// Long-history cost: how taria behaves for someone with a lot of saved
// conversations and one very long one. Generates the history (schema v1
// files, shaped like what taria writes, including the delta lines a streamed
// reply leaves), then measures in a pseudo-terminal:
//   - `taria -p -c` (continue the latest conversation)
//   - opening the /resume picker
//   - resuming the long conversation (time to first frame)
//   - a resize that reprints the long conversation
//
// Usage: node scripts/bench-history.mjs [--conversations 1000] [--long-turns 300] [--runs 5] [--sources N [--blob-kb 48]] [--bin path]...
// A --bin that ends in .js runs with this Node; repeat --bin to compare builds.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
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
const conversations = Number(arg("conversations", 1000));
const longTurns = Number(arg("long-turns", 300));
const runs = Number(arg("runs", 5));
// --sources N: every Nth reply of the long conversation searched the web: one
// search, five sources (two cited) and --blob-kb of the provider's opaque
// data (48 KB is about what one search's encrypted results come to).
const sourcesEvery = Number(arg("sources", 0));
const blobKb = Number(arg("blob-kb", 48));
const root = new URL("..", import.meta.url).pathname;
const bins = process.argv.flatMap((a, i) =>
  a === "--bin" ? [resolve(process.argv[i + 1])] : [],
);
const targets = (bins.length ? bins : [join(root, "bin", "taria.js")]).map(
  (b) =>
    b.endsWith(".js")
      ? { label: `node build ${b}`, command: process.execPath, args: [b] }
      : { label: `binary ${b}`, command: b, args: [] },
);

// ------------------------------------------------------------ history
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const WORDS =
  "the of and to a in is that for it as with was on be by this are or at from which have an not but can all".split(
    " ",
  );
const words = (n) =>
  Array.from(
    { length: n },
    () => WORDS[Math.floor(rand() * WORDS.length)],
  ).join(" ");
function reply(i) {
  const parts = [
    `## Part ${i}`,
    words(60),
    "",
    "- " + words(8),
    "- " + words(8),
    "",
  ];
  if (i % 2)
    parts.push(
      "```js",
      `function f${i}(a) {`,
      "  return a.map((x) => x * 2);",
      "}",
      "```",
      "",
    );
  parts.push(words(80));
  return parts.join("\n");
}

function writeConversation(dir, id, turns, ts) {
  const lines = [
    { type: "meta", v: 1, id, createdAt: ts, app: "taria", cwd: "/tmp" },
    { type: "model", model: "mock/echo" },
  ];
  let parent = null;
  for (let t = 0; t < turns; t++) {
    const u = `u_${id}_${t}`;
    const a = `a_${id}_${t}`;
    lines.push({
      type: "message",
      id: u,
      parentId: parent,
      role: "user",
      content: [{ type: "text", text: `question ${t}: ${words(25)}` }],
      ts: ts + t * 1000,
      model: "mock/echo",
    });
    lines.push({
      type: "partial",
      id: a,
      parentId: u,
      model: "mock/echo",
      ts: ts + t * 1000 + 1,
    });
    const text = reply(t);
    for (let k = 0; k < text.length; k += 400)
      lines.push({ type: "delta", id: a, text: text.slice(k, k + 400) });
    lines.push({
      type: "message",
      id: a,
      parentId: u,
      role: "assistant",
      content: [{ type: "text", text }],
      model: "mock/echo",
      ts: ts + t * 1000 + 500,
      usage: { inputTokens: 100 * t, outputTokens: 300 },
      durationMs: 2000,
      stopReason: "end_turn",
    });
    if (sourcesEvery && turns === longTurns && t % sourcesEvery === 0) {
      lines.push({
        type: "annex",
        id: a,
        parts: [
          { type: "search", id: `s${t}`, query: `question ${t}`, status: "done" },
          ...Array.from({ length: 5 }, (_, k) => ({
            type: "source",
            url: `https://example.com/${t}/${k}`,
            title: `Result ${k} for question ${t}`,
            snippet: words(20),
            ...(k < 2 ? { cited: true, at: 40 + k * 30 } : {}),
          })),
          { type: "provider_data", provider: "mock", model: "echo", data: "e".repeat(blobKb * 1024) },
        ],
      });
    }
    if (t === 0) lines.push({ type: "title", title: `Conversation ${id}` });
    parent = a;
  }
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, new Date(ts + turns * 1000), new Date(ts + turns * 1000));
}

const home = mkdtempSync(join(tmpdir(), "taria-bench-history-"));
mkdirSync(join(home, "config", "taria"), { recursive: true });
writeFileSync(
  join(home, "config", "taria", "config.yaml"),
  "default_model: mock/echo\nbell: false\nproviders:\n  mock:\n    type: mock\n",
);
const convDir = join(home, "data", "taria", "conversations");
mkdirSync(convDir, { recursive: true });
const base = Date.UTC(2026, 0, 1);
let bytes = 0;
for (let i = 0; i < conversations; i++) {
  const id = `20260101-000000-${String(i).padStart(6, "0")}`;
  writeConversation(
    convDir,
    id,
    2 + Math.floor(rand() * 30),
    base + i * 60_000,
  );
}
const longId = "20260201-000000-longlong";
writeConversation(
  convDir,
  longId,
  longTurns,
  base + conversations * 60_000 + 1,
);
bytes =
  Number(
    spawnSync("du", ["-sk", convDir], { encoding: "utf8" }).stdout.split(
      "\t",
    )[0],
  ) * 1024;

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TARIA_NO_KEYCHAIN: "1",
};
for (const k of [
  "CI",
  "GITHUB_ACTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
])
  delete env[k];

// ------------------------------------------------------------ measurements
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printContinue(target) {
  const t0 = performance.now();
  const r = spawnSync(target.command, [...target.args, "-p", "-c", "hi"], {
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`-p -c failed: ${r.stderr}`);
  return performance.now() - t0;
}

function session(target, args, cols = 100, rows = 30) {
  const term = new Terminal({
    cols,
    rows,
    scrollback: 100_000,
    allowProposedApi: true,
  });
  const p = pty.spawn(target.command, [...target.args, ...args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: home,
    env,
  });
  const started = performance.now();
  const waiters = [];
  let raw = "";
  p.onData((d) => {
    if (d.includes("\x1b[c")) p.write("\x1b[?62;22c");
    raw += d;
    term.write(d, () => {
      for (const w of [...waiters]) {
        if (!w.test()) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.done();
      }
    });
  });
  const screen = () => {
    const b = term.buffer.active;
    const out = [];
    for (let y = 0; y < term.rows; y++)
      out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
    return out.join("\n");
  };
  const waitFor = (test, ms = 60_000) =>
    new Promise((res, rej) => {
      const t = setTimeout(
        () => rej(new Error(`timed out; screen:\n${screen()}`)),
        ms,
      );
      const done = () => (clearTimeout(t), res());
      if (test()) done();
      else waiters.push({ test, done });
    });
  return {
    p,
    term,
    started,
    screen,
    waitFor,
    raw: () => raw,
    close: () => p.kill(),
  };
}

async function resumePicker(target) {
  const s = session(target, []);
  await s.waitFor(() => s.screen().includes("Send a message"));
  await sleep(300);
  s.p.write("/resume");
  await sleep(100);
  const t0 = performance.now();
  s.p.write("\r");
  await s.waitFor(() => s.screen().includes("Conversation 20260101"));
  const t = performance.now() - t0;
  s.close();
  return t;
}

async function resumeLong(target) {
  const s = session(target, ["-r", longId]);
  await s.waitFor(() => s.screen().includes("Send a message"));
  const first = performance.now() - s.started;
  await sleep(500);
  const before = s.raw().length;
  const t0 = performance.now();
  s.p.resize(90, 30);
  s.term.resize(90, 30);
  // The reprint ends with the conversation's last reply and the prompt again.
  await s.waitFor(
    () =>
      s.raw().length > before &&
      s.screen().includes("Send a message") &&
      s
        .raw()
        .slice(before)
        .includes(`question ${longTurns - 1}`),
  );
  const reprint = performance.now() - t0;
  const reprintBytes = s.raw().length - before;
  s.close();
  return { first, reprint, reprintBytes };
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(
  `${conversations} conversations + one of ${longTurns} turns, ${(bytes / 1024 / 1024).toFixed(1)} MB on disk; ${runs} runs each (median)`,
);
const res = targets.map(() => ({
  cont: [],
  picker: [],
  first: [],
  reprint: [],
  reprintBytes: [],
}));
for (const t of targets) printContinue(t); // warm the compile cache
for (let i = 0; i < runs; i++) {
  for (const [k, t] of targets.entries()) {
    res[k].cont.push(printContinue(t));
    res[k].picker.push(await resumePicker(t));
    const l = await resumeLong(t);
    res[k].first.push(l.first);
    res[k].reprint.push(l.reprint);
    res[k].reprintBytes.push(l.reprintBytes);
  }
}
if (process.env.BENCH_KEEP) console.log(`kept ${home}`);
else rmSync(home, { recursive: true, force: true });
for (const [k, t] of targets.entries()) {
  const r = res[k];
  console.log(t.label);
  console.log(`  taria -p -c                 ${med(r.cont).toFixed(0)} ms`);
  console.log(`  /resume picker open          ${med(r.picker).toFixed(0)} ms`);
  console.log(
    `  resume long conversation     ${med(r.first).toFixed(0)} ms to the prompt`,
  );
  console.log(
    `  resize reprint (long conv.)  ${med(r.reprint).toFixed(0)} ms, ${(med(r.reprintBytes) / 1024).toFixed(0)} KiB written`,
  );
}
process.exit(0);
