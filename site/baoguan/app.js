/* 报关资料：页面配置（通用框架见 common/ui.js）。单据识别与按报关单合并见 parser.js；列表一份报关单一行 */
import * as U from "../common/ui.js";
import { brief } from "../common/text.js";
import { parseSplit, parseOcrBill, mergeDocs, serverDecls, serverMeta, serverKeys, serverBill, manualDoc } from "./parser.js";

const { esc, fmtMoney } = U;

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
// （字段合并仍按 parser.js 的 TYPE_ORDER，退税联优先）
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
// 详情和 Excel 表头沿用票面写法（字段名去掉了括号，见 parser.js）
const LABEL = { 运抵国: "运抵国（地区）", 指运港: "指运港（地区）", 毛重: "毛重（千克）", 净重: "净重（千克）", 被委托方: "报关行（被委托方）" };
/** 某类单据是否已提交：服务器清单里这份报关单已有这类（不论文件名）；只在服务器上的看查询到的清单（已提交） */
const submitted = (d, t, srv) => !!d.已提交?.[t] || srv.types(d.header.海关编号).has(t);
/** 过长的文字（如没对上报关单的草稿里取错的合同号）只显示一段，鼠标移上去看全文，不撑开表格 */
const clip = (s) => `<span class="clip" title="${esc(s)}">${esc(s)}</span>`;
/** Excel 里件数、毛重、净重写成数字（不是数字的原样） */
const cellNum = (v) => (v !== "" && v != null && !isNaN(+v) ? +v : v);

// 全局入口供调试 / 自动化测试使用
window.__customsApp = U.createApp({
  title: "报关资料",
  sub: "报关委托书、预填单、放行通知书、提运单、出口退税联、数电发票：同一份报关单合为一行、互相核对，归档打包，导出 Excel。",
  icon: "📄",
  dropTitle: "把报关资料 PDF（或整个文件夹）拖到这里",
  zipTitle: "合同号/申报日期/单据类型_海关编号.pdf；没对上报关单的、无法识别的不打包，需核对的照常打包",
  tip: "把文件名改成提运单号，即可自动归入对应的报关单。",
  search: "搜索 合同号 / 提运单号 / 海关编号 / 品名 / 国家…",
  unit: "份",
  allLabel: "报关单",
  zipName: "报关资料_归档.zip",
  splitIssues: true, // 第一个框只含报关单（含需核对），无法识别、疑似提运单各自单列
  submit: "报关资料",
  // 认出是提运单但没对上报关单的，以及文件名含 BL（B-L、B_L、HBL、MBL 等）、提单、提运单、BILL OF LADING 的无法识别文件；
  // 保险单、保函的文件名常带提单号，排除
  suspect: { label: "疑似提运单", re: /^(?!.*(保单|保函))(.*(^|[^A-Z])[HM]?B[\s._-]?L([^A-Z]|$)|.*提运?单|.*BILL\s*OF\s*LADING)/i },
  ocr: { on: ["sus"], parse: (text, file) => [{ ...parseOcrBill(text), 原文件名: file.name }] },
  lacking: (d, srv) => d.单据类型 === "报关单" && REQUIRED.some((t) => !d.单据.some((x) => x.单据类型 === t) && !submitted(d, t, srv)),

  // 合订文件按页拆成几份（见 parser.js parseSplit），每份切出那几页作为它的文件（U.withPdf）；识别不出的那份进“无法识别”
  load: (file) => U.withPdf(file, ({ pages }) => parseSplit(pages, file.name)),
  merge: mergeDocs,
  fill: (key, d, type, file) => manualDoc(key, type, file.name),
  serverRows: serverDecls,
  serverMeta,
  serverKeys,
  serverBill,
  // 判重以单份文件为单位；提运单没有报关单号，用全文判重；数电发票按发票号码
  // 没有编号的（如还没有海关编号的预填单草稿）不判重，否则几份不相干的会被当成同一份只留一份
  key: (d) => {
    const id = d.header.海关编号 || d.发票号码 || d.全文;
    return id ? `${d.单据类型}#${id}` : null;
  },
  hay: (d) => [d.单据类型, d.header.海关编号, d.header.合同协议号, d.header.提运单号, d.header.运抵国, d.header.主要货物名称, d.发票号码, d.销售方名称,
    ...d.items.flatMap((i) => [i.商品名称, i.商品编号])].join(" "),
  sortBy: "申报日期",
  sortKey: (d) => (d.header.合同协议号 || "") + (d.header.申报日期 || "") + (d.header.海关编号 || ""),

  // [表头, 显示, 样式, 排序取值]；金额按「币种 + 金额」排序（同币种内按数值）
  columns: [
    ["合同协议号", (d) => clip(d.header.合同协议号), "nowrap", (d) => d.header.合同协议号],
    // 只在服务器上的（查询已提交）海关编号是部分隐去的；拖入其单据后显示完整内容
    ["申报日期", (d) => esc(d.header.申报日期), "nowrap", (d) => d.header.申报日期],
    ["海关编号", (d) => esc(d.header.海关编号), "nowrap", (d) => d.header.海关编号],
    ["商品", (d) => esc(goods(d)), "goods", goods],
    ["运抵国", (d) => esc(d.header.运抵国), "nowrap", (d) => d.header.运抵国],
    ["金额", (d) => esc(moneyText(d.totals)), "num", (d) => Object.entries(d.totals).map(([c, v]) => `${c} ${v.toFixed(2).padStart(16, "0")}`).join(" ")],
  ],
  // 报关单一行多个文件，只在疑似提运单、无法识别页显示原文件名列
  fileColumn: (filter) => filter === "sus" || filter === "err",
  // 按合同号分组：合同行显示申报日期范围、商品、运抵国、金额合计（列与 columns 对应）
  // 没对上报关单的单据（如还没有海关编号的预填单草稿）有合同号的也归入该合同
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
  // 查询出来的（只在服务器上）只有单据清单，没有字段和明细
  detail: (d, srv) =>
    (d.服务器 ? "" : U.kvGrid({ 归档位置: d.归档位置, ...d.header }, ["归档位置", ...HEADER_SHOW], LABEL)) +
    // 单据齐套情况：按取得先后固定列出全部类型。待提交（本地有）正常显示；已提交（服务器上已有）灰色，
    // 只在服务器上的「版式」写提交时间和提交者、「打包后」只写“已提交”；未提交（都没有）黄色划线
    U.itemTable(FLOW.flatMap((t) => {
      const xs = d.单据.filter((x) => x.单据类型 === t).map((x) => ({ ...x, 状态: srv.has(x.归档位置) ? "已提交" : "待提交" }));
      if (xs.length) return xs;
      return submitted(d, t, srv) ? [{ 单据类型: t, 状态: "已提交", 版式: d.已提交?.[t] || "", 归档位置: "已提交" }] : [{ 单据类型: t, 状态: "未提交" }];
    }), [
      ["单据", (x) => `<span class="doc-${x.状态}" title="${x.状态}">${esc(x.单据类型)}</span>`],
      // 缺的单据可直接选文件补上（不识别，作为这份报关单的该类单据）；本地识别的、查询得到的都可以
      ["版式", (x) => (x.状态 === "未提交" && d.单据类型 === "报关单"
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
});
