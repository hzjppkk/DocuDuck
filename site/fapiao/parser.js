/*
 * 单据识别：发票专家（invoice.js）和报关单证专家（customs.js）合成一组，逐页识别一次，认出的专家直接解析，再归类。
 * 同一份单据的连续页合为一份：发票按号码（parseAndCheck 拆分）、报关单证按类型和报关单号；委托报关协议背面等续页、
 * 发票之后的清单页跟着前一份。识别出两份以上才拆，各带 页（页号，从 0 起），页面据此切出单独的文件。
 * 结果：发票记录（类别 发票，见 invoice.js）、报关单证（见 customs.js）、识别不出的 { 错误 }
 * ES 模块，浏览器（app.js）和 Node（scripts/check.js）共用；取二维码的方式由调用方提供
 */
import * as X from "../common/text.js";
import * as I from "./invoice.js";
import * as C from "./customs.js";

const invoice = (e) => ({ ...e, kind: "发票" });
const customs = (e) => ({ ...e, kind: "报关" });
/**
 * 全部专家，按顺序匹配，第一个认领的负责解析；kind 为所属类别，match 收到该类别的页面上下文（各文件的 pageContext）。
 * 特征明确的在前、最宽松的放最后：
 * 1. 有票种标题的发票（财政票据、客票、机动车、二手车、旧版、数电 / 增值税）：不会误认别的单据；数电发票备注里常写提单号
 *    （有时是英文 B/L），排在后面会被提运单认走
 * 2. 报关单证（提运单除外）：退税联、放行通知书在预填单前（预填单只认“出口货物报关单”字样，较宽）；
 *    Crystal 版放行通知书、勾选框的电子委托在各自的通用版前
 * 3. 只有“发票号码”字样的发票（增值税发票兜底）
 * 4. 提运单（最宽松）
 */
const EXPERTS = [
  ...[I.FISCAL, I.RAILWAY, I.AIR, I.VEHICLE, I.LABELED, I.LEGACY].map(invoice),
  invoice({ ...I.VAT, match: (c) => !!c.type }),
  ...[C.REFUND, C.RELEASE_CRYSTAL, C.RELEASE, C.PREFILL, C.ENTRUST_TICK_X, C.ENTRUST_STD_X, C.ENTRUST_PAPER, C.LAND_WAYBILL].map(customs),
  invoice(I.VAT),
  customs(C.BILL),
];

/**
 * 识别一页 → { ctx: { 发票, 报关 } 两类上下文, e: 认出的专家 | null, 续页 }。
 * 内嵌附件数据能认定票种的发票专家优先（票面标题可能拆碎识别不到），要求页面上有号码标签，避免认领清单等非票据页
 */
function recognize(page, xml) {
  const base = X.prepare(page.items); // 通用规整每页只做一次，两类上下文在它上面各自加工
  const ctx = { 发票: I.pageContext(base), 报关: C.pageContext(base) };
  if (C.isContinued(page)) return { ctx, e: null, 续页: true };
  const e = EXPERTS.find((x) => x.xml && xml.some(x.xml.match) && /(发票|票据|缴款书)号码/.test(ctx.发票.text))
    || EXPERTS.find((x) => x.match(ctx[x.kind]));
  return { ctx, e: e || null };
}

/**
 * 解析一个 PDF：pages 每页文本块，attachments 内嵌附件，name 原文件名；
 * qrOf(页号) → 二维码文字（发票核对用，可省略），wl：购买方白名单（parseWhitelist 的结果，可省略）。
 * 返回 [单据]，拆开的各带 页、原文件名为「原名（第 n 页）」；整份识别不出时抛错
 */
async function parseFile(pages, attachments, name, { qrOf = async () => null, wl } = {}) {
  const xml = I.parseAttachments(attachments);
  const info = pages.map((p) => recognize(p, xml));
  const segs = [];
  for (const [i, r] of info.entries()) {
    let kind = r.续页 ? "续页" : r.e?.kind ?? null, key = kind;
    if (kind === "报关") {
      try {
        r.doc = C.parseCustoms(r.e, [r.ctx.报关.T]); // 只有这一页的那份直接用它
        key = `${r.e.type}#${r.doc.header.海关编号 || ""}`;
      } catch {
        kind = key = r.e = null;
      }
    }
    const last = segs.at(-1);
    // 续页、发票之后识别不出的页（清单、附页）跟前一份；同一份报关单证的相邻页、相邻的发票页（按号码拆分由 parseAndCheck 做）合为一份
    if (last && (kind === "续页" || (kind === null && last.kind === "发票") || last.key === key)) last.pages.push(i);
    else segs.push({ kind: kind === "续页" ? null : kind, key, pages: [i] });
  }
  // 识别出两份以上才拆；否则整份按认出的那类解析（提运单 + 续页、只有一页被误认的保险单等不拆）
  const known = segs.filter((s) => s.kind);
  const parts = known.length > 1 ? segs : [{ kind: known[0]?.kind ?? null, pages: pages.map((_, i) => i) }];
  const out = [];
  for (const s of parts) {
    const rs = s.pages.map((i) => info[i]);
    try {
      if (s.kind === "发票") {
        // 别的类别认领的页按非发票页处理
        const ps = rs.map((r) => ({ ctx: r.ctx, e: r.e?.kind === "发票" ? r.e : null }));
        const invs = await I.parseAndCheck(ps, xml, (v) => qrOf(s.pages[v.pageIndex]), wl);
        for (const v of invs) out.push({ ...v, 类别: "发票", 页: (v.页 || ps.map((_, j) => j)).map((j) => s.pages[j]) });
      } else if (s.kind === "报关") {
        // 按首页认出的专家解析（整份时首页可能不是报关单证）
        const e = rs[0].e;
        if (e?.kind !== "报关") throw new Error("不是可识别的报关单证");
        out.push({ ...(rs.length === 1 && rs[0].doc ? rs[0].doc : C.parseCustoms(e, rs.map((r) => r.ctx.报关.T))), 页: s.pages });
      } else out.push({ 错误: "不是可识别的单据（发票、票据、报关单证）", 页: s.pages });
    } catch (e) {
      out.push({ 错误: e.message, 页: s.pages });
    }
  }
  if (out.length === 1 && out[0].页.length === pages.length) {
    const { 页, ...d } = out[0];
    if (d.错误) throw new Error(d.错误);
    return [{ ...d, 原文件名: name }];
  }
  return out.map((d) => ({ ...d, 原文件名: X.partName(name, d.页) }));
}

export { parseFile };
