/* 报关单整理：页面配置（通用框架见 common/ui.js） */
import * as U from "../common/ui.js";
import { parseDeclaration } from "./parser.js";

const { esc, fmtMoney, fmtDate } = U;

const goodsName = (items) => {
  const names = [...new Set(items.map((i) => i.商品名称))];
  return names.slice(0, 3).join("、") + (names.length > 3 ? ` 等${names.length}种` : "");
};
const moneyText = (totals) => Object.entries(totals).map(([c, v]) => `${c} ${fmtMoney(v)}`).join(" + ");

const HEADER_SHOW = ["海关编号", "预录入编号", "出口日期", "申报日期", "出口口岸", "境内收发货人", "生产销售单位",
  "运输方式", "运输工具名称", "提运单号", "贸易方式", "征免性质", "结汇方式", "许可证号", "运抵国（地区）", "指运港（地区）",
  "境内货源地", "批准文号", "成交方式", "运费", "保费", "杂费", "合同协议号", "件数", "包装种类", "毛重（千克）",
  "净重（千克）", "集装箱号", "随附单据", "标记唛码及备注", "打印日期"];
const SUMMARY_COLS = ["出口日期", "申报日期", "海关编号", "预录入编号", "出口口岸", "运抵国（地区）",
  "指运港（地区）", "贸易方式", "成交方式", "合同协议号", "商品", "商品项数", "币制", "总价合计", "运费", "保费", "杂费",
  "件数", "包装种类", "毛重（千克）", "净重（千克）", "运输方式", "运输工具名称", "提运单号", "集装箱号", "境内收发货人",
  "生产销售单位", "境内货源地", "许可证号", "征免性质", "结汇方式", "随附单据", "标记唛码及备注", "页数", "打印日期",
  "原文件名"];
const ITEM_COLS = ["出口日期", "海关编号", "合同协议号", "运抵国（地区）", "成交方式", "序号", "商品编号", "商品名称",
  "规格型号", "法定数量", "法定单位", "第二数量", "第二单位", "申报数量", "申报单位", "目的国", "目的国代码", "单价", "总价", "币制", "征免", "原文件名"];
const NUMERIC = new Set(["件数", "毛重（千克）", "净重（千克）"]);
const toNum = (v) => (v !== "" && v != null && !isNaN(+v) ? +v : v);

// 全局入口供调试 / 自动化测试使用
window.__customsApp = U.createApp({
  title: "报关单整理工具",
  sub: "把出口报关单 PDF 拖进来，自动提取信息，一键导出 Excel 台账。",
  icon: "📄",
  dropTitle: "把报关单 PDF（或整个文件夹）拖到这里",
  zipTitle: "按报关单内容重新命名 PDF，打包下载（原文件不会被修改）",
  search: "搜索 品名 / 国家 / 合同号 / 海关编号…",
  footer: "适用于「中华人民共和国海关出口货物报关单」打印版 PDF。",
  unit: "份",
  allLabel: "报关单",
  dupNote: "海关编号相同",
  zipName: "报关单_规范命名.zip",

  async load(file) {
    const { pages, close } = await U.loadPdf(file);
    close();
    return [parseDeclaration(pages)];
  },
  key: (d) => d.header.海关编号,
  sortKey: (d) => (d.header.出口日期 || "") + (d.header.海关编号 || ""),
  hay: (d) => [d.header.海关编号, d.header.合同协议号, d.header["运抵国（地区）"], d.header.提运单号, ...d.items.flatMap((i) => [i.商品名称, i.商品编号])].join(" "),
  fileName: (d) => d.suggestedName,

  // [表头, 显示, 样式, 排序取值]；金额按「币种 + 金额」排序（同币种内按数值）
  columns: [
    ["出口日期", (d) => esc(fmtDate(d.header.出口日期)), "nowrap", (d) => d.header.出口日期],
    ["海关编号", (d) => esc(d.header.海关编号), "nowrap", (d) => d.header.海关编号],
    ["商品", (d) => esc(goodsName(d.items)), "goods", (d) => goodsName(d.items)],
    ["运抵国", (d) => esc(d.header["运抵国（地区）"]), "nowrap", (d) => d.header["运抵国（地区）"]],
    ["合同协议号", (d) => esc(d.header.合同协议号), "", (d) => d.header.合同协议号],
    ["成交方式", (d) => esc(d.header.成交方式), "", (d) => d.header.成交方式],
    ["金额", (d) => esc(moneyText(d.totals)), "num", (d) => Object.entries(d.totals).map(([c, v]) => `${c} ${v.toFixed(2).padStart(16, "0")}`).join(" ")],
  ],
  stats(list) {
    const totals = {};
    for (const d of list) for (const [c, v] of Object.entries(d.totals)) totals[c] = (totals[c] || 0) + v;
    return Object.entries(totals).sort().map(([c, v]) => [`${c} 合计`, fmtMoney(v)]);
  },
  detail: (d) =>
    U.kvGrid(d.header, HEADER_SHOW) +
    U.itemTable(d.items, [
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
    ]),

  excel: {
    prefix: "报关单汇总",
    sheets(list) {
      const summary = [], detail = [], issues = [];
      for (const d of list) {
        const h = d.header;
        const curs = Object.keys(d.totals);
        const base = { 出口日期: fmtDate(h.出口日期), 海关编号: h.海关编号, 合同协议号: h.合同协议号, "运抵国（地区）": h["运抵国（地区）"], 成交方式: h.成交方式, 原文件名: d.原文件名 };
        const row = Object.fromEntries(SUMMARY_COLS.filter((k) => k in h).map((k) => [k, NUMERIC.has(k) ? toNum(h[k]) : h[k]]));
        summary.push(Object.assign(row, base, {
          申报日期: fmtDate(h.申报日期),
          商品: [...new Set(d.items.map((i) => i.商品名称))].join("、"), 商品项数: d.items.length,
          币制: curs.join("、"), 总价合计: curs.length === 1 ? d.totals[curs[0]] : moneyText(d.totals),
        }));
        for (const i of d.items) detail.push({ ...i, ...base });
        for (const s of d.issues) issues.push({ 出口日期: fmtDate(h.出口日期), 海关编号: h.海关编号, 问题: s, 原文件名: d.原文件名 });
      }
      return [
        { name: "报关单汇总", rows: summary, cols: SUMMARY_COLS, widths: { 商品: 24, 原文件名: 40, 集装箱号: 24, 境内收发货人: 26, 生产销售单位: 26 } },
        { name: "商品明细", rows: detail, cols: ITEM_COLS, widths: { 商品名称: 20, 规格型号: 40, 原文件名: 40 } },
        { name: "需核对", rows: issues, cols: ["出口日期", "海关编号", "问题", "原文件名"], widths: { 海关编号: 22, 问题: 60, 原文件名: 50 } },
      ];
    },
  },
});
