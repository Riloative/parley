// 0.2 UX: unsent drafts, desktop notifications, the /compact offer.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, makeHome, spawnParley, sleep, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const input = (text: string) => `│ > ${text}`;
const draftsDir = (home: string) => join(home, 'data', 'parley', 'drafts');
const drafts = (home: string) => (existsSync(draftsDir(home)) ? readdirSync(draftsDir(home)).filter((f) => f.endsWith('.json')) : []);

describe('unsent draft', () => {
  it('survives a killed process (no chance to clean up) and comes back in the input box', async () => {
    const home = makeHome();
    s = spawnParley({ home });
    await s.waitFor('Send a message');
    s.write('half a thought, not sent');
    await s.waitFor(input('half a thought, not sent'));
    await s.waitFor(() => drafts(home).length === 1); // the debounced write
    s.proc.kill('SIGKILL');
    await s.exited;
    await s.close(true);

    s = spawnParley({ home });
    await s.waitFor(input('half a thought, not sent'));
    await s.waitFor('unsent draft restored');
    // Editing continues where it stopped, and sending clears the draft.
    s.write(' until now\r');
    await s.waitFor('You said: half a thought, not sent until now');
    await s.waitFor(() => drafts(home).length === 0);
  }, 30_000);

  it('is flushed on SIGTERM even inside the debounce window, and belongs to its conversation', async () => {
    const home = makeHome();
    s = spawnParley({ home });
    await s.waitFor('Send a message');
    s.write('first\r');
    await s.waitFor('You said: first');
    await s.waitFor(() => /Send a message/.test(s!.screen().join('\n')));
    s.write('reply in progress');
    await s.waitFor(input('reply in progress'));
    s.proc.kill('SIGTERM'); // at once: the debounce timer has not fired
    await s.exited;
    await s.close(true);
    expect(drafts(home).length).toBe(1);

    // A fresh conversation does not get another conversation's draft…
    s = spawnParley({ home });
    await s.waitFor('Send a message');
    await sleep(300);
    expect(s.screen().join('\n')).not.toContain('reply in progress');
    s.write('\x04');
    await s.exited;
    await s.close(true);

    // …the conversation it was typed in does.
    s = spawnParley({ home, args: ['-c'] });
    await s.waitFor(input('reply in progress'));
    // Ctrl+C clears the input and with it the draft.
    s.write('\x03');
    await s.waitFor(() => drafts(home).length === 0);
  }, 30_000);
});

describe('desktop notification', () => {
  const config = DEFAULT_CONFIG + 'notifications: osc9\nbell_after_seconds: 0\n';
  const OSC9 = '\x1b]9;parley: Reply ready';

  it('is sent when a long reply finishes while the terminal is unfocused, and only then', async () => {
    s = spawnParley({ home: makeHome(config) });
    await s.waitFor('Send a message');
    expect(s.raw).toContain('\x1b[?1004h');
    // Focused (or unknown): no notification.
    s.write('one\r');
    await s.waitFor('You said: one');
    await s.waitFor(() => /Send a message/.test(s!.screen().join('\n')));
    expect(s.raw).not.toContain('\x1b]9;');
    // The terminal reports focus lost, then gained and lost again.
    s.write('\x1b[O\x1b[I\x1b[O');
    s.write('two');
    await s.waitFor(input('two')); // focus reports never reach the input box
    expect(s.screen().join('\n')).not.toMatch(/\[O|\[I/);
    s.write('\r');
    await s.waitFor('You said: two');
    await s.waitFor(() => s!.raw.includes(OSC9));
    // Focus is back: quiet again.
    const mark = s.raw.length;
    s.write('\x1b[I');
    s.write('three\r');
    await s.waitFor('You said: three');
    await s.waitFor(() => /Send a message/.test(s!.screen().join('\n')));
    expect(s.raw.slice(mark)).not.toContain('\x1b]9;');
  }, 30_000);

  const focusOff = (raw: string) => raw.lastIndexOf('\x1b[?1004l') > raw.lastIndexOf('\x1b[?1004h');

  it('turns focus reporting off again on a normal exit, on SIGTERM and after a crash', async () => {
    s = spawnParley({ home: makeHome(config) });
    await s.waitFor('Send a message');
    s.write('\x04');
    await s.exited;
    expect(focusOff(s.raw)).toBe(true);
    await s.close();

    s = spawnParley({ home: makeHome(config) });
    await s.waitFor('Send a message');
    s.proc.kill('SIGTERM');
    await s.exited;
    await s.waitFor(() => focusOff(s!.raw));
    await s.close();

    s = spawnParley({ home: makeHome(config), env: { PARLEY_DEBUG_CRASH: 'uncaught:300' } });
    await s.waitFor('Send a message');
    await s.exited;
    await s.waitFor(() => focusOff(s!.raw));
  }, 30_000);

  it('asks for nothing in a terminal with no known notification protocol', async () => {
    s = spawnParley({});
    await s.waitFor('Send a message');
    expect(s.raw).not.toContain('\x1b[?1004h');
  }, 30_000);
});

describe('/compact offer', () => {
  it('offers Tab at 80% context and compacts on it; Tab does nothing below that', async () => {
    const config = `default_model: tiny/echo
theme: dark
bell: false
providers:
  tiny:
    type: mock
    models:
      echo:
        context_window: 400
`;
    s = spawnParley({ cols: 100, rows: 30, home: makeHome(config) });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor('You said: hi');
    await s.waitFor(() => /Send a message/.test(s!.screen().join('\n')));
    expect(s.screen().join('\n')).not.toContain('tab to compact');
    s.write('\t');
    await sleep(300);
    expect(s.all().join('\n')).not.toMatch(/Compact|compact/);

    s.write(`${'lorem ipsum dolor '.repeat(37)}\r`);
    await s.waitFor(/context \d+% full · tab to compact/, 15_000);
    s.write('\t');
    // (The mock "summarises" by echoing its prompt, so the context stays full
    // here; what matters is that one key ran the compaction.)
    await s.waitFor(() => s!.all().join('\n').includes('Conversation compacted'), 15_000);
  }, 40_000);
});
