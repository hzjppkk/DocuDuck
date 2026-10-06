#!/usr/bin/env node
/*
 * 命令行批量解析（回归测试）；发票的二维码要用 OffscreenCanvas 和 jsQR 识别，只能在浏览器中验证
 *   node scripts/check.js baoguan <报关单PDF目录> [--json 输出.json]
 *   node scripts/check.js fapiao <发票PDF目录>       [--json 输出.json]
 */
import fs from "node:fs";
import path from "node:path";
import { loadPdfFile } from "./node-pdf.js";
import { parseDeclaration } from "../site/baoguan/parser.js";
import * as P from "../site/fapiao/parser.js";

const TOOLS = {
  baoguan: {
    parse: (pages) => [parseDeclaration(pages)],
    line: (d) => `${d.header.海关编号} ${d.header.出口日期} [${d.items.length} 项]`,
    unit: "份报关单",
  },
  fapiao: {
    // 与网页一致：site/fapiao/whitelist.ini 存在且格式标准时，校验购买方
    parse(pages, attachments) {
      const file = path.join(import.meta.dirname, "../site/fapiao/whitelist.ini");
      const wl = P.parseWhitelist(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
      const { invoices } = P.parseInvoicePdf(pages, attachments);
      if (wl.status === "ok") for (const inv of invoices) inv.issues.push(...P.checkWhitelist(inv, wl.entries));
      return invoices;
    },
    line: (i) => `${i.发票类型} ${P.fullNo(i)} ${i.开票日期} ${i.销售方名称 || "-"} ¥${i.价税合计} [${i.items.length} 行]`,
    unit: "张发票 / 票据",
  },
};

async function main() {
  const [tool, dir, flag, jsonOut] = process.argv.slice(2);
  const T = TOOLS[tool];
  if (!T || !dir) {
    console.error("用法: node scripts/check.js <baoguan|fapiao> <PDF目录> [--json 输出.json]");
    process.exit(2);
  }
  const files = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort();
  const results = [];
  let n = 0, nIssues = 0, nFail = 0;
  for (const f of files) {
    try {
      const { pages, attachments, close } = await loadPdfFile(path.join(dir, f));
      close();
      for (const d of T.parse(pages, attachments)) {
        n++;
        nIssues += d.issues.length;
        results.push({ file: f, ...d });
        console.log(`${d.issues.length ? "⚠" : "✓"} ${T.line(d)}  ← ${f}`);
        d.issues.forEach((s) => console.log(`    - ${s}`));
      }
    } catch (e) {
      nFail++;
      results.push({ file: f, error: e.message });
      console.log(`✗ ${f}: ${e.message}`);
    }
  }
  console.log(`\n共 ${files.length} 个文件，${n} ${T.unit}，${nIssues} 个提示，${nFail} 个失败`);
  if (flag === "--json" && jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  process.exit(nFail ? 1 : 0);
}

main();
