/* 单据核验页：发票、报关单证一起识别，分报关单、发票、无法识别三个视图（视图见 views.js，框架见 common/ui.js）。
 * jsQR 只发布 UMD 版，由 index.html 用普通 <script> 加载为全局变量 */
import { OPS } from "../vendor/pdfjs/pdf.min.mjs";
import * as U from "../common/ui.js";
import { findQr } from "../common/pdf.js";
import { parseFile } from "./parser.js";
import { parseWhitelist } from "./invoice.js";
import { customsView, invoiceView, errorView, key, hay, ocr } from "./views.js";

/** 购买方白名单（scripts/config.ini 的 [发票购买方白名单]，由 serve.py 提供，只核对发票）：读不到按未配置处理；为空或格式不标准时不校验 */
const whitelist = fetch("../api/whitelist", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : {}), () => ({}))
  .then((j) => j.text || "", () => "")
  .then((text) => ({ ...parseWhitelist(text), text }));
const WL_NOTICE = {
  ok: (w) => [`购买方白名单已启用（${w.entries.length} 家）`, "ok"],
  empty: () => ["未配置购买方白名单（scripts/config.ini），不校验购买方", ""],
  invalid: (w) => [`购买方白名单${w.message}，本次不校验购买方`, "warn"],
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

// 全局入口供调试 / 自动化测试使用
window.__app = U.createApp({
  title: "单据核验",
  sub: "支持发票、财政电子票据、报关单证。",
  icon: "📄",
  dropTitle: "把 PDF（或整个文件夹）拖到这里",
  tip: "把提单的文件名改成提运单号，即可自动归入对应的报关单。",
  search: "搜索 合同号 / 海关编号 / 提运单号 / 发票号码 / 销售方 / 品名…",
  // 逐页识别、合订的按页拆开（parser.js），拆出的几份各自切出所在的页（U.withPdf）
  load: (file) => U.withPdf(file, async ({ doc, pages, attachments }) =>
    parseFile(pages, attachments, file.name, { qrOf: (i) => findQr(OPS, doc, i, decodeImage), wl: await whitelist })),
  key,
  hay,
  ocr,
  views: [customsView, invoiceView, errorView],
});

whitelist.then((w) => U.notice(...WL_NOTICE[w.status](w)));
