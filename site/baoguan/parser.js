/*
 * 出口报关资料解析：一个 PDF 一份单据（几种单据合订的按页拆开，见 parseSplit）。一种版式一个专家（识别 + 解析），
 * 各类单据一节、专家就近定义，在 EXPERTS 里排定匹配顺序；结果记下 单据类型 和 版式
 *   出口退税联：报关单出口退税联（JG09 打印版），含商品明细
 *   预填单：报关行发来的报关单（多为“仅供核对用”），三种版式，其一整页旋转 90°（坐标已按页面旋转换算，见 common/pdf.js）
 *   放行通知书：通关无纸化出口（查验 /）放行通知书，三种版式
 *   报关委托书：代理报关委托书（电子），票面只有数值、标签是图片，按固定模板的位置取值，两种模板；
 *     另有纸质的委托报关协议（标签是文字，背面通用条款为第 2 页）
 *   提运单：海运提单、空运单、电放件、陆运运单等，格式各异，只用于关联：在全文里找同批报关单的提运单号，找不到再比对集装箱号
 *   数电发票：货代、报关行开的数电发票（由发票工具解析），只用于关联：备注里的提运单号或报关单号
 * 合并（mergeDocs）：同一报关单的单据合为一组（网页一行）。报关委托书、提运单没有合同号，按报关单号 / 提运单号 / 集装箱号
 *   并入同批的报关单类单据（退税联、预填单、放行通知书），合并字段并核对是否一致；归档路径“合同号/申报日期/单据类型_报关单号.pdf”，
 *   同一天同一合同的多份报关单在同一文件夹
 *
 * 输入：每页文本块 [{str, x, y, w}]（y 自上而下，见 common/pdf.js）
 * 输出：{ 单据类型, 版式, header, items, totals, 集装箱号, issues }
 */
import * as X from "../common/text.js";
import { parseInvoicePdf } from "../fapiao/parser.js";

const { prepare, round2, normDate, squash, compact } = X;

// ======================= 共用 =======================

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
/** 编号比对用：大写、只留字母数字（MAWB 的“618 12345678”即报关单上的 61812345678） */
const normNo = (s) => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/g;
const hasTok = (T, s) => T.some((t) => squash(t.s) === s);

/** 单据的基本结构；只用于关联、没有表头和明细的单据（提运单、数电发票、服务器上的记录等）只填 extra */
const blank = (extra) => ({ header: {}, items: [], totals: {}, issues: [], ...extra });

// ======================= 报关单类：出口退税联、预填单、放行通知书 =======================

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

/** 只基于报关单内容本身的合理性检查（缺少字段不提示，只提示值不对的） */
function checkDeclaration({ header: h, items, totals }) {
  const issues = [];
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
      issues.push(`第${it.序号}项 数量×单价≠总价（${qs[0]}×${it.单价}≠${it.总价}）`);
  }
  return issues;
}

// 表头：标签在格子上方、值在正下方（Crystal 版放行通知书另见 parseCells）。各版式标签写法不同，字段名统一（出境关别→出口口岸，监管方式→贸易方式 等）
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
    const s = compact(t.s);
    const hit = GRID_LABELS.find(([, re]) => re.test(s));
    if (hit && !labels.some((l) => l.name && l.name === hit[0])) labels.push({ name: hit[0], x: t.x, y: t.y, tok: t });
  }
  // 商品表（“项号”“商品序号”那一行）及以下不是表头：新版报关单的境内货源地是商品表的一列
  const table = Math.min(Infinity, ...labels.filter((l) => !l.name && /^(项号|商品序号)/.test(compact(l.tok.s))).map((l) => l.y));
  return labels.filter((l) => !l.name || l.y < table - GRID_TOL);
}

/** 报关单号取条码下方印的“*000020240001234567*”（早期版式没有星号），退税联没有条码，取“海关编号：…”；日期统一为 2024-10-21 */
function finishHeader(T, header) {
  const all = T.map((t) => t.s).join("\n");
  // “标签：值”，值须符合格式（有的版式标签后紧跟的是别的文字）
  const inline = (k, v) => (new RegExp(`${k}\\s*[:：]\\s*(${v})`).exec(all) || [])[1] || "";
  const code = T.find((t) => /^\*?\d{18}\*?$/.test(t.s));
  header.海关编号 = code ? code.s.replace(/\*/g, "") : inline("海关编号", "\\d{18}");
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
 * Crystal 版放行通知书：一行标签的高低相差几点，值有的在标签右侧、有的在下方，并夹着代码（“××海关 0000”“日本 JPN”）。
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
      if (toks.some((t) => /[一-龥]/.test(t.s))) toks = toks.filter((t) => !/^[A-Z0-9]+$/.test(t.s));
      header[lb.name] = joinText(toks);
    }
  });
  return finishHeader(T, header);
}

const REFUND = { type: "出口退税联", name: "出口退税联（JG09）", match: (text) => /出口退税联/.test(text) && /出口货物报关单/.test(text), parse: parseRefundCopy };
// 预填单、放行通知书只有表头
// Crystal 版：“出口查验 / 放行通知书”，标签为经营单位、发货单位、贸易方式，值在标签右侧或下方
const RELEASE_CRYSTAL = { type: "放行通知书", name: "放行通知书（Crystal）", match: (text, T) => /放行通知书/.test(text) && hasTok(T, "经营单位"),
  parse: (P) => blank({ header: parseCells(P[0]) }) };
const RELEASE = { type: "放行通知书", name: "放行通知书", match: (text) => /放行通知书/.test(text), parse: (P) => blank({ header: parseGrid(P[0]) }) };
// 报关行的预填单：多数印“仅供核对用”，Crystal 版没有；有一种整页旋转 90°（坐标已换算），取值方式相同
const PREFILL = { type: "预填单", name: "预填单", match: (text) => /出口货物报关单/.test(text), parse: (P) => blank({ header: parseGrid(P[0]) }) };

// ======================= 报关委托书：电子委托、纸质委托报关协议 =======================

/** 委托的字段另记一份报关单类单据的字段名，供合并时核对 */
const entrustDoc = (header) => blank({ header: Object.assign(header, { 海关编号: header.报关单编码, 提运单号: header.提单号 }) });

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
  header[tpl.weight] = header["数（重）量"];
  return entrustDoc(header);
}

// 纸质的委托报关协议（中国报关协会监制）：标签是文字，左栏委托方、右栏被委托方，值在标签右侧，可能折行（到下一个标签为止）；
// 有的文件标签和值挨得近，读出来是一块（“*报关单编号 No.0000…”），标签后面的部分也是值。
// 第 2 页为背面的通用条款，拆分合订文件时跟着第 1 页（见 parseSplit 的 CONTINUED）
const PAPER_ENTRUST = [["委托方", "委托方"], ["主要货物名称", "主要货物名称"], ["HS编码", "HS编码"], ["进/出口日期", "进出口日期"],
  ["提(运)单号", "提单号"], ["贸易方式", "贸易方式"], ["数(重)量", "数（重）量"], ["包装情况", "包装情况"], ["原产地/货源", "原产地/货源地"],
  ["地(地区)", null], ["其它要求", null], ["被委托方", "被委托方"], ["*报关单编号", "报关单编码"], ["收到单证日期", "收到单证日期"],
  ["收到单证情况", null]];

function parsePaperEntrust(P) {
  const T = P[0];
  // 以标签开头的块，每个标签取最上面的一块（页面底部的“委托方签章”“被委托方签章”也以标签开头）；inline 为块里标签之后的部分
  const labels = PAPER_ENTRUST.flatMap(([text, name]) => {
    const key = compact(text);
    const t = T.filter((t) => compact(t.s).startsWith(key)).sort((a, b) => a.y - b.y)[0];
    return t ? [{ t, name, inline: X.afterLabel(t.s, key.length) }] : [];
  });
  const isLabel = new Set(labels.map((l) => l.t));
  const left = (t) => t.x < 300;
  const header = {};
  for (const { t: lb, name, inline } of labels.filter((l) => l.name)) {
    // 同一栏、在标签右侧，从标签所在行到同栏下一个标签之前
    const next = Math.min(...labels.filter((l) => left(l.t) === left(lb) && l.t.y > lb.y + 4).map((l) => l.t.y), Infinity);
    const toks = T.filter((t) => !isLabel.has(t) && left(t) === left(lb) && t.x > lb.x + 20 && t.y >= lb.y - 4 && t.y < next - 4)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const v = inline + toks.map((t) => t.s).join("");
    header[name] = /日期$/.test(name) ? normDate(v) : v;
  }
  header.报关单编码 = (header.报关单编码 || "").replace(/^No\.?/i, "");
  return entrustDoc(header);
}

// 电子委托、陆运运单的栏目名都是图片：文字少、有 18 位报关单号、没有中文标签；电子委托一定有 10 位 HS 编码，陆运运单没有
const imageForm = (text, T) => T.length < 60 && T.some((t) => /^\d{18}$/.test(t.s)) && !/编号|日期|方式/.test(text);
const hasHs = (T) => T.some((t) => /^\d{10}$/.test(t.s));
const isEntrust = (text, T) => imageForm(text, T) && hasHs(T);

const ENTRUST_TICK_X = { type: "报关委托书", name: "电子委托（勾选框）", match: (text, T) => isEntrust(text, T) && hasTok(T, "√"), parse: (P) => parseEntrust(P, ENTRUST_TICK) };
const ENTRUST_STD_X = { type: "报关委托书", name: "电子委托", match: isEntrust, parse: (P) => parseEntrust(P, ENTRUST_STD) };
const ENTRUST_PAPER = { type: "报关委托书", name: "委托报关协议（纸质）", match: (text, T) => hasTok(T, "委托报关协议"), parse: parsePaperEntrust };

// ======================= 提运单 =======================
// 格式各异，不取字段，只留去掉空格和符号的全文用于关联（集装箱号由 parseCustomsPdf 统一提取）

const parseBill = (P) => blank({ 全文: normNo(P.flatMap((T) => T.map((t) => t.s)).join(" ")) });

const LAND_WAYBILL = { type: "提运单", name: "陆运运单", match: (text, T) => imageForm(text, T) && !hasHs(T) && !/名称/.test(text), parse: parseBill };
// 有的提单栏目名是图片，只能靠“SHIPPED ON BOARD”、空运单的“N.V.D.”（未声明价值）等正文识别；船公司格式有 Shipper、Consignee 栏
// 货运险保险单正文也提到 B/L，排除
const BILL = { type: "提运单", name: "提运单",
  match: (text) => !/INSURANCE POLICY|保险单/i.test(text) && (/B\/L|BILL OF LADING|AIR WAYBILL|SHIPPED ON BOARD|N\.V\.D\./i.test(text) || (/SHIPPER/i.test(text) && /CONSIGNEE/i.test(text))),
  parse: parseBill };

/** OCR 得到的提单文字（不分栏目）：同 parseBill 只用于关联；OCR 常把集装箱号的字母和数字断开（“ABCU 1234567”），先接上 */
function parseOcrBill(text) {
  const up = text.toUpperCase().replace(/\b([A-Z]{4})\s+(\d{7})\b/g, "$1$2");
  return blank({ 单据类型: "提运单", 版式: "提运单（OCR）", 自身提示: [], 全文: normNo(text), 集装箱号: [...new Set(up.match(CONTAINER_RE) || [])] });
}

// ======================= 数电发票 =======================
// 货代、报关行开的增值税发票（代理运费、港杂费等），由发票工具解析（fapiao/parser.js）；只用于关联：
// 备注里常写提单号或报关单号，按同提运单的规则关联（mentions），只看备注栏

/** 备注规整后的全文（同提运单的 全文）；“ABCD1901/02”是两票的简写，先展开为 ABCD1901 ABCD1902（后一个原文里没有完整出现） */
const remarkText = (text) =>
  normNo((text || "").toUpperCase().replace(/([A-Z0-9]+)\/(\d{1,4})(?![0-9])/g, (m, a, b) => `${a} ${a.slice(0, -b.length)}${b}`));

function parseInvoiceDoc(pages) {
  const [inv] = parseInvoicePdf(pages).invoices;
  return blank({ 发票号码: inv.发票号码, 开票日期: inv.开票日期, 销售方名称: inv.销售方名称, 价税合计: inv.价税合计,
    项目: inv.items.map((i) => i.项目名称).join("、"), 备注: inv.备注 || "", 全文: remarkText(inv.备注) });
}

// 只认标题为“电子发票(…)”的数电发票
const INVOICE = { type: "数电发票", name: "数电发票", match: (text) => /电子发票/.test(squash(text)) && /发票号码/.test(squash(text)), parse: (P, pages) => parseInvoiceDoc(pages) };

// ======================= 识别与拆分 =======================

/**
 * 专家按顺序匹配，第一个认领的负责解析：match(首页文字, 首页文本块)，parse(各页文本块, 原始页)。特征明确的在前：
 * - 发票最前：不会误认别的单据；而备注里常写提单号（有时是英文 B/L），排在后面会被提单专家认走
 * - 退税联、放行通知书在预填单前（预填单只认“出口货物报关单”字样，较宽）；Crystal 版放行通知书、勾选框的电子委托在各自的通用版前
 * - 提运单最宽松，放最后
 */
const EXPERTS = [INVOICE, REFUND, RELEASE_CRYSTAL, RELEASE, PREFILL, ENTRUST_TICK_X, ENTRUST_STD_X, ENTRUST_PAPER, LAND_WAYBILL, BILL];
/** 同一报关单的单据合并时的优先顺序（前者优先）：退税联是海关放行后打印的，最权威 */
const TYPE_ORDER = ["出口退税联", "预填单", "放行通知书", "报关委托书", "提运单", "数电发票"];

/** 解析一个 PDF，返回一份单据；识别不出时抛错 */
function parseCustomsPdf(pages) {
  const P = pages.map((p) => prepare(p.items));
  const text = P[0].map((t) => t.s).join("");
  const e = EXPERTS.find((x) => x.match(text, P[0]));
  if (!e) throw new Error("不是可识别的报关资料（报关委托书、预填单、放行通知书、提运单、出口退税联、数电发票）");
  const doc = { 单据类型: e.type, 版式: e.name, ...e.parse(P, pages) };
  doc.集装箱号 = [...new Set(P.flatMap((T) => T.map((t) => t.s)).join(" ").match(CONTAINER_RE) || [])];
  doc.自身提示 = doc.issues;
  return doc;
}

const CONTINUED = /委托报关协议通用条款/; // 这些页是前一份的续页（背面条款等），拆分时跟着前一份
const tryParse = (pages) => {
  try {
    return parseCustomsPdf(pages);
  } catch (e) {
    return { 错误: e.message };
  }
};

/**
 * 解析一个 PDF，合订的（如预填单、提单、放行通知书合成一个 PDF）按页拆开：逐页识别，相邻的类型和报关单号都相同的页为同一份
 * （多页提单、多页退税联），连续识别不出的页也合为一份。识别出两份以上才拆（提单 + 续页、只有一页被误认的保险单等不拆）。
 * 返回 [单据]：拆出的各份带 页（页号，从 0 起）、原文件名为「原名（第 n 页）」，识别不出的那份为 { 错误, 原文件名, 页 }；
 * 不拆时同 parseCustomsPdf（识别不出抛错）。只有一页的份直接用逐页识别的结果，不再解析
 */
function parseSplit(pages, name) {
  const whole = () => [{ ...parseCustomsPdf(pages), 原文件名: name }];
  if (pages.length < 2) return whole();
  const segs = [];
  pages.forEach((p, i) => {
    const d = CONTINUED.test(p.items.map((t) => t.str).join("")) ? null : tryParse([p]);
    const key = !d ? "续页" : d.错误 ? null : `${d.单据类型}#${d.header.海关编号 || d.发票号码 || ""}`;
    if (segs.length && (key === "续页" || segs.at(-1).key === key)) segs.at(-1).页.push(i);
    else segs.push({ key, 页: [i], d });
  });
  if (segs.filter((s) => s.key).length < 2) return whole();
  return segs.map(({ 页, d }) => ({ ...(页.length === 1 && d ? d : tryParse(页.map((i) => pages[i]))), 原文件名: X.partName(name, 页), 页 }));
}

// ======================= 合并 =======================

// 同一报关单号的各单据之间核对的字段
const CROSS_FIELDS = ["合同协议号", "提运单号", "贸易方式", "成交方式", "运抵国", "件数", "毛重", "净重"];
// 件数、毛重、净重按数值比较（去掉千分位“17,000”、单位“千克”）；其余按去掉空格和符号的文字比较
// （合同号“2024-001”“2024-099”不能取开头的数字比，空运单号“618 12345678”与“61812345678”是同一个）
const NUMERIC_FIELDS = new Set(["件数", "毛重", "净重"]);
const numOf = (v) => num(String(v).replace(/,/g, ""));
const sameVal = (k, a, b) =>
  NUMERIC_FIELDS.has(k) && numOf(a) != null && numOf(b) != null ? Math.abs(numOf(a) - numOf(b)) < 0.001 : normNo(a) === normNo(b);
/** 附属单据：提运单、数电发票，按编号挂到报关单下，不参与字段合并和核对 */
const isAttach = (d) => d.单据类型 === "提运单" || d.单据类型 === "数电发票";
const isDecl = (d) => d.单据类型 !== "报关委托书" && !isAttach(d);
/**
 * 关联提运单、数电发票的统一规则：规整后的全文（大写、只留字母数字；数电发票只取备注栏）中出现了这份报关单的海关编号，
 * 或提运单号（8 位以上，太短容易误中）。按包含判断，编号前后紧贴别的文字（如报关单号后接几位）也能对上
 */
const mentions = (text, d) => [d.header.海关编号, billNo(d)].some((no) => no && text.includes(no));
/** 关联用的提运单号：8 位以上才用（太短容易误中） */
const billNo = (d) => {
  const n = normNo(d.header.提运单号);
  return n.length >= 8 ? n : "";
};

/**
 * 按报关单合并同批单据，返回 [{ key, data, members, files: [{ member, name }] }]，一份报关单一组：
 * - 报关单号相同的为一组（须含退税联、预填单或放行通知书，只有报关委托书的不成组）
 * - 提运单按全文中出现了报关单的海关编号或提运单号（mentions），其次集装箱号相同来匹配，可属于多组（各放一份）
 * - failed：识别不了的文件 [{ 原文件名, 错误, 无文字层 }]。其中的扫描件（无文字层），文件名按非字母数字切开后有一段与某份报关单的
 *   提运单号完全相同的，按提单并入（版式记为“按文件名推断”，不另提示），并入的单据其 来源 即该对象。有文字层的（保函、申请等）不推断
 * - 组内按 退税联 → 预填单 → 放行通知书 → 报关委托书 的顺序合并字段（前者优先）、逐项核对
 * - 打包路径：合同号/申报日期/单据类型_报关单号.pdf（提运单为 提运单_提运单号.pdf，数电发票为 数电发票_发票号码.pdf）；不成组的单据单列一行，带提示（不打包）
 * - 数电发票：同提运单的规则（mentions），只看备注栏；并入该组，可属于多组；归档为 数电发票_发票号码.pdf
 * - 手动补充的单据（manualDoc，带 归属 = 组的 key）不经匹配，直接并入该组
 * - server：服务器上已提交的报关单（serverDecls 的记录），按 键（对上本地编号的为完整编号）与本地单据同样成组，排在最后、不参与核对、不打包；
 *   组里没有本地文件的，members 为空
 * 会改写每份单据的 issues（自身提示 + 核对结果）
 */
function mergeDocs(docs, failed = [], server = []) {
  for (const d of docs) d.issues = [...d.自身提示];
  const byNo = new Map();
  for (const d of [...docs.filter((d) => !d.归属 && !isAttach(d) && d.header.海关编号), ...server]) {
    if (!byNo.has(noOf(d))) byNo.set(noOf(d), []);
    byNo.get(noOf(d)).push(d);
  }
  const rank = (d) => (d.服务器 ? TYPE_ORDER.length : TYPE_ORDER.indexOf(d.单据类型));
  const groups = [...byNo.values()].filter((g) => g.some(isDecl)).map((g) => g.sort((a, b) => rank(a) - rank(b)));
  /** 报关单类单据满足 test 的组 */
  const groupsWhere = (test) => groups.filter((g) => g.some((d) => isDecl(d) && test(d)));
  const unassigned = (type) => docs.filter((d) => !d.归属 && d.单据类型 === type);
  for (const b of unassigned("提运单")) {
    const byBill = groupsWhere((d) => mentions(b.全文, d));
    for (const g of byBill.length ? byBill : groupsWhere((d) => d.集装箱号.some((c) => b.集装箱号.includes(c)))) g.push(b);
  }
  for (const v of unassigned("数电发票")) for (const g of groupsWhere((d) => mentions(v.全文, d))) g.push(v);
  // 服务器比对出的（serverDecls 的 附属）：本地提运单并入只在服务器上的报关单
  for (const g of groups) for (const srv of g.filter((d) => d.服务器)) for (const b of srv.附属 || []) if (!g.includes(b)) g.push(b);
  for (const f of failed.filter((f) => f.无文字层)) {
    const parts = f.原文件名.replace(/\.pdf$/i, "").toUpperCase().split(/[^0-9A-Z]+/);
    const b = blank({ 单据类型: "提运单", 版式: "提运单（按文件名推断）", 原文件名: f.原文件名, 来源: f, 集装箱号: [] });
    for (const g of groupsWhere((d) => d.header.提运单号 && parts.includes(normNo(d.header.提运单号)))) g.push(b);
  }
  const byKey = new Map(groups.map((g) => [groupKey(noOf(g[0])), g]));
  for (const d of docs.filter((d) => d.归属)) byKey.get(d.归属)?.push(d);
  const rows = groups.map(mergeGroup);
  const grouped = new Set(groups.flat());
  for (const d of docs.filter((d) => !grouped.has(d))) {
    d.issues.push("同批中没有对应的报关单");
    const files = [{ member: d, name: "" }]; // 不知道归到哪份报关单，没有打包位置，不打包、不提交
    rows.push({ key: `${d.单据类型}#${d.原文件名}`, members: [d], files, suspect: d.单据类型 === "提运单", data: { ...d, 单据: fileList(files), 缺少: [], 归档位置: "" } });
  }
  return rows;
}

const groupKey = (no) => `报关单#${no}`;
/** 成组用的编号：服务器上的记录用 键（对不上本地编号的，海关编号只有部分隐去的，不能用来成组） */
const noOf = (d) => d.键 || d.header.海关编号;
const NO_CONTRACT = "无合同号";
const BAD_CONTRACT = "合同号异常";
/** 合同协议号最长 32 位；更长、或含乱码常见的字符（替换符 �、私用区、控制字符）的是识别错了（非标准 PDF、取到了别的栏） */
const badContract = (s) => s.length > 32 || /[�-\u0000-\u001F]/.test(s);

/** 组内各单据：类型、版式、原文件名、打包后的位置 */
const fileList = (files) => files.map(({ member, name }) => ({ 单据类型: member.单据类型, 版式: member.版式, 原文件名: member.原文件名, 归档位置: name }));

function mergeGroup(g) {
  const docs = g.filter((d) => !isAttach(d));
  docs.forEach((d, i) => {
    if (d.服务器) return; // 服务器上的记录只有清单里的几项，不核对
    for (const k of CROSS_FIELDS) {
      const o = docs.slice(0, i).find((o) => o.header[k]);
      if (o && d.header[k] && !sameVal(k, d.header[k], o.header[k])) d.issues.push(`${k} ${d.header[k]} 与${o.单据类型} ${o.header[k]} 不一致`);
    }
  });
  const header = {};
  for (const d of docs) for (const [k, v] of Object.entries(d.header)) if (v && !header[k]) header[k] = v;
  // 没有合同号的（如样品、退运）照常导出、提交，合同号记为“无合同号”，列表、Excel、归档文件夹一致
  header.合同协议号 ||= NO_CONTRACT;
  // 识别异常的合同号不用来显示、分组和建归档文件夹（乱码会撑开表格、打乱排序），记为“合同号异常”，原文放进提示
  const rawContract = header.合同协议号;
  if (badContract(rawContract)) header.合同协议号 = BAD_CONTRACT;
  const refund = g.find((d) => d.单据类型 === "出口退税联");
  const srv = g.find((d) => d.服务器);
  const local = g.filter((d) => !d.服务器);
  const onlyServer = docs.every((d) => d.服务器); // 报关单类单据都只在服务器上：只有清单里的几项
  // 本地有识别出编号的单据才有完整海关编号；否则（只在服务器上，或只补传了手动文件）是部分隐去的，归档名用“前4-后4”
  const known = docs.some((d) => !d.服务器 && d.header.海关编号);
  const no = known ? header.海关编号 : (header.海关编号 || "").replace(/\*+/g, "-");
  const folder = [header.合同协议号, (header.申报日期 || "无申报日期").replace(/-/g, "")].map(X.safeName).join("/");
  const fileOf = (t) => `${folder}/${X.safeName(`${t}_${t === "提运单" ? header.提运单号 || "无提运单号" : no}`)}.pdf`;
  const nameOf = (d) => (d.发票号码 ? `${folder}/${X.safeName(`数电发票_${d.发票号码}`)}.pdf` : d.归属 ? manualName(fileOf(d.单据类型)) : fileOf(d.单据类型));
  const files = local.map((d) => ({ member: d, name: nameOf(d) }));
  return {
    key: groupKey(noOf(g[0])), members: local, files,
    data: {
      单据类型: "报关单", header, items: refund ? refund.items : [], totals: refund ? refund.totals : {},
      服务器: onlyServer,
      服务器校验: known ? undefined : srv?.校验, // 没有完整编号的：提交并入它的文件时，清单里直接记到这一组（serverMeta）
      已提交: srv ? srv.已提交 : {}, // 清单里有的单据类型 → 提交时间、提交者 IP
      集装箱号: [...new Set(docs.flatMap((d) => d.集装箱号))],
      单据: fileList(files), 缺少: TYPE_ORDER.filter((t) => !local.some((d) => d.单据类型 === t)), 归档位置: folder + "/",
      issues: [
        ...(header.合同协议号 === BAD_CONTRACT ? [`合同协议号识别异常：${rawContract.slice(0, 40)}${rawContract.length > 40 ? "…" : ""}`] : []),
        ...g.flatMap((d) => d.issues.map((s) => `${d.单据类型}：${s}`)),
      ],
    },
  };
}

// ======================= 服务器上已提交的 =======================
// 服务器只留非敏感的清单（scripts/serve.py 的 清单.jsonl）：每个文件一条，有合同号、申报日期、单据类型、部分隐去的报关单号，
// 页面看到的完整报关单号只有校验值（serverKeys 给出本地的编号，服务器换成校验值比对）；海关编号、提运单号、集装箱号原文存在服务器上，
// 只供比对提运单、数电发票（serverBill），查询时不发给页面

/** 报关单号遮去中间：前 4 位海关代码、后 4 位便于对照 */
const maskNo = (no) => (no && no.length > 8 ? no.slice(0, 4) + "*".repeat(no.length - 8) + no.slice(-4) : no || "");

/**
 * 提交时记入清单的内容：一个文件属于哪几份报关单（同一文件夹里共用的提运单等属于几份）。校验 由服务器换成校验值；
 * 只在服务器上的报关单（页面没有完整编号）直接给它的校验值（已校验）
 */
const serverMeta = (d, member) => ({
  字段: { 合同协议号: d.header.合同协议号, 申报日期: d.header.申报日期, 单据类型: member.单据类型 },
  组: [{
    ...(d.服务器校验 ? { 名称: d.header.海关编号, 已校验: d.服务器校验 } : { 名称: maskNo(d.header.海关编号), 校验: d.header.海关编号 }),
    提运单号: d.header.提运单号 || "", 集装箱号: d.集装箱号 || [],
  }],
});
/** 查询后拿去与清单比对的本地编号 */
const serverKeys = (d) => (d.header?.海关编号 ? [d.header.海关编号] : []);
/** 查询后交给服务器比对的本地提运单、数电发票（全文，数电发票为备注栏；集装箱号），同 mergeDocs 的 mentions */
const serverBill = (d) => (isAttach(d) && !d.归属 ? { 全文: d.全文 || "", 集装箱号: d.集装箱号 || [] } : null);

/**
 * 服务器清单 → 每份报关单一条记录（交给 mergeDocs 的 server）。keymap：校验值 → 本地单据的完整编号；
 * 对上的以完整编号成组（与本地单据合为一行），对不上的只有部分隐去的编号，以校验值成组。
 * billmap：本地提运单 → 服务器比对出的组 [{ 校验, 提运单号? }]，记为该组的 附属（mergeDocs 并入），按提运单号对上的带回号码供归档命名
 */
function serverDecls(entries, keymap = {}, billmap = new Map()) {
  const groups = new Map();
  for (const e of entries)
    for (const g of e.组 || []) {
      if (!groups.has(g.校验)) groups.set(g.校验, { 名称: g.名称, 合同协议号: e.合同协议号, 申报日期: e.申报日期, 已提交: {} });
      groups.get(g.校验).已提交[e.单据类型] = `${(e.提交时间 || "").replace("T", " ")} · ${e.提交IP || ""}`;
    }
  return [...groups].map(([h, g]) => {
    const hits = [...billmap].flatMap(([bill, gs]) => gs.filter((x) => x.校验 === h).map((x) => ({ bill, no: x.提运单号 })));
    return blank({
      单据类型: "已提交", 服务器: true, 键: keymap[h] || `#${h}`, 校验: h, 已提交: g.已提交, 集装箱号: [], 自身提示: [],
      附属: hits.map((x) => x.bill),
      header: { 合同协议号: g.合同协议号 || "", 申报日期: g.申报日期 || "", 海关编号: keymap[h] || g.名称, 提运单号: hits.find((x) => x.no)?.no || "" },
    });
  });
}

// ======================= 手动补充 =======================

/** 手动补充的单据：不识别，直接作为 key 那一组的 type 类单据（打包时按该组的规范名称，末尾加 _手动） */
const MANUAL = "_手动";
const manualName = (name) => name.replace(/\.pdf$/i, `${MANUAL}.pdf`);
const manualDoc = (key, type, fileName) => blank({ 单据类型: type, 版式: `${type}（手动补充）`, 原文件名: fileName, 归属: key, 集装箱号: [], 全文: "", 自身提示: [] });

export { manualDoc, parseSplit, parseOcrBill, mergeDocs, serverDecls, serverMeta, serverKeys, serverBill };
