/*
 * PDF 电子发票 / 财政电子票据解析器
 *
 * 结构：共用工具 → 专家（每种版式一个对象：识别、解析、专属校验、附件数据）→ 附件数据（内嵌 XML / XBRL）→ 调度与公共校验 → 二维码 → 白名单
 * 新增版式：写一个专家对象，加入 EXPERTS（按顺序匹配，VAT 兜底放最后）。
 *
 * 依据：税务总局公告 2024 年第 11 号（票面要素、20 位发票号码）、2024-11-28 特定业务问答（19 类）、
 *       GB 32100（信用代码）、GB 11643（身份证号）、税务发票二维码格式；大写金额解析改写自 erma0/fapiao-print（MIT）
 * 输入：每页文本块 [{str, x, y, w}]（y 自上而下，见 common/pdf.js）及 PDF 内嵌的 XML 附件；输出：发票数组（一个 PDF 可能含多张）
 */
import * as X from "../common/text.js";

const { squash, round2, sameRow, cx, groupLines, joinText, toNum, normDate, safeFileName } = X;
// 发票文本的括号统一为半角（见 common/text.js 的 halfBrackets），以下规则只匹配半角括号。
// 有的转换软件把文字拆成单字（发票号码、金额一个数字一块，“471.70”拆成“471.”“70”）：同一行首尾相接的块先拼回一块；
// 这类软件记的数字宽度偏大、前后块互相重叠，所以数字碎块重叠也拼（文字块重叠不拼，如“备注：”与紧贴的值）
function prepare(items) {
  const out = [];
  for (const t of X.prepare(items)) {
    const last = out[out.length - 1];
    const end = last && last.x + last.w;
    const digits = last && t.x > last.x && t.x < end && /^[\d.,*]+$/.test(t.s) && /[\d.,*]$/.test(last.s);
    if (last && Math.abs(t.y - last.y) <= 1 && (Math.abs(t.x - end) <= 1 || digits)) {
      last.s += t.s;
      last.w = t.x + t.w - last.x;
    } else out.push({ ...t });
  }
  return out.map((t) => ({ ...t, s: X.halfBrackets(t.s) }));
}

const ROW_TOL = 4;
const AMOUNT_RE = /^-?[¥￥]?-?[\d,]+\.\d{1,2}$/; // 红字发票的负号可能在 ¥ 前或后
const eq = (a, b, tol = 0.011) => a != null && b != null && Math.abs(a - b) <= tol;
const isChar = (t) => /^[\u4e00-\u9fa5]$/.test(t.s); // 单个汉字的文字块

// ======================= 共用工具 =======================

/**
 * 找标签右侧的值：先看标签本身是否带值（“发票号码:123”），否则在同一行右侧找最近的、符合格式的文本块；
 * 以冒号结尾的块是别的标签（或单独的冒号），不作为值。rowTol：值与标签的高度差容差。
 * 标签去掉空白后比较（有的票面字间有空格：“发 票 号码 ：”），labelRe 不必考虑空格；标签自带的值保留原样
 */
function valueOf(tokens, labelRe, valueRe, { xMin = -Infinity, xMax = Infinity, yMin = -Infinity, yMax = Infinity, joinRow = false, rowTol = ROW_TOL } = {}) {
  const labels = tokens.filter((t) => labelRe.test(squash(t.s)) && t.x >= xMin && t.x < xMax && t.y >= yMin && t.y <= yMax);
  for (const lb of labels) {
    const inline = X.afterLabel(lb.s, labelRe.exec(squash(lb.s))[0].length).replace(/^[:：]/, "").trim();
    if (inline && (!valueRe || valueRe.test(inline))) return inline;
    const right = tokens
      .filter((t) => t !== lb && !/[:：]$/.test(t.s) && sameRow(t, lb, rowTol) && t.x > lb.x && t.x < xMax && t.y >= yMin - ROW_TOL && t.y <= yMax + ROW_TOL)
      .sort((a, b) => a.x - b.x);
    if (joinRow) {
      const txt = right.map((t) => t.s).join("");
      if (txt) return txt;
    }
    const hit = right.find((t) => !valueRe || valueRe.test(t.s));
    if (hit) return hit.s;
  }
  return "";
}

/** GB 32100-2015 统一社会信用代码校验位 */
function checkCreditCode(code) {
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(code)) return false;
  const cs = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const w = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += cs.indexOf(code[i]) * w[i];
  return cs[(31 - (sum % 31)) % 31] === code[17];
}

/** GB 11643-1999 公民身份号码校验位 */
function checkIdCard(id) {
  const m = /^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[\dX]$/.exec(id);
  if (!m || +m[1] < 1900 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += +id[i] * w[i];
  return "10X98765432"[sum % 11] === id[17];
}

/** 红字（负数）发票的大写金额前缀：“负”“(负数)” */
const NEG_RE = /^(负数|负)/;

/** 大写金额 → 数字（改写自 fapiao-print parseChineseNumeral，MIT） */
function parseChineseAmount(str) {
  const raw = squash(str).replace(/[()（）]/g, "");
  const neg = NEG_RE.test(raw);
  const s = raw.replace(NEG_RE, "").replace(/[整正]$/, "");
  if (!s) return null;
  const D = { 零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
  const yi = s.search(/[圆元]/);
  const intPart = yi >= 0 ? s.slice(0, yi) : /[角分]/.test(s) ? "" : s;
  const decPart = yi >= 0 ? s.slice(yi + 1) : /[角分]/.test(s) ? s : "";
  let total = 0, section = 0, cur = 0, has = false;
  for (const ch of intPart) {
    if (ch in D) { cur = D[ch]; has = true; }
    else if ("拾佰仟".includes(ch)) {
      section += (has ? cur : 1) * { 拾: 10, 佰: 100, 仟: 1000 }[ch];
      cur = 0; has = false;
    } else if (ch === "万") { section = (section + cur) * 1e4; cur = 0; has = false; }
    else if (ch === "亿") { total += (section + cur) * 1e8; section = 0; cur = 0; has = false; }
    else return null; // 出现无法识别的字
  }
  let v = total + section + cur;
  const jiao = /([零壹贰叁肆伍陆柒捌玖])角/.exec(decPart);
  const fen = /([零壹贰叁肆伍陆柒捌玖])分/.exec(decPart);
  if (jiao) v += D[jiao[1]] * 0.1;
  if (fen) v += D[fen[1]] * 0.01;
  return round2(neg ? -v : v);
}

/** 购销方区域内按行提取：名称、税号、地址电话、开户行及账号 */
const PARTY_RE = [
  ["名称", /名\s*称\s*[:：]\s*(.+)$/],
  ["税号", /(?:统一社会信用代码\/纳税人识别号|纳税人识别号|统一社会信用代码)\s*[:：]\s*([0-9A-Z]{15,20})/],
  ["地址电话", /地\s*址\s*、?\s*电\s*话\s*[:：]\s*(.+)$/],
  ["开户行及账号", /开户行及账号\s*[:：]\s*(.+)$/],
];
function partyInfo(tokens, role) {
  const out = {};
  for (const { text } of groupLines(tokens))
    for (const [k, re] of PARTY_RE) {
      const m = re.exec(text);
      // 去掉汉字之间的空格（部分票面把名称逐字排开，字与字之间有空格），英文单词间的空格保留
      if (m && !out[role + k]) out[role + k] = m[1].trim().replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "");
    }
  return out;
}

/** 明细表头：把拆开的单字（“单”“位”）合并成列名，记录列左边界 x（按 x 升序） */
function headerColumns(T, header) {
  const row = T.filter((t) => sameRow(t, header, 3)).sort((a, b) => a.x - b.x);
  const merged = [];
  for (const t of row) {
    const last = merged[merged.length - 1];
    // 并入前一列：拆开的单字、落在前一块范围内或只有标点的块（如叠在“税率 征收率”上的“/”）
    const inside = last && (t.x < last.x + last.w - 1 || /^[\/、]$/.test(t.s));
    if (last && (inside || (t.x - (last.x + last.w) < 14 && last.s.length + t.s.length <= 6 && !/名称|型号|征收率/.test(last.s)))) {
      last.s += t.s;
      last.w = t.x + t.w - last.x;
    } else merged.push({ ...t });
  }
  const MAP = [
    [/名称/, "项目名称"], [/规格型号|型号/, "规格型号"], [/^单位$/, "单位"], [/^数量$/, "数量"],
    [/^单价/, "单价"], [/^金额/, "金额"], [/税率|征收率/, "税率"], [/^税额$/, "税额"],
    // 通行费：旧版表头为“类型”，数电为“车辆类型”
    [/^车牌号$/, "车牌号"], [/^(车辆)?类型$/, "车辆类型"], [/^通行日期起$/, "通行日期起"], [/^通行日期止$/, "通行日期止"],
  ];
  // 列按 MAP 统一命名；MAP 以外的列（如财政票据的“备注”）保留原表头名
  const cols = [];
  for (const m of merged) {
    const s = squash(m.s);
    const hit = MAP.find(([re]) => re.test(s));
    const name = hit ? hit[1] : s;
    if (name && !cols.some((c) => c.name === name)) cols.push({ name, x: m.x, cx: cx(m) });
  }
  return cols;
}

/**
 * 明细列归属：列区间按表头左边界划分；数字（右对齐，可能起于表头左侧）按右边缘判断，
 * 文字按中心判断（有的票面文字居中，如通行费的车牌号、车辆类型，起点在表头左侧）。
 * 不采用“每行从右数：税额、税率、金额”的顺序法——通行费的通行日期、财政票据的项目编码也是数字列。
 */
const NUMERIC_RE = /^-?[¥￥]?-?[\d,.]+%?$/;
const STARS_RE = /^\*+$/; // 免税 / 不征税的税额印作“***”，有的票只有一个“*”
function colOf(cols, t) {
  const stars = STARS_RE.test(t.s);
  const key = stars || NUMERIC_RE.test(t.s) ? t.x + t.w - 1 : cx(t);
  let col = cols[0];
  for (const c of cols) if (c.x - 2 <= key) col = c;
  // 税额栏的星号可能比表头窄、落在税率表头下方；项目名称里的“*”不受影响
  return stars && col.name === "税率" ? "税额" : col.name;
}

/** 表头居中的网格表（财政票据）：文字可能起于表头左侧，按离哪个表头中心最近归列 */
const nearestCol = (cols, t) => cols.reduce((a, c) => (Math.abs(c.cx - cx(t)) < Math.abs(a.cx - cx(t)) ? c : a)).name;

/** 明细行：以“金额”列中的数字为行锚点，其他文字（包括折行）归入其上方最近的锚点行 */
function parseItemRows(area, cols, col = colOf) {
  if (!cols.some((c) => c.name === "金额")) return [];
  const withCol = area.map((t) => ({ ...t, col: col(cols, t) }));
  const anchors = withCol.filter((t) => t.col === "金额" && AMOUNT_RE.test(t.s)).sort((a, b) => a.y - b.y);
  if (!anchors.length) return [];
  const rows = anchors.map((a) => ({ anchor: a, cells: {} }));
  for (const t of withCol) {
    if (t.y < anchors[0].y - ROW_TOL) continue;
    let r = rows[0];
    for (const row of rows) if (row.anchor.y <= t.y + ROW_TOL) r = row;
    (r.cells[t.col] = r.cells[t.col] || []).push(t);
  }
  const STD = ["项目名称", "规格型号", "单位", "数量", "单价", "金额", "税率", "税额"];
  return rows.map(({ cells }) => {
    const txt = (k) => (cells[k] ? joinText(cells[k]) : "");
    const taxTxt = txt("税额");
    const item = {
      项目名称: txt("项目名称"),
      规格型号: txt("规格型号"),
      单位: txt("单位"),
      数量: toNum(txt("数量")),
      单价: toNum(txt("单价")),
      金额: toNum(txt("金额")),
      税率: txt("税率"),
      税额: STARS_RE.test(taxTxt) ? 0 : toNum(taxTxt),
    };
    for (const c of cols) if (!STD.includes(c.name)) item[c.name] = txt(c.name);
    return item;
  });
}

/**
 * 附加信息区块。两种形式：
 *   - “标签：值”（一行可有多对）→ 返回一个对象
 *   - 表格：首行为表头，其余每行一条记录，按列中心对齐 → 返回多个对象
 */
function parseExtraTable(tokens) {
  const lines = groupLines(tokens);
  if (!lines.length) return [];
  if (lines.some((l) => /[:：]/.test(l.text))) {
    const kv = {};
    for (const l of lines) {
      const text = l.toks.map((t) => t.s).join(" ").replace(/_/g, " "); // 非税收入票据用“_”分隔：“申请号:…_缴费日期:…_”
      // 标签不以数字开头，避免把值里的时间（如 14:45）当成下一个标签；冒号后的空格非贪婪，标签没有值时不会把下一个标签当成值
      const re = /([^\s:：\d][^\s:：]{1,23})[:：]\s*?(.*?)(?=\s+[^\s:：\d][^\s:：]{1,23}[:：]|$)/g;
      let m;
      while ((m = re.exec(text))) if (m[2].trim()) kv[m[1]] = m[2].trim();
    }
    return Object.keys(kv).length ? [kv] : [];
  }
  if (lines.length === 1) return []; // 只有表头、没有内容
  const head = mergeByGap(lines[0].toks);
  return lines.slice(1).map((l) => {
    const row = {};
    for (const t of l.toks) {
      let best = head[0], d = Infinity;
      for (const h of head) {
        const dd = Math.abs(h.x + h.w / 2 - cx(t));
        if (dd < d) { d = dd; best = h; }
      }
      row[best.s] = (row[best.s] || "") + t.s;
    }
    return row;
  });
}
function mergeByGap(toks) {
  const out = [];
  for (const t of toks) {
    const last = out[out.length - 1];
    if (last && t.x - (last.x + last.w) < 8 && t.s.length === 1 && last.s.length <= 2) {
      last.s += t.s; last.w = t.x + t.w - last.x;
    } else out.push({ ...t });
  }
  return out;
}

/** 税务发票号码：数电票 20 位且前 2 位为开票年份；有发票代码的旧版票 8 位 */
function taxNoIssues(inv) {
  const no = inv.发票号码 || "";
  if (!no) return [];
  if (inv.发票代码) return /^\d{8}$/.test(no) ? [] : ["发票号码应为 8 位数字（有发票代码的旧版发票）"];
  if (!/^\d{20}$/.test(no)) return [`数电发票号码应为 20 位数字，实际为 ${no.length} 位`];
  if (inv.开票日期 && no.slice(0, 2) !== inv.开票日期.slice(2, 4)) return [`发票号码前 2 位（${no.slice(0, 2)}）与开票年份（${inv.开票日期.slice(0, 4)}）不符`];
  return [];
}

const sumOf = (items, k) => round2(items.reduce((s, i) => s + (i[k] || 0), 0));

/**
 * 明细勾稽：明细合计 = 合计；每行 金额 × 税率 ≈ 税额、数量 × 单价 ≈ 金额、数量 × 标准 = 金额（财政票据）
 * grossOk：单价也可能含税（旧版通用发票），数量 × 单价 ≈ 金额 + 税额 也算对
 */
function itemIssues(inv, { grossOk = false } = {}) {
  const its = inv.items;
  if (!its.length) return ["未识别到明细行"];
  const out = [];
  const sumA = sumOf(its, "金额");
  const sumT = sumOf(its, "税额");
  if (inv.合计金额 != null && !eq(sumA, inv.合计金额)) out.push(`明细金额合计 ${sumA} ≠ 合计金额 ${inv.合计金额}`);
  if (inv.合计税额 != null && !eq(sumT, inv.合计税额, 0.011 * its.length)) out.push(`明细税额合计 ${sumT} ≠ 合计税额 ${inv.合计税额}`);
  for (const s of inv.小计 || []) {
    if (s.金额 != null && !eq(s.明细金额, s.金额)) out.push(`第${s.页}页 明细金额合计 ${s.明细金额} ≠ 小计 ${s.金额}`);
    if (s.税额 != null && !eq(s.明细税额, s.税额, 0.011 * (s.行数 || 1))) out.push(`第${s.页}页 明细税额合计 ${s.明细税额} ≠ 小计税额 ${s.税额}`);
  }
  its.forEach((i, n) => {
    const std = toNum(i.标准 || "");
    if (std != null && i.数量 && i.金额 != null && Math.abs(i.数量 * std - i.金额) > 0.011)
      out.push(`第${n + 1}行 数量 ${i.数量} × 标准 ${std} ≠ 金额 ${i.金额}`);
    const r = /^(\d+(?:\.\d+)?)%$/.exec(i.税率 || "");
    if (r && i.金额 != null && i.税额 != null && !eq(round2(i.金额 * r[1] / 100), i.税额))
      out.push(`第${n + 1}行 金额 ${i.金额} × ${i.税率} ≠ 税额 ${i.税额}`);
    const off = (v) => Math.abs(i.数量 * i.单价 - v) > Math.abs(i.数量) * 0.00005 + 0.011;
    if (i.数量 && i.单价 && i.金额 != null && off(i.金额) && (!grossOk || off(i.金额 + (i.税额 || 0))))
      out.push(`第${n + 1}行 数量 ${i.数量} × 单价 ${i.单价} ≠ 金额 ${i.金额}`);
  });
  return out;
}

// ======================= 增值税发票共用 =======================
// 数电发票与旧版发票的票面下半部分版式相同：明细表、合计行、附加信息、价税合计、备注、开票人

// 票面底部签名栏；旧版发票逐字排开：“开 票 人:”“收 款 人:”“复 核:”
const KPR_RE = /^开票人[:：]?/;
const PAYEE_RE = /^收款人[:：]?/;
const REVIEWER_RE = /^复核人?[:：]?/;

/** 票种标题（公告 2024 年第 11 号的 6 类数电发票，以及旧版增值税发票、机动车 / 二手车发票） */
const TYPE_RE = /(电子发票\((?:增值税专用发票|普通发票|铁路电子客票|航空运输电子客票行程单|机动车销售统一发票|二手车销售统一发票)\)|增值税电子(?:普通|专用)发票|增值税(?:普通|专用)发票|电子普通发票|电子专用发票|机动车销售统一发票|二手车销售统一发票|航空运输电子客票行程单)/;

/** 特定业务：税务总局 2024-11-28 问答列出的 19 类；票面左上角显示业务字样，特定信息在合计行与价税合计行之间 */
const SPECIAL_BIZ = ["建筑服务", "成品油", "报废产品收购", "旅客运输服务", "货物运输服务", "不动产销售", "不动产经营租赁服务",
  "农产品收购", "光伏收购", "代收车船税", "自产农产品销售", "差额征税", "机动车", "二手车", "代开发票", "通行费", "医疗服务",
  "拖拉机和联合收割机", "稀土"];

const findHeader = (T) => T.find((t) => /^(项目名称|货物或应税劳务.*名称)$/.test(squash(t.s)));
/** 购买方 / 销售方的竖排标记：“购”“购买方”“购买方信息”或以“购买方”开头的文字块 */
const findMark = (T, c, rest) => T.find((t) => new RegExp(`^${c}(${rest})?(信息)?$`).test(squash(t.s)) || t.s.startsWith(c + rest));
/** 版面锚点：明细表头、购 / 销竖排标记，partyTop 为购买方区域上沿（找不到购买方标记时为 undefined，购买方区域为空） */
function vatAnchors(T) {
  const buyerMark = findMark(T, "购", "买方");
  return { header: findHeader(T), buyerMark, sellerMark: findMark(T, "销", "售方"), partyTop: buyerMark && buyerMark.y - 15 };
}

/** 发票号码、开票日期（可能拆成多个文字块，整行拼接）、购销方上方的特定业务标签 */
function vatHead(T, inv, partyTop) {
  inv.发票号码 = valueOf(T, /^发票号码[:：]?/, /^\d{8,20}$/);
  inv.开票日期 = normDate(valueOf(T, /^开票日期[:：]?/, null, { joinRow: true }));
  const bizTok = T.find((t) => t.y < partyTop && SPECIAL_BIZ.some((b) => squash(t.s).startsWith(b)));
  inv.特定业务 = bizTok ? bizTok.s : "";
}

/** 明细、合计行、附加信息（合计与价税合计之间）、价税合计（大写 / 小写）、备注、开票人 */
function vatBody(T, inv, header) {
  const heji = T.find((t) => header && t.y > header.y && t.x < 150 && /^合\s*计?$/.test(t.s));
  // 多页发票每页明细下方有“小计”行，其金额不能算作明细；“合计”“小计”二字可能分成两块
  const xiaoji = T.find((t) => header && t.y > header.y && t.x < 150 && /^小\s*计?$/.test(t.s));
  const jshj = T.find((t) => /^价税合计/.test(squash(t.s)));
  if (header) {
    const cols = headerColumns(T, header);
    // 合计行的数字可能比“合计”二字略低（同行容差内），不能算作明细
    const bottom = Math.min(...[xiaoji, heji, jshj].filter(Boolean).map((t) => t.y - ROW_TOL), Infinity);
    // 合计行的金额带“¥”且可能与“合计”二字有几个点的高度差，不能算作明细
    inv.items = parseItemRows(T.filter((t) => t.y > header.y + 3 && t.y < bottom && !/^-?[¥￥]/.test(t.s)), cols);
    if (heji) {
      const row = rowAmounts(T, heji, cols);
      inv.合计金额 = row.金额;
      inv.合计税额 = row.税额;
      if (inv.合计税额 == null && T.some((t) => sameRow(t, heji) && STARS_RE.test(t.s))) inv.合计税额 = 0;
      if (jshj) inv.附加信息 = parseExtraTable(T.filter((t) => t.y > heji.y + ROW_TOL && t.y < jshj.y - ROW_TOL));
    }
    // 本页小计与本页明细合计，由 itemIssues 核对（页码由 parseInvoicePdf 填写）
    if (xiaoji) {
      const { 金额, 税额 } = rowAmounts(T, xiaoji, cols);
      inv.小计 = [{ 金额, 税额, 明细金额: sumOf(inv.items, "金额"), 明细税额: sumOf(inv.items, "税额"), 行数: inv.items.length }];
    }
  }
  if (jshj) {
    const small = T.find((t) => sameRow(t, jshj) && /小写/.test(t.s));
    const row = T.filter((t) => sameRow(t, jshj) && t !== jshj).sort((a, b) => a.x - b.x);
    inv.价税合计大写 = row.filter((t) => t.x > jshj.x && (!small || t.x < small.x) && /[圆元角分整]|[壹贰叁肆伍陆柒捌玖零]|负/.test(t.s)).map((t) => t.s).join("");
    const nums = row.filter((t) => (!small || t.x > small.x) && /\d/.test(t.s));
    if (nums.length) inv.价税合计 = toNum(nums.map((t) => t.s).join(""));
    if (small && inv.价税合计 == null) inv.价税合计 = toNum(small.s.replace(/.*小写\)?/, ""));
  }
  const kpr = T.find((t) => KPR_RE.test(squash(t.s)));
  const bei = T.find((t) => /^备(注)?$/.test(squash(t.s)));
  if (bei) {
    const top = jshj ? jshj.y + ROW_TOL : bei.y - 20;
    const bottom = kpr ? kpr.y - ROW_TOL : bei.y + 40;
    inv.备注 = joinText(T.filter((t) => t.y > top && t.y < bottom && t.x > bei.x + 8), { sep: " " });
  }
  inv.开票人 = valueOf(T, KPR_RE, null);
}

/** 合计 / 小计行的金额、税额（带“¥”的数字可能与标签有几个点的高度差） */
function rowAmounts(T, lb, cols) {
  const out = {};
  for (const t of T.filter((t) => Math.abs(t.y - lb.y) <= 8 && t.x > lb.x + 5 && /\d/.test(t.s) && (/^-?[¥￥]/.test(t.s) || sameRow(t, lb)))) {
    const c = colOf(cols, t);
    if (c === "金额") out.金额 = toNum(t.s);
    else if (c === "税额") out.税额 = toNum(t.s);
  }
  return out;
}

// ======================= 专家：增值税发票（数电） =======================
// 数电专票 / 普票、19 类特定业务。购买方、销售方左右并列，以竖排“销”字的 x 为界

const VAT = {
  name: "增值税发票",
  match: ({ type, text }) => !!type || /发票号码/.test(text),
  required: ["销售方名称"],
  parse({ T, type }) {
    const inv = { 发票类型: type || "电子发票", items: [], 附加信息: [] };
    // 购买方 / 销售方：先圈区域，再按行正则提取（参考 sanluan/einvoice 的锚点区域做法）
    // 购 / 销标记或明细表头找不到时不猜位置，购销方留空，由「缺少字段」提示
    const { header, buyerMark, sellerMark, partyTop } = vatAnchors(T);
    if (buyerMark && sellerMark && header) {
      const inBand = (t) => t.y > partyTop && t.y < header.y - 2;
      const buyerArea = T.filter((t) => inBand(t) && t.x > buyerMark.x + 5 && t.x < sellerMark.x - 2);
      const sellerArea = T.filter((t) => inBand(t) && t.x > sellerMark.x + 5);
      Object.assign(inv, partyInfo(buyerArea, "购买方"), partyInfo(sellerArea, "销售方"));
    }
    vatHead(T, inv, partyTop);
    vatBody(T, inv, header);
    return inv;
  },
  check: (inv) => [...taxNoIssues(inv), ...itemIssues(inv)],
};

// ======================= 专家：旧版发票 =======================
// 有发票代码的旧版票：旧版增值税电子普通 / 专用发票、各省「××通用（电子）发票」。
// 随数电发票推行逐步淘汰，届时删除本段并从 EXPERTS 去掉即可。
// 版式：购买方在上（右侧是竖排栏目：增值税发票“密码区”、通用发票“经办人”），销售方在明细下方（备注左侧），明细以下同数电发票。
// 通用发票另有：表头“数量 / 单价”、税率写成小数（0.01）、单价含税。

const GENERAL_TITLE_RE = /[\u4e00-\u9fa5]{2,3}通用\(电子\)发票/;

const LEGACY = {
  name: "旧版发票",
  match: ({ T }) => T.some((t) => /^发票代码/.test(t.s)),
  required: ["销售方名称"],
  parse({ T, text, type }) {
    const inv = { 发票类型: type || (GENERAL_TITLE_RE.exec(text) || [])[0] || "旧版发票", items: [], 附加信息: [] };
    inv.发票代码 = valueOf(T, /^发票代码[:：]?/, /^\d{10,12}$/);
    inv.校验码 = valueOf(T, /^校验码[:：]?/, null, { joinRow: true }).replace(/\s/g, "");
    inv.机器编号 = valueOf(T, /^机器编号[:：]?/, /^\d+$/);
    const { header, buyerMark, sellerMark, partyTop } = vatAnchors(T);
    const bx = buyerMark ? buyerMark.x : 0;
    const headY = header ? header.y : Infinity;
    // 购买方右侧竖排栏目的标题：单个汉字，正下方紧接着另一个单字（“密 / 码 / 区”“经 / 办 / 人”）
    const side = T.find((t) => isChar(t) && t.y > partyTop && t.y < headY && t.x > bx + 50 &&
      T.some((u) => isChar(u) && Math.abs(u.x - t.x) < 3 && u.y > t.y && u.y - t.y < 25));
    const note = T.find((t) => /^备(注)?$/.test(t.s) && t.y > headY);
    const foot = T.find((t) => PAYEE_RE.test(squash(t.s)));
    const buyerArea = T.filter((t) => t.y > partyTop && t.y < headY - 2 && t.x > bx + 5 && (!side || t.x < side.x - 2));
    const sellerArea = !sellerMark ? [] : T.filter((t) => t.y > sellerMark.y - 15 && (!foot || t.y < foot.y - 2) &&
      t.x > sellerMark.x + 5 && (!note || t.x < note.x - 2));
    Object.assign(inv, partyInfo(buyerArea, "购买方"), partyInfo(sellerArea, "销售方"));
    vatHead(T, inv, partyTop);
    vatBody(T, inv, header);
    inv.收款人 = valueOf(T, PAYEE_RE, null);
    inv.复核人 = valueOf(T, REVIEWER_RE, null);
    for (const i of inv.items) {
      if ("数量/" in i) { i.数量 = toNum(i["数量/"]); delete i["数量/"]; } // 通用发票表头“数量 / 单价”
      if (/^0?\.\d+$/.test(i.税率)) i.税率 = `${+(i.税率 * 100).toFixed(2)}%`; // 通用发票税率为小数
    }
    return inv;
  },
  check: (inv) => [...taxNoIssues(inv), ...itemIssues(inv, { grossOk: true })],
};

// ======================= 专家：铁路客票 =======================
// 部分票面文字拆得很碎（“发票号码” “:2533…”、“2025” “年” “11” …），一律整行拼接后正则提取；车次、站名按坐标取

const railItem = (inv, trip) => ({
  项目名称: `${trip.费用类型 && trip.费用类型 !== "票价" ? `铁路${trip.费用类型}` : "铁路旅客运输"} ${trip.车次 || ""} ${trip.出发站 || ""}→${trip.到达站 || ""}`.trim(),
  规格型号: trip.席别 || "", 单位: "张", 数量: 1, 单价: inv.价税合计, 金额: inv.价税合计, 税率: "", 税额: null,
});

const station = (s) => (s && !s.endsWith("站") ? s + "站" : s || ""); // XBRL 站名不带“站”，票面带

const RAILWAY = {
  name: "铁路客票",
  match: ({ type }) => /铁路电子客票/.test(type || ""),
  // PDF 内嵌财政部 XBRL（rai），含票面没有的不含税金额、税率、税额（退票费为 6%，票价为 9%）；个人证件号不取
  xml: {
    match: (f) => "ElectronicInvoiceRailwayETicketNumber" in f,
    map: (f) => ({
      发票类型: X.halfBrackets(f.TypeOfVoucher || ""),
      发票号码: f.ElectronicInvoiceRailwayETicketNumber,
      开票日期: f.DateOfIssue,
      价税合计: xmlNum(f.Fare),
      合计金额: xmlNum(f.TotalAmountExcludingTax),
      合计税额: xmlNum(f.TaxAmount),
      购买方名称: f.NameOfPurchaser,
      购买方税号: f.UnifiedSocialCreditCodeOfPurchaser,
      附加信息: {
        车次: f.TrainNumber, 出发站: station(f.DepartureStation), 到达站: station(f.DestinationStation), 乘车日期: f.TravelDate,
        发车时间: f.DepartureTime, 车厢座位: (f.Carriage || "") + (f.Seat || ""), 席别: f.SeatLevel,
      },
    }),
    finish(inv, f) {
      const item = railItem(inv, inv.附加信息[0] || {});
      if (inv.合计金额 != null) Object.assign(item, { 单价: inv.合计金额, 金额: inv.合计金额, 税率: xmlRate(f.TaxRate), 税额: inv.合计税额 });
      inv.items = [item];
    },
  },
  parse({ T, type }) {
    const inv = { 发票类型: type, items: [], 附加信息: [] };
    const lines = groupLines(T).map((l) => l.text);
    const find = (re) => lines.map((l) => re.exec(l)).find(Boolean) || [];
    inv.发票号码 = find(/发票号码[:：]?(\d{8,20})/)[1] || "";
    inv.开票日期 = normDate(find(/开票日期[:：]?(\d{4}年\d{1,2}月\d{1,2}日)/)[1]);
    inv.购买方名称 = (find(/购买方名称[:：]?(.+?)(?:统一社会信用代码|$)/)[1] || "").trim();
    inv.购买方税号 = find(/统一社会信用代码[:：]?([0-9A-Z]{15,20})/)[1] || "";
    const trip = {};
    const train = T.find((t) => /^[GDCZTKYLS]?\d{1,5}$/.test(t.s) && t.y < 140 && t.x > 150 && t.x < 400);
    if (train) {
      const row = T.filter((t) => sameRow(t, train) && t !== train).sort((a, b) => a.x - b.x);
      trip.车次 = train.s;
      trip.出发站 = row.filter((t) => t.x < train.x).map((t) => t.s).join("");
      trip.到达站 = row.filter((t) => t.x > train.x).map((t) => t.s).join("");
    }
    const dep = find(/(\d{4}年\d{1,2}月\d{1,2}日)(\d{1,2}:\d{2})开(\d+车\w+?号|无座)?(.*)$/);
    if (dep[0]) Object.assign(trip, { 乘车日期: normDate(dep[1]), 发车时间: dep[2] }, dep[3] ? { 车厢座位: dep[3] } : {}, { 席别: dep[4].trim() });
    const who = find(/(\d{6,}\*+\d*[\dX]?)(.*)$/);
    if (who[0]) Object.assign(trip, { 证件号: who[1], 乘车人: who[2].trim() });
    const ticket = find(/电子客票号[:：]?(\d+)(.*)$/);
    if (ticket[0]) Object.assign(trip, { 电子客票号: ticket[1] }, ticket[2].trim() ? { 说明: ticket[2].trim() } : {});
    // 金额可能是票价、退票费或改签费
    const fee = find(/(票价|退票费|改签费)[:：]?[¥￥]?(-?[\d.]+)/);
    if (fee[0]) {
      trip.费用类型 = fee[1];
      inv.价税合计 = toNum(fee[2]);
    }
    inv.附加信息 = [trip];
    inv.items = [railItem(inv, trip)];
    return inv;
  },
  check: taxNoIssues,
};

// ======================= 专家：航空客票 =======================
// 电子发票（航空运输电子客票行程单）。PDF 内嵌财政部 XBRL（atr），以它为准：票面没有销售方（承运的航空公司），金额拆分只在附件里可靠。
// 票面只取核对用的字段：号码、填开日期、购买方、合计（金额行最右的数值）、旅客、电子客票号码、填开单位（订票的代理）。
// 票面金额区是一行不带冒号的表头、数值在正下方，两种版式的列对不齐（有的把“增值税税率 增值税税额”排成一块），所以不拆分。
// 金额：合计 = 票价 + 燃油附加费 + 增值税税额 + 民航发展基金 + 其他税费，税额 = (票价 + 燃油附加费) × 税率；
// 明细按此拆成“航空旅客运输（票价 + 燃油附加费，计税）”“民航发展基金”“其他税费”（为 0 时不列），合计金额 = 合计 − 税额

/** 由 XBRL 生成明细；多航段的航班和起止站用“；”连接 */
function airItems(f) {
  const n = (k) => xmlNum(f[k]) || 0;
  const trips = [].concat(f.DetailInformationOfAirTicketTuple || []).map((s) =>
    `${s.Flight} ${s.DepartureStation.replace(/\s/g, "")}→${s.DestinationStation.replace(/\s/g, "")}`);
  const fare = round2(n("Fare") + n("FuelSurcharge"));
  const items = [{ 项目名称: `航空旅客运输 ${trips.join("；")}`, 规格型号: "", 单位: "张", 数量: 1, 单价: fare, 金额: fare, 税率: xmlRate(f.VatRate), 税额: xmlNum(f.VatTaxAmount) }];
  for (const [name, k] of [["民航发展基金", "CivilAviationDevelopmentFund"], ["其他税费", "OtherTaxes"]])
    if (n(k)) items.push({ 项目名称: name, 规格型号: "", 单位: "", 数量: null, 单价: null, 金额: n(k), 税率: "", 税额: null });
  return items;
}

const AIR = {
  name: "航空客票",
  match: ({ type }) => /航空运输电子客票行程单/.test(type || ""),
  xml: {
    match: (f) => "ElectronicInvoiceAirTransportReceiptNumber" in f,
    map: (f) => ({
      发票号码: f.ElectronicInvoiceAirTransportReceiptNumber,
      开票日期: f.IssueDate,
      价税合计: xmlNum(f.TotalAmount),
      合计金额: xmlNum(f.TotalAmount) != null && xmlNum(f.VatTaxAmount) != null ? round2(f.TotalAmount - f.VatTaxAmount) : null,
      合计税额: xmlNum(f.VatTaxAmount),
      购买方名称: f.NameOfPurchaser,
      购买方税号: f.UnifiedSocialCreditCodeOfPurchaser,
      销售方名称: f.NameOfSeller,
      附加信息: { 旅客: f.PassengerName, 电子客票号码: f.ETicketNumber, 填开单位: f.IssueParty },
    }),
    finish(inv, f) {
      inv.items = airItems(f);
    },
  },
  parse({ T, type }) {
    const inv = { 发票类型: type, items: [], 附加信息: [] };
    inv.发票号码 = valueOf(T, /^发票号码[:：]?/, /^\d{20}$/);
    inv.开票日期 = normDate(valueOf(T, /^填开日期[:：]?/, /\d{4}\s*年/));
    inv.购买方名称 = valueOf(T, /^购买方名称[:：]?/, null);
    inv.购买方税号 = valueOf(T, /^统一社会信用代码\/纳税人识别号[:：]?/, /^[0-9A-Z]{15,20}$/);
    const total = T.find((t) => t.s === "合计" && T.some((u) => u.s === "票价" && sameRow(u, t)));
    const nums = total ? T.filter((t) => t.y > total.y + ROW_TOL && t.y < total.y + 20 && /\d/.test(t.s)).sort((a, b) => a.x - b.x) : [];
    if (nums.length) inv.价税合计 = toNum(nums[nums.length - 1].s);
    const name = T.find((t) => t.s === "旅客姓名");
    const passenger = name && T.find((t) => t.y > name.y + ROW_TOL && t.y < name.y + 20 && Math.abs(t.x - name.x) < 10);
    inv.附加信息 = [{
      旅客: passenger ? passenger.s : "",
      电子客票号码: valueOf(T, /^电子客票号码[:：]?/, /^\d+$/),
      填开单位: valueOf(T, /^填开单位[:：]?/, null),
    }];
    return inv;
  },
  check: (inv) => [...taxNoIssues(inv), ...itemIssues(inv)],
};

// ======================= 专家：机动车销售统一发票 =======================
// 电子发票（机动车销售统一发票）。格子式票面：标签不带冒号，值在标签右侧、到同一行下一个标签为止。
// 标签常逐字排开（“车 辆 类 型”是 4 个文字块，“地”“址”相隔很远），先把同一行相邻的单字拼起来；
// 有的标签占两行（“统一社会信用代码/纳税”+“人识别号/身份证号码”、“增值税税率”+“或征收率”），值在两行之间，
// 所以标签的上下范围包括正下方的续行。价税合计、不含税价的金额在同一行“小写”标签之后。
// 购买方为个人时税号是票面上印的身份证号码，照票面取。

const VEHICLE_LABELS = {
  购买方名称: /^购买方名称$/, 购买方税号: /^统一社会信用代码\/纳税/, 车辆类型: /^车辆类型$/, 厂牌型号: /^厂牌型号$/, 产地: /^产地$/,
  合格证号: /^合格证号$/, 进口证明书号: /^进口证明书号$/, 商检单号: /^商检单号$/, 发动机号码: /^发动机号码$/,
  车辆识别代号: /^车辆识别代号\/车架号码$/, 价税合计: /^价税合计$/, 小写: /^小写$/, 销售方名称: /^销货单位名称$/, 电话: /^电话$/,
  销售方税号: /^纳税人识别号$/, 账号: /^账号$/, 地址: /^地址$/, 开户银行: /^开户银行$/, 税率: /^增值税税率$/, 税额: /^增值税$/,
  主管税务机关: /^主管税务$/, 不含税价: /^不含税价$/, 完税凭证号码: /^完税凭证号码$/, 吨位: /^吨位$/, 限乘人数: /^限乘人数$/,
  开票人: /^开票人$/, 备注: /^备注[:：]?$/,
};
const VEHICLE_CONT = /^(人识别号\/身份证号码|或征收率|税额|机关及代码)$/; // 两行标签的第二行
const VEHICLE_EXTRA = ["车辆识别代号", "发动机号码", "合格证号", "产地", "进口证明书号", "商检单号", "完税凭证号码", "吨位", "限乘人数", "主管税务机关", "备注"];

/** 同一行相邻的单字拼成一块（只拼由单字组成的块，避免把“无”之类的单字值拼进前面的标签） */
function mergeChars(T) {
  const out = [];
  for (const l of groupLines(T))
    for (const t of l.toks) {
      const last = out[out.length - 1];
      if (last && last.chars && isChar(t) && l.toks.includes(last.tok) && t.x - (last.x + last.w) < 40) {
        last.s += t.s;
        last.w = t.x + t.w - last.x;
      } else out.push({ ...t, chars: isChar(t), tok: t });
    }
  return out;
}

const VEHICLE = {
  name: "机动车",
  match: ({ type }) => /机动车销售统一发票/.test(type || ""),
  required: ["销售方名称"],
  parse({ T, type }) {
    const inv = { 发票类型: type, items: [], 附加信息: [] };
    inv.发票号码 = valueOf(T, /^发票号码[:：]?/, /^\d{20}$/);
    inv.开票日期 = normDate(valueOf(T, /^开票日期[:：]?/, /\d{4}\s*年/));
    const M = mergeChars(T);
    const labels = [];
    for (const t of M) {
      const name = Object.keys(VEHICLE_LABELS).find((k) => VEHICLE_LABELS[k].test(squash(t.s)));
      if (name) labels.push({ ...t, name, top: t.y, bottom: t.y });
      else if (VEHICLE_CONT.test(squash(t.s))) labels.push({ ...t, cont: true, top: t.y, bottom: t.y });
    }
    for (const lb of labels.filter((l) => !l.cont)) {
      const below = labels.find((c) => c.cont && Math.abs(c.x - lb.x) < 20 && c.y > lb.y && c.y - lb.y < 20);
      if (below) lb.bottom = below.y;
    }
    // 值：标签上下范围内、标签右侧到同一行下一个标签之间的文字
    const value = (lb) => {
      const inBand = (t) => t.y >= lb.top - 8 && t.y <= lb.bottom + 8;
      const next = Math.min(Infinity, ...labels.filter((l) => l !== lb && inBand(l) && l.x > lb.x).map((l) => l.x));
      return joinText(M.filter((t) => !labels.some((l) => l.tok === t.tok) && inBand(t) && t.x >= lb.x + lb.w - 4 && t.x < next));
    };
    const v = {};
    for (const lb of labels) if (lb.name && lb.name !== "小写" && !(lb.name in v)) v[lb.name] = value(lb);
    // 同一行“小写”标签后的金额
    const small = (name) => {
      const lb = labels.find((l) => l.name === name);
      const s = lb && labels.find((l) => l.name === "小写" && sameRow(l, lb) && l.x > lb.x);
      return s ? toNum(value(s)) : null;
    };
    Object.assign(inv, {
      购买方名称: v.购买方名称, 购买方税号: v.购买方税号, 销售方名称: v.销售方名称, 销售方税号: v.销售方税号,
      销售方地址电话: [v.地址, v.电话].filter(Boolean).join(" "), 销售方开户行及账号: [v.开户银行, v.账号].filter(Boolean).join(" "),
      价税合计: small("价税合计"), 价税合计大写: v.价税合计, 合计金额: small("不含税价"), 合计税额: toNum(v.税额 || ""), 开票人: v.开票人,
    });
    inv.items = [{ 项目名称: v.车辆类型 || "", 规格型号: v.厂牌型号 || "", 单位: "辆", 数量: 1, 单价: inv.合计金额, 金额: inv.合计金额, 税率: v.税率, 税额: inv.合计税额 }];
    const extra = Object.fromEntries(VEHICLE_EXTRA.filter((k) => v[k]).map((k) => [k, v[k]]));
    inv.附加信息 = Object.keys(extra).length ? [extra] : [];
    return inv;
  },
  check: (inv) => [...taxNoIssues(inv), ...itemIssues(inv)],
};

// ======================= 专家：标签式票据 =======================
// 二手车销售统一发票：“标签 + 值”的格子，值在标签右侧或正下方。
// 核心字段按常见标签名映射，其余标签放入附加信息。无真实样本，字段名来自公开的票面说明。

const LABELED_CORE = [
  ["购买方名称", /^(购买方名称|购买方|买方单位\/个人|购货单位)$/], // 整个标签相同：裸“购买方”不能匹配到“购买方统一社会信用代码”
  ["购买方税号", /^(购买方)?(统一社会信用代码|纳税人识别号|身份证号码\/组织机构代码|单位代码\/身份证号码)/],
  ["销售方名称", /^(销售方名称|销货单位名称|销售单位名称|卖方单位\/个人|经营、拍卖单位)/],
  ["合计金额", /^(不含税价|不含税金额)/],
  ["合计税额", /^(增值税税额|税额)/],
  ["价税合计", /^(价税合计|车价合计|合计)(\(.*\))?$/], // 不能匹配到“合计金额”
];

const LABELED = {
  name: "标签式票据",
  match: ({ type }) => /二手车销售统一发票/.test(type || ""),
  parse({ T, type }) {
    const inv = { 发票类型: type, items: [], 附加信息: [] };
    inv.发票号码 = valueOf(T, /^发票号码[:：]?/, /^\d{8,20}$/);
    inv.发票代码 = valueOf(T, /^发票代码[:：]?/, /^\d{10,12}$/);
    inv.开票日期 = normDate(valueOf(T, /^开票日期[:：]?/, /\d{4}\s*年|^\d{8}$|\d{4}-\d{2}-\d{2}/));
    const isLabel = (t) => /[:：]$/.test(t.s) || /^[^\d¥￥]{2,16}[:：]/.test(t.s);
    const kv = {};
    for (const lb of T.filter(isLabel)) {
      const [name, inline] = lb.s.split(/[:：]/);
      let v = (inline || "").trim();
      if (!v) {
        const right = T.filter((t) => t !== lb && sameRow(t, lb) && t.x > lb.x).sort((a, b) => a.x - b.x);
        const stop = right.findIndex(isLabel);
        v = (stop < 0 ? right : right.slice(0, stop)).map((t) => t.s).join("");
      }
      if (!v) {
        const below = T.filter((t) => t.y > lb.y + ROW_TOL && t.y < lb.y + 22 && t.x >= lb.x - 10 && t.x < lb.x + Math.max(lb.w, 40) + 20 && !isLabel(t));
        v = joinText(below);
      }
      if (name && v && !(name.trim() in kv)) kv[name.trim()] = v;
    }
    for (const [field, re] of LABELED_CORE) {
      const k = Object.keys(kv).find((n) => re.test(squash(n)));
      if (k) inv[field] = /金额|税额|合计/.test(field) ? toNum(kv[k]) : kv[k];
    }
    delete kv.发票号码; delete kv.开票日期; delete kv.发票代码;
    inv.附加信息 = Object.keys(kv).length ? [kv] : [];
    return inv;
  },
  check: taxNoIssues,
};

// ======================= 专家：财政电子票据 =======================
// 财政部门监制。票面要素：票据名称、票据代码（8 位：行政区划 2 + 分类 2 + 种类 2 + 年度 2）、票据号码（10 位）、
// 校验码、交款人及其信用代码、开票日期、明细（项目编码 / 项目名称 / 单位 / 数量 / 标准 / 金额）、金额合计、
// 其他信息、收款单位、复核人、收款人。映射：票据代码 → 发票代码，票据号码 → 发票号码，交款人 → 购买方，收款单位 → 销售方。
// 标题形如「××非税收入统一票据(电子)」「××医疗门诊收费票据(电子)」「××非税收入一般缴款书(电子)」

const FISCAL_TITLE_RE = /(票据|缴款书)\(电子\)$/;

/** 金额与备注挤在一块（“15.00 甲/0.00/0%”）时拆成两块，按字数估算各自的位置 */
function splitAmount(t) {
  const m = /^(-?[\d,]+\.\d{2})\s+(\S.*)$/.exec(t.s);
  if (!m) return [t];
  const w = t.w * m[1].length / t.s.length;
  return [{ ...t, s: m[1], w }, { ...t, s: m[2], x: t.x + w, w: t.w - w }];
}

/** 两级明细（浙江医疗票据）：大类行没有数量、金额等于其下各项之和，去掉 */
function dropSubtotals(items) {
  return items.filter((it, i) => {
    if (it.数量 != null) return true;
    const kids = [];
    for (const k of items.slice(i + 1)) {
      if (k.数量 == null) break;
      kids.push(k);
    }
    return !(kids.length && eq(round2(kids.reduce((s, k) => s + (k.金额 || 0), 0)), it.金额));
  });
}

const FISCAL = {
  name: "财政票据",
  category: "财政电子票据",
  match: ({ T, text }) => T.some((t) => FISCAL_TITLE_RE.test(squash(t.s))) && /票据号码|缴款书号码/.test(text),
  // PDF 内嵌财政部电子票据 XML（<EInvoice>）：票据要素和逐项明细。交款人为个人（PayerPartyType 1）时代码是完整证件号，出于隐私不取
  xml: {
    match: (f) => !!f.EInvoiceData,
    map(f) {
      const m = f.EInvoiceData.Main, payer = m.PayerParty || {};
      return {
        发票类型: X.halfBrackets(m.EInvoiceName || ""),
        发票代码: m.EInvoiceCode,
        发票号码: m.EInvoiceNumber,
        校验码: m.RandomNumber,
        开票日期: normDate(m.IssueDate),
        价税合计: xmlNum(m.TotalAmount),
        购买方名称: payer.PayerPartyName,
        购买方税号: payer.PayerPartyType === "2" ? payer.PayerPartyCode : "",
        销售方名称: (m.InvoicingParty || {}).InvoicingPartyName,
      };
    },
    finish(inv, f) {
      inv.合计金额 = inv.价税合计; // 不涉及增值税，与票面解析一致
      inv.items = [].concat((f.EInvoiceData.Details || {}).Item || []).map((i) => ({
        项目名称: i.ItemName, 规格型号: "", 单位: i.ItemUnit, 数量: xmlNum(i.ItemQuantity), 单价: null, 金额: xmlNum(i.ItemAmount), 税率: "", 税额: null,
        ...(i.ItemStd ? { 标准: i.ItemStd } : {}), ...(i.ItemRemark ? { 备注: i.ItemRemark } : {}),
      }));
    },
  },
  parse({ T }) {
    const titleTok = T.find((t) => FISCAL_TITLE_RE.test(squash(t.s)));
    const inv = { 发票类型: titleTok.s, items: [], 附加信息: [] };
    inv.发票代码 = valueOf(T, /^(票据代码|缴款书代码)[:：]?/, /^\d{8}$/);
    inv.发票号码 = valueOf(T, /^(票据号码|缴款书号码)[:：]?/, /^\d{8,12}$/);
    inv.校验码 = valueOf(T, /^校验码[:：]?/, /^[0-9A-Za-z]{4,10}$/);
    inv.开票日期 = normDate(valueOf(T, /^(开票日期|填制日期)[:：]?/, /\d{4}\s*年|\d{4}-\d{2}-\d{2}|^\d{8}$/));
    inv.购买方名称 = valueOf(T, /^交款人(?!统一)[:：]?/, null, { rowTol: 6 }); // 中央非税收入票据的值比标签低约 5 点
    inv.购买方税号 = valueOf(T, /^交款人统一社会信用代码[:：]?/, /^[0-9A-Z]{15,20}$/);
    inv.销售方名称 = valueOf(T, /^(收款单位(\(章\))?|执收单位名称)[:：]?/, null); // 缴款书为执收单位

    // 明细：表头以“项目名称”（缴款书为“收入项目名称”）定位；“项目编码”“标准”“备注”等列保留原名
    const header = T.find((t) => /项目名称$/.test(squash(t.s)));
    // “金额合计”可能拆成“金额”“合计”两块、可能不在行首（缴款书前有“币种”），按整行文字找，取以“金额”开头的块
    const sumLine = groupLines(T).find((l) => /金额合计/.test(squash(l.text)));
    const sumLb = sumLine && sumLine.toks.find((t) => /^金额/.test(squash(t.s)));
    const footer = T.find((t) => /^(收款单位|复核人|收款人|执收单位\()/.test(t.s));
    if (header) {
      // 明细在表头以下，到合计行或签章栏为止（缴款书的合计行在表头上方）；浙江医疗票据左右两栏，各有一套表头
      const bottom = Math.min(...[sumLb, footer].filter((t) => t && t.y > header.y).map((t) => t.y - 2), Infinity);
      const area = T.filter((t) => t.y > header.y + 3 && t.y < bottom).flatMap(splitAmount);
      const heads = T.filter((t) => sameRow(t, header) && /项目名称$/.test(squash(t.s))).sort((a, b) => a.x - b.x);
      inv.items = heads.flatMap((h, i) => {
        const inHalf = (t) => (!i || t.x >= h.x - 2) && (i + 1 === heads.length || t.x < heads[i + 1].x - 2);
        return parseItemRows(area.filter(inHalf), headerColumns(T.filter(inHalf), h), nearestCol);
      });
    }
    // 医疗收费票据的表头为“数量/单位”，值形如“1/元”
    for (const i of inv.items) {
      if (!("数量/单位" in i)) continue;
      const [q, u = ""] = i["数量/单位"].split("/");
      Object.assign(i, { 数量: toNum(q), 单位: u });
      delete i["数量/单位"];
    }
    inv.items = dropSubtotals(inv.items);
    if (sumLb) {
      const row = T.filter((t) => Math.abs(t.y - sumLb.y) <= 8 && t !== sumLb).sort((a, b) => a.x - b.x);
      inv.价税合计大写 = row.filter((t) => /[壹贰叁肆伍陆柒捌玖零].*[圆元角分整]|^[壹贰叁肆伍陆柒捌玖零]/.test(t.s)).map((t) => t.s).join("");
      const small = T.find((t) => /小写/.test(t.s) && t.y >= sumLb.y - 8 && t.y <= sumLb.y + 20);
      const inline = small && toNum(small.s.replace(/.*小写\)?/, ""));
      const next = small && T.filter((t) => sameRow(t, small) && t.x > small.x && /\d/.test(t.s)).sort((a, b) => a.x - b.x)[0];
      inv.价税合计 = inline != null ? inline : next ? toNum(next.s) : null;
      if (/大写\)?[:：]?.+/.test(sumLb.s) && !inv.价税合计大写) inv.价税合计大写 = sumLb.s.replace(/.*大写\)?[:：]?/, "");
    }
    inv.合计金额 = inv.价税合计;
    inv.合计税额 = null; // 不涉及增值税

    // 其他信息：竖排“其他信息”右侧、金额合计行以下、收款单位行以上的“标签：值”
    const qi = T.find((t) => squash(t.s) === "其" || /^其他信息/.test(squash(t.s)));
    if (qi) {
      const top = sumLb ? sumLb.y + ROW_TOL : qi.y - 10;
      const bottom = footer && footer.y > top ? footer.y - ROW_TOL : Infinity;
      inv.附加信息 = parseExtraTable(T.filter((t) => t.y > top && t.y < bottom && t.x > qi.x + 8));
    }
    // 票头其他“标签：值”（如医疗票据的门诊号、就诊日期、医保类型）
    if (header) {
      const MAPPED = /^(票据代码|票据号码|缴款书代码|缴款书号码|校验码|开票日期|填制日期|交款人|交款人统一社会信用代码)$/;
      const head = parseExtraTable(T.filter((t) => t.y > titleTok.y + ROW_TOL && t.y < header.y - ROW_TOL))[0] || {};
      for (const k of Object.keys(head)) if (MAPPED.test(k)) delete head[k];
      if (Object.keys(head).length) inv.附加信息.unshift(head);
    }
    inv.收款人 = valueOf(T, PAYEE_RE, null);
    inv.复核人 = valueOf(T, REVIEWER_RE, null);
    return inv;
  },
  check(inv) {
    const out = [];
    if (inv.发票代码 && !/^\d{8}$/.test(inv.发票代码)) out.push("票据代码应为 8 位数字");
    if (inv.发票号码 && !/^\d{10}$/.test(inv.发票号码)) out.push(`票据号码应为 10 位数字，实际为 ${inv.发票号码.length} 位`);
    return [...out, ...itemIssues(inv)];
  },
};

// ======================= 附件数据（内嵌 XML / XBRL） =======================
// 部分 PDF 内嵌开票方写入的结构化数据（铁路电子客票的财政部 XBRL、财政电子票据的 XML 等）。通用层只把 XML 解析成对象，
// 是哪种格式由专家的 xml 钩子判断：match(对象) 认领附件；map(对象) 转成发票字段（附加信息为对象，逐项合并到附加信息第一条）；
// finish(发票, 对象) 可选，收尾（如生成明细）。附件数据为准：票面没识别到的直接填入；二者不同时采用附件数据，
// 并记入 inv.附件核对（由 checkInvoice 并入 issues）

/**
 * XML → 对象，返回根元素的内容。去掉命名空间前缀；有子元素的元素为对象，叶子元素为文本（空元素为 ""）；
 * 同名元素出现多次时为数组（如财政票据明细的多个 <Item>；只有一个时不是数组，取用时用 [].concat 统一）
 */
function parseEmbedded(text) {
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const stack = [{ kids: {} }];
  const add = (node, name, v) => (node.kids[name] = name in node.kids ? [].concat(node.kids[name], [v]) : v);
  // 依次匹配：结束标签、开始 / 自闭合标签（<?xml ?> 和注释不会匹配为标签，按文本跳过）、文本
  for (const m of text.matchAll(/<\/(?:[\w.-]+:)?([\w.-]+)\s*>|<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const node = stack.pop();
      add(stack[stack.length - 1], node.name, Object.keys(node.kids).length ? node.kids : unescape(node.text).trim());
    } else if (m[2]) {
      if (m[3]) add(top, m[2], "");
      else stack.push({ name: m[2], kids: {}, text: "" });
    } else if (m[4] && top.name) top.text += m[4];
  }
  return Object.values(stack[0].kids)[0];
}
const xmlNum = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
const xmlRate = (v) => (xmlNum(v) == null ? "" : `${+(v * 100).toFixed(2)}%`); // 0.09 → 9%
const sameValue = (a, b) => (typeof a === "number" ? eq(a, b, 0.001) : normName(String(a)) === normName(String(b)));

/** 按发票号码找到属于这张发票的附件；没有就不用 */
function applyXml(inv, recs) {
  const x = expertOf(inv).xml;
  const hit = x && recs.filter(x.match).map((r) => [r, x.map(r)]).find(([, m]) => m.发票号码 === inv.发票号码);
  if (!hit) return;
  const [f, data] = hit;
  const diff = [];
  const merge = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v == null || v === "" || typeof v === "object") continue;
      const face = target[k];
      if (face == null || face === "") target[k] = v;
      else if (!sameValue(v, face)) {
        diff.push(`附件数据${k} ${v} 与票面 ${face} 不一致`);
        target[k] = v;
      }
    }
  };
  merge(inv, data);
  if (data.附加信息) merge((inv.附加信息[0] = inv.附加信息[0] || {}), data.附加信息);
  if (x.finish) x.finish(inv, f);
  inv.附件数据 = diff.length ? "不一致" : "一致";
  inv.附件核对 = diff;
}

// ======================= 调度与公共校验 =======================

/** 按顺序匹配，第一个认领的专家负责解析；VAT 兜底 */
const EXPERTS = [FISCAL, RAILWAY, AIR, VEHICLE, LABELED, LEGACY, VAT];
const expertOf = (inv) => EXPERTS.find((e) => e.name === inv.版式);

function parsePage(items, xml) {
  const T = prepare(items);
  const text = T.map((t) => t.s).join("").replace(/\s/g, "");
  const ctx = { T, text, type: (TYPE_RE.exec(text) || [])[1] };
  // 附件数据能认定票种时优先（票面标题可能拆碎识别不到），否则按票面匹配；要求页面上有号码标签，避免认领清单等非票据页
  const e = EXPERTS.find((x) => x.xml && xml.some(x.xml.match) && /(发票|票据|缴款书)号码/.test(text)) || EXPERTS.find((x) => x.match(ctx));
  if (!e) return null; // 不是发票页（如行程单、清单封面）
  return { ...e.parse(ctx), 票据类别: e.category || "税务发票", 版式: e.name };
}

/**
 * 解析 PDF 的所有页面：同一发票号码的连续页合并（续页），不同号码拆成多张发票。
 * 每张记下所在的 页（页号，从 0 起）：不是发票的页（清单、附页等）跟前一张，开头的跟第一张；多张时网页按它切出各自的文件
 * attachments：PDF 内嵌的 XML 附件 [{name, text}]（common/pdf.js 的 extractAttachments），可省略
 */
function parseInvoicePdf(pages, attachments = []) {
  const xml = attachments.map((a) => parseEmbedded(a.text));
  const invoices = [];
  const lead = []; // 第一张发票之前的非发票页
  for (const [pageIndex, p] of pages.entries()) {
    const inv = parsePage(p.items, xml);
    if (!inv) {
      (invoices.length ? invoices.at(-1).页 : lead).push(pageIndex); // 不是发票页（如清单封面）
      continue;
    }
    if (inv.小计) inv.小计[0].页 = pageIndex + 1;
    const last = invoices[invoices.length - 1];
    if (last && (!inv.发票号码 || inv.发票号码 === last.发票号码)) {
      last.items.push(...inv.items);
      if (inv.小计) (last.小计 ||= []).push(...inv.小计);
      for (const k of ["合计金额", "合计税额", "价税合计", "价税合计大写", "备注"]) if (inv[k] != null && inv[k] !== "") last[k] = inv[k];
      last.页数++;
      last.页.push(pageIndex);
    } else {
      invoices.push({ ...inv, 页数: 1, pageIndex, 页: invoices.length ? [pageIndex] : [...lead, pageIndex] });
    }
  }
  if (!invoices.length) throw new Error("没有识别到发票内容，可能不是发票");
  if (invoices.length === 1) delete invoices[0].页; // 只有一张的不拆
  for (const inv of invoices) {
    applyXml(inv, xml);
    inv.税率 = [...new Set(inv.items.map((i) => i.税率).filter(Boolean))].join("、");
    inv.附加信息文本 = inv.附加信息.map((r) => Object.entries(r).map(([k, v]) => `${k}:${v}`).join(" ")).join("；");
    inv.issues = checkInvoice(inv);
    inv.suggestedName = suggestName(inv);
  }
  return { invoices };
}

/** 解析并核对（网页、scripts 共用）：二维码（qrOf(发票) → 文字，取图由调用方提供），再白名单（二维码核对会重算 issues，须在其后） */
async function parseAndCheck(pages, attachments, qrOf, wl) {
  const { invoices } = parseInvoicePdf(pages, attachments);
  for (const inv of invoices) {
    applyQr(inv, await qrOf(inv));
    if (wl && wl.status === "ok") inv.issues.push(...checkWhitelist(inv, wl.entries));
  }
  return invoices;
}

/** 公共校验（所有票据）+ 专家专属校验 + 二维码 */
function checkInvoice(inv, qr) {
  const e = expertOf(inv);
  const out = [];
  for (const k of ["发票号码", "开票日期", "价税合计", ...(e.required || [])]) if (inv[k] == null || inv[k] === "") out.push(`缺少字段：${k}`);
  out.push(...e.check(inv));
  out.push(...(inv.附件核对 || []));
  // 18 位税号可能是统一社会信用代码（GB 32100），个人则是身份证号（GB 11643，如收购发票的销售方）
  for (const k of ["购买方税号", "销售方税号"]) {
    const v = inv[k];
    if (v && v.length === 18 && !checkCreditCode(v) && !checkIdCard(v)) out.push(`${k} ${v} 校验位不正确（GB 32100 / GB 11643）`);
  }
  if (inv.合计金额 != null && inv.合计税额 != null && inv.价税合计 != null && !eq(round2(inv.合计金额 + inv.合计税额), inv.价税合计))
    out.push(`金额 ${inv.合计金额} + 税额 ${inv.合计税额} ≠ 价税合计 ${inv.价税合计}`);
  if (inv.价税合计大写) {
    const v = parseChineseAmount(inv.价税合计大写);
    if (v == null) out.push(`无法解析大写金额：${inv.价税合计大写}`);
    else if (inv.价税合计 != null && !eq(v, inv.价税合计)) out.push(`大写金额 ${inv.价税合计大写}（${v}）与小写 ${inv.价税合计} 不一致`);
  }
  if (qr) out.push(...checkQr(inv, qr));
  return out;
}

// ======================= 二维码 =======================

/** 二维码内容：01,种类代码,发票代码,发票号码,金额,开票日期(YYYYMMDD，个别开票方写成 YYYY-MM-DD),校验码,…；不是税务发票二维码时返回 null */
function parseQr(text) {
  const p = (text || "").split(",");
  if (p.length < 6 || p[0] !== "01" || !/^\d{2}$/.test(p[1])) return null;
  return { 种类代码: p[1], 发票代码: p[2].trim(), 发票号码: p[3].trim(), 金额: parseFloat(p[4]), 开票日期: p[5].trim().replace(/-/g, ""), 校验码: (p[6] || "").trim(), 原文: text };
}

/** 种类代码 → 票面类型（10 / 31 / 32 / 33 / 51 / 61 已用实物验证；01 / 04 / 08 / 11 为旧版公开代码）；10 也用于各省通用电子发票 */
const QR_KINDS = {
  "31": /电子发票\(增值税专用发票\)/, "32": /电子发票\(普通发票\)/, "33": /机动车销售统一发票/, "51": /铁路电子客票/, "61": /航空运输电子客票行程单/,
  "01": /专用发票/, "04": /普通发票/, "08": /专用发票/, "10": /普通发票|通用\(电子\)发票/, "11": /普通发票/,
};

function checkQr(inv, qr) {
  const out = [];
  if (qr.发票号码 && inv.发票号码 && qr.发票号码 !== inv.发票号码) out.push(`二维码发票号码 ${qr.发票号码} 与票面 ${inv.发票号码} 不一致`);
  if (qr.发票代码 && inv.发票代码 && qr.发票代码 !== inv.发票代码) out.push(`二维码发票代码 ${qr.发票代码} 与票面 ${inv.发票代码} 不一致`);
  const d = inv.开票日期 ? inv.开票日期.replace(/-/g, "") : "";
  if (qr.开票日期 && d && qr.开票日期 !== d) out.push(`二维码开票日期 ${qr.开票日期} 与票面 ${d} 不一致`);
  // 金额：数电票（无发票代码）为价税合计，旧版为不含税金额；系统写入的精确值，只允许浮点误差
  const isDigital = !qr.发票代码;
  const expect = isDigital ? inv.价税合计 : inv.合计金额;
  if (!isNaN(qr.金额) && expect != null && Math.abs(expect - qr.金额) > 0.001)
    out.push(`二维码金额 ${qr.金额} 与票面${isDigital ? "价税合计" : "金额"} ${expect} 不一致`);
  const kind = QR_KINDS[qr.种类代码];
  if (kind && inv.发票类型 && !kind.test(inv.发票类型)) out.push(`二维码票种代码 ${qr.种类代码} 与票面类型「${inv.发票类型}」不一致`);
  return out;
}

/** 二维码文字（common/pdf.js findQr）补充进发票并重新检查；没识别到、或不是税务二维码（如财政电子票据的查验网址，没有统一格式）时不核对 */
function applyQr(inv, text) {
  const qr = parseQr(text);
  if (!qr) return;
  inv.二维码 = qr;
  if (!inv.发票代码 && qr.发票代码) inv.发票代码 = qr.发票代码;
  inv.issues = checkInvoice(inv, qr);
  inv.suggestedName = suggestName(inv);
}

/** 显示和导出用的完整号码：发票代码 + 发票号码（旧版发票 12 + 8 位，财政票据 8 + 10 位；数电票没有代码）。解析结果里两个字段仍分开存，核对要分别用 */
const fullNo = (inv) => (inv.发票代码 || "") + (inv.发票号码 || "");

/** 规范文件名：开票日期_销售方_价税合计_完整号码.pdf */
function suggestName(inv) {
  const seller = inv.销售方名称 || inv.发票类型.replace(/^电子发票\(|\)$/g, "");
  const amt = inv.价税合计 != null ? inv.价税合计.toFixed(2) : "金额未知";
  return safeFileName(`${(inv.开票日期 || "").replace(/-/g, "")}_${seller}_${amt}_${fullNo(inv) || "无号码"}`);
}

// ======================= 购买方白名单 =======================

const normName = X.compact;

/**
 * 购买方白名单（scripts/config.ini 的 [发票购买方白名单]）：每行「公司名称:统一社会信用代码」（冒号全角 / 半角均可），# 开头为注释，空行忽略。
 * 返回 { entries, status, message }；status：ok / empty / invalid。任一行不标准即整体 invalid（不校验）。
 */
function parseWhitelist(text) {
  const entries = [];
  for (const [i, raw] of (text || "").replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(.+?)\s*[:：]\s*([0-9A-Z]{18})$/.exec(line);
    if (!m) return { entries: [], status: "invalid", message: `第 ${i + 1} 行格式不正确，应为「公司名称:统一社会信用代码」` };
    if (!checkCreditCode(m[2])) return { entries: [], status: "invalid", message: `第 ${i + 1} 行税号 ${m[2]} 校验位不正确` };
    entries.push({ name: normName(m[1]), id: m[2] });
  }
  return { entries, status: entries.length ? "ok" : "empty", message: "" };
}

/** 购买方（财政票据为交款人）须在白名单内：有税号按税号查并核对名称，无税号按名称查 */
function checkWhitelist(inv, entries) {
  const name = normName(inv.购买方名称), id = inv.购买方税号 || "";
  if (!name && !id) return ["缺少购买方信息，无法核对白名单"];
  if (id) {
    const hit = entries.find((e) => e.id === id);
    if (!hit) return [`购买方不在白名单：${inv.购买方名称 || ""}（${id}）`];
    if (name && hit.name !== name) return [`购买方名称「${inv.购买方名称}」与白名单不一致，该税号应为「${hit.name}」`];
    return [];
  }
  return entries.some((e) => e.name === name) ? [] : [`购买方不在白名单：${inv.购买方名称}（无税号）`];
}

export { parseInvoicePdf, parseAndCheck, fullNo, parseWhitelist };
