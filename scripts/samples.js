/*
 * 发票样本精简（check.js 调用）：同一版式、同样情况的样本只留代表，其余移到别处（不删除），回归测试更快、覆盖面不变；保留的样本改为规范命名
 * 报关资料不精简：报关委托书、提运单要靠同一票货的其他单据关联，按整套保留
 *
 * 做法：给每个样本提取一组特征（版式 + 票面上出现的各种情况），再挑尽量少的样本，使每个特征至少被一个样本覆盖。
 *   版式：PDF 生成软件、页宽、票种（内容不同、版式相同的样本算冗余，开票方不作为依据）
 *   发票：税率、负数行、规格型号、明细行数、附加信息、内嵌数据、名称 / 税号 / 号码被拆成多个文字块、表头斜杠、
 *         铁路票的退票费 / 无座、行程单的多航段（发票的情况按版式分别统计：同一种情况在不同版式里各留一份）
 * 精简不判断识别对错，须先看回归结果确认程序正确，再加 --move 执行（见 README 新增样本流程）。
 * 只保留能正确识别的样本：识别失败的 PDF（不是单据、没有文字层、文字乱码等）和非 PDF 文件一并移出（desktop.ini 等系统文件不动）。
 * 要增加判断依据，在 featuresOf 里加一条特征即可。规范命名同网页发票视图的打包（site/common/text.js 的 standardNames），不含开票年月文件夹。
 */
import fs from "node:fs";
import path from "node:path";
import { standardNames, compact } from "../site/common/text.js";

/** 某个值能否在单个文字块中完整找到（忽略空格）；找不到说明票面上它被拆成了多块 */
const inOneToken = (tokens, v) => !v || tokens.some((s) => s.includes(String(v).replace(/\s/g, "")));

/** 由解析结果提取特征：返回 { family: 版式（用于显示）, features: Map(特征 id → 显示名) } */
function featuresOf(pdf, invoices) {
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
    if (["增值税发票", "旧版发票"].includes(inv.版式) && inv.附加信息.length) flags.push("附加信息");
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
}

/** 目录（含子文件夹）中的样本：PDF 与其他文件（desktop.ini 等系统文件除外），路径相对 dir、按路径排序 */
export function listSamples(dir) {
  const all = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !/^(desktop\.ini|thumbs\.db)$/i.test(path.basename(f))).sort();
  return { pdfs: all.filter((f) => /\.pdf$/i.test(f)), others: all.filter((f) => !/\.pdf$/i.test(f)) };
}

/** 一个样本的特征；meta 为 PDF 元数据（doc.getMetadata 的 info），records 为解析结果 */
export function sampleOf(pages, meta, records) {
  const pdf = {
    producer: (meta.Producer || "").slice(0, 20),
    creator: (meta.Creator || "").slice(0, 12),
    width: Math.round(pages[0].width),
    tokens: pages.flatMap((p) => p.items.map((i) => compact(i.str))).filter(Boolean), // 同解析器规整（部首、空白、括号），否则名称恒判为拆分
  };
  return { ...featuresOf(pdf, records), records };
}

/**
 * 挑选、预览，moveTo 非空时执行：多余的移到 moveTo，保留的改为规范命名
 * samples：Map(文件 → sampleOf 的结果)，按文件名顺序；failed：识别失败的文件；others：非 PDF 文件
 */
export function prune({ dir, samples, failed, others, moveTo }) {
  // 每次挑覆盖“尚未覆盖的特征”最多的样本，直到所有特征都被覆盖（并列时取文件名靠前的）
  const keep = new Set();
  const need = new Set([...samples.values()].flatMap((x) => [...x.features.keys()]));
  while (need.size) {
    let best, gain = [];
    for (const [f, x] of samples) {
      const g = [...x.features.keys()].filter((id) => need.has(id));
      if (g.length > gain.length) [best, gain] = [f, g];
    }
    keep.add(best);
    gain.forEach((id) => need.delete(id));
  }

  const dup = [...samples.keys()].filter((f) => !keep.has(f));
  const drop = [...dup, ...failed, ...others];
  const renames = standardNames([...keep].flatMap((f) => samples.get(f).records.map((data) => ({ file: f, data }))), (d) => d.suggestedName, "张")
    .filter(({ file, name }) => file !== name);

  console.log(`\n—— 样本精简 ——`);
  for (const f of dup) console.log(`  移出（重复）${f}\n      ${samples.get(f).family}`);
  for (const f of failed) console.log(`  移出（识别失败）${f}`);
  for (const f of others) console.log(`  移出（非 PDF）${f}`);
  for (const { file, name } of renames) console.log(`  改名 ${file}\n    → ${name}`);
  console.log(`保留 ${keep.size}（改名 ${renames.length}），移出 ${drop.length}（重复 ${dup.length}，识别失败 ${failed.length}，非 PDF ${others.length}）`);
  if (!drop.length && !renames.length) return;
  if (!moveTo) return console.log("预览，未移动、未改名；确认回归结果无误后加 --move <目录> 执行");

  fs.mkdirSync(moveTo, { recursive: true });
  for (const f of drop) {
    fs.mkdirSync(path.dirname(path.join(moveTo, f)), { recursive: true });
    fs.renameSync(path.join(dir, f), path.join(moveTo, f));
  }
  // 分两步改名：新名字可能正是另一个待改名文件的旧名字
  renames.forEach(({ file }, i) => fs.renameSync(path.join(dir, file), path.join(dir, `~renaming-${i}`)));
  renames.forEach(({ name }, i) => fs.renameSync(path.join(dir, `~renaming-${i}`), path.join(dir, name)));
  console.log(`已移到 ${moveTo}，已改名 ${renames.length} 个`);
}
