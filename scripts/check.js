#!/usr/bin/env node
/*
 * 回归测试 + 样本精简：批量解析目录（含子文件夹）中的 PDF，发票同网页一样核对二维码，报关资料同网页一样按报关单合并（一份报关单一行）
 *   node scripts/check.js customs <报关资料目录> [--json 输出.json]
 *   node scripts/check.js invoice <发票PDF目录>  [--json 输出.json] [--move 移出目录]
 * 发票末尾预览样本精简（见 samples.js）；--move：确认回归结果无误后再加，把多余样本移到指定目录、保留的样本改为规范命名。
 * 报关资料按整套保留（关联要靠同一票货的各单据），不精简。
 */
import fs from "node:fs";
import path from "node:path";
import { loadPdfFile, parseDocs } from "./node-pdf.js";
import { listSamples, sampleOf, prune } from "./samples.js";
import { mergeDocs } from "../site/fapiao/customs.js";
import * as P from "../site/fapiao/invoice.js";

// 购买方白名单：scripts/config.ini 的 [发票购买方白名单] 一节（同 serve.py 提供给网页的内容）
const CONFIG = path.join(import.meta.dirname, "config.ini");
const section = (text, name) => (text.split(/^\s*\[(.+?)\]\s*$/m).find((s, i, a) => a[i - 1]?.trim() === name) || "");
const wl = P.parseWhitelist(section(fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : "", "发票购买方白名单"));

const TOOLS = {
  customs: {
    // 与网页一致：逐页识别、合订的按页拆开（parseDocs），各份的原文件名为「原名（第 n 页）」；发票只用于关联报关单
    parse: (doc, pages, attachments, file) => parseDocs(doc, pages, attachments, path.basename(file), { qr: false }), // 发票只用于关联，不扫二维码
    merge: mergeDocs,
    line: (d) => `${d.归档位置} [${d.单据.map((x) => x.版式).join("、")}]${d.缺少.length && d.单据类型 === "报关单" ? ` 缺 ${d.缺少.join("、")}` : ""}`,
    unit: "份报关单（含未匹配的单据）",
  },
  invoice: {
    // 与网页一致：核对二维码，config.ini 的发票白名单格式标准时校验购买方；只看发票（报关单证在 customs）
    parse: async (doc, pages, attachments, file) =>
      (await parseDocs(doc, pages, attachments, path.basename(file), { wl })).filter((d) => d.错误 || d.类别 === "发票"),
    line: (i) => `${i.发票类型} ${P.fullNo(i)} ${i.开票日期} ${i.销售方名称 || "-"} ¥${i.价税合计} [${i.items.length} 行]${i.二维码 ? "" : " 无税务二维码"}`,
    unit: "张发票 / 票据",
    prune: true,
  },
};

async function main() {
  const [tool, dir, ...rest] = process.argv.slice(2);
  // 选项后面没有值、或紧跟另一个选项时为 ""（报用法错误）
  const opt = (name) => (rest.includes(name) ? (rest[rest.indexOf(name) + 1] || "").replace(/^--.*/, "") : null);
  const jsonOut = opt("--json"), moveTo = opt("--move");
  const T = TOOLS[tool];
  if (!T || !dir || jsonOut === "" || moveTo === "" || (moveTo && !T.prune)) {
    console.error("用法: node scripts/check.js <customs|invoice> <PDF目录> [--json 输出.json] [--move 移出目录（仅发票）]");
    process.exit(2);
  }
  if (tool === "invoice") console.log({ ok: `购买方白名单已启用（${wl.entries.length} 家）`, empty: "未配置购买方白名单（scripts/config.ini），不校验购买方",
    invalid: `购买方白名单${wl.message}，本次不校验购买方` }[wl.status]);
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
      if (T.prune) samples.set(f, sampleOf(pages, meta, list.filter((x) => !x.错误))); // 识别不出的那几页另作失败单列
      // 拆出的几份里识别不出的（带 错误），同网页作为失败单列
      for (const x of list.filter((x) => x.错误)) parsed.push({ file: path.join(path.dirname(f), x.原文件名), error: x.错误 });
      parsed.push({ file: f, list: list.filter((x) => !x.错误) });
    } catch (e) {
      failed.push(f);
      parsed.push({ file: f, error: e.message, noText: e.code === "NO_TEXT" });
    }
  }
  // 报关资料先合并，一行对应一份报关单（来源为组内各文件）
  // 识别不了的文件交给合并（报关资料可按文件名并入为提运单），并入的不再算失败
  const stubs = new Map(parsed.filter((p) => p.error).map((p) => [{ 原文件名: path.basename(p.file), 错误: p.error, 无文字层: p.noText }, p]));
  const groups = T.merge ? T.merge(parsed.flatMap((p) => p.list || []), [...stubs.keys()]) : [];
  const rows = T.merge
    ? groups.map(({ data: d }) => ({ file: d.单据.map((x) => x.原文件名).join("、"), d }))
    : parsed.filter((p) => p.list).flatMap((p) => p.list.map((d) => ({ file: p.file, d })));
  // 并入某组的（成员的 来源 即交给合并的那个对象）按对象认，不按文件名（不同子文件夹里可能同名）
  const used = new Set(groups.flatMap((g) => g.members.map((m) => stubs.get(m.来源))));
  const results = [];
  let nIssues = 0;
  const unrecognized = parsed.filter((p) => p.error && !used.has(p));
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
  if (T.prune) prune({ dir, samples, failed, others, moveTo });
  process.exit(unrecognized.length ? 1 : 0);
}

main();
