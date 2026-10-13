/*
 * 单据核验的视图（框架见 common/ui.js 的 views）：报关单、发票、无法识别；单据核验页（app.js）和查询页（chaxun/app.js）共用。
 * 识别见 parser.js：报关单证按报关单归集（customs.js），发票一张一行（invoice.js）；货代的数电发票两个视图都有，各按各的规则命名、提交
 */
import * as U from "../common/ui.js";
import { brief, round2 } from "../common/text.js";
import { parseOcrBill, mergeDocs, serverDecls, serverMeta, serverKeys, serverBill, manualDoc, maskNo } from "./customs.js";
import { fullNo } from "./invoice.js";

const { esc, fmtMoney } = U;
const pick = (obj, cols) => Object.fromEntries(cols.map((k) => [k, obj[k]]));

// ======================= 报关单 =======================

const goodsName = (items) => brief(items.map((i) => i.商品名称), 3, "种");
const goods = (d) => goodsName(d.items) || d.header.主要货物名称 || "";
const moneyText = (totals) => Object.entries(totals).map(([c, v]) => `${c} ${fmtMoney(v)}`).join(" + ");
/** 几份报关单按币制合计的总价 */
const sumTotals = (list) => {
  const t = {};
  for (const d of list) for (const [c, v] of Object.entries(d.totals)) t[c] = (t[c] || 0) + v;
  return t;
};
const SHORT = { 出口退税联: "退税联", 预填单: "预填单", 放行通知书: "放行", 报关委托书: "委托", 提运单: "提运单", 数电发票: "数电发票" };
// 展示单据时按取得的先后：先签委托，报关行发预填单核对，海关放行，装船后签提运单，结关后才能打印退税联，货代、报关行再开费用发票
// （字段合并仍按 customs.js 的 TYPE_ORDER，退税联优先）
const FLOW = ["报关委托书", "预填单", "放行通知书", "提运单", "出口退税联", "数电发票"];
const docsText = (d) => FLOW.filter((t) => d.单据.some((x) => x.单据类型 === t)).map((t) => SHORT[t]).join(" ");
const missingText = (d) => FLOW.filter((t) => d.缺少.includes(t)).map((t) => SHORT[t]).join(" ");
// 齐套要求的单据（退税联结关后才能打印、数电发票是费用凭证，都不要求）
const REQUIRED = FLOW.filter((t) => t !== "出口退税联" && t !== "数电发票");

const HEADER_SHOW = ["海关编号", "预录入编号", "出口日期", "申报日期", "出口口岸", "境内收发货人", "生产销售单位", "境外收货人",
  "运输方式", "运输工具名称", "提运单号", "贸易方式", "征免性质", "结汇方式", "许可证号", "运抵国", "指运港",
  "境内货源地", "批准文号", "成交方式", "运费", "保费", "杂费", "合同协议号", "件数", "包装种类", "毛重",
  "净重", "集装箱号", "随附单据", "标记唛码及备注", "打印日期", "委托方", "被委托方", "主要货物名称", "HS编码"];
const SUMMARY_COLS = ["合同协议号", "申报日期", "出口日期", "海关编号", "提运单号", "已有单据", "缺少单据", "预录入编号", "出口口岸", "运抵国",
  "指运港", "贸易方式", "成交方式", "商品", "商品项数", "币制", "总价合计", "运费", "保费", "杂费",
  "件数", "包装种类", "毛重", "净重", "运输方式", "运输工具名称", "集装箱号", "境内收发货人", "境外收货人",
  "生产销售单位", "境内货源地", "许可证号", "征免性质", "结汇方式", "随附单据", "标记唛码及备注", "被委托方", "归档位置", "原文件名"];
const ITEM_COLS = ["出口日期", "海关编号", "合同协议号", "运抵国", "成交方式", "序号", "商品编号", "商品名称",
  "规格型号", "法定数量", "法定单位", "第二数量", "第二单位", "申报数量", "申报单位", "目的国", "目的国代码", "单价", "总价", "币制", "征免", "原文件名"];
const DOC_COLS = ["合同协议号", "海关编号", "单据类型", "版式", "归档位置", "原文件名"];
const NUMERIC = new Set(["件数", "毛重", "净重"]);
// 详情和 Excel 表头沿用票面写法（字段名去掉了括号，见 customs.js）
const LABEL = { 运抵国: "运抵国（地区）", 指运港: "指运港（地区）", 毛重: "毛重（千克）", 净重: "净重（千克）", 被委托方: "报关行（被委托方）" };
/** 某类单据是否已提交：服务器清单里这份报关单已有这类（不论文件名）；只在服务器上的看清单（已提交） */
const submitted = (d, t, srv) => t in (d.已提交 || {}) || srv.types(d.header.海关编号).has(t);
/** 过长的文字（如没对上报关单的草稿里取错的合同号）只显示一段，不撑开表格 */
const clip = (s) => `<span class="clip">${esc(s)}</span>`;
/** Excel 里件数、毛重、净重写成数字（不是数字的原样） */
const cellNum = (v) => (v !== "" && v != null && !isNaN(+v) ? +v : v);
// 文件名含 BL（B-L、B_L、HBL、MBL 等）、提单、提运单、BILL OF LADING 的无法识别文件算疑似提运单；保险单、保函的文件名常带提单号，排除
const SUSPECT = /^(?!.*(保单|保函))(.*(^|[^A-Z])[HM]?B[\s._-]?L([^A-Z]|$)|.*提运?单|.*BILL\s*OF\s*LADING)/i;

export const customsView = {
  id: "customs",
  label: "报关单",
  unit: "份",
  submit: "报关资料",
  zipName: "报关资料_归档.zip",
  filters: [["lack", "缺文件"], ["warn", "需核对"], ["sus", "疑似提运单"]],
  accepts: () => true, // 全部交给 mergeDocs：报关单证按报关单归集，数电发票按备注归入，其他发票不参与
  // 认出是提运单但没对上报关单的、文件名像提运单的无法识别文件
  suspect: { label: "疑似提运单", re: SUSPECT },
  lacking: (d, srv) => d.单据类型 === "报关单" && REQUIRED.some((t) => !d.单据.some((x) => x.单据类型 === t) && !submitted(d, t, srv)),
  merge: mergeDocs,
  fill: (key, d, type, file) => manualDoc(key, type, file.name),
  serverRows: (m, keymap, billmap) => serverDecls(m.groups || [], keymap, billmap),
  serverMeta,
  serverKeys,
  serverBill,
  sortBy: "申报日期",
  sortKey: (d) => (d.header.合同协议号 || "") + (d.header.申报日期 || "") + (d.header.海关编号 || ""),

  // [表头, 显示, 样式, 排序取值]；金额按「币种 + 金额」排序（同币种内按数值）
  columns: [
    ["合同协议号", (d) => clip(d.header.合同协议号), "nowrap", (d) => d.header.合同协议号],
    // 只在服务器上的海关编号是部分隐去的
    ["申报日期", (d) => esc(d.header.申报日期), "nowrap", (d) => d.header.申报日期],
    ["海关编号", (d) => esc(d.header.海关编号), "nowrap", (d) => d.header.海关编号],
    ["商品", (d) => esc(goods(d)), "goods", goods],
    ["运抵国", (d) => esc(d.header.运抵国), "nowrap", (d) => d.header.运抵国],
    ["金额", (d) => esc(moneyText(d.totals)), "num", (d) => Object.entries(d.totals).map(([c, v]) => `${c} ${v.toFixed(2).padStart(16, "0")}`).join(" ")],
  ],
  // 一份报关单一行多个文件，只在疑似提运单里显示原文件名列
  fileColumn: (filter) => filter === "sus",
  // 按合同号分组：合同行显示申报日期范围、商品、运抵国、金额合计（列与 columns 对应）；没对上报关单的单据有合同号的也归入该合同
  groupBy: (d) => d.header.合同协议号 || null,
  groupRow(contract, list) {
    const dates = list.map((d) => d.header.申报日期).filter(Boolean).sort();
    const uniq = (xs) => brief(xs, Infinity);
    return [
      clip(contract),
      esc(dates.length ? (dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} ~ ${dates.at(-1)}`) : ""),
      "",
      esc(goodsName(list.flatMap((d) => d.items)) || uniq(list.map((d) => d.header.主要货物名称))),
      esc(uniq(list.map((d) => d.header.运抵国))),
      esc(moneyText(sumTotals(list))),
    ];
  },
  stats: (list) => Object.entries(sumTotals(list)).sort().map(([c, v]) => [`${c} 合计`, fmtMoney(v)]),
  // 只在服务器上的只有单据清单，没有字段和明细
  detail: (d, srv) =>
    (d.服务器 ? "" : U.kvGrid({ 归档位置: d.归档位置, ...d.header }, ["归档位置", ...HEADER_SHOW], LABEL)) +
    // 单据齐套情况：按取得先后固定列出全部类型。待提交（本地有）正常显示；已提交（服务器上已有）灰色，
    // 只在服务器上的「版式」写提交时间和提交者、「打包后」只写“已提交”；未提交（都没有）黄色划线
    U.itemTable(FLOW.flatMap((t) => {
      const xs = d.单据.filter((x) => x.单据类型 === t).map((x) => ({ ...x, 状态: srv.has(x.归档位置) ? "已提交" : "待提交" }));
      if (xs.length) return xs;
      return submitted(d, t, srv) ? [{ 单据类型: t, 状态: "已提交", 版式: d.已提交?.[t] || "", 归档位置: "已提交" }] : [{ 单据类型: t, 状态: "未提交" }];
    }), [
      ["单据", (x) => `<span class="doc-${x.状态}">${esc(x.单据类型)}</span>`],
      // 缺的单据可直接选文件补上（不识别，作为这份报关单的该类单据）；只在服务器上的（没有完整编号、查询页只读）不能补
      ["版式", (x) => (x.状态 === "未提交" && d.单据类型 === "报关单" && !d.服务器
        ? `<button type="button" class="link" data-fill="${x.单据类型}">上传</button>` : `<span class="doc-${x.状态}">${esc(x.版式)}</span>`)],
      ["原文件名", (x) => (x.原文件名 ? `<a href="#" class="open doc-${x.状态}" data-open="${esc(x.原文件名)}">${esc(x.原文件名)}</a>` : "")],
      ["打包后", (x) => `<span class="doc-${x.状态}">${esc(x.归档位置)}</span>`],
    ]) +
    (d.items.length ? U.itemTable(d.items, [
      ["序号", (i) => i.序号],
      ["商品编号", (i) => esc(i.商品编号)],
      ["商品名称", (i) => esc(i.商品名称)],
      ["规格型号", (i) => esc(i.规格型号), "spec"],
      ["法定数量", (i) => esc(`${i.法定数量 ?? ""} ${i.法定单位}`), "num"],
      ["第二数量", (i) => (i.第二数量 ? esc(`${i.第二数量} ${i.第二单位}`) : ""), "num"],
      ["申报数量", (i) => esc(`${i.申报数量 ?? ""} ${i.申报单位}`), "num"],
      ["单价", (i) => esc(i.单价), "num"],
      ["总价", (i) => fmtMoney(i.总价), "num"],
      ["币制", (i) => esc(i.币制)],
    ]) : ""),

  // 一份报关单一行（字段已合并），商品明细取自出口退税联；单据清单列出每个文件及打包后的位置
  excel: {
    prefix: "报关资料汇总",
    sheets(list) {
      const summary = [], detail = [], docs = [], issues = [];
      for (const d of list) {
        const h = d.header;
        for (const x of d.单据) docs.push({ 合同协议号: h.合同协议号, 海关编号: h.海关编号, ...x });
        for (const s of d.issues) issues.push({ 合同协议号: h.合同协议号, 海关编号: h.海关编号, 问题: s, 原文件名: d.原文件名 });
        if (d.单据类型 !== "报关单") continue; // 未匹配的单据只进单据清单
        const curs = Object.keys(d.totals);
        const base = { 出口日期: h.出口日期, 海关编号: h.海关编号, 合同协议号: h.合同协议号, 运抵国: h.运抵国, 成交方式: h.成交方式, 原文件名: d.原文件名 };
        const row = Object.fromEntries(SUMMARY_COLS.filter((k) => k in h).map((k) => [k, NUMERIC.has(k) ? cellNum(h[k]) : h[k]]));
        summary.push(Object.assign(row, base, {
          已有单据: docsText(d), 缺少单据: missingText(d), 归档位置: d.归档位置,
          商品: [...new Set(d.items.map((i) => i.商品名称))].join("、") || h.主要货物名称, 商品项数: d.items.length || null,
          币制: curs.join("、"), 总价合计: curs.length === 1 ? d.totals[curs[0]] : moneyText(d.totals),
        }));
        for (const i of d.items) detail.push({ ...i, ...base });
      }
      return [
        { name: "报关单汇总", rows: summary, cols: SUMMARY_COLS, labels: LABEL, widths: { 商品: 24, 归档位置: 40, 原文件名: 40, 集装箱号: 24, 境内收发货人: 26, 境外收货人: 26, 生产销售单位: 26, 被委托方: 26 } },
        { name: "商品明细", rows: detail, cols: ITEM_COLS, labels: LABEL, widths: { 商品名称: 20, 规格型号: 40, 原文件名: 40 } },
        { name: "单据清单", rows: docs, cols: DOC_COLS, widths: { 合同协议号: 16, 海关编号: 22, 归档位置: 60, 原文件名: 50 } },
        { name: "需核对", rows: issues, cols: ["合同协议号", "海关编号", "问题", "原文件名"], widths: { 海关编号: 22, 问题: 60, 原文件名: 50 } },
      ];
    },
  },
};

// ======================= 发票 =======================

const shortType = (t) => (t || "").replace(/^电子发票\((.+)\)$/, "$1").replace(/^增值税/, "").replace(/\(电子\)$/, "");
const itemSummary = (items) => brief(items.map((i) => i.项目名称.replace(/^\*[^*]+\*/, "")), 2, "项");

const FIELDS_SHOW = ["发票类型", "特定业务", "发票号码", "开票日期", "校验码", "购买方名称", "购买方税号", "购买方地址电话", "购买方开户行及账号",
  "销售方名称", "销售方税号", "销售方地址电话", "销售方开户行及账号", "合计金额", "合计税额", "价税合计", "税率", "开票人", "收款人", "复核人",
  "备注", "附加信息文本", "提交"];
// Excel 列。金额为不含税金额（表头显示“不含税金额”），价税合计 = 金额 + 税额；核对结果不导出。
// 发票号码 = 发票代码 + 发票号码（见 fullNo），所以没有单独的发票代码列。
// 汇总表按票面从上到下（税务总局公告 2024 年第 11 号的票面要素）：票头 → 购买方 → 销售方 → 明细 → 价税合计 → 备注 → 开票人等，原文件名最后
const INV_SUMMARY_COLS = ["开票日期", "发票号码", "票据类别", "发票类型", "特定业务", "购买方名称", "购买方税号", "销售方名称", "销售方税号",
  "项目名称", "单位", "数量", "金额", "税率", "税额", "价税合计", "备注", "开票人", "收款人", "复核人", "原文件名"];
// 明细表：销售方、行号、明细金额，再到日期号码；规格型号、单价、通行费和财政票据的专有列不导出
const INV_ITEM_COLS = ["销售方名称", "行号", "项目名称", "数量", "单位", "价税合计", "金额", "税额", "税率", "开票日期", "发票号码"];
const INV_LABELS = { 金额: "不含税金额", 销售方税号: "销售方统一社会信用代码/纳税人识别号", 购买方税号: "购买方统一社会信用代码/纳税人识别号", 附加信息文本: "附加信息" };

export const invoiceView = {
  id: "invoice",
  label: "发票",
  unit: "张",
  submit: "发票",
  zipName: "发票_规范命名.zip",
  filters: [["warn", "需核对"]],
  accepts: (d) => d.类别 === "发票",
  // 规范命名：开票年月/开票日期_销售方_价税合计_号码.pdf
  fileName: (i) => `${(i.开票日期 || "").slice(0, 7).replace("-", "") || "无开票日期"}/${i.suggestedName}`,
  // 提交时记入服务器清单（查询页的发票列表）：号码部分隐去，不含购买方、明细
  serverMeta: (i) => ({ 字段: { 单据类型: "发票", 发票类型: i.发票类型, 开票日期: i.开票日期, 发票号码: maskNo(fullNo(i)), 销售方名称: i.销售方名称,
    价税合计: String(i.价税合计 ?? "") } }),
  // 查询页：服务器清单里的发票
  serverRows: (m) => (m.files || []).filter((f) => f.单据类型 === "发票").map((f) => ({
    类别: "发票", 服务器: true, 发票类型: f.发票类型, 开票日期: f.开票日期, 发票号码: f.发票号码, 销售方名称: f.销售方名称,
    价税合计: f.价税合计 === "" ? null : +f.价税合计, items: [], 附加信息: [], issues: [],
    提交: `${(f.提交时间 || "").replace("T", " ")} · ${f.提交IP || ""}`,
  })),
  sortKey: (i) => (i.开票日期 || "") + fullNo(i),

  columns: [
    ["开票日期", (i) => esc(i.开票日期), "nowrap", (i) => i.开票日期],
    ["发票 / 票据号码", (i) => esc(fullNo(i)), "nowrap mono", (i) => fullNo(i)],
    ["类型", (i) => esc(shortType(i.发票类型)) + (i.特定业务 ? `<br><span class="tip">${esc(i.特定业务)}</span>` : ""), "nowrap", (i) => shortType(i.发票类型) + (i.特定业务 || "")],
    ["销售方", (i) => esc(i.销售方名称 || "—"), "goods", (i) => i.销售方名称],
    ["项目", (i) => esc(itemSummary(i.items)), "goods", (i) => itemSummary(i.items)],
    ["价税合计", (i) => fmtMoney(i.价税合计), "num", (i) => i.价税合计],
  ],
  detail: (i) =>
    U.kvGrid({ ...i, 发票号码: fullNo(i) }, FIELDS_SHOW, INV_LABELS) +
    (i.items.length ? U.itemTable(i.items, [
      ["行", (x, n) => n + 1],
      ["项目名称", (x) => esc(x.项目名称)],
      ["规格型号", (x) => esc(x.规格型号)],
      ["单位", (x) => esc(x.单位)],
      ["数量", (x) => esc(x.数量 ?? ""), "num"],
      ["单价", (x) => esc(x.单价 ?? ""), "num"],
      ["金额", (x) => fmtMoney(x.金额), "num"],
      ["税率", (x) => esc(x.税率)],
      ["税额", (x) => fmtMoney(x.税额), "num"],
    ]) : ""),

  excel: {
    prefix: "发票汇总",
    sheets(list) {
      const summary = [], detail = [], issues = [];
      for (const i of list) {
        const one = i.items.length === 1 ? i.items[0] : { 数量: "见发票明细" }; // 单位、数量只在只有一行明细时填
        summary.push(pick({
          ...i, 项目名称: [...new Set(i.items.map((x) => x.项目名称))].join("、"), 单位: one.单位, 数量: one.数量,
          金额: i.合计金额, 税额: i.合计税额, 发票号码: fullNo(i), 备注: [i.备注, i.附加信息文本].filter(Boolean).join("；"),
        }, INV_SUMMARY_COLS));
        i.items.forEach((x, n) => detail.push(pick({
          ...x, 价税合计: round2(x.金额 + (x.税额 || 0)), 行号: n + 1, 开票日期: i.开票日期, 发票号码: fullNo(i), 销售方名称: i.销售方名称,
        }, INV_ITEM_COLS)));
        for (const s of i.issues) issues.push({ 开票日期: i.开票日期, 发票号码: fullNo(i), 销售方名称: i.销售方名称, 问题: s, 原文件名: i.原文件名 });
      }
      return [
        { name: "发票汇总", rows: summary, cols: INV_SUMMARY_COLS, labels: INV_LABELS, widths: { 发票号码: 24, 购买方名称: 28, 销售方名称: 28, 购买方税号: 22, 销售方税号: 22,
          项目名称: 30, 备注: 40, 原文件名: 40 } },
        { name: "发票明细", rows: detail, cols: INV_ITEM_COLS, labels: INV_LABELS, widths: { 发票号码: 24, 销售方名称: 28, 项目名称: 30 } },
        { name: "需核对", rows: issues, cols: ["开票日期", "发票号码", "销售方名称", "问题", "原文件名"], widths: { 发票号码: 24, 销售方名称: 28, 问题: 60, 原文件名: 50 } },
      ];
    },
  },
};

// ======================= 无法识别 =======================

export const errorView = {
  id: "err",
  label: "无法识别",
  unit: "个",
  accepts: () => false,
  errors: true, // 其余识别不了的文件（疑似提运单的归在报关单视图，见 suspect）
  columns: [["原因"]],
};

// ======================= 页面共用 =======================

/** 判重：发票按代码 + 号码；报关单证以单份文件为单位，提运单没有报关单号用全文；没有编号的（如预填单草稿）不判重 */
export const key = (d) => {
  if (d.类别 === "发票") return d.发票号码 && `发票#${d.发票代码 || ""}#${d.发票号码}`;
  const id = d.header.海关编号 || d.全文;
  return id ? `${d.单据类型}#${id}` : null;
};
/** 搜索用的文本 */
export const hay = (d) => (d.类别 === "发票"
  ? [fullNo(d), d.销售方名称, d.购买方名称, d.销售方税号, d.购买方税号, d.备注, d.附加信息文本, ...d.items.map((x) => x.项目名称)]
  : [d.单据类型, d.header.海关编号, d.header.合同协议号, d.header.提运单号, d.header.运抵国, d.header.主要货物名称, ...d.items.flatMap((i) => [i.商品名称, i.商品编号])]).join(" ");
/** 疑似提运单的扫描件可 OCR，得到的文字按提运单关联 */
export const ocr = { on: ["sus"], parse: (text, file) => [{ ...parseOcrBill(text), 原文件名: file.name }] };
