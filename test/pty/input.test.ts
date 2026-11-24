// 0.2 input: editing queued messages in place, undo/redo.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTaria, sleep, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const screen = () => s!.screen().join('\n');
const all = () => s!.all().map((l) => l.trimEnd());
const queued = () => s!.screen().map((l) => l.trimEnd()).filter((l) => /^(>|✎) /.test(l) && l !== '> go');

describe('queued messages', () => {
  it('are edited in place: order kept, input text set aside, empty removes, Ctrl+C keeps the original', async () => {
    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=400&tps=250'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('Section 1');
    // (Wait for the queue rows themselves: the text is also in the input box
    // until Enter is handled.)
    s.write('first queued\r');
    await s.waitFor(() => queued().length === 1);
    s.write('second queued\r');
    await s.waitFor(() => queued().length === 2);
    expect(queued()).toEqual(['> first queued', '> second queued']);

    // Something is being typed when the user decides to fix a queued message.
    s.write('my draft');
    await s.waitFor('│ > my draft');
    s.write(UP);
    await s.waitFor('│ > second queued');
    await s.waitFor('editing queued message');
    expect(queued()).toEqual(['> first queued', '✎ second queued']);
    s.write(UP);
    await s.waitFor('│ > first queued');
    s.write(' EDITED');
    await s.waitFor('✎ first queued EDITED');
    s.write('\r');
    // Saved in its slot; the set-aside text is back in the input box.
    await s.waitFor('│ > my draft');
    expect(queued()).toEqual(['> first queued EDITED', '> second queued']);

    // Ctrl+C while editing puts the message back as it was.
    s.write(UP);
    await s.waitFor('│ > second queued');
    s.write(' oops');
    await s.waitFor('✎ second queued oops');
    s.write('\x03');
    await s.waitFor('│ > my draft');
    expect(queued()).toEqual(['> first queued EDITED', '> second queued']);

    // Emptying a queued message and saving removes it; Down leaves the queue.
    s.write(UP);
    await s.waitFor('│ > second queued');
    s.write('\x15\r');
    await s.waitFor(() => queued().length === 1);
    expect(queued()).toEqual(['> first queued EDITED']);
    s.write(UP);
    await s.waitFor('│ > first queued EDITED');
    s.write(DOWN);
    await s.waitFor('│ > my draft');
    expect(queued()).toEqual(['> first queued EDITED']);

    // The reply is still streaming: nothing was sent or interrupted meanwhile.
    expect(all().join('\n')).not.toContain('Interrupted');
    // (The one match is the queue row itself, not a sent message.)
    expect(all().filter((l) => l.startsWith('> first queued')).length).toBe(1);
    s.write('\x1b');
    await s.waitFor('Interrupted');
    // An interrupted reply hands the queue back to the input, edited text included.
    await s.waitFor('first queued EDITED');
    expect(screen()).toContain('my draft');
  }, 60_000);

  it('are not sent while one is being edited, and go out edited afterwards', async () => {
    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/long?lines=12&tps=60'] });
    await s.waitFor('Send a message');
    s.write('go\r');
    await s.waitFor('A very long answer');
    s.write('queued\r');
    await s.waitFor(() => queued().length === 1);
    s.write(UP);
    await s.waitFor('editing queued message');
    // The first reply finishes while the edit is open.
    await s.waitFor('The end.', 20_000);
    await sleep(700);
    expect(all().filter((l) => l.startsWith('> queued')).length).toBe(0);
    expect(queued()).toEqual(['✎ queued']);
    s.write(' and fixed\r');
    await s.waitFor(() => all().includes('> queued and fixed'), 15_000);
  }, 60_000);
});

describe('undo and redo', () => {
  it('Ctrl+_ and Ctrl+Z undo edits in groups, Alt+Z redoes, and sending clears the history', async () => {
    s = spawnTaria({ cols: 80, rows: 24 });
    await s.waitFor('Send a message');
    s.write('hello world');
    await s.waitFor('│ > hello world');
    s.write('\x17'); // Ctrl+W: delete the last word
    await s.waitFor(() => /│ > hello\s+│/.test(screen()));
    s.write('\x1f'); // Ctrl+_
    await s.waitFor('│ > hello world');
    s.write('\x1a'); // Ctrl+Z: back to empty
    await s.waitFor('Send a message');
    s.write('\x1bz'); // Alt+Z: redo
    await s.waitFor('│ > hello world');
    s.write('\x1bz');
    await s.waitFor(() => /│ > hello\s+│/.test(screen()));
    // A new edit drops the redo history.
    s.write('there');
    await s.waitFor('│ > hello there');
    s.write('\x1bz');
    await sleep(200);
    expect(screen()).toContain('│ > hello there');
    s.write('\r');
    await s.waitFor('You said: hello there');
    await s.waitFor(() => /Send a message/.test(screen()));
    s.write('\x1f');
    await sleep(200);
    expect(screen()).toContain('Send a message');
  }, 30_000);
});
