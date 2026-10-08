#!/usr/bin/env node
/*
 * 回归测试 + 样本精简：批量解析目录（含子文件夹）中的 PDF，发票同网页一样核对二维码，报关资料同网页一样按报关单合并（一份报关单一行）
 *   node scripts/check.js baoguan <报关资料目录> [--json 输出.json]
 *   node scripts/check.js fapiao <发票PDF目录>   [--json 输出.json] [--move 移出目录]
 * 发票末尾预览样本精简（见 samples.js）；--move：确认回归结果无误后再加，把多余样本移到指定目录、保留的样本改为规范命名。
 * 报关资料按整套保留（关联要靠同一票货的各单据），不精简。
 */
import fs from "node:fs";
import path from "node:path";
import { loadPdfFile, parseInvoices } from "./node-pdf.js";
import { listSamples, sampleOf, prune } from "./samples.js";
import { parseCustomsPdf, mergeDocs } from "../site/baoguan/parser.js";
import * as P from "../site/fapiao/parser.js";

const WL_FILE = path.join(import.meta.dirname, "../site/fapiao/whitelist.ini");
const wl = P.parseWhitelist(fs.existsSync(WL_FILE) ? fs.readFileSync(WL_FILE, "utf8") : "");

const TOOLS = {
  baoguan: {
    parse: async (doc, pages, attachments, file) => [{ ...parseCustomsPdf(pages), 原文件名: path.basename(file) }],
    merge: (docs, failed) => mergeDocs(docs, failed).map((g) => g.data),
    line: (d) => `${d.归档位置} [${d.单据.map((x) => x.版式).join("、")}]${d.缺少.length && d.单据类型 === "报关单" ? ` 缺 ${d.缺少.join("、")}` : ""}`,
    unit: "份报关单（含未匹配的单据）",
  },
  fapiao: {
    // 与网页一致：先核对二维码（会重算 issues），再在 site/fapiao/whitelist.ini 存在且格式标准时校验购买方
    async parse(doc, pages, attachments) {
      const invoices = await parseInvoices(doc, pages, attachments);
      if (wl.status === "ok") for (const inv of invoices) inv.issues.push(...P.checkWhitelist(inv, wl.entries));
      return invoices;
    },
    line: (i) => `${i.发票类型} ${P.fullNo(i)} ${i.开票日期} ${i.销售方名称 || "-"} ¥${i.价税合计} [${i.items.length} 行]${i.二维码 ? "" : " 无税务二维码"}`,
    unit: "张发票 / 票据",
    prune: true,
  },
};

async function main() {
  const [tool, dir, ...rest] = process.argv.slice(2);
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] || "" : null);
  const jsonOut = opt("--json"), moveTo = opt("--move");
  const T = TOOLS[tool];
  if (!T || !dir || jsonOut === "" || moveTo === "" || (moveTo && !T.prune)) {
    console.error("用法: node scripts/check.js <baoguan|fapiao> <PDF目录> [--json 输出.json] [--move 移出目录（仅发票）]");
    process.exit(2);
  }
  const { pdfs, others } = listSamples(dir);
  const parsed = []; // [{ file, list } | { file, error }]
  const samples = new Map(), failed = [];
  for (const f of pdfs) {
    try {
      const { doc, pages, attachments, close } = await loadPdfFile(path.join(dir, f));
      let list, meta;
      try {
        list = await T.parse(doc, pages, attachments, f);
        meta = (await doc.getMetadata()).info;
      } finally {
        close();
      }
      if (T.prune) samples.set(f, sampleOf(tool, pages, meta, list));
      parsed.push({ file: f, list });
    } catch (e) {
      failed.push(f);
      parsed.push({ file: f, error: e.message, noText: e.code === "NO_TEXT" });
    }
  }
  // 报关资料先合并，一行对应一份报关单（来源为组内各文件）
  // 识别不了的文件交给合并（报关资料可按文件名并入为提单），并入的不再算失败
  const stubs = new Map(parsed.filter((p) => p.error).map((p) => [{ 原文件名: path.basename(p.file), 错误: p.error, 无文字层: p.noText }, p]));
  const rows = T.merge
    ? T.merge(parsed.flatMap((p) => p.list || []), [...stubs.keys()]).map((d) => ({ file: d.单据.map((x) => x.原文件名).join("、"), d }))
    : parsed.filter((p) => p.list).flatMap((p) => p.list.map((d) => ({ file: p.file, d })));
  const used = new Set(T.merge ? rows.flatMap(({ d }) => d.单据).map((x) => x.原文件名) : []);
  const results = [];
  let nIssues = 0;
  const unrecognized = parsed.filter((p) => p.error && !used.has(path.basename(p.file)));
  for (const { file, error } of unrecognized) {
    results.push({ file, error });
    console.log(`✗ ${file}: ${error}`);
  }
  for (const { file, d } of rows) {
    nIssues += d.issues.length;
    results.push({ file, ...d });
    console.log(`${d.issues.length ? "⚠" : "✓"} ${T.line(d)}  ← ${file}`);
    d.issues.forEach((s) => console.log(`    - ${s}`));
  }
  const n = rows.length;
  console.log(`\n共 ${pdfs.length} 个文件，${n} ${T.unit}，${nIssues} 个提示，${unrecognized.length} 个失败`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  if (T.prune) prune({ tool, dir, samples, failed, others, moveTo });
  process.exit(unrecognized.length ? 1 : 0);
}

main();
