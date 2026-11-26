/**
 * CSS 预算检查：防止样式总量、单文件体积和 !important 再次失控。
 *
 * 当前阈值是清理后的实际值，后续只应下调。需要新增预算时先拆分或删除旧样式，
 * 不要直接放宽阈值。
 */
import { Glob } from "bun";

const MAX_TOTAL_LINES = 11_600;
const MAX_GZIP_BYTES = 43 * 1024;
const MAX_FILE_LINES = 600;
const MAX_IMPORTANT = 53;

const files = await Array.fromAsync(new Glob("app/**/*.css").scan({ onlyFiles: true }));
files.sort();

let totalLines = 0;
let totalBytes = 0;
let important = 0;
const sources: string[] = [];
const fileLines: Array<{ file: string; lines: number }> = [];

for (const file of files) {
  const source = await Bun.file(file).text();
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  totalLines += lines;
  totalBytes += new TextEncoder().encode(source).byteLength;
  important += source.match(/!important/g)?.length ?? 0;
  sources.push(source);
  fileLines.push({ file, lines });
}

const gzipBytes = Bun.gzipSync(new TextEncoder().encode(sources.join("\n"))).byteLength;
let largest: { file: string; lines: number } | undefined;
for (const entry of fileLines) {
  if (!largest || entry.lines > largest.lines) largest = entry;
}
const failures: string[] = [];

if (totalLines > MAX_TOTAL_LINES)
  failures.push(`CSS 总行数 ${totalLines} 超过预算 ${MAX_TOTAL_LINES}`);
if (gzipBytes > MAX_GZIP_BYTES)
  failures.push(`CSS gzip 体积 ${gzipBytes} 字节超过预算 ${MAX_GZIP_BYTES}`);
if (largest && largest.lines > MAX_FILE_LINES)
  failures.push(`${largest.file} 有 ${largest.lines} 行，超过单文件预算 ${MAX_FILE_LINES}`);
if (important > MAX_IMPORTANT)
  failures.push(`!important 数量 ${important} 超过预算 ${MAX_IMPORTANT}`);

console.log(
  `[css:budget] ${files.length} 个文件，${totalLines} 行，${(totalBytes / 1024).toFixed(1)} KB，gzip ${(gzipBytes / 1024).toFixed(1)} KB，!important ${important}`,
);
console.log(`[css:budget] 最大文件：${largest?.file ?? "无"}（${largest?.lines ?? 0} 行）`);

if (failures.length) {
  for (const failure of failures) console.error(`[css:budget] ${failure}`);
  process.exit(1);
}
