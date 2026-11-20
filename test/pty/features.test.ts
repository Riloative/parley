import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHome, spawnParley, sleep, DEFAULT_CONFIG, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const paste = (t: string) => `\x1b[200~${t}\x1b[201~`;
const screen = () => s!.screen().join('\n');
const bottom = () => s!.screen().filter((l) => l.trim()).slice(-4).join('\n');

async function start(opts: Parameters<typeof spawnParley>[0] = {}) {
  s = spawnParley({ cols: 90, rows: 30, ...opts });
  await s.waitFor('Send a message');
  return s;
}

async function say(text: string, expectReply = `You said: ${text}`) {
  s!.write(text);
  await sleep(50);
  s!.write('\r');
  await s!.waitFor(expectReply);
  await s!.waitFor(() => /Send a message/.test(screen()));
}

describe('conversations', () => {
  it('quit and resume exactly where you left off', async () => {
    const home = makeHome();
    await start({ home });
    await say('remember the word kumquat');
    s!.write('\x03');
    await sleep(50);
    s!.write('\x03');
    await s!.exited;
    await s!.waitFor(/Resume this conversation with: parley -r \S+/);
    await s!.close(true);
    s = spawnParley({ cols: 90, rows: 30, home, args: ['-c'] });
    await s.waitFor('Send a message');
    await s.waitFor('> remember the word kumquat');
    expect(screen()).toContain('You said: remember the word kumquat');
    await say('and now?');
    const dir = join(home, 'data', 'parley', 'conversations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.includes('"role":"user"'))).toHaveLength(2);
  }, 40_000);

  it('/resume lists past conversations and opens one', async () => {
    const home = makeHome();
    await start({ home });
    await say('alpha topic');
    s!.write('/new\r');
    await s!.waitFor(() => !screen().includes('You said: alpha topic'));
    await say('beta topic');
    s!.write('/resume\r');
    await s!.waitFor('Resume a conversation');
    await s!.waitFor(/alpha topic\s+.*1m?|alpha topic/);
    s!.write('alpha');
    await sleep(300);
    s!.write('\r');
    await s!.waitFor('You said: alpha topic');
    expect(screen()).not.toContain('beta topic');
  }, 40_000);

  it('Esc Esc rewinds to an earlier message, edits it and branches', async () => {
    await start();
    await say('one');
    await say('two');
    s!.write(ESC);
    await sleep(100);
    s!.write(ESC);
    await s!.waitFor('Rewind: pick a message');
    s!.write('\r'); // newest first: "two"
    await s!.waitFor('│ > two');
    s!.write('\x15deux\r');
    await s!.waitFor('You said: deux');
    const all = s!.all().join('\n');
    expect(all).toContain('You said: one');
    // The screen was reprinted for the new branch: "two" is gone from view.
    expect(screen()).not.toContain('You said: two');
  }, 30_000);

  it('Ctrl+R searches input history; Up/Down walk it', async () => {
    await start();
    await say('first message');
    await say('second message');
    s!.write('\x12fir');
    await s!.waitFor("(reverse-i-search)`fir': first message");
    s!.write('\t');
    await s!.waitFor('│ > first message');
    s!.write('\x15');
    s!.write(UP);
    await s!.waitFor('│ > second message');
    s!.write(UP);
    await s!.waitFor('│ > first message');
    s!.write(DOWN);
    await s!.waitFor('│ > second message');
  }, 30_000);

  it('/rename, /cost, /system, /export and /delete', async () => {
    await start();
    await say('hello');
    s!.write('/rename Fruit chat\r');
    await s!.waitFor('Renamed to "Fruit chat"');
    expect(s!.raw).toContain('\x1b]0;Fruit chat\x07');
    s!.write('/cost\r');
    await s!.waitFor(/mock\/echo\s+│\s+1/);
    s!.write('/system Be brief.\r');
    await s!.waitFor('System prompt set');
    s!.write('/system\r');
    await s!.waitFor(/System prompt:\s+▎ Be brief\./);
    s!.write('/export chat.md\r');
    await s!.waitFor('Exported to');
    expect(readFileSync(join(s!.home, 'chat.md'), 'utf8')).toMatch(/# Fruit chat[\s\S]*## You\s+hello[\s\S]*You said: hello/);
    s!.write('/delete\r');
    await s!.waitFor('Delete "Fruit chat"?');
    s!.write(DOWN + '\r');
    await s!.waitFor('Conversation deleted.');
    expect(readdirSync(join(s!.home, 'data', 'parley', 'trash')).length).toBe(1);
  }, 30_000);

  it('/copy and /copy code use the clipboard (OSC 52 without a helper)', async () => {
    // Simulate SSH so the OSC 52 path is used on every platform.
    await start({ args: ['-m', 'mock/code'], env: { SSH_TTY: '/dev/pts/9', DISPLAY: '', WAYLAND_DISPLAY: '' } });
    s!.write('x\r');
    await s!.waitFor('sys.exit(main(sys.argv))');
    s!.write('/copy code\r');
    await s!.waitFor('Copied the last code block');
    const m = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(s!.raw);
    expect(Buffer.from(m![1]!, 'base64').toString()).toMatch(/^import sys\n\ndef main/);
  }, 30_000);
});

describe('input', () => {
  it('collapses large pastes and expands them when sending', async () => {
    await start();
    const big = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    s!.write(paste(big));
    await s!.waitFor('[Pasted text #1 +20 lines]');
    s!.write('\r');
    await s!.waitFor('line 20');
    expect(s!.all().join('\n')).toContain('> [Pasted text #1 +20 lines]');
  }, 30_000);

  it('newline keys: Ctrl+J, Alt+Enter and backslash-Enter', async () => {
    await start();
    s!.write('a\nb');
    s!.write('\x1b\r');
    s!.write('c\\');
    s!.write('\r');
    s!.write('d');
    await s!.waitFor('│   d');
    expect(screen()).toMatch(/│ > a\s+│\n│ {3}b\s+│\n│ {3}c\s+│\n│ {3}d/);
    s!.write('\r');
    await s!.waitFor(/You said: a\n\s*b/);
  }, 30_000);

  it('Shift+Enter works with the kitty keyboard protocol, and the hint says so', async () => {
    await start({ kitty: true });
    await s!.waitFor('shift+⏎ for newline');
    expect(s!.raw).toContain('\x1b[>1u');
    s!.write('one\x1b[13;2utwo');
    await s!.waitFor('│   two');
    s!.write('\x03'); // clears the input
    await s!.waitFor('Send a message');
    s!.write('\x03');
    await sleep(50);
    s!.write('\x03');
    await s!.exited;
    expect(s!.raw.slice(-200)).toContain('\x1b[<u');
  }, 30_000);

  it('readline editing and wide characters', async () => {
    await start();
    s!.write('hello wide 日本語 world');
    s!.write('\x17'); // Ctrl+W
    s!.write('\x01'); // Ctrl+A
    s!.write('>> ');
    s!.write('\x05'); // Ctrl+E
    s!.write('end');
    await s!.waitFor('│ > >> hello wide 日本語 end');
    s!.write('\x1bb\x1bb'); // Alt+B twice
    s!.write('\x0b'); // Ctrl+K
    await s!.waitFor(/│ > >> hello wide\s+│/);
  }, 30_000);

  it('@ attaches a file from the current directory; dropping a path attaches too', async () => {
    const home = makeHome();
    mkdirSync(join(home, 'project'));
    writeFileSync(join(home, 'project', 'notes.txt'), 'secret notes');
    await start({ home, cwd: join(home, 'project') });
    s!.write('look at @note');
    await s!.waitFor('  notes.txt');
    s!.write('\r');
    await s!.waitFor('[File #1: notes.txt]');
    s!.write(paste(join(home, 'project', 'notes.txt')));
    await s!.waitFor('[File #2: notes.txt]');
    s!.write('\r');
    await s!.waitFor('You said: look at [File #1: notes.txt] [File #2: notes.txt]');
  }, 30_000);

  it('warns before sending an image to a model that cannot read it', async () => {
    const home = makeHome(DEFAULT_CONFIG + '    models:\n      echo:\n        images: false\n');
    // 1x1 PNG
    writeFileSync(join(home, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await start({ home });
    s!.write(paste(join(home, 'dot.png')));
    await s!.waitFor('[Image #1]');
    s!.write('\r');
    await s!.waitFor('cannot read images');
    s!.write('\r');
    await s!.waitFor('You said: [image omitted: dot.png — this model cannot read images]');
  }, 30_000);

  it('Ctrl+L clears the screen and keeps the conversation; Ctrl+D exits', async () => {
    await start();
    await say('keep me');
    s!.write('\x0c');
    await s!.waitFor(() => !screen().includes('keep me'));
    s!.write('/cost\r');
    await s!.waitFor(/mock\/echo\s+│\s+1/);
    s!.write('\x04');
    expect(await s!.exited).toBe(0);
  }, 30_000);
});

describe('appearance and editor', () => {
  it('Ctrl+G edits the input in $EDITOR', async () => {
    await start({ env: { EDITOR: 'perl -pi -e s/hello/goodbye/', VISUAL: '' } });
    s!.write('hello editor');
    await s!.waitFor('│ > hello editor');
    s!.write('\x07');
    await s!.waitFor('│ > goodbye editor');
  }, 30_000);

  it('NO_COLOR removes colour from the whole interface', async () => {
    await start({ env: { NO_COLOR: '1' } });
    await say('plain');
    expect(s!.raw).not.toMatch(/\x1b\[(3[0-7]|9[0-7]|38;[25];)[0-9;]*m/);
  }, 30_000);

  it('the ANSI theme uses only the 16 terminal colours', async () => {
    await start({ args: ['--theme', 'ansi', '-m', 'mock/code'] });
    s!.write('x\r');
    await s!.waitFor('sys.exit');
    expect(s!.raw).not.toMatch(/\x1b\[[0-9;]*38;[25];/);
    expect(s!.raw).toMatch(/\x1b\[(3[1-6]|9[0-7])m/);
  }, 30_000);

  describe('theme: auto follows the terminal background (OSC 11)', () => {
    const AUTO = DEFAULT_CONFIG.replace('theme: dark', 'theme: auto');
    const LIGHT_ACCENT = '38;2;193;95;60';
    const DARK_ACCENT = '38;2;217;119;87';

    it('uses the light palette when the terminal reports a light background', async () => {
      await start({ home: makeHome(AUTO), background: 'rgb:ffff/ffff/fafa' });
      await s!.waitFor('Send a message');
      expect(s!.raw).toContain(LIGHT_ACCENT);
      expect(s!.raw).not.toContain(DARK_ACCENT);
    }, 30_000);

    it('keeps the dark palette for a dark background, or when the terminal does not answer', async () => {
      await start({ home: makeHome(AUTO), background: 'rgb:1e1e/1e1e/2e2e' });
      await s!.waitFor('Send a message');
      expect(s!.raw).toContain(DARK_ACCENT);
      await s!.close();
      await start({ home: makeHome(AUTO) });
      await s!.waitFor('Send a message');
      expect(s!.raw).toContain(DARK_ACCENT);
    }, 30_000);

    it('a late answer (slow link) changes nothing and never reaches the input box', async () => {
      await start({ home: makeHome(AUTO), background: 'rgb:ffff/ffff/ffff', backgroundDelayMs: 700 });
      await s!.waitFor('Send a message');
      await sleep(900);
      s!.write('abc');
      await s!.waitFor('│ > abc');
      expect(s!.screen().join('\n')).not.toMatch(/rgb:|11;/);
      expect(s!.raw).not.toContain(LIGHT_ACCENT);
    }, 30_000);

    it('keys typed while parley starts are kept, in order', async () => {
      s = spawnParley({ home: makeHome(AUTO), background: 'rgb:ffff/ffff/ffff' });
      // Once the background query is out, parley owns the keyboard (raw
      // mode) while the interface loads.
      await s.waitFor(() => s!.raw.includes('\x1b]11;?'));
      s.write('typed early');
      await s.waitFor('│ > typed early');
    }, 30_000);
  });

  it('/theme switches to the light palette and reprints', async () => {
    await start();
    await say('colourful');
    s!.write('/theme\r');
    await s!.waitFor('follow the terminal background');
    s!.write('\x1b[B\r'); // dark → light
    await s!.waitFor(() => /theme: light/.test(readFileSync(join(s!.home, 'config', 'parley', 'config.yaml'), 'utf8')));
    // Light accent (#C15F3C) is used for the welcome border after the reprint.
    await s!.waitFor(() => s!.raw.includes('38;2;193;95;60'));
    await s!.waitFor('You said: colourful');
  }, 30_000);
});

describe('/terminal-setup', () => {
  it('shows the snippets, and writes only what the user confirms', async () => {
    const home = makeHome();
    const userDir =
      process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User') : join(home, 'config', 'Code', 'User');
    mkdirSync(userDir, { recursive: true });
    const keybindings = join(userDir, 'keybindings.json');
    writeFileSync(keybindings, '// my bindings\n[\n  { "key": "ctrl+k", "command": "x" }\n]\n');
    await start({ home, env: { TERM_PROGRAM: 'vscode', TMUX: '/tmp/tmux-0/default,1,0' } });
    s!.write('/terminal-setup');
    await sleep(100);
    s!.write('\r');
    await s!.waitFor('extended-keys on');
    await s!.waitFor('Add the Shift+Enter keybinding to VS Code');
    s!.write('\x1b[B\r'); // No → Yes
    // Wait for the write itself: the message naming the file wraps with long paths.
    await s!.waitFor(() => existsSync(`${keybindings}.parley-backup`));
    const text = readFileSync(keybindings, 'utf8');
    expect(text.startsWith('// my bindings\n')).toBe(true);
    expect(text).toContain('"key": "shift+enter"');
    expect(text).toContain('"text": "\\u001b\\r"');
    await s!.waitFor(/Updated/);
    // The tmux offer comes next; Enter takes the default, No.
    await s!.waitFor('Add extended-keys to');
    s!.write('\r');
    await sleep(300);
    expect(existsSync(join(home, '.tmux.conf'))).toBe(false);
  }, 30_000);
});

describe('reasoning', () => {
  it('collapses thinking to "Thought for Ns"; Ctrl+O expands it; Shift+Tab cycles effort', async () => {
    await start({ args: ['-m', 'mock/reasoning?tps=400'] });
    await s!.waitFor('mock/reasoning?tps=400 · default effort');
    s!.write('\x1b[Z');
    await s!.waitFor('Reasoning effort: low');
    await s!.waitFor('· low effort');
    s!.write('q\r');
    await s!.waitFor('Thinking…');
    await s!.waitFor(/Thought for \d+s \(ctrl\+o to expand\)/, 20_000);
    await s!.waitFor(/^ {2}\d+(\.\d)?s · /m, 20_000);
    s!.write('\x0f');
    await s!.waitFor('The user is asking a question');
    expect(screen()).not.toContain('ctrl+o to expand');
  }, 40_000);

  it('distinguishes connecting, waiting and streaming in the spinner', async () => {
    await start({ args: ['-m', 'mock/slow-first?delay=6000&connect=600'] });
    s!.write('x\r');
    await s!.waitFor('Connecting…');
    await s!.waitFor('Waiting for the first token…', 15_000);
    s!.write(ESC);
    await s!.waitFor('Interrupted');
  }, 30_000);

  it('shows visible retries in the status area', async () => {
    await start({ args: ['-m', 'mock/retry?failures=1'] });
    s!.write('x\r');
    await s!.waitFor(/Retrying in \d+s… \(attempt 2\/6/);
    await s!.waitFor('Streaming markdown');
  }, 30_000);
});

describe('configuration', () => {
  it('custom commands from the commands folder with $ARGUMENTS', async () => {
    const home = makeHome();
    mkdirSync(join(home, 'config', 'parley', 'commands'), { recursive: true });
    writeFileSync(join(home, 'config', 'parley', 'commands', 'greet.md'), '---\ndescription: Greet someone\n---\nSay hello to $ARGUMENTS politely.\n');
    await start({ home });
    s!.write('/gre');
    await s!.waitFor('Greet someone');
    s!.write('\t');
    await s!.waitFor('│ > /greet ');
    s!.write('Bob\r');
    await s!.waitFor('You said: Say hello to Bob politely.');
  }, 30_000);

  it('/config edits the file in place, keeping comments', async () => {
    const home = makeHome('# my comment\n' + DEFAULT_CONFIG);
    await start({ home });
    // Typed ahead in one burst: keys that arrive before the settings screen
    // has mounted must still reach it.
    s!.write('/config\r' + DOWN.repeat(5) + '\r');
    await s!.waitFor('Settings');
    await s!.waitFor(/Bell when a long reply finishes\s+on/);
    const text = readFileSync(join(home, 'config', 'parley', 'config.yaml'), 'utf8');
    expect(text).toContain('# my comment');
    expect(text).toMatch(/bell: true/);
  }, 30_000);

  it('/providers shows a live connectivity check', async () => {
    await start();
    s!.write('/providers\r');
    await s!.waitFor(/mock\s+mock · .*✓ reachable · 11 models/);
    await s!.waitFor('+ Add a provider');
  }, 30_000);

  it('first run: setup flow writes a config', async () => {
    await start({ noConfig: true, env: { ANTHROPIC_API_KEY: 'sk-ant-test-xxxxxxxxxxxx' } }).catch(() => undefined);
    await s!.waitFor("Welcome! Let's connect parley to a model.");
    await s!.waitFor('Use Anthropic (Claude)');
    await s!.waitFor('ANTHROPIC_API_KEY is set');
    await s!.waitFor('Skip for now');
    s!.write(DOWN.repeat(5) + '\r');
    await sleep(500);
    const cfg = join(s!.home, 'config', 'parley', 'config.yaml');
    expect(existsSync(cfg)).toBe(true);
    expect(readFileSync(cfg, 'utf8')).toContain('default_model: mock/markdown');
    expect(readFileSync(cfg, 'utf8')).not.toContain('sk-ant-test');
  }, 30_000);

  it('rings the bell after long replies when enabled', async () => {
    const home = makeHome(DEFAULT_CONFIG.replace('bell: false', 'bell: true\nbell_after_seconds: 0'));
    await start({ home });
    await say('ding');
    await sleep(100);
    const withoutOsc = s!.raw.replace(/\x1b\][^\x07]*\x07/g, '');
    expect(withoutOsc).toContain('\x07');
  }, 30_000);
});

void bottom;
