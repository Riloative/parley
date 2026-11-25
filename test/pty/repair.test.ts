// Conversations hit by the 0.0.1–0.2.0 crash bug, repaired through doctor or
// by opening them.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHome, spawnTaria, testEnv, type Session } from './harness.js';
import { tariaCommand } from '../build-once.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const ID = '20250601-120000-dead';
const msg = (id: string, parentId: string | null, role: string, text: string, ts: number) => ({ type: 'message', id, parentId, role, content: [{ type: 'text', text }], ts, ...(role === 'assistant' ? { model: 'mock/echo' } : {}) });
/** A finished reply as every version writes it: `partial`, the text as it
 * streamed, then the message. */
const reply = (id: string, parentId: string, text: string, ts: number) => [{ type: 'partial', id, parentId, model: 'mock/echo', ts }, { type: 'delta', id, text }, msg(id, parentId, 'assistant', text, ts)];
const jsonl = (ev: object[]) => ev.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** A conversation as parley 0.1.0 left it after two crashes mid-reply (a1,
 * a3), each followed by a resume. */
const hitEvents = () => [
  { type: 'meta', v: 1, id: ID, createdAt: 1_700_000_000_000, app: 'parley' },
  msg('u1', null, 'user', 'the very first question', 1_700_000_000_000),
  { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 1_700_000_000_001 },
  { type: 'delta', id: 'a1', text: 'the answer that was cut off' },
  msg('u2', 'a1', 'user', 'question after the crash', 1_700_000_000_002),
  ...reply('a2', 'u2', 'answer after the crash', 1_700_000_000_003),
  msg('u3', 'a2', 'user', 'one more', 1_700_000_000_004),
  { type: 'partial', id: 'a3', parentId: 'u3', model: 'mock/echo', ts: 1_700_000_000_005 },
  { type: 'delta', id: 'a3', text: 'cut off as well' },
  msg('u4', 'a3', 'user', 'and the last question', 1_700_000_000_006),
  ...reply('a4', 'u4', 'and the last answer', 1_700_000_000_007),
  { type: 'title', title: 'Crash-hit chat' },
];

function hitHome(events: object[] = hitEvents()): { home: string; file: string; dir: string } {
  const home = makeHome();
  const dir = join(home, 'data', 'taria', 'conversations');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ID}.jsonl`);
  writeFileSync(file, jsonl(events));
  return { home, file, dir };
}

/** The same conversation in a home that only parley has used: nothing of
 * taria's exists yet. */
function parleyHitHome(): { home: string; oldFile: string; newFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'taria-test-'));
  mkdirSync(join(home, 'config', 'parley'), { recursive: true });
  writeFileSync(join(home, 'config', 'parley', 'config.yaml'), 'default_model: mock/echo\ntheme: dark\nbell: false\nproviders:\n  mock:\n    type: mock\n');
  mkdirSync(join(home, 'data', 'parley', 'conversations'), { recursive: true });
  const oldFile = join(home, 'data', 'parley', 'conversations', `${ID}.jsonl`);
  writeFileSync(oldFile, jsonl(hitEvents()));
  return { home, oldFile, newFile: join(home, 'data', 'taria', 'conversations', `${ID}.jsonl`) };
}

function run(home: string, args: string[], extra: Record<string, string> = {}) {
  const cmd = tariaCommand(args);
  return spawnSync(cmd.command, cmd.args, { env: testEnv(home, extra), input: '', encoding: 'utf8', timeout: 30_000 });
}

describe('repairing crash-hit conversations', () => {
  it('doctor reports them and changes nothing', () => {
    const { home, file } = hitHome();
    const before = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    const cmd = tariaCommand(['doctor']);
    const r = spawnSync(cmd.command, cmd.args, { env: testEnv(home, { NO_COLOR: '1' }), encoding: 'utf8', timeout: 30_000 });
    // parley showed only the last two of the eight messages.
    expect(r.stdout).toMatch(/Needs repair\s+Crash-hit chat: 6 earlier messages hidden by 2 replies cut off in parley before 0\.2\.0/);
    expect(r.stdout).toMatch(/taria doctor repair/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it('doctor repair asks first: "n" changes nothing, "y" records the lost replies', async () => {
    const { home, file } = hitHome();
    const before = readFileSync(file, 'utf8');
    s = spawnTaria({ cols: 120, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('Repair 1 conversation? [y/N]');
    await s!.waitStable();
    expect(s.screen().join('\n')).toMatch(/Crash-hit chat \(20250601-120000-dead\): 2 cut-off replies, 6 earlier messages hidden/);
    s.write('n\r');
    await s.waitFor('Nothing changed.');
    expect(await s.exited).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    await s.close(true);

    s = spawnTaria({ cols: 120, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('[y/N]');
    s.write('y\r');
    await s.waitFor('repaired Crash-hit chat: 2 replies recorded');
    expect(await s.exited).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(3); // a1, a3, head
  }, 30_000);

  it('a cut-off reply on a branch the user left: reported for what it is, with no claim that messages are hidden', () => {
    const { home, file } = hitHome([
      { type: 'meta', v: 1, id: ID, createdAt: 1_700_000_000_000, app: 'parley' },
      msg('u1', null, 'user', 'a question', 1_700_000_000_000),
      { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 1_700_000_000_001 },
      { type: 'delta', id: 'a1', text: 'cut off' },
      msg('u2', 'a1', 'user', 'went on', 1_700_000_000_002),
      { type: 'head', id: null, ts: 1_700_000_000_003 }, // rewound to the start
      msg('u1b', null, 'user', 'asked again', 1_700_000_000_004),
      ...reply('a1b', 'u1b', 'the answer', 1_700_000_000_005),
      { type: 'title', title: 'Left branch' },
    ]);
    const before = readFileSync(file, 'utf8');
    const d = run(home, ['doctor'], { NO_COLOR: '1' });
    expect(d.stdout).toMatch(/Needs repair\s+Left branch: a reply cut off in parley before 0\.2\.0 was never recorded, on a branch you left; no message is hidden/);
    expect(d.stdout).not.toMatch(/Left branch: \d+ earlier message/);
    const r = run(home, ['doctor', 'repair']);
    expect(r.stdout).toMatch(/Left branch \(20250601-120000-dead\): 1 cut-off reply on a branch you left, no message hidden/);
    expect(r.stdout).not.toMatch(/Left branch.*earlier message/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Opening it repairs it; the notice does not say messages had been hidden.
    const p = run(home, ['-p', '-c', 'next']);
    expect(p.stdout).toBe('You said: next\n');
    expect(p.stderr).toMatch(/^taria: Repaired this conversation: a reply was cut off by a crash in parley before 0\.2\.0/m);
    expect(p.stderr).not.toMatch(/which hid|shows again/);
  }, 60_000);

  it('doctor repair does not make the repaired conversation the most recent one: -c still continues the newest', async () => {
    const { home, file, dir } = hitHome();
    const NEWER = '20251120-090000-beef';
    const newer = join(dir, `${NEWER}.jsonl`);
    const t = 1_763_600_000_000;
    writeFileSync(newer, jsonl([{ type: 'meta', v: 1, id: NEWER, createdAt: t, app: 'taria' }, msg('u1', null, 'user', 'what I was working on yesterday', t), ...reply('a1', 'u1', 'the newest answer', t + 1)]));
    utimesSync(file, 1_700_000_100, 1_700_000_100);
    utimesSync(newer, t / 1000 + 1, t / 1000 + 1);
    const before = readFileSync(file, 'utf8');

    s = spawnTaria({ cols: 120, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('[y/N]');
    await s.waitStable();
    expect(s.screen().join('\n')).toContain('Repair 1 conversation? [y/N]');
    s.write('y\r');
    await s.waitFor('repaired Crash-hit chat: 2 replies recorded');
    expect(await s.exited).toBe(0);
    const repaired = readFileSync(file, 'utf8');
    expect(repaired.length).toBeGreaterThan(before.length);
    expect(statSync(file).mtimeMs).toBe(1_700_000_100_000);

    const r = run(home, ['-p', '-c', 'next']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('You said: next\n');
    expect(readFileSync(newer, 'utf8')).toContain('You said: next');
    expect(readFileSync(file, 'utf8')).toBe(repaired);
  }, 60_000);

  it('before the move from parley: doctor finds them in the old folder, and still changes nothing', () => {
    const { home, oldFile } = parleyHitHome();
    const before = readFileSync(oldFile, 'utf8');
    const mtime = statSync(oldFile).mtimeMs;
    const r = run(home, ['doctor'], { NO_COLOR: '1' });
    expect(r.stdout).toMatch(/Needs repair\s+Crash-hit chat: 6 earlier messages hidden by 2 replies cut off in parley before 0\.2\.0 \(in .*data\/parley\)/);
    expect(r.stdout).not.toMatch(/Crash damage\s+none/);
    expect(r.stdout).toMatch(/taria doctor repair/);
    expect(readFileSync(oldFile, 'utf8')).toBe(before);
    expect(statSync(oldFile).mtimeMs).toBe(mtime);
    expect(lstatSync(join(home, 'data', 'parley')).isDirectory()).toBe(true);
    expect(existsSync(join(home, 'data', 'taria'))).toBe(false);
    expect(existsSync(join(home, 'config', 'taria'))).toBe(false);
  });

  it('before the move from parley: doctor repair moves the files first, like every command that writes, then repairs', async () => {
    const { home, oldFile, newFile } = parleyHitHome();
    const before = readFileSync(oldFile, 'utf8');
    s = spawnTaria({ cols: 140, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('Repair 1 conversation? [y/N]');
    await s.waitStable();
    const screen = s.screen().map((l) => l.trim()).join(' ');
    expect(screen).toMatch(/parley is now taria: moved your files/);
    expect(screen).toMatch(/Crash-hit chat \(20250601-120000-dead\): 2 cut-off replies, 6 earlier messages hidden/);
    expect(screen).not.toContain('No conversation needs repair');
    // Listed once: the old folder is now a link to the new one.
    expect(screen.match(/Crash-hit chat \(/g)).toHaveLength(1);
    expect(lstatSync(join(home, 'data', 'parley')).isSymbolicLink()).toBe(true);
    expect(readFileSync(newFile, 'utf8')).toBe(before);
    s.write('y\r');
    await s.waitFor('repaired Crash-hit chat: 2 replies recorded');
    expect(await s.exited).toBe(0);
    const after = readFileSync(newFile, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(3); // a1, a3, head
    await s.close(true);
    s = undefined;
    // Nothing is left to repair, by either name.
    const again = run(home, ['doctor', 'repair']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('No conversation needs repair.');
  }, 40_000);

  it('an old folder that could not be moved (taria already has files): its conversations are found and repaired where they are', async () => {
    const { home, oldFile } = parleyHitHome();
    // taria has been used on its own as well, so parley's folder stays.
    const mine = join(home, 'data', 'taria', 'conversations');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, '20251120-090000-beef.jsonl'), jsonl([{ type: 'meta', v: 1, id: '20251120-090000-beef', createdAt: 1_763_600_000_000, app: 'taria' }, msg('u1', null, 'user', 'a taria conversation', 1_763_600_000_000)]));
    const before = readFileSync(oldFile, 'utf8');
    const d = run(home, ['doctor'], { NO_COLOR: '1' });
    expect(d.stdout).toMatch(/Needs repair\s+Crash-hit chat: 6 earlier messages hidden by 2 replies cut off in parley before 0\.2\.0 \(in .*data\/parley\)/);
    expect(readFileSync(oldFile, 'utf8')).toBe(before);

    s = spawnTaria({ cols: 160, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('Repair 1 conversation? [y/N]');
    await s.waitStable();
    expect(lstatSync(join(home, 'data', 'parley')).isDirectory()).toBe(true); // not moved
    expect(s.screen().map((l) => l.trim()).join(' ')).toMatch(/Crash-hit chat \(20250601-120000-dead\) in \S*data\/parley: 2 cut-off replies, 6 earlier messages hidden/);
    s.write('y\r');
    await s.waitFor('repaired Crash-hit chat: 2 replies recorded');
    expect(await s.exited).toBe(0);
    const after = readFileSync(oldFile, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).trim().split('\n')).toHaveLength(3);
  }, 40_000);

  it('-p -c repairs it too and says so on stderr, never on stdout', () => {
    const { home, file } = hitHome();
    const before = readFileSync(file, 'utf8');
    const cmd = tariaCommand(['-p', '-c', 'next']);
    const r = spawnSync(cmd.command, cmd.args, { env: testEnv(home), input: '', encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('You said: next\n');
    expect(r.stderr).toMatch(/^taria: Repaired this conversation: 2 replies were cut off by a crash in parley before 0\.2\.0/m);
    expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true);
    // --json: stdout is still exactly one JSON object.
    const again = hitHome();
    const j = spawnSync(cmd.command, [...cmd.args.slice(0, -3), '-p', '-c', '--json', 'next'], { env: testEnv(again.home), input: '', encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(j.stdout)).toMatchObject({ text: 'You said: next' });
    expect(j.stderr).toContain('Repaired this conversation');
    // Already repaired: nothing more is said.
    const third = spawnSync(cmd.command, cmd.args, { env: testEnv(home), input: '', encoding: 'utf8', timeout: 30_000 });
    expect(third.stderr).not.toContain('Repaired');
  }, 60_000);

  it('opening one shows the whole conversation and says, once, what was repaired', async () => {
    const { home } = hitHome();
    s = spawnTaria({ cols: 120, rows: 40, home, args: ['-r', ID] });
    await s.waitFor('Send a message');
    await s.waitStable({ lastLine: '% context' });
    const all = s.all().map((l) => l.trim()).join(' ');
    for (const t of ['the very first question', 'the answer that was cut off', 'question after the crash', 'cut off as well', 'and the last answer']) expect(all).toContain(t);
    expect(all).toMatch(/Repaired this conversation: 2 replies were cut off by a crash in parley before 0\.2\.0/);
    s.write('\x04');
    await s.exited;
    await s.close(true);
    s = spawnTaria({ cols: 120, rows: 40, home, args: ['-r', ID] });
    await s.waitFor('Send a message');
    await s.waitStable({ lastLine: '% context' });
    expect(s.all().join(' ')).not.toContain('Repaired this conversation');
  }, 30_000);
});
