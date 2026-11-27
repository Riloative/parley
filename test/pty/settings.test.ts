// 0.2 settings: model picker details and favourites, /config additions,
// /terminal-setup for another terminal, reduced motion, the opt-in update
// notice, and the welcome box after a late background answer.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, makeHome, spawnTaria, sleep, type Session } from './harness.js';

let s: Session | undefined;
let server: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  server = undefined;
});

const paste = (t: string) => `\x1b[200~${t}\x1b[201~`;
const screen = () => s!.screen().join('\n');
const lines = () => s!.screen().map((l) => l.trimEnd());
const all = () => s!.all().map((l) => l.trimEnd());
const configText = () => readFileSync(join(s!.home, 'config', 'taria', 'config.yaml'), 'utf8');
const state = () => JSON.parse(readFileSync(join(s!.home, 'data', 'taria', 'state.json'), 'utf8')) as { favouriteModels?: string[]; updateCheck?: { at: number; latest?: string; notified?: string } };

describe('model picker', () => {
  it('shows what each model can do, and Ctrl+F keeps favourites at the top across restarts', async () => {
    s = spawnTaria({ cols: 100, rows: 32 });
    await s.waitFor('Send a message');
    s.write('/model\r');
    await s.waitFor('reasoning   32k context · images · reasoning');
    // The footer is the last line drawn: wait for the whole frame.
    await s.waitFor('ctrl+f favourite');
    await s!.waitStable();
    expect(lines()).toContain('❯ echo        current · 32k context · images');
    s.write('\x1b[B\x1b[B'); // → long
    await s.waitFor('❯ long');
    s.write('\x06');
    await s.waitFor('Favourites');
    // The selection stays on the model that was marked.
    await s.waitFor(() => lines().includes('❯ long        ★ · 32k context · images'));
    await s.waitFor(/^  mock\/long\s+★ · 32k context · images/m);
    expect(state().favouriteModels).toEqual(['mock/long']);
    s.write('\x1b');
    await s.waitFor(() => !screen().includes('Select a model'));

    const home = s.home;
    s.write('\x04');
    await s.exited;
    await s.close(true);
    s = spawnTaria({ cols: 100, rows: 32, home });
    await s.waitFor('Send a message');
    s.write('/model\r');
    await s.waitFor('Favourites');
    await s.waitFor(/❯ mock\/long\s+★ · 32k context · images/);
    // Unmarking it removes the group again.
    s.write('\x06');
    await s.waitFor(() => !screen().includes('Favourites'));
    // The heading goes with the first row of the redraw; the rest of the
    // frame may still be on its way. Look at the screen once it is whole.
    await s.waitStable();
    expect(state().favouriteModels).toEqual([]);
    expect(screen()).not.toContain('★');
  }, 40_000);

  it('uses the capabilities set in the config', async () => {
    s = spawnTaria({
      cols: 100,
      rows: 32,
      config: `${DEFAULT_CONFIG}    models:\n      echo:\n        context_window: 200000\n        images: false\n        reasoning: true\n`,
    });
    await s.waitFor('Send a message');
    s.write('/model\r');
    await s.waitFor('echo        current · 200k context · text only · reasoning');
  }, 30_000);
});

describe('/config', () => {
  it('changes soft_line_breaks and redraws the conversation with it', async () => {
    s = spawnTaria({ cols: 80, rows: 30 });
    await s.waitFor('Send a message');
    s.write(paste('one\ntwo'));
    await sleep(100);
    s.write('\r');
    await s.waitFor('● You said: one');
    await s.waitFor(() => /Send a message/.test(screen()));
    await s!.waitStable();
    expect(all()).toContain('● You said: one');
    s.write('/config\r');
    await s.waitFor('Single line breaks in replies');
    await s.waitFor('Tell me when a new version is out'); // the last row: the frame is complete
    await s!.waitStable();
    expect(screen()).toContain('keep (as written)');
    expect(screen()).toContain('Reduced motion (still spinner)');
    expect(screen()).toContain('Tell me when a new version is out');
    // One step at a time: wait until the selection has moved before the next
    // key, or a slow runner overshoots the row (keys arrive faster than frames).
    const selected = () => lines().find((l) => l.startsWith('❯ '));
    for (let i = 0; i < 20 && !selected()?.startsWith('❯ Single line breaks'); i++) {
      const before = selected();
      s.write('\x1b[B');
      await s.waitFor(() => selected() !== before);
      await s.waitStable();
    }
    expect(lines().some((l) => l.startsWith('❯ Single line breaks'))).toBe(true);
    s.write('\r');
    await s.waitFor('join (flow as one paragraph)');
    expect(configText()).toContain('soft_line_breaks: join');
    s.write('\x1b');
    // (The user's own message keeps its line break; the reply is one line now.)
    await s.waitFor(() => all().includes('● You said: one two'));
    await s!.waitStable();
    expect(all()).not.toContain('● You said: one');
    expect(all().filter((l) => l.includes('Welcome to taria')).length).toBe(1);
  }, 40_000);
});

describe('reduced motion', () => {
  const MOVING = /[✢✳✶✽]/;
  it('shows a still spinner; the default one moves', async () => {
    s = spawnTaria({ cols: 80, rows: 24, config: `${DEFAULT_CONFIG}reduced_motion: true\n`, args: ['-m', 'mock/slow-first'] });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor(/✻ \S+… \(\d+s/);
    await sleep(1300);
    await s!.waitStable();
    expect(screen()).toMatch(/✻ \S+… \(1s/); // the elapsed time still counts
    s.write('\x1b');
    await s.waitFor('Interrupted');
    expect(s.raw).not.toMatch(MOVING);
    await s.close();

    s = spawnTaria({ cols: 80, rows: 24, args: ['-m', 'mock/slow-first'] });
    await s.waitFor('Send a message');
    s.write('hi\r');
    await s.waitFor(() => MOVING.test(s!.raw));
  }, 40_000);
});

describe('/terminal-setup for another terminal', () => {
  it('tmux: shows the lines and writes ~/.tmux.conf only after a yes, outside tmux too', async () => {
    s = spawnTaria({ cols: 100, rows: 30 });
    await s.waitFor('Send a message');
    const conf = join(s.home, '.tmux.conf');
    s.write('/terminal-setup tmux');
    await sleep(100);
    s.write('\r');
    await s.waitFor('extended-keys on');
    await s.waitFor('Add extended-keys to');
    await s!.waitStable();
    expect(all().join('\n')).not.toContain('keybindings.json');
    s.write('\r'); // No is the default
    await s.waitFor(() => !screen().includes('Add extended-keys to'));
    expect(existsSync(conf)).toBe(false);
    s.write('/terminal-setup tmux');
    await sleep(100);
    s.write('\r');
    await s.waitFor('Add extended-keys to');
    s.write('\x1b[B\r');
    await s.waitFor(() => existsSync(conf) && readFileSync(conf, 'utf8').includes('extended-keys on'));
  }, 40_000);

  it('vscode: says so when no editor settings exist, and rejects other names', async () => {
    s = spawnTaria({ cols: 100, rows: 30 });
    await s.waitFor('Send a message');
    s.write('/terminal-setup vscode');
    await sleep(100);
    s.write('\r');
    await s.waitFor('"key": "shift+enter"');
    await s.waitFor('settings folder was found');
    await s!.waitStable();
    expect(all().join('\n')).not.toContain('extended-keys');
    s.write('/terminal-setup iterm');
    await sleep(100);
    s.write('\r');
    await s.waitFor('Usage: /terminal-setup, /terminal-setup vscode or /terminal-setup tmux');
  }, 40_000);
});

describe('new version notice', () => {
  const serve = async (tag: string) => {
    const hits: Array<{ url: string; ua: string }> = [];
    server = createServer((req, res) => {
      hits.push({ url: req.url ?? '', ua: String(req.headers['user-agent']) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: tag }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { hits, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/latest` };
  };

  it('is off by default: nothing is requested', async () => {
    const { hits, url } = await serve('v99.0.0');
    s = spawnTaria({ env: { TARIA_UPDATE_URL: url } });
    await s.waitFor('Send a message');
    await sleep(2000);
    expect(hits).toEqual([]);
    expect(all().join('\n')).not.toContain('is available');
  }, 30_000);

  it('when switched on, asks once a day and mentions a newer version once', async () => {
    const { hits, url } = await serve('v99.0.0');
    const home = makeHome(`${DEFAULT_CONFIG}check_for_updates: true\n`);
    s = spawnTaria({ cols: 110, home, env: { TARIA_UPDATE_URL: url } });
    await s.waitFor('Send a message');
    await s.waitFor('taria 99.0.0 is available', 15_000);
    expect(hits.length).toBe(1);
    expect(hits[0]!.ua).toMatch(/^taria\/\d+\.\d+\.\d+/);
    expect(state().updateCheck).toMatchObject({ latest: '99.0.0', notified: '99.0.0' });
    // The input box still works and nothing was installed or changed.
    s.write('hello\r');
    await s.waitFor('You said: hello');
    s.write('\x04');
    await s.exited;
    await s.close(true);

    s = spawnTaria({ cols: 110, home, env: { TARIA_UPDATE_URL: url } });
    await s.waitFor('Send a message');
    await sleep(2500);
    expect(hits.length).toBe(1);
    expect(all().join('\n')).not.toContain('is available');
  }, 40_000);

  it('says nothing when this version is the latest, or when the server is unreachable', async () => {
    const { hits, url } = await serve('v0.0.1');
    s = spawnTaria({ home: makeHome(`${DEFAULT_CONFIG}check_for_updates: true\n`), env: { TARIA_UPDATE_URL: url } });
    await s.waitFor('Send a message');
    await s.waitFor(() => hits.length === 1, 15_000);
    await sleep(500);
    await s!.waitStable();
    expect(all().join('\n')).not.toContain('is available');
    await s.close();
    s = spawnTaria({ home: makeHome(`${DEFAULT_CONFIG}check_for_updates: true\n`), env: { TARIA_UPDATE_URL: 'http://127.0.0.1:9/latest' } });
    await s.waitFor('Send a message');
    await sleep(2500);
    s.write('still fine\r');
    await s.waitFor('You said: still fine');
    await s!.waitStable();
    expect(all().join('\n')).not.toMatch(/is available|fetch|ECONN|bad port/i);
  }, 40_000);
});

describe('late background answer', () => {
  const AUTO = DEFAULT_CONFIG.replace('theme: dark', 'theme: auto');
  const LIGHT_ACCENT = '38;2;193;95;60';

  it('repaints a welcome box that is still alone on the screen, in place', async () => {
    s = spawnTaria({ cols: 80, rows: 24, home: makeHome(AUTO), background: 'rgb:ffff/ffff/ffff', backgroundDelayMs: 1500 });
    await s.waitFor('% context'); // the status line is complete
    expect(s.raw).not.toContain(LIGHT_ACCENT);
    const before = lines().join('\n');
    await s.waitFor(() => s!.raw.includes(LIGHT_ACCENT));
    await sleep(300);
    // Same screen, new colours: nothing scrolled, cleared or duplicated.
    await s!.waitStable();
    expect(lines().join('\n')).toBe(before);
    expect(all().filter((l) => l.includes('Welcome to taria')).length).toBe(1);
    expect(s.raw).not.toContain('\x1b[3J');
    expect(s.raw).not.toContain('\x1b[2J');
    s.write('abc\r');
    await s.waitFor('You said: abc');
    await s!.waitStable();
    expect(all().filter((l) => l.includes('Welcome to taria')).length).toBe(1);
  }, 30_000);

  it('does not print the conversation a second time when the answer arrives after messages', async () => {
    s = spawnTaria({ cols: 80, rows: 24, home: makeHome(AUTO), background: 'rgb:ffff/ffff/ffff', backgroundDelayMs: 2500 });
    await s.waitFor('Send a message');
    s.write('hello\r');
    await s.waitFor('You said: hello');
    s.write('second\r');
    await s.waitFor('You said: second');
    const mark = s.raw.length;
    await sleep(3000);
    await s!.waitStable();
    expect(all().filter((l) => l.includes('You said: hello')).length).toBe(1);
    expect(all().filter((l) => l === '> second').length).toBe(1);
    expect(s.raw.slice(mark)).not.toContain('You said: hello');
    // The new palette still applies to what is drawn from now on.
    s.write('third\r');
    await s.waitFor('You said: third');
    expect(s.raw).toContain(LIGHT_ACCENT);
  }, 30_000);

  it('leaves the box alone once the user has started typing', async () => {
    s = spawnTaria({ cols: 80, rows: 24, home: makeHome(AUTO), background: 'rgb:ffff/ffff/ffff', backgroundDelayMs: 1200 });
    await s.waitFor('Send a message');
    s.write('typing');
    await s.waitFor('│ > typing');
    const mark = s.raw.length;
    await sleep(1600);
    expect(s.raw.slice(mark)).not.toContain('Welcome to taria');
    expect(screen()).toContain('│ > typing');
    expect(all().filter((l) => l.includes('Welcome to taria')).length).toBe(1);
  }, 30_000);
});
