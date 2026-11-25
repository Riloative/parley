// copyText with real processes: tools that cannot be started, hang, ignore
// their input or daemonise; and what is reported when an earlier method failed.
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clipboardCommandProblem, copyText, detectClipboardHelper, killPendingCopies, planCopy, splitCommand, type ClipboardContext } from '../../src/term/clipboard.js';
import { parseConfig } from '../../src/config/config.js';

/** A directory of fake tools (shell scripts), used as the start of PATH. */
function fakeDir(tools: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'taria-clip-'));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
function ctxFor(dir: string, extra: Record<string, string> = {}): ClipboardContext {
  return { env: { PATH: `${dir}:/usr/bin:/bin`, ...extra }, platform: 'linux', wsl: false, has: (c) => existsSync(join(dir, c)) };
}
const X11 = { DISPLAY: ':0' };
const SSH = { SSH_TTY: '/dev/pts/9' };

/** Process ids whose command line contains `pattern`. */
function alive(pattern: string): number[] {
  const out = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes(pattern))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}
async function goneWithin(pattern: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive(pattern).length) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pattern).length;
}
const leftovers: string[] = [];
afterEach(() => {
  for (const pattern of leftovers.splice(0)) {
    for (const pid of alive(pattern)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const READS = 'cat > "$0.out"';

describe('a clipboard_command that cannot be run', () => {
  for (const command of ['""', "''", 'co\0py', '"   "']) {
    it(`${JSON.stringify(command)}: counts as failed, the next method is tried, and the failure is reported`, async () => {
      const dir = fakeDir({ xclip: READS });
      const r = await copyText('hello', { mode: 'auto', command, ctx: ctxFor(dir, X11), write: () => {} });
      expect(r).toMatchObject({ status: 'copied', via: 'xclip' });
      expect(readFileSync(join(dir, 'xclip.out'), 'utf8')).toBe('hello');
      if (r.status !== 'copied') return;
      expect(r.failed).toEqual([{ method: expect.stringMatching(/^clipboard_command/), reason: expect.stringMatching(/no program name|NUL character/), configured: true }]);
      expect(r.failed[0]!.reason).not.toMatch(/argument 'file'|ERR_/);
    });
  }

  it('planCopy does not plan a command without a program name', () => {
    for (const command of ['""', "''", '"" --flag', 'co\0py']) {
      const p = planCopy({ command }, ctxFor(fakeDir({}), X11));
      expect(p.methods.filter((m) => m.kind === 'command')).toEqual([]);
      expect(p.problems).toEqual([{ method: expect.stringMatching(/^clipboard_command/), reason: expect.any(String), configured: true }]);
    }
    expect(planCopy({ command: '   ' }, ctxFor(fakeDir({}), X11)).problems).toEqual([]);
  });

  it('a program that does not exist: reported with its name and why, also when a later method works', async () => {
    const dir = fakeDir({});
    const out: string[] = [];
    const r = await copyText('hi', { mode: 'auto', command: '/nonexistent/copytool --flag', ctx: ctxFor(dir, SSH), write: (s) => out.push(s) });
    expect(r).toMatchObject({ status: 'sent', via: 'OSC 52' });
    if (r.status !== 'sent') return;
    expect(r.failed).toEqual([{ method: 'clipboard_command "/nonexistent/copytool --flag"', reason: 'not found', configured: true }]);
    expect(out.join('')).toContain('\x1b]52;c;');
  });

  it('a native tool that fails before another works is in `failed`, not marked as configured', async () => {
    const dir = fakeDir({ xclip: 'cat > /dev/null; exit 3', xsel: READS });
    const r = await copyText('hi', { mode: 'native', ctx: ctxFor(dir, X11) });
    expect(r).toMatchObject({ status: 'copied', via: 'xsel', failed: [{ method: 'xclip', reason: 'exited with status 3', configured: false }] });
  });

  it('doctor\'s summary does not call a configured command fine when its program is missing', () => {
    const dir = fakeDir({ mycopy: READS, xclip: READS });
    const missing = detectClipboardHelper({ command: '/nonexistent/copytool --flag' }, ctxFor(dir, X11));
    expect(missing.ok).toBe(false);
    expect(missing.detail).toMatch(/clipboard_command.*\/nonexistent\/copytool.*not found.*xclip/);
    expect(detectClipboardHelper({ command: 'nosuchtool' }, ctxFor(dir, X11)).ok).toBe(false);
    expect(detectClipboardHelper({ command: 'mycopy -p' }, ctxFor(dir, X11))).toMatchObject({ ok: true, detail: 'mycopy (clipboard_command in the config)' });
    expect(detectClipboardHelper({ command: `${dir}/mycopy` }, ctxFor(dir, X11)).ok).toBe(true);
    expect(detectClipboardHelper({ command: '""' }, ctxFor(dir, X11)).ok).toBe(false);
  });

  it('without a terminal to write to, OSC 52 is skipped and nothing is written', async () => {
    const r = await copyText('hi', { mode: 'auto', ctx: ctxFor(fakeDir({}), SSH), write: null });
    expect(r).toMatchObject({ status: 'failed', noTerminal: true });
    if (r.status === 'failed') expect(r.tried.join('; ')).toMatch(/OSC 52: not sent \(the output is not a terminal\)/);
  });
});

describe('a clipboard tool that hangs', () => {
  it('is stopped after the timeout together with its child processes', async () => {
    leftovers.push('sleep 31415');
    const dir = fakeDir({ xclip: 'sleep 31415' });
    const r = await copyText('hello', { mode: 'native', ctx: ctxFor(dir, X11), timeoutMs: 300 });
    expect(r).toMatchObject({ status: 'failed', failed: [{ method: 'xclip', reason: 'did not finish within 0.3 s' }] });
    expect(await goneWithin('sleep 31415', 1500)).toBe(true);
  });

  it('is killed when it ignores SIGTERM', async () => {
    leftovers.push('sleep 27182');
    const dir = fakeDir({ xclip: 'trap "" TERM\nwhile :; do sleep 27182; done' });
    leftovers.push(join(dir, 'xclip'));
    const r = await copyText('hello', { mode: 'native', ctx: ctxFor(dir, X11), timeoutMs: 300 });
    expect(r.status).toBe('failed');
    // SIGTERM at the timeout, SIGKILL for the whole group after a short grace.
    expect(await goneWithin(join(dir, 'xclip'), 3000)).toBe(true);
    expect(await goneWithin('sleep 27182', 1000)).toBe(true);
  });

  it('is killed at once, with its children, when taria exits while the copy is pending', async () => {
    leftovers.push('sleep 17320');
    const dir = fakeDir({ xclip: 'trap "" TERM\nsleep 17320' });
    leftovers.push(join(dir, 'xclip'));
    const pending = copyText('hello', { mode: 'native', ctx: ctxFor(dir, X11), timeoutMs: 30_000 });
    for (const end = Date.now() + 3000; Date.now() < end && !alive('sleep 17320').length; ) await sleep(20);
    expect(alive('sleep 17320').length).toBe(1);
    killPendingCopies(); // what process.on('exit') runs
    expect(await goneWithin('sleep 17320', 1500)).toBe(true);
    expect(await goneWithin(join(dir, 'xclip'), 1500)).toBe(true);
    expect((await pending).status).toBe('failed');
  });

  it('a tool that daemonises after a successful copy (xclip, wl-copy) is left running: it serves the selection', async () => {
    leftovers.push('sleep 16180');
    const dir = fakeDir({ xclip: `${READS}\n(sleep 16180 &)\nexit 0` });
    const r = await copyText('hello', { mode: 'native', ctx: ctxFor(dir, X11), timeoutMs: 300 });
    expect(r).toMatchObject({ status: 'copied', via: 'xclip', failed: [] });
    killPendingCopies();
    await sleep(1200); // past the timeout and the grace period
    expect(alive('sleep 16180').length).toBe(1);
  });
});

describe('a tool that exits with status 0 without taking the text', () => {
  it('is not reported as copied when writing the text to it failed; the next method gets all of it', async () => {
    const dir = fakeDir({ xclip: 'exit 0', xsel: 'wc -c > "$0.out"' });
    const r = await copyText('x'.repeat(1 << 20), { mode: 'native', ctx: ctxFor(dir, X11) });
    expect(r).toMatchObject({ status: 'copied', via: 'xsel', failed: [{ method: 'xclip', reason: 'exited without reading the text' }] });
    expect(Number(readFileSync(join(dir, 'xsel.out'), 'utf8'))).toBe(1 << 20);
  });

  it('the same for a tool that reads only the start of a long text', async () => {
    const dir = fakeDir({ xclip: 'head -c 10 > /dev/null\nexit 0' });
    const r = await copyText('y'.repeat(4 << 20), { mode: 'native', ctx: ctxFor(dir, X11) });
    expect(r).toMatchObject({ status: 'failed', failed: [{ method: 'xclip', reason: 'exited without reading the text' }] });
  });

  it('a tool that reads everything and exits 0 is still "copied"', async () => {
    const dir = fakeDir({ xclip: 'wc -c > "$0.out"' });
    const r = await copyText('z'.repeat(4 << 20), { mode: 'native', ctx: ctxFor(dir, X11) });
    expect(r).toMatchObject({ status: 'copied', via: 'xclip' });
    expect(Number(readFileSync(join(dir, 'xclip.out'), 'utf8'))).toBe(4 << 20);
  });
});

describe('clipboard_command is not run by a shell', () => {
  it('a leading ~/ in an unquoted word is expanded; nothing else is', async () => {
    expect(splitCommand('~/bin/copy -o ~/out "~/quoted" a~/b ~user/x $HOME/y', '/home/u')).toEqual(['/home/u/bin/copy', '-o', '/home/u/out', '~/quoted', 'a~/b', '~user/x', '$HOME/y']);
    expect(splitCommand('~/bin/copy')).toEqual(['~/bin/copy']);
    const home = fakeDir({ copy: READS });
    const r = await copyText('hi', { mode: 'native', command: '~/copy', ctx: ctxFor(fakeDir({}), { HOME: home }) });
    expect(r).toMatchObject({ status: 'copied', via: 'copy' });
    expect(readFileSync(join(home, 'copy.out'), 'utf8')).toBe('hi');
  });

  it('an unterminated quote is a problem with the setting, reported with its line', () => {
    expect(clipboardCommandProblem('"/opt/my tools/copy --flag')).toMatch(/quote that is never closed/);
    expect(clipboardCommandProblem("xclip -selection 'clip board")).toMatch(/quote that is never closed/);
    expect(clipboardCommandProblem('""')).toMatch(/no program name/);
    for (const fine of ['wl-copy -p', '"/opt/my tools/copy" --flag "a b"', "xclip -selection 'clip board'", "it's-fine --x"]) expect(clipboardCommandProblem(fine)).toBeUndefined();
    const { config, issues } = parseConfig('theme: dark\nclipboard_command: \'"/opt/my tools/copy --flag\'\n');
    expect(issues).toEqual([{ line: 2, message: expect.stringMatching(/^clipboard_command has a quote that is never closed/) }]);
    expect(config.clipboardCommand).toBeUndefined();
    expect(parseConfig('clipboard_command: wl-copy -p\n')).toMatchObject({ issues: [], config: { clipboardCommand: 'wl-copy -p' } });
  });
});
