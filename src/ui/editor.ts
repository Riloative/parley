// The input buffer: pure, immutable text-editing operations with grapheme
// awareness, readline kill/yank, atomic attachment "chips", and a word-wrapping
// layout that maps the cursor to a visual row/column.

import { graphemes, graphemeWidth } from '../render/width.js';

export interface EditorState {
  text: string;
  cursor: number; // UTF-16 offset, always on a grapheme boundary
  kill: string; // last killed text, for Ctrl+Y
  /** Preferred visual column for vertical movement. */
  goal?: number;
}

export const emptyEditor = (): EditorState => ({ text: '', cursor: 0, kill: '' });

export const editorWith = (text: string): EditorState => ({ text, cursor: text.length, kill: '' });

/** Chips are atomic: the cursor never lands inside them and deletion removes
 * them whole. */
export const CHIP_RE = /\[(?:Pasted text #\d+ \+\d+ lines?|Image #\d+|File #\d+: [^\]\n]+)\]/g;

function chipRanges(text: string): Array<[number, number]> {
  const r: Array<[number, number]> = [];
  for (const m of text.matchAll(CHIP_RE)) r.push([m.index, m.index + m[0].length]);
  return r;
}

/** Grapheme boundaries (UTF-16 offsets) of `text`, chips treated as one unit. */
function boundaries(text: string): number[] {
  const out = [0];
  const chips = chipRanges(text);
  let i = 0;
  for (const g of graphemes(text)) {
    i += g.length;
    out.push(i);
  }
  if (!chips.length) return out;
  return out.filter((b) => !chips.some(([s, e]) => b > s && b < e));
}

function prevBoundary(text: string, pos: number): number {
  const b = boundaries(text);
  let p = 0;
  for (const x of b) {
    if (x >= pos) break;
    p = x;
  }
  return p;
}

function nextBoundary(text: string, pos: number): number {
  for (const x of boundaries(text)) if (x > pos) return x;
  return text.length;
}

const set = (s: EditorState, text: string, cursor: number, extra: Partial<EditorState> = {}): EditorState => ({
  ...s,
  text,
  cursor,
  goal: undefined,
  ...extra,
});

export function insert(s: EditorState, str: string): EditorState {
  const text = s.text.slice(0, s.cursor) + str + s.text.slice(s.cursor);
  return set(s, text, s.cursor + str.length);
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const p = prevBoundary(s.text, s.cursor);
  return set(s, s.text.slice(0, p) + s.text.slice(s.cursor), p);
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  const n = nextBoundary(s.text, s.cursor);
  return set(s, s.text.slice(0, s.cursor) + s.text.slice(n), s.cursor);
}

export const left = (s: EditorState): EditorState => set(s, s.text, prevBoundary(s.text, s.cursor));
export const right = (s: EditorState): EditorState => set(s, s.text, nextBoundary(s.text, s.cursor));

const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

export function wordLeft(s: EditorState): EditorState {
  let p = s.cursor;
  while (p > 0 && !isWordChar(s.text[p - 1]!)) p = prevBoundary(s.text, p);
  while (p > 0 && isWordChar(s.text[p - 1]!)) p = prevBoundary(s.text, p);
  return set(s, s.text, p);
}

export function wordRight(s: EditorState): EditorState {
  let p = s.cursor;
  const n = s.text.length;
  while (p < n && !isWordChar(s.text[p]!)) p = nextBoundary(s.text, p);
  while (p < n && isWordChar(s.text[p]!)) p = nextBoundary(s.text, p);
  return set(s, s.text, p);
}

export function lineStart(s: EditorState): EditorState {
  return set(s, s.text, s.text.lastIndexOf('\n', s.cursor - 1) + 1);
}

export function lineEnd(s: EditorState): EditorState {
  const e = s.text.indexOf('\n', s.cursor);
  return set(s, s.text, e < 0 ? s.text.length : e);
}

export function bufferStart(s: EditorState): EditorState {
  return set(s, s.text, 0);
}

export function bufferEnd(s: EditorState): EditorState {
  return set(s, s.text, s.text.length);
}

/** Ctrl+K: kill to end of line (or the newline itself at end of line). */
export function killToEnd(s: EditorState): EditorState {
  let e = s.text.indexOf('\n', s.cursor);
  if (e < 0) e = s.text.length;
  if (e === s.cursor && e < s.text.length) e++;
  if (e === s.cursor) return s;
  return set(s, s.text.slice(0, s.cursor) + s.text.slice(e), s.cursor, { kill: s.text.slice(s.cursor, e) });
}

/** Ctrl+U: kill to start of line. */
export function killToStart(s: EditorState): EditorState {
  let b = s.text.lastIndexOf('\n', s.cursor - 1) + 1;
  if (b === s.cursor && b > 0) b--;
  if (b === s.cursor) return s;
  return set(s, s.text.slice(0, b) + s.text.slice(s.cursor), b, { kill: s.text.slice(b, s.cursor) });
}

/** Ctrl+W: kill the previous whitespace-delimited word. */
export function killWordBack(s: EditorState): EditorState {
  let p = s.cursor;
  while (p > 0 && /\s/.test(s.text[p - 1]!)) p--;
  while (p > 0 && !/\s/.test(s.text[p - 1]!)) p = prevBoundary(s.text, p);
  if (p === s.cursor) return s;
  return set(s, s.text.slice(0, p) + s.text.slice(s.cursor), p, { kill: s.text.slice(p, s.cursor) });
}

/** Alt+D: kill the next word. */
export function killWordForward(s: EditorState): EditorState {
  const e = wordRight(s).cursor;
  if (e === s.cursor) return s;
  return set(s, s.text.slice(0, s.cursor) + s.text.slice(e), s.cursor, { kill: s.text.slice(s.cursor, e) });
}

export function yank(s: EditorState): EditorState {
  return s.kill ? insert(s, s.kill) : s;
}

// ---------------------------------------------------------------- layout

export interface Layout {
  rows: string[];
  /** UTF-16 offset where each row starts. */
  starts: number[];
  cursorRow: number;
  cursorCol: number;
}

/**
 * Word-wrap the buffer to `width` cells. One extra cell is reserved so the
 * cursor can sit after the last character of a full row.
 */
export function layout(text: string, cursor: number, width: number): Layout {
  const w = Math.max(2, width);
  const rows: string[] = [];
  const starts: number[] = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let offset = 0;
  const logical = text.split('\n');
  for (const line of logical) {
    const gs = graphemes(line);
    let rowStartIdx = 0; // index into gs
    let col = 0;
    let lastBreak = -1; // gs index after a space
    let rowStartOffset = offset;
    const rowsForLine: Array<[number, number]> = [];
    for (let i = 0; i < gs.length; i++) {
      const gw = graphemeWidth(gs[i]!);
      if (col + gw > w - 1 && i > rowStartIdx) {
        const brk = lastBreak > rowStartIdx ? lastBreak : i;
        rowsForLine.push([rowStartIdx, brk]);
        rowStartIdx = brk;
        col = 0;
        for (let j = brk; j < i; j++) col += graphemeWidth(gs[j]!);
        lastBreak = -1;
      }
      col += gw;
      if (gs[i] === ' ') lastBreak = i + 1;
    }
    rowsForLine.push([rowStartIdx, gs.length]);
    for (const [a, b] of rowsForLine) {
      const before = gs.slice(0, a).join('').length;
      const seg = gs.slice(a, b).join('');
      rowStartOffset = offset + before;
      starts.push(rowStartOffset);
      rows.push(seg);
    }
    offset += line.length + 1;
  }
  // Locate the cursor: last row whose start <= cursor.
  for (let r = 0; r < starts.length; r++) {
    if (starts[r]! <= cursor) cursorRow = r;
  }
  // A cursor exactly at a soft-wrap boundary belongs to the next row, which
  // the loop above already chose (starts are increasing).
  const rowText = text.slice(starts[cursorRow]!, cursor);
  cursorCol = graphemes(rowText).reduce((a, g) => a + graphemeWidth(g), 0);
  return { rows, starts, cursorRow, cursorCol };
}

function offsetAtCol(text: string, rowStart: number, rowText: string, col: number): number {
  let c = 0;
  let off = rowStart;
  for (const g of graphemes(rowText)) {
    const gw = graphemeWidth(g);
    if (c + gw > col) break;
    c += gw;
    off += g.length;
  }
  // Snap out of a chip.
  for (const [s, e] of chipRanges(text)) if (off > s && off < e) return e;
  return off;
}

/** Move up a visual row; returns null when already on the first row. */
export function up(s: EditorState, width: number): EditorState | null {
  const l = layout(s.text, s.cursor, width);
  if (l.cursorRow === 0) return null;
  const goal = s.goal ?? l.cursorCol;
  const r = l.cursorRow - 1;
  return { ...s, cursor: offsetAtCol(s.text, l.starts[r]!, l.rows[r]!, goal), goal };
}

/** Move down a visual row; returns null when already on the last row. */
export function down(s: EditorState, width: number): EditorState | null {
  const l = layout(s.text, s.cursor, width);
  if (l.cursorRow >= l.rows.length - 1) return null;
  const goal = s.goal ?? l.cursorCol;
  const r = l.cursorRow + 1;
  return { ...s, cursor: offsetAtCol(s.text, l.starts[r]!, l.rows[r]!, goal), goal };
}
