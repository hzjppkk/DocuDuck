/*
 * 共用：工具页面框架。各工具只提供配置（见 baoguan/app.js、fapiao/app.js）：
 *   createApp({ title, sub, icon, dropTitle, zipTitle, search, footer, unit, allLabel,
 *                     load, key, dupNote, sortKey, hay, columns, stats, detail, excel, zipName, fileName, merge? })
 * 列表默认一个解析结果一行；merge(全部解析结果) 可选，把多个文件合并成一行（如同一报关单的各单据），
 * 返回 [{ key, data, members: [解析结果], files: [{ member, name }] }]，打包时按 files 放置（name 可含“/”，即文件夹）；
 * merge 的第二个参数是识别不了的文件 [{ 原文件名, 错误, 无文字层 }]，并入某组的（成员的 来源 即该对象）不再单列为“无法识别”
 * unrecognizedDir 可选：识别不了的文件也打包，放在该文件夹下、保留拖入时的原文件夹层级；不设则不打包
 * 页面骨架（标题、拖放区、工具栏、表格、页脚）由这里生成，html 只需以模块方式引入各工具的 app.js。
 * 第三方库：pdf.js、SheetJS 为 ES 模块，在这里导入；JSZip 只发布 UMD 版，由 html 用普通 <script> 加载为全局变量。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import * as XLSX from "../vendor/xlsx.mjs";
import * as DocPdf from "./pdf.js";
import { standardNames } from "./text.js";

const $ = (s) => document.querySelector(s);

// ---------- 格式化 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMoney = (v) => (v == null || v === "" ? "" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

function friendlyError(err) {
  if (err && err.name === "PasswordException") return "PDF 设置了密码，无法读取";
  if (err && err.name === "InvalidPDFException") return "文件已损坏，或不是有效的 PDF";
  return (err && err.message) || String(err);
}

// ---------- 提示与进度 ----------
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
/** 页头提示行（如白名单状态）；level：ok / warn / 空（灰色）；tip：鼠标移到图标上显示的内容 */
const notice = (msg, level = "", tip = "") => {
  const n = $("#notice");
  n.innerHTML = `<span class="notice-icon"${tip ? ` title="${esc(tip)}"` : ""}>📋</span> ${esc(msg)}`;
  n.className = `notice ${level}`;
  n.hidden = !msg;
};
const progress = (msg) => { const p = $("#progress"); p.hidden = !msg; p.textContent = msg || ""; };

// ---------- PDF ----------
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", PDFJS).href;
// CMap 等资源由 Worker 自行 fetch，须为绝对地址；发票常用 UniGB-UCS2-H 等中文编码，缺 CMap 时中文会整段丢失
const PDF_OPTIONS = {
  cMapUrl: new URL("cmaps/", PDFJS).href,
  standardFontDataUrl: new URL("standard_fonts/", PDFJS).href,
  wasmUrl: new URL("wasm/", PDFJS).href,
  iccUrl: new URL("iccs/", PDFJS).href,
  // 所有文件共用一个 Worker 线程（解析 PDF、提取文字、解码图片在其中进行）；pdf.js 默认每个文件新建一个，每次多花约 40 ms
  worker: new pdfjsLib.PDFWorker(),
};

/** 打开 → 提取文字 → 检查文字层；返回 { doc, pages, attachments, close }，用完需 close() */
const loadPdf = async (file) => DocPdf.loadPdf(pdfjsLib, new Uint8Array(await file.arrayBuffer()), PDF_OPTIONS);

// ---------- 页面骨架 ----------
function skeleton(c) {
  const version = document.querySelector('meta[name="version"]')?.content; // 发布打包时写入（.github/workflows/release.yml）
  document.body.innerHTML = `
<header class="top"><div class="wrap">
  <a class="home" href="../index.html">← 返回首页</a>
  <h1>${esc(c.title)}</h1>
  <p class="sub">${esc(c.sub)}</p>
  <p class="privacy">🔒 所有文件只在你自己的电脑上处理，不会上传到任何地方，断网也能用。</p>
  <p id="notice" class="notice" hidden></p>
</div></header>
<main class="wrap">
  <section id="drop" class="drop" tabindex="0">
    <div class="drop-icon" aria-hidden="true">${c.icon}</div>
    <p class="drop-title"></p>
    <p class="drop-hint">也可以点击下面的按钮选择；只识别 PDF，图片、OFD、XML 会被自动排除</p>
    <div class="drop-btns">
      <label class="btn primary">选择 PDF 文件<input id="pickFiles" type="file" accept=".pdf,application/pdf" multiple hidden></label>
      <label class="btn">选择文件夹<input id="pickDir" type="file" webkitdirectory multiple hidden></label>
    </div>
    <p id="progress" class="progress" hidden></p>
  </section>
  <section id="result" hidden>
    <div id="stats" class="stats"></div>
    <div class="toolbar">
      <button id="btnExcel" class="btn primary">⬇ 导出 Excel</button>
      <button id="btnZip" class="btn" title="${esc(c.zipTitle)}">⬇ 下载规范命名的 PDF</button>
      <input id="search" class="search" type="search" placeholder="${esc(c.search)}">
      <button id="btnClear" class="btn ghost">清空</button>
    </div>
    <div class="table-wrap"><table id="table"><thead><tr>
      ${["状态", ...c.columns.map(([th]) => th), "原文件名"].map((th, i) =>
        // 表头只继承对齐（num），不继承字体类（如 mono 会让中文表头失去加粗）
        `<th data-i="${i}"${/\bnum\b/.test((c.columns[i - 1] || [])[2] || "") ? ` class="num"` : ""}>${esc(th)}</th>`).join("")}
    </tr></thead><tbody></tbody></table></div>
  </section>
</main>
<footer class="wrap foot"><p>${esc(c.footer)}</p><p>只支持带文字层的 PDF；图片、OFD、XML 等其他格式会被自动排除，扫描件无法识别。</p>${version ? `<p>版本 ${esc(version)}</p>` : ""}</footer>
<div id="toast" class="toast" hidden></div>`;
}

// ---------- 文件输入 ----------
/** 只有虚线框接收拖放；框外显示“禁止”光标，松手也不会让浏览器打开 PDF。非 PDF 直接排除 */
function initFileInput(onFiles) {
  const drop = $("#drop");
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  const deliver = (files) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    const excluded = files.length - pdfs.length;
    if (!pdfs.length) return toast(files.length ? `没有找到 PDF 文件（已排除 ${excluded} 个其他格式的文件）` : "没有读取到文件");
    onFiles(pdfs, excluded);
  };
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drop.contains(e.target) ? "copy" : "none";
  });
  window.addEventListener("drop", (e) => hasFiles(e) && !drop.contains(e.target) && e.preventDefault());
  drop.addEventListener("dragenter", (e) => hasFiles(e) && ++depth && drop.classList.add("over"));
  drop.addEventListener("dragleave", () => --depth <= 0 && ((depth = 0), drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove("over");
    // DataTransfer 只在事件同步阶段有效，先把条目全部取出来
    const plain = [...e.dataTransfer.files];
    const entries = [...e.dataTransfer.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry());
    if (!entries.some((en) => en && en.isDirectory)) return deliver(plain);
    readFolders(entries).then(deliver);
  });
  for (const id of ["#pickFiles", "#pickDir"])
    $(id).addEventListener("change", (e) => { deliver([...e.target.files]); e.target.value = ""; });
}

/** 文件在拖入 / 选择时的相对路径（含原文件夹层级）；单独拖入的文件只有文件名 */
const relPath = (file) => file.relPath || file.webkitRelativePath || file.name;

/** 读取拖入的文件夹（File and Directory Entries API：名称带 webkit 前缀，但各浏览器都已实现，http 下也可用） */
async function readFolders(entries) {
  progress("正在读取文件夹…");
  try {
    const out = [];
    const walk = async (en) => {
      if (en.isFile) {
        const file = await new Promise((res, rej) => en.file(res, rej));
        file.relPath = en.fullPath.replace(/^\//, ""); // 拖入的文件没有 webkitRelativePath，记下原文件夹层级
        return out.push(file);
      }
      const reader = en.createReader();
      for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) for (const c of batch) await walk(c);
    };
    for (const en of entries.filter(Boolean)) await walk(en);
    return out;
  } finally {
    progress("");
  }
}

// ---------- 导出 ----------
/** sheets: [{name, rows, cols, widths, labels}]；labels 为表头显示名（缺省用字段名）；号码、税号是字符串，写入后为文本单元格 */
function exportExcel(prefix, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows, cols, widths = {}, labels = {} } of sheets) {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}], { header: cols });
    XLSX.utils.sheet_add_aoa(ws, [cols.map((c) => labels[c] || c)], { origin: "A1" });
    ws["!cols"] = cols.map((c) => ({ wch: widths[c] || Math.max(8, Math.min(20, c.length * 2 + 2)) }));
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: cols.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, `${prefix}_${dateStamp()}.xlsx`);
}

/** entries: [{name, file}]；同名同文件只放一份（如同一文件夹里几份报关单共用的提单），同名不同文件加 (2)(3)… */
async function downloadZip(entries, zipName) {
  const zip = new JSZip();
  const used = new Map(); // 名称 → 已放入的文件
  for (const { name, file } of entries) {
    const files = used.get(name) || [];
    if (files.includes(file)) continue;
    used.set(name, [...files, file]);
    zip.file(files.length ? name.replace(/\.pdf$/i, `(${files.length + 1}).pdf`) : name, file); // 直接交给 JSZip，打包时才读取
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- 应用 ----------
const BADGE = { ok: `<span class="badge ok">✓ 正常</span>`, warn: `<span class="badge warn">⚠ 需核对</span>`, err: `<span class="badge err">✗ 无法识别</span>` };

function createApp(c) {
  skeleton(c);
  /** 记录：{ id, fileName, file, data?, error? }；一个文件可产生多条记录（如一个 PDF 含多张发票） */
  let records = [];
  let nextId = 1;
  /** 列表的行：不合并时即记录；合并时为 { id, fileName（各文件名）, data, files: [{ name, file }], hay } 加上出错的记录 */
  let rows = [];
  const openIds = new Set();
  const status = (r) => (r.error ? "err" : r.data.issues.length ? "warn" : "ok");
  const ok = () => records.filter((r) => r.data);
  function rebuild() {
    if (!c.merge) return (rows = records);
    const rec = new Map(ok().map((r) => [r.data, r]));
    const failed = new Map(records.filter((r) => r.error).map((r) => [{ 原文件名: r.fileName, 错误: r.error, 无文字层: r.noText }, r]));
    for (const [stub, r] of failed) rec.set(stub, r);
    const recOf = (m) => rec.get(m.来源 || m);
    const groups = c.merge(ok().map((r) => r.data), [...failed.keys()]);
    const used = new Set(groups.flatMap((g) => g.members.map(recOf)));
    rows = [...groups.map((g) => ({
      id: g.key, data: g.data,
      fileName: g.members.map((m) => recOf(m).fileName).join("、"),
      files: g.files.map(({ member, name }) => ({ name, file: recOf(member).file })),
      hay: g.members.map((m) => recOf(m).hay).join(" "),
    })), ...records.filter((r) => r.error && !used.has(r))];
  }

  // 排序：点列标题切换升 / 降序，默认第一列（日期）升序；无法识别的记录始终在最后
  // 取值：状态、原文件名内置；其余为列配置的第 4 项（数字按大小，文字按拼音、其中数字按数值；空值在最后）
  const RANK = { ok: 0, warn: 1, err: 2 };
  const sorters = [(r) => RANK[status(r)], ...c.columns.map(([, , , v]) => (r) => (v ? v(r.data) : "")), (r) => r.fileName];
  let sort = { i: 1, dir: 1 };
  let filter = "all"; // 统计框筛选：all / warn / err
  const empty = (v) => v == null || v === "";
  const cmpVal = (a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh-CN", { numeric: true });
  function ordered() {
    const f = sorters[sort.i];
    // 排序值先算好（v：所选列，t：并列时的次序），比较时不再反复计算
    const keyed = rows.map((r) => (r.error ? { r, v: "", t: r.fileName } : { r, v: f(r), t: c.sortKey(r.data) }));
    keyed.sort((a, b) => {
      if (!!a.r.error !== !!b.r.error) return a.r.error ? 1 : -1;
      if (a.r.error) return cmpVal(a.t, b.t);
      if (empty(a.v) !== empty(b.v)) return empty(a.v) ? 1 : -1;
      return (empty(a.v) ? 0 : cmpVal(a.v, b.v) * sort.dir) || cmpVal(a.t, b.t);
    });
    return keyed.map((k) => k.r);
  }

  async function addFiles(pdfs, excluded = 0) {
    let added = 0, dup = 0, failed = 0;
    const seen = new Set(ok().map((r) => c.key(r.data)));
    for (const [i, file] of pdfs.entries()) {
      progress(`正在识别 ${i + 1} / ${pdfs.length}：${file.name}`);
      try {
        for (const data of await c.load(file)) {
          const k = c.key(data);
          if (k && seen.has(k)) { dup++; continue; }
          seen.add(k);
          // hay：搜索用的文本，添加时算一次
          records.push({ id: nextId++, fileName: file.name, file, data, hay: `${file.name} ${c.hay(data)}`.toLowerCase() });
          added++;
        }
      } catch (err) {
        records.push({ id: nextId++, fileName: file.name, file, error: friendlyError(err), noText: err.code === "NO_TEXT", hay: file.name.toLowerCase() });
        failed++;
      }
    }
    progress("");
    rebuild();
    render();
    const msg = [`已添加 ${added} ${c.unit}`];
    if (dup) msg.push(`跳过重复 ${dup} ${c.unit}（${c.dupNote}）`);
    if (failed) msg.push(`${failed} 个文件无法识别`);
    if (excluded) msg.push(`已排除 ${excluded} 个非 PDF 文件`);
    toast(msg.join("，"), 5000);
  }

  function render() {
    const n = rows.length;
    $("#result").hidden = !n;
    $("#drop").classList.toggle("compact", n > 0);
    $(".drop-title").textContent = n ? "继续添加：拖入更多文件，或" : c.dropTitle;
    const nWarn = rows.filter((r) => status(r) === "warn").length;
    const nErr = rows.filter((r) => r.error).length;
    // 前三个框是筛选按钮（全部 / 需核对 / 无法识别），其后是各工具自己的统计，只展示
    const card = (k, v) => `<div class="k">${esc(k)}</div><div class="v" title="${esc(v)}">${esc(v)}</div>`;
    $("#stats").innerHTML =
      [["all", c.allLabel, n], ["warn", "需核对", nWarn], ["err", "无法识别", nErr]]
        .map(([f, k, cnt]) => `<button type="button" class="stat filter${f === filter ? " active" : ""}${f !== "all" && cnt ? " warn" : ""}" data-f="${f}">${card(k, `${cnt} ${c.unit}`)}</button>`).join("") +
      c.stats(rows.filter((r) => r.data).map((r) => r.data)).map(([k, v]) => `<div class="stat">${card(k, v)}</div>`).join("");

    const q = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const span = c.columns.length + 2;
    document.querySelectorAll("#table thead th").forEach((th, i) => {
      th.classList.toggle("asc", i === sort.i && sort.dir > 0);
      th.classList.toggle("desc", i === sort.i && sort.dir < 0);
    });
    const html = [];
    for (const r of ordered()) {
      if (q.some((w) => !r.hay.includes(w)) || (filter !== "all" && status(r) !== filter)) continue;
      const open = openIds.has(String(r.id));
      const cells = r.error ? `<td colspan="${span - 2}">${esc(r.error)}</td>`
        : c.columns.map(([, td, cls]) => `<td${cls ? ` class="${cls}"` : ""}>${td(r.data)}</td>`).join("");
      html.push(`<tr class="main${open ? " open" : ""}" data-id="${esc(r.id)}"><td>${BADGE[status(r)]}</td>${cells}<td class="file" title="${esc(r.fileName)}">${esc(r.fileName)}</td></tr>`);
      if (open) {
        const body = r.error ? `<ul class="issues err"><li>${esc(r.error)}</li></ul>`
          : (r.data.issues.length ? `<ul class="issues">${r.data.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : "") + c.detail(r.data);
        html.push(`<tr class="detail"><td colspan="${span}">${body}</td></tr>`);
      }
    }
    $("#table tbody").innerHTML = html.join("") || `<tr><td colspan="${span}" class="tip">没有符合条件的记录</td></tr>`;
  }

  initFileInput(addFiles);
  render(); // 初始化拖放区标题等（空列表状态）
  $("#table tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.main");
    if (!tr) return;
    const id = tr.dataset.id;
    openIds.has(id) ? openIds.delete(id) : openIds.add(id);
    render();
  });
  $("#table thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-i]");
    if (!th) return;
    const i = +th.dataset.i;
    sort = { i, dir: sort.i === i ? -sort.dir : 1 };
    render();
  });
  $("#search").addEventListener("input", render);
  $("#stats").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-f]");
    if (!btn) return;
    filter = btn.dataset.f === filter ? "all" : btn.dataset.f; // 再点一次已选中的框，回到全部
    render();
  });
  $("#btnClear").addEventListener("click", () => { records = []; rebuild(); openIds.clear(); filter = "all"; render(); });

  // 出错的 PDF 不导出；打包见 unrecognizedDir
  const exportAll = () => exportExcel(c.excel.prefix, c.excel.sheets(rows.filter((r) => r.data).map((r) => ({ ...r.data, 原文件名: r.fileName }))));
  $("#btnExcel").addEventListener("click", exportAll);
  $("#btnZip").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const list = ok();
    if (!list.length) return toast("没有可导出的文件");
    btn.disabled = true;
    try {
      const entries = c.merge ? rows.flatMap((r) => r.files || []) : standardNames(list, c.fileName, c.unit);
      if (c.unrecognizedDir) for (const r of rows.filter((r) => r.error)) entries.push({ name: `${c.unrecognizedDir}/${relPath(r.file)}`, file: r.file });
      await downloadZip(entries, c.zipName);
    } finally {
      btn.disabled = false;
    }
  });

  // 供调试 / 自动化测试使用
  return { addFiles, exportExcel: exportAll, records: () => records, rows: () => rows };
}

/** 详情里的“字段：值”网格 */
const kvGrid = (obj, keys, label = {}) =>
  `<div class="kv">${keys.filter((k) => obj[k] != null && obj[k] !== "")
      .map((k) => `<div><b>${esc(label[k] || k)}</b><span>${esc(typeof obj[k] === "number" ? fmtMoney(obj[k]) : obj[k])}</span></div>`).join("")}</div>`;
/** 详情里的明细表：cols 为 [表头, 取值函数(返回 HTML), class] */
const itemTable = (items, cols) =>
  `<div class="items"><table><thead><tr>${cols.map(([th, , cls]) => `<th${cls ? ` class="${cls}"` : ""}>${esc(th)}</th>`).join("")}</tr></thead><tbody>${items
      .map((it, n) => `<tr>${cols.map(([, td, cls]) => `<td${cls ? ` class="${cls}"` : ""}>${td(it, n)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

export { createApp, loadPdf, notice, esc, fmtMoney, kvGrid, itemTable };
