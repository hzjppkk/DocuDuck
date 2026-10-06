#!/usr/bin/env node
/*
 * 样本精简：同一版式、同样情况的样本只留代表，其余移到别处（不删除），回归测试更快、覆盖面不变
 *   node scripts/pick-samples.js fapiao <发票PDF目录>                       预览：按版式列出保留哪些、可移出多少
 *   node scripts/pick-samples.js baoguan <报关单PDF目录> --move <目录>   把多余样本移到指定目录
 *
 * 做法：给每个样本提取一组特征（版式 + 票面上出现的各种情况），再挑尽量少的样本，使每个特征至少被一个样本覆盖。
 *   版式：PDF 生成软件、页宽、票种（内容不同、版式相同的样本算冗余，开票方不作为依据）
 *   发票：税率、负数行、规格型号、明细行数、附加信息、内嵌数据、名称 / 税号 / 号码被拆成多个文字块、表头斜杠、
 *         铁路票的退票费 / 无座、行程单的多航段（发票的情况按版式分别统计：同一种情况在不同版式里各留一份）
 *   报关单：商品项数、第二数量、单价总价折行、申报与法定单位不同、成交方式（这些按组合统计）；表头填了哪些字段；币制
 * 前提：已跑回归（check.js）确认程序正确，这里不判断识别对错（见 README 新增样本三步）。
 * 只保留能正确识别的样本：识别失败的 PDF（不是单据、没有文字层、文字乱码等）和非 PDF 文件一并移出（desktop.ini 等系统文件不动）。
 * 要增加判断依据，在 FEATURES 里加一条特征即可。
 */
import fs from "node:fs";
import path from "node:path";
import { loadPdfFile } from "./node-pdf.js";
import { parseDeclaration } from "../site/baoguan/parser.js";
import { parseInvoicePdf } from "../site/fapiao/parser.js";

/** 某个值能否在单个文字块中完整找到（忽略空格）；找不到说明票面上它被拆成了多块 */
const inOneToken = (tokens, v) => !v || tokens.some((s) => s.includes(String(v).replace(/\s/g, "")));

const CUSTOMS_HEAD = ["备案号", "运输工具名称", "提运单号", "许可证号", "批准文号", "运费", "保费", "杂费",
  "集装箱号", "随附单据", "标记唛码及备注", "境内货源地", "指运港（地区）"];

/** 每个工具返回 { family: 版式（用于汇总显示）, features: Map(特征 id → 显示名) } */
const FEATURES = {
  fapiao(pdf) {
    const { invoices } = parseInvoicePdf(pdf.pages, pdf.attachments);
    const features = new Map();
    let family;
    for (const inv of invoices) {
      family = [inv.版式, inv.发票类型, inv.特定业务, pdf.producer, pdf.creator, pdf.width].filter(Boolean).join(" | ");
      const its = inv.items;
      const flags = its.map((i) => `税率 ${i.税率 || "无"}`);
      flags.push(its.length > 5 ? "多行明细" : its.length > 1 ? "少行明细" : "单行明细");
      if (its.some((i) => i.金额 < 0)) flags.push("负数行");
      if (its.some((i) => i.规格型号)) flags.push("有规格型号");
      if (!its.some((i) => i.单价)) flags.push("无单价");
      if (its.some((i) => (i.项目名称 || "").length > 18)) flags.push("长项目名");
      if (inv.版式 === "增值税发票" && inv.附加信息.length) flags.push("附加信息");
      if (inv.附件数据) flags.push("内嵌数据");
      if (pdf.tokens.includes("/")) flags.push("表头斜杠");
      if (!inOneToken(pdf.tokens, inv.销售方名称) || !inOneToken(pdf.tokens, inv.购买方名称)) flags.push("名称拆分");
      if (!inOneToken(pdf.tokens, inv.销售方税号) || !inOneToken(pdf.tokens, inv.购买方税号)) flags.push("税号拆分");
      if (!inOneToken(pdf.tokens, inv.发票号码)) flags.push("号码拆分");
      if (inv.版式 === "铁路客票") {
        const trip = inv.附加信息[0] || {};
        flags.push(trip.费用类型 || "无费用类型");
        if (trip.车厢座位 === "无座") flags.push("无座");
      }
      if (inv.版式 === "航空客票" && its[0] && its[0].项目名称.includes("；")) flags.push("多航段");
      features.set(`版式#${family}`, "版式");
      for (const f of flags) features.set(`${family}#${f}`, f);
    }
    return { family, features };
  },

  baoguan(pdf) {
    const d = parseDeclaration(pdf.pages);
    const h = d.header;
    const family = [pdf.producer, pdf.creator, pdf.width, `${h.页数} 页`].filter(Boolean).join(" | ");
    const flags = new Set([d.items.length > 1 ? "多项" : "单项", h.贸易方式, h.成交方式 === "FOB" ? "FOB" : "CIF 类"]);
    for (const i of d.items) {
      for (const v of [i.单价, i.总价])
        if (v != null && ![String(v), v.toFixed(2), v.toFixed(4)].some((s) => pdf.tokens.includes(s))) flags.add("单价总价折行");
      if (i.第二数量) flags.add("第二数量");
      if (i.申报单位 !== i.法定单位) flags.add("申报与法定单位不同");
    }
    const item = [...flags].sort().join("+");
    const head = CUSTOMS_HEAD.filter((k) => h[k]).join("、");
    const cur = Object.keys(d.totals).sort().join("、");
    return {
      family,
      features: new Map([[`版式#${family}`, "版式"], [`商品#${item}`, `商品 ${item}`], [`表头#${head}`, `表头 ${head}`], [`币制#${cur}`, `币制 ${cur}`]]),
    };
  },
};

async function loadPdf(file) {
  const { doc, pages, attachments, close } = await loadPdfFile(file);
  try {
    const { info } = await doc.getMetadata();
    return {
      pages,
      attachments,
      producer: (info.Producer || "").slice(0, 20),
      creator: (info.Creator || "").slice(0, 12),
      width: Math.round(pages[0].width),
      tokens: pages.flatMap((p) => p.items.map((i) => i.str.replace(/\s/g, ""))).filter(Boolean),
    };
  } finally {
    close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [tool, dir] = args;
  const mi = args.indexOf("--move");
  const moveTo = mi > 0 ? args[mi + 1] : null;
  if (!FEATURES[tool] || !dir || (mi > 0 && !moveTo)) {
    console.error("用法: node scripts/pick-samples.js <baoguan|fapiao> <PDF目录> [--move 移出目录]");
    process.exit(2);
  }
  const all = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !/^(desktop\.ini|thumbs\.db)$/i.test(f)).sort();
  const files = all.filter((f) => /\.pdf$/i.test(f));
  const others = all.filter((f) => !/\.pdf$/i.test(f));
  const info = new Map();
  const failed = new Map(); // 文件 → 失败原因
  for (const f of files) {
    try {
      info.set(f, FEATURES[tool](await loadPdf(path.join(dir, f))));
    } catch (e) {
      failed.set(f, e.message);
    }
  }
  const keep = new Map(); // 文件 → 因它而覆盖的特征

  // 每次挑覆盖“尚未覆盖的特征”最多的样本，直到所有特征都被覆盖（并列时取文件名靠前的）
  const need = new Map([...info.values()].flatMap((x) => [...x.features]));
  while (need.size) {
    let best, gain = [];
    for (const [f, x] of info) {
      const g = [...x.features.keys()].filter((id) => need.has(id));
      if (g.length > gain.length) [best, gain] = [f, g];
    }
    keep.set(best, gain.map((id) => need.get(id)));
    gain.forEach((id) => need.delete(id));
  }

  // 按版式汇总
  const byFamily = new Map();
  for (const [f, x] of info) byFamily.set(x.family, [...(byFamily.get(x.family) || []), f]);
  for (const [family, list] of [...byFamily].sort((a, b) => b[1].length - a[1].length)) {
    const kept = list.filter((f) => keep.has(f));
    console.log(`\n${family}　保留 ${kept.length} / ${list.length}`);
    for (const f of kept) console.log(`  ✓ ${f}\n      ${keep.get(f).join("、")}`);
  }
  if (failed.size) console.log("\n识别失败，移出：");
  for (const [f, msg] of failed) console.log(`  ✗ ${f}\n      ${msg}`);
  if (others.length) console.log(`\n非 PDF 文件，移出：\n${others.map((f) => `  ✗ ${f}`).join("\n")}`);

  const drop = [...files.filter((f) => !keep.has(f)), ...others];
  console.log(`\n共 ${all.length} 个文件：保留 ${keep.size}，可移出 ${drop.length}（重复 ${info.size - keep.size}，识别失败 ${failed.size}，非 PDF ${others.length}）`);
  if (!moveTo) return console.log("预览，未移动文件；加 --move <目录> 执行移出");
  fs.mkdirSync(moveTo, { recursive: true });
  for (const f of drop) fs.renameSync(path.join(dir, f), path.join(moveTo, f));
  console.log(`已移到 ${moveTo}`);
}

main();
