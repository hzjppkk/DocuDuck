/*
 * 中华人民共和国海关出口货物报关单（出口退税联，JG09 打印版）解析器
 *
 * 输入：每页文本块 [{str, x, y, w}]（y 自上而下，见 common/pdf.js）
 * 输出：{ header, items, totals, issues, suggestedName }
 */
import * as X from "../common/text.js";

const { prepare, round2, safeFileName } = X;

// 表头标签（单元格左上角的小字），值位于标签正下方、同一列
const HEADER_LABELS = [
  "出口口岸", "备案号", "出口日期", "申报日期",
  "境内收发货人", "运输方式", "运输工具名称", "提运单号",
  "生产销售单位", "贸易方式", "征免性质", "结汇方式",
  "许可证号", "运抵国（地区）", "指运港（地区）", "境内货源地",
  "批准文号", "成交方式", "运费", "保费", "杂费",
  "合同协议号", "件数", "包装种类", "毛重（千克）", "净重（千克）",
  "集装箱号", "随附单据", "标记唛码及备注",
  "商品序号", // 商品表头，作为表头区域的终止行
];
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

function parseHeader(T) {
  const labels = [];
  for (const t of T) {
    const m = /^(.+?)(?:\((\w+)\))?$/.exec(t.s);
    if (m && HEADER_LABELS.includes(m[1])) labels.push({ name: m[1], code: m[2] || "", x: t.x, y: t.y });
  }
  const rowYs = [...new Set(labels.map((l) => Math.round(l.y)))].sort((a, b) => a - b);
  const header = {};
  for (const lb of labels) {
    if (lb.name === "商品序号" || lb.name in header) continue;
    const nextRowY = rowYs.find((y) => y > lb.y + TOL) ?? Infinity;
    const nextX = Math.min(Infinity, ...labels.filter((o) => sameRow(o, lb) && o.x > lb.x + 1).map((o) => o.x));
    header[lb.name] = joinText(T.filter((t) => t.y > lb.y + TOL && t.y < nextRowY - TOL && t.x >= lb.x - 1 && t.x < nextX - 1));
    if (lb.code) header[lb.name + "代码"] = lb.code;
  }
  const all = T.map((t) => t.s).join("\n");
  for (const key of ["预录入编号", "海关编号", "打印日期"]) {
    const m = new RegExp(`${key}：\\s*(\\S+)`).exec(all);
    header[key] = m ? m[1] : "";
  }
  return header;
}

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

/** 解析整份报关单（可多页；表头每页重复，商品按序号合并） */
function parseDeclaration(pages) {
  if (!pages.length) throw new Error("PDF 没有页面");
  const P = pages.map((p) => prepare(p.items));
  if (!/报关单/.test(P[0].map((t) => t.s).join(""))) throw new Error("看起来不是报关单（未找到“报关单”字样）");
  const header = parseHeader(P[0]);
  const bySeq = new Map();
  for (const T of P) for (const it of parseItems(T)) if (!bySeq.has(it.序号)) bySeq.set(it.序号, it);
  const items = [...bySeq.values()].sort((a, b) => a.序号 - b.序号);
  header.页数 = pages.length;
  const decl = { header, items, totals: currencyTotals(items) };
  decl.issues = checkDeclaration(decl);
  decl.suggestedName = suggestName(decl);
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
  for (const k of ["海关编号", "出口日期", "运抵国（地区）", "成交方式", "合同协议号", "贸易方式"])
    if (!h[k]) issues.push(`缺少字段：${k}`);
  if (!items.length) issues.push("未识别到商品明细");
  const gross = num(h["毛重（千克）"]), net = num(h["净重（千克）"]);
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

/** 按报关单内容生成文件名（格式同发票，下划线分隔）：出口日期_运抵国_合同协议号_品名等_贸易方式成交方式_币种金额.pdf */
function suggestName({ header: h, items, totals }) {
  const names = [...new Set(items.map((i) => i.商品名称))];
  const name = (names[0] || "未知品名") + (names.length > 1 ? "等" : "");
  const money = Object.entries(totals).map(([c, v]) => c + v).join("+");
  return safeFileName([h.出口日期, h["运抵国（地区）"], h.合同协议号, name, (h.贸易方式 || "") + (h.成交方式 || ""), money].map((s) => s || "").join("_"));
}

export { parseDeclaration };
