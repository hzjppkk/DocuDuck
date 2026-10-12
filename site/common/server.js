/*
 * 共用：页面与 scripts/serve.py 的交互，由 ui.js 的 createApp 接上（相关配置 submit、serverKeys、serverMeta、serverRows、ocr 见 ui.js 开头）：
 *   已提交：都查服务器清单（不看服务器上有没有文件）。本地各文件按规范名称问有没有、大小和修改时间（同名、大小相同且
 *     服务器上的不比本地旧的算已提交）；本地的编号（c.serverKeys）问清单里这份报关单已有哪些单据类型（不论文件名，如手动补传的）。
 *     服务器只查清单（清单.jsonl），不遍历目录；归档文件下载后删掉了，清单还在，仍算已提交
 *   提交：上传时附上清单字段（c.serverMeta，只放非敏感的；完整编号由服务器换成校验值）；同一份的跳过，其余上传（已有的覆盖）
 *   查询已提交：取服务器清单（只给查询白名单内的 IP），交给 c.serverRows 变成记录，之后每次重建列表都与本地文件一起合并。
 *     本地单据的编号（c.serverKeys）问服务器换成校验值，与清单里的对上的并入同一行；本地的提运单（c.serverBill）由服务器按清单里
 *     存的提运单号、集装箱号比对（这两项查询时不发给页面），对上的并入只在服务器上的报关单
 *   下载：查询白名单内、服务器设了下载密码的显示「下载归档」：输入密码，下载服务器上的全部归档文件（zip），下载完问是否删除服务器上的归档文件（清单保留）
 *   OCR：无法识别的文件经服务器交给 OCR 接口，返回的文字由 c.ocr.parse 解析，替换原来的出错记录
 *   库中已有：无法识别、疑似的文件，清单里有大小、修改时间都相同的（如手动补充过的扫描件），页面不再列出（inStore）
 * app：createApp 提供的 { rows(), records(), rebuild(), render(), packEntries(), pageCount(file), replace(出错的行, [解析结果]) → 新的行,
 *   status(行), filesOf(行) → [File] }
 */
import { $, esc, toast, progress, busy, friendlyError } from "./dom.js";

const api = (path) => new URL(`../api/${path}`, import.meta.url).href;
const API = api("files");
const OCR_API = api("ocr");
const EXISTS_API = api("exists");
const MANIFEST_API = api("manifest");
const DOWNLOAD_API = api("download");
const PURGE_API = api("purge");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 输入密码的对话框；取消时为空 */
function askPassword(title) {
  const dlg = document.createElement("dialog");
  dlg.className = "ask";
  dlg.innerHTML = `<form method="dialog"><p>${esc(title)}</p><input type="password" autocomplete="current-password" required>
    <div class="btns"><button value="ok" class="btn primary">确定</button><button value="" formnovalidate class="btn">取消</button></div></form>`;
  document.body.append(dlg);
  return new Promise((res) => {
    dlg.addEventListener("close", () => {
      res(dlg.returnValue === "ok" ? dlg.querySelector("input").value : "");
      dlg.remove();
    });
    dlg.showModal();
  });
}

function connect(c, app) {
  let apiOk = false; // 连得上 serve.py
  let query = false; // 点过「查询已提交」后为 true：之后每次重建都带上服务器上的行
  let manifest = null; // 查询时取的服务器清单；null：没查询或不在白名单
  let keymap = {}; // 校验值 → 本地的完整编号（本地单据与清单里对上的）
  let typesOf = new Map(); // 本地的完整编号 → 清单里已有的单据类型
  let billmap = new Map(); // 本地提运单的解析结果 → 对上的清单组 [{ 校验, 提运单号? }]
  let present = new Map(); // 问过的名称中服务器上有的 → { 大小, 修改时间（秒） }
  let localFiles = new Map(); // 本地要打包的文件名称 → File
  let stored = new Set(); // 问过的「大小/修改时间」中清单里有的（提交时修改时间随文件一起记，见 serve.py keep_mtime）
  let asked = "";
  let ocrOn = false;
  const dirQ = `?dir=${encodeURIComponent(c.submit)}`;
  const apiPath = (name) => [c.submit, ...name.split("/")].map(encodeURIComponent).join("/");

  const seconds = (file) => Math.floor(file.lastModified / 1000);
  /**
   * 不用提交：服务器上的修改时间比本地的晚（服务器上的更新，不论大小），或时间相同、大小也相同（同一份）。
   * 其余（本地的更新，或时间相同大小不同）提交时覆盖。与 serve.py 的 do_PUT 同一规则
   */
  const sameAs = (p, file) => !!p && (p.修改时间 > seconds(file) || (p.修改时间 === seconds(file) && p.大小 === file.size));
  /**
   * 交给 lacking、detail 的查询：has(名称) 服务器上有同名的、且本地有这个文件时不用提交（服务器上的是同一份或更新的）；
   * types(编号) 清单里这份报关单已有的单据类型
   */
  const check = {
    has: (name) => present.has(name) && (!localFiles.has(name) || sameAs(present.get(name), localFiles.get(name))),
    types: (no) => typesOf.get(no) || new Set(),
  };
  /** 识别不了的文件按「大小/修改时间（秒）」认：大小、修改时间都相同的文件已在库中（如手动补充过的扫描件），不再列出 */
  const stamp = (file) => `${file.size}/${Math.floor(file.lastModified / 1000)}`;
  const inStore = (files) => files.length > 0 && files.every((f) => stored.has(stamp(f)));
  /** 交给 merge 的服务器上的记录 */
  const serverRecords = () => (query && manifest ? c.serverRows(manifest, keymap, billmap) : []);

  // 服务器不能写入时（serve.py 启动时试写过）隐藏「提交」；查询白名单内的显示「查询已提交」，再设了下载密码的显示「下载归档」
  async function refreshServer() {
    let j = null;
    try {
      const res = await fetch(API + dirQ, { cache: "no-store" });
      j = res.ok ? await res.json() : null;
      manifest = query && j && j.query ? (await (await fetch(MANIFEST_API + dirQ, { cache: "no-store" })).json()).entries : null;
    } catch {
      j = null;
      manifest = null;
    }
    apiOk = !!j;
    $("#btnSubmit").hidden = !(j && j.writable);
    if ($("#btnQuery")) $("#btnQuery").hidden = !(j && j.query);
    if ($("#btnDownload")) $("#btnDownload").hidden = !(j && j.download);
    app.rebuild();
    app.render();
    await checkExists(true);
  }

  /**
   * 问服务器：本地各行的规范名称哪些已在清单里、多大；无法识别、疑似的行（没有规范名称）按大小 + 修改时间问；
   * 本地单据的编号（serverKeys）对应清单里的哪一组、已有哪些单据类型（查询后对上的组变了就重建列表）。问的内容没变时不重复问
   */
  async function checkExists(force) {
    if (!c.submit || !apiOk) return;
    const rows = app.rows();
    const names = [...new Set(rows.flatMap((r) => (r.files || []).map((f) => f.name)))].filter(Boolean);
    const stamps = [...new Set(rows.filter((r) => ["err", "sus"].includes(app.status(r))).flatMap((r) => app.filesOf(r).map(stamp)))];
    const datas = app.records().filter((r) => r.data).map((r) => r.data);
    const keys = c.serverKeys ? [...new Set(datas.flatMap(c.serverKeys))] : [];
    const billRecs = manifest && c.serverBill ? datas.map((d) => [d, c.serverBill(d)]).filter(([, b]) => b) : [];
    const ask = [...names, ...stamps, ...keys, ...billRecs.map(([, b]) => `${b.全文.length}:${b.全文.slice(0, 40)}`)].join("\n");
    if (!force && ask === asked) return;
    asked = ask;
    let j = {};
    if (names.length || stamps.length || keys.length || billRecs.length) {
      const body = JSON.stringify({ names, stamps, keys, bills: billRecs.map(([, b]) => b) });
      const res = await fetch(EXISTS_API + dirQ, { method: "POST", body }).catch(() => null);
      j = res && res.ok ? await res.json() : {};
    }
    present = new Map(Object.entries(j.exists || {}));
    stored = new Set(j.stamps || []);
    localFiles = new Map(rows.flatMap((r) => (r.files || []).map((f) => [f.name, f.file])));
    const map = manifest ? Object.fromEntries(Object.entries(j.keys || {}).map(([k, v]) => [v.校验, k])) : {};
    typesOf = new Map(Object.entries(j.keys || {}).map(([k, v]) => [k, new Set(v.类型)]));
    const bills = new Map(billRecs.map(([d], i) => [d, (j.bills || [])[i] || []]).filter(([, hs]) => hs.length));
    const sig = (m, b) => JSON.stringify([m, [...b.values()]]);
    if (sig(map, bills) !== sig(keymap, billmap)) {
      keymap = map;
      billmap = bills;
      app.rebuild(); // 本地单据并入服务器上的行，打包名称随之变化，再问一次
      app.render();
      return checkExists(false);
    }
    app.render();
  }

  /** 下载服务器上的全部归档文件：密码 → 服务器记下此刻的文件 → 浏览器下载 zip → 等服务器发送完 → 问是否删除 */
  async function download() {
    const password = await askPassword("下载服务器上的全部归档文件，请输入下载密码");
    if (!password) return;
    const res = await fetch(DOWNLOAD_API + dirQ, { method: "POST", body: JSON.stringify({ password }) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) return toast(j.error || "连接不到服务器", 6000);
    if (!j.count) return toast("服务器上没有归档文件（可能已下载并删除）", 5000);
    const a = Object.assign(document.createElement("a"), { href: `${DOWNLOAD_API}/${j.token}`, download: "" });
    a.click();
    const size = `${(j.bytes / 1048576).toFixed(1)} MB`;
    for (let s; ; ) {
      progress(`正在下载 ${j.count} 个文件（${size}）…`);
      await sleep(1000);
      s = await fetch(`${DOWNLOAD_API}/${j.token}/status`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!s || s.failed) return toast("下载中断，请重新下载", 6000);
      if (s.done) break;
    }
    progress("");
    if (!confirm(`服务器已发送 ${j.count} 个文件（${size}）。请先确认压缩包已保存、能正常打开。\n\n是否删除服务器上的这些归档文件？`))
      return toast("服务器上的归档文件已保留", 5000);
    const p = await fetch(PURGE_API, { method: "POST", body: JSON.stringify({ token: j.token }) }).catch(() => null);
    const r = p ? await p.json().catch(() => ({})) : {};
    if (!p || !p.ok) return toast(`删除失败：${r.error || "连接不到服务器"}`, 6000);
    toast(`已删除服务器上的归档文件 ${r.deleted} 个${r.kept ? `，下载之后又提交过的 ${r.kept} 个保留` : ""}`, 6000);
  }

  if (c.submit) {
    refreshServer();
    $("#btnQuery")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const before = app.rows().filter((r) => r.server).length;
      query = true;
      await refreshServer();
      if (!manifest) return toast(apiOk ? "无查询权限" : "连接不到服务器");
      const n = app.rows().filter((r) => r.server).length - before;
      toast(n ? `已添加 ${n} ${c.unit}` : "没有新的记录", 5000);
    }));
    $("#btnDownload")?.addEventListener("click", (e) => busy(e.currentTarget, download));
    $("#btnSubmit").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      await refreshServer();
      // 服务器上是同一份或更新的跳过；其余上传（已有的覆盖）
      const todo = app.packEntries().filter((x) => !sameAs(present.get(x.name), x.file));
      if (!todo.length) return toast("没有待提交的文件");
      let done = 0, over = 0;
      const failed = []; // 失败的原因，打印到控制台（F12）
      for (const [i, x] of todo.entries()) {
        progress(`正在提交 ${i + 1} / ${todo.length}：${x.name}`);
        // 请求体：清单字段（JSON）+ 文件；清单字段的字节数放在请求头（字段本身可能很长，不放请求头）
        const meta = new TextEncoder().encode(JSON.stringify(x.meta || {}));
        const headers = { "X-Last-Modified": String(x.file.lastModified), "X-Meta-Length": String(meta.length) };
        const t0 = performance.now();
        // 网络中断（如连接超时）的重试 2 次：上传同一文件重复执行结果相同
        let res;
        for (let n = 0; n < 3 && !(res instanceof Response); n++) {
          if (n) await sleep(1000);
          res = await fetch(`${API}/${apiPath(x.name)}`, { method: "PUT", body: new Blob([meta, x.file]), headers }).catch((e) => e);
        }
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        if (res instanceof Response && (res.ok || res.status === 409)) {
          done++;
          if (res.status === 200) over++;
          continue;
        }
        const why = res instanceof Response ? `${res.status} ${(await res.json().catch(() => ({}))).error || ""}` : `网络中断（${res}）`;
        failed.push(why);
        console.warn(`提交失败：${x.name}（${x.file.size} 字节，用时 ${secs} 秒）：${why}`);
      }
      await refreshServer();
      const note = over ? `（其中覆盖 ${over} 个）` : "";
      toast(failed.length ? `已提交 ${done} 个文件${note}，${failed.length} 个失败：${failed[0]}（详情见 F12 控制台）` : `已提交 ${done} 个文件${note}`, 8000);
    }));
  }

  // OCR：页数由这里读出（接口逐页识别），文字交给 c.ocr.parse
  if (c.ocr) fetch(OCR_API, { cache: "no-store" })
    .then((res) => res.json()).then((j) => { ocrOn = !!j.enabled; app.render(); }).catch(() => {});
  const ocrButton = (r, st) => (ocrOn && r.error && c.ocr.on.includes(st) ? `<button type="button" class="link" data-ocr>OCR</button>` : "");
  async function runOcr(r, btn) {
    btn.disabled = true;
    progress(`正在 OCR：${r.fileName}`);
    try {
      const res = await fetch(`${OCR_API}?pages=${await app.pageCount(r.file)}`, { method: "POST", body: r.file });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      const now = app.replace(r, c.ocr.parse(j.text, r.file));
      if (now === null) return toast("列表已清空，OCR 结果未使用");
      toast(!now || app.status(now) === "sus" ? "OCR 完成，仍未匹配到报关单" : "OCR 完成，已归入对应的报关单", 5000);
    } catch (err) {
      btn.disabled = false;
      toast(`OCR 失败：${friendlyError(err)}`, 6000);
    } finally {
      progress("");
    }
  }

  return { check, inStore, serverRecords, checkExists, ocrButton, runOcr, reset: () => (query = false) };
}

export { connect };
