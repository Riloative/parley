// The welcome box (0.5.0): two columns with the owl on wide terminals, one
// column on narrower ones, a compact box on very narrow ones; never wider
// than the terminal, in any theme, with or without colour or Unicode.
import { afterEach, describe, expect, it } from 'vitest';
import { setColorLevel } from '../../src/term/caps.js';
import { setTheme } from '../../src/render/theme.js';
import { textWidth } from '../../src/render/width.js';
import { OWL, mascotLines } from '../../src/ui/mascot.js';
import { ago, welcomeBox, type WelcomeInfo } from '../../src/ui/welcome.js';

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (s: string) => plain(s).split('\n');

const info = (over: Partial<WelcomeInfo> = {}): WelcomeInfo => ({
  app: 'taria',
  version: '0.5.0',
  model: 'mock/echo',
  cwd: '/home/u/projects/notes',
  home: '/home/u',
  tips: ['Run /help to see every command and key', 'Type @ to attach a file, or paste an image', "Ctrl+O shows the model's thinking"],
  recent: [
    { title: 'Planning the garden beds', when: '2h ago' },
    { title: 'Regex for ISO dates', when: 'yesterday' },
  ],
  mascot: mascotLines(OWL),
  ...over,
});

afterEach(() => {
  setColorLevel(undefined);
  setTheme('dark');
});

describe('the welcome box', () => {
  it('wide: the title in the top border, the owl on the left, tips and recent conversations on the right', () => {
    const out = lines(welcomeBox(110, info()));
    expect(out[0]).toMatch(/^╭─── taria v0\.5\.0 ─+╮$/);
    expect(out.at(-1)).toMatch(/^╰─+╯$/);
    for (const l of out) expect(textWidth(l)).toBe(110);
    const tips = out.findIndex((l) => l.includes('Tips for getting started'));
    const owl = out.findIndex((l) => l.includes(mascotLines(OWL)[0]!));
    expect(tips).toBe(1);
    expect(owl).toBeGreaterThan(1);
    // Left and right share the same rows, divided by a vertical line.
    expect(out[owl]).toMatch(/█.*│ /);
    const recent = out.findIndex((l) => l.includes('Recent activity'));
    expect(recent).toBeGreaterThan(tips);
    expect(out[recent + 1]).toContain('Planning the garden beds · 2h ago');
    expect(out.join('\n')).toContain('echo · mock');
    expect(out.join('\n')).toContain('~/projects/notes');
    expect(out.join('\n')).toContain('Welcome back!');
  });

  it('one column below 76 columns: greeting, owl, model and folder, then tips and recent conversations', () => {
    const out = lines(welcomeBox(64, info()));
    for (const l of out) expect(textWidth(l)).toBe(64);
    const owl = out.findIndex((l) => l.includes('█'));
    const tips = out.findIndex((l) => l.includes('Tips for getting started'));
    expect(owl).toBeGreaterThan(0);
    expect(tips).toBeGreaterThan(owl);
    expect(out.some((l) => /│ .*│ .*│/.test(l))).toBe(false);
  });

  it('compact below 44 columns: no owl, no tips, just who, which model and where', () => {
    const out = lines(welcomeBox(40, info()));
    for (const l of out) expect(textWidth(l)).toBe(40);
    expect(out.join('\n')).not.toMatch(/[█▀▄]/);
    expect(out.join('\n')).not.toContain('Tips');
    expect(out.length).toBe(5);
  });

  it('is never wider than the terminal, at any width, with long titles, wide characters and a deep folder', () => {
    const long = info({
      name: 'Alexandria-Wilhelmina',
      cwd: '/home/u/' + 'very-long-folder-name/'.repeat(8),
      recent: [{ title: '中文标题非常长的对话标题 '.repeat(6), when: '3d ago' }, { title: 'x'.repeat(300), when: 'yesterday' }, { title: 'emoji 🎉🎉🎉 title', when: 'just now' }],
    });
    for (let cols = 20; cols <= 220; cols++) {
      for (const l of lines(welcomeBox(cols, long))) expect(textWidth(l), `at ${cols} columns`).toBeLessThanOrEqual(Math.max(cols, 20));
    }
  });

  it('without Unicode: ASCII borders and an ASCII owl', () => {
    const out = plain(welcomeBox(110, info({ mascot: mascotLines(OWL, false) }), false));
    expect(out).not.toMatch(/[─│╭╮╰╯█▀▄…]/);
    expect(out.split('\n')[0]).toMatch(/^\+--- taria v0\.5\.0 -+\+$/);
  });

  it('without colour (NO_COLOR): no colour codes, only bold', () => {
    setColorLevel(0);
    const out = welcomeBox(110, info());
    expect(out.match(/\x1b\[[0-9;]*m/g)!.every((c) => c === '\x1b[1m' || c === '\x1b[0m' || c === '\x1b[22m')).toBe(true);
  });

  it('in each theme the border takes that theme\'s accent', () => {
    setColorLevel(3);
    setTheme('dark');
    expect(welcomeBox(110, info())).toContain('38;2;217;119;87');
    setTheme('light');
    expect(welcomeBox(110, info())).toContain('38;2;193;95;60');
    setTheme('ansi');
    expect(welcomeBox(110, info())).toMatch(/\x1b\[33m/);
  });

  it('greets by name from the config, says "Welcome to" on the first start, and plain "Welcome back!" otherwise', () => {
    expect(plain(welcomeBox(110, info({ name: 'Rue' })))).toContain('Welcome back, Rue!');
    expect(plain(welcomeBox(110, info({ firstRun: true, name: 'Rue' })))).toContain('Welcome to taria!');
    expect(plain(welcomeBox(110, info()))).toContain('Welcome back!');
  });

  it('a conversation title or a name cannot send terminal control sequences', () => {
    setColorLevel(0);
    const evil = info({ name: 'a\x1b]0;pwned\x07b', recent: [{ title: 'title\x1b[2J\x1b[Hwiped\r\n', when: 'now' }] });
    const out = plain(welcomeBox(110, evil));
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(out).toContain('Welcome back, a]0;pwnedb!');
  });

  it('without conversations: "No recent activity"; with recent hidden: no recent section at all', () => {
    expect(plain(welcomeBox(110, info({ recent: [] })))).toContain('No recent activity');
    const hidden = plain(welcomeBox(110, info({ recent: undefined })));
    expect(hidden).not.toContain('Recent activity');
    expect(hidden).toContain('Tips for getting started');
  });

  it('with no model selected, says how to pick one', () => {
    expect(plain(welcomeBox(110, info({ model: '' })))).toContain('no model yet · /model to pick one');
  });
});

describe('ago()', () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  it('says how long ago, in plain words', () => {
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 2 * 3600_000, now)).toBe('2h ago');
    expect(ago(now - 30 * 3600_000, now)).toBe('yesterday');
    expect(ago(now - 3 * 86400_000, now)).toBe('3d ago');
    expect(ago(now - 20 * 86400_000, now)).toBe('2w ago');
    expect(ago(now - 400 * 86400_000, now)).toBe('over a year ago');
    expect(ago(now + 60_000, now)).toBe('just now');
  });
});

describe('Recent activity filled in after the first frame', () => {
  const entries = [
    { title: 'One', when: '1h ago' },
    { title: 'Two', when: '2h ago' },
    { title: 'Three', when: 'yesterday' },
  ];
  it('the placeholder and the filled box have the same height at every layout, for 0 to 3 conversations', () => {
    for (const cols of [110, 76, 64, 50]) {
      const placeholder = lines(welcomeBox(cols, info({ recent: 'loading' }))).length;
      for (let n = 0; n <= 3; n++) {
        expect(lines(welcomeBox(cols, info({ recent: entries.slice(0, n) }))).length, `${cols} columns, ${n} conversations`).toBe(placeholder);
      }
    }
  });
  it('the placeholder shows the heading and empty rows, nothing else', () => {
    const out = plain(welcomeBox(110, info({ recent: 'loading' })));
    expect(out).toContain('Recent activity');
    expect(out).not.toContain('No recent activity');
  });
});
