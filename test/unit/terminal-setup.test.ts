// /terminal-setup edits other programs' config files, so each edit must keep
// what is there and produce a file that still parses.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIFT_ENTER_BINDING, addShiftEnterBinding, addTmuxLines, stripJsonc, tmuxConfFile, vscodeKeybindingFiles, writeConfigFile } from '../../src/term/setup.js';

const parse = (t: string) => JSON.parse(stripJsonc(t)) as Array<Record<string, unknown>>;

describe('VS Code keybinding', () => {
  it('creates the file when there is none, sending ESC + CR for Shift+Enter', () => {
    const r = addShiftEnterBinding(undefined);
    expect(r.ok && r.changed).toBe(true);
    const list = parse((r as { text: string }).text);
    expect(list).toEqual([SHIFT_ENTER_BINDING]);
    expect((list[0]!.args as { text: string }).text).toBe('\x1b\r');
  });

  const cases: Record<string, string> = {
    empty: '[]',
    'empty with a comment': '// Place your key bindings in this file\n[\n]\n',
    'one entry': '[\n  { "key": "ctrl+k", "command": "a" }\n]',
    'trailing comma': '[\n  { "key": "ctrl+k", "command": "a" },\n]',
    'comment after the last entry': '[\n  { "key": "ctrl+k", "command": "a" } // mine\n]\n',
    'block comment and a ] inside a string': '/* keys */\n[\n  { "key": "ctrl+]", "command": "a", "args": { "text": "]" } }\n  /* end ] */\n]\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`adds the binding and keeps everything else: ${name}`, () => {
      const r = addShiftEnterBinding(text);
      expect(r.ok).toBe(true);
      const out = (r as { text: string }).text;
      const before = parse(text);
      const after = parse(out);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after[after.length - 1]).toEqual(SHIFT_ENTER_BINDING);
      // Comments survive.
      for (const c of text.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? []) expect(out).toContain(c);
    });
  }

  it('leaves a file that already has the binding alone, and refuses files it cannot edit safely', () => {
    const once = (addShiftEnterBinding('[]') as { text: string }).text;
    expect(addShiftEnterBinding(once)).toEqual({ ok: true, changed: false, text: once });
    expect(addShiftEnterBinding('{ "key": "x" }')).toMatchObject({ ok: false });
    expect(addShiftEnterBinding('[ { "key": ')).toMatchObject({ ok: false });
  });

  it('finds the keybindings of installed VS Code-like editors', () => {
    const home = mkdtempSync(join(tmpdir(), 'taria-setup-'));
    mkdirSync(join(home, '.config', 'Code', 'User'), { recursive: true });
    mkdirSync(join(home, '.config', 'Cursor', 'User'), { recursive: true });
    expect(vscodeKeybindingFiles({}, 'linux', home)).toEqual([
      { name: 'VS Code', file: join(home, '.config', 'Code', 'User', 'keybindings.json') },
      { name: 'Cursor', file: join(home, '.config', 'Cursor', 'User', 'keybindings.json') },
    ]);
    mkdirSync(join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    expect(vscodeKeybindingFiles({}, 'darwin', home).map((e) => e.name)).toEqual(['VS Code']);
    expect(vscodeKeybindingFiles({}, 'win32', home)).toEqual([]);
  });
});

describe('tmux', () => {
  it('appends extended-keys once, keeping the existing config', () => {
    const r = addTmuxLines('set -g mouse on');
    expect(r.ok && r.changed).toBe(true);
    const text = (r as { text: string }).text;
    expect(text.startsWith('set -g mouse on\n\n# taria')).toBe(true);
    expect(text).toContain('set -s extended-keys on');
    expect(addTmuxLines(text)).toMatchObject({ changed: false });
    expect(addTmuxLines('set -g extended-keys always\n')).toMatchObject({ changed: false });
    expect((addTmuxLines(undefined) as { text: string }).text.startsWith('# taria')).toBe(true);
  });

  it('prefers an existing XDG tmux.conf', () => {
    const home = mkdtempSync(join(tmpdir(), 'taria-setup-'));
    expect(tmuxConfFile({}, home)).toBe(join(home, '.tmux.conf'));
    mkdirSync(join(home, '.config', 'tmux'), { recursive: true });
    writeFileSync(join(home, '.config', 'tmux', 'tmux.conf'), '');
    expect(tmuxConfFile({}, home)).toBe(join(home, '.config', 'tmux', 'tmux.conf'));
  });
});

describe('writing', () => {
  it('writes atomically and keeps a backup of a file that existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-setup-'));
    const f = join(dir, 'keybindings.json');
    expect(writeConfigFile(f, '[]\n')).toEqual({ backup: undefined });
    expect(writeConfigFile(f, '[1]\n')).toEqual({ backup: `${f}.taria-backup` });
    expect(readFileSync(f, 'utf8')).toBe('[1]\n');
    expect(readFileSync(`${f}.taria-backup`, 'utf8')).toBe('[]\n');
    expect(existsSync(`${f}.taria-${process.pid}.tmp`)).toBe(false);
  });
});

describe('settings that only look like ours', () => {
  it('tmux: extended-keys off, or only extended-keys-format, still gets the lines', () => {
    for (const existing of ['set -s extended-keys off\n', 'set -g extended-keys-format csi-u\n', 'set -s extended-keys on\nset -s extended-keys off\n']) {
      const r = addTmuxLines(existing);
      expect(r.ok && r.changed, existing).toBe(true);
      const text = (r as { text: string }).text;
      expect(text.startsWith(existing)).toBe(true);
      // tmux reads the file top to bottom: the last setting wins.
      expect(text.trimEnd().split('\n').filter((l) => /extended-keys\s/.test(l)).at(-1)).toMatch(/extended-keys on$/);
      expect(addTmuxLines(text)).toMatchObject({ ok: true, changed: false });
    }
    for (const existing of ['set -s extended-keys on\n', 'set-option -g extended-keys always\n', 'set -s extended-keys off\nset -s extended-keys on\n']) {
      expect(addTmuxLines(existing), existing).toMatchObject({ ok: true, changed: false });
    }
  });

  it('VS Code: a Shift+Enter binding that sends something else, or never applies, is not taken for ours', () => {
    const other = (over: Record<string, unknown>) => JSON.stringify([{ ...SHIFT_ENTER_BINDING, ...over }], null, 2);
    for (const text of [other({ args: { text: 'foo' } }), other({ when: 'terminalFocus && false' }), other({ args: {} })]) {
      const r = addShiftEnterBinding(text);
      expect(r.ok && r.changed, text).toBe(true);
      const list = parse((r as { text: string }).text);
      expect(list.length).toBe(2);
      expect(list.at(-1)).toEqual(SHIFT_ENTER_BINDING); // later entries win in VS Code
      expect(addShiftEnterBinding((r as { text: string }).text)).toMatchObject({ ok: true, changed: false });
    }
    expect(addShiftEnterBinding(JSON.stringify([{ ...SHIFT_ENTER_BINDING, when: ' terminalFocus ' }]))).toMatchObject({ ok: true, changed: false });
  });

  it('VS Code: a file that starts with a byte-order mark is edited, and keeps it', () => {
    const r = addShiftEnterBinding('﻿[\n  { "key": "ctrl+k", "command": "a" }\n]\n');
    expect(r.ok && r.changed).toBe(true);
    const text = (r as { text: string }).text;
    expect(text.startsWith('﻿[')).toBe(true);
    expect(parse(text).length).toBe(2);
  });
});

describe('writing another program\'s config file', () => {
  it('writes through a symlink, keeps the file mode, and never overwrites an earlier backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-setup-'));
    const real = join(dir, 'dotfiles-tmux.conf');
    const link = join(dir, '.tmux.conf');
    writeFileSync(real, 'original\n', { mode: 0o600 });
    symlinkSync(real, link);
    const first = writeConfigFile(link, 'first edit\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('first edit\n');
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.backup!, 'utf8')).toBe('original\n');
    const second = writeConfigFile(link, 'second edit\n');
    expect(second.backup).not.toBe(first.backup);
    expect(readFileSync(first.backup!, 'utf8')).toBe('original\n');
    expect(readFileSync(second.backup!, 'utf8')).toBe('first edit\n');
    expect(readFileSync(link, 'utf8')).toBe('second edit\n');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
