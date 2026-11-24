// Display-width aware text utilities: grapheme segmentation, cell widths
// (wide CJK, emoji, combining marks) and word wrapping of styled spans.

import stringWidth from 'string-width';
import type { Line, Span, Style } from './style.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(s: string): string[] {
  // ASCII fast path: every code unit is its own grapheme.
  if (/^[\x20-\x7e]*$/.test(s)) return s.split('');
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

export function textWidth(s: string): number {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  return stringWidth(s);
}

export function graphemeWidth(g: string): number {
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
    if (c === 0x09) return 1;
  }
  return stringWidth(g);
}

export function lineWidth(line: Line): number {
  let w = 0;
  for (const s of line) w += textWidth(s.text);
  return w;
}

/** Cut a string to at most `width` cells. */
export function truncate(s: string, width: number, ellipsis = '…'): string {
  if (textWidth(s) <= width) return s;
  if (width <= 0) return '';
  const ew = textWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = graphemeWidth(g);
    if (w + gw > width - ew) break;
    out += g;
    w += gw;
  }
  return out + ellipsis;
}

export function padEnd(s: string, width: number): string {
  const w = textWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

interface Piece {
  text: string;
  style?: Style;
  width: number;
  space: boolean;
}

function piecesOf(spans: Span[]): Piece[][] {
  // Returns "words": runs of non-space pieces (possibly spanning several
  // styled spans) separated by single whitespace pieces.
  const words: Piece[][] = [];
  let current: Piece[] = [];
  for (const s of spans) {
    const parts = s.text.split(/( +)/);
    for (const part of parts) {
      if (part === '') continue;
      if (/^ +$/.test(part)) {
        if (current.length) words.push(current);
        current = [];
        words.push([{ text: part, style: s.style, width: part.length, space: true }]);
      } else {
        current.push({ text: part, style: s.style, width: textWidth(part), space: false });
      }
    }
  }
  if (current.length) words.push(current);
  return words;
}

export interface WrapOptions {
  /** Spans prepended to the first line (e.g. a bullet). */
  firstPrefix?: Span[];
  /** Spans prepended to continuation lines (e.g. hanging indent). */
  restPrefix?: Span[];
  /** Break long words anywhere (default true). */
  hard?: boolean;
}

/**
 * Word-wrap styled spans to `width` cells. Explicit '\n' characters inside
 * spans force line breaks. Never returns a line wider than `width` (unless a
 * prefix alone is wider).
 */
export function wrapSpans(spans: Span[], width: number, opts: WrapOptions = {}): Line[] {
  // Split on explicit newlines first.
  const paragraphs: Span[][] = [[]];
  for (const s of spans) {
    const parts = s.text.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) paragraphs.push([]);
      if (p) paragraphs[paragraphs.length - 1]!.push({ text: p, style: s.style });
    });
  }
  const out: Line[] = [];
  const firstPrefix = opts.firstPrefix ?? [];
  const restPrefix = opts.restPrefix ?? firstPrefix.map((p) => ({ text: ' '.repeat(textWidth(p.text)) }));
  const fpw = lineWidth(firstPrefix);
  const rpw = lineWidth(restPrefix);

  for (const para of paragraphs) {
    let line: Span[] = [...(out.length === 0 ? firstPrefix : restPrefix)];
    let w = out.length === 0 ? fpw : rpw;
    let lineHasContent = false;
    const avail = () => Math.max(1, width - (out.length === 0 ? fpw : rpw));
    const pushLine = () => {
      // Trim trailing spaces.
      while (line.length && /^ +$/.test(line[line.length - 1]!.text) && lineHasContent) line.pop();
      out.push(mergeSpans(line));
      line = [...restPrefix];
      w = rpw;
      lineHasContent = false;
    };
    for (const word of piecesOf(para)) {
      const ww = word.reduce((a, p) => a + p.width, 0);
      const isSpace = word.length === 1 && word[0]!.space;
      if (isSpace) {
        if (!lineHasContent && out.length > 0 && line.length === restPrefix.length) continue; // drop leading space on wrapped lines
        if (w + ww > width) {
          pushLine();
          continue;
        }
        line.push({ text: word[0]!.text, style: word[0]!.style });
        w += ww;
        continue;
      }
      if (w + ww <= width) {
        for (const p of word) line.push({ text: p.text, style: p.style });
        w += ww;
        lineHasContent = true;
        continue;
      }
      if (lineHasContent && ww <= avail()) {
        pushLine();
        for (const p of word) line.push({ text: p.text, style: p.style });
        w += ww;
        lineHasContent = true;
        continue;
      }
      // Hard-break a word that is wider than the line.
      for (const p of word) {
        for (const g of graphemes(p.text)) {
          const gw = graphemeWidth(g);
          if (w + gw > width && lineHasContent) pushLine();
          line.push({ text: g, style: p.style });
          w += gw;
          lineHasContent = true;
        }
      }
    }
    pushLine();
  }
  return out;
}

/** Merge adjacent spans with identical styles (keeps ANSI output small). */
export function mergeSpans(line: Span[]): Line {
  const out: Span[] = [];
  for (const s of line) {
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev.style, s.style)) prev.text += s.text;
    else out.push({ text: s.text, style: s.style });
  }
  return out;
}

function sameStyle(a?: Style, b?: Style): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b ? true : isEmpty(a) && isEmpty(b);
  return (
    a.fg === b.fg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.inverse === !!b.inverse &&
    a.href === b.href
  );
}

function isEmpty(s?: Style): boolean {
  return !s || Object.values(s).every((v) => !v);
}

/** Hard-wrap (character level) one string to width; used for code. */
export function hardWrap(text: string, width: number): string[] {
  if (textWidth(text) <= width) return [text];
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = graphemeWidth(g);
    if (w + gw > width && cur) {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += g;
    w += gw;
  }
  out.push(cur);
  return out;
}
