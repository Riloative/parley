import { beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown, StreamingMarkdown } from '../../src/render/markdown.js';
import { loadHighlighter } from '../../src/render/highlight.js';
import { lineToAnsi, plainText, type Line } from '../../src/render/style.js';
import { lineWidth } from '../../src/render/width.js';
import { MARKDOWN_SAMPLE } from '../../src/providers/mock.js';

const plain = (lines: Line[]) => lines.map(plainText);

function streamAll(src: string, width: number, chunk: (i: number) => number) {
  const md = new StreamingMarkdown(width);
  const committed: Line[] = [];
  let i = 0;
  const lives: Line[][] = [];
  while (i < src.length) {
    i = Math.min(src.length, i + chunk(i));
    const u = md.update(src.slice(0, i));
    committed.push(...u.commit);
    lives.push(u.live);
  }
  const f = md.update(src, true);
  committed.push(...f.commit);
  return { committed, lives };
}

const NASTY = [
  // nested lists with code
  '- one\n  - nested\n\n    ```js\n    const x = 1;\n    ```\n  - after code\n- two\n\nend\n',
  // table inside a block quote
  '> | a | b |\n> |---|---|\n> | 1 | 2 |\n\nafter\n',
  // raw HTML blocks and inline HTML
  '<details>\n<summary>Click</summary>\n\nhidden *text*\n\n</details>\n\nInline <b>bold</b> tag.\n',
  // CRLF line endings
  '# Title\r\n\r\nPara one\r\nline two\r\n\r\n```py\r\nx = 1\r\n```\r\n',
  // tabs
  '- item\n\tcontinued\n\n```\n\tindented\twith\ttabs\n```\n\n\tindented code block\n',
  // very long words and URLs
  'Supercalifragilisticexpialidocious'.repeat(8) + ' and https://example.com/' + 'a'.repeat(150) + '\n',
  // emoji and CJK
  '日本語のテキストと絵文字 👩‍👩‍👧‍👦 と 🇯🇵 が混ざった段落。\n\n| 名前 | 値 |\n|---|---|\n| テスト | 👍 |\n',
  // tilde fences, longer fences, fence inside fence
  '~~~python\nprint(1)\n~~~\n\n````md\n```js\ninner\n```\n````\n',
  // setext headings
  'Heading one\n===========\n\nHeading two\n-----------\n\nNot a heading\n',
  // links split in awkward places
  'See [the docs](https://example.com/path?query=1&b=2) and [another\nlink](http://x.y) and <https://auto.link>.\n',
  // empty list items, hr variations, escaped chars
  '-\n- \n* * *\n___\n\\*not emphasis\\* and \\`not code\\`\n',
];

const DOCS = [
  MARKDOWN_SAMPLE,
  '# Title\n\nSome text\nwith two lines\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter code.\n',
  'Para one.\n\n- a\n- b\n\n  continued\n- c\n\nPara two\n===\n\nThird\n---\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n',
  '```\nunclosed fence\nline 2\n',
  '> quote\n> more\n\n1. one\n2. two\n\n***\n\nend',
  'Text with **bold** and `code` and a [link](https://example.com/very/long/path).',
];

describe('markdown rendering', () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it('never emits lines wider than the width', () => {
    for (const w of [20, 40, 60, 120]) {
      for (const d of DOCS) {
        for (const l of renderMarkdown(d, { width: w })) expect(lineWidth(l)).toBeLessThanOrEqual(w);
      }
    }
  });

  it('renders tables with box borders and falls back to vertical layout when too narrow', () => {
    const wide = plain(renderMarkdown(DOCS[3]!, { width: 60 }));
    expect(wide[0]).toMatch(/^┌─+┬─+┐$/);
    expect(wide.some((l) => l.includes('│ 1 '))).toBe(true);
    const many = '| a | b | c | d | e | f | g | h |\n|-|-|-|-|-|-|-|-|\n| alpha | beta | gamma | delta | epsilon | zeta | eta | theta |\n';
    const narrow = plain(renderMarkdown(many, { width: 24 }));
    expect(narrow.some((l) => l.startsWith('a: alpha'))).toBe(true);
  });

  it('labels and indents code blocks', () => {
    const out = plain(renderMarkdown('```python\nprint(1)\n```', { width: 40 }));
    expect(out).toEqual(['python', '  print(1)']);
  });

  for (const [di, doc] of DOCS.entries()) {
    for (const width of [24, 60, 200]) {
      for (const size of [1, 3, 17, 1000]) {
        it(`streams doc ${di} at width ${width} in chunks of ${size} identically to a one-shot render`, () => {
          const { committed } = streamAll(doc, width, () => size);
          expect(plain(committed)).toEqual(plain(renderMarkdown(doc, { width })));
        });
      }
    }
  }

  it('handles nasty inputs: streamed output equals a one-shot render and fits the width', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const doc of NASTY) {
      for (const width of [12, 30, 80]) {
        for (let round = 0; round < 6; round++) {
          const { committed } = streamAll(doc, width, () => 1 + Math.floor(rand() * (round < 3 ? 4 : 40)));
          const once = renderMarkdown(doc, { width });
          expect(plain(committed)).toEqual(plain(once));
          for (const l of committed) expect(lineWidth(l)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('streams with random chunk sizes identically (property)', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 40; n++) {
      const doc = DOCS[n % DOCS.length]!;
      const width = 20 + Math.floor(rand() * 100);
      const { committed } = streamAll(doc, width, () => 1 + Math.floor(rand() * 12));
      expect(plain(committed)).toEqual(plain(renderMarkdown(doc, { width })));
    }
  });

  it('commits a long open code block progressively', () => {
    const code = '```js\n' + Array.from({ length: 100 }, (_, i) => `line${i}();`).join('\n') + '\n';
    const md = new StreamingMarkdown(60);
    const u = md.update(code);
    expect(u.commit.length).toBeGreaterThan(90);
    expect(u.live.length).toBeLessThan(3);
  });

  it('does not flash raw markup for half-arrived inline markers or table rows', () => {
    const md = new StreamingMarkdown(60);
    const u = md.update('Some **bol');
    expect(plain(u.live).join('\n')).toBe('Some bol');
    const md2 = new StreamingMarkdown(60);
    const u2 = md2.update('Intro\n\n| a | b');
    expect(plain(u2.live).join('\n')).not.toContain('|');
  });
});

describe('soft_line_breaks', () => {
  const md = 'one\ntwo  \nthree\n\n- item a\n  item b';
  it('keeps a single newline as a line break by default, and joins the lines with join', async () => {
    const { setSoftLineBreaks } = await import('../../src/render/markdown.js');
    const text = (src: string) => renderMarkdown(src, { width: 60 }).map(plainText);
    try {
      expect(text(md)).toEqual(['one', 'two', 'three', '', '- item a', '  item b']);
      setSoftLineBreaks('join');
      // A hard break (two trailing spaces) is still a break.
      expect(text(md)).toEqual(['one two', 'three', '', '- item a item b']);
      // Streaming gives the same result as a one-shot render.
      const s = new StreamingMarkdown(60);
      const lines: Line[] = [];
      for (let i = 1; i <= md.length; i++) lines.push(...s.update(md.slice(0, i), i === md.length).commit);
      expect(lines.map(plainText)).toEqual(text(md));
    } finally {
      setSoftLineBreaks('keep');
    }
  });
});

describe('numbered code blocks', () => {
  const CODE_DOCS = [
    ...NASTY,
    ...DOCS,
    'One:\n\n```js\na()\n```\n\nTwo, nested:\n\n- item\n\n  ```py\n  b()\n  ```\n\n> quoted\n>\n> ```\n> c()\n> ```\n\n    indented()\n\nFive, unclosed:\n\n```sh\nd\n',
  ];
  const numbered = (lines: Line[]) => plain(lines).flatMap((l) => (/ · (\d+)$/.exec(l) ? [Number(/ · (\d+)$/.exec(l)![1])] : []));

  it('labels every code block 1..n in the order /copy code uses', async () => {
    const { codeBlockTexts } = await import('../../src/render/markdown.js');
    for (const doc of CODE_DOCS) {
      const blocks = codeBlockTexts(doc);
      const lines = renderMarkdown(doc, { width: 60, numberCode: true });
      expect(numbered(lines), doc).toEqual(blocks.map((_, i) => i + 1));
      // Without the option nothing changes.
      expect(numbered(renderMarkdown(doc, { width: 60 }))).toEqual([]);
    }
    expect(codeBlockTexts(CODE_DOCS[CODE_DOCS.length - 1]!)).toEqual(['a()', 'b()', 'c()', 'indented()', 'd']);
  });

  it('streams to the same numbered output as a one-shot render, for any chunking', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const doc of CODE_DOCS) {
      for (const width of [12, 30, 80]) {
        const expected = plain(renderMarkdown(doc, { width, numberCode: true }));
        for (const chunk of [() => 1, () => 7, () => 1 + Math.floor(rnd() * 40)]) {
          const md = new StreamingMarkdown(width, { numberCode: true });
          const committed: Line[] = [];
          for (let i = 0; i < doc.length; ) {
            i = Math.min(doc.length, i + chunk());
            committed.push(...md.update(doc.slice(0, i)).commit);
          }
          committed.push(...md.update(doc, true).commit);
          expect(plain(committed), `${width}: ${JSON.stringify(doc)}`).toEqual(expected);
        }
      }
    }
  });
});

describe('hyperlinks (OSC 8)', () => {
  const OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
  const CLOSE = '\x1b]8;;\x1b\\';
  const ansi = (src: string, width = 80) => renderMarkdown(src, { width }).map(lineToAnsi).join('\n');

  it('makes web and mail links clickable and hides the URL; everything else keeps "text (url)"', async () => {
    const { setHyperlinks } = await import('../../src/term/caps.js');
    const { setColorLevel } = await import('../../src/term/caps.js');
    setColorLevel(3);
    try {
      setHyperlinks(true);
      const on = ansi('See [the docs](https://example.com/a?b=1&c=2) and <https://auto.link> and [mail](mailto:me@example.com).');
      expect(on).toContain(OPEN('https://example.com/a?b=1&c=2'));
      expect(on).toContain(OPEN('https://auto.link'));
      expect(on).toContain(OPEN('mailto:me@example.com'));
      expect(on.split(CLOSE).length - 1).toBe(on.split('\x1b]8;;h').length - 1 + on.split('\x1b]8;;m').length - 1);
      expect(plain(renderMarkdown('See [the docs](https://example.com/a).', { width: 80 }))).toEqual(['See the docs.']);

      // Not clickable: other schemes, and anything that could end the sequence.
      for (const bad of ['[x](file:///etc/passwd)', '[x](javascript:alert(1))', '[x](myapp://do)', '[x](<https://a.b/\x1b]0;t\x07>)', '[x](<https://a.b/ c>)']) {
        expect(ansi(bad), bad).not.toContain('\x1b]8;');
      }
      expect(plain(renderMarkdown('[x](file:///etc/passwd)', { width: 80 }))).toEqual(['x (file:///etc/passwd)']);

      // A wrapped link: every piece is its own closed link, and no line is too wide.
      const long = `[${'word '.repeat(20).trim()}](https://example.com/long)`;
      const lines = renderMarkdown(long, { width: 30 });
      expect(lines.length).toBeGreaterThan(2);
      for (const l of lines) {
        expect(lineWidth(l)).toBeLessThanOrEqual(30);
        const a = lineToAnsi(l);
        expect(a.split(OPEN('https://example.com/long')).length - 1).toBe(a.split(CLOSE).length - 1);
      }

      setHyperlinks(false);
      const off = ansi('See [the docs](https://example.com/a).');
      expect(off).not.toContain('\x1b]8;');
      expect(plain(renderMarkdown('See [the docs](https://example.com/a).', { width: 80 }))).toEqual(['See the docs (https://example.com/a).']);
    } finally {
      setHyperlinks(undefined);
      setColorLevel(undefined);
    }
  });
});
