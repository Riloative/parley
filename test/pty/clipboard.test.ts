// /copy: which clipboard method is used, what reaches it, and that success is
// only claimed when it was confirmed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { makeHome, spawnParley, sleep, testEnv, type Session } from './harness.js';
import { parleyCommand } from '../build-once.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const all = () => s!.all().map((l) => l.trimEnd()).join('\n');
/** The transcript as one line, so a wrapped message can be matched. */
const flat = () => s!.all().map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
const DOWN = '\x1b[B';

/** A directory to use as PATH, holding fake clipboard tools that record
 * their arguments and stdin. */
function fakeBin(home: string, tools: Record<string, number> = {}): string {
  const dir = join(home, 'fakebin');
  mkdirSync(dir, { recursive: true });
  for (const [name, exit] of Object.entries(tools)) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.args"\n/bin/cat > "${dir}/${name}.stdin"\nexit ${exit}\n`);
    chmodSync(f, 0o755);
  }
  return dir;
}

async function reply(): Promise<void> {
  s!.write('x\r');
  await s!.waitFor('sys.exit(main(sys.argv))');
  await s!.waitStable({ lastLine: 'Send a message' });
}

const DESKTOP = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };

// The platform decides the native tool (planCopy is unit-tested for every
// platform); these run the Linux paths on a Linux host, and the macOS path on
// a Mac.
const onLinux = process.platform === 'linux';

describe.runIf(onLinux)('/copy on a Linux desktop', () => {
  it('without wl-copy or xclip, in a VTE terminal (Ptyxis, GNOME Terminal), says nothing was copied instead of claiming it was', async () => {
    const home = makeHome();
    s = spawnParley({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, VTE_VERSION: '8002', PATH: fakeBin(home) } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy code\r');
    await s.waitFor('Nothing was copied');
    await s.waitStable();
    expect(flat()).not.toMatch(/Copied|Sent .* to the terminal/);
    expect(flat()).toMatch(/wl-copy: not installed/);
    expect(flat()).toMatch(/OSC 52: this terminal ignores it/);
    expect(flat()).toMatch(/wl-clipboard/);
    // Nothing was written to the terminal that it would ignore anyway.
    expect(s.raw).not.toContain('\x1b]52;');
    // Offered instead: write it to a file.
    await s.waitFor('Write it to a file instead?');
    s.write(`${DOWN}\r`);
    await s.waitFor(/Wrote the last code block to (\S+)/);
    const file = /Wrote the last code block to (\S+?)\.?\s*$/m.exec(all())![1]!;
    expect(readFileSync(file, 'utf8')).toMatch(/^import sys\n\ndef main/);
  }, 30_000);

  it('uses wl-copy when it is installed, passing the text on stdin', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'wl-copy': 0 });
    s = spawnParley({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, VTE_VERSION: '8002', PATH: bin } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy code\r');
    await s.waitFor(/Copied the last code block \([\d,]+ characters\) via wl-copy\./);
    expect(readFileSync(join(bin, 'wl-copy.stdin'), 'utf8')).toMatch(/^import sys\n\ndef main/);
    expect(s.raw).not.toContain('\x1b]52;');
  }, 30_000);

  it('a native tool that fails is reported, and the next method is tried', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'wl-copy': 1, xclip: 0 });
    s = spawnParley({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, PATH: bin } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy\r');
    await s.waitFor('via xclip');
    expect(readFileSync(join(bin, 'xclip.args'), 'utf8').trim().split('\n')).toEqual(['-selection', 'clipboard']);
    expect(existsSync(join(bin, 'wl-copy.stdin'))).toBe(true);
  }, 30_000);
});

describe.runIf(process.platform === 'darwin')('/copy on macOS', () => {
  it('uses pbcopy, passing the text on stdin; doctor clipboard reads it back with pbpaste', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { pbcopy: 0 });
    writeFileSync(join(bin, 'pbpaste'), `#!/bin/sh\n/bin/cat "${bin}/pbcopy.stdin"\n`);
    chmodSync(join(bin, 'pbpaste'), 0o755);
    s = spawnParley({ cols: 100, rows: 30, home, env: { PATH: bin } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor(/Copied the last response \(12 characters\) via pbcopy\./);
    expect(readFileSync(join(bin, 'pbcopy.stdin'), 'utf8')).toBe('You said: hi');
    expect(s.raw).not.toContain('\x1b]52;');
    const cmd = parleyCommand(['doctor', 'clipboard']);
    const r = spawnSync(cmd.command, cmd.args, { env: testEnv(home, { NO_COLOR: '1', PATH: bin }), encoding: 'utf8', timeout: 20_000 });
    expect(r.stdout).toMatch(/Test copy\s+copied with pbcopy and read back/);
  }, 30_000);
});

describe('/copy elsewhere', () => {
  it.runIf(onLinux)('WSL: uses clip.exe, with the text as UTF-16 so non-ASCII survives', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'clip.exe': 0 });
    s = spawnParley({ cols: 100, rows: 30, home, env: { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    s.write('héllo ✓\r');
    await s.waitFor('You said: héllo ✓');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('via clip.exe');
    const bytes = readFileSync(join(bin, 'clip.exe.stdin'));
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe('You said: héllo ✓');
  }, 30_000);

  it('SSH: sends OSC 52 (exact bytes) and says the terminal does not confirm it', async () => {
    const home = makeHome();
    s = spawnParley({ cols: 100, rows: 30, home, env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor("to the terminal's clipboard (OSC 52)");
    expect(s.raw).toContain(`\x1b]52;c;${Buffer.from('You said: hi').toString('base64')}\x07`);
    expect(all()).not.toMatch(/Copied the last response/);
    expect(all()).toContain('doctor');
  }, 30_000);

  it('inside tmux: hands the text to tmux (load-buffer -w), and falls back to a passthrough-wrapped OSC 52', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { tmux: 0 });
    s = spawnParley({ cols: 100, rows: 30, home, env: { TMUX: '/tmp/tmux-1/default,1,0', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor("tmux's paste buffer");
    expect(readFileSync(join(bin, 'tmux.args'), 'utf8').trim().split('\n')).toEqual(['load-buffer', '-w', '-']);
    expect(readFileSync(join(bin, 'tmux.stdin'), 'utf8')).toBe('You said: hi');
    expect(s.raw).not.toContain('\x1b]52;');
    await s.close();

    const home2 = makeHome();
    const bin2 = fakeBin(home2, { tmux: 1 });
    s = spawnParley({ cols: 100, rows: 30, home: home2, env: { TMUX: '/tmp/tmux-1/default,1,0', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin2 } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor("to the terminal's clipboard (OSC 52)");
    const inner = `\x1b]52;c;${Buffer.from('You said: hi').toString('base64')}\x07`;
    expect(s.raw).toContain(`\x1bPtmux;${inner.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`);
  }, 40_000);

  it('a custom clipboard_command gets the text on stdin; clipboard: off disables /copy', async () => {
    const home = makeHome(`default_model: mock/echo\ntheme: dark\nbell: false\nclipboard_command: mycopy --primary\nproviders:\n  mock:\n    type: mock\n`);
    const bin = fakeBin(home, { mycopy: 0 });
    s = spawnParley({ cols: 100, rows: 30, home, env: { DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('via mycopy');
    expect(readFileSync(join(bin, 'mycopy.args'), 'utf8').trim()).toBe('--primary');
    expect(readFileSync(join(bin, 'mycopy.stdin'), 'utf8')).toBe('You said: hi');
    await s.close();

    s = spawnParley({ cols: 100, rows: 30, config: `default_model: mock/echo\ntheme: dark\nbell: false\nclipboard: off\nproviders:\n  mock:\n    type: mock\n`, env: { SSH_TTY: '/dev/pts/9' } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('Copying is turned off (clipboard: off)');
    expect(s.raw).not.toContain('\x1b]52;');
  }, 40_000);

  it('text too large for OSC 52 is not sent; a file is offered instead', async () => {
    const home = makeHome();
    s = spawnParley({ cols: 100, rows: 30, home, args: ['-m', 'mock/long?lines=4000&tps=0'], env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('The end.', 20_000);
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('Nothing was copied');
    expect(flat()).toMatch(/OSC 52: too large/);
    expect(s.raw).not.toContain('\x1b]52;');
    await s.waitFor('Write it to a file instead?');
    await sleep(50);
  }, 40_000);
});

describe('parley doctor clipboard', () => {
  const doctor = (home: string, env: Record<string, string>) => {
    const cmd = parleyCommand(['doctor', 'clipboard']);
    return spawnSync(cmd.command, cmd.args, { env: testEnv(home, { NO_COLOR: '1', ...env }), encoding: 'utf8', timeout: 20_000 });
  };

  it.runIf(onLinux)('copies a test line and reads it back with the paste tool', () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'wl-copy': 0 });
    writeFileSync(join(bin, 'wl-paste'), `#!/bin/sh\n/bin/cat "${bin}/wl-copy.stdin"\n`);
    chmodSync(join(bin, 'wl-paste'), 0o755);
    const r = doctor(home, { ...DESKTOP, PATH: bin });
    expect(r.stdout).toMatch(/\/copy uses|Method\s+wl-copy \(Wayland session\)/);
    expect(r.stdout).toMatch(/Test copy\s+copied with wl-copy and read back/);
    expect(readFileSync(join(bin, 'wl-copy.stdin'), 'utf8')).toMatch(/^parley clipboard test \d\d:\d\d:\d\d$/);
    expect(r.status).toBe(0);
  });

  it.runIf(onLinux)('says plainly when nothing can copy, with what to install, and fails', () => {
    const home = makeHome();
    const r = doctor(home, { ...DESKTOP, VTE_VERSION: '8002', PATH: fakeBin(home) });
    expect(r.stdout).toMatch(/Test copy\s+nothing was copied/);
    expect(r.stdout).toMatch(/Install wl-clipboard/);
    expect(r.stdout).not.toContain('\x1b]52;');
    expect(r.status).toBe(1);
  });

  it('for OSC 52, says it cannot be confirmed and what to paste to check', () => {
    const home = makeHome();
    const r = doctor(home, { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) });
    expect(r.stdout).toMatch(/sent "parley clipboard test [\d:]+" via OSC 52; the terminal does not confirm it/);
    expect(r.stdout).toMatch(/Paste now/);
    expect(r.stdout).toMatch(/\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);
  });
});
