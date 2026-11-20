// Structured styled text. The Markdown renderer and every transcript block
// produce `Line`s (arrays of spans); they are serialised to ANSI only at the
// very end, using the active theme and the terminal's colour depth.

import { getTheme, type ColorToken } from './theme.js';
import { colorLevel } from '../term/caps.js';

export interface Style {
  /** A theme token or a #rrggbb colour. */
  fg?: ColorToken | `#${string}`;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  style?: Style;
}

export type Line = Span[];

export const span = (text: string, style?: Style): Span => (style ? { text, style } : { text });

// ---------------------------------------------------------------- colours

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbTo256(r: number, g: number, b: number): number {
  // Greys get the dedicated ramp for better fidelity.
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const ANSI16: Array<[number, [number, number, number]]> = [
  [30, [0, 0, 0]],
  [31, [205, 49, 49]],
  [32, [13, 188, 121]],
  [33, [229, 179, 16]],
  [34, [36, 114, 200]],
  [35, [188, 63, 188]],
  [36, [17, 168, 205]],
  [37, [229, 229, 229]],
  [90, [118, 118, 118]],
  [91, [241, 76, 76]],
  [92, [35, 209, 139]],
  [93, [245, 245, 67]],
  [94, [59, 142, 234]],
  [95, [214, 112, 214]],
  [96, [41, 184, 219]],
  [97, [255, 255, 255]],
];

function rgbTo16(r: number, g: number, b: number): number {
  let best = 37;
  let bestD = Infinity;
  for (const [code, [R, G, B]] of ANSI16) {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bestD) {
      bestD = d;
      best = code;
    }
  }
  return best;
}

/** SGR parameters for a foreground colour, or '' if colour is disabled. */
export function fgParams(color: Style['fg']): string {
  if (!color) return '';
  const level = colorLevel();
  if (level === 0) return '';
  let hex: string = color;
  if (!color.startsWith('#')) {
    const tok = getTheme().colors[color as ColorToken];
    if (tok === undefined) return '';
    if (typeof tok === 'number') return String(tok); // fixed ANSI code (ansi theme)
    hex = tok;
  }
  const [r, g, b] = hexToRgb(hex);
  if (level === 3) return `38;2;${r};${g};${b}`;
  if (level === 2) return `38;5;${rgbTo256(r, g, b)}`;
  return String(rgbTo16(r, g, b));
}

function sgr(style: Style | undefined): string {
  if (!style) return '';
  const p: string[] = [];
  const level = colorLevel();
  if (style.bold) p.push('1');
  // Faint is only used when colour is off; otherwise dim maps to a grey.
  if (style.dim && level === 0) p.push('2');
  if (style.italic) p.push('3');
  if (style.underline) p.push('4');
  if (style.inverse) p.push('7');
  if (style.strike) p.push('9');
  const fg = style.fg ?? (style.dim ? 'dim' : undefined);
  const f = fgParams(fg);
  if (f) p.push(f);
  return p.length ? `\x1b[${p.join(';')}m` : '';
}

/** Serialise one line to an ANSI string. Each styled span is self-contained. */
export function lineToAnsi(line: Line): string {
  let out = '';
  for (const s of line) {
    const open = sgr(s.style);
    out += open ? `${open}${s.text}\x1b[0m` : s.text;
  }
  return out;
}

export function linesToAnsi(lines: Line[]): string {
  return lines.map(lineToAnsi).join('\n');
}

/** Convenience: style a plain string. */
export function paint(text: string, style: Style): string {
  return lineToAnsi([{ text, style }]);
}

export function plainText(line: Line): string {
  return line.map((s) => s.text).join('');
}
