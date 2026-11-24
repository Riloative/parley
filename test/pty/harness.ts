// Drives the real bundled binary through a pseudo-terminal and keeps a
// headless xterm.js emulator in sync, so tests can assert on what a user
// would actually see (and on the raw bytes written).

import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import type { Terminal as XTerminal } from '@xterm/headless';
import { tariaCommand } from '../build-once.js';

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof XTerminal };


export interface Session {
  term: InstanceType<typeof Terminal>;
  proc: pty.IPty;
  raw: string;
  /** The part of `raw` the emulator has already processed. */
  parsed: string;
  home: string;
  write(s: string): void;
  screen(): string[];
  /** Scrollback + screen. */
  all(): string[];
  waitFor(pred: string | RegExp | (() => boolean), timeoutMs?: number): Promise<void>;
  /**
   * Wait until the frame is complete: nothing new has arrived for `quietMs`
   * and everything received has been parsed, and (if given) some line of the
   * screen matches `lastLine`. Assert on the screen only after this.
   * While a reply streams the screen never settles: pass `region` (the part
   * asserted on, e.g. the queue and input box) to wait for that part only.
   */
  waitStable(opts?: { quietMs?: number; lastLine?: string | RegExp; timeoutMs?: number; region?: () => string }): Promise<void>;
  resize(cols: number, rows: number): void;
  /** Resolves with the exit code; rejects with the screen if the program has
   * not exited 15 s after this is read (a hang must fail with something to
   * look at, not a bare test timeout). */
  readonly exited: Promise<number>;
  close(keepHome?: boolean): Promise<void>;
  rawSince(mark: number): string;
}

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  args?: string[];
  config?: string;
  env?: Record<string, string>;
  command?: string;
  commandArgs?: string[];
  /** Reuse an existing home directory (to test resuming). */
  home?: string;
  /** Pretend to be a terminal that supports the kitty keyboard protocol. */
  kitty?: boolean;
  /** Working directory (defaults to the temporary home). */
  cwd?: string;
  /** Write no config file (first-run). */
  noConfig?: boolean;
  /** Answer the OSC 11 background query with this colour (e.g. rgb:ffff/ffff/ffff). */
  background?: string;
  /** ...after this many milliseconds (a slow link). */
  backgroundDelayMs?: number;
  /** Also answer DA2 and XTVERSION as xterm does (tmux asks, to pick features). */
  identifyAsXterm?: boolean;
}

export const DEFAULT_CONFIG = `default_model: mock/echo
theme: dark
bell: false
providers:
  mock:
    type: mock
`;

export function makeHome(config = DEFAULT_CONFIG): string {
  const home = mkdtempSync(join(tmpdir(), 'taria-test-'));
  mkdirSync(join(home, 'config', 'taria'), { recursive: true });
  if (config) writeFileSync(join(home, 'config', 'taria', 'config.yaml'), config);
  return home;
}

export function testEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CI|GITHUB_ACTIONS|TMUX|TERM_PROGRAM|COLORFGBG|NO_COLOR|FORCE_COLOR|SSH_.*|.*_API_KEY|PARLEY_.*|TARIA_.*)$/.test(k)) continue;
    // Tests set proxies explicitly when they need one.
    if (/^(https?_proxy|no_proxy|all_proxy)$/i.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    TARIA_NO_KEYCHAIN: '1',
    EDITOR: 'true',
    ...extra,
  };
}

// node-pty's prebuilt macOS spawn-helper is sometimes installed without its
// execute bit, which makes every spawn fail with "posix_spawnp failed".
function fixSpawnHelper(): void {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
  }
}

export function spawnTaria(opts: SpawnOptions = {}): Session {
  fixSpawnHelper();
  const launch = tariaCommand(opts.args ?? []);
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const home = opts.home ?? makeHome(opts.noConfig ? '' : (opts.config ?? DEFAULT_CONFIG));
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const proc = pty.spawn(opts.command ?? launch.command, opts.commandArgs ?? launch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? home,
    env: testEnv(home, opts.env),
  });
  let raw = '';
  let parsed = '';
  let pending = Promise.resolve();
  proc.onData((d) => {
    raw += d;
    pending = pending.then(
      () =>
        new Promise<void>((r) =>
          term.write(d, () => {
            parsed += d;
            r();
          }),
        ),
    );
    // Answer the terminal queries the way a basic xterm does (DA1 only, no
    // kitty keyboard protocol) so behaviour is deterministic.
    if (opts.background && d.includes('\x1b]11;?')) {
      const reply = `\x1b]11;${opts.background}\x1b\\`;
      if (opts.backgroundDelayMs) setTimeout(() => proc.write(reply), opts.backgroundDelayMs);
      else proc.write(reply);
    }
    if (opts.identifyAsXterm && d.includes('\x1b[>c')) proc.write('\x1b[>41;370;0c');
    if (opts.identifyAsXterm && d.includes('\x1b[>q')) proc.write('\x1bP>|XTerm(370)\x1b\\');
    if (opts.kitty && d.includes('\x1b[?u')) proc.write('\x1b[?0u');
    if (d.includes('\x1b[c')) proc.write('\x1b[?62;22c');
  });
  const exited = new Promise<number>((resolve) => proc.onExit((e) => resolve(e.exitCode)));
  const lines = (from: number, to: number) => {
    const out: string[] = [];
    const buf = term.buffer.active;
    for (let i = from; i < to; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
    return out;
  };
  const s: Session = {
    term,
    proc,
    get raw() {
      return raw;
    },
    get parsed() {
      return parsed;
    },
    home,
    write: (d) => proc.write(d),
    screen: () => {
      const buf = term.buffer.active;
      return lines(buf.viewportY, buf.viewportY + term.rows);
    },
    all: () => lines(0, term.buffer.active.length),
    async waitFor(pred, timeoutMs = 10_000) {
      const start = Date.now();
      const test = () => {
        if (typeof pred === 'function') return pred();
        const text = s.all().join('\n');
        return typeof pred === 'string' ? text.includes(pred) : pred.test(text);
      };
      while (Date.now() - start < timeoutMs) {
        await pending;
        if (test()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting for ${String(pred)}\n--- screen ---\n${s.screen().join('\n')}\n--------------`);
    },
    async waitStable({ quietMs = 150, lastLine, timeoutMs = 10_000, region } = {}) {
      const start = Date.now();
      const snapshot = () => (region ? region() : String(raw.length));
      let seen = snapshot();
      let since = Date.now();
      const lineOk = () => {
        if (lastLine === undefined) return true;
        return s.screen().some((l) => (typeof lastLine === 'string' ? l.includes(lastLine) : lastLine.test(l)));
      };
      while (Date.now() - start < timeoutMs) {
        await pending;
        const now = snapshot();
        if (now !== seen) {
          seen = now;
          since = Date.now();
        } else if ((region || parsed.length === raw.length) && Date.now() - since >= quietMs && lineOk()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for a stable frame${lastLine === undefined ? '' : ` with ${String(lastLine)}`}\n--- screen ---\n${s.screen().join('\n')}\n--------------`);
    },
    resize(c, r) {
      proc.resize(c, r);
      term.resize(c, r);
    },
    get exited() {
      return Promise.race([
        exited,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error(`The program did not exit within 15 s\n--- screen ---\n${s.screen().join('\n')}\n--------------`)), 15_000).unref(),
        ),
      ]);
    },
    async close(keepHome = false) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      // A child that is still shutting down (tmux's pane after kill-server)
      // can write its drafts and state while the folder is being removed;
      // retry rather than fail the test with ENOTEMPTY.
      if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
    rawSince: (mark) => raw.slice(mark),
  };
  return s;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The screen below the spinner (queue, input box, status line): the part
 * that can settle while a reply is still streaming above it. */
export function belowSpinner(s: Session): string {
  const l = s.screen();
  let i = -1;
  l.forEach((x, k) => {
    if (/esc to (interrupt|cancel)\)/.test(x)) i = k;
  });
  return l.slice(i + 1).join('\n');
}
