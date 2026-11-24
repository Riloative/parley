// Run PTY tests repeatedly under CPU load, to catch races that only show on a
// slow machine (the 0.2.0 queue-editing bug only failed on loaded runners).
//
// Usage: node scripts/stress-pty.mjs [--runs 5] [--load N] [--base origin/main] [test files...]
// Without files: the PTY test files that differ from --base (all of them if
// git cannot tell). --load is the number of busy-looping processes (default:
// one per CPU). Exits 1 if any run failed, with a summary of what failed.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const runs = Number(opt('--runs', '5'));
const load = Number(opt('--load', String(availableParallelism())));
const base = opt('--base', 'origin/main');
let files = argv;
if (!files.length) {
  try {
    files = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', 'test/pty'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.test.ts') && !f.endsWith('peek.test.ts'));
  } catch {
    files = [];
  }
  if (!files.length) files = ['test/pty'];
}
console.log(`stress: ${runs} run(s) of ${files.join(' ')} with ${load} busy process(es)`);

const burners = Array.from({ length: load }, () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
const stop = () => burners.forEach((b) => b.kill());
process.on('exit', stop);

const failures = new Map();
let failedRuns = 0;
for (let i = 1; i <= runs; i++) {
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files], { encoding: 'utf8', env: process.env });
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = /Tests\s+.*$/m.exec(out)?.[0] ?? `exit ${r.status}`;
  console.log(`run ${i}: ${summary.trim()}`);
  if (r.status !== 0) {
    failedRuns++;
    for (const m of out.matchAll(/^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)) failures.set(m[1], (failures.get(m[1]) ?? 0) + 1);
    // The first failure's details, for the log.
    console.log(out.split('\n').filter((l) => /FAIL|Error|Timed out|expected|❯ test\//.test(l)).slice(0, 30).join('\n'));
  }
}
stop();
if (failedRuns) {
  console.log(`\n${failedRuns} of ${runs} runs failed:`);
  for (const [t, n] of failures) console.log(`  ${n}× ${t}`);
  process.exit(1);
}
console.log(`\nall ${runs} runs passed`);
