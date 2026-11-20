// Clipboard: copy text and read images. macOS uses pbcopy/osascript; Linux
// uses wl-clipboard under Wayland or xclip/xsel under X11. Over SSH (or when
// no helper exists) text is copied with the OSC 52 escape sequence.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overSsh, inTmux } from './caps.js';

export class ClipboardError extends Error {}

function has(cmd: string): boolean {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return r.status === 0;
}

function runInput(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
    p.stdin.end(input);
  });
}

export function osc52(text: string): string {
  const seq = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  // tmux needs passthrough wrapping unless set-clipboard is on; wrapping is
  // harmless either way.
  return inTmux() ? `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : seq;
}

export interface CopyResult {
  method: string;
}

export async function copyText(text: string, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<CopyResult> {
  if (overSsh()) {
    write(osc52(text));
    return { method: 'OSC 52 (terminal clipboard)' };
  }
  if (process.platform === 'darwin') {
    if (await runInput('pbcopy', [], text)) return { method: 'pbcopy' };
  } else {
    const wayland = !!process.env.WAYLAND_DISPLAY;
    if (wayland && has('wl-copy') && (await runInput('wl-copy', [], text))) return { method: 'wl-copy' };
    if (process.env.DISPLAY) {
      if (has('xclip') && (await runInput('xclip', ['-selection', 'clipboard'], text))) return { method: 'xclip' };
      if (has('xsel') && (await runInput('xsel', ['--clipboard', '--input'], text))) return { method: 'xsel' };
    }
  }
  // Last resort: most modern terminals accept OSC 52.
  write(osc52(text));
  return { method: 'OSC 52 (terminal clipboard)' };
}

export function clipboardHelpHint(): string {
  if (process.platform === 'darwin') return '';
  if (process.env.WAYLAND_DISPLAY) return 'Install wl-clipboard (sudo apt install wl-clipboard).';
  return 'Install xclip (sudo apt install xclip).';
}

export interface ClipboardImage {
  data: Buffer;
  mediaType: string;
}

/** Read an image from the clipboard; null when the clipboard holds none. */
export async function readImage(): Promise<ClipboardImage | null> {
  if (overSsh()) throw new ClipboardError('Image paste is not available over SSH — the clipboard is on your local machine. Attach the file with @ instead.');
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'parley-'));
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

export function detectClipboardHelper(): { ok: boolean; detail: string } {
  if (overSsh()) return { ok: true, detail: 'SSH session: copy uses OSC 52; image paste is unavailable' };
  if (process.platform === 'darwin') return { ok: true, detail: 'pbcopy / osascript (built in)' };
  if (process.env.WAYLAND_DISPLAY) return has('wl-copy') ? { ok: true, detail: 'wl-clipboard (Wayland)' } : { ok: false, detail: 'Wayland session but wl-clipboard is missing — sudo apt install wl-clipboard' };
  if (process.env.DISPLAY) {
    if (has('xclip')) return { ok: true, detail: 'xclip (X11)' };
    if (has('xsel')) return { ok: true, detail: 'xsel (X11; image paste needs xclip)' };
    return { ok: false, detail: 'X11 session but xclip is missing — sudo apt install xclip' };
  }
  return { ok: true, detail: 'no graphical session: copy uses OSC 52; image paste unavailable' };
}
