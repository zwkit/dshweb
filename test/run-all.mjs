/**
 * 测试总入口：依次运行 test/ 下的每个独立断言脚本，汇总结果。
 *
 * 这些脚本不是 node:test 用例（它们在顶层用 await 跑断言并打印
 * `N/M PASS`，不等时 exit(1)），所以不能直接交给 `node --test`。
 * 用子进程逐个跑，任何一份失败则整体失败。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run-all.mjs')
  .sort();

let failed = 0;
const summary = [];

for (const file of files) {
  process.stdout.write(`\n━━━ ${file} ━━━\n`);
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  const ok = res.status === 0;
  if (!ok) failed += 1;
  summary.push({ file, ok, code: res.status });
}

process.stdout.write('\n════════ 测试汇总 ════════\n');
for (const s of summary) {
  process.stdout.write(`${s.ok ? '✓' : '✗'} ${s.file}${s.ok ? '' : ` (exit ${s.code})`}\n`);
}
process.stdout.write(`${summary.length - failed}/${summary.length} 个测试文件通过\n`);

if (failed > 0) process.exit(1);
