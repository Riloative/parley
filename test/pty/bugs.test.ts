// Regression tests for bugs found in the Part 2 review (each written to fail
// before its fix).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { tariaCommand } from '../build-once.js';
import { makeHome, sleep, spawnTaria, testEnv, type Session } from './harness.js';

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function run(args: string[], home: string, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const launch = tariaCommand(args);
    const p = spawn(launch.command, launch.args, { env: testEnv(home, env), cwd: home });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end();
  });
}

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe('persistence races', () => {
  it('taria -p -c explains when the latest conversation is open in another window', async () => {
    const home = makeHome();
    homes.push(home);
    await run(['-p', 'first'], home);
    const dir = join(home, 'data', 'taria', 'conversations');
    const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
    // Another live process (our parent) holds the lock.
    writeFileSync(join(dir, `${file}.lock`), String(process.pid));
    const r = await run(['-p', 'second', '-c'], home);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/open in another taria window/);
  });
});

describe('terminal restore', () => {
  // Every mode switched on is switched off afterwards: bracketed paste off
  // after the last "on", cursor shown after the last "hide".
  const restored = (raw: string) => raw.lastIndexOf('\x1b[?2004l') > raw.lastIndexOf('\x1b[?2004h') && raw.lastIndexOf('\x1b[?25h') > raw.lastIndexOf('\x1b[?25l');

  it('an exception while rendering restores the terminal and exits non-zero with a redacted error', async () => {
    s = spawnTaria({ env: { TARIA_DEBUG_CRASH: 'render' } });
    const code = await Promise.race([s.exited, sleep(10_000).then(() => -999)]);
    expect(code).toBe(1);
    expect(restored(s.raw)).toBe(true);
    await s.waitFor(/taria crashed: .*debug crash \(render\)/);
    // Not Ink's error screen: it printed the message unredacted and, in the
    // standalone binary, a "source excerpt" of raw executable bytes.
    expect(s.raw).not.toContain(' ERROR ');
    expect(s.raw).not.toContain('DEBUGCRASHSECRETVALUE');
    expect(s.raw).toContain('[redacted]');
  });

  it('an uncaught exception restores the terminal, saves the partial reply and exits non-zero', async () => {
    s = spawnTaria({ args: ['-m', 'mock/long?lines=400&tps=300'], env: { TARIA_DEBUG_CRASH: 'uncaught:1500' } });
    await s.waitFor('Send a message');
    s.write('go\r');
    const code = await Promise.race([s.exited, sleep(10_000).then(() => -999)]);
    expect(code).toBe(1);
    expect(restored(s.raw)).toBe(true);
    await s.waitFor(/taria crashed: .*debug crash \(uncaught\)/);
    const dir = join(s.home, 'data', 'taria', 'conversations');
    const text = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))!), 'utf8');
    expect(text).toContain('"type":"delta"');
    expect(readdirSync(dir).some((f) => f.endsWith('.lock'))).toBe(false);
  });

  it('closing the terminal mid-reply (SIGHUP) saves what streamed, releases the lock and exits', async () => {
    s = spawnTaria({ args: ['-m', 'mock/long?lines=400&tps=300'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 2');
    // Close the terminal: the kernel hangs up the session, and writes to it
    // fail afterwards.
    s.proc.kill('SIGHUP');
    const code = await Promise.race([s.exited, sleep(10_000).then(() => -999)]);
    expect(code).not.toBe(-999);
    const dir = join(s.home, 'data', 'taria', 'conversations');
    const text = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))!), 'utf8');
    expect(text).toContain('Section 1');
    expect(readdirSync(dir).some((f) => f.endsWith('.lock'))).toBe(false);
  });

  it('Ctrl+C sent to the whole process group while $EDITOR runs does not kill taria', async () => {
    s = spawnTaria({ env: { EDITOR: 'kill -INT 0; sleep 0.2; true', VISUAL: '' } });
    await s.waitFor('Send a message');
    s.write('draft text');
    await s.waitFor('│ > draft text');
    s.write('\x07');
    await sleep(1500);
    expect(await Promise.race([s.exited.then(() => 'exited'), sleep(10).then(() => 'running')])).toBe('running');
    await s.waitFor('│ > draft text');
  });
});

describe('key routing', () => {
  it('keys typed ahead across screens inside an overlay reach the next screen', async () => {
    s = spawnTaria({ cols: 100, rows: 30 });
    await s.waitFor('Send a message');
    // /providers → "+ Add a provider" (after the mock row) → first preset
    // (Anthropic) → replace the suggested name → skip the key prompt.
    s.write('/providers\r' + '\x1b[B' + '\r' + '\r' + '\x15mine\r' + '\r');
    const cfg = join(s.home, 'config', 'taria', 'config.yaml');
    try {
      await s.waitFor(() => /\n  mine:\n    type: anthropic/.test(readFileSync(cfg, 'utf8')), 10_000);
    } catch (e) {
      console.log('SCREEN\n' + s.screen().join('\n') + '\nCONFIG\n' + readFileSync(cfg, 'utf8'));
      throw e;
    }
    // The key prompt was left empty: nothing typed into the name prompt may
    // leak into it (they used to share one component and its text).
    await s.waitFor('Added provider "mine"');
    expect(existsSync(join(s.home, 'config', 'taria', 'credentials'))).toBe(false);
  });
});

describe('resize and reprint', () => {
  it('resizing with a picker open keeps the picker working and the transcript intact', async () => {
    s = spawnTaria({ cols: 100, rows: 30 });
    await s.waitFor('Send a message');
    s.write('first\r');
    await s.waitFor('You said: first');
    s.write('/model\r');
    await s.waitFor('Select a model');
    s.resize(64, 30);
    await sleep(500);
    await s.waitFor('Select a model');
    await s!.waitStable();
    expect(s.all().filter((l) => l.includes('You said: first')).length).toBe(1);
    for (const l of s.all()) expect(l.length).toBeLessThanOrEqual(64);
    s.write('mark\r');
    await s.waitFor('Model set to mock/markdown');
  });

  it('resizing during compaction leaves one clean copy and finishes the compaction', async () => {
    s = spawnTaria({ cols: 90, rows: 30, config: 'default_model: mock/echo\ncompact_model: mock/echo?delay=1500\nbell: false\nproviders:\n  mock:\n    type: mock\n' });
    await s.waitFor('Send a message');
    s.write('one\r');
    await s.waitFor('You said: one');
    s.write('two\r');
    await s.waitFor('You said: two');
    s.write('/compact\r');
    await s.waitFor('Compacting conversation');
    s.resize(70, 30);
    await s.waitFor('Conversation compacted', 10_000);
    const all = s.all();
    // (The mock's summary quotes the conversation, so count the prompt lines.)
    expect(all.filter((l) => l.startsWith('> one')).length).toBe(1);
    expect(all.filter((l) => l.startsWith('> two')).length).toBe(1);
    expect(all.filter((l) => l.includes('Welcome to taria')).length).toBe(1);
  });

  it('after Ctrl+L, a resize does not bring the cleared conversation back', async () => {
    s = spawnTaria({ cols: 90, rows: 30 });
    await s.waitFor('Send a message');
    s.write('before clear\r');
    await s.waitFor('You said: before clear');
    s.write('\x0c');
    await s.waitFor(() => !s!.all().join('\n').includes('You said: before clear'));
    s.write('after clear\r');
    await s.waitFor('You said: after clear');
    s.resize(70, 30);
    await sleep(600);
    const text = s.all().join('\n');
    expect(text).toContain('You said: after clear');
    expect(text).not.toContain('You said: before clear');
  });
});

describe('kitty keyboard protocol layout', () => {
  it('keeps the blank line between the welcome box and the input box', async () => {
    // Once reported as occasionally missing. Investigation: 75 runs (30
    // sequential, 45 three-at-a-time) with the harness sampling only fully
    // parsed frames showed no occurrence, live or replayed; the sightings
    // came from sampling the emulator before it had parsed a frame. Kept as
    // a regression check, comparing the live screen with a fresh replay.
    s = spawnTaria({ cols: 90, rows: 30, kitty: true });
    await s.waitFor('shift+⏎ for newline');
    await s.waitFor(() => s!.parsed.length === s!.raw.length && s!.parsed.lastIndexOf('\x1b[?2026h') < s!.parsed.lastIndexOf('\x1b[?2026l'));
    await sleep(200);
    await s.waitFor(() => s!.parsed.length === s!.raw.length);
    const screen = s.screen();
    const welcomeEnd = screen.findIndex((l) => l.startsWith('╰'));
    expect(screen[welcomeEnd + 1]).toBe('');
    expect(screen[welcomeEnd + 2]!.startsWith('╭')).toBe(true);
  });
});
