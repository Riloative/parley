// Streaming cost, measured in a pseudo-terminal while a long, fast reply
// streams: how much CPU parley uses, how many frames it draws and how big
// they are, how quickly typed keys show up meanwhile, and memory at the end.
//
// Usage: node scripts/bench-stream.mjs [--runs 3] [--lines 2000] [--tps 20000] [--bin path]...
// Without --bin it measures the Node build (node bin/parley.js); a --bin that
// ends in .js runs with this Node. Repeat --bin to compare builds.
// CPU and memory come from /proc (Linux) or ps (macOS).

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pty from "node-pty";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const runs = Number(arg("runs", 3));
const lines = Number(arg("lines", 2000));
const tps = Number(arg("tps", 20000));
const cols = Number(arg("cols", 100));
const rows = Number(arg("rows", 30));
const root = new URL("..", import.meta.url).pathname;
const bins = process.argv.flatMap((a, i) =>
  a === "--bin" ? [resolve(process.argv[i + 1])] : [],
);
const targets = (bins.length ? bins : [join(root, "bin", "parley.js")]).map(
  (b) =>
    b.endsWith(".js")
      ? { label: `node build ${b}`, command: process.execPath, args: [b] }
      : { label: `binary ${b}`, command: b, args: [] },
);

const home = mkdtempSync(join(tmpdir(), "parley-bench-stream-"));
mkdirSync(join(home, "config", "parley"), { recursive: true });
writeFileSync(
  join(home, "config", "parley", "config.yaml"),
  "bell: false\nproviders:\n  mock:\n    type: mock\n",
);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  PARLEY_NO_KEYCHAIN: "1",
};
for (const k of ["CI", "GITHUB_ACTIONS"]) delete env[k];

const TICK =
  Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) ||
  100;
function cpuMs(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]
      .split(" ");
    return ((Number(f[11]) + Number(f[12])) * 1000) / TICK;
  } catch {
    const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(); // [[dd-]hh:]mm:ss.cc
    const parts = t.split(":").map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  }
}
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    return Number(m[1]) / 1024;
  } catch {
    return (
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim(),
      ) / 1024
    );
  }
}

const SYNC_BEGIN = "\x1b[?2026h";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(target) {
  return new Promise((resolvePromise, reject) => {
    const model = `mock/long?lines=${lines}&tps=${tps}`;
    const p = pty.spawn(target.command, [...target.args, "-m", model], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: home,
      env,
    });
    // Typed keys are checked on a parsed screen: with incremental rendering
    // Ink writes only the cells that changed, so the raw bytes can't be searched.
    const term = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    const countOnScreen = (ch) => {
      const b = term.buffer.active;
      let n = 0;
      for (let y = 0; y < rows; y++)
        n +=
          (b
            .getLine(b.viewportY + y)
            ?.translateToString(true)
            .split(ch).length ?? 1) - 1;
      return n;
    };
    let out = "";
    let streaming = false;
    let streamOut = "";
    const timer = setTimeout(() => reject(new Error("timed out")), 120_000);
    const waiters = [];
    p.onData((d) => {
      if (d.includes("\x1b[c")) p.write("\x1b[?62;22c");
      out += d;
      if (streaming) streamOut += d;
      term.write(d, () => {
        for (const w of [...waiters]) {
          if (!w.test()) continue;
          waiters.splice(waiters.indexOf(w), 1);
          w.done();
        }
      });
    });
    const waitFor = (test) =>
      new Promise((r) => (test() ? r() : waiters.push({ test, done: r })));
    p.onExit(() => clearTimeout(timer));

    (async () => {
      await waitFor(() => out.includes("Send a message"));
      await sleep(300);
      p.write("go");
      await sleep(50);
      const cpu0 = cpuMs(p.pid);
      const t0 = performance.now();
      streaming = true;
      p.write("\r");
      // Type one key every 100 ms while the reply streams, and time how long
      // each takes to show up in the input box.
      const latencies = [];
      let typed = 0;
      let finished = false;
      const endSeen = () => /The end\.[\s\S]*tokens/.test(streamOut);
      const typing = (async () => {
        await waitFor(() => streamOut.includes("Section 1"));
        while (!finished && typed < 150) {
          typed++;
          // Only the input box contains this letter, so the count on screen
          // is the number of keys drawn so far.
          const k0 = performance.now();
          p.write("ж");
          await waitFor(() => countOnScreen("ж") >= typed || finished);
          if (!finished) latencies.push(performance.now() - k0);
          await sleep(100);
        }
      })();
      await waitFor(endSeen);
      const t1 = performance.now();
      finished = true;
      await typing;
      const cpu1 = cpuMs(p.pid);
      const rss = rssMb(p.pid);
      streaming = false;
      const frames = streamOut.split(SYNC_BEGIN).length - 1;
      p.write("\x15"); // clear the typed keys
      await sleep(50);
      p.write("\x04");
      resolvePromise({
        seconds: (t1 - t0) / 1000,
        cpuMs: cpu1 - cpu0,
        frames,
        bytes: Buffer.byteLength(streamOut),
        latencies,
        rss,
      });
    })().catch(reject);
  });
}

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)]
    : NaN;
};
const med = (xs) => pct(xs, 50);

console.log(
  `mock/long?lines=${lines}&tps=${tps} at ${cols}x${rows}, ${runs} run(s) each`,
);
const results = targets.map(() => []);
for (let i = 0; i < runs; i++)
  for (const [k, t] of targets.entries()) results[k].push(await once(t));
rmSync(home, { recursive: true, force: true });

for (const [k, t] of targets.entries()) {
  const r = results[k];
  const lat = r.flatMap((x) => x.latencies);
  console.log(t.label);
  console.log(
    `  stream duration   ${med(r.map((x) => x.seconds)).toFixed(2)} s`,
  );
  console.log(
    `  CPU               ${med(r.map((x) => x.cpuMs)).toFixed(0)} ms (${med(r.map((x) => x.cpuMs / 10 / x.seconds)).toFixed(0)}% of one core)`,
  );
  console.log(
    `  frames            ${med(r.map((x) => x.frames))} (${med(r.map((x) => x.frames / x.seconds)).toFixed(1)}/s), CPU per frame ${med(r.map((x) => x.cpuMs / Math.max(1, x.frames))).toFixed(1)} ms`,
  );
  console.log(
    `  output            ${(med(r.map((x) => x.bytes)) / 1024).toFixed(0)} KiB, ${med(r.map((x) => x.bytes / Math.max(1, x.frames))).toFixed(0)} bytes per frame`,
  );
  console.log(
    `  typing latency    median ${med(lat).toFixed(0)} ms, p95 ${pct(lat, 95).toFixed(0)} ms, max ${Math.max(...lat).toFixed(0)} ms (n=${lat.length})`,
  );
  console.log(`  RSS at end        ${med(r.map((x) => x.rss)).toFixed(0)} MB`);
}
