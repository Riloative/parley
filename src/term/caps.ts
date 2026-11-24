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

export type NotifyProtocol = 'osc9' | 'osc777' | 'osc99';

/**
 * How this terminal shows a desktop notification, if it is known to. Only
 * one protocol is chosen, because several terminals implement two and would
 * show the notification twice. Inside tmux or screen nothing is sent: the
 * sequence would need passthrough, and focus events are off by default.
 */
export function notifyProtocol(env: NodeJS.ProcessEnv = process.env): NotifyProtocol | undefined {
  if (inTmux(env)) return undefined;
  const n = terminalName(env);
  if (n === 'kitty') return 'osc99';
  if (n === 'iTerm2' || n === 'WezTerm' || n === 'Ghostty') return 'osc9';
  const term = env.TERM ?? '';
  if (term.startsWith('foot') || term.startsWith('rxvt')) return 'osc777';
  return undefined;
}

/** The escape sequence for a desktop notification. Control characters are
 * removed so the text can never end the sequence or start another. */
export function notificationSequence(protocol: NotifyProtocol, title: string, body: string): string {
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
  const t = clean(title);
  const b = clean(body);
  if (protocol === 'osc777') return `\x1b]777;notify;${t.replace(/;/g, ',')};${b.replace(/;/g, ',')}\x07`;
  // kitty: title and body are two chunks of one notification (same id).
  if (protocol === 'osc99') return `\x1b]99;i=taria:d=0:p=title;${t}\x1b\\\x1b]99;i=taria:d=1:p=body;${b}\x1b\\`;
  // OSC 9: a leading "<digits>;" would be read as a ConEmu/Windows Terminal
  // subcommand (9;4 is the progress bar), so the text never starts with one.
  return `\x1b]9;${`${t}: ${b}`.replace(/^(\d+);/, '$1,')}\x07`;
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

let hyperlinkOverride: boolean | undefined;

/** Force hyperlinks on or off (tests); undefined restores detection. */
export function setHyperlinks(on: boolean | undefined): void {
  hyperlinkOverride = on;
}

/**
 * Whether links are written as OSC 8 hyperlinks (clickable, URL hidden)
 * instead of "text (url)". FORCE_HYPERLINK=1/0 overrides detection, as in
 * other command-line tools. Off inside tmux and over SSH unless forced: an
 * older tmux drops the sequence, and the URL would be lost with it.
 */
export function hyperlinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hyperlinkOverride !== undefined) return hyperlinkOverride;
  if (env.FORCE_HYPERLINK !== undefined && env.FORCE_HYPERLINK !== '') return env.FORCE_HYPERLINK !== '0' && colorLevel() > 0;
  return supportsHyperlinks(env);
}

/**
 * A URL that is safe to put in an OSC 8 sequence, or undefined. Only web and
 * mail links become clickable: other schemes (file:, javascript:, app
 * handlers) keep the visible "text (url)" form, so the reader sees where
 * they lead. Control characters would end the sequence, so they disqualify
 * the URL.
 */
export function linkTarget(href: string): string | undefined {
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return undefined;
  if (/[\x00-\x20\x7f-\x9f]/.test(href) || href.length > 2000) return undefined;
  return href;
}

/** True when glyphs such as ✻ and ● are likely to render. */
export function unicodeOk(env: NodeJS.ProcessEnv = process.env): boolean {
  const lang = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`;
  if (env.TERM === 'linux') return false; // the Linux console font lacks most of them
  return lang === '' || /utf-?8/i.test(lang);
}
