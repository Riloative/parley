// Clipboard: copy text and read images.
//
// Copying tries, in order: a `clipboard_command` from the config; the
// platform's own tool (pbcopy, clip.exe under WSL, wl-copy under Wayland,
// xclip or xsel under X11); tmux's paste buffer when inside tmux; and the
// OSC 52 escape sequence, which asks the terminal to set its clipboard.
// Only a tool's exit status confirms a copy. OSC 52 is never confirmed by the
// terminal, and some terminals (every VTE-based one: GNOME Terminal, Ptyxis,
// Tilix, Terminator...) ignore it, so it is reported as sent, not copied.
// A method that fails (cannot be started, hangs, exits with an error, or
// does not read the text) never stops the next from being tried, and what
// failed is part of the outcome even when a later method worked.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { overSsh, inTmux } from './caps.js';

export class ClipboardError extends Error {}

/** Is `cmd` an executable on PATH? (No shell: PATH is searched directly.) */
export function has(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Windows Subsystem for Linux: the Windows clipboard is reached through clip.exe. */
export function inWsl(env: NodeJS.ProcessEnv = process.env, procVersion?: string): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  let v = procVersion;
  if (v === undefined) {
    try {
      v = readFileSync('/proc/version', 'utf8');
    } catch {
      v = '';
    }
  }
  return /microsoft|wsl/i.test(v);
}

export type ClipboardMode = 'auto' | 'native' | 'osc52' | 'off';

/** Terminals accept OSC 52 strings up to some size (xterm and others: about
 * 100,000 bytes); beyond it they drop or truncate the copy without a word. */
export const OSC52_MAX_BYTES = 100_000;

export type CopyMethod =
  | { kind: 'command'; name: string; command: string; args: string[]; encoding: 'utf8' | 'utf16le-bom'; why: string; /** The clipboard_command it came from. */ configured?: string }
  | { kind: 'tmux'; name: 'tmux'; why: string }
  | { kind: 'osc52'; name: 'OSC 52'; wrap: 'none' | 'tmux' | 'screen'; why: string };

/** A method that was tried, or should have been, and did not work. */
export interface CopyFailure {
  /** "xclip", or `clipboard_command "my-copy --in"`. */
  method: string;
  reason: string;
  /** It is the user's own clipboard_command: they expect it to be in use. */
  configured: boolean;
}

export interface CopyPlan {
  mode: ClipboardMode;
  methods: CopyMethod[];
  /** Methods not used, and why ("wl-copy: not installed"). */
  skipped: string[];
  /** A clipboard_command that cannot be run at all (no program name...). */
  problems: CopyFailure[];
  /** What to install or change when nothing works. */
  hint?: string;
}

export interface ClipboardContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  has: (cmd: string) => boolean;
  wsl: boolean;
}

export function currentContext(env: NodeJS.ProcessEnv = process.env): ClipboardContext {
  return { env, platform: process.platform, has: (c) => has(c, env), wsl: process.platform === 'linux' && inWsl(env) };
}

/** VTE (GNOME Terminal, Ptyxis, Tilix, Terminator, ...) ignores OSC 52. */
function terminalIgnoresOsc52(env: NodeJS.ProcessEnv): boolean {
  return !!env.VTE_VERSION && !overSsh(env) && !inTmux(env);
}

function installHint(ctx: ClipboardContext): string | undefined {
  if (ctx.platform !== 'linux' || ctx.wsl) return undefined;
  let id = '';
  try {
    const os = readFileSync('/etc/os-release', 'utf8');
    id = `${/^ID=(.*)$/m.exec(os)?.[1] ?? ''} ${/^ID_LIKE=(.*)$/m.exec(os)?.[1] ?? ''}`.replace(/"/g, '');
  } catch {
    /* unknown distribution */
  }
  const pkg = ctx.env.WAYLAND_DISPLAY ? 'wl-clipboard' : 'xclip';
  const cmd = /fedora|rhel|centos/.test(id) ? `sudo dnf install ${pkg}` : /arch/.test(id) ? `sudo pacman -S ${pkg}` : /suse/.test(id) ? `sudo zypper install ${pkg}` : `sudo apt install ${pkg}`;
  return `Install ${pkg} (${cmd}).`;
}

const WORDS = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

/** Split a configured command into words. No shell runs it: quotes group
 * words, and nothing else is special (no $VAR, no backslash outside double
 * quotes, no globbing), except that an unquoted word starting with `~/` gets
 * the home directory when `home` is given. */
export function splitCommand(cmd: string, home?: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(WORDS)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(home && m[3]!.startsWith('~/') ? join(home, m[3]!.slice(2)) : m[3]!);
  }
  return out;
}

/** Why a clipboard_command cannot be run as written, or undefined. */
export function clipboardCommandProblem(cmd: string): string | undefined {
  if (cmd.includes('\0')) return 'contains a NUL character';
  const words = [...cmd.matchAll(WORDS)];
  // A quote that opens a word and never closes is read as part of the word.
  if (words.some((m) => m[3] !== undefined && /^["']/.test(m[3]))) return 'has a quote that is never closed';
  if (words.length && !splitCommand(cmd)[0]!.trim()) return 'has no program name (its first word is empty)';
  return undefined;
}

const configuredName = (raw: string) => `clipboard_command ${JSON.stringify(raw.replace(/\0/g, ''))}`;

/** Which copy methods apply here, in the order they are tried. Pure: every
 * input is in `ctx`, so it is unit-tested for each environment. */
export function planCopy(opts: { mode?: ClipboardMode; command?: string }, ctx: ClipboardContext): CopyPlan {
  const mode = opts.mode ?? 'auto';
  const { env } = ctx;
  const plan: CopyPlan = { mode, methods: [], skipped: [], problems: [] };
  if (mode === 'off') return plan;
  const tool = (name: string, args: string[], why: string, encoding: 'utf8' | 'utf16le-bom' = 'utf8') => {
    if (ctx.has(name)) plan.methods.push({ kind: 'command', name, command: name, args, encoding, why });
    else plan.skipped.push(`${name}: not installed`);
  };
  if (opts.command?.trim() && mode !== 'osc52') {
    const raw = opts.command.trim();
    const problem = clipboardCommandProblem(raw);
    const [command, ...args] = splitCommand(raw, env.HOME);
    if (problem || !command) plan.problems.push({ method: configuredName(raw), reason: problem ?? 'has no program name', configured: true });
    else plan.methods.push({ kind: 'command', name: command.split('/').pop() || command, command, args, encoding: 'utf8', why: 'clipboard_command in the config', configured: raw });
  }
  const ssh = overSsh(env);
  if (mode === 'auto' || mode === 'native') {
    if (ssh && mode === 'auto') {
      plan.skipped.push('native tools: this is an SSH session, so they would copy on the remote machine');
    } else if (ctx.platform === 'darwin') {
      tool('pbcopy', [], 'macOS');
    } else if (ctx.platform === 'linux') {
      // WSL first: WSLg also sets WAYLAND_DISPLAY, but its clipboard does not
      // always reach Windows; clip.exe does. clip.exe reads UTF-16 with a BOM.
      if (ctx.wsl) tool('clip.exe', [], 'WSL: the Windows clipboard', 'utf16le-bom');
      if (env.WAYLAND_DISPLAY) tool('wl-copy', [], 'Wayland session');
      if (env.DISPLAY) {
        tool('xclip', ['-selection', 'clipboard'], 'X11 session');
        tool('xsel', ['--clipboard', '--input'], 'X11 session');
      }
      if (!ctx.wsl && !env.WAYLAND_DISPLAY && !env.DISPLAY) plan.skipped.push('native tools: no graphical session (neither WAYLAND_DISPLAY nor DISPLAY is set)');
    }
  }
  const tmux = !!env.TMUX;
  if (mode === 'auto' && tmux) plan.methods.push({ kind: 'tmux', name: 'tmux', why: 'inside tmux: its paste buffer, which tmux passes on to the terminal' });
  if (mode === 'auto' || mode === 'osc52') {
    if (mode === 'auto' && terminalIgnoresOsc52(env)) {
      plan.skipped.push('OSC 52: this terminal ignores it (VTE-based: GNOME Terminal, Ptyxis, Tilix and others)');
    } else {
      const wrap = tmux ? 'tmux' : env.STY ? 'screen' : 'none';
      plan.methods.push({ kind: 'osc52', name: 'OSC 52', wrap, why: ssh ? 'SSH session: the terminal on your own machine' : 'the terminal' });
    }
  }
  plan.hint = installHint(ctx);
  return plan;
}

/** The OSC 52 sequence, wrapped for tmux or screen passthrough when needed. */
export function osc52(text: string, wrap: 'none' | 'tmux' | 'screen' = inTmux() ? 'tmux' : 'none'): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const seq = `\x1b]52;c;${b64}\x07`;
  if (wrap === 'tmux') return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  if (wrap === 'screen') {
    // screen limits a DCS string to 768 bytes: send it in pieces.
    const chunks = seq.match(/[\s\S]{1,760}/g) ?? [];
    return chunks.map((c) => `\x1bP${c}\x1b\\`).join('');
  }
  return seq;
}

/** How long a tool may take, and how long after SIGTERM it gets SIGKILL. */
const COPY_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;

/** Process groups of copy tools that have not exited yet, or were told to
 * stop and may not have. Never a tool that finished: xclip and wl-copy leave
 * a process behind that serves the selection, and it must live on. */
const pendingGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // The tool is the leader of its own process group (`detached`), so this
    // reaches the children of a wrapper script as well.
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

/** Kill every copy tool that is still pending. Runs when taria exits (it is
 * synchronous), so that a hung tool does not outlive the program. */
export function killPendingCopies(): void {
  for (const pid of pendingGroups) killGroup(pid, 'SIGKILL');
  pendingGroups.clear();
}

function run(command: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv, timeoutMs = COPY_TIMEOUT_MS): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const timers: { timeout?: NodeJS.Timeout } = {};
    const finish = (r: { ok: boolean; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timers.timeout);
      resolve(r);
    };
    // Detached: wl-copy, xclip and xsel leave a process behind that owns the
    // clipboard; in its own session it survives the terminal closing.
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true, env });
    } catch (e) {
      // spawn() throws for a command it will not even try (an empty name, a
      // NUL character): a failed method like any other.
      const code = (e as NodeJS.ErrnoException).code;
      return finish({ ok: false, reason: `could not be started${code ? ` (${code})` : ''}` });
    }
    const pid = p.pid;
    if (pid !== undefined) {
      pendingGroups.add(pid);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on('exit', killPendingCopies);
      }
    }
    timers.timeout = setTimeout(() => {
      finish({ ok: false, reason: `did not finish within ${timeoutMs / 1000} s` });
      if (pid === undefined) return;
      killGroup(pid, 'SIGTERM');
      // Whatever is left of the group after the grace period ignored SIGTERM.
      // The group stays in `pendingGroups` until then, so an exit in between
      // kills it too.
      setTimeout(
        () => {
          killGroup(pid, 'SIGKILL');
          pendingGroups.delete(pid);
        },
        Math.min(KILL_GRACE_MS, timeoutMs),
      ).unref();
    }, timeoutMs);
    // Writing the text failed (EPIPE): the tool closed its input or exited
    // before it had read everything, so its exit status 0 confirms nothing.
    let unread = false;
    p.on('error', (e) => {
      if (pid !== undefined && !done) pendingGroups.delete(pid);
      finish({ ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (e as NodeJS.ErrnoException).code === 'EACCES' ? 'is not an executable file' : e.message });
    });
    p.on('close', (code, signal) => {
      // Finished by itself: from here on its group is none of taria's business.
      if (pid !== undefined && !done) pendingGroups.delete(pid);
      if (code !== 0) return finish({ ok: false, reason: signal ? `stopped by ${signal}` : `exited with status ${code}` });
      finish(unread ? { ok: false, reason: 'exited without reading the text' } : { ok: true });
    });
    p.stdin!.on('error', () => {
      unread = true;
    });
    p.stdin!.end(input);
    p.unref();
  });
}

export type CopyOutcome =
  /** A tool took the text and said so (exit status 0). */
  | { status: 'copied'; via: string; tried: string[]; failed: CopyFailure[] }
  /** Handed on, but nobody confirmed it reached the clipboard. */
  | { status: 'sent'; via: 'OSC 52' | 'tmux'; tried: string[]; failed: CopyFailure[] }
  | { status: 'failed'; tried: string[]; failed: CopyFailure[]; hint?: string; /** OSC 52 was the method left, and there is no terminal to send it to. */ noTerminal?: boolean }
  | { status: 'off' };
// `tried` is everything that did not copy, as text: methods skipped and
// methods that failed. `failed` holds only those that were run (or should
// have been: a clipboard_command that cannot be run), also on success.

export interface CopyOptions {
  mode?: ClipboardMode;
  command?: string;
  /** Where OSC 52 is written (default: stdout). `null`: there is no terminal
   * to write to, so OSC 52 is skipped. */
  write?: ((s: string) => void) | null;
  ctx?: ClipboardContext;
  /** How long one tool may take (tests shorten it). */
  timeoutMs?: number;
}

/** "wl-copy: exited with status 1; clipboard_command "x": not found". */
export function describeFailures(failed: CopyFailure[]): string {
  return failed.map((f) => `${f.method}: ${f.reason}`).join('; ');
}

export async function copyText(text: string, opts: CopyOptions = {}): Promise<CopyOutcome> {
  const ctx = opts.ctx ?? currentContext();
  const write = opts.write === undefined ? (s: string) => process.stdout.write(s) : opts.write;
  const plan = planCopy({ mode: opts.mode, command: opts.command }, ctx);
  if (plan.mode === 'off') return { status: 'off' };
  const tried = [...plan.skipped];
  const failed: CopyFailure[] = [];
  let noTerminal = false;
  const fail = (f: CopyFailure) => {
    failed.push(f);
    tried.push(`${f.method}: ${f.reason}`);
  };
  plan.problems.forEach(fail);
  for (const m of plan.methods) {
    if (m.kind === 'command') {
      const input = m.encoding === 'utf16le-bom' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8');
      const r = await run(m.command, m.args, input, ctx.env, opts.timeoutMs);
      if (r.ok) return { status: 'copied', via: m.name, tried, failed };
      fail({ method: m.configured === undefined ? m.name : configuredName(m.configured), reason: r.reason ?? 'failed', configured: m.configured !== undefined });
    } else if (m.kind === 'tmux') {
      // -w also sets the terminal's clipboard (tmux 3.2+); older tmux only
      // fills its paste buffer.
      let r = await run('tmux', ['load-buffer', '-w', '-'], Buffer.from(text, 'utf8'), ctx.env, opts.timeoutMs);
      if (!r.ok) r = await run('tmux', ['load-buffer', '-'], Buffer.from(text, 'utf8'), ctx.env, opts.timeoutMs);
      if (r.ok) return { status: 'sent', via: 'tmux', tried, failed };
      fail({ method: 'tmux', reason: r.reason ?? 'failed', configured: false });
    } else if (!write) {
      noTerminal = true;
      tried.push('OSC 52: not sent (the output is not a terminal)');
    } else {
      const bytes = Buffer.byteLength(text, 'utf8');
      const encoded = Math.ceil(bytes / 3) * 4;
      if (encoded > OSC52_MAX_BYTES) {
        tried.push(`OSC 52: too large (${Math.round(bytes / 1024)} KB; terminals accept about ${Math.floor((OSC52_MAX_BYTES * 3) / 4 / 1024)} KB)`);
        continue;
      }
      write(osc52(text, m.wrap));
      return { status: 'sent', via: 'OSC 52', tried, failed };
    }
  }
  return { status: 'failed', tried, failed, hint: plan.hint, ...(noTerminal ? { noTerminal } : {}) };
}

export function clipboardHelpHint(): string {
  return installHint(currentContext()) ?? '';
}

export interface ClipboardImage {
  data: Buffer;
  mediaType: string;
}

/** Read an image from the clipboard; null when the clipboard holds none. */
export async function readImage(): Promise<ClipboardImage | null> {
  if (overSsh()) throw new ClipboardError('Image paste is not available over SSH — the clipboard is on your local machine. Attach the file with @ instead.');
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'taria-'));
    const out = join(dir, 'clip.png');
    try {
      const script = `set f to POSIX file "${out}"\ntry\nset d to the clipboard as «class PNGf»\non error\nreturn "none"\nend try\nset h to open for access f with write permission\nwrite d to h\nclose access h\nreturn "ok"`;
      const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 });
      if (r.stdout.trim() !== 'ok') return null;
      return { data: readFileSync(out), mediaType: 'image/png' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const wayland = !!process.env.WAYLAND_DISPLAY;
  if (wayland) {
    if (!has('wl-paste')) throw new ClipboardError('Reading images from the clipboard needs wl-clipboard. Install it with: sudo apt install wl-clipboard');
    const types = spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8', timeout: 3000 }).stdout ?? '';
    const t = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find((x) => types.split('\n').includes(x));
    if (!t) return null;
    const r = spawnSync('wl-paste', ['--type', t], { timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 && r.stdout.length ? { data: r.stdout, mediaType: t } : null;
  }
  if (process.env.DISPLAY) {
    if (!has('xclip')) throw new ClipboardError('Reading images from the clipboard needs xclip. Install it with: sudo apt install xclip');
    const targets = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { encoding: 'utf8', timeout: 3000 }).stdout ?? '';
    const t = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find((x) => targets.split('\n').includes(x));
    if (!t) return null;
    const r = spawnSync('xclip', ['-selection', 'clipboard', '-t', t, '-o'], { timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 && r.stdout.length ? { data: r.stdout, mediaType: t } : null;
  }
  throw new ClipboardError('No graphical session found (neither WAYLAND_DISPLAY nor DISPLAY is set), so the clipboard cannot be read.');
}

/** Is this program there to be run? A path is checked as it is; a bare name
 * is looked up on PATH. */
function programExists(command: string, ctx: ClipboardContext): boolean {
  if (!command.includes('/')) return ctx.has(command);
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** For `doctor`: the method /copy would use here, and why. */
export function detectClipboardHelper(opts: { mode?: ClipboardMode; command?: string } = {}, ctx = currentContext()): { ok: boolean; detail: string; plan: CopyPlan; /** What to change, when it is not the install hint. */ fix?: string } {
  const plan = planCopy(opts, ctx);
  if (plan.mode === 'off') return { ok: true, detail: 'copying is turned off (clipboard: off)', plan };
  // A clipboard_command that cannot work is never "fine": say so, and what
  // /copy falls back to.
  const broken = [...plan.problems];
  let methods = plan.methods;
  const head = methods[0];
  if (head?.kind === 'command' && head.configured !== undefined && !programExists(head.command, ctx)) {
    broken.push({ method: configuredName(head.configured), reason: `${head.command} was not found${head.command.includes('/') ? '' : ' on PATH'}, or is not executable`, configured: true });
    methods = methods.slice(1);
  }
  const first = methods[0];
  if (broken.length) {
    const next = !first ? 'nothing else can copy here' : `/copy falls back to ${first.kind === 'osc52' ? 'OSC 52, which the terminal does not confirm' : first.kind === 'tmux' ? "tmux's paste buffer" : first.name}`;
    return { ok: false, detail: `${describeFailures(broken)}; ${next}`, plan, fix: 'Correct clipboard_command in the config file, or remove it.' };
  }
  if (!first) return { ok: false, detail: `nothing can copy here: ${plan.skipped.join('; ')}`, plan };
  if (first.kind === 'command') return { ok: true, detail: `${first.name} (${first.why})`, plan };
  if (first.kind === 'tmux') return { ok: true, detail: `tmux paste buffer, passed on to the terminal (not confirmed by the terminal)`, plan };
  return { ok: !plan.skipped.some((x) => x.startsWith('wl-copy') || x.startsWith('xclip')), detail: `OSC 52 to ${first.why}: the terminal does not confirm it, and some terminals ignore it`, plan };
}

/** Read the clipboard back with the platform's paste tool, if there is one. */
export function readBackText(ctx = currentContext()): string | undefined {
  const tryRun = (cmd: string, args: string[]) => {
    if (!ctx.has(cmd)) return undefined;
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, env: ctx.env });
    return r.status === 0 ? r.stdout : undefined;
  };
  if (ctx.platform === 'darwin') return tryRun('pbpaste', []);
  if (ctx.wsl) {
    const v = tryRun('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
    if (v !== undefined) return v.replace(/\r?\n$/, '').replace(/\r\n/g, '\n');
  }
  if (ctx.env.WAYLAND_DISPLAY) {
    const v = tryRun('wl-paste', ['--no-newline']);
    if (v !== undefined) return v;
  }
  if (ctx.env.DISPLAY) return tryRun('xclip', ['-selection', 'clipboard', '-o']) ?? tryRun('xsel', ['--clipboard', '--output']);
  return undefined;
}
