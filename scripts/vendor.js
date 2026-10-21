#!/usr/bin/env node
/*
 * 从 node_modules 生成 site/vendor/（安装或升级依赖后执行一次）：
 *   npm install && node scripts/vendor.js
 *
 * 全部原样复制，不改写：
 * - pdf.js：ES 模块 pdf.min.mjs、Worker pdf.worker.min.mjs，及运行时按需加载的 cmaps / standard_fonts / wasm / iccs 目录
 * - SheetJS：ES 模块 xlsx.mjs
 * - jsQR、JSZip：只发布 UMD 版，页面用普通 <script> 加载
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = path.join(import.meta.dirname, "..", "site", "vendor");

/** 包目录：部分包（如 xlsx）的 exports 不含 package.json，从入口文件向上查找 */
function pkgDir(name) {
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== name) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`找不到 ${name} 的包目录`);
    dir = up;
  }
  return dir;
}

function copy(pkg, rel, to) {
  const dest = path.join(out, to);
  fs.cpSync(path.join(pkgDir(pkg), rel), dest, { recursive: true });
  const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir(pkg), "package.json"), "utf8"));
  console.log(`site/vendor/${to}  ← ${pkg} ${version}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "cmaps", "standard_fonts", "wasm", "iccs"])
  copy("pdfjs-dist", f, `pdfjs/${path.basename(f)}`);
copy("xlsx", "xlsx.mjs", "xlsx.mjs");
copy("jsqr", "dist/jsQR.js", "jsQR.js");
copy("jszip", "dist/jszip.min.js", "jszip.min.js");
