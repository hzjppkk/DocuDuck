/* 报关资料整理：页面配置（通用框架见 common/ui.js）。单据识别与按报关单合并见 parser.js；列表一份报关单一行 */
import * as U from "../common/ui.js";
import { parseCustomsPdf, mergeDocs } from "./parser.js";

const { esc, fmtMoney } = U;

const goodsName = (items) => {
  const names = [...new Set(items.map((i) => i.商品名称))];
  return names.slice(0, 3).join("、") + (names.length > 3 ? ` 等${names.length}种` : "");
};
const goods = (d) => goodsName(d.items) || d.header.主要货物名称 || "";
const moneyText = (totals) => Object.entries(totals).map(([c, v]) => `${c} ${fmtMoney(v)}`).join(" + ");
const SHORT = { 出口退税联: "退税联", 预填单: "预填单", 放行通知书: "放行", 电子委托: "委托", 提单: "提单" };
// 展示单据时按取得的先后：先签委托，报关行发预填单核对，海关放行，装船后签提单，结关后才能打印退税联
// （字段合并仍按 parser.js 的 TYPE_ORDER，退税联优先）
const FLOW = ["电子委托", "预填单", "放行通知书", "提单", "出口退税联"];
const docsText = (d) => FLOW.filter((t) => d.单据.some((x) => x.单据类型 === t)).map((t) => SHORT[t]).join(" ");
const missingText = (d) => FLOW.filter((t) => d.缺少.includes(t)).map((t) => SHORT[t]).join(" ");

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
const toNum = (v) => (v !== "" && v != null && !isNaN(+v) ? +v : v);

// 全局入口供调试 / 自动化测试使用
window.__customsApp = U.createApp({
  title: "报关资料整理工具",
  sub: "把出口报关资料 PDF（报关单出口退税联、预填单、放行通知书、电子委托、提单）拖进来，同一份报关单的单据合为一行、互相核对，按报关单归档打包，一键导出 Excel 台账。",
  icon: "📄",
  dropTitle: "把报关资料 PDF（或整个文件夹）拖到这里",
  zipTitle: "按合同号、申报日期分文件夹：合同号/申报日期/单据类型_报关单号.pdf；识别不了的文件（如扫描件）原样放入“未识别”，保留原文件夹层级（原文件不会被修改）",
  search: "搜索 合同号 / 提运单号 / 海关编号 / 品名 / 国家…",
  footer: "适用于出口报关资料：报关单出口退税联（JG09）、报关行的预填单（仅供核对用）、通关无纸化出口放行通知书、代理报关委托书（电子）、提单。电子委托按报关单号、提单按提运单号或集装箱号并入同批的报关单；找不到对应报关单的单独列出，打包时放入“未匹配”。",
  unit: "份",
  allLabel: "全部",
  dupNote: "同类单据且报关单号相同",
  zipName: "报关资料_归档.zip",
  unrecognizedDir: "未识别",

  async load(file) {
    const { pages, close } = await U.loadPdf(file);
    close();
    return [{ ...parseCustomsPdf(pages), 原文件名: file.name }];
  },
  merge: mergeDocs,
  // 判重以单份文件为单位；提单没有报关单号，用全文判重
  key: (d) => `${d.单据类型}#${d.header.海关编号 || d.全文}`,
  hay: (d) => [d.单据类型, d.header.海关编号, d.header.合同协议号, d.header.提运单号, d.header.运抵国, d.header.主要货物名称,
    ...d.items.flatMap((i) => [i.商品名称, i.商品编号])].join(" "),
  sortKey: (d) => (d.header.合同协议号 || "") + (d.header.申报日期 || "") + (d.header.海关编号 || ""),

  // [表头, 显示, 样式, 排序取值]；金额按「币种 + 金额」排序（同币种内按数值）
  columns: [
    ["合同协议号", (d) => esc(d.header.合同协议号), "nowrap", (d) => d.header.合同协议号],
    ["申报日期", (d) => esc(d.header.申报日期), "nowrap", (d) => d.header.申报日期],
    ["海关编号", (d) => esc(d.header.海关编号), "nowrap", (d) => d.header.海关编号],
    ["商品", (d) => esc(goods(d)), "goods", goods],
    ["运抵国", (d) => esc(d.header.运抵国), "nowrap", (d) => d.header.运抵国],
    ["金额", (d) => esc(moneyText(d.totals)), "num", (d) => Object.entries(d.totals).map(([c, v]) => `${c} ${v.toFixed(2).padStart(16, "0")}`).join(" ")],
  ],
  stats(list) {
    const totals = {};
    for (const d of list) for (const [c, v] of Object.entries(d.totals)) totals[c] = (totals[c] || 0) + v;
    return Object.entries(totals).sort().map(([c, v]) => [`${c} 合计`, fmtMoney(v)]);
  },
  detail: (d) =>
    U.kvGrid({ 归档位置: d.归档位置, ...d.header }, ["归档位置", ...HEADER_SHOW], LABEL) +
    // 单据齐套情况：按取得先后固定列出全部类型，没有的灰色、不显示内容（只展示，不计入“需核对”）
    U.itemTable(FLOW.flatMap((t) => {
      const xs = d.单据.filter((x) => x.单据类型 === t);
      return xs.length ? xs : [{ 单据类型: t, 缺: true }];
    }), [
      ["单据", (x) => (x.缺 ? `<span class="tip">${esc(x.单据类型)}</span>` : esc(x.单据类型))],
      ["版式", (x) => esc(x.版式)], ["原文件名", (x) => esc(x.原文件名)], ["打包后", (x) => esc(x.归档位置)],
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
        const row = Object.fromEntries(SUMMARY_COLS.filter((k) => k in h).map((k) => [k, NUMERIC.has(k) ? toNum(h[k]) : h[k]]));
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
