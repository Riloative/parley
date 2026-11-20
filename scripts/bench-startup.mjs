// Time to first frame, measured two ways over N runs in a pseudo-terminal:
//   trace — the program's own PARLEY_STARTUP_TRACE (ms since process start)
//   wall  — from spawn until the prompt is visible in the output
//
// Usage: node scripts/bench-startup.mjs [--runs 20] [--bin path/to/parley]...
// Without --bin it measures the Node build (node bin/parley.js). A --bin that
// ends in .js is run with this Node. Repeat --bin to compare builds: their
// runs alternate, so a busy machine slows them all alike.
// Requires the dev dependencies (node-pty).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const runs = Number(arg('runs', 20));
const root = new URL('..', import.meta.url).pathname;
const bins = process.argv.flatMap((a, i) => (a === '--bin' ? [resolve(process.argv[i + 1])] : []));
const targets = (bins.length ? bins : [join(root, 'bin', 'parley.js')]).map((b) =>
  b.endsWith('.js')
    ? { label: `node build ${b} (${process.version})`, command: process.execPath, args: [b] }
    : { label: `binary ${b}`, command: b, args: [] },
);

const home = mkdtempSync(join(tmpdir(), 'parley-bench-'));
mkdirSync(join(home, 'config', 'parley'), { recursive: true });
writeFileSync(join(home, 'config', 'parley', 'config.yaml'), 'default_model: mock/echo\nbell: false\nproviders:\n  mock:\n    type: mock\n');

const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), TERM: 'xterm-256color', COLORTERM: 'truecolor', PARLEY_NO_KEYCHAIN: '1' };
for (const k of ['CI', 'GITHUB_ACTIONS']) delete env[k];

function once(target, i, k = 0) {
  return new Promise((resolve, reject) => {
    const trace = join(home, `trace-${k}-${i}`);
    const started = performance.now();
    const p = pty.spawn(target.command, target.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: home, env: { ...env, PARLEY_STARTUP_TRACE: trace } });
    let out = '';
    let wall;
    const timer = setTimeout(() => reject(new Error('timed out waiting for the prompt')), 15_000);
    p.onData((d) => {
      out += d;
      if (d.includes('\x1b[c')) p.write('\x1b[?62;22c');
      if (wall === undefined && out.includes('Send a message')) {
        wall = performance.now() - started;
        setTimeout(() => p.write('\x04'), 150);
      }
    });
    p.onExit(() => {
      clearTimeout(timer);
      let t = NaN;
      try {
        const lines = readFileSync(trace, 'utf8').trim().split('\n');
        t = Number(lines[0]);
        if (process.env.BENCH_MARKS && lines[1]) console.log(lines[1]);
      } catch {
        /* no trace */
      }
      resolve({ trace: t, wall, ...(process.env.BENCH_DEBUG ? { out: out.slice(0, 400) } : {}) });
    });
  });
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// One warm-up run each fills the compile cache, like any real second start.
for (const [k, t] of targets.entries()) await once(t, -1, k);
const results = targets.map(() => []);
for (let i = 0; i < runs; i++) for (const [k, t] of targets.entries()) results[k].push(await once(t, i, k));
if (process.env.BENCH_DEBUG) console.log(JSON.stringify(results[0].slice(0, 3)));
rmSync(home, { recursive: true, force: true });

const fmt = (xs) => `median ${pct(xs, 50).toFixed(0)} ms, p95 ${pct(xs, 95).toFixed(0)} ms (n=${xs.length})`;
for (const [k, t] of targets.entries()) {
  const trace = results[k].map((r) => r.trace).filter(Number.isFinite);
  const wall = results[k].map((r) => r.wall).filter(Number.isFinite);
  console.log(t.label);
  console.log(`  first frame (trace): ${fmt(trace)}`);
  console.log(`  prompt visible (wall): ${fmt(wall)}`);
}
