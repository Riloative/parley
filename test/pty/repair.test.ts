// Conversations hit by the 0.0.1–0.2.0 crash bug, repaired through doctor or
// by opening them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A conversation as parley 0.1.0 left it after a crash mid-reply and a resume. */
function hitHome(): { home: string; file: string } {
  const home = makeHome();
  const dir = join(home, 'data', 'taria', 'conversations');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ID}.jsonl`);
  const ev = [
    { type: 'meta', v: 1, id: ID, createdAt: 1_700_000_000_000, app: 'parley' },
    msg('u1', null, 'user', 'the very first question', 1_700_000_000_000),
    { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 1_700_000_000_001 },
    { type: 'delta', id: 'a1', text: 'the answer that was cut off' },
    msg('u2', 'a1', 'user', 'question after the crash', 1_700_000_000_002),
    msg('a2', 'u2', 'assistant', 'answer after the crash', 1_700_000_000_003),
    msg('u3', 'a2', 'user', 'one more', 1_700_000_000_004),
    { type: 'partial', id: 'a3', parentId: 'u3', model: 'mock/echo', ts: 1_700_000_000_005 },
    { type: 'delta', id: 'a3', text: 'cut off as well' },
    msg('u4', 'a3', 'user', 'and the last question', 1_700_000_000_006),
    msg('a4', 'u4', 'assistant', 'and the last answer', 1_700_000_000_007),
    { type: 'title', title: 'Crash-hit chat' },
  ];
  writeFileSync(file, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { home, file };
}

describe('repairing crash-hit conversations', () => {
  it('doctor reports them and changes nothing', () => {
    const { home, file } = hitHome();
    const before = readFileSync(file, 'utf8');
    const cmd = tariaCommand(['doctor']);
    const r = spawnSync(cmd.command, cmd.args, { env: testEnv(home, { NO_COLOR: '1' }), encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toMatch(/Needs repair\s+Crash-hit chat: 2 earlier messages hidden by a reply cut off in parley before 0\.2\.0/);
    expect(r.stdout).toMatch(/taria doctor repair/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('doctor repair asks first: "n" changes nothing, "y" records the lost replies', async () => {
    const { home, file } = hitHome();
    const before = readFileSync(file, 'utf8');
    s = spawnTaria({ cols: 120, rows: 30, home, args: ['doctor', 'repair'] });
    await s.waitFor('Repair 1 conversation? [y/N]');
    await s!.waitStable();
    expect(s.screen().join('\n')).toMatch(/Crash-hit chat \(20250601-120000-dead\): 2 cut-off replies, 2 earlier messages hidden/);
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
