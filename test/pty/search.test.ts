// Web search in the real program, with the mock provider (mock/search):
// what the reader sees while a search runs and under the reply, at narrow
// widths, in the light theme, with reduced motion, with and without
// hyperlinks; hostile sources; interrupting a search; models that cannot
// search; and `taria -p`.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MARKDOWN_SAMPLE } from '../../src/providers/mock.js';
import { tariaCommand } from '../build-once.js';
import { DEFAULT_CONFIG, makeHome, spawnTaria, testEnv, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const ESC = '\x1b';
const lines = (x: Session) => x.all().map((l) => l.trimEnd());

describe('web search', () => {
  it('says what it searches for, then shows markers and the sources under the reply, also at 40 columns', async () => {
    s = spawnTaria({ cols: 40, rows: 40, args: ['--search', '-m', 'mock/search?searchms=1500&n=2'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('owl habitats\r');
    await s.waitFor(() => s!.screen().some((l) => /Searching the web: owl/.test(l)));
    // The spinner line fits the terminal while the search runs.
    expect(s.screen().filter((l) => /Searching the web/.test(l))).toHaveLength(1);
    await s.waitFor(() => s!.screen().some((l) => /1 search/.test(l)), 15_000);
    await s.waitStable({ lastLine: /for commands/ });
    const all = lines(s);
    const text = all.join('\n');
    expect(text.replace(/\s+/g, ' ')).toContain('supported by a page [1], and there is more.');
    expect(text.replace(/\s+/g, ' ')).toContain('supported by a page [2].');
    const at = all.findIndex((l) => l.trim() === 'Sources');
    expect(at).toBeGreaterThan(0);
    // Each source: its number and title, the real host, and (no hyperlinks
    // in this terminal) the address on the next line.
    expect(all[at + 1]).toMatch(/^\s+1\. Result 1 for owl.* · example\.com$/);
    expect(all[at + 2]).toMatch(/^\s+https:\/\/example\.com\/1\/1$/);
    expect(all[at + 3]).toMatch(/^\s+2\. Result 2 for owl.* · example\.com$/);
    expect(all.some((l) => /tokens · 1 search$/.test(l))).toBe(true);
    for (const l of all) expect(l.length, l).toBeLessThanOrEqual(40);
    // Nothing is printed twice.
    expect(all.filter((l) => l.trim() === 'Sources')).toHaveLength(1);
  }, 40_000);

  it('Ctrl+O adds the query, full addresses and quoted text; a resize reprints the same reply once', async () => {
    s = spawnTaria({ cols: 90, rows: 40, args: ['--search', '-m', 'mock/search?searchms=50&n=1&tps=4000'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('owls\r');
    await s.waitFor(() => s!.screen().some((l) => /1 search/.test(l)), 15_000);
    await s.waitStable({ lastLine: /for commands/ });
    const before = lines(s).filter((l) => /\[1\]|Sources|Result 1/.test(l));
    s.write('\x0f'); // Ctrl+O
    await s.waitFor(() => lines(s!).some((l) => /Searched the web: owls/.test(l)));
    await s.waitStable({ lastLine: /for commands/ });
    expect(lines(s).join('\n')).toMatch(/“Snippet 1: what the page says about owls\.”/);
    s.write('\x0f');
    await s.waitFor(() => !lines(s!).some((l) => /Searched the web/.test(l)));
    s.resize(70, 40);
    await s.waitStable({ lastLine: /for commands/, quietMs: 400 });
    expect(lines(s).filter((l) => l.trim() === 'Sources')).toHaveLength(1);
    s.resize(90, 40);
    await s.waitStable({ lastLine: /for commands/, quietMs: 400 });
    expect(lines(s).filter((l) => /\[1\]|Sources|Result 1/.test(l))).toEqual(before);
  }, 40_000);

  it('with hyperlinks, a source is a link to its own address and nothing else is', async () => {
    s = spawnTaria({ cols: 100, rows: 50, env: { FORCE_HYPERLINK: '1' }, args: ['--search', '-m', 'mock/search?searchms=50&hostile=1&tps=4000'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('q\r');
    await s.waitFor(() => s!.screen().some((l) => /1 search/.test(l)), 15_000);
    await s.waitStable({ lastLine: /for commands/ });
    const targets = new Set([...s.raw.matchAll(/\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)].map((m) => m[1]!).filter(Boolean));
    expect(targets).toContain('https://evil.example/a');
    expect([...targets].every((t) => /^https:\/\/[a-z.]+\.example\//.test(t) && t.length <= 2000)).toBe(true);
    expect([...targets].some((t) => /phish|javascript|toolong/.test(t))).toBe(false);
    // What the hostile titles tried: retitle the terminal, clear the screen,
    // ring the bell, reverse the text. None of it reached the terminal.
    expect(s.raw).not.toContain(`${ESC}]0;pwned`);
    expect(s.raw).not.toContain('\x07 and');
    expect(s.raw).not.toMatch(/[‪-‮⁦-⁩​]/);
    const all = lines(s);
    expect(all.find((l) => l.includes('Official site'))).toMatch(/· bank\.example\.attacker\.example$/);
    expect(all.some((l) => /Clears \[2J\[H the screen \]0;pwned and retitles · evil\.example/.test(l))).toBe(true);
    expect(all.some((l) => /Reversed gpj\.exe name isolated zero width · evil\.example/.test(l))).toBe(true);
    // The welcome box is still there: the screen was never cleared.
    expect(all.some((l) => /taria v/.test(l))).toBe(true);
    for (const l of all) expect(l.length, l).toBeLessThanOrEqual(100);
  }, 40_000);

  it('light theme and reduced motion: one still line names the search', async () => {
    s = spawnTaria({ cols: 80, rows: 30, config: `${DEFAULT_CONFIG.replace('theme: dark', 'theme: light')}reduced_motion: true\nweb_search: true\n`, args: ['-m', 'mock/search?searchms=1800&n=1'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('reduced motion\r');
    await s.waitFor(() => s!.screen().some((l) => /Searching the web: reduced motion/.test(l)));
    const mark = s.raw.length;
    const glyphs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const l = s.screen().find((x) => /Searching the web/.test(x));
      if (l) glyphs.add(l.trim()[0]!);
    }
    // The glyph does not animate and the words do not change.
    expect(glyphs.size).toBe(1);
    expect(s.rawSince(mark)).not.toMatch(/Pondering|Mulling|Musing/);
    await s.waitFor(() => s!.screen().some((l) => /1 search/.test(l)), 15_000);
    await s.waitStable({ lastLine: /for commands/ });
    expect(lines(s).some((l) => /1\. Result 1 for reduced motion · example\.com/.test(l))).toBe(true);
  }, 40_000);

  it('Esc during a search stops it; the conversation resumes later and takes another message', async () => {
    const home = makeHome();
    s = spawnTaria({ cols: 80, rows: 30, home, args: ['--search', '-m', 'mock/search?pre=1&hang=1'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('what happened today\r');
    await s.waitFor(() => s!.screen().some((l) => /Searching the web: what happened today/.test(l)));
    s.write(ESC);
    await s.waitFor(() => lines(s!).some((l) => /Interrupted/.test(l)));
    await s.waitStable({ lastLine: /for commands/ });
    expect(lines(s).some((l) => /Let me look that up\./.test(l))).toBe(true);
    expect(s.screen().some((l) => /Searching the web/.test(l))).toBe(false);
    await s.close(true);

    s = spawnTaria({ cols: 80, rows: 30, home, args: ['-c', '-m', 'mock/echo'] });
    await s.waitStable({ lastLine: /for commands/ });
    expect(lines(s).some((l) => /Let me look that up\./.test(l))).toBe(true);
    s.write('and now\r');
    await s.waitFor(() => lines(s!).some((l) => /You said: and now/.test(l)));
    await s.waitStable({ lastLine: /for commands/ });
    expect(lines(s).filter((l) => /You said/.test(l))).toHaveLength(1);
  }, 40_000);

  it('a model without web search answers anyway, after one notice', async () => {
    s = spawnTaria({ cols: 100, rows: 30, args: ['--search'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('one\r');
    await s.waitFor(() => lines(s!).some((l) => /You said: one/.test(l)));
    s.write('two\r');
    await s.waitFor(() => lines(s!).some((l) => /You said: two/.test(l)));
    await s.waitStable({ lastLine: /for commands/ });
    const text = lines(s).join(' ').replace(/\s+/g, ' ');
    expect(text.match(/has no web search as far as taria can tell/g)).toHaveLength(1);
    expect(text).toContain('sent without it');
  }, 30_000);

  it('a search that fails inside the reply is said in plain words, and the reply goes on', async () => {
    s = spawnTaria({ cols: 100, rows: 30, args: ['--search', '-m', 'mock/search?searchms=50&fail=unavailable'] });
    await s.waitStable({ lastLine: /for commands/ });
    s.write('q\r');
    await s.waitFor(() => lines(s!).some((l) => /from memory/.test(l)));
    await s.waitStable({ lastLine: /for commands/ });
    const text = lines(s).join('\n');
    expect(text).toMatch(/Web search failed: The search failed \(unavailable\)/);
    expect(text).not.toContain('sk-ant-api03-xxxxxxxx');
    expect(text).not.toMatch(/\d search/);
  }, 30_000);

  it('/search shows the state and switches it; the status line says when it is on', async () => {
    s = spawnTaria({ cols: 120, rows: 30, args: ['-m', 'mock/search?searchms=50&n=1'] });
    await s.waitStable({ lastLine: /for commands/ });
    expect(s.screen().some((l) => /web search/.test(l))).toBe(false);
    s.write('/search\r');
    await s.waitFor(() => lines(s!).some((l) => /Web search is off\./.test(l)));
    s.write('/search on\r');
    await s.waitFor(() => lines(s!).some((l) => /Web search is on\./.test(l)));
    await s.waitStable({ lastLine: /· web search ·/ });
    expect(lines(s).join(' ').replace(/\s+/g, ' ')).toMatch(/can search; it decides when to\. A reply may run at most 5 searches/);
    s.write('q\r');
    await s.waitFor(() => s!.screen().some((l) => /1 search/.test(l)), 15_000);
    s.write('/search off\r');
    await s.waitFor(() => lines(s!).filter((l) => /Web search is off\./.test(l)).length === 2);
    await s.waitStable({ lastLine: /for commands/ });
    expect(s.screen().some((l) => /· web search ·/.test(l))).toBe(false);
    s.write('/search maybe\r');
    await s.waitFor(() => lines(s!).some((l) => /Use \/search on or \/search off/.test(l)));
  }, 40_000);
});

describe('taria -p with web search', () => {
  const homes: string[] = [];
  afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

  function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const home = makeHome();
    homes.push(home);
    return new Promise((resolve) => {
      const launch = tariaCommand(args);
      const p = spawn(launch.command, launch.args, { env: testEnv(home), cwd: home });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
      p.stdin.end('');
    });
  }

  it('prints exactly what 0.5.0 printed for a reply without sources, whether or not search is on', async () => {
    // 0.5.0 printed the reply text as it is, 790 bytes for this script.
    expect(Buffer.byteLength(MARKDOWN_SAMPLE)).toBe(790);
    for (const extra of [[], ['--no-search'], ['--search'], ['--search', '--sources']]) {
      const r = await run(['-p', 'hi', '-m', 'mock/markdown?tps=0', ...extra]);
      expect(r.code).toBe(0);
      expect(r.out, extra.join(' ')).toBe(MARKDOWN_SAMPLE);
    }
    // The search script without search answers the same.
    expect((await run(['-p', 'hi', '-m', 'mock/search?tps=0'])).out).toBe(MARKDOWN_SAMPLE);
  }, 60_000);

  it('with search: the answer alone by default, the sources after it with --sources', async () => {
    const plain = await run(['-p', 'owls', '-m', 'mock/search?tps=0&searchms=0&n=2', '--search']);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('Finding 1 of search 1 is **supported** by a page, and there is more.');
    expect(plain.out).not.toMatch(/\[1\]|Sources/);
    const withSources = await run(['-p', 'owls', '-m', 'mock/search?tps=0&searchms=0&n=2', '--search', '--sources']);
    expect(withSources.out).toBe(`${plain.out}\nSources:\n1. Result 1 for owls: https://example.com/1/1\n2. Result 2 for owls: https://example.com/1/2\n`);
  }, 60_000);

  it('--json keeps every field it had and adds sources and searches', async () => {
    const r = await run(['-p', 'owls', '-m', 'mock/search?tps=0&searchms=0&n=1', '--search', '--json']);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(['model', 'conversation_id', 'text', 'stop_reason', 'interrupted', 'error', 'usage', 'duration_ms', 'sources', 'searches']);
    expect(j).toMatchObject({ interrupted: false, error: null, stop_reason: 'end_turn' });
    expect(j.sources).toEqual([{ title: 'Result 1 for owls', url: 'https://example.com/1/1', snippet: 'Snippet 1: what the page says about owls.' }]);
    expect(j.searches).toEqual([{ query: 'owls', status: 'done' }]);
    expect((j.usage as { searches: number }).searches).toBe(1);
    expect(r.out).not.toContain('eeee');
    const none = JSON.parse((await run(['-p', 'hi', '-m', 'mock/echo', '--json'])).out) as Record<string, unknown>;
    expect(none.sources).toEqual([]);
    expect(none.searches).toEqual([]);
  }, 60_000);

  it('a model without search still answers; the notice and a failed search go to stderr', async () => {
    const r = await run(['-p', 'hi', '-m', 'mock/echo', '--search']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('You said: hi\n');
    expect(r.err).toContain('has no web search as far as taria can tell');
    const failed = await run(['-p', 'hi', '-m', 'mock/search?tps=0&searchms=0&fail=unavailable', '--search']);
    expect(failed.code).toBe(0);
    expect(failed.out).toContain('from memory');
    expect(failed.err).toContain('taria: web search failed: The search failed (unavailable)');
    expect(failed.err).not.toContain('sk-ant-api03-xxxxxxxx');
  }, 60_000);
});
