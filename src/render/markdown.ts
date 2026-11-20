// Markdown → styled terminal lines, plus an incremental renderer for
// streaming. Uses marked's lexer only (no HTML rendering).

import { Lexer, type Token, type Tokens } from 'marked';
import { highlight, isHighlighterReady, loadHighlighter, normalizeLang } from './highlight.js';
import type { Line, Span, Style } from './style.js';
import { hardWrap, lineWidth, mergeSpans, padEnd, textWidth, wrapSpans } from './width.js';

export interface MdOptions {
  /** Content width in cells (already excludes any message prefix). */
  width: number;
}

const DIM: Style = { fg: 'dim' };

let joinSoftBreaks = false;

/** `soft_line_breaks: join` renders a single newline inside a paragraph as a
 * space (CommonMark); the default keeps it as a line break. */
export function setSoftLineBreaks(mode: 'keep' | 'join'): void {
  joinSoftBreaks = mode === 'join';
}

export function lex(src: string): Token[] {
  return Lexer.lex(src, { gfm: true, breaks: false });
}

// ------------------------------------------------------------- inline

export function inlineSpans(tokens: Token[] | undefined, base: Style = {}): Span[] {
  const out: Span[] = [];
  if (!tokens) return out;
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineSpans(tt.tokens, base));
        else out.push({ text: joinSoftBreaks ? tt.text.replace(/ *\n */g, ' ') : tt.text, style: base });
        break;
      }
      case 'escape':
        out.push({ text: (t as Tokens.Escape).text, style: base });
        break;
      case 'strong':
        out.push(...inlineSpans((t as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case 'em':
        out.push(...inlineSpans((t as Tokens.Em).tokens, { ...base, italic: true }));
        break;
      case 'del':
        out.push(...inlineSpans((t as Tokens.Del).tokens, { ...base, strike: true }));
        break;
      case 'codespan':
        out.push({ text: (t as Tokens.Codespan).text, style: { ...base, fg: 'code' } });
        break;
      case 'br':
        out.push({ text: '\n' });
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const inner = inlineSpans(l.tokens, { ...base, fg: 'link', underline: true });
        const label = inner.map((s) => s.text).join('');
        out.push(...inner);
        if (l.href && label !== l.href && !l.href.startsWith('mailto:') && label !== l.href.replace(/^https?:\/\//, '')) {
          out.push({ text: ` (${l.href})`, style: { ...base, fg: 'dim' } });
        }
        break;
      }
      case 'image': {
        const im = t as Tokens.Image;
        out.push({ text: `[image: ${im.text || im.href}]`, style: { ...base, fg: 'dim' } });
        break;
      }
      case 'html':
        out.push({ text: (t as Tokens.HTML).text, style: base });
        break;
      case 'checkbox':
        out.push({ text: (t as Tokens.Checkbox).checked ? '[x] ' : '[ ] ', style: base });
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ text: t.text, style: base });
    }
  }
  return out;
}

// ------------------------------------------------------------- blocks

function renderCode(token: Tokens.Code, width: number): Line[] {
  const lang = token.lang?.trim() || undefined;
  const out: Line[] = [];
  if (lang) out.push([{ text: lang.split(/\s/)[0]!, style: DIM }]);
  out.push(...codeBodyLines(token.text, lang, width));
  return out;
}

/** Code lines, each source line hard-wrapped and indented by two cells. */
export function codeBodyLines(code: string, lang: string | undefined, width: number, groups?: number[]): Line[] {
  const indent = 2;
  const inner = Math.max(1, width - indent);
  const hl = highlight(code, lang);
  const src = code.split('\n');
  const out: Line[] = [];
  src.forEach((line, i) => {
    const styled: Line = hl?.[i] ?? (line ? [{ text: line }] : []);
    const wrapped = wrapCodeLine(styled, inner);
    groups?.push(wrapped.length);
    for (const w of wrapped) out.push([{ text: ' '.repeat(indent) }, ...w]);
  });
  return out;
}

function wrapCodeLine(line: Line, width: number): Line[] {
  // Expand tabs so widths are predictable.
  const expanded = line.map((s) => ({ ...s, text: s.text.replace(/\t/g, '    ') }));
  if (lineWidth(expanded) <= width) return [expanded];
  const out: Line[] = [];
  let cur: Span[] = [];
  let w = 0;
  for (const s of expanded) {
    for (const piece of hardWrap(s.text, 1e9)) {
      for (const ch of splitGraphemesKeep(piece)) {
        const cw = textWidth(ch);
        if (w + cw > width && cur.length) {
          out.push(mergeSpans(cur));
          cur = [];
          w = 0;
        }
        cur.push({ text: ch, style: s.style });
        w += cw;
      }
    }
  }
  if (cur.length) out.push(mergeSpans(cur));
  return out;
}

function splitGraphemesKeep(s: string): string[] {
  return /^[\x20-\x7e]*$/.test(s) ? s.split('') : Array.from(new Intl.Segmenter().segment(s), (x) => x.segment);
}

function renderList(list: Tokens.List, width: number, depth: number): Line[] {
  const out: Line[] = [];
  const start = typeof list.start === 'number' ? list.start : Number(list.start) || 1;
  const numbers = list.items.map((_, i) => `${start + i}.`);
  const markerWidth = list.ordered ? Math.max(...numbers.map((n) => n.length)) + 1 : 2;
  list.items.forEach((item, i) => {
    if (i > 0 && list.loose) out.push([]);
    const marker = list.ordered ? padEnd(numbers[i]!, markerWidth) : depth % 2 === 0 ? '- ' : '◦ ';
    const inner = Math.max(1, width - markerWidth);
    const body: Line[] = [];
    let first = true;
    for (const t of item.tokens) {
      if (t.type === 'checkbox') continue;
      const lines =
        t.type === 'text'
          ? wrapSpans(withTask(item, inlineSpans((t as Tokens.Text).tokens ?? [{ type: 'text', raw: t.raw, text: (t as Tokens.Text).text } as Token]), first), inner)
          : t.type === 'list'
            ? renderList(t as Tokens.List, inner, depth + 1)
            : t.type === 'space'
              ? []
              : renderBlock(t, inner, depth + 1);
      if (t.type === 'paragraph' && first) {
        // Loose list item paragraphs: prepend task marker.
        lines.splice(0, lines.length, ...wrapSpans(withTask(item, inlineSpans((t as Tokens.Paragraph).tokens), true), inner));
      }
      if (body.length && t.type !== 'list' && t.type !== 'space' && item.loose) body.push([]);
      body.push(...lines);
      if (t.type !== 'space') first = false;
    }
    if (body.length === 0) body.push([]);
    body.forEach((l, j) => {
      const prefix: Span = j === 0 ? { text: marker, style: list.ordered ? undefined : DIM } : { text: ' '.repeat(markerWidth) };
      out.push([prefix, ...l]);
    });
  });
  return out;
}

function withTask(item: Tokens.ListItem, spans: Span[], first: boolean): Span[] {
  if (!first || !item.task) return spans;
  return [{ text: item.checked ? '☑ ' : '☐ ', style: item.checked ? { fg: 'success' } : DIM }, ...spans];
}

function renderQuote(q: Tokens.Blockquote, width: number, depth: number): Line[] {
  const inner = renderBlocks(q.tokens, Math.max(1, width - 2), depth);
  return inner.map((l) => [{ text: '▎ ', style: DIM }, ...l.map((s) => ({ ...s, style: { ...s.style, italic: true } }))]);
}

type Align = 'left' | 'right' | 'center' | null;

export function renderTable(table: Tokens.Table, width: number): Line[] {
  const ncols = table.header.length;
  const head = table.header.map((c) => inlineSpans(c.tokens, { bold: true }));
  const rows = table.rows.map((r) => r.map((c) => inlineSpans(c.tokens)));
  const aligns: Align[] = table.align as Align[];
  const natural = (col: number) => Math.max(...[head[col]!, ...rows.map((r) => r[col] ?? [])].map((s) => textWidth(s.map((x) => x.text).join(''))), 1);
  const minWord = (col: number) =>
    Math.max(
      ...[head[col]!, ...rows.map((r) => r[col] ?? [])].map((s) =>
        Math.max(0, ...s.map((x) => x.text).join('').split(/\s+/).map((w) => textWidth(w))),
      ),
      1,
    );
  const overhead = ncols * 3 + 1; // "│ " + " " per column + final "│"
  const avail = width - overhead;
  const widths = Array.from({ length: ncols }, (_, i) => natural(i));
  const floors = Array.from({ length: ncols }, (_, i) => Math.min(widths[i]!, Math.max(4, Math.min(minWord(i), 14))));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > avail) {
    // Shrink the widest column that can still give.
    let idx = -1;
    for (let i = 0; i < ncols; i++) if (widths[i]! > floors[i]! && (idx < 0 || widths[i]! > widths[idx]!)) idx = i;
    if (idx < 0) break;
    widths[idx]!--;
    total--;
  }
  if (total > avail || avail < ncols * 3) return renderTableVertical(head, rows, width);

  const B = DIM;
  const rule = (l: string, m: string, r: string): Line => [{ text: l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, style: B }];
  const renderRow = (cells: Span[][], isHead: boolean): Line[] => {
    const wrapped = cells.map((c, i) => wrapSpans(c, widths[i]!));
    const h = Math.max(1, ...wrapped.map((w) => w.length));
    const lines: Line[] = [];
    for (let r = 0; r < h; r++) {
      const line: Span[] = [{ text: '│', style: B }];
      for (let i = 0; i < ncols; i++) {
        const content = wrapped[i]?.[r] ?? [];
        const cw = lineWidth(content);
        const pad = widths[i]! - cw;
        const al = isHead ? (aligns[i] ?? 'left') : (aligns[i] ?? 'left');
        const left = al === 'right' ? pad : al === 'center' ? Math.floor(pad / 2) : 0;
        line.push({ text: ' ' + ' '.repeat(left) });
        line.push(...content);
        line.push({ text: ' '.repeat(pad - left) + ' ' });
        line.push({ text: '│', style: B });
      }
      lines.push(mergeSpans(line));
    }
    return lines;
  };
  const out: Line[] = [rule('┌', '┬', '┐'), ...renderRow(head, true), rule('├', '┼', '┤')];
  for (const r of rows) out.push(...renderRow(Array.from({ length: ncols }, (_, i) => r[i] ?? []), false));
  out.push(rule('└', '┴', '┘'));
  return out;
}

function renderTableVertical(head: Span[][], rows: Span[][][], width: number): Line[] {
  const out: Line[] = [];
  rows.forEach((r, ri) => {
    if (ri > 0) out.push([{ text: '─'.repeat(Math.min(width, 20)), style: DIM }]);
    head.forEach((h, i) => {
      out.push(...wrapSpans([...h.map((s) => ({ ...s, style: { ...s.style, bold: true } })), { text: ': ' }, ...(r[i] ?? [])], width, { restPrefix: [{ text: '  ' }] }));
    });
  });
  return out;
}

export function renderBlock(t: Token, width: number, depth = 0): Line[] {
  switch (t.type) {
    case 'paragraph':
      return wrapSpans(inlineSpans((t as Tokens.Paragraph).tokens), width);
    case 'text': {
      const tt = t as Tokens.Text;
      return wrapSpans(tt.tokens ? inlineSpans(tt.tokens) : [{ text: tt.text }], width);
    }
    case 'heading': {
      const h = t as Tokens.Heading;
      const style: Style = h.depth === 1 ? { bold: true, underline: true } : h.depth === 2 ? { bold: true } : { bold: true, italic: h.depth >= 4 };
      return wrapSpans(inlineSpans(h.tokens, style), width);
    }
    case 'code':
      return renderCode(t as Tokens.Code, width);
    case 'list':
      return renderList(t as Tokens.List, width, depth);
    case 'blockquote':
      return renderQuote(t as Tokens.Blockquote, width, depth);
    case 'table':
      return renderTable(t as Tokens.Table, width);
    case 'hr':
      return [[{ text: '─'.repeat(Math.max(1, Math.min(width, 80))), style: DIM }]];
    case 'html':
      return wrapSpans([{ text: (t as Tokens.HTML).text.replace(/\n+$/, ''), style: DIM }], width);
    case 'space':
    case 'def':
      return [];
    default:
      return 'raw' in t ? wrapSpans([{ text: t.raw.replace(/\n+$/, '') }], width) : [];
  }
}

export function renderBlocks(tokens: Token[], width: number, depth = 0): Line[] {
  const out: Line[] = [];
  for (const t of tokens) {
    if (t.type === 'space' || t.type === 'def') continue;
    const lines = renderBlock(t, width, depth);
    if (!lines.length) continue;
    if (out.length) out.push([]);
    out.push(...lines);
  }
  return out;
}

export function renderMarkdown(src: string, opts: MdOptions): Line[] {
  return renderBlocks(lex(normalize(src)), Math.max(8, opts.width));
}

export function normalize(src: string): string {
  return src.replace(/\r\n?/g, '\n');
}

// ------------------------------------------------------------- streaming

function isOpenFence(t: Token): boolean {
  if (t.type !== 'code') return false;
  const raw = t.raw;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return false; // indented code block
  const fence = open[1]!;
  const lines = raw.replace(/\n$/, '').split('\n');
  if (lines.length < 2) return true;
  const last = lines[lines.length - 1]!.trim();
  return !(last.startsWith(fence[0]!.repeat(fence.length)) && /^(`+|~+)$/.test(last));
}

/** Make an in-progress tail look finished: close dangling inline markers and
 * hold back a half-arrived table row or fence line. Live view only. */
function polishTail(src: string, inline = true): string {
  const nl = src.lastIndexOf('\n');
  const lastLine = src.slice(nl + 1);
  let s = src;
  if (lastLine && /^\s*(\||`{1,3}$|~{1,3}$)/.test(lastLine)) s = src.slice(0, nl + 1);
  if (!inline) return s;
  // Close unbalanced ** and ` in the final paragraph.
  const para = s.slice(s.lastIndexOf('\n\n') + 1);
  const ticks = (para.match(/`/g) ?? []).length;
  if (ticks % 2 === 1 && !/```/.test(para)) s += '`';
  else {
    const stars = (para.replace(/`[^`]*`/g, '').match(/\*\*/g) ?? []).length;
    if (stars % 2 === 1 && !/\*\*\s*$/.test(s)) s += '**';
  }
  return s;
}

export interface StreamUpdate {
  /** Newly finished lines: append to the permanent transcript, never change. */
  commit: Line[];
  /** The in-progress tail, re-rendered every frame. */
  live: Line[];
}

/**
 * Incremental Markdown renderer. Feed it the whole text so far; it returns
 * lines that are final (safe to write to scrollback once) and lines that may
 * still change. Each finished block is rendered and committed exactly once.
 *
 * A block's "full rendering" is its separator (a blank line, except for the
 * first block) followed by its lines. `partial` counts how many lines of the
 * current block's full rendering were already committed; that only happens
 * for open code fences, whose complete lines are final as soon as they end.
 */
export class StreamingMarkdown {
  private offset = 0; // source offset of the first uncommitted token
  private blocks = 0; // number of blocks committed (for spacing)
  private partial = 0;

  constructor(private readonly width: number) {}

  update(text: string, final = false): StreamUpdate {
    text = normalize(text);
    const tail = text.slice(this.offset);
    const tokens = lex(tail);
    const commit: Line[] = [];
    if (tokens.map((t) => t.raw).join('') !== tail) {
      // The lexer did not round-trip (not expected). Keep everything live
      // until the end so nothing is ever committed wrongly.
      const lines = this.full(renderBlocks(final ? tokens : lex(polishTail(tail)), this.width)).slice(this.partial);
      if (!final) return { commit, live: lines };
      this.offset = text.length;
      this.partial = 0;
      return { commit: lines, live: [] };
    }
    const content = tokens.filter((t) => t.type !== 'space' && t.type !== 'def');
    let stableCount = final ? content.length : Math.max(0, content.length - 1);
    // If the newest block has not completed its first line, the one before
    // it might still merge with it (e.g. a setext heading underline).
    if (!final && content.length >= 2 && !content[content.length - 1]!.raw.includes('\n')) stableCount = content.length - 2;

    let consumed = 0;
    let ci = 0;
    for (const t of tokens) {
      if (t.type === 'space' || t.type === 'def') {
        if (ci < stableCount) consumed += t.raw.length;
        continue;
      }
      if (ci >= stableCount) break;
      if (!final && t.type === 'code' && !isHighlighterReady() && normalizeLang((t as Tokens.Code).lang)) {
        void loadHighlighter();
        break; // hold finished code back until it can be highlighted
      }
      const lines = renderBlock(t, this.width);
      if (lines.length) {
        commit.push(...this.full(lines).slice(this.partial));
        this.blocks++;
      }
      this.partial = 0;
      consumed += t.raw.length;
      ci++;
    }
    if (final) consumed = tail.length;
    this.offset += consumed;
    if (final) return { commit, live: [] };

    const rest = text.slice(this.offset);
    const restTokens = lex(rest);
    const first = restTokens.find((t) => t.type !== 'space' && t.type !== 'def');
    const firstIsOpenFence = !!first && isOpenFence(first);
    // Commit the complete lines of an open code fence progressively, so a
    // long code block never has to fit in the live area.
    // Only once the opening fence line itself is complete: until then the
    // language label may still be arriving (```py… → ```python).
    if (first && firstIsOpenFence && first.raw.includes('\n')) {
      const code = first as Tokens.Code;
      const lang = code.lang?.trim() || undefined;
      if (isHighlighterReady() || !normalizeLang(lang)) {
        const groups: number[] = [];
        const body = codeBodyLines(code.text, lang, this.width, groups);
        const label: Line[] = lang ? [[{ text: lang.split(/\s/)[0]!, style: DIM }]] : [];
        // Complete source lines = newlines after the opening fence line.
        const complete = Math.min(groups.length, (code.raw.match(/\n/g) ?? []).length - 1);
        const stableBody = groups.slice(0, Math.max(0, complete)).reduce((a, b) => a + b, 0);
        const full = this.full([...label, ...body]);
        const target = full.length - body.length + stableBody;
        if (target > this.partial) {
          commit.push(...full.slice(this.partial, target));
          this.partial = target;
        }
      } else {
        void loadHighlighter();
      }
    }
    const rendered = renderBlocks(lex(polishTail(rest, !firstIsOpenFence)), this.width);
    const live = rendered.length ? this.full(rendered).slice(firstIsOpenFence ? this.partial : 0) : [];
    return { commit, live };
  }

  /** Separator + lines. */
  private full(lines: Line[]): Line[] {
    return this.blocks > 0 && lines.length ? [[], ...lines] : lines;
  }
}

const WARM_SAMPLE = `# Title

Some **bold**, *italic*, \`code\` and a [link](https://example.com).

- one
- two

> quote

| a | b |
| - | - |
| 1 | 2 |
`;

const WARM_LANGUAGES = ['javascript', 'typescript', 'python', 'bash', 'json'];

/**
 * Do the renderer's one-time work while the user is still typing their first
 * message, a few milliseconds per step: the emoji width table, the
 * highlighter module, marked's first lex, and the grammars of the most common
 * languages (highlight.js compiles each on first use). Otherwise each costs
 * 15–30 ms in the middle of the first reply that needs it.
 */
export function warmRenderer(): () => void {
  const steps: (() => unknown)[] = [
    () => textWidth('\u{1F44D}'),
    () => loadHighlighter(),
    () => renderMarkdown(WARM_SAMPLE, { width: 80 }),
    ...WARM_LANGUAGES.map((lang) => () => highlight('const x = { "a": [1, "b"] } // c', lang)),
  ];
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const next = async () => {
    const step = steps.shift();
    if (!step || cancelled) return;
    try {
      await step();
    } catch {
      /* warming is best-effort */
    }
    if (!cancelled) timer = setTimeout(() => void next(), 5);
  };
  timer = setTimeout(() => void next(), 30);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
