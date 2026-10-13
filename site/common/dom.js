/* 共用：页面小工具（转义、金额格式、出错信息、提示、进度、按钮忙碌），ui.js、archive.js 使用 */

const $ = (s) => document.querySelector(s);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMoney = (v) => (v == null || v === "" ? "" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function friendlyError(err) {
  if (err && err.name === "PasswordException") return "PDF 设置了密码，无法读取";
  if (err && err.name === "InvalidPDFException") return "文件已损坏，或不是有效的 PDF";
  return (err && err.message) || String(err);
}

let toastTimer;
/** 底部提示，显示 5 秒 */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}
/** 页头提示行（如白名单状态）；level：ok / warn / 空（灰色） */
const notice = (msg, level = "") => {
  const n = $("#notice");
  n.innerHTML = `<span class="notice-icon">📋</span> ${esc(msg)}`;
  n.className = `notice ${level}`;
  n.hidden = !msg;
};
const progress = (msg) => { const p = $("#progress"); p.hidden = !msg; p.textContent = msg || ""; };
/** 按钮执行期间禁用，结束后清掉进度 */
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; progress(""); } };

export { $, esc, fmtMoney, friendlyError, toast, notice, progress, busy };
