/*
 * 共用：文本块（带坐标）处理工具，供各解析器使用
 * ES 模块，浏览器和 Node 共用。
 */

// 只把康熙部首 / 部首补充区字符（如“⼦”）规范成常用汉字；不做全量 NFKC（会改动各类全角标点），括号半角化由 halfBrackets 按需处理
const nk = (s) => (s || "").replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (c) => c.normalize("NFKC"));
const squash = (s) => nk(s).replace(/\s+/g, "");
/** 全角括号 （）［］｛｝ → 半角；发票同一名称常混用全角 / 半角括号，统一后比对、查重才一致 */
const HALF = { "（": "(", "）": ")", "［": "[", "］": "]", "｛": "{", "｝": "}" };
const halfBrackets = (s) => s.replace(/[（）［］｛｝]/g, (c) => HALF[c]);
const round2 = (x) => Math.round(x * 100) / 100;

/** pdf.js 文本块 {str,x,y,w} → {s,x,y,w}，去掉空白块 */
const prepare = (items) =>
  items.map((i) => ({ s: nk(i.str).trim(), x: i.x, y: i.y, w: i.w || 0 })).filter((t) => t.s);

const sameRow = (a, b, tol = 4) => Math.abs(a.y - b.y) <= tol;
const cx = (t) => t.x + (t.w || 0) / 2;

/** 按 y 分行（容差 tol），每行按 x 排序，text 为同行文本块用 inline 连接 */
function groupLines(tokens, tol = 4, inline = "") {
  const lines = [];
  for (const t of tokens.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - t.y) <= tol) last.toks.push(t);
    else lines.push({ y: t.y, toks: [t] });
  }
  for (const l of lines) {
    l.toks.sort((a, b) => a.x - b.x);
    l.text = l.toks.map((t) => t.s).join(inline);
  }
  return lines;
}

/**
 * 多行拼接：行与行默认直接相连（中文折行），英文单词在折行处断开的补空格（上一行以字母、数字或 ' . 结尾，下一行以字母开头）；
 * inline 为同一行内文本块之间的连接符
 */
const joinText = (tokens, { tol = 4, sep = "", inline = "" } = {}) =>
  groupLines(tokens, tol, inline).map((l) => l.text)
    .reduce((acc, t) => (!acc ? t : acc + (sep || (/[A-Za-z0-9'.]$/.test(acc) && /^[A-Za-z]/.test(t) ? " " : "")) + t), "");

/** 取文本中的第一个数字（忽略 ¥ 和千分位） */
const toNum = (s) => {
  const m = /-?[\d,]*\.?\d+/.exec(squash(s).replace(/[¥￥]/g, ""));
  return m ? parseFloat(m[0].replace(/,/g, "")) : null;
};

/** 2026年9月1日 / 2026-09-01 / 20260901 → 2026-09-01 */
function normDate(s) {
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s || "") || /(\d{4})-?(\d{2})-?(\d{2})/.exec(s || "");
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

/** 生成合法的 PDF 文件名（“/” 改为 “&”，去掉 Windows 不允许的字符） */
const safeFileName = (raw) => raw.replace(/\//g, "&").replace(/[\\:*?"<>|\r\n]/g, "").slice(0, 180) + ".pdf";

export { squash, halfBrackets, round2, prepare, sameRow, cx, groupLines, joinText, toNum, normDate, safeFileName };
