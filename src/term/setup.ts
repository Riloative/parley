// /terminal-setup: the two common setups where Shift+Enter can't reach
// parley, and the configuration that fixes each.
//   - VS Code's integrated terminal (and its forks) sends a plain Enter for
//     Shift+Enter. A keybinding that sends ESC + CR instead (what Alt+Enter
//     sends) makes it insert a new line.
//   - tmux may pass Shift+Enter on as a plain Enter. Turning extended keys
//     on is tmux's documented fix (tmux 3.2+); a PTY test checks Shift+Enter
//     with these lines. Without them, tmux 3.4 passed it through in one
//     environment and not in another (CI), so it is offered, not assumed.
// Files are only written after the user confirms, atomically, keeping a
// backup of a file that existed, and only when the result still parses.

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHIFT_ENTER_BINDING = {
  key: 'shift+enter',
  command: 'workbench.action.terminal.sendSequence',
  args: { text: '\x1b\r' },
  when: 'terminalFocus',
};

export const TMUX_LINES = [
  '# parley: pass Shift+Enter and other modified keys through to programs (tmux 3.2+)',
  'set -s extended-keys on',
  "set -as terminal-features 'xterm*:extkeys'",
];

const EDITORS: Array<{ name: string; dir: string }> = [
  { name: 'VS Code', dir: 'Code' },
  { name: 'VS Code Insiders', dir: 'Code - Insiders' },
  { name: 'Cursor', dir: 'Cursor' },
  { name: 'VSCodium', dir: 'VSCodium' },
  { name: 'Windsurf', dir: 'Windsurf' },
];

/** keybindings.json of every VS Code-like editor installed for this user. */
export function vscodeKeybindingFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Array<{ name: string; file: string }> {
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'linux' ? (env.XDG_CONFIG_HOME ?? join(home, '.config')) : undefined;
  if (!base) return [];
  return EDITORS.filter((e) => existsSync(join(base, e.dir, 'User'))).map((e) => ({ name: e.name, file: join(base, e.dir, 'User', 'keybindings.json') }));
}

export function tmuxConfFile(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'tmux', 'tmux.conf');
  return existsSync(xdg) ? xdg : join(home, '.tmux.conf');
}

/** JSON with comments and trailing commas (as VS Code writes it) → JSON. */
export function stripJsonc(text: string): string {
  let out = '';
  // A byte-order mark (some Windows editors write one) is not JSON.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[\]}])/g, '$1');
}

/** Exactly our binding: same key, command, text sent and condition. A
 * Shift+Enter binding that sends something else or applies elsewhere is
 * someone else's; ours is then added after it (later entries win). */
function isShiftEnterBinding(b: unknown): boolean {
  const o = b as { key?: unknown; command?: unknown; when?: unknown; args?: { text?: unknown } | null } | null;
  return (
    !!o &&
    typeof o.key === 'string' &&
    o.key.replace(/\s/g, '').toLowerCase() === 'shift+enter' &&
    o.command === SHIFT_ENTER_BINDING.command &&
    o.args?.text === SHIFT_ENTER_BINDING.args.text &&
    String(o.when ?? '').trim() === SHIFT_ENTER_BINDING.when
  );
}

export type EditResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/** Add the Shift+Enter binding to a keybindings.json text (undefined: no file
 * yet), keeping its comments and formatting. */
export function addShiftEnterBinding(text: string | undefined): EditResult {
  const entry = JSON.stringify(SHIFT_ENTER_BINDING, null, 2).replace(/\n/g, '\n  ');
  if (text === undefined || !text.trim()) return { ok: true, changed: true, text: `[\n  ${entry}\n]\n` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'it is not a list of keybindings' };
  if (parsed.some(isShiftEnterBinding)) return { ok: true, changed: false, text };
  const close = lastCode(text, (c) => c === ']');
  if (close < 0) return { ok: false, reason: 'its closing bracket was not found' };
  // The comma goes right after the last element, before any comment that
  // follows it; the new entry goes after that comment.
  const prevAt = lastCode(text.slice(0, close), (c) => !/\s/.test(c));
  const prev = text[prevAt];
  const comma = prev === '[' || prev === ',' ? '' : ',';
  const out = `${text.slice(0, prevAt + 1)}${comma}${text.slice(prevAt + 1, close).replace(/\s*$/, '')}\n  ${entry}\n${text.slice(close)}`;
  try {
    const check = JSON.parse(stripJsonc(out)) as unknown[];
    if (!Array.isArray(check) || !check.some(isShiftEnterBinding)) throw new Error('binding missing');
  } catch {
    return { ok: false, reason: 'the edited file would not parse' };
  }
  return { ok: true, changed: true, text: out };
}

/** Index of the last character outside strings and comments that matches
 * (a string's closing quote counts as code). */
function lastCode(text: string, match: (c: string) => boolean): number {
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (match('"')) found = i;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (match(c)) found = i;
  }
  return found;
}

export function addTmuxLines(text: string | undefined): EditResult {
  // The option itself (not extended-keys-format), wherever it is set: tmux
  // reads the file top to bottom, so the last setting is the one in force.
  const settings = [...(text ?? '').matchAll(/^[ \t]*set(?:-option)?[ \t]+(?:-\w+[ \t]+)*extended-keys[ \t]+(\S+)/gm)];
  const last = settings.at(-1)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (text && (last === 'on' || last === 'always')) return { ok: true, changed: false, text };
  const base = text ?? '';
  const sep = base && !base.endsWith('\n') ? '\n\n' : base ? '\n' : '';
  return { ok: true, changed: true, text: `${base}${sep}${TMUX_LINES.join('\n')}\n` };
}

/** Write next to the target, then rename over it; back up a file that existed. */
export function writeConfigFile(file: string, text: string): { backup?: string } {
  let backup: string | undefined;
  // A symlinked config (dotfiles) is written where it really lives, so the
  // link stays a link; the file keeps its permissions.
  let target = file;
  let mode: number | undefined;
  if (existsSync(file)) {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
    // Never overwrite an earlier backup: it may be the only copy of the
    // file as it was before parley first touched it.
    backup = `${file}.parley-backup`;
    for (let n = 2; existsSync(backup); n++) backup = `${file}.parley-backup-${n}`;
    copyFileSync(target, backup);
  }
  const tmp = `${target}.parley-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { backup };
}

export function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
