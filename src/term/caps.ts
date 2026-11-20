// Terminal capability detection. Everything here is synchronous and cheap
// (environment inspection only); the kitty keyboard protocol is probed
// asynchronously by the input layer.

import { setColorsEnabled } from '../render/theme.js';

export type ColorLevel = 0 | 1 | 2 | 3;

let levelOverride: ColorLevel | undefined;

export function setColorLevel(level: ColorLevel | undefined): void {
  levelOverride = level;
}

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): ColorLevel {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR === '0') return 0;
  if (env.FORCE_COLOR === '1') return 1;
  if (env.FORCE_COLOR === '2') return 2;
  if (env.FORCE_COLOR === '3') return 3;
  if (!isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  const tp = env.TERM_PROGRAM ?? '';
  // Apple Terminal gained truecolour only in macOS 26 (Terminal 2.15+);
  // older versions misrender 24-bit SGR, so stay at 256 there.
  if (tp === 'Apple_Terminal') {
    const v = Number.parseFloat(env.TERM_PROGRAM_VERSION ?? '0');
    return v >= 460 ? 3 : 2;
  }
  if (['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'Hyper', 'Tabby'].includes(tp)) return 3;
  const term = env.TERM ?? '';
  if (/kitty|alacritty|ghostty|wezterm|foot|direct|truecolor/.test(term)) return 3;
  if (env.VTE_VERSION && Number(env.VTE_VERSION) >= 3600) return 3; // GNOME Terminal and friends
  if (/256/.test(term)) return 2;
  return 1;
}

export function colorLevel(): ColorLevel {
  return levelOverride ?? (levelOverride = detectColorLevel());
}

setColorsEnabled(() => colorLevel() > 0);

export function inTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TMUX || (env.TERM ?? '').startsWith('tmux') || (env.TERM ?? '').startsWith('screen');
}

export function overSsh(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

export function terminalName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERM_PROGRAM === 'vscode') return 'VS Code';
  if (env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'Terminal.app';
  if (env.TERM_PROGRAM === 'WezTerm') return 'WezTerm';
  if (env.TERM_PROGRAM === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'Ghostty';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.ALACRITTY_WINDOW_ID || env.TERM === 'alacritty') return 'Alacritty';
  if (env.VTE_VERSION) return 'GNOME Terminal (VTE)';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  return env.TERM ?? 'unknown';
}

/** Whether the terminal is likely to honour DEC 2026 synchronized output.
 * Terminals that do not understand the mode ignore it, so this is only used
 * for diagnostics. */
export function likelySupportsSyncOutput(env: NodeJS.ProcessEnv = process.env): boolean {
  const n = terminalName(env);
  return ['iTerm2', 'WezTerm', 'Ghostty', 'kitty', 'Alacritty', 'VS Code', 'GNOME Terminal (VTE)'].includes(n);
}

/** Whether OSC 8 hyperlinks are safe to emit. */
export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  if (colorLevel() === 0) return false;
  const n = terminalName(env);
  return ['iTerm2', 'WezTerm', 'Ghostty', 'kitty', 'VS Code', 'GNOME Terminal (VTE)', 'Alacritty'].includes(n);
}

/** True when glyphs such as ✻ and ● are likely to render. */
export function unicodeOk(env: NodeJS.ProcessEnv = process.env): boolean {
  const lang = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`;
  if (env.TERM === 'linux') return false; // the Linux console font lacks most of them
  return lang === '' || /utf-?8/i.test(lang);
}
