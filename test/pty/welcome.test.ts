// The 0.5.0 start screen in the real program: two columns with the owl,
// one column and compact on narrower terminals, the name and recent
// conversations from the config and the store, reprinted once on resize.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, makeHome, spawnTaria, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const OWL_EYES = '██  ████  ██';

/** A home with conversations on disk, newest last. */
function homeWith(titles: string[], config = DEFAULT_CONFIG): string {
  const home = makeHome(config);
  const dir = join(home, 'data', 'taria', 'conversations');
  mkdirSync(dir, { recursive: true });
  titles.forEach((title, i) => {
    const id = `20260101-00000${i}-abcd`;
    const ts = Date.now() - (titles.length - i) * 3600_000;
    const lines = [
      { type: 'meta', v: 1, id, createdAt: ts, app: 'taria' },
      { type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }], ts },
      { type: 'message', id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], ts, model: 'mock/echo' },
      { type: 'title', title },
    ];
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // The store ranks by the later of the stored time and the file's.
    utimesSync(join(dir, `${id}.jsonl`), ts / 1000, ts / 1000);
  });
  return home;
}

const boxLines = (all: string[]) => {
  const top = all.findIndex((l) => /^[╭+]─*-* ?taria v/.test(l) || /^╭─+ taria v/.test(l));
  const end = all.findIndex((l, i) => i > top && /^[╰+][─-]+[╯+]$/.test(l));
  return all.slice(top, end + 1);
};

describe('the start screen', () => {
  it('first start: "Welcome to taria!", the owl, tips, and no recent activity', async () => {
    s = spawnTaria({ cols: 100, rows: 30 });
    await s.waitStable({ lastLine: /context/ });
    const box = boxLines(s.all().map((l) => l.trimEnd()));
    const text = box.join('\n');
    expect(box[0]).toMatch(/^╭─── taria v\d+\.\d+\.\d+/);
    expect(text).toContain('Welcome to taria!');
    expect(text).toContain(OWL_EYES);
    expect(text).toContain('Tips for getting started');
    expect(text).toContain('No recent activity');
    // With no conversations on disk there is nothing to read later: the box
    // is complete in the first frame and is not drawn a second time.
    expect(s.raw.split('Recent activity').length - 1).toBe(1);
    expect(text).toContain('echo · mock');
    for (const l of box) expect(l.length).toBe(100);
  });

  it('greets by the name in the config and lists the latest three conversations, newest first', async () => {
    const home = homeWith(['Oldest chat', 'Garden beds', 'Regex for dates', 'Newest chat'], `${DEFAULT_CONFIG}name: Sam\n`);
    s = spawnTaria({ home, cols: 110, rows: 30 });
    await s.waitStable({ lastLine: /context/ });
    const text = boxLines(s.all().map((l) => l.trimEnd())).join('\n');
    expect(text).toContain('Welcome back, Sam!');
    const order = ['Newest chat', 'Regex for dates', 'Garden beds'].map((t) => text.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).not.toContain('Oldest chat');
    expect(text).toMatch(/Newest chat · 1h ago/);
  });

  it('welcome_recent: false keeps conversation titles off the screen', async () => {
    const home = homeWith(['Private matter'], `${DEFAULT_CONFIG}welcome_recent: false\n`);
    s = spawnTaria({ home, cols: 110, rows: 30 });
    await s.waitStable({ lastLine: /context/ });
    const text = s.all().join('\n');
    expect(text).toContain('Welcome back!');
    expect(text).not.toContain('Private matter');
    expect(text).not.toContain('Recent activity');
  });

  it('a conversation title cannot send control sequences to the terminal', async () => {
    const home = homeWith(['evil\x1b]0;pwned\x07\x1b[2J title']);
    s = spawnTaria({ home, cols: 110, rows: 30 });
    await s.waitStable({ lastLine: /context/ });
    expect(s.raw).not.toContain('\x1b]0;pwned');
    expect(s.raw).not.toContain('\x1b[2J title');
    expect(s.all().join('\n')).toContain('evil]0;pwned[2J title');
  });

  it('taria -c: the box above the resumed conversation lists the recent ones straight away', async () => {
    const home = homeWith(['Garden beds', 'Regex for dates']);
    s = spawnTaria({ home, cols: 110, rows: 40, args: ['-c'] });
    await s.waitStable({ lastLine: /context/ });
    const text = boxLines(s.all().map((l) => l.trimEnd())).join('\n');
    expect(text).toContain('Welcome back!');
    expect(text.indexOf('Regex for dates')).toBeGreaterThan(0);
    expect(text.indexOf('Garden beds')).toBeGreaterThan(text.indexOf('Regex for dates'));
    // Drawn once: not first empty and then again.
    expect(s.raw.split('Recent activity').length - 1).toBe(1);
  });

  it('on resize: one column at 64, compact at 40, back to two columns, and always exactly one box', async () => {
    const home = homeWith(['Garden beds']);
    s = spawnTaria({ home, cols: 100, rows: 40 });
    await s.waitStable({ lastLine: /context/ });
    const check = async (cols: number, expectOwl: boolean, twoColumns: boolean) => {
      s!.resize(cols, 40);
      await s!.waitStable({ lastLine: /for commands/, quietMs: 400 });
      const all = s!.all().map((l) => l.trimEnd());
      expect(all.filter((l) => /^╭─+ taria v/.test(l)).length, `at ${cols}`).toBe(1);
      const box = boxLines(all);
      for (const l of box) expect(l.length, `at ${cols}: ${l}`).toBeLessThanOrEqual(cols);
      expect(box.join('\n').includes(OWL_EYES), `owl at ${cols}`).toBe(expectOwl);
      expect(box.some((l) => /█.*│ \S/.test(l)), `two columns at ${cols}`).toBe(twoColumns);
    };
    await check(64, true, false);
    await check(40, false, false);
    await check(120, true, true);
  }, 60_000);
});
