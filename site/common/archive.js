/*
 * 共用：存档，即页面与 scripts/serve.py 的交互，由 ui.js 的 createApp 接上。每个视图（v）有自己的存放目录 v.submit，相关配置 serverKeys、serverBill、
 * serverMeta、serverRows 见 ui.js 开头；页面级的 query（查询页）、ocr。服务器关闭存档（config.ini [存档]）时为纯本地模式：不提交、不查询。
 * 单据核验页（用户）：
 *   已提交：都查服务器清单（不看服务器上有没有文件）。本地各文件按规范名称问有没有、大小和修改时间（服务器上的是同一份或更新的算已提交）；
 *     本地的编号（v.serverKeys）问清单里这份报关单已有哪些单据类型（不论文件名，如手动补传的）
 *   归属：本地对不上报关单的提运单、数电发票（v.serverBill）由服务器按清单比对，对上的并入那份已提交的报关单（v.serverRows），可照常提交
 *   提交：当前视图的文件上传到它的目录，附上清单字段（v.serverMeta，只放非敏感的；完整编号由服务器换成校验值）；同一份的跳过，其余上传（已有的覆盖）
 *   OCR：无法识别的文件经服务器交给 OCR 接口，返回的文字由 c.ocr.parse 解析，替换原来的出错记录
 *   库中已有：无法识别、疑似的文件，清单里有大小、修改时间都相同的（如手动补充过的扫描件），页面不再列出（inStore）
 * 查询页（c.query，查询白名单内）：打开即取各视图目录的清单列出（只读）；「下载归档」（要密码）下载当前视图目录的全部归档文件，
 *   下载完成后「删除归档」才可用，删除这次下载里的文件（清单保留）
 * app：createApp 提供的 { view() 当前视图, records(), rebuild(), render(), packEntries(v), pageCount(file),
 *   replace(出错的行, [解析结果]) → 新的行, status(行, v) }
 */
import { $, esc, toast, notice, progress, busy, friendlyError } from "./dom.js";

const api = (path) => new URL(`../api/${path}`, import.meta.url).href;
const API = api("files");
const OCR_API = api("ocr");
const EXISTS_API = api("exists");
const MANIFEST_API = api("manifest");
const DOWNLOAD_API = api("download");
const PURGE_API = api("purge");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirQ = (dir) => `?dir=${encodeURIComponent(dir)}`;

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
  const dirs = [...new Set(c.views.map((v) => v.submit).filter(Boolean))];
  let status = null; // serve.py 的 { archive, writable, query, download }；null：连不上或存档关闭
  let archiveOff = false;
  const manifests = new Map(); // 查询页：目录 → { groups, files }
  let keymap = {}; // 校验值 → 本地的完整编号（本地单据与清单里对上的）
  let typesOf = new Map(); // 本地的完整编号 → 清单里已有的单据类型
  let billmap = new Map(); // 本地提运单、发票的解析结果 → 服务器比对出的报关单
  let present = new Map(); // 目录 → 问过的名称中服务器上有的 → { 大小, 修改时间（秒） }
  let localFiles = new Map(); // 目录 → 本地要打包的文件名称 → File
  let stored = new Set(); // 问过的「大小/修改时间」中清单里有的（提交时修改时间随文件一起记，见 serve.py keep_mtime）
  let asked = "";
  let ocrOn = false;
  let downloaded = null; // 查询页：最近一次下载完成的 { token, dir, count, size }，「删除归档」用
  const apiPath = (dir, name) => [dir, ...name.split("/")].map(encodeURIComponent).join("/");

  const seconds = (file) => Math.floor(file.lastModified / 1000);
  /**
   * 不用提交：服务器上的修改时间比本地的晚（服务器上的更新，不论大小），或时间相同、大小也相同（同一份）。
   * 其余（本地的更新，或时间相同大小不同）提交时覆盖。与 serve.py 的 do_PUT 同一规则
   */
  const sameAs = (p, file) => !!p && (p.修改时间 > seconds(file) || (p.修改时间 === seconds(file) && p.大小 === file.size));
  /**
   * 交给视图 lacking、detail 的查询：has(名称) 服务器上有同名的、且本地有这个文件时不用提交（服务器上的是同一份或更新的）；
   * types(编号) 清单里这份报关单已有的单据类型
   */
  const check = (v) => ({
    has: (name) => {
      const p = present.get(v.submit)?.get(name), f = localFiles.get(v.submit)?.get(name);
      return !!p && (!f || sameAs(p, f));
    },
    types: (no) => typesOf.get(no) || new Set(),
  });
  /** 识别不了的文件按「大小/修改时间（秒）」认：大小、修改时间都相同的文件已在库中（如手动补充过的扫描件），不再列出 */
  const stamp = (file) => `${file.size}/${Math.floor(file.lastModified / 1000)}`;
  const inStore = (files) => files.length > 0 && files.every((f) => stored.has(stamp(f)));
  /** 交给视图的服务器上的记录：查询页为它目录的清单；单据核验页为本地提运单、发票对上的已提交报关单 */
  const serverRecords = (v) => (!v.serverRows ? [] : c.query ? v.serverRows(manifests.get(v.submit) || {})
    : v.serverBill ? v.serverRows({ groups: [...billmap.values()].flat() }, keymap, billmap) : []);

  async function refreshServer() {
    try {
      const res = await fetch(API, { cache: "no-store" });
      status = res.ok ? await res.json() : null;
      archiveOff = !!status && !status.archive;
      if (archiveOff) status = null; // 存档关闭（config.ini [存档]）：纯本地模式，不提交、不查询
      if (c.query && status && status.query)
        for (const d of dirs) manifests.set(d, await (await fetch(MANIFEST_API + dirQ(d), { cache: "no-store" })).json());
    } catch {
      status = null;
    }
    if (c.query && (!status || !status.query)) notice(archiveOff ? "存档已关闭" : status ? "不在查询白名单内" : "连接不到服务器", "warn");
    app.rebuild();
    app.render();
    await checkExists(true);
  }

  /**
   * 单据核验页问服务器（每个视图的目录各问一次）：本地各文件的规范名称哪些已在清单里、多大；无法识别、疑似的文件按大小 + 修改时间问；
   * 本地单据的编号（serverKeys）已提交了哪些单据类型；本地提运单、发票（serverBill）属于哪份已提交的报关单（变了就重建列表）。
   * 问的内容没变时不重复问
   */
  async function checkExists(force) {
    if (c.query || !status) return;
    const datas = app.records().filter((r) => r.data).map((r) => r.data);
    const stamps = [...new Set(app.records().filter((r) => r.error).map((r) => stamp(r.file)))];
    const asks = c.views.filter((v) => v.submit).map((v) => {
      const entries = app.packEntries(v);
      return {
        v, entries, names: [...new Set(entries.map((x) => x.name))],
        keys: v.serverKeys ? [...new Set(datas.flatMap(v.serverKeys))] : [],
        bills: v.serverBill ? datas.map((d) => [d, v.serverBill(d)]).filter(([, b]) => b) : [],
      };
    });
    const sig = JSON.stringify([stamps, asks.map((a) => [a.v.submit, a.names, a.keys, a.bills.map(([, b]) => `${b.全文.length}:${b.全文.slice(0, 40)}`)])]);
    if (!force && sig === asked) return;
    asked = sig;
    const map = {}, bills = new Map(), types = new Map(), has = new Map(), local = new Map(), inStock = new Set();
    // 各目录同时问
    const answers = await Promise.all(asks.map(async (a) => {
      const body = JSON.stringify({ names: a.names, stamps, keys: a.keys, bills: a.bills.map(([, b]) => b) });
      const res = await fetch(EXISTS_API + dirQ(a.v.submit), { method: "POST", body }).catch(() => null);
      return res && res.ok ? res.json() : {};
    }));
    for (const [n, a] of asks.entries()) {
      const j = answers[n];
      has.set(a.v.submit, new Map(Object.entries(j.exists || {})));
      local.set(a.v.submit, new Map(a.entries.map((x) => [x.name, x.file])));
      for (const s of j.stamps || []) inStock.add(s);
      for (const [k, x] of Object.entries(j.keys || {})) (map[x.校验] = k), types.set(k, new Set(x.类型));
      a.bills.forEach(([d], i) => (j.bills || [])[i]?.length && bills.set(d, j.bills[i]));
    }
    [present, localFiles, stored, typesOf] = [has, local, inStock, types]; // 都问完再换上，问的期间显示不受影响
    const same = (m, b) => JSON.stringify([m, [...b.values()]]);
    if (same(map, bills) !== same(keymap, billmap)) {
      keymap = map;
      billmap = bills;
      app.rebuild(); // 提运单、发票并入服务器上的报关单，打包名称随之变化，再问一次
      app.render();
      return checkExists(false);
    }
    app.render();
  }

  /** 查询页：下载当前视图目录的全部归档文件：密码 → 服务器记下此刻的文件 → 浏览器下载 zip → 等服务器发送完 → 「删除归档」可用 */
  async function download() {
    const dir = app.view().submit;
    const password = await askPassword(`下载服务器上「${dir}」的全部归档文件，请输入下载密码`);
    if (!password) return;
    const res = await fetch(DOWNLOAD_API + dirQ(dir), { method: "POST", body: JSON.stringify({ password }) }).catch(() => null);
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
    downloaded = { token: j.token, dir, count: j.count, size };
    $("#btnPurge").disabled = false;
    toast(`已下载 ${j.count} 个文件（${size}）；确认压缩包已保存、能正常打开后，可删除服务器上的归档文件`, 8000);
  }

  /** 查询页：删除最近一次下载里的归档文件（下载之后又提交过的不删，清单保留） */
  async function purge() {
    if (!downloaded || !confirm(`删除服务器上「${downloaded.dir}」已下载的 ${downloaded.count} 个归档文件（${downloaded.size}）？`)) return;
    const p = await fetch(PURGE_API, { method: "POST", body: JSON.stringify({ token: downloaded.token }) }).catch(() => null);
    const r = p ? await p.json().catch(() => ({})) : {};
    if (!p || !p.ok) return toast(`删除失败：${r.error || "连接不到服务器"}`, 6000);
    downloaded = null;
    toast(`已删除服务器上的归档文件 ${r.deleted} 个${r.kept ? `，下载之后又提交过的 ${r.kept} 个保留` : ""}`, 6000);
  }

  /** 单据核验页：提交当前视图的文件到它的目录 */
  async function submit() {
    const v = app.view();
    await refreshServer();
    // 服务器上是同一份或更新的跳过；其余上传（已有的覆盖）
    const todo = app.packEntries(v).filter((x) => !sameAs(present.get(v.submit)?.get(x.name), x.file));
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
        res = await fetch(`${API}/${apiPath(v.submit, x.name)}`, { method: "PUT", body: new Blob([meta, x.file]), headers }).catch((e) => e);
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
  }

  if (dirs.length) {
    refreshServer();
    if (c.query) {
      $("#btnDownload").addEventListener("click", (e) => busy(e.currentTarget, download));
      $("#btnPurge").addEventListener("click", (e) => {
        const btn = e.currentTarget;
        busy(btn, purge).then(() => (btn.disabled = !downloaded)); // 没下载过、或已删除的不可再点
      });
    } else $("#btnSubmit").addEventListener("click", (e) => busy(e.currentTarget, submit));
  }

  // OCR：页数由这里读出（接口逐页识别），文字交给 c.ocr.parse
  if (c.ocr && !c.query) fetch(OCR_API, { cache: "no-store" })
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
      toast(!now || app.status(now, app.view()) === "sus" ? "OCR 完成，仍未匹配到报关单" : "OCR 完成，已归入对应的报关单", 5000);
    } catch (err) {
      btn.disabled = false;
      toast(`OCR 失败：${friendlyError(err)}`, 6000);
    } finally {
      progress("");
    }
  }

  return {
    check, inStore, serverRecords, checkExists, ocrButton, runOcr,
    canSubmit: () => !!(status && status.writable), canDownload: () => !!(status && status.download),
  };
}

export { connect };
