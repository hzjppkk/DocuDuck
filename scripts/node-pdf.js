/*
 * 脚本共用：在 Node 中读取 PDF（check.js），解析逻辑与网页相同（site/common/pdf.js）；
 * parseInvoices 同网页解析发票并核对二维码
 * pdf.js 用官方为 Node 提供的 legacy 版（标准版用到 Uint8Array.toHex 等 Node 尚未支持的新特性）；
 * 用 require.resolve 定位，兼容 NODE_PATH。CMap 等资源直接读 node_modules 中的目录。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadPdf } from "../site/common/pdf.js";
import { parseInvoicePdf, parseQr, applyQr } from "../site/fapiao/parser.js";

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const dir = path.dirname(require.resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");
const OPTIONS = { cMapUrl: `${dir}/cmaps/`, standardFontDataUrl: `${dir}/standard_fonts/`, wasmUrl: `${dir}/wasm/`, iccUrl: `${dir}/iccs/` };

/** 返回 { doc, pages, attachments, close }，用完调用 close() */
export const loadPdfFile = (file) => loadPdf(pdfjs, new Uint8Array(fs.readFileSync(file)), OPTIONS);

/** 解析发票并核对二维码（同 site/fapiao/app.js 的 load，不含白名单）；二维码可能补上发票代码，影响规范命名 */
export async function parseInvoices(doc, pages, attachments) {
  const { invoices } = parseInvoicePdf(pages, attachments);
  for (const inv of invoices) {
    const qr = parseQr(await decodeQr(doc, inv.pageIndex));
    if (qr) applyQr(inv, qr);
  }
  return invoices;
}

const jsQR = require("jsqr");
const { OPS, ImageKind } = pdfjs;

/**
 * 识别某页二维码，取图方式同网页（site/fapiao/app.js 的 decodeQr）；Node 没有 OffscreenCanvas，
 * pdf.js 给的是原始像素（ImageKind：1 位灰度 / RGB / RGBA），转成 RGBA 后交给 jsQR
 */
async function decodeQr(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const ops = await page.getOperatorList();
  for (const [i, fn] of ops.fnArray.entries()) {
    if (fn !== OPS.paintImageXObject) continue;
    const id = ops.argsArray[i][0];
    const img = await new Promise((res) => (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, res));
    if (!img || !img.data || img.width !== img.height) continue;
    const code = jsQR(toRgba(img), img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code && code.data) return code.data;
  }
  return null;
}

function toRgba({ width: w, height: h, kind, data }) {
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  if (kind === ImageKind.RGBA_32BPP) out.set(data.subarray(0, w * h * 4));
  else if (kind === ImageKind.RGB_24BPP) {
    for (let i = 0; i < w * h; i++) out.set(data.subarray(i * 3, i * 3 + 3), i * 4);
  } else {
    // 1 位灰度：每行按字节对齐，位为 1 是白
    const stride = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if ((data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) continue;
        out.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
      }
  }
  return out;
}
