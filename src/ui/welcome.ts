// The welcome box: printed once at the top of the transcript, and again on
// every reprint. It is a pre-rendered ANSI string, never wider than the
// terminal, so Ink never re-wraps it.
//
//   ╭─── taria v0.5.0 ─────────────────────────────────────────────╮
//   │      Welcome back!       │ Tips for getting started          │
//   │                          │ …                                 │
//   │        (mascot)          │ ───────────────────────────────── │
//   │                          │ Recent activity                   │
//   │   model · provider       │ …                                 │
//   │      ~/the/folder        │                                   │
//   ╰──────────────────────────────────────────────────────────────╯
//
// Narrower terminals get one column, and very narrow ones a compact box
// without the mascot.

import { cleanText } from '../render/clean.js';
import { homedir } from 'node:os';
import { lineToAnsi, type Span, type Style } from '../render/style.js';
import { textWidth, truncate } from '../render/width.js';

export interface WelcomeInfo {
  app: string;
  version: string;
  /** "Welcome back, <name>!"; without a name, "Welcome back!". */
  name?: string;
  /** The first start ever: "Welcome to taria!" instead of "Welcome back". */
  firstRun?: boolean;
  /** "provider/model", or empty when none is selected. */
  model: string;
  cwd: string;
  /** For showing the folder as ~/…; the user's home by default. */
  home?: string;
  tips: string[];
  /** The latest conversations (up to RECENT_ROWS); 'loading' until they are
   * read, just after the first frame; undefined hides the section
   * (welcome_recent: false). */
  recent?: Array<{ title: string; when: string }> | 'loading';
  /** The mascot's lines (all the same width), or none. */
  mascot: string[];
}

/** The tips on the right. Without a model, the first says how to get one. */
export function welcomeTips(hasModel: boolean): string[] {
  return hasModel
    ? ['Run /help to see every command and key', 'Type @ to attach a file, or paste an image', "Press Ctrl+O to show the model's thinking"]
    : ['Run /model to pick a model, or /providers to add one', 'Run /help to see every command and key', 'Type @ to attach a file, or paste an image'];
}

/** Rows kept for recent conversations, filled or not, so that the box
 * keeps its height when the list arrives after the first frame and can be
 * redrawn in place. */
export const RECENT_ROWS = 3;

/** Two columns from this width up; one column below. */
export const TWO_COLUMNS_FROM = 76;
/** Below this width: no mascot, everything left-aligned. */
export const COMPACT_BELOW = 44;

const ACCENT: Style = { fg: 'accent' };
const HEAD: Style = { fg: 'accent', bold: true };
const DIM: Style = { fg: 'dim' };

/** Text from outside (a name, a conversation title) on one line, with no
 * control characters: a title could otherwise carry escape sequences that
 * clear the screen or retitle the terminal. */
export function clean(s: string): string {
  return cleanText(s);
}

/** How long ago, in plain words: "just now", "5m ago", "yesterday", … */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 2) return 'yesterday';
  if (d < 14) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 7)}w ago`;
  return 'over a year ago';
}

/** A path with the home folder as ~, cut from the left to fit. */
export function shortPath(p: string, width: number, home: string = homedir()): string {
  let s = home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p;
  if (textWidth(s) <= width) return s;
  while (s.length > 1 && textWidth(s) > width - 1) s = s.slice(1);
  return `…${s}`;
}

/** "echo · mock" for "mock/echo". */
export function modelLine(ref: string): string {
  if (!ref) return 'no model yet · /model to pick one';
  const i = ref.indexOf('/');
  return i < 0 ? ref : `${ref.slice(i + 1)} · ${ref.slice(0, i)}`;
}

function greeting(info: WelcomeInfo): string {
  if (info.firstRun) return `Welcome to ${info.app}!`;
  const name = info.name ? clean(info.name) : '';
  return name ? `Welcome back, ${name}!` : 'Welcome back!';
}

type Cell = Span[];

function recentRows(recent: Array<{ title: string; when: string }> | 'loading', w: number): Cell[] {
  const rows: Cell[] =
    recent === 'loading'
      ? []
      : recent.length
        ? recent.slice(0, RECENT_ROWS).map((r) => {
            const when = ` · ${clean(r.when)}`;
            return [...fit(clean(r.title), Math.max(1, w - textWidth(when))), { text: when, style: DIM }];
          })
        : [fit('No recent activity', w, DIM)];
  while (rows.length < RECENT_ROWS) rows.push([]);
  return rows;
}
const width = (c: Cell) => c.reduce((a, s) => a + textWidth(s.text), 0);
const center = (c: Cell, w: number): Cell => {
  const left = Math.max(0, Math.floor((w - width(c)) / 2));
  return [{ text: ' '.repeat(left) }, ...c];
};
const pad = (c: Cell, w: number): Cell => [...c, { text: ' '.repeat(Math.max(0, w - width(c))) }];
const fit = (text: string, w: number, style?: Style): Cell => [{ text: truncate(text, w), style }];

export function welcomeBox(cols: number, info: WelcomeInfo, unicode = true): string {
  const box = unicode ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  const outer = Math.max(20, cols);
  const inner = outer - 4; // "│ " … " │"
  const compact = cols < COMPACT_BELOW;
  const two = cols >= TWO_COLUMNS_FROM;

  // Title in the top border: ╭─── taria v0.5.0 ───…╮
  const lead = compact ? 1 : 3;
  const title: Span[] = [
    { text: ' ' },
    { text: info.app, style: HEAD },
    { text: ` v${info.version}`, style: DIM },
    { text: ' ' },
  ];
  const titleW = width(title);
  const top = lineToAnsi([
    { text: box.tl + box.h.repeat(lead), style: ACCENT },
    ...title,
    { text: box.h.repeat(Math.max(0, outer - 2 - lead - titleW)) + box.tr, style: ACCENT },
  ]);
  const bottom = lineToAnsi([{ text: box.bl + box.h.repeat(outer - 2) + box.br, style: ACCENT }]);
  const row = (c: Cell) => lineToAnsi([{ text: `${box.v} `, style: ACCENT }, ...pad(c, inner), { text: ` ${box.v}`, style: ACCENT }]);

  const tipsCell = (w: number): Cell[] => [fit('Tips for getting started', w, HEAD), ...info.tips.map((t) => fit(t, w))];
  const recentCell = (w: number): Cell[] =>
    info.recent
      ? [
          [{ text: box.h.repeat(w), style: ACCENT }],
          fit('Recent activity', w, HEAD),
          ...recentRows(info.recent, w),
        ]
      : [];

  if (compact) {
    const lines: Cell[] = [
      fit(greeting(info), inner),
      fit(modelLine(info.model), inner, DIM),
      fit(shortPath(info.cwd, inner, info.home), inner, DIM),
    ];
    return [top, ...lines.map(row), bottom].join('\n');
  }

  const leftW = two ? Math.min(44, Math.max(30, Math.round(inner * 0.36))) : inner;
  const left: Cell[] = [
    [],
    center(fit(greeting(info), leftW, { bold: true }), leftW),
    [],
    ...info.mascot.map((m) => center([{ text: m, style: ACCENT }], leftW)),
    ...(info.mascot.length ? [[]] : []),
    center(fit(modelLine(info.model), leftW, DIM), leftW),
    center(fit(shortPath(info.cwd, leftW, info.home), leftW, DIM), leftW),
  ];

  if (!two) {
    const lines = [...left, [], ...tipsCell(inner), ...recentCell(inner)];
    return [top, ...lines.map(row), bottom].join('\n');
  }

  const rightW = inner - leftW - 3; // " │ "
  const right: Cell[] = [...tipsCell(rightW), ...recentCell(rightW)];
  const height = Math.max(left.length, right.length);
  const lines: Cell[] = [];
  for (let i = 0; i < height; i++) {
    lines.push([...pad(left[i] ?? [], leftW), { text: ` ${box.v} `, style: ACCENT }, ...(right[i] ?? [])]);
  }
  return [top, ...lines.map(row), bottom].join('\n');
}
