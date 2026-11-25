// /copy: which clipboard method is used, what reaches it, and that success is
// only claimed when it was confirmed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, makeHome, spawnTaria, sleep, testEnv, type Session } from './harness.js';
import { tariaCommand } from '../build-once.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const all = () => s!.all().map((l) => l.trimEnd()).join('\n');
/** The transcript as one line, so a wrapped message can be matched. */
const flat = () => s!.all().map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
const DOWN = '\x1b[B';
/** Command lines of running processes that contain `pattern`. */
const running = (pattern: string) =>
  spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l.includes(pattern));

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
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, VTE_VERSION: '8002', PATH: fakeBin(home) } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, VTE_VERSION: '8002', PATH: bin } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, PATH: bin } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, env: { PATH: bin } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor(/Copied the last response \(12 characters\) via pbcopy\./);
    expect(readFileSync(join(bin, 'pbcopy.stdin'), 'utf8')).toBe('You said: hi');
    expect(s.raw).not.toContain('\x1b]52;');
    const cmd = tariaCommand(['doctor', 'clipboard']);
    const r = spawnSync(cmd.command, cmd.args, { env: testEnv(home, { NO_COLOR: '1', PATH: bin }), encoding: 'utf8', timeout: 20_000 });
    expect(r.stdout).toMatch(/Test copy\s+copied with pbcopy and read back/);
  }, 30_000);
});

describe('/copy elsewhere', () => {
  it.runIf(onLinux)('WSL: uses clip.exe, with the text as UTF-16 so non-ASCII survives', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'clip.exe': 0 });
    s = spawnTaria({ cols: 100, rows: 30, home, env: { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, env: { TMUX: '/tmp/tmux-1/default,1,0', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
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
    s = spawnTaria({ cols: 100, rows: 30, home: home2, env: { TMUX: '/tmp/tmux-1/default,1,0', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin2 } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, env: { DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('via mycopy');
    expect(readFileSync(join(bin, 'mycopy.args'), 'utf8').trim()).toBe('--primary');
    expect(readFileSync(join(bin, 'mycopy.stdin'), 'utf8')).toBe('You said: hi');
    await s.close();

    s = spawnTaria({ cols: 100, rows: 30, config: `default_model: mock/echo\ntheme: dark\nbell: false\nclipboard: off\nproviders:\n  mock:\n    type: mock\n`, env: { SSH_TTY: '/dev/pts/9' } });
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
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/long?lines=4000&tps=0'], env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('The end.', 20_000);
    await s.waitStable({ lastLine: 'Send a message' });
    s.write('/copy\r');
    await s.waitFor('Nothing was copied');
    await s!.waitStable();
    expect(flat()).toMatch(/OSC 52: too large/);
    expect(s.raw).not.toContain('\x1b]52;');
    await s.waitFor('Write it to a file instead?');
    await sleep(50);
  }, 40_000);
});

describe('taria doctor clipboard', () => {
  const doctor = (home: string, env: Record<string, string>) => {
    const cmd = tariaCommand(['doctor', 'clipboard']);
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
    expect(readFileSync(join(bin, 'wl-copy.stdin'), 'utf8')).toMatch(/^taria clipboard test \d\d:\d\d:\d\d$/);
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

  it('for OSC 52, in a terminal: sends it, says it cannot be confirmed and what to paste to check', async () => {
    const home = makeHome();
    s = spawnTaria({ cols: 120, rows: 30, home, args: ['doctor', 'clipboard'], env: { NO_COLOR: '1', SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
    expect(await s.exited).toBe(0);
    await s.waitStable();
    expect(flat()).toMatch(/sent "taria clipboard test [\d:]+" via OSC 52; the terminal does not confirm it/);
    expect(flat()).toMatch(/Paste now/);
    expect(s.raw).toMatch(/\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);
  }, 30_000);

  it('for OSC 52, with the output piped or redirected: writes no escape sequence, and says the test was not run', () => {
    const home = makeHome();
    const r = doctor(home, { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) });
    expect(r.stdout).not.toContain('\x1b]52;');
    expect(r.stdout).toMatch(/Test copy\s+not run: OSC 52 is the method left here, and the output is not a terminal/);
    expect(r.stdout).toMatch(/Run `taria doctor clipboard` in the terminal itself/);
    expect(r.status).toBe(0);
  });

  it('a clipboard_command that cannot be run is a config error; doctor clipboard reports it, tests the other methods and does not crash', () => {
    for (const bad of [`'""'`, `'"/opt/my tools/copy --flag'`]) {
      const home = makeHome(`${DEFAULT_CONFIG}clipboard_command: ${bad}\n`);
      const bin = fakeBin(home, { mycopy: 0 });
      const r = doctor(home, { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: bin });
      expect(r.stdout + r.stderr).not.toMatch(/TypeError|ERR_INVALID|\n\s+at /);
      expect(r.stdout).toMatch(/✗ Config error\s+.*config\.yaml:\d+: clipboard_command has (no program name|a quote that is never closed)/);
      expect(r.stdout).toMatch(/Test copy\s+not run: OSC 52 is the method left here/);
      expect(r.status).toBe(1);
    }
  });

  /** An xclip that copies (stdin to a file) and pastes (-o prints the file). */
  const workingXclip = (bin: string) => {
    writeFileSync(join(bin, 'xclip'), `#!/bin/sh\ncase "$*" in *-o*) /bin/cat "${bin}/xclip.stdin";; *) /bin/cat > "${bin}/xclip.stdin";; esac\n`);
    chmodSync(join(bin, 'xclip'), 0o755);
  };

  // The method left after the broken command is xclip: a Linux desktop case, like its neighbours.
  it.runIf(onLinux)('a clipboard_command whose program does not exist: no tick in `taria doctor`; `doctor clipboard` lists it as tried and failed', () => {
    const home = makeHome(`${DEFAULT_CONFIG}clipboard_command: /nonexistent/copytool --flag\n`);
    const bin = fakeBin(home);
    workingXclip(bin);
    const env = testEnv(home, { NO_COLOR: '1', DISPLAY: ':0', WAYLAND_DISPLAY: '', PATH: bin });
    const cmd = tariaCommand(['doctor']);
    const summary = spawnSync(cmd.command, cmd.args, { env, encoding: 'utf8', timeout: 30_000 }).stdout;
    expect(summary).toMatch(/! \/copy uses\s+clipboard_command "\/nonexistent\/copytool --flag": \/nonexistent\/copytool was not found, or is not executable; \/copy falls back to xclip/);
    expect(summary).not.toMatch(/✓ \/copy uses/);
    expect(summary).toMatch(/→ Correct clipboard_command in the config file, or remove it/);
    const r = doctor(home, { DISPLAY: ':0', WAYLAND_DISPLAY: '', PATH: bin });
    expect(r.stdout).toMatch(/✗ Tried\s+clipboard_command "\/nonexistent\/copytool --flag": not found/);
    expect(r.stdout).toMatch(/✓ Test copy\s+copied with xclip and read back/);
    // The copy worked, but the configured command did not: that is a failure.
    expect(r.status).toBe(1);
  });

  it.runIf(onLinux)('a tool that fails before another works is listed as tried', () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'wl-copy': 3 });
    workingXclip(bin);
    const r = doctor(home, { ...DESKTOP, PATH: bin });
    expect(r.stdout).toMatch(/! Tried\s+wl-copy: exited with status 3/);
    expect(r.stdout).toMatch(/✓ Test copy\s+copied with xclip and read back/);
    expect(r.status).toBe(0);
  });

  it.runIf(onLinux)('a tool that hangs and ignores SIGTERM is killed, with its children, by the time doctor exits', () => {
    const home = makeHome();
    const bin = fakeBin(home);
    writeFileSync(join(bin, 'xclip'), '#!/bin/sh\ntrap "" TERM\nwhile :; do /bin/sleep 14142; done\n');
    chmodSync(join(bin, 'xclip'), 0o755);
    const r = doctor(home, { DISPLAY: ':0', WAYLAND_DISPLAY: '', PATH: bin });
    expect(r.stdout).toMatch(/! Tried\s+xclip: did not finish within 5 s/);
    expect(running('sleep 14142')).toEqual([]);
    expect(running(join(bin, 'xclip'))).toEqual([]);
  }, 30_000);
});

describe('/copy with a clipboard tool or command that does not work', () => {
  it.runIf(onLinux)('a hanging tool: typing still works, and quitting during the wait leaves nothing running', async () => {
    const home = makeHome();
    const bin = fakeBin(home);
    writeFileSync(join(bin, 'xclip'), '#!/bin/sh\n/bin/sleep 17321\n');
    chmodSync(join(bin, 'xclip'), 0o755);
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { DISPLAY: ':0', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy\r');
    await s.waitFor(() => running('sleep 17321').length > 0);
    s.write('still typing');
    await s.waitFor('still typing', 3000);
    s.write('\x15/exit\r');
    expect(await s.exited).toBe(0);
    await sleep(300);
    expect(running('sleep 17321')).toEqual([]);
    expect(running(join(bin, 'xclip'))).toEqual([]);
  }, 30_000);

  it.runIf(onLinux)('a clipboard_command that cannot be run is reported when taria starts, and /copy uses the next method', async () => {
    const home = makeHome(`${DEFAULT_CONFIG}clipboard_command: '""'\n`);
    const bin = fakeBin(home, { xclip: 0 });
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { DISPLAY: ':0', WAYLAND_DISPLAY: '', PATH: bin } });
    await s.waitFor('Send a message');
    await s.waitStable({ lastLine: 'Send a message' });
    expect(flat()).toMatch(/config\.yaml:\d+: clipboard_command has no program name/);
    await reply();
    s.write('/copy\r');
    await s.waitFor(/Copied the last response \([\d,]+ characters\) via xclip\./);
    await s.waitStable();
    expect(flat()).not.toMatch(/Copy failed|argument 'file'/);
    expect(readFileSync(join(bin, 'xclip.stdin'), 'utf8')).toMatch(/import sys/);
  }, 30_000);

  it('a mistyped clipboard_command is named, with the reason, also when a later method "works"', async () => {
    const home = makeHome(`${DEFAULT_CONFIG}clipboard_command: /usr/local/bin/my-copy-typo --in\n`);
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '', PATH: fakeBin(home) } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy\r');
    await s.waitFor("to the terminal's clipboard (OSC 52)");
    await s.waitStable();
    expect(flat()).toMatch(/Tried first, without success: clipboard_command "\/usr\/local\/bin\/my-copy-typo --in": not found\./);
    expect(s.raw).toContain('\x1b]52;c;');
  }, 30_000);

  it.runIf(onLinux)('a tool that fails before another copies is named in the notice', async () => {
    const home = makeHome();
    const bin = fakeBin(home, { 'wl-copy': 1, xclip: 0 });
    s = spawnTaria({ cols: 100, rows: 30, home, args: ['-m', 'mock/code'], env: { ...DESKTOP, PATH: bin } });
    await s.waitFor('Send a message');
    await reply();
    s.write('/copy\r');
    await s.waitFor('via xclip');
    await s.waitStable();
    expect(flat()).toMatch(/via xclip\. Tried first, without success: wl-copy: exited with status 1\./);
  }, 30_000);
});
