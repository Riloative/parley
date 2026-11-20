import { afterEach, describe, expect, it } from 'vitest';
import { spawnParley, sleep, type Session } from './harness.js';
import { mockScriptText } from '../../src/providers/mock.js';
import { renderMarkdown } from '../../src/render/markdown.js';
import { plainText } from '../../src/render/style.js';
import { setColorLevel } from '../../src/term/caps.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const LONG = 'mock/long?lines=500&tps=6000';

function expectedAnswer(model: string, width: number): string[] {
  setColorLevel(0);
  const q = new URLSearchParams(model.split('?')[1] ?? '');
  const text = mockScriptText(model.split('/')[1]!.split('?')[0]!, q, { model, messages: [], sampling: {}, signal: new AbortController().signal });
  return renderMarkdown(text, { width: width - 2 }).map((l, i) => (i === 0 ? '● ' : '  ') + plainText(l)).map((l) => l.trimEnd());
}

/** Lines of the scrollback between the "> go" prompt line and the stats line. */
function answerLines(all: string[]): string[] {
  const start = all.findIndex((l) => l.startsWith('> go'));
  const end = all.findIndex((l, i) => i > start && /^  \d+(\.\d)?s · /.test(l));
  const out = all.slice(start + 2, end).map((l) => l.trimEnd());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

async function streamLong(cols: number, rows: number, model = LONG) {
  s = spawnParley({ cols, rows, args: ['-m', model] });
  await s.waitFor('Send a message');
  const mark = s.raw.length;
  s.write('go\r');
  await s.waitFor(/^ {2}\d+(\.\d)?s · .*tokens/m, 30_000);
  await sleep(200);
  return mark;
}

describe('rendering core', () => {
  for (const [cols, rows] of [
    [80, 24],
    [60, 20],
    [200, 50],
  ] as const) {
    it(`streams a 500-line answer at ${cols}x${rows} into scrollback exactly once, matching a one-shot render`, async () => {
      const mark = await streamLong(cols, rows);
      const raw = s!.rawSince(mark);
      const got = answerLines(s!.all());
      const want = expectedAnswer(LONG, cols);
      expect(got.length).toBeGreaterThan(450);
      expect(got).toEqual(want);
      // Never a full-screen clear or "home + erase down" redraw while streaming.
      expect(raw).not.toContain('\x1b[2J');
      expect(raw).not.toContain('\x1b[3J');
      expect(raw).not.toContain('\x1b[1;1H\x1b[J');
      expect(raw).not.toContain('\x1b[H\x1b[J');
      // Every frame is wrapped in synchronized output.
      const bsu = raw.split('\x1b[?2026h').length - 1;
      const esu = raw.split('\x1b[?2026l').length - 1;
      expect(bsu).toBeGreaterThan(5);
      expect(Math.abs(bsu - esu)).toBeLessThanOrEqual(1);
      // Output volume stays proportional to the content (no repeated redraws).
      const visible = want.join('\n').length;
      expect(raw.length).toBeLessThan(visible * 8);
      // Each finished section heading reaches the terminal a bounded number of
      // times (once live, once committed) — not once per frame.
      for (const n of [3, 20, 40]) {
        const count = raw.split(`Section ${n}\x1b`).length - 1 + raw.split(`Section ${n}\r`).length - 1 + raw.split(`Section ${n}\n`).length - 1;
        expect(count).toBeLessThanOrEqual(3);
      }
    }, 60_000);
  }

  it('keeps the dynamic area shorter than the terminal while a long code block streams', async () => {
    s = spawnParley({ cols: 70, rows: 16, args: ['-m', 'mock/long?lines=300&tps=800'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      // Sample between frames: a real terminal never shows a half-received
      // synchronized update.
      await s.waitFor(() => s!.parsed.lastIndexOf('\x1b[?2026h') < s!.parsed.lastIndexOf('\x1b[?2026l'));
      const screen = s.screen();
      // The input box bottom border and the status line are always visible.
      if (!screen.some((l) => l.startsWith('╰'))) throw new Error(`input box not visible:\n${screen.join('\n')}`);
    }
    s.write('\x1b');
    await s.waitFor('Interrupted');
  }, 60_000);

  it('reflows cleanly on resize, with no duplicated content', async () => {
    await streamLong(100, 30, 'mock/long?lines=120&tps=6000');
    s!.resize(60, 30);
    await sleep(600);
    const all = s!.all();
    expect(all.filter((l) => l.includes('Welcome to parley')).length).toBe(1);
    expect(all.filter((l) => l.trim() === 'Section 7').length).toBe(1);
    expect(answerLines(all)).toEqual(expectedAnswer('mock/long?lines=120&tps=6000', 60));
    for (const l of all) expect(l.length).toBeLessThanOrEqual(60);
  }, 60_000);

  it('resizing mid-stream still produces one clean copy of the answer', async () => {
    const model = 'mock/long?lines=150&tps=1500';
    s = spawnParley({ cols: 90, rows: 30, args: ['-m', model] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 4');
    s.resize(72, 30);
    await s.waitFor(/^ {2}\d+(\.\d)?s · .*tokens/m, 30_000);
    await sleep(200);
    expect(answerLines(s.all())).toEqual(expectedAnswer(model, 72));
  }, 60_000);

  it('lets you type while streaming and queues Enter until the reply ends', async () => {
    s = spawnParley({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=150&tps=600'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 2');
    s.write('next question');
    await s.waitFor('│ > next question');
    s.write('\r');
    await s.waitFor('↑ to edit queued message');
    expect(s.screen().some((l) => l.startsWith('> next question'))).toBe(true);
    await s.waitFor(/^> next question\n\n● A very long answer/m, 30_000);
  }, 60_000);

  it('withdraws a queued message with Up', async () => {
    s = spawnParley({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=200&tps=300'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 1');
    s.write('queued text\r');
    await s.waitFor('↑ to edit queued message');
    s.write('\x1b[A');
    await s.waitFor('│ > queued text');
    expect(s.screen().join('\n')).not.toContain('↑ to edit queued message');
    s.write('\x1b');
    await s.waitFor('Interrupted');
  }, 60_000);

  it('interrupts with Esc and keeps the partial text', async () => {
    s = spawnParley({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=400&tps=200'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 1');
    s.write('\x1b');
    await s.waitFor('Interrupted');
    const all = s.all().join('\n');
    expect(all).toContain('A very long answer');
    expect(all).not.toContain('The end.');
  }, 30_000);

  it('restores the terminal on exit', async () => {
    s = spawnParley({ cols: 80, rows: 24 });
    await s.waitFor('Send a message');
    s.write('\x03');
    await s.waitFor('Press Ctrl-C again to exit');
    s.write('\x03');
    const code = await s.exited;
    expect(code).toBe(0);
    const tail = s.raw.slice(-400);
    expect(tail).toContain('\x1b[?2004l');
    expect(tail).toContain('\x1b[?25h');
  }, 30_000);

  it('restores the terminal when killed with SIGTERM', async () => {
    s = spawnParley({ cols: 80, rows: 24 });
    await s.waitFor('Send a message');
    s.proc.kill('SIGTERM');
    await s.exited;
    await sleep(100);
    const tail = s.raw.slice(-400);
    expect(tail).toContain('\x1b[?2004l');
    expect(tail).toContain('\x1b[?25h');
  }, 30_000);
});

import { spawnSync } from 'node:child_process';
import { testEnv } from './harness.js';
import { parleyCommand } from '../build-once.js';

const hasTmux = spawnSync('sh', ['-c', 'command -v tmux'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasTmux)('inside tmux', () => {
  it('renders and streams correctly', async () => {
    const sock = `parley-test-${process.pid}`;
    // tmux needs the test environment inside the session, so pass it via env.
    s = spawnParley({
      cols: 80,
      rows: 24,
      command: 'tmux',
      commandArgs: ['-L', sock, '-f', '/dev/null', 'new-session', '-x', '80', '-y', '24', `${parleyCommand().shell} -m mock/long?lines=80\\&tps=3000`],
    });
    try {
      await s.waitFor('Send a message', 15_000);
      s.write('go\r');
      await s.waitFor('The end.', 30_000);
      await sleep(300);
      const screen = s.screen().join('\n');
      expect(screen).toContain('The end.');
      expect(screen).toContain('╰');
      // tmux keeps its own scrollback; ask it for the full history and check
      // that each section appears exactly once.
      const hist = spawnSync('tmux', ['-L', sock, 'capture-pane', '-p', '-S', '-2000'], { encoding: 'utf8', env: testEnv(s.home) }).stdout;
      for (const n of [1, 5, 9]) expect(hist.split('\n').filter((l) => l.trim() === `Section ${n}`).length).toBe(1);
    } finally {
      spawnSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
    }
  }, 60_000);
});
