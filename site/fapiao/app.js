/* 发票整理：页面配置 + 二维码核对（通用框架见 common/ui.js）。jsQR 只发布 UMD 版，由 fapiao/index.html 用普通 <script> 加载为全局变量 */
import { OPS } from "../vendor/pdfjs/pdf.min.mjs";
import * as U from "../common/ui.js";
import { findQr } from "../common/pdf.js";
import * as P from "./parser.js";
import { round2, brief } from "../common/text.js";

const { esc, fmtMoney } = U;

/** 购买方白名单（scripts/config.ini 的 [发票购买方白名单]，由 serve.py 提供）：读不到（没有 serve.py 或请求失败）按未配置处理；为空或格式不标准时不校验 */
const whitelist = fetch("../api/whitelist", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : {}), () => ({}))
  .then((j) => j.text || "", () => "")
  .then((text) => ({ ...P.parseWhitelist(text), text }));
// 鼠标移到图标上显示白名单内容（去掉注释和空行）
const wlLines = (w) => w.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n");
const WL_NOTICE = {
  ok: (w) => [`购买方白名单已启用（${w.entries.length} 家）`, "ok", wlLines(w)],
  empty: () => ["未配置购买方白名单（scripts/config.ini），不校验购买方", ""],
  invalid: (w) => [`购买方白名单${w.message}，本次不校验购买方`, "warn", wlLines(w)],
};

/** 浏览器里 pdf.js 给的图片是 bitmap：画到画布上取像素交给 jsQR（取图见 common/pdf.js findQr） */
function decodeImage(img) {
  if (!img.bitmap) return null;
  const size = img.width;
  const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img.bitmap, 0, 0);
  const code = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: "dontInvert" });
  return code && code.data;
}

const shortType = (t) => (t || "").replace(/^电子发票\((.+)\)$/, "$1").replace(/^增值税/, "").replace(/\(电子\)$/, "");
const itemSummary = (items) => brief(items.map((i) => i.项目名称.replace(/^\*[^*]+\*/, "")), 2, "项");

const FIELDS_SHOW = ["发票类型", "特定业务", "发票号码", "开票日期", "校验码", "购买方名称", "购买方税号", "购买方地址电话", "购买方开户行及账号",
  "销售方名称", "销售方税号", "销售方地址电话", "销售方开户行及账号", "合计金额", "合计税额", "价税合计", "税率", "开票人", "收款人", "复核人", "备注", "附加信息文本"];
// Excel 列。金额为不含税金额（表头显示“不含税金额”），价税合计 = 金额 + 税额；核对结果不导出。
// 发票号码 = 发票代码 + 发票号码（见 P.fullNo），所以没有单独的发票代码列。
// 汇总表按票面从上到下（税务总局公告 2024 年第 11 号的票面要素）：票头 → 购买方 → 销售方 → 明细（单位、数量、金额、税率、税额）
// → 价税合计 → 备注（含附加信息：特定业务信息、财政票据的其他信息）→ 开票人等，原文件名最后
const SUMMARY_COLS = ["开票日期", "发票号码", "票据类别", "发票类型", "特定业务", "购买方名称", "购买方税号", "销售方名称", "销售方税号",
  "项目名称", "单位", "数量", "金额", "税率", "税额", "价税合计", "备注", "开票人", "收款人", "复核人", "原文件名"];
// 明细表：销售方、行号、明细金额，再到日期号码。列顺序为自定义，不必与汇总表（按票面要素）一致，表头名称一致；
// 规格型号、单价、通行费和财政票据的专有列不导出
const ITEM_COLS = ["销售方名称", "行号", "项目名称", "数量", "单位", "价税合计", "金额", "税额", "税率", "开票日期", "发票号码"];
const LABELS = { 金额: "不含税金额", 销售方税号: "销售方统一社会信用代码/纳税人识别号", 购买方税号: "购买方统一社会信用代码/纳税人识别号" };
const pick = (obj, cols) => Object.fromEntries(cols.map((k) => [k, obj[k]]));

// 全局入口供调试 / 自动化测试使用
window.__invoiceApp = U.createApp({
  title: "发票整理工具",
  sub: "把 PDF 电子发票、财政电子票据拖进来，自动提取票面信息、核对二维码，一键导出 Excel 台账。",
  icon: "🧾",
  dropTitle: "把 PDF 发票 / 票据（或整个文件夹）拖到这里",
  zipTitle: "按发票内容重新命名 PDF，打包下载",
  search: "搜索 销售方 / 发票号码 / 项目 / 税号…",
  footer: "支持数电发票的全部 6 个类别（专票、普票、铁路电子客票、航空运输电子客票行程单、机动车 / 二手车销售统一发票）及 19 类特定业务发票、旧版增值税电子发票，以及财政电子票据（非税收入、医疗收费、通行费等）；字段依据国家税务总局公告 2024 年第 11 号。",
  unit: "张",
  allLabel: "发票 / 票据",
  zipName: "发票_规范命名.zip",

  // 一个 PDF 有多张发票时，各自切出所在的页（U.withPdf）
  load: (file) => U.withPdf(file, async ({ doc, pages, attachments }) =>
    P.parseAndCheck(pages, attachments, (inv) => findQr(OPS, doc, inv.pageIndex, decodeImage), await whitelist)),
  key: (i) => i.发票号码 && `${i.发票代码 || ""}#${i.发票号码}`,
  sortKey: (i) => (i.开票日期 || "") + P.fullNo(i),
  hay: (i) => [P.fullNo(i), i.销售方名称, i.购买方名称, i.销售方税号, i.购买方税号, i.备注, i.附加信息文本, ...i.items.map((x) => x.项目名称)].join(" "),
  fileName: (i) => i.suggestedName,

  // [表头, 显示, 样式, 排序取值]
  columns: [
    ["开票日期", (i) => esc(i.开票日期), "nowrap", (i) => i.开票日期],
    ["发票 / 票据号码", (i) => esc(P.fullNo(i)), "nowrap mono", (i) => P.fullNo(i)],
    ["类型", (i) => esc(shortType(i.发票类型)) + (i.特定业务 ? `<br><span class="tip">${esc(i.特定业务)}</span>` : ""), "nowrap", (i) => shortType(i.发票类型) + i.特定业务],
    ["销售方", (i) => esc(i.销售方名称 || "—"), "goods", (i) => i.销售方名称],
    ["项目", (i) => esc(itemSummary(i.items)), "goods", (i) => itemSummary(i.items)],
    ["价税合计", (i) => fmtMoney(i.价税合计), "num", (i) => i.价税合计],
  ],
  stats: (list) => [["价税合计", fmtMoney(list.reduce((s, i) => s + (i.价税合计 || 0), 0))]],
  detail: (i) =>
    U.kvGrid({ ...i, 发票号码: P.fullNo(i) }, FIELDS_SHOW, { 附加信息文本: "附加信息" }) +
    U.itemTable(i.items, [
      ["行", (x, n) => n + 1],
      ["项目名称", (x) => esc(x.项目名称)],
      ["规格型号", (x) => esc(x.规格型号)],
      ["单位", (x) => esc(x.单位)],
      ["数量", (x) => esc(x.数量 ?? ""), "num"],
      ["单价", (x) => esc(x.单价 ?? ""), "num"],
      ["金额", (x) => fmtMoney(x.金额), "num"],
      ["税率", (x) => esc(x.税率)],
      ["税额", (x) => fmtMoney(x.税额), "num"],
    ]),

  excel: {
    prefix: "发票汇总",
    sheets(list) {
      const summary = [], detail = [], issues = [];
      for (const i of list) {
        const one = i.items.length === 1 ? i.items[0] : { 数量: "见发票明细" }; // 单位、数量只在只有一行明细时填
        summary.push(pick({
          ...i, 项目名称: [...new Set(i.items.map((x) => x.项目名称))].join("、"), 单位: one.单位, 数量: one.数量,
          金额: i.合计金额, 税额: i.合计税额, 发票号码: P.fullNo(i), 备注: [i.备注, i.附加信息文本].filter(Boolean).join("；"),
        }, SUMMARY_COLS));
        i.items.forEach((x, n) => detail.push(pick({
          ...x, 价税合计: round2(x.金额 + (x.税额 || 0)),
          行号: n + 1, 开票日期: i.开票日期, 发票号码: P.fullNo(i), 销售方名称: i.销售方名称,
        }, ITEM_COLS)));
        for (const s of i.issues) issues.push({ 开票日期: i.开票日期, 发票号码: P.fullNo(i), 销售方名称: i.销售方名称, 问题: s, 原文件名: i.原文件名 });
      }
      return [
        { name: "发票汇总", rows: summary, cols: SUMMARY_COLS, labels: LABELS, widths: { 发票号码: 24, 购买方名称: 28, 销售方名称: 28, 购买方税号: 22, 销售方税号: 22,
          项目名称: 30, 备注: 40, 原文件名: 40 } },
        { name: "发票明细", rows: detail, cols: ITEM_COLS, labels: LABELS, widths: { 发票号码: 24, 销售方名称: 28, 项目名称: 30 } },
        { name: "需核对", rows: issues, cols: ["开票日期", "发票号码", "销售方名称", "问题", "原文件名"], widths: { 发票号码: 24, 销售方名称: 28, 问题: 60, 原文件名: 50 } },
      ];
    },
  },
});

whitelist.then((w) => U.notice(...WL_NOTICE[w.status](w)));
