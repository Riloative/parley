// 0.2 reading and navigation: links, numbered code blocks, /find, branches,
// collapsed history.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHome, spawnTaria, sleep, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const paste = (t: string) => `\x1b[200~${t}\x1b[201~`;
const screen = () => s!.screen().join('\n');
const all = () => s!.all().map((l) => l.trimEnd());
const idle = () => s!.waitFor(() => /Send a message/.test(screen()));

async function say(text: string, expectReply = `You said: ${text}`) {
  s!.write(text);
  await sleep(50);
  s!.write('\r');
  await s!.waitFor(expectReply);
  await idle();
}

describe('links', () => {
  const md = 'see [the docs](https://example.com/guide) now';
  const OPEN = '\x1b]8;;https://example.com/guide\x1b\\';

  it('are clickable (OSC 8) with the URL hidden when the terminal supports it, also after a reprint', async () => {
    s = spawnTaria({ cols: 80, rows: 24, env: { FORCE_HYPERLINK: '1' } });
    await s.waitFor('Send a message');
    await say(md, 'You said: see the docs now');
    expect(s.raw).toContain(OPEN);
    // The reply shows the link text only (the user's own message is shown as typed).
    expect(all()).toContain('● You said: see the docs now');
    // Every link that is opened is closed again.
    const opens = s.raw.split('\x1b]8;;https').length - 1;
    expect(s.raw.split('\x1b]8;;\x1b\\').length - 1).toBe(opens);
    const mark = s.parsed.length;
    s.resize(60, 24);
    await s.waitFor(() => s!.parsed.slice(mark).includes(OPEN) && s!.parsed.slice(mark).includes('Send a message'));
    // The screen is parsed a moment after the bytes arrive: wait for it.
    await s.waitFor(() => all().some((l) => l.includes('You said: see the docs now')) && /Send a message/.test(screen()));
    expect(all().filter((l) => l.includes('You said: see the docs now')).length).toBe(1);
    for (const l of all()) expect(l.length).toBeLessThanOrEqual(60);
  }, 30_000);

  it('fall back to "text (url)" elsewhere', async () => {
    s = spawnTaria({ cols: 80, rows: 24 });
    await s.waitFor('Send a message');
    await say(md, 'You said: see the docs (https://example.com/guide) now');
    expect(s.raw).not.toContain('\x1b]8;');
  }, 30_000);
});

describe('numbered code blocks', () => {
  it('are labelled in the transcript, and /copy code N copies that one', async () => {
    s = spawnTaria({ cols: 80, rows: 30, env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '' } });
    await s.waitFor('Send a message');
    s.write(paste('two blocks\n```js\nfirst()\n```\nand\n```py\nsecond()\n```'));
    await sleep(100);
    s.write('\r');
    await s.waitFor('second()');
    await idle();
    expect(all()).toContain('  js · 1');
    expect(all()).toContain('  py · 2');
    const copied = () => [...s!.raw.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g)].map((m) => Buffer.from(m[1]!, 'base64').toString());
    s.write('/copy code 1\r');
    await s.waitFor('Sent code block 1 of 2');
    expect(copied().at(-1)).toBe('first()');
    s.write('/copy code\r');
    await s.waitFor('Sent the last code block');
    expect(copied().at(-1)).toBe('second()');
    s.write('/copy code 3\r');
    await s.waitFor('The last response has 2 code blocks; use /copy code 1 to 2.');
    // The numbers survive a reprint.
    const mark = s.parsed.length;
    s.resize(70, 30);
    await s.waitFor(() => s!.parsed.slice(mark).includes('py · 2'));
  }, 30_000);
});

describe('/find', () => {
  it('lists the messages containing the text and shows the chosen one again', async () => {
    s = spawnTaria({ cols: 90, rows: 30 });
    await s.waitFor('Send a message');
    await say('alpha one');
    await say('the needle is here');
    await say('gamma three');
    s.write('/find NEEDLE\r');
    await s.waitFor('2 messages containing "NEEDLE"');
    await s.waitFor('message 3 of 6');
    await s.waitFor('message 4 of 6');
    s.write('\x1b[B\r'); // the older of the two: the user's message
    await s.waitFor('Message 3 of 6 · You');
    expect(all().filter((l) => l.includes('the needle is here')).length).toBeGreaterThanOrEqual(3);
    s.write('/find nothing-like-this\r');
    await s.waitFor('"nothing-like-this" does not appear in this conversation');
    // Nothing was added to the conversation itself.
    const dir = join(s.home, 'data', 'taria', 'conversations');
    const text = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))!), 'utf8');
    expect(text.split('\n').filter((l) => l.includes('"type":"message"')).length).toBe(6);
  }, 30_000);
});

describe('branches', () => {
  it('marks a branch point after a rewind, and /branches switches back and forth', async () => {
    s = spawnTaria({ cols: 90, rows: 30 });
    await s.waitFor('Send a message');
    await say('first question');
    await say('second original');
    s.write('/branches\r');
    await s.waitFor('This conversation has one branch');
    // Rewind to the second message and send something else.
    s.write('\x1b');
    await sleep(100);
    s.write('\x1b');
    await s.waitFor('Rewind: pick a message');
    s.write('\r');
    await s.waitFor('│ > second original');
    s.write('\x15');
    await say('second rewritten');
    expect(all()).toContain('  ⑂ branch 2 of 2 · /branches to switch');
    expect(all().join('\n')).not.toContain('second original');

    s.write('/branches\r');
    await s.waitFor('Branches (each line');
    await s.waitFor('> second original');
    await s.waitFor(/> second rewritten.*current|current/);
    s.write('\x1b[B\r'); // the other branch
    await s.waitFor('You said: second original');
    await idle();
    expect(all()).toContain('  ⑂ branch 1 of 2 · /branches to switch');
    expect(all().join('\n')).not.toContain('second rewritten');
    expect(all().filter((l) => l === '> first question').length).toBe(1);

    // The choice is persisted: reopening shows the same branch.
    const home = s.home;
    s.write('\x04');
    await s.exited;
    await s.close(true);
    s = spawnTaria({ cols: 90, rows: 30, home, args: ['-c'] });
    await s.waitFor('You said: second original');
    expect(all().join('\n')).not.toContain('second rewritten');
  }, 40_000);
});

describe('very long conversations', () => {
  it('show the recent part on reprint, say how much is hidden, and /history shows everything', async () => {
    const home = makeHome();
    const dir = join(home, 'data', 'taria', 'conversations');
    mkdirSync(dir, { recursive: true });
    const id = '20260101-000000-long';
    const lines: object[] = [{ type: 'meta', v: 1, id, createdAt: 1, app: 'taria' }];
    let parent: string | null = null;
    for (let t = 0; t < 150; t++) {
      lines.push({ type: 'message', id: `u${t}`, parentId: parent, role: 'user', content: [{ type: 'text', text: `question ${t}` }], ts: t });
      lines.push({ type: 'message', id: `a${t}`, parentId: `u${t}`, role: 'assistant', content: [{ type: 'text', text: `answer ${t}` }], ts: t, model: 'mock/echo' });
      parent = `a${t}`;
    }
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    s = spawnTaria({ cols: 80, rows: 24, home, args: ['-r', id] });
    await s.waitFor('Send a message');
    await s.waitFor('answer 149');
    const questions = () => all().flatMap((l) => (/^> question (\d+)$/.exec(l) ? [Number(/^> question (\d+)$/.exec(l)![1])] : []));
    // 300 messages: the newest 200 are printed, starting at a question.
    expect(questions()).toEqual(Array.from({ length: 100 }, (_, i) => i + 50));
    expect(all()).toContain('  … 100 earlier messages not shown · /history shows them');

    let mark = s.parsed.length;
    s.write('/history\r');
    await s.waitFor(() => s!.parsed.slice(mark).includes('question 0') && s!.parsed.slice(mark).includes('answer 149'));
    await idle();
    expect(questions()).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(all().join('\n')).not.toContain('earlier messages not shown');

    // A new message still goes to the model with the whole conversation.
    mark = s.parsed.length;
    s.write('/history\r');
    await s.waitFor(() => s!.parsed.slice(mark).includes('earlier messages not shown'));
    await say('one more');
    expect(questions().at(0)).toBe(50);
  }, 60_000);

  it('/history says so when nothing is hidden', async () => {
    s = spawnTaria({});
    await s.waitFor('Send a message');
    s.write('/history\r');
    await s.waitFor('Nothing is hidden');
  }, 30_000);
});
