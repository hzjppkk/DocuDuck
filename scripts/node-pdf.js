/*
 * 脚本共用：在 Node 中读取 PDF（check.js、pick-samples.js），解析逻辑与网页相同（site/common/pdf.js）
 * pdf.js 用官方为 Node 提供的 legacy 版（标准版用到 Uint8Array.toHex 等 Node 尚未支持的新特性）；
 * 用 require.resolve 定位，兼容 NODE_PATH。CMap 等资源直接读 node_modules 中的目录。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadPdf } from "../site/common/pdf.js";

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const dir = path.dirname(require.resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");
const OPTIONS = { cMapUrl: `${dir}/cmaps/`, standardFontDataUrl: `${dir}/standard_fonts/`, wasmUrl: `${dir}/wasm/`, iccUrl: `${dir}/iccs/` };

/** 返回 { doc, pages, attachments, close }，用完调用 close() */
export const loadPdfFile = (file) => loadPdf(pdfjs, new Uint8Array(fs.readFileSync(file)), OPTIONS);
