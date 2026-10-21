/*
 * 共用：打开 PDF、提取带坐标的文字、读取内嵌附件、检查文字层；把一个 PDF 里的几份单据各自的页切成单独的文件；取二维码图片
 * ES 模块，浏览器（common/ui.js）和 Node（scripts/node-pdf.js）共用；pdf.js 及其资源地址由调用方传入：
 *   options = { cMapUrl, standardFontDataUrl, wasmUrl, iccUrl, worker? }
 */
import { partName } from "./text.js";

/**
 * 打开 → 提取文字 → 检查文字层 → 读取附件（data 为 Uint8Array）。
 * 返回 { doc, pages, attachments, close }，用完调用 close() 释放；出错时已自动释放。
 */
async function loadPdf(pdfjsLib, data, options) {
  const task = pdfjsLib.getDocument({ data, verbosity: 0, ...options });
  const close = () => task.destroy();
  try {
    const doc = await task.promise;
    const pages = await extractPages(doc);
    assertTextLayer(pages);
    return { doc, pages, attachments: await extractAttachments(doc), close };
  } catch (err) {
    close();
    throw err;
  }
}

/** 每页文本块 [{str, x, y, w}]，坐标为页面显示方向（按页面旋转换算），y 自上而下 */
async function extractPages(pdfDoc) {
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      width: vp.width,
      height: vp.height,
      items: tc.items
        .filter((i) => i.str && i.str.trim())
        .map((i) => {
          const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
          return { str: i.str, x, y, w: i.width };
        }),
    });
  }
  return pages;
}

/** PDF 内嵌的 XML 附件 [{name, text}]（如铁路电子客票内嵌的财政部 XBRL 数据）；没有附件时返回空数组 */
async function extractAttachments(pdfDoc) {
  const out = [];
  // getAttachments 返回 Map（键为附件 id），没有附件时为 null；内容需另行读取
  for (const [id, a] of (await pdfDoc.getAttachments()) || []) {
    const name = a.filename || id;
    const content = await pdfDoc.getAttachmentContent(id);
    if (!content) continue;
    const text = new TextDecoder("utf-8").decode(content);
    if (/\.xml$/i.test(name) || /^\s*<\?xml/.test(text)) out.push({ name, text });
  }
  return out;
}

/**
 * 没有文字层（扫描件、图片转 PDF）直接报不支持。扫描件上可能叠加了文字印章（如提单的“FREIGHT PREPAID”“ORIGIN”，约 30 字），
 * 也算没有；现有样本中正常文件最少的是电子委托（约 95 字），门槛取两者之间
 */
function assertTextLayer(pages) {
  const chars = pages.reduce((n, p) => n + p.items.reduce((m, i) => m + i.str.replace(/\s/g, "").length, 0), 0);
  if (chars < 60) throw Object.assign(new Error("不支持：PDF 没有文字层（扫描件或图片转换的 PDF）"), { code: "NO_TEXT" }); // code 供调用方区分扫描件
}

/**
 * 一个 PDF 含几份单据时（合订的报关资料、多张发票），按各份的 页（页号，从 0 起）切出单独的 PDF，
 * 记为该份的 文件（File，名为「原名（第 n 页）」，修改时间沿用原文件，重复时据此取较新的），供打包、提交、打开。
 * 分组规则由各工具的解析器决定
 */
async function cutParts(doc, file, items) {
  for (const d of items.filter((d) => d.页)) {
    const bytes = await doc.extractPages([{ document: null, includePages: d.页 }]);
    d.文件 = new File([bytes], partName(file.name, d.页), { type: "application/pdf", lastModified: file.lastModified });
  }
}

/**
 * 某页的二维码：二维码是页面内嵌的正方形图片，逐张交给 decode(图片) 识别（返回文字或 null），不渲染页面（渲染最耗时）。
 * 图片的像素格式浏览器和 Node 不同（bitmap / 原始像素），由调用方的 decode 处理。用到 pdf.js 未公开的 page.objs，升级须回归测试
 */
async function findQr(OPS, doc, pageIndex, decode) {
  const page = await doc.getPage(pageIndex + 1);
  const ops = await page.getOperatorList();
  for (const [i, fn] of ops.fnArray.entries()) {
    if (fn !== OPS.paintImageXObject) continue;
    const id = ops.argsArray[i][0];
    const img = await new Promise((res) => (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, res));
    if (!img || img.width !== img.height) continue;
    const text = decode(img);
    if (text) return text;
  }
  return null;
}

export { loadPdf, cutParts, findQr };
