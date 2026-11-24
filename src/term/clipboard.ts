// Clipboard: copy text and read images.
//
// Copying tries, in order: a `clipboard_command` from the config; the
// platform's own tool (pbcopy, clip.exe under WSL, wl-copy under Wayland,
// xclip or xsel under X11); tmux's paste buffer when inside tmux; and the
// OSC 52 escape sequence, which asks the terminal to set its clipboard.
// Only a tool's exit status confirms a copy. OSC 52 is never confirmed by the
// terminal, and some terminals (every VTE-based one: GNOME Terminal, Ptyxis,
// Tilix, Terminator...) ignore it, so it is reported as sent, not copied.

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
  | { kind: 'command'; name: string; command: string; args: string[]; encoding: 'utf8' | 'utf16le-bom'; why: string }
  | { kind: 'tmux'; name: 'tmux'; why: string }
  | { kind: 'osc52'; name: 'OSC 52'; wrap: 'none' | 'tmux' | 'screen'; why: string };

export interface CopyPlan {
  mode: ClipboardMode;
  methods: CopyMethod[];
  /** Methods not used, and why ("wl-copy: not installed"). */
  skipped: string[];
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

/** Split a configured command into words; quotes group words, no shell. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of cmd.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]!));
  return out;
}

/** Which copy methods apply here, in the order they are tried. Pure: every
 * input is in `ctx`, so it is unit-tested for each environment. */
export function planCopy(opts: { mode?: ClipboardMode; command?: string }, ctx: ClipboardContext): CopyPlan {
  const mode = opts.mode ?? 'auto';
  const { env } = ctx;
  const plan: CopyPlan = { mode, methods: [], skipped: [] };
  if (mode === 'off') return plan;
  const tool = (name: string, args: string[], why: string, encoding: 'utf8' | 'utf16le-bom' = 'utf8') => {
    if (ctx.has(name)) plan.methods.push({ kind: 'command', name, command: name, args, encoding, why });
    else plan.skipped.push(`${name}: not installed`);
  };
  if (opts.command?.trim() && mode !== 'osc52') {
    const [command, ...args] = splitCommand(opts.command.trim());
    plan.methods.push({ kind: 'command', name: command!.split('/').pop()!, command: command!, args, encoding: 'utf8', why: 'clipboard_command in the config' });
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

function run(command: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Detached: wl-copy, xclip and xsel leave a process behind that owns the
    // clipboard; in its own session it survives the terminal closing.
    const p = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true, env });
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* gone */
      }
      finish({ ok: false, reason: `did not finish within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    p.on('error', (e) => finish({ ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : e.message }));
    p.on('close', (code, signal) => finish(code === 0 ? { ok: true } : { ok: false, reason: signal ? `stopped by ${signal}` : `exited with status ${code}` }));
    p.stdin.on('error', () => {
      /* reported through close */
    });
    p.stdin.end(input);
    p.unref();
  });
}

export type CopyOutcome =
  /** A tool took the text and said so (exit status 0). */
  | { status: 'copied'; via: string; tried: string[] }
  /** Handed on, but nobody confirmed it reached the clipboard. */
  | { status: 'sent'; via: 'OSC 52' | 'tmux'; tried: string[] }
  | { status: 'failed'; tried: string[]; hint?: string }
  | { status: 'off' };

export interface CopyOptions {
  mode?: ClipboardMode;
  command?: string;
  write?: (s: string) => void;
  ctx?: ClipboardContext;
}

export async function copyText(text: string, opts: CopyOptions = {}): Promise<CopyOutcome> {
  const ctx = opts.ctx ?? currentContext();
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const plan = planCopy({ mode: opts.mode, command: opts.command }, ctx);
  if (plan.mode === 'off') return { status: 'off' };
  const tried = [...plan.skipped];
  for (const m of plan.methods) {
    if (m.kind === 'command') {
      const input = m.encoding === 'utf16le-bom' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8');
      const r = await run(m.command, m.args, input, ctx.env);
      if (r.ok) return { status: 'copied', via: m.name, tried };
      tried.push(`${m.name}: ${r.reason}`);
    } else if (m.kind === 'tmux') {
      // -w also sets the terminal's clipboard (tmux 3.2+); older tmux only
      // fills its paste buffer.
      let r = await run('tmux', ['load-buffer', '-w', '-'], Buffer.from(text, 'utf8'), ctx.env);
      if (!r.ok) r = await run('tmux', ['load-buffer', '-'], Buffer.from(text, 'utf8'), ctx.env);
      if (r.ok) return { status: 'sent', via: 'tmux', tried };
      tried.push(`tmux: ${r.reason}`);
    } else {
      const bytes = Buffer.byteLength(text, 'utf8');
      const encoded = Math.ceil(bytes / 3) * 4;
      if (encoded > OSC52_MAX_BYTES) {
        tried.push(`OSC 52: too large (${Math.round(bytes / 1024)} KB; terminals accept about ${Math.floor((OSC52_MAX_BYTES * 3) / 4 / 1024)} KB)`);
        continue;
      }
      write(osc52(text, m.wrap));
      return { status: 'sent', via: 'OSC 52', tried };
    }
  }
  return { status: 'failed', tried, hint: plan.hint };
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

/** For `doctor`: the method /copy would use here, and why. */
export function detectClipboardHelper(opts: { mode?: ClipboardMode; command?: string } = {}, ctx = currentContext()): { ok: boolean; detail: string; plan: CopyPlan } {
  const plan = planCopy(opts, ctx);
  if (plan.mode === 'off') return { ok: true, detail: 'copying is turned off (clipboard: off)', plan };
  const first = plan.methods[0];
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
