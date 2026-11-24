// Tables built from dynamic text (/help, /cost): every cell must come out as
// the literal text that went in, whatever Markdown or `|` it contains.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import { builtinCommands, loadCustomCommands, type CommandDef, type UiApi } from '../../src/commands/commands.js';
import { CostTracker } from '../../src/core/usage.js';
import { inlineSpans, lex, mdTable, renderMarkdown } from '../../src/render/markdown.js';
import { plainText } from '../../src/render/style.js';
import { lineWidth } from '../../src/render/width.js';

const WIDTHS = [120, 80, 60, 40, 24];

function run(name: string, cmds: CommandDef[], extra: Partial<UiApi> = {}): string {
  let md = '';
  const ui = { commands: () => cmds, info: (m: string) => (md = m), notice: () => {}, config: { prices: {} }, ...extra } as unknown as UiApi;
  void cmds.find((c) => c.name === name)!.run(ui, '');
  return md;
}

/** The cells of every table in a Markdown document, as plain text. */
function tables(md: string): string[][][] {
  return lex(md)
    .filter((t): t is Tokens.Table => t.type === 'table')
    .map((t) => [t.header, ...t.rows].map((row) => row.map((c) => inlineSpans(c.tokens).map((s) => s.text).join(''))));
}

function expectFits(md: string): void {
  for (const w of WIDTHS) {
    const lines = renderMarkdown(md, { width: w });
    for (const l of lines) {
      expect(lineWidth(l), `width ${w}: ${plainText(l)}`).toBeLessThanOrEqual(w);
      const text = plainText(l);
      // A row of a two-column table has exactly three vertical bars.
      if (text.startsWith('│')) expect(text.split('│').length - 1, `width ${w}: ${text}`).toBe(3);
    }
  }
}

function customCommands(): CommandDef[] {
  const dir = mkdtempSync(join(tmpdir(), 'parley-cmds-'));
  writeFileSync(join(dir, 'pipe.md'), '---\ndescription: a | b || c, *stars*, `ticks`, [link](http://x.y), <tag> & \\ end\nargument-hint: <a|b> [--x|--y]\n---\nBody');
  writeFileSync(join(dir, 'plain.md'), 'First line | with a pipe and https://example.com/a_b_c and user@example.com\n');
  return loadCustomCommands(dir);
}

describe('/help', () => {
  const cmds = [...builtinCommands(), ...customCommands()];
  const md = run('help', cmds);
  const [commandTable, keyTable] = tables(md);

  it('has one row of exactly two cells per command, with the literal hint and description', () => {
    expect(commandTable!.length).toBe(cmds.length + 1);
    for (const row of commandTable!) expect(row.length, row.join(' ¦ ')).toBe(2);
    for (const c of cmds) {
      const row = commandTable!.find((r) => r[0] === `/${c.name}${c.argHint ? ` ${c.argHint}` : ''}`);
      expect(row, `/${c.name}`).toBeDefined();
      expect(row![1]!.startsWith(c.description), `/${c.name}: ${row![1]}`).toBe(true);
    }
    // The two that were broken, and a custom command full of Markdown.
    expect(commandTable!.map((r) => r[0])).toContain('/theme [dark|light|ansi|auto]');
    expect(commandTable!.find((r) => r[0] === '/pipe <a|b> [--x|--y]')![1]).toBe('a | b || c, *stars*, `ticks`, [link](http://x.y), <tag> & \\ end');
    expect(commandTable!.find((r) => r[0] === '/plain')![1]).toBe('First line | with a pipe and https://example.com/a_b_c and user@example.com'.slice(0, 70));
  });

  it('keeps the Keys table to two cells per row', () => {
    expect(keyTable!.length).toBeGreaterThan(10);
    for (const row of keyTable!) expect(row.length, row.join(' ¦ ')).toBe(2);
    expect(keyTable!.map((r) => r[0])).toContain('Shift+Enter, Alt+Enter, Ctrl+J, \\ then Enter');
  });

  it('never renders a line wider than the terminal, at any width', () => {
    expectFits(md);
  });
});

describe('/cost', () => {
  it('keeps a model name with pipes and Markdown in one cell', () => {
    const costs = new CostTracker();
    costs.add('local/weird|model_name*v2*', { inputTokens: 10, outputTokens: 5 }, 5, 10);
    costs.add('mock/echo', undefined, 7, 3);
    const md = run('cost', builtinCommands(), { session: { costs } as never });
    const [t] = tables(md);
    expect(t!.length).toBe(3);
    for (const row of t!) expect(row.length, row.join(' ¦ ')).toBe(6);
    expect(t![1]![0]).toBe('local/weird|model_name*v2*');
    for (const w of WIDTHS) for (const l of renderMarkdown(md, { width: w })) expect(lineWidth(l)).toBeLessThanOrEqual(w);
  });
});

describe('mdTable', () => {
  it('round-trips any cell text literally', () => {
    const nasty = ['a|b', '\\|', '\\', '`x`', '**b**', '_i_', '[t](u)', '<b>', '&amp;', '~~s~~', 'line\nbreak', '', '  padded  ', '$1 #2 !3', 'https://a.b/c_d', 'www.example.com', 'me@example.com', '1. x', '- y', '> z', '|', '||', 'a\\|b'];
    const md = mdTable(['h|1', 'h*2*'], nasty.map((n, i) => [n, nasty[nasty.length - 1 - i]!]));
    const [t] = tables(md);
    const clean = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
    expect(t![0]).toEqual(['h|1', 'h*2*']);
    expect(t!.slice(1)).toEqual(nasty.map((n, i) => [clean(n), clean(nasty[nasty.length - 1 - i]!)]));
  });
});
