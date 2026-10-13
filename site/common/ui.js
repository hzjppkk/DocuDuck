/*
 * 共用：工具页面框架。页面只提供配置（见 fapiao/app.js、chaxun/app.js，视图见 fapiao/views.js）：
 *   createApp({ title, sub, icon, dropTitle, search, tip?, query?, load, key, hay, ocr?, views: [视图] })
 * load(file) 返回 [解析结果]，一般用 withPdf(file, 解析函数)：带 页 的切出那几页作为 文件（File），用它代替原文件打包、打开
 * （如合订文件拆出的几页、一个 PDF 里的几张发票），带 错误 的作为无法识别。key(解析结果) 判重的键，hay(解析结果) 搜索用的文本。
 * 拖入的文件一次识别完，按视图分类显示：一级为视图标签页（如报关单、发票、无法识别，带数量，没有行的不显示），二级为表格上方的单选筛选；导出、提交只针对当前视图。
 * 视图：{ id, label, unit, columns, accepts(解析结果), 以及下列可选项 }
 *   accepts：哪些解析结果归这个视图（一份结果可归几个视图，如货代的数电发票）
 *   errors: true：识别不了的文件列在这个视图（文件名匹配某个视图 suspect.re 的列在那个视图）
 *   filters: [[状态, 名称]]：视图下的筛选（缺文件 lack、需核对 warn、疑似 sus）；选「全部」时列出除疑似以外的全部
 *   列表默认一个解析结果一行；merge(解析结果, 识别不了的文件, 服务器上的记录) 把多个文件合并成一行（如同一报关单的各单据），
 *     返回 [{ key, data, members: [解析结果], files: [{ member, name }] }]，打包时按 files 放置（name 可含“/”，即文件夹）；
 *     识别不了的文件为 [{ 原文件名, 错误, 无文字层 }]，并入某组的（成员的 来源 即该对象）不再列出
 *   不合并的视图按 fileName(解析结果) 规范命名打包（一个文件含几份的写“等N{unit}”）
 *   columns: [[表头, 显示, 样式, 排序取值]]；stats(list) → [[名称, 值]] 统计；sortBy 默认排序的列；sortKey(data) 并列时的次序；detail(data, 查询) 详情；excel { prefix, sheets(list) }；zipName
 *   fileColumn(筛选)：返回 false 时不显示原文件名列
 *   suspect { label, re }：文件名匹配 re 的识别不了的文件、merge 标了 suspect 的行归为“疑似”（sus）
 *   lacking(data, 查询)：返回 true 时状态为“缺文件”（次于需核对）
 *   fill(行 id, 行的 data, 单据类型, file) → 解析结果：详情里 data-fill="单据类型" 的按钮选一个 PDF，不经识别直接作为该行的这类单据，
 *     由 merge 归入该行（同名同大小的无法识别记录一并去掉）
 *   groupBy(data) → 分组名 | null，groupRow(分组名, [data]) → 各列的 HTML：列表按分组折叠（如按合同号），
 *     分组行显示概况和组内最差的状态，点击展开；搜索、筛选时自动展开。只有一行的组不分组；不分组的行排在所有分组之后
 *   以下与存档（提交到服务器）有关，由 archive.js 实现：
 *   submit：提交到服务器（scripts/serve.py）时的目录名；是否已提交都查服务器清单，detail、lacking 的 查询 =
 *     { has(名称)：这个文件已提交, types(编号)：清单里这份已有的单据类型 }。
 *     服务器上的修改时间更晚（不论大小），或时间、大小都相同的算已提交、提交时跳过；否则算待提交，提交时覆盖
 *   serverMeta(data, 成员?) → { 字段, 组?: [{ 名称, 校验 }] }：提交时记入服务器清单的内容（只放非敏感的；组的 校验 由服务器换成校验值）
 *   serverRows(服务器清单 { groups, files }, 校验值 → 本地编号, 本地提运单 → 对上的报关单) → [记录]：服务器上的记录
 *     （查询页为全部已提交的；单据核验页为本地提运单、发票对上的），合并的视图交给 merge；没有本地文件的行为“服务器上的行”，不导出 Excel
 *   serverKeys(data) → [编号]：用来对上服务器清单（换成校验值比对）的本地编号：查已有哪些单据类型
 *   serverBill(data) → { 全文, 集装箱号 } | null：交给服务器比对的本地提运单、发票（对上的经 serverRows 并入服务器上的报关单）
 * 页面级的其他项：
 *   query：查询页（只读）：不能拖入文件，打开即列出服务器上已提交的（查询白名单内），工具栏只有搜索、下载归档、删除归档
 *   ocr { on: [状态], parse(文字, file) → [解析结果] }：服务器启用了 OCR（scripts/serve.py、config.ini 的 [OCR]）时，这些状态的无法识别行
 *     显示「OCR」按钮：文件经服务器交给 OCR 接口，返回的文字由 parse 解析，替换原来的出错记录
 * 原文件名可点击，在新标签页打开本地的 PDF；详情里 data-open="原文件名" 的元素同样（只在所在行的文件里找）
 * 页面骨架（标题、拖放区、视图标签页、统计、工具栏、筛选、表格、页脚）由这里生成，html 只需以模块方式引入页面的 app.js。
 * 第三方库：pdf.js、SheetJS 为 ES 模块，在这里导入（SheetJS 导出 Excel 时才加载）；JSZip 只发布 UMD 版，由 html 用普通 <script> 加载为全局变量。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import * as DocPdf from "./pdf.js";
import { standardNames } from "./text.js";
import { $, esc, fmtMoney, friendlyError, toast, notice, progress, busy } from "./dom.js";
import { connect } from "./archive.js";
import { THREADS, mapLimit } from "./pool.js";

const dateStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

// ---------- PDF ----------
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", PDFJS).href;
/**
 * CMap、标准字体等资源（发票、报关单常用 GBK-EUC-H、UniGB-UCS2-H 等中文编码，缺 CMap 时中文会整段丢失）：
 * pdf.js 默认每打开一个 PDF 都重新下载一次，批量识别时同一个文件要请求几百次，经网络访问服务器时请求排队、卡住几十秒。
 * 这里改为页面下载一次后存在内存里，之后各 PDF 都用这份（每次给一份拷贝：pdf.js 会把数据转交给 Worker）
 */
const binaryCache = new Map(); // 地址 → Promise<Uint8Array>
class CachedBinaryData {
  constructor(urls) {
    this.urls = urls; // { cMapUrl, standardFontDataUrl, wasmUrl }
  }
  async fetch({ kind, filename }) {
    const url = this.urls[kind] + filename;
    if (!binaryCache.has(url)) {
      const p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${url}`)))).then((b) => new Uint8Array(b));
      p.catch(() => binaryCache.delete(url)); // 失败的不缓存，下次重试
      binaryCache.set(url, p);
    }
    return (await binaryCache.get(url)).slice();
  }
}
const PDF_OPTIONS = {
  cMapUrl: new URL("cmaps/", PDFJS).href,
  standardFontDataUrl: new URL("standard_fonts/", PDFJS).href,
  wasmUrl: new URL("wasm/", PDFJS).href,
  iccUrl: new URL("iccs/", PDFJS).href,
  BinaryDataFactory: CachedBinaryData,
  useWorkerFetch: false, // 资源由页面（CachedBinaryData）取，不让 Worker 各自下载
};

/**
 * pdf.js 的 Worker 线程（解析 PDF、提取文字、解码图片在其中进行）：用完放回、下个文件接着用（pdf.js 默认每个文件新建一个，每次多花约 40 ms）。
 * 同时处理几个文件（pool.js THREADS）就有几个，各在各的线程里并行
 */
const idleWorkers = [];
async function withWorker(fn) {
  // 只输出错误：不少 PDF 的内嵌字体不规范（“TT: undefined function”等警告），只影响显示字形，不影响取文字
  const worker = idleWorkers.pop() || new pdfjsLib.PDFWorker({ verbosity: pdfjsLib.VerbosityLevel.ERRORS });
  try {
    return await fn({ ...PDF_OPTIONS, worker });
  } finally {
    idleWorkers.push(worker);
  }
}

/**
 * 页面的 load 用：打开 PDF（提取文字、检查文字层）交给 parse({ doc, pages, attachments }) → [解析结果]；
 * 结果中带 页 的（一个 PDF 含几份单据）切出那几页作为它的 文件（common/pdf.js cutParts），最后释放 PDF
 */
const withPdf = (file, parse) => withWorker(async (options) => {
  const pdf = await DocPdf.loadPdf(pdfjsLib, new Uint8Array(await file.arrayBuffer()), options);
  try {
    const list = await parse(pdf);
    await DocPdf.cutParts(pdf.doc, file, list);
    return list;
  } finally {
    await pdf.close(); // Worker 是传入的，不会被一起关掉
  }
});

/** 页数（不检查文字层，扫描件也能读；OCR 用） */
const pageCount = (file) => withWorker(async (options) => {
  const task = pdfjsLib.getDocument({ ...options, data: new Uint8Array(await file.arrayBuffer()) });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
});

// ---------- 页面骨架 ----------
function skeleton(c) {
  const version = document.querySelector('meta[name="version"]')?.content; // 发布打包时写入（.github/workflows/release.yml）
  document.body.innerHTML = `
<header class="top"><div class="wrap">
  <a class="home" href="../index.html">← 返回首页</a>
  <h1>${esc(c.title)}</h1>
  <p class="sub">${esc(c.sub)}</p>
  ${c.tip ? `<p class="hint">💡 ${esc(c.tip)}</p>` : ""}
  <p id="notice" class="notice" hidden></p>
</div></header>
<main class="wrap">
  ${c.query ? `<p id="progress" class="progress" hidden></p>` : `<section id="drop" class="drop" tabindex="0">
    <div class="drop-icon" aria-hidden="true">${c.icon}</div>
    <p class="drop-title"></p>
    <p class="drop-hint">只识别带文字层的 PDF</p>
    <div class="drop-btns">
      <label class="btn primary">选择 PDF 文件<input id="pickFiles" type="file" accept=".pdf,application/pdf" multiple hidden></label>
      <label class="btn">选择文件夹<input id="pickDir" type="file" webkitdirectory multiple hidden></label>
    </div>
    <p id="progress" class="progress" hidden></p>
  </section>`}
  <section id="result"${c.query ? "" : " hidden"}>
    <nav id="views" class="tabs" role="tablist"></nav>
    <div id="stats" class="stats"></div>
    <div class="toolbar">
      ${c.query ? `<button id="btnDownload" class="btn primary" hidden>⬇ 下载归档</button><button id="btnPurge" class="btn" disabled>删除归档</button>`
    : `<button id="btnExcel" class="btn primary">⬇ 导出 Excel</button><button id="btnZip" class="btn">⬇ 导出 PDF</button>
      <button id="btnSubmit" class="btn" hidden>⬆ 提交</button>`}
      <input id="search" class="search" type="search" placeholder="${esc(c.search)}">
      ${c.query ? "" : `<button id="btnClear" class="btn ghost">清空</button>`}
    </div>
    <div id="filters" class="seg" role="radiogroup" aria-label="筛选"></div>
    <div class="table-wrap"><table id="table"><thead><tr></tr></thead><tbody></tbody></table></div>
  </section>
</main>
<footer class="wrap foot">${version ? `<p>版本 ${esc(version)}</p>` : ""}</footer>
<div id="toast" class="toast" hidden></div>`;
}

/** 当前视图的表头：只继承对齐（num），不继承字体类（如 mono 会让中文表头失去加粗） */
const theadHtml = (v) => ["状态", ...v.columns.map(([th]) => th), "原文件名"].map((th, i) =>
  `<th data-i="${i}"${/\bnum\b/.test((v.columns[i - 1] || [])[2] || "") ? ` class="num"` : i === v.columns.length + 1 ? ` class="file"` : ""}>${esc(th)}</th>`).join("");

// ---------- 文件输入 ----------
/** 只有虚线框接收拖放；框外显示“禁止”光标，松手也不会让浏览器打开 PDF。非 PDF 直接排除 */
function initFileInput(onFiles) {
  const drop = $("#drop");
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  // others：已按文件名排除的其他文件数；unreadable：读不出的文件数（见 readFolders）
  const deliver = (files, others = 0, unreadable = 0) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    const excluded = files.length - pdfs.length + others;
    if (!pdfs.length) return toast(unreadable ? `有 ${unreadable} 个 PDF 读不出（可能被占用、路径过长或同步盘未下载到本地）` : excluded ? "没有找到 PDF 文件" : "没有读取到文件");
    onFiles(pdfs, excluded, unreadable);
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
    readFolders(entries).then(({ out, others, unreadable }) => deliver(out, others, unreadable));
  });
  for (const id of ["#pickFiles", "#pickDir"])
    $(id).addEventListener("change", (e) => { deliver([...e.target.files]); e.target.value = ""; });
}

/**
 * 读取拖入的文件夹（File and Directory Entries API，名称带 webkit 前缀，各浏览器都已实现）：只打开 PDF，其他文件按文件名计数、不碰（打开中的 Office 临时文件 ~$xxx、同步盘未下载的占位文件打开会出错）；
 * 个别文件或子文件夹读不出时跳过并计数，不中断整个读取。返回 { out: [File], others, unreadable }
 */
async function readFolders(entries) {
  const pdfs = [];
  let others = 0, unreadable = 0;
  // 先走完目录树，只记下 PDF 的条目
  const walk = async (en) => {
    if (en.isFile) return /\.pdf$/i.test(en.name) ? pdfs.push(en) : others++;
    try {
      const reader = en.createReader();
      for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) for (const c of batch) await walk(c);
    } catch (e) {
      unreadable++;
      console.warn("读不出文件夹：", en.fullPath, e);
    }
  };
  progress("正在读取文件夹…");
  try {
    for (const en of entries.filter(Boolean)) await walk(en);
    // 再同时打开几个（同步盘的占位文件打开较慢）；结果按目录顺序
    const files = await mapLimit(pdfs, THREADS * 2, (en) => new Promise((res, rej) => en.file(res, rej)),
      (n) => progress(`正在读取文件夹…${n} / ${pdfs.length} 个 PDF`));
    files.forEach((r, i) => r.error && (unreadable++, console.warn("读不出：", pdfs[i].fullPath, r.error)));
    const out = files.filter((r) => !r.error).map((r) => r.value);
    progress(out.length ? `已找到 ${out.length} 个 PDF，开始识别…` : "");
    return { out, others, unreadable };
  } catch (e) {
    progress("");
    throw e;
  }
}

// ---------- 导出 ----------
/** sheets: [{name, rows, cols, widths, labels}]；labels 为表头显示名（缺省用字段名）；号码、税号是字符串，写入后为文本单元格 */
async function exportExcel(prefix, sheets) {
  const XLSX = await import("../vendor/xlsx.mjs"); // 近 1 MB，点「导出 Excel」时才加载
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

/**
 * entries: [{name, file, meta?}]；同名同文件只留一份（如同一文件夹里几份报关单共用的提运单，其 meta 的 组 合在一起），
 * 同名不同文件加 (2)(3)…
 */
function uniqueNames(entries) {
  const used = new Map(); // 名称 → [已放入的条目]
  const out = [];
  for (const { name, file, meta } of entries) {
    const list = used.get(name) || [];
    const same = list.find((x) => x.file === file);
    if (same) {
      if (same.meta && meta) same.meta = { ...same.meta, 组: [...same.meta.组, ...meta.组.filter((g) => !same.meta.组.some((h) => h.校验 === g.校验))] };
      continue;
    }
    const x = { name: list.length ? name.replace(/\.pdf$/i, `(${list.length + 1}).pdf`) : name, file, meta };
    used.set(name, [...list, x]);
    out.push(x);
  }
  return out;
}

async function downloadZip(entries, zipName) {
  const zip = new JSZip();
  for (const { name, file } of entries) zip.file(name, file); // 直接交给 JSZip，打包时才读取
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- 应用 ----------
const BADGE = { ok: "✓ 正常", lack: "⚠ 缺文件", warn: "⚠ 需核对", err: "✗ 无法识别" };
const RANK = { ok: 0, lack: 1, warn: 2, sus: 3, err: 4 };

function createApp(c) {
  skeleton(c);
  const views = c.views;
  let view = views[0]; // 当前视图
  // 与服务器的交互（已提交、提交、查询、OCR）见 archive.js；这里用到的函数都包一层，到调用时才取
  const sv = connect(c, {
    view: () => view, records: () => records, rebuild: () => rebuild(), render: () => render(),
    packEntries: (v) => packEntries(v), pageCount, replace: (r, datas) => replace(r, datas), status: (r, v) => status(r, v),
  });
  /** 记录：{ id, fileName, file, data?, error? }；一个文件可产生多条记录（如一个 PDF 含多张发票） */
  let records = [];
  let nextId = 1;
  /**
   * 各视图的行：不合并的视图即记录（加上服务器上的记录）；合并的为 { id, fileName（各文件名）, data, files: [{ name, file, meta }], recs, suspect, hay }；
   * 再加上该视图认领的、没被并入的出错记录
   */
  let rowsBy = new Map();
  const rowsOf = (v) => rowsBy.get(v) || [];
  const openIds = new Set();
  const openGroups = new Set();
  // 各视图的排序（默认第一列或 sortBy 升序）、筛选（all 或 filters 里的状态）
  const initial = (v) => ({ sort: { i: 1 + Math.max(0, v.columns.findIndex(([th]) => th === v.sortBy)), dir: 1 }, filter: "all" });
  const state = new Map(views.map((v) => [v, initial(v)]));
  const status = (r, v) => (r.error ? (v.suspect && v.suspect.re.test(r.fileName) ? "sus" : "err")
    : v.suspect && r.suspect ? "sus" : r.data.issues.length ? "warn" : v.lacking && v.lacking(r.data, sv.check(v)) ? "lack" : "ok");
  const badge = (st, v) => `<span class="badge ${st}">${esc(st === "sus" ? `📎 ${v.suspect.label}` : BADGE[st])}</span>`;
  /** 一行的本地文件记录：合并的行为各成员，否则为记录本身（服务器上的行没有） */
  const filesOf = (r) => r.recs || (r.file ? [r] : []);
  const openLink = (name) => `<a href="#" class="open" data-open="${esc(name)}">${esc(name)}</a>`;
  const ok = () => records.filter((r) => r.data);
  /** 新记录（尚未编号）；hay：搜索用的文本，添加时算一次 */
  const recordOf = (file, data) => ({ fileName: file.name, file, data, hay: `${file.name} ${c.hay(data)}`.toLowerCase() });
  const errorOf = (file, error, noText) => ({ id: nextId++, fileName: file.name, file, error, noText, hay: file.name.toLowerCase() });

  function rebuild() {
    const rec = new Map(ok().map((r) => [r.data, r]));
    const failed = new Map(records.filter((r) => r.error).map((r) => [{ 原文件名: r.fileName, 错误: r.error, 无文字层: r.noText }, r]));
    for (const [stub, r] of failed) rec.set(stub, r);
    const recOf = (m) => rec.get(m.来源 || m);
    const used = new Set(); // 并入某行的出错记录
    rowsBy = new Map(views.map((v) => {
      const mine = ok().filter((r) => v.accepts(r.data));
      const server = sv.serverRecords(v);
      if (!v.merge) return [v, [...mine, ...server.map((data, i) => ({ id: `${v.id}-${i}`, data, server: true, fileName: "", hay: c.hay(data).toLowerCase() }))]];
      // 服务器上已提交的一并交给 merge，本地拖入的单据（如提运单）可并入服务器上的报关单
      const groups = v.merge(mine.map((r) => r.data), [...failed.keys()], server);
      for (const g of groups) for (const m of g.members) used.add(recOf(m));
      return [v, groups.map((g) => ({
        id: g.key, data: g.data, recs: g.members.map(recOf), suspect: g.suspect, server: !g.members.length,
        fileName: g.members.map((m) => recOf(m).fileName).join("、"),
        files: g.files.map(({ member, name }) => ({ name, file: recOf(member).file, meta: v.serverMeta && name ? v.serverMeta(g.data, member) : null })),
        hay: g.members.length ? g.members.map((m) => recOf(m).hay).join(" ") : c.hay(g.data).toLowerCase(),
      }))];
    }));
    // 没被并入的出错记录：文件名像某个视图的疑似单据的归那个视图，其余归 errors 视图
    const owner = (r) => views.find((v) => v.suspect && v.suspect.re.test(r.fileName)) || views.find((v) => v.errors);
    for (const r of records.filter((r) => r.error && !used.has(r))) owner(r) && rowsOf(owner(r)).push(r);
  }

  /** 重建列表并显示，再问服务器哪些已提交（问完再刷新一次显示） */
  const refresh = () => { rebuild(); render(); sv.checkExists(); };

  // 排序：点列标题切换升 / 降序；无法识别的记录始终在最后
  // 取值：状态、原文件名内置；其余为列配置的第 4 项（数字按大小，文字按拼音、其中数字按数值；空值在最后）
  const empty = (x) => x == null || x === "";
  const collator = new Intl.Collator("zh-CN", { numeric: true }); // 复用：localeCompare 带选项时每次比较都新建一个，几千行排序明显变慢
  const cmpVal = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b)));
  function ordered(list, v, stOf) {
    const { sort } = state.get(v);
    const f = [(r) => RANK[stOf(r)], ...v.columns.map(([, , , g]) => (r) => (g ? g(r.data) : "")), (r) => r.fileName][sort.i];
    // 排序值先算好（x：所选列，t：并列时的次序），比较时不再反复计算
    const keyed = list.map((r) => (r.error ? { r, x: "", t: RANK[stOf(r)] + r.fileName } : { r, x: f(r), t: v.sortKey(r.data) }));
    keyed.sort((a, b) => {
      if (!!a.r.error !== !!b.r.error) return a.r.error ? 1 : -1;
      if (a.r.error) return cmpVal(a.t, b.t);
      if (empty(a.x) !== empty(b.x)) return empty(a.x) ? 1 : -1;
      return (empty(a.x) ? 0 : cmpVal(a.x, b.x) * sort.dir) || cmpVal(a.t, b.t);
    });
    return keyed.map((k) => k.r);
  }

  async function addFiles(pdfs, excluded = 0, unreadable = 0) {
    let added = 0, dup = 0, failed = 0;
    // 识别：同时处理 THREADS 个（pool.js）；结果按文件原顺序收进列表，判重等与逐个处理相同
    const t0 = performance.now();
    const results = await mapLimit(pdfs, THREADS, (file) => c.load(file), (n, file) => progress(`正在识别 ${n} / ${pdfs.length}：${file.name}`));
    console.info(`识别 ${pdfs.length} 个文件，并发 ${THREADS}，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
    const seen = new Map(ok().map((r) => [c.key(r.data), r])); // 判重的键 → 已有的记录
    for (const [i, file] of pdfs.entries()) {
      try {
        if (results[i].error) throw results[i].error;
        for (const data of results[i].value) {
          // 一个文件拆出的几份里识别不出的那份（带 错误 和它自己的 文件）：作为无法识别
          if (data.错误) {
            records.push(errorOf(data.文件, data.错误));
            failed++;
            continue;
          }
          // 解析结果带 文件 的（如合订文件拆出的几页）用它打包、打开
          const f = data.文件 || file;
          const rec = recordOf(f, data);
          // 重复的保留文件修改时间较晚的那份（归档用它）
          const k = c.key(data), old = k && seen.get(k);
          if (old) {
            dup++;
            if (f.lastModified > old.file.lastModified) Object.assign(old, rec);
            continue;
          }
          records.push(Object.assign(rec, { id: nextId++ }));
          if (k) seen.set(k, rec);
          added++;
        }
      } catch (err) {
        records.push(errorOf(file, friendlyError(err), err.code === "NO_TEXT"));
        failed++;
      }
    }
    progress("");
    refresh();
    const msg = [`已识别 ${added} 份单据`];
    if (dup) msg.push(`跳过重复 ${dup} 份`);
    if (failed) msg.push(`${failed} 个文件无法识别`);
    if (excluded) msg.push(`已排除 ${excluded} 个非 PDF 文件`);
    if (unreadable) msg.push(`${unreadable} 个读不出（可能被占用、路径过长或同步盘未下载到本地）`);
    toast(msg.join("，"));
  }

  /**
   * 一个视图要显示的行和各行状态（状态每次显示算一遍，lacking 要逐个查服务器上的文件）；
   * 无法识别、疑似的文件库中已有（大小、修改时间都相同，见 archive.js inStore）：不列出，只计数
   */
  function listOf(v) {
    const S = new Map(rowsOf(v).map((r) => [r, status(r, v)]));
    const stOf = (r) => S.get(r);
    const shown = rowsOf(v).filter((r) => !((stOf(r) === "err" || stOf(r) === "sus") && sv.inStore(filesOf(r).map((x) => x.file))));
    return { stOf, shown, nStored: S.size - shown.length };
  }
  // 不筛选时列出除疑似以外的全部（疑似只在它的筛选里）
  const inAll = (st) => st !== "sus";

  function render() {
    const lists = new Map(views.map((v) => [v, listOf(v)]));
    // 没有行的视图不显示标签；当前视图没有行时切到第一个有行的
    const has = (v) => lists.get(v).shown.length > 0;
    if (!has(view)) view = views.find(has) || view;
    if (!c.query) {
      const n = records.length;
      $("#result").hidden = !n;
      $("#drop").classList.toggle("compact", n > 0);
      $(".drop-title").textContent = n ? "继续添加：拖入更多文件，或" : c.dropTitle;
      $("#btnExcel").hidden = !view.excel;
      $("#btnZip").hidden = !view.zipName;
      $("#btnSubmit").hidden = !(view.submit && sv.canSubmit());
    } else $("#btnDownload").hidden = !(view.submit && sv.canDownload());
    const card = (k, val) => `<div class="k">${esc(k)}</div><div class="v">${esc(val)}</div>`;
    // 一级：视图标签页，数量为不筛选时列出的行数
    $("#views").innerHTML = views.filter(has).map((v) => {
      const { shown, stOf } = lists.get(v);
      return `<button type="button" class="tab" role="tab" aria-selected="${v === view}" data-v="${esc(v.id)}">${esc(v.label)}<span class="count">${shown.filter((r) => inAll(stOf(r))).length}</span></button>`;
    }).join("");

    // 当前视图的统计（只展示）
    const { stOf, shown, nStored } = lists.get(view);
    const st = state.get(view);
    const count = (s) => shown.filter((r) => stOf(r) === s).length;
    const stats = [...(nStored ? [["已在库中", `${nStored} 个`]] : []), ...(view.stats ? view.stats(shown.filter((r) => r.data).map((r) => r.data)) : [])];
    $("#stats").hidden = !stats.length;
    $("#stats").innerHTML = stats.map(([k, val]) => `<div class="stat">${card(k, val)}</div>`).join("");
    // 二级：表格上方的单选筛选（全部、缺文件、需核对、疑似…），有数量的标黄
    const filters = view.filters || [];
    $("#filters").hidden = !filters.length;
    $("#filters").innerHTML = [["all", "全部", null], ...filters.map(([f, k]) => [f, k, count(f)])].map(([f, k, cnt]) =>
      `<button type="button" role="radio" aria-checked="${f === st.filter}" data-f="${f}">${esc(k)}${cnt == null ? "" : `<span class="count${cnt ? " warn" : ""}">${cnt}</span>`}</button>`).join("");

    const q = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const span = view.columns.length + 2;
    // fileColumn(筛选)：返回 false 时不显示原文件名列（如报关单一行多个文件）
    $("#table").classList.toggle("nofile", !!view.fileColumn && !view.fileColumn(st.filter));
    $("#table thead tr").innerHTML = theadHtml(view);
    document.querySelectorAll("#table thead th").forEach((th, i) => {
      th.classList.toggle("asc", i === st.sort.i && st.sort.dir > 0);
      th.classList.toggle("desc", i === st.sort.i && st.sort.dir < 0);
    });
    const html = [];
    const td = (cls, h) => `<td${cls ? ` class="${cls}"` : ""}>${h}</td>`;
    const pushRow = (r, child) => {
      const s = stOf(r);
      const open = openIds.has(String(r.id));
      const cells = r.error ? `<td colspan="${span - 2}">${esc(r.error)}</td>` : view.columns.map(([, f, cls]) => td(cls, f(r.data))).join("");
      html.push(`<tr class="main${child ? " child" : ""}${open ? " open" : ""}" data-id="${esc(r.id)}"><td>${badge(s, view)} ${sv.ocrButton(r, s)}</td>${cells}<td class="file">${filesOf(r).map((x) => openLink(x.fileName)).join("、")}</td></tr>`);
      if (open) {
        const body = r.error ? `<ul class="issues err"><li>${esc(r.error)}</li></ul>`
          : (r.data.issues.length ? `<ul class="issues">${r.data.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "") + view.detail(r.data, sv.check(view));
        html.push(`<tr class="detail" data-id="${esc(r.id)}"><td colspan="${span}">${body}</td></tr>`);
      }
    };
    // 分组（groupBy）：分组按组内第一行的排序位置排列，不分组的行在所有分组之后
    const groups = new Map(), flat = [];
    for (const r of ordered(shown, view, stOf)) {
      const s = stOf(r);
      if (q.some((w) => !r.hay.includes(w)) || (st.filter === "all" ? !inAll(s) : s !== st.filter)) continue;
      const g = view.groupBy && r.data ? view.groupBy(r.data) : null;
      if (g == null) flat.push(r);
      else if (groups.has(g)) groups.get(g).push(r);
      else groups.set(g, [r]);
    }
    const auto = q.length > 0 || st.filter !== "all"; // 搜索、筛选时展开命中的分组
    for (const [g, rs] of groups) {
      if (rs.length === 1) { pushRow(rs[0]); continue; } // 只有一行的不分组
      const open = auto || openGroups.has(g);
      const worst = rs.map(stOf).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
      html.push(`<tr class="group${open ? " open" : ""}" data-group="${esc(g)}"><td>${badge(worst, view)}</td>${view.groupRow(g, rs.map((r) => r.data))
        .map((h, i) => td(view.columns[i][2], h)).join("")}<td class="file"></td></tr>`);
      if (open) rs.forEach((r) => pushRow(r, true));
    }
    flat.forEach((r) => pushRow(r));
    $("#table tbody").innerHTML = html.join("") || `<tr><td colspan="${span}" class="tip">没有符合条件的记录</td></tr>`;
  }

  if (!c.query) initFileInput(addFiles);
  rebuild();
  render(); // 初始化拖放区标题等（空列表状态）
  const rowOf = (id) => rowsOf(view).find((r) => String(r.id) === id);
  $("#table tbody").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]"), fill = e.target.closest("[data-fill]");
    const row = rowOf(e.target.closest("tr[data-id]")?.dataset.id);
    if (open) {
      e.preventDefault();
      const rec = filesOf(row).find((x) => x.fileName === open.dataset.open);
      if (rec) openPdf(rec.file);
      return;
    }
    if (fill) return pickFill(row, fill.dataset.fill);
    const grp = e.target.closest("tr.group");
    if (grp) {
      const g = grp.dataset.group;
      openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g);
      return render();
    }
    const tr = e.target.closest("tr.main");
    if (!tr) return;
    if (e.target.closest("[data-ocr]")) return sv.runOcr(rowOf(tr.dataset.id), e.target.closest("[data-ocr]"));
    const id = tr.dataset.id;
    openIds.has(id) ? openIds.delete(id) : openIds.add(id);
    render();
  });
  $("#table thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-i]");
    if (!th) return;
    const i = +th.dataset.i, st = state.get(view);
    st.sort = { i, dir: st.sort.i === i ? -st.sort.dir : 1 };
    render();
  });
  let searchTimer; // 停止输入 120 ms 后再重排重绘，不必每按一键都做
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
  $("#views").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-v]");
    if (!btn) return;
    view = views.find((v) => v.id === btn.dataset.v);
    openIds.clear();
    render();
  });
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-f]");
    if (!btn) return;
    state.get(view).filter = btn.dataset.f;
    render();
  });
  $("#btnClear")?.addEventListener("click", () => {
    records = [];
    openIds.clear();
    openGroups.clear();
    for (const v of views) state.get(v).filter = "all";
    refresh();
  });

  // 出错的 PDF、服务器上的行不导出
  const exportAll = () => exportExcel(view.excel.prefix, view.excel.sheets(rowsOf(view).filter((r) => r.data && !r.server).map((r) => ({ ...r.data, 原文件名: r.fileName }))));
  $("#btnExcel")?.addEventListener("click", exportAll);
  /**
   * 视图打包 / 提交的文件 [{ name, file, meta }]：能规范命名的都要（需核对的也照常）。合并的视图取各行有打包位置的文件
   * （无法识别的行没有 files、服务器上的行 files 为空、merge 没给位置的 name 为空），不合并的按 fileName 规范命名
   */
  function packEntries(v) {
    if (v.merge) return uniqueNames(rowsOf(v).flatMap((r) => r.files || []).filter((f) => f.name));
    const mine = ok().filter((r) => v.accepts(r.data));
    const dataOf = new Map(mine.map((r) => [r.file, r.data]));
    return standardNames(mine, v.fileName, v.unit).map((x) => ({ ...x, meta: v.serverMeta ? v.serverMeta(dataOf.get(x.file)) : null }));
  }
  $("#btnZip")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const entries = packEntries(view);
    if (!entries.length) return toast("没有可导出的文件");
    await downloadZip(entries, view.zipName);
  }));

  /** 在新标签页打开本地 PDF（浏览器自带的阅读器） */
  function openPdf(file) {
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** 补单据：选一个 PDF，由当前视图的 fill 直接作为该行的这类单据；同一文件若在“无法识别”里，一并去掉 */
  function pickFill(row, type) {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".pdf,application/pdf" });
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const same = (r) => r.error && r.file.name === file.name && r.file.size === file.size;
      records = records.filter((r) => !same(r));
      records.push({ ...recordOf(file, view.fill(row.id, row.data, type, file)), id: nextId++ });
      refresh();
    });
    input.click();
  }

  /** OCR 的结果替换原来的出错记录，返回它现在在当前视图里所在的行 */
  function replace(r, datas) {
    if (!records.includes(r)) return null; // OCR 期间列表被清空了
    records.splice(records.indexOf(r), 1, ...datas.map((data) => ({ ...recordOf(r.file, data), id: nextId++ })));
    refresh();
    return rowsOf(view).find((x) => x.recs && x.recs.some((m) => m.file === r.file));
  }

  // 供调试 / 自动化测试使用
  return { addFiles, records: () => records, rows: (v = view) => rowsOf(v) };
}

/** 详情里的“字段：值”网格 */
const kvGrid = (obj, keys, label = {}) =>
  `<div class="kv">${keys.filter((k) => obj[k] != null && obj[k] !== "")
      .map((k) => `<div><b>${esc(label[k] || k)}</b><span>${esc(typeof obj[k] === "number" ? fmtMoney(obj[k]) : obj[k])}</span></div>`).join("")}</div>`;
/** 详情里的明细表：cols 为 [表头, 取值函数(返回 HTML), class] */
const itemTable = (items, cols) =>
  `<div class="items"><table><thead><tr>${cols.map(([th, , cls]) => `<th${cls ? ` class="${cls}"` : ""}>${esc(th)}</th>`).join("")}</tr></thead><tbody>${items
      .map((it, n) => `<tr>${cols.map(([, td, cls]) => `<td${cls ? ` class="${cls}"` : ""}>${td(it, n)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

export { createApp, withPdf, notice, esc, fmtMoney, kvGrid, itemTable };
