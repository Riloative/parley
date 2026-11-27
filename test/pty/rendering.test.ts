import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, spawnTaria, sleep, type Session, belowSpinner } from './harness.js';
import { TMUX_LINES } from '../../src/term/setup.js';
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
  return renderMarkdown(text, { width: width - 2, numberCode: true }).map((l, i) => (i === 0 ? '● ' : '  ') + plainText(l)).map((l) => l.trimEnd());
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
  s = spawnTaria({ cols, rows, args: ['-m', model] });
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
    s = spawnTaria({ cols: 70, rows: 16, args: ['-m', 'mock/long?lines=300&tps=800'] });
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
    expect(all.filter((l) => l.includes('Welcome to taria')).length).toBe(1);
    expect(all.filter((l) => l.trim() === 'Section 7').length).toBe(1);
    expect(answerLines(all)).toEqual(expectedAnswer('mock/long?lines=120&tps=6000', 60));
    for (const l of all) expect(l.length).toBeLessThanOrEqual(60);
  }, 60_000);

  it('resumes a long conversation and reprints it on resize: every message once, in order, rendered as when it streamed', async () => {
    // Resumes and reprints write the history directly instead of through
    // <Static>; the result must look exactly like the streamed original.
    const home = makeHome();
    const dir = join(home, 'data', 'taria', 'conversations');
    mkdirSync(dir, { recursive: true });
    const id = '20260101-000000-resume';
    const reply = (t: number) => `## Part ${t}\n\nSome **bold** text and \`code\` that is long enough to wrap at narrow widths, part ${t}.\n\n\`\`\`js\nconst v${t} = [${t}];\n\`\`\`\n`;
    const lines: object[] = [{ type: 'meta', v: 1, id, createdAt: 1, app: 'taria' }];
    let parent: string | null = null;
    for (let t = 0; t < 40; t++) {
      lines.push({ type: 'message', id: `u${t}`, parentId: parent, role: 'user', content: [{ type: 'text', text: `question ${t}` }], ts: t });
      lines.push({ type: 'message', id: `a${t}`, parentId: `u${t}`, role: 'assistant', content: [{ type: 'text', text: reply(t) }], ts: t, model: 'mock/echo' });
      parent = `a${t}`;
    }
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const check = (cols: number) => {
      const all = s!.all().map((l) => l.trimEnd());
      // The welcome box once: counted by its title border, since with
      // conversations on disk it greets "Welcome back!" (0.5.0).
      expect(all.filter((l) => /^╭─+ taria v/.test(l)).length).toBe(1);
      expect(all.filter((l) => l.includes('Welcome back!')).length).toBe(1);
      const order = all.flatMap((l) => (/^> question (\d+)$/.exec(l) ? [Number(RegExp.$1)] : []));
      expect(order).toEqual([...Array(40).keys()]);
      for (const l of all) expect(l.length).toBeLessThanOrEqual(cols);
      // The last reply is rendered exactly as the Markdown renderer renders it.
      const start = all.indexOf('> question 39');
      const expected = renderMarkdown(reply(39), { width: cols - 2, numberCode: true }).map((l, i) => ((i === 0 ? '● ' : '  ') + plainText(l)).trimEnd());
      expect(all.slice(start + 2, start + 2 + expected.length)).toEqual(expected);
    };

    setColorLevel(0);
    s = spawnTaria({ cols: 80, rows: 24, home, args: ['-r', id] });
    await s.waitFor('Send a message');
    await sleep(300);
    check(80);
    const mark = s.parsed.length;
    s.resize(64, 24);
    // Wait for the reprint itself: it starts by clearing screen and
    // scrollback (ESC[3J), then writes the conversation and a fresh frame.
    // Neither "Send a message" (the old frame shows it too) nor the content
    // (the emulator re-wraps the old text on resize) proves it happened.
    await s.waitFor(() => {
      const after = s!.parsed.slice(mark);
      const cleared = after.lastIndexOf('\x1b[3J');
      return cleared >= 0 && after.slice(cleared).includes('question 39') && after.slice(cleared).includes('Send a message');
    }, 20_000);
    check(64);
  }, 60_000);

  it('resizing mid-stream still produces one clean copy of the answer', async () => {
    const model = 'mock/long?lines=150&tps=1500';
    s = spawnTaria({ cols: 90, rows: 30, args: ['-m', model] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 4');
    const mark = s.parsed.length;
    s.resize(72, 30);
    // Wait for what the resize causes, not for what may be on the screen
    // already: on a busy machine the emulator is still working through
    // output written at the old width, and the reply may even have ended
    // (its stats line showing) before taria hears of the resize. taria then
    // clears the scrollback and prints the conversation again; the reply is
    // complete when its stats line follows that.
    await s.waitFor(() => {
      const after = s!.parsed.slice(mark);
      const cleared = after.lastIndexOf('\x1b[3J');
      return cleared >= 0 && /\d+(\.\d)?s · [^\n]*tokens/.test(after.slice(cleared)) && after.slice(cleared).includes('Send a message');
    }, 30_000);
    await s.waitStable({ lastLine: /for commands/ });
    expect(answerLines(s.all())).toEqual(expectedAnswer(model, 72));
  }, 60_000);

  it('lets you type while streaming and queues Enter until the reply ends', async () => {
    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=150&tps=600'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 2');
    s.write('next question');
    await s.waitFor('│ > next question');
    s.write('\r');
    await s.waitFor('↑ to edit queued message');
    await s!.waitStable({ region: () => belowSpinner(s!) });
    expect(s.screen().some((l) => l.startsWith('> next question'))).toBe(true);
    await s.waitFor(/^> next question\n\n● A very long answer/m, 30_000);
  }, 60_000);

  it('withdraws a queued message with Up', async () => {
    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=200&tps=300'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 1');
    s.write('queued text\r');
    await s.waitFor('↑ to edit queued message');
    s.write('\x1b[A');
    await s.waitFor('│ > queued text');
    await s!.waitStable({ region: () => belowSpinner(s!) });
    expect(s.screen().join('\n')).not.toContain('↑ to edit queued message');
    s.write('\x1b');
    await s.waitFor('Interrupted');
  }, 60_000);

  it('interrupts with Esc and keeps the partial text', async () => {
    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=400&tps=200'] });
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
    s = spawnTaria({ cols: 80, rows: 24 });
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
    s = spawnTaria({ cols: 80, rows: 24 });
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
import { tariaCommand } from '../build-once.js';

const hasTmux = spawnSync('sh', ['-c', 'command -v tmux'], { stdio: 'ignore' }).status === 0;

/**
 * Stop the tmux server and wait until the program in its pane has stopped
 * running. kill-server returns at once, while taria is still saving its
 * draft and state into the test's home folder; removing that folder at the
 * same time failed with ENOTEMPTY on busy machines. A process tmux has not
 * collected yet (state Z) has stopped running and writes nothing more.
 */
async function stopTmux(sock: string): Promise<void> {
  const panes = spawnSync('tmux', ['-L', sock, 'list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  spawnSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  const running = (pid: string) => {
    const st = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
    return st !== '' && !st.startsWith('Z');
  };
  const deadline = Date.now() + 10_000;
  while (panes.some(running)) {
    if (Date.now() > deadline) throw new Error(`taria in tmux (pid ${panes.join(', ')}) still running 10 s after kill-server`);
    await sleep(20);
  }
}

describe.runIf(hasTmux)('inside tmux', () => {
  it('renders and streams correctly', async () => {
    const sock = `taria-test-${process.pid}`;
    // tmux needs the test environment inside the session, so pass it via env.
    s = spawnTaria({
      cols: 80,
      rows: 24,
      command: 'tmux',
      commandArgs: ['-L', sock, '-f', '/dev/null', 'new-session', '-x', '80', '-y', '24', `${tariaCommand().shell} -m 'mock/long?lines=80&tps=3000'`],
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
      await stopTmux(sock);
    }
  }, 60_000);

  it('with the /terminal-setup tmux lines, Shift+Enter from an xterm-compatible terminal reaches taria as a new line', async () => {
    const sock = `taria-keys-${process.pid}`;
    const conf = join(makeHome(), 'tmux.conf');
    writeFileSync(conf, TMUX_LINES.join('\n') + '\n');
    s = spawnTaria({
      cols: 80,
      rows: 24,
      identifyAsXterm: true,
      command: 'tmux',
      commandArgs: ['-L', sock, '-f', conf, 'new-session', '-x', '80', '-y', '24', tariaCommand().shell],
    });
    try {
      await s.waitFor('Send a message', 15_000);
      // taria asks for modified keys once its terminal probe finishes, and
      // tmux then asks the outer terminal. Wait for that request when tmux
      // makes one this harness can see (its form differs between tmux
      // versions, and some send none); otherwise allow the same time as
      // before.
      await s.waitFor(() => /\x1b\[>4;\d+m/.test(s!.raw), 3000).catch(() => undefined);
      await sleep(150);
      s.write('one');
      s.write('\x1b[27;2;13~'); // Shift+Enter, xterm modifyOtherKeys form
      s.write('two');
      await s.waitFor(() => /│ > one\s*│\n│\s+two/.test(s!.screen().join('\n')));
      await s!.waitStable();
      expect(s.screen().join('\n')).not.toContain('You said');
    } finally {
      await stopTmux(sock);
    }
  }, 60_000);
});
