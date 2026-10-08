/* 发票整理：页面配置 + 二维码核对（通用框架见 common/ui.js）。jsQR 只发布 UMD 版，由 fapiao/index.html 用普通 <script> 加载为全局变量 */
import { OPS } from "../vendor/pdfjs/pdf.min.mjs";
import * as U from "../common/ui.js";
import * as P from "./parser.js";
import { round2 } from "../common/text.js";

const { esc, fmtMoney } = U;

/** 购买方白名单（同目录 whitelist.ini）：读不到（文件不存在或请求失败）按未配置处理；为空或格式不标准时不校验 */
const whitelist = fetch("whitelist.ini", { cache: "no-store" })
  .then((r) => (r.ok ? r.text() : ""), () => "")
  .then((text) => ({ ...P.parseWhitelist(text), text }));
// 鼠标移到图标上显示白名单内容（去掉注释和空行）
const wlLines = (w) => w.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n");
const WL_NOTICE = {
  ok: (w) => [`购买方白名单已启用（${w.entries.length} 家）`, "ok", wlLines(w)],
  empty: () => ["未配置购买方白名单（fapiao/whitelist.ini），不校验购买方", ""],
  invalid: (w) => [`购买方白名单${w.message}，本次不校验购买方`, "warn", wlLines(w)],
};

/** 识别发票所在页的二维码并与票面核对，不一致的写入 inv.issues；识别不到、或不是税务二维码（如财政电子票据的查验网址，没有统一格式）时不核对 */
async function attachQr(doc, inv) {
  const qr = P.parseQr(await decodeQr(doc, inv.pageIndex));
  if (qr) P.applyQr(inv, qr);
}

/** 二维码是页面内嵌的正方形图片：取出页面上的图片逐张识别，不渲染页面 */
async function decodeQr(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const ops = await page.getOperatorList();
  for (const [i, fn] of ops.fnArray.entries()) {
    if (fn !== OPS.paintImageXObject) continue;
    const id = ops.argsArray[i][0];
    const img = await new Promise((res) => (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, res));
    if (!img || !img.bitmap || img.width !== img.height) continue;
    const size = img.width;
    const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img.bitmap, 0, 0);
    const code = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: "dontInvert" });
    if (code && code.data) return code.data;
  }
  return null;
}

const shortType = (t) => (t || "").replace(/^电子发票\((.+)\)$/, "$1").replace(/^增值税/, "").replace(/\(电子\)$/, "");
const itemSummary = (items) => {
  const names = [...new Set(items.map((i) => i.项目名称.replace(/^\*[^*]+\*/, "")).filter(Boolean))];
  return names.slice(0, 2).join("、") + (names.length > 2 ? ` 等${names.length}项` : "");
};

const FIELDS_SHOW = ["发票类型", "特定业务", "发票号码", "开票日期", "校验码", "购买方名称", "购买方税号", "购买方地址电话", "购买方开户行及账号",
  "销售方名称", "销售方税号", "销售方地址电话", "销售方开户行及账号", "合计金额", "合计税额", "价税合计", "税率", "开票人", "收款人", "复核人", "备注", "附加信息文本"];
// Excel 列。金额为不含税金额（表头显示“不含税金额”），价税合计 = 金额 + 税额；核对结果不导出。
// 发票号码 = 发票代码 + 发票号码（见 P.fullNo），所以没有单独的发票代码列。
// 汇总表按票面从上到下（税务总局公告 2024 年第 11 号的票面要素）：票头 → 购买方 → 销售方 → 明细（单位、数量、金额、税率、税额）
// → 价税合计 → 备注（含附加信息：特定业务信息、财政票据的其他信息）→ 开票人等，原文件名最后
const SUMMARY_COLS = ["开票日期", "发票号码", "票据类别", "发票类型", "特定业务", "购买方名称", "购买方税号", "销售方名称", "销售方税号",
  "项目名称", "单位", "数量", "金额", "税率", "税额", "价税合计", "备注", "开票人", "收款人", "复核人", "原文件名"];
// 明细表：与汇总表相同次序的发票列，其后为行号、其余标准列、按票种分组的专有列（通行费；财政票据，命名见 parser.js 的 headerColumns），原文件名最后
const ITEM_COLS = ["销售方名称", "项目名称", "数量", "单位", "金额", "税额", "价税合计", "税率", "开票日期", "发票号码",
  "行号", "规格型号", "单价", "车牌号", "车辆类型", "通行日期起", "通行日期止", "项目编码", "标准", "备注", "原文件名"];
const LABELS = { 金额: "不含税金额", 销售方税号: "销售方统一社会信用代码/纳税人识别号", 购买方税号: "购买方统一社会信用代码/纳税人识别号" };
const pick = (obj, cols) => Object.fromEntries(cols.map((k) => [k, obj[k]]));

// 全局入口供调试 / 自动化测试使用
window.__invoiceApp = U.createApp({
  title: "发票整理工具",
  sub: "把 PDF 电子发票、财政电子票据拖进来，自动提取票面信息、核对二维码，一键导出 Excel 台账。",
  icon: "🧾",
  dropTitle: "把 PDF 发票 / 票据（或整个文件夹）拖到这里",
  zipTitle: "按发票内容重新命名 PDF，打包下载（原文件不会被修改）",
  search: "搜索 销售方 / 发票号码 / 项目 / 税号…",
  footer: "支持数电发票的全部 6 个类别（专票、普票、铁路电子客票、航空运输电子客票行程单、机动车 / 二手车销售统一发票）及 19 类特定业务发票、旧版增值税电子发票，以及财政电子票据（非税收入、医疗收费、通行费等）；字段依据国家税务总局公告 2024 年第 11 号。",
  unit: "张",
  allLabel: "发票 / 票据",
  dupNote: "发票号码相同",
  zipName: "发票_规范命名.zip",

  async load(file) {
    const { doc, pages, attachments, close } = await U.loadPdf(file);
    try {
      const { invoices } = P.parseInvoicePdf(pages, attachments);
      const wl = await whitelist;
      for (const inv of invoices) {
        await attachQr(doc, inv); // 二维码核对会重算 issues，白名单结果须在其后追加
        if (wl.status === "ok") inv.issues.push(...P.checkWhitelist(inv, wl.entries));
      }
      return invoices;
    } finally {
      close();
    }
  },
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
          行号: n + 1, 开票日期: i.开票日期, 发票号码: P.fullNo(i), 销售方名称: i.销售方名称, 原文件名: i.原文件名,
        }, ITEM_COLS)));
        for (const s of i.issues) issues.push({ 开票日期: i.开票日期, 发票号码: P.fullNo(i), 销售方名称: i.销售方名称, 问题: s, 原文件名: i.原文件名 });
      }
      return [
        { name: "发票汇总", rows: summary, cols: SUMMARY_COLS, labels: LABELS, widths: { 发票号码: 24, 购买方名称: 28, 销售方名称: 28, 购买方税号: 22, 销售方税号: 22,
          项目名称: 30, 备注: 40, 原文件名: 40 } },
        { name: "发票明细", rows: detail, cols: ITEM_COLS, labels: LABELS, widths: { 发票号码: 24, 销售方名称: 28, 项目名称: 30, 规格型号: 14, 原文件名: 40 } },
        { name: "需核对", rows: issues, cols: ["开票日期", "发票号码", "销售方名称", "问题", "原文件名"], widths: { 发票号码: 24, 销售方名称: 28, 问题: 60, 原文件名: 50 } },
      ];
    },
  },
});

whitelist.then((w) => U.notice(...WL_NOTICE[w.status](w)));
