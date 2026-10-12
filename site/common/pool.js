/*
 * 共用：并发执行。识别多个文件时同时处理 THREADS 个（ui.js 的 addFiles、读取文件夹）。
 * 浏览器里每个并发任务各用一个 pdf.js Worker 线程（见 ui.js withPdf），解析 PDF、提取文字在各自的线程里并行；
 * 识别规则（各工具的 parser.js）在主线程执行，结果按原顺序收进列表，与逐个处理的结果相同。
 * 开关：THREADS 改成 1 即逐个处理；临时对比可在页面地址后加 ?threads=1（或其他数）
 */

const fromUrl = +(globalThis.location && new URLSearchParams(location.search).get("threads"));
/** 同时处理的文件数：实测 862 个文件逐个 39.8 秒、2 个 21.1 秒、3 个 20.7 秒（瓶颈转到主线程的识别规则），取 2 */
const THREADS = fromUrl >= 1 ? Math.floor(fromUrl) : 2;

/**
 * 对 items 逐个调用 fn(item, i)，同时最多 limit 个；返回 [{ value } | { error }]，顺序同 items，一项出错不影响其他项。
 * onDone(已完成数, item)：每完成一项调用一次（如更新进度）
 */
async function mapLimit(items, limit, fn, onDone) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { error };
      }
      onDone?.(++done, items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return out;
}

export { THREADS, mapLimit };
