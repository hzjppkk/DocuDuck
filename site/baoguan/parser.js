/*
 * 出口报关资料解析：一个 PDF 一份单据。一种版式一个专家（EXPERTS：识别 + 解析），结果记下 单据类型 和 版式
 *   出口退税联：报关单出口退税联（JG09 打印版），含商品明细
 *   预填单：报关行发来的报关单（多为“仅供核对用”），三种版式，其一整页旋转 90°（坐标已按页面旋转换算，见 common/pdf.js）
 *   放行通知书：通关无纸化出口（查验 /）放行通知书，三种版式
 *   电子委托：代理报关委托书（电子），票面只有数值、标签是图片，按固定模板的位置取值，两种模板
 *   提单：海运提单、空运单、电放件等，格式各异，只用于关联：在全文里找同批报关单的提运单号，找不到再比对集装箱号
 * 合并（mergeDocs）：同一报关单的单据合为一组（网页一行）。委托、提单没有合同号，按报关单号 / 提运单号 / 集装箱号
 *   并入同批的报关单类单据（退税联、预填单、放行通知书），合并字段并核对是否一致；归档路径“合同号/申报日期/单据类型_报关单号.pdf”，
 *   同一天同一合同的多份报关单在同一文件夹
 *
 * 输入：每页文本块 [{str, x, y, w}]（y 自上而下，见 common/pdf.js）
 * 输出：{ 单据类型, header, items, totals, 集装箱号, issues }
 */
import * as X from "../common/text.js";

const { prepare, round2, normDate, squash, halfBrackets } = X;

const TOL = 2.5; // 同一行的 y 容差（pt）
const sameRow = (a, b) => X.sameRow(a, b, TOL);
const joinText = (tokens) => X.joinText(tokens, { tol: TOL, inline: " " });

const num = (s) => {
  const m = /^-?[\d.]+/.exec(s || "");
  return m ? parseFloat(m[0]) : null;
};
/** "810.57千克" -> [810.57, "千克"] */
const qtyUnit = (s) => {
  const m = /^([\d.]+)\s*(.*)$/.exec(s || "");
  return m ? [parseFloat(m[1]), m[2]] : [null, s || ""];
};

/** 解析一页中的商品明细 */
function parseItems(T) {
  const headRow = T.find((t) => t.s === "商品序号");
  if (!headRow) return [];
  const endRow = T.find((t) => t.s === "税费征收情况");
  const bottom = endRow ? endRow.y - TOL : Infinity;
  const area = T.filter((t) => t.y > headRow.y + TOL && t.y < bottom);

  // 每个商品以「序号 + 10 位商品编号」开头的行作为起点
  const starts = area
    .filter((t) => /^\d{10}$/.test(t.s))
    .map((c) => {
      const seq = area.find((t) => sameRow(t, c) && t.x < c.x && /^\d+$/.test(t.s));
      return seq && { y: c.y, seq: parseInt(seq.s, 10), codeTok: c };
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y);

  const out = [];
  starts.forEach((st, idx) => {
    const blockEnd = idx + 1 < starts.length ? starts[idx + 1].y - TOL : bottom;
    const blk = area.filter((t) => t.y >= st.y - TOL && t.y < blockEnd);
    const [lb1, lb2, lb3] = ["法定数量/法定单位", "第二数量/第二单位", "申报数量/申报单位"].map((s) => blk.find((t) => t.s === s));
    if (!lb1) return;
    const onRow = (lb) => (lb ? blk.filter((t) => sameRow(t, lb) && t.x > lb.x).sort((a, b) => a.x - b.x) : []);

    // 第一行：法定数量  目的国  单价  总价  币制  [征免]
    const [qty1Tok, countryTok, priceTok, totalTok, curTok, taxTok] = onRow(lb1);
    let price = priceTok ? priceTok.s : "";
    let total = totalTok ? totalTok.s : "";
    // 单价 / 总价过长会折到下一小行，按 x 坐标归入对应列
    if (priceTok && totalTok) {
      blk
        .filter((t) => t.y > lb1.y + TOL && (!lb2 || t.y < lb2.y - TOL) && t.x >= priceTok.x - 1 && t.x < (curTok ? curTok.x - 1 : Infinity) && /^[\d.]+$/.test(t.s))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .forEach((t) => (t.x < totalTok.x - 1 ? (price += t.s) : (total += t.s)));
    }

    // 名称列（商品编号右侧到数量标签左侧）：第二数量行之前是名称，之后是规格型号
    const nameCol = blk.filter((t) => t.x >= st.codeTok.x + 20 && t.x < lb1.x - 1);
    const splitY = lb2 ? lb2.y - TOL : Infinity;
    const r2 = onRow(lb2);
    const [q1, u1] = qtyUnit(qty1Tok && qty1Tok.s);
    const [q2, u2] = qtyUnit(r2[0] && r2[0].s);
    const [q3, u3] = qtyUnit((onRow(lb3)[0] || {}).s);
    const codeTok2 = r2.find((t) => /^\(\d+\)$/.test(t.s));

    out.push({
      序号: st.seq,
      商品编号: st.codeTok.s,
      商品名称: joinText(nameCol.filter((t) => t.y < splitY)),
      规格型号: joinText(nameCol.filter((t) => t.y >= splitY)),
      法定数量: q1, 法定单位: u1,
      第二数量: q2, 第二单位: q2 ? u2 : "",
      申报数量: q3, 申报单位: u3,
      目的国: countryTok ? countryTok.s : "",
      目的国代码: codeTok2 ? codeTok2.s.replace(/[()]/g, "") : "",
      单价: num(price),
      总价: num(total),
      币制: curTok ? curTok.s : "",
      征免: taxTok ? taxTok.s : "",
    });
  });
  return out;
}

/** 出口退税联（可多页；表头每页重复，商品按序号合并） */
function parseRefundCopy(P) {
  const header = parseGrid(P[0]);
  const bySeq = new Map();
  for (const T of P) for (const it of parseItems(T)) if (!bySeq.has(it.序号)) bySeq.set(it.序号, it);
  const items = [...bySeq.values()].sort((a, b) => a.序号 - b.序号);
  header.页数 = P.length;
  const decl = { header, items, totals: currencyTotals(items) };
  decl.issues = checkDeclaration(decl);
  return decl;
}

function currencyTotals(items) {
  const t = {};
  for (const it of items) t[it.币制] = round2((t[it.币制] || 0) + (it.总价 || 0));
  return t;
}

/** 只基于报关单内容本身的合理性检查 */
function checkDeclaration({ header: h, items, totals }) {
  const issues = [];
  for (const k of ["海关编号", "出口日期", "运抵国", "成交方式", "合同协议号", "贸易方式"])
    if (!h[k]) issues.push(`缺少字段：${k}`);
  if (!items.length) issues.push("未识别到商品明细");
  const gross = num(h.毛重), net = num(h.净重);
  if (gross != null && net != null && net > gross) issues.push(`净重 ${net} 大于毛重 ${gross}`);
  const curs = Object.keys(totals);
  if (curs.length > 1) issues.push(`包含多种币制：${curs.join("、")}`);
  for (const it of items) {
    if (it.单价 == null || it.总价 == null) {
      issues.push(`第${it.序号}项 单价或总价缺失`);
      continue;
    }
    // 单价最多 4 位小数，允许相应的四舍五入误差
    const qs = [it.申报数量, it.法定数量].filter((q) => q);
    if (qs.length && qs.every((q) => Math.abs(q * it.单价 - it.总价) > q * 0.00005 + 0.011))
      issues.push(`第${it.序号}项 数量×单价≠总价（${qs[0]}×${it.单价}≠${it.总价}），请核对原件`);
  }
  return issues;
}

// ======================= 表头（退税联、预填单、放行通知书） =======================
// 表格：标签在格子上方、值在正下方（Crystal 版放行通知书另见 parseCells）。各版式标签写法不同，字段名统一（出境关别→出口口岸，监管方式→贸易方式 等）

const GRID_LABELS = [
  ["出口口岸", /^(出境关别|出口关别|出口口岸)/], ["备案号", /^备案号/], ["出口日期", /^出口日期/], ["申报日期", /^申报日期/],
  ["境内收发货人", /^(境内收发货人|境内发货人|收发货人|经营单位)/], ["境外收货人", /^境外收货人/], ["运输方式", /^运输方式/],
  ["运输工具名称", /^运输工具名称/], ["提运单号", /^提运单号/], ["生产销售单位", /^(生产销售单位|发货单位)/], ["贸易方式", /^(监管方式|贸易方式)/],
  ["征免性质", /^征免性质/], ["许可证号", /^许可证号/], ["结汇方式", /^结汇方式/], ["批准文号", /^批准文号/],
  ["合同协议号", /^合同协议号/], ["贸易国", /^贸易国/], ["运抵国", /^运抵国/], ["指运港", /^指运港/], ["离境口岸", /^离境口岸/],
  ["境内货源地", /^境内货源地/], ["包装种类", /^包装种类/], ["件数", /^件数/], ["毛重", /^毛重/], ["净重", /^净重/],
  ["成交方式", /^成交方式/], ["运费", /^运费/], ["保费", /^保费/], ["杂费", /^杂费/], ["集装箱号", /^集装箱号$/],
  ["随附单据", /^随附单据$/], ["标记唛码及备注", /^标记唛码及备注$/],
  // 只作为边界：表头区域到此为止，或同一行的下一格（预填单的“随附单证及编号…”“标记唛码及备注:”标签与值连在一起，不取）
  ["", /^(随附单证|生产厂家|标记唛码|项号|序号|商品序号)/],
];
const GRID_TOL = 3;

/** 表头字段：值在标签下方、到下一行标签为止，左右到同一行的下一个标签为止（值可能比标签略靠左几点） */
function gridLabels(T) {
  const labels = [];
  for (const t of T) {
    const s = halfBrackets(squash(t.s));
    const hit = GRID_LABELS.find(([, re]) => re.test(s));
    if (hit && !labels.some((l) => l.name && l.name === hit[0])) labels.push({ name: hit[0], x: t.x, y: t.y, tok: t });
  }
  return labels;
}

/** 报关单号取条码下方印的“*222920240001234567*”（早期版式没有星号），退税联没有条码，取“海关编号：…”；日期统一为 2024-10-21 */
function finishHeader(T, header) {
  const all = T.map((t) => t.s).join("\n");
  // “标签：值”，值须符合格式（有的版式标签后紧跟的是别的文字）
  const inline = (k, v) => (new RegExp(`${k}\\s*[:：]\\s*(${v})`).exec(all) || [])[1] || "";
  const code = T.find((t) => /^\*?\d{18}\*?$/.test(t.s));
  header.海关编号 = code ? code.s.replace(/\*/g, "") :inline("海关编号", "\\d{18}");
  header.预录入编号 = inline("预录入编号", "[A-Z0-9]{18}");
  header.打印日期 = inline("打印日期", "\\d{4}-\\d{2}-\\d{2}");
  for (const key of ["出口日期", "申报日期"]) header[key] = normDate(header[key]);
  return header;
}

function parseGrid(T) {
  const labels = gridLabels(T);
  const rowYs = labels.map((l) => l.y).sort((a, b) => a - b);
  const header = {};
  for (const lb of labels.filter((l) => l.name)) {
    const nextRowY = rowYs.find((y) => y > lb.y + GRID_TOL) ?? Infinity;
    const nextX = Math.min(Infinity, ...labels.filter((o) => Math.abs(o.y - lb.y) <= GRID_TOL && o.x > lb.x + 1).map((o) => o.x));
    header[lb.name] = joinText(T.filter((t) => t.y > lb.y + GRID_TOL && t.y < nextRowY - GRID_TOL && t.x >= lb.x - 5 && t.x < nextX - 5));
  }
  return finishHeader(T, header);
}

/**
 * Crystal 版放行通知书：一行标签的高低相差几点，值有的在标签右侧、有的在下方，并夹着代码（“上海海关 2200”“日本 JPN”）。
 * 标签按高度连成行；值取标签所在行顶到下一行之间、标签左缘到同一行下一个标签之间的文字，去掉标签的括号碎片；有中文时去掉纯代码
 */
function parseCells(T) {
  const labels = gridLabels(T).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const l of labels) {
    const r = rows[rows.length - 1];
    if (r && l.y - r.bottom <= 7) { r.items.push(l); r.bottom = l.y; }
    else rows.push({ top: l.y, bottom: l.y, items: [l] });
  }
  const isLabel = new Set(labels.map((l) => l.tok));
  const header = {};
  rows.forEach((r, i) => {
    const nextTop = i + 1 < rows.length ? rows[i + 1].top : Infinity;
    for (const lb of r.items.filter((l) => l.name)) {
      const nextX = Math.min(Infinity, ...r.items.filter((o) => o.x > lb.x + 1).map((o) => o.x));
      let toks = T.filter((t) => !isLabel.has(t) && t.y >= r.top - 3 && t.y < nextTop - 3 && t.x >= lb.x - 5 && t.x < nextX - 5
        && !/^([()（）:：\/]|地区|公斤|千克)$/.test(t.s));
      if (toks.some((t) => /[\u4e00-\u9fa5]/.test(t.s))) toks = toks.filter((t) => !/^[A-Z0-9]+$/.test(t.s));
      header[lb.name] = joinText(toks);
    }
  });
  return finishHeader(T, header);
}

/** 预填单、放行通知书：只有表头，必须有关联用的三个字段 */
function gridDoc(header) {
  const issues = ["海关编号", "合同协议号", "提运单号"].filter((k) => !header[k]).map((k) => `缺少字段：${k}`);
  return { header, items: [], totals: {}, issues };
}

// ======================= 电子委托 =======================
// 代理报关委托书（电子）的固定模板：以报关单编码（18 位数字）所在行为基准，各栏相对它的高度固定；左栏 x < 300，右栏 x ≥ 300。
// 两种模板：一种首行是委托方 / 被委托方，数（重）量即毛重；另一种上方有勾选框（“√”）、行距更密，数（重）量即净重

const ENTRUST_STD = {
  left: [[-23, "委托方"], [0, "主要货物名称"], [23, "HS编码"], [46, "进出口日期"], [70, "提单号"], [96, "贸易方式"],
    [118, "数（重）量"], [141, "包装情况"], [179, "原产地/货源地"]],
  right: [[-23, "被委托方"], [0, "报关单编码"], [23, "收到单证日期"]],
  weight: "毛重",
};
const ENTRUST_TICK = {
  left: [[0, "主要货物名称"], [15, "HS编码"], [40, "提单号"], [55, "贸易方式"], [72, "数（重）量"], [90, "包装情况"], [107, "原产地/货源地"]],
  right: [[-13, "被委托方"], [0, "报关单编码"], [15, "收到单证日期"]],
  weight: "净重",
};

function parseEntrust(P, tpl) {
  const T = P[0];
  const base = T.find((t) => /^\d{18}$/.test(t.s)).y;
  const header = {};
  for (const [side, rows] of [[(t) => t.x < 300, tpl.left], [(t) => t.x >= 300, tpl.right]])
    for (const [dy, name] of rows) {
      const toks = T.filter((t) => side(t) && Math.abs(t.y - base - dy) <= 6).sort((a, b) => a.x - b.x);
      // 日期是“2026 7 11”三块
      header[name] = /日期$/.test(name) && toks.length === 3 ? normDate(toks.map((t, i) => (i ? t.s.padStart(2, "0") : t.s)).join("-")) : joinText(toks);
    }
  // 与报关单类单据核对用的统一字段名
  header.海关编号 = header.报关单编码;
  header.提运单号 = header.提单号;
  header[tpl.weight] = header["数（重）量"];
  const issues = ["报关单编码", "提单号"].filter((k) => !header[k]).map((k) => `缺少字段：${k}`);
  return { header, items: [], totals: {}, issues };
}

// ======================= 提单 =======================

const normNo = (s) => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

function parseBill(P) {
  // 关联用：去掉空格和符号的全文（MAWB 的“618 12345678”即报关单上的 61812345678）
  return { header: {}, items: [], totals: {}, issues: [], 全文: normNo(P.flatMap((T) => T.map((t) => t.s)).join(" ")) };
}

// ======================= 识别与关联 =======================

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/g;

/** 电子委托没有标题：文字少、有 18 位报关单号和 10 位 HS 编码、没有中文标签 */
const isEntrust = (text, T) => T.length < 60 && T.some((t) => /^\d{18}$/.test(t.s)) && T.some((t) => /^\d{10}$/.test(t.s)) && !/编号|日期|方式/.test(text);
const hasTok = (T, s) => T.some((t) => squash(t.s) === s);

/** 专家：按顺序匹配，第一个认领的负责解析。match(首页文字, 首页文本块)，parse(各页文本块) */
const EXPERTS = [
  { type: "出口退税联", name: "出口退税联（JG09）", match: (text) => /出口退税联/.test(text) && /出口货物报关单/.test(text), parse: parseRefundCopy },
  // Crystal 版：“出口查验 / 放行通知书”，标签为经营单位、发货单位、贸易方式，值在标签右侧或下方
  { type: "放行通知书", name: "放行通知书（Crystal）", match: (text, T) => /放行通知书/.test(text) && hasTok(T, "经营单位"), parse: (P) => gridDoc(parseCells(P[0])) },
  { type: "放行通知书", name: "放行通知书", match: (text) => /放行通知书/.test(text), parse: (P) => gridDoc(parseGrid(P[0])) },
  // 报关行的预填单：多数印“仅供核对用”，Crystal 版没有；有一种整页旋转 90°（坐标已换算），取值方式相同
  { type: "预填单", name: "预填单", match: (text) => /出口货物报关单/.test(text), parse: (P) => gridDoc(parseGrid(P[0])) },
  { type: "电子委托", name: "电子委托（勾选框）", match: (text, T) => isEntrust(text, T) && hasTok(T, "√"), parse: (P) => parseEntrust(P, ENTRUST_TICK) },
  { type: "电子委托", name: "电子委托", match: isEntrust, parse: (P) => parseEntrust(P, ENTRUST_STD) },
  // 有的提单栏目名是图片，只能靠“SHIPPED ON BOARD”、空运单的“N.V.D.”（未声明价值）等正文识别；船公司格式有 Shipper、Consignee 栏
  // 货运险保险单正文也提到 B/L，排除
  { type: "提单", name: "提单", match: (text) => !/INSURANCE POLICY|保险单/i.test(text) && (/B\/L|BILL OF LADING|AIR WAYBILL|SHIPPED ON BOARD|N\.V\.D\./i.test(text) || (/SHIPPER/i.test(text) && /CONSIGNEE/i.test(text))), parse: parseBill },
];
/** 同一报关单的单据合并时的优先顺序（前者优先）：退税联是海关放行后打印的，最权威 */
const TYPE_ORDER = ["出口退税联", "预填单", "放行通知书", "电子委托", "提单"];

/** 解析一个 PDF，返回一份单据 */
function parseCustomsPdf(pages) {
  const P = pages.map((p) => prepare(p.items));
  const text = P[0].map((t) => t.s).join("");
  const e = EXPERTS.find((x) => x.match(text, P[0]));
  if (!e) throw new Error("不是可识别的报关资料（出口退税联、预填单、放行通知书、电子委托、提单）");
  const doc = { 单据类型: e.type, 版式: e.name, ...e.parse(P) };
  doc.集装箱号 = [...new Set(P.flatMap((T) => T.map((t) => t.s)).join(" ").match(CONTAINER_RE) || [])];
  doc.自身提示 = doc.issues;
  return doc;
}

// 同一报关单号的各单据之间核对的字段（数值按数值比较）
const CROSS_FIELDS = ["合同协议号", "提运单号", "贸易方式", "成交方式", "运抵国", "件数", "毛重", "净重"];
// 数值去掉千分位（“17,000”）后比较
const numOf = (v) => num(String(v).replace(/,/g, ""));
const sameVal = (a, b) => (numOf(a) != null && numOf(b) != null ? Math.abs(numOf(a) - numOf(b)) < 0.001 : normNo(a) === normNo(b));
const isDecl = (d) => d.单据类型 !== "电子委托" && d.单据类型 !== "提单";
const baseName = (d) => d.原文件名.replace(/\.pdf$/i, "");

/**
 * 按报关单合并同批单据，返回 [{ key, data, members, files: [{ member, name }] }]，一份报关单一组：
 * - 报关单号相同的为一组（须含退税联、预填单或放行通知书，只有电子委托的不成组）
 * - 提单按提运单号（8 位以上）出现在提单全文中、其次集装箱号相同来匹配，可属于多组（各放一份）
 * - failed：识别不了的文件 [{ 原文件名, 错误, 无文字层 }]。其中的扫描件（无文字层），文件名按非字母数字切开后有一段与某份报关单的
 *   提运单号完全相同的，按提单并入（版式记为“按文件名推断”，不另提示），并入的单据其 来源 即该对象。有文字层的（保函、申请等）不推断
 * - 组内按 退税联 → 预填单 → 放行通知书 → 电子委托 的顺序合并字段（前者优先）、逐项核对
 * - 打包路径：合同号/申报日期/单据类型_报关单号.pdf（提单为 提单_提运单号.pdf）；不成组的放入 未匹配/，沿用原文件名
 * 会改写每份单据的 issues（自身提示 + 核对结果）
 */
function mergeDocs(docs, failed = []) {
  for (const d of docs) d.issues = [...d.自身提示];
  const byNo = new Map();
  for (const d of docs.filter((d) => d.单据类型 !== "提单" && d.header.海关编号)) {
    if (!byNo.has(d.header.海关编号)) byNo.set(d.header.海关编号, []);
    byNo.get(d.header.海关编号).push(d);
  }
  const rank = (d) => TYPE_ORDER.indexOf(d.单据类型);
  const groups = [...byNo.values()].filter((g) => g.some(isDecl)).map((g) => g.sort((a, b) => rank(a) - rank(b)));
  for (const b of docs.filter((d) => d.单据类型 === "提单")) {
    const hits = (test) => groups.filter((g) => g.some((d) => isDecl(d) && test(d)));
    const byBill = hits((d) => normNo(d.header.提运单号).length >= 8 && b.全文.includes(normNo(d.header.提运单号)));
    for (const g of byBill.length ? byBill : hits((d) => d.集装箱号.some((c) => b.集装箱号.includes(c)))) g.push(b);
  }
  for (const f of failed.filter((f) => f.无文字层)) {
    const parts = f.原文件名.replace(/\.pdf$/i, "").toUpperCase().split(/[^0-9A-Z]+/);
    const hits = groups.filter((g) => g.some((d) => isDecl(d) && d.header.提运单号 && parts.includes(normNo(d.header.提运单号))));
    const b = { 单据类型: "提单", 版式: "提单（按文件名推断）", 原文件名: f.原文件名, 来源: f, header: {}, items: [], totals: {}, 集装箱号: [],
      issues: [] };
    for (const g of hits) g.push(b);
  }
  const rows = groups.map(mergeGroup);
  const grouped = new Set(groups.flat());
  for (const d of docs.filter((d) => !grouped.has(d))) {
    d.issues.push("同批中没有对应的报关单，打包时放入“未匹配”");
    const files = [{ member: d, name: `未匹配/${X.safeName(`${d.单据类型}_${baseName(d)}`)}.pdf` }];
    rows.push({ key: `${d.单据类型}#${d.原文件名}`, members: [d], files, data: { ...d, 单据: fileList(files), 缺少: [], 归档位置: "未匹配/" } });
  }
  return rows;
}

/** 组内各单据：类型、版式、原文件名、打包后的位置 */
const fileList = (files) => files.map(({ member, name }) => ({ 单据类型: member.单据类型, 版式: member.版式, 原文件名: member.原文件名, 归档位置: name }));

function mergeGroup(g) {
  const docs = g.filter((d) => d.单据类型 !== "提单");
  docs.forEach((d, i) => {
    for (const k of CROSS_FIELDS) {
      const o = docs.slice(0, i).find((o) => o.header[k]);
      if (o && d.header[k] && !sameVal(d.header[k], o.header[k])) d.issues.push(`${k} ${d.header[k]} 与${o.单据类型} ${o.header[k]} 不一致`);
    }
  });
  const header = {};
  for (const d of docs) for (const [k, v] of Object.entries(d.header)) if (v && !header[k]) header[k] = v;
  const refund = g.find((d) => d.单据类型 === "出口退税联");
  const folder = [header.合同协议号 || "无合同号", header.申报日期.replace(/-/g, "")].map(X.safeName).join("/");
  const fileOf = (d) => `${folder}/${X.safeName(`${d.单据类型}_${d.单据类型 === "提单" ? header.提运单号 : header.海关编号}`)}.pdf`;
  const files = g.map((d) => ({ member: d, name: fileOf(d) }));
  return {
    key: `报关单#${header.海关编号}`, members: g, files,
    data: {
      单据类型: "报关单", header, items: refund ? refund.items : [], totals: refund ? refund.totals : {},
      单据: fileList(files), 缺少: TYPE_ORDER.filter((t) => !g.some((d) => d.单据类型 === t)), 归档位置: folder + "/",
      issues: g.flatMap((d) => d.issues.map((s) => `${d.单据类型}：${s}`)),
    },
  };
}

export { parseCustomsPdf, mergeDocs };
