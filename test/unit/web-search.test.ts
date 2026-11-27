// Web search, provider-neutral core (0.6.0), with the mock provider only:
// sources and markers, the streaming invariant, hostile web content,
// storage that older readers survive, history for other models, and what
// the session does when a model cannot search or a search goes wrong.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { toChatMessages, type StoredMessage } from '../../src/core/conversation.js';
import { Store, messageEvents, replay } from '../../src/core/store.js';
import { displayText, hostOf, listSources, markerOffset, plainSources } from '../../src/core/sources.js';
import { Registry } from '../../src/providers/registry.js';
import { HOSTILE_SOURCES } from '../../src/providers/mock.js';
import type { ContentPart, SourcePart } from '../../src/providers/types.js';
import { defaultConfig, loadConfig, type Config } from '../../src/config/config.js';
import { cleanText } from '../../src/render/clean.js';
import { StreamingMarkdown, renderMarkdown } from '../../src/render/markdown.js';
import { plainText, type Line } from '../../src/render/style.js';
import { textWidth } from '../../src/render/width.js';
import { setColorLevel, setHyperlinks } from '../../src/term/caps.js';
import { setTheme } from '../../src/render/theme.js';
import { TranscriptModel } from '../../src/ui/transcript.js';
import { renderItem, sourcesBlock, type Item } from '../../src/ui/blocks.js';
import { searchStatus } from '../../src/commands/commands.js';
import { parseArgs } from '../../src/args.js';
import { replay as replay001 } from '../fixtures/old-readers/v001/store.js';
import { replay as replay010 } from '../fixtures/old-readers/v010/store.js';
import { replay as replay020 } from '../fixtures/old-readers/v020/store.js';

function make(model: string, over: Partial<Config> = {}) {
  const config: Config = { ...defaultConfig(), webSearch: true, ...over };
  const store = new Store(mkdtempSync(join(tmpdir(), 'taria-search-')));
  const session = new Session({ config, registry: new Registry(config), store, model });
  const events: SessionEvent[] = [];
  session.on('event', (e: SessionEvent) => events.push(e));
  return { session, store, events, config };
}

const FAST = 'tps=0&searchms=0&delay=0&connect=0';
const text = (m: StoredMessage | undefined) => (m?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
const notices = (events: SessionEvent[]) => events.filter((e) => e.type === 'notice').map((e) => (e as { text: string }).text);
const plain = (lines: Line[]) => lines.map((l) => plainText(l).trimEnd());
const src = (url: string, extra: Partial<SourcePart> = {}): SourcePart => ({ type: 'source', url, title: `Title of ${url}`, ...extra });

/** Everything taria itself writes for colour and links; what is left of a
 * rendered string after removing it must be plain text. */
const OWN_SGR = /\x1b\[[0-9;]*m/g;
const OWN_LINK = /\x1b\]8;;([^\x1b\x07]*)\x1b\\/g;
const DANGEROUS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

afterEach(() => {
  setHyperlinks(undefined);
  setColorLevel(0);
});

describe('sources and markers', () => {
  it('numbers cited sources in the order of their first citation, once per URL', () => {
    const parts: ContentPart[] = [src('https://a.example/'), src('https://b.example/'), src('https://c.example/'), src('https://b.example/', { at: 5 }), src('https://a.example/', { cited: true }), src('https://b.example/', { at: 9 })];
    expect(listSources(parts).map((s) => [s.n, s.url])).toEqual([
      [1, 'https://b.example/'],
      [2, 'https://a.example/'],
    ]);
  });

  it('lists everything found when the reply cites nothing', () => {
    expect(listSources([src('https://a.example/'), src('https://b.example/'), src('https://a.example/')]).map((s) => s.n)).toEqual([1, 2]);
  });

  it('puts markers at their offsets and leaves text without citations alone', () => {
    const parts = [src('https://a.example/', { at: 5 }), src('https://b.example/', { at: 5 }), src('https://a.example/', { at: 11 }), src('https://c.example/', { at: 999 })];
    expect(displayText('Hello world', parts)).toBe('Hello [1][2] world [1][3]');
    expect(displayText('Hello world', [src('https://a.example/')])).toBe('Hello world');
    expect(displayText('Hello world', [])).toBe('Hello world');
  });

  it('allows a marker only at the end of a line of prose', () => {
    expect(markerOffset('A claim')).toBe(7);
    expect(markerOffset('A claim.\n')).toBeUndefined();
    expect(markerOffset('A claim ')).toBeUndefined();
    expect(markerOffset('')).toBeUndefined();
    expect(markerOffset('Look:\n```js\nconst a = 1')).toBeUndefined();
    expect(markerOffset('Look:\n```js\nconst a = 1\n```\nDone')).toBe(32);
  });

  it('shows the real host, and none for what is not a web address', () => {
    expect(hostOf('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(hostOf('https://bank.example.attacker.example/login')).toBe('bank.example.attacker.example');
    expect(hostOf('https://b\u0430nk.example/')).toMatch(/^xn--bnk-[a-z0-9]+\.example$/); // a Cyrillic letter that looks like "a"
    expect(hostOf('javascript:alert(1)')).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
  });

  it('writes sources as plain text for another model, without anything that is not a web address', () => {
    const parts = [src('https://a.example/x', { cited: true, title: 'A\x1b[2J page\u202e' }), src('javascript:alert(1)', { cited: true }), src('https://b.example/ y', { cited: true })];
    expect(plainSources(parts)).toBe('Sources:\n1. A[2J page: https://a.example/x');
    expect(plainSources([])).toBe('');
  });

  it('cleanText removes escape, control and direction-changing characters and keeps emoji sequences', () => {
    expect(cleanText('a\x1b]0;t\x07b\r\nc\td\x9b31m')).toBe('a]0;tb c d31m');
    expect(cleanText('x\u202egpj\u202c \u2066y\u2069 \u200bz\ufeff')).toBe('xgpj y z');
    expect(cleanText('👨‍👩‍👧 fam')).toBe('👨‍👩‍👧 fam');
  });
});

describe('streaming with markers', () => {
  const DOCS = [
    'A first claim about the weather. A second claim, with **bold** text and `code`.\n\nA new paragraph follows, with a [link](https://example.com) in it.\n\n- item one\n- item two is longer and wraps around in a narrow terminal\n\nThe end.',
    '# Heading\n\nSome text before code.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nText after the code block, which is cited.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast line',
    '1. one\n2. two\n3. three\n\n> quoted text that is cited\n\nPlain ending without a newline',
  ];

  it('commits the same lines as a one-shot render, for any chunking and any citation points (property)', () => {
    let seed = 20261127;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 150; n++) {
      const doc = DOCS[n % DOCS.length]!;
      const width = 16 + Math.floor(rand() * 90);
      const md = new StreamingMarkdown(width, { numberCode: true });
      const sources: SourcePart[] = [];
      const committed: Line[] = [];
      for (let i = 0; i < doc.length; ) {
        i = Math.min(doc.length, i + 1 + Math.floor(rand() * 14));
        const soFar = doc.slice(0, i);
        // A citation arrives for the text just received, as in the session.
        if (rand() < 0.3) {
          const at = markerOffset(soFar);
          const url = `https://s${Math.floor(rand() * 4)}.example/`;
          if (at === undefined) sources.push(src(url, { cited: true }));
          else if (!sources.some((s) => s.url === url && s.at === at)) sources.push(src(url, { cited: true, at }));
        }
        // Not every event is followed by a frame.
        if (rand() < 0.7) committed.push(...md.update(displayText(soFar, sources)).commit);
      }
      committed.push(...md.update(displayText(doc, sources), true).commit);
      expect(plain(committed), `run ${n}, width ${width}`).toEqual(plain(renderMarkdown(displayText(doc, sources), { width, numberCode: true })));
    }
  });

  it('prints the same through the session and transcript while streaming as on a reprint, with thinking, text before the search and several searches', async () => {
    for (const [i, chunk] of [1, 3, 7, 19].entries()) {
      const cols = [40, 64, 100, 131][i]!;
      const { session } = make(`mock/search?tps=900&searchms=40&delay=0&connect=0&think=1&pre=1&searches=2&chunk=${chunk}`);
      const transcript = new TranscriptModel(session, cols, () => ({ kind: 'spacer', key: 'w' }) as Item);
      await session.submit({ text: 'what is new' });
      const streamed = transcript.items.filter((x) => x.kind === 'chunk' || x.kind === 'sources').map((x) => renderItem(x, cols)).join('\n');
      expect(streamed).toContain('[1]');
      expect(streamed).toContain('Sources');
      transcript.reprint(true);
      const again = transcript.items.find((x) => x.kind === 'assistant')!;
      // The reprint also has the "Thought for" line, printed separately while streaming.
      const reprinted = renderItem(again, cols).replace(/^\n.*Thought for[^\n]*\n/, '');
      expect(streamed, `chunk ${chunk}, ${cols} columns`).toBe(reprinted);
      for (const line of streamed.split('\n')) expect(textWidth(line.replace(OWN_SGR, ''))).toBeLessThanOrEqual(cols);
      session.close();
    }
  });
});

describe('hostile sources', () => {
  const parts: ContentPart[] = [
    ...HOSTILE_SOURCES.map((s) => ({ type: 'source' as const, ...s, cited: true })),
    { type: 'search', id: 's1', query: 'q \x1b[2J\u202e', status: 'failed', error: 'bad \x1b]0;x\x07 thing' },
  ];

  for (const links of [true, false]) {
    for (const cols of [40, 80, 200]) {
      for (const expanded of [false, true]) {
        it(`are harmless at ${cols} columns, links ${links ? 'on' : 'off'}${expanded ? ', expanded' : ''}`, () => {
          setColorLevel(3);
          setHyperlinks(links);
          const out = sourcesBlock(parts, cols, expanded);
          // Links: only ones taria wrote, only to addresses linkTarget() accepts.
          const targets = [...out.matchAll(OWN_LINK)].map((m) => m[1]!).filter(Boolean);
          for (const t of targets) {
            expect(t).toMatch(/^https:\/\/[a-z.]+\.example\//);
            expect(t.length).toBeLessThanOrEqual(2000);
          }
          expect(targets.some((t) => t.includes('phish'))).toBe(false);
          if (links) expect(new Set(targets)).toContain('https://evil.example/a');
          else expect(targets).toEqual([]);
          const visible = out.replace(OWN_LINK, '').replace(OWN_SGR, '');
          // No escape, control or direction-changing character is left.
          expect(DANGEROUS.test(visible), JSON.stringify(visible.match(DANGEROUS))).toBe(false);
          // Nothing is wider than the terminal.
          for (const line of visible.split('\n')) expect(textWidth(line), line).toBeLessThanOrEqual(cols);
          // Every source shows where it really leads, whatever its title says.
          const lines = visible.split('\n');
          expect(lines.find((l) => l.includes('Official site')) ?? lines.find((l) => l.includes('attacker.example'))).toMatch(/attacker\.example$/);
          expect(visible).toContain('empty.example');
          expect(visible).toContain('javascript:alert(1)');
          expect(visible.replace(/\s+/g, ' ')).toContain('Web search failed: bad ]0;x thing');
        });
      }
    }
  }

  it('a 2,000-character URL may be a link; a longer one and a non-web one are shown, never linked', () => {
    setColorLevel(3);
    setHyperlinks(true);
    const out = sourcesBlock(parts, 100, false);
    const targets = new Set([...out.matchAll(OWN_LINK)].map((m) => m[1]!).filter(Boolean));
    expect([...targets].some((t) => t.startsWith('https://long.example/') && t.length === 2000)).toBe(true);
    expect([...targets].some((t) => t.startsWith('https://toolong.example/'))).toBe(false);
    expect([...targets].some((t) => t.startsWith('javascript:'))).toBe(false);
    // Without a link the address itself is on the next line, cut to fit.
    expect(out.replace(OWN_LINK, '').replace(OWN_SGR, '')).toMatch(/toolong\.example\n\s+https:\/\/toolong\.example\/b+…/);
  });

  it('come out of a session cleaned, in the light theme too', async () => {
    setTheme('light');
    try {
      const { session } = make(`mock/search?${FAST}&hostile=1`);
      const transcript = new TranscriptModel(session, 60, () => ({ kind: 'spacer', key: 'w' }) as Item);
      await session.submit({ text: 'q' });
      const m = session.conv.head!;
      for (const p of m.content) {
        if (p.type === 'source') expect(DANGEROUS.test(p.title + (p.snippet ?? ''))).toBe(false);
      }
      setColorLevel(3);
      transcript.reprint(true);
      const all = transcript.items.map((x) => renderItem(x, 60)).join('\n');
      expect(all).toContain('Sources');
      expect(DANGEROUS.test(all.replace(OWN_LINK, '').replace(OWN_SGR, ''))).toBe(false);
      session.close();
    } finally {
      setTheme('dark');
    }
  });
});

describe('session', () => {
  it('records the search, its sources and the provider data, and counts the search', async () => {
    const { session, events } = make(`mock/search?${FAST}&n=2&blob=300`);
    await session.submit({ text: 'owls' });
    const m = session.conv.head!;
    expect(m.content.map((p) => p.type)).toEqual(['text', 'search', 'source', 'source', 'source', 'source', 'provider_data']);
    expect(m.content.find((p) => p.type === 'search')).toMatchObject({ query: 'owls', status: 'done' });
    expect(m.content.filter((p) => p.type === 'source' && p.at !== undefined)).toHaveLength(2);
    expect(m.content.find((p) => p.type === 'provider_data')).toMatchObject({ provider: 'mock', model: `search?${FAST}&n=2&blob=300` });
    expect((m.content.find((p) => p.type === 'provider_data') as { data: string }).data).toHaveLength(300);
    expect(m.usage?.searches).toBe(1);
    expect([...session.costs.byModel.values()][0]!.searches).toBe(1);
    const end = events.find((e) => e.type === 'assistant-end') as Extract<SessionEvent, { type: 'assistant-end' }>;
    expect(end.stats.searches).toBe(1);
    expect(notices(events)).toEqual([]);
    session.close();
  });

  it('with web search off sends an ordinary request and stores nothing new', async () => {
    const { session } = make(`mock/search?${FAST}`, { webSearch: false });
    await session.submit({ text: 'owls' });
    expect(session.conv.head!.content.map((p) => p.type)).toEqual(['text']);
    expect(readFileSync(session.file!.file, 'utf8')).not.toContain('annex');
    session.close();
  });

  it('applies web_search_max where the provider can, and says when it cannot', async () => {
    const a = make(`mock/search?${FAST}&searches=9`, { webSearchMax: 2 });
    await a.session.submit({ text: 'q' });
    expect(a.session.conv.head!.content.filter((p) => p.type === 'search')).toHaveLength(2);
    a.session.close();
    const b = make(`mock/search?${FAST}&searches=4&nolimit=1`, { webSearchMax: 2 });
    await b.session.submit({ text: 'q' });
    expect(b.session.conv.head!.content.filter((p) => p.type === 'search')).toHaveLength(4);
    const caps = await b.session.capabilities();
    expect(searchStatus(true, b.session.model, caps, b.session.searchMax)).toContain('cannot limit the searches of a reply, so web_search_max (2) does not apply');
    expect(searchStatus(true, a.session.model, await a.session.capabilities(), 2)).toContain('at most 2 searches');
    expect(searchStatus(false, 'mock/echo', undefined, 5)).toContain('Web search is off');
    b.session.close();
  });

  it('a model without web search gets the message without it, and one notice', async () => {
    const { session, events } = make('mock/echo?delay=0');
    await session.submit({ text: 'first' });
    await session.submit({ text: 'second' });
    expect(session.conv.path().map(text)).toEqual(['first', 'You said: first', 'second', 'You said: second']);
    const said = notices(events).filter((t) => /web search/.test(t));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('sent without it');
    expect(said[0]).toContain('web_search: true');
    session.close();
  });

  it('a config override sends search to a model taria thinks cannot, and keeps it from one that can', async () => {
    const config = loadConfigText('web_search: true\nproviders:\n  m:\n    type: mock\n    models:\n      "search?tps=0&searchms=0&delay=0&connect=0&caps=no": { web_search: true }\n      "search?tps=0&searchms=0&delay=0&connect=0": { web_search: false }\n');
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-search-')));
    const on = new Session({ config, registry: new Registry(config), store, model: 'm/search?tps=0&searchms=0&delay=0&connect=0&caps=no' });
    await on.submit({ text: 'q' });
    expect(on.conv.head!.content.some((p) => p.type === 'search')).toBe(true);
    on.close();
    const off = new Session({ config, registry: new Registry(config), store, model: 'm/search?tps=0&searchms=0&delay=0&connect=0' });
    await off.submit({ text: 'q' });
    expect(off.conv.head!.content.some((p) => p.type === 'search')).toBe(false);
    off.close();
  });

  it('when the provider refuses the request because of search, sends it once more without, says so, and remembers', async () => {
    const { session, events } = make(`mock/search?${FAST}&reject=1`);
    await session.submit({ text: 'q1' });
    expect(session.conv.path().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(text(session.conv.head)).toContain('Streaming markdown');
    expect(session.conv.head!.error).toBeUndefined();
    const said = notices(events);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('refused web search');
    expect(said[0]).toContain('not enabled for this organization');
    expect(said[0]).toContain('/search off');
    await session.submit({ text: 'q2' });
    // No second refusal, no second notice: the model is known not to search.
    expect(notices(events)).toHaveLength(1);
    expect(session.conv.path()).toHaveLength(4);
    session.close();
  });

  it('a search error inside the stream is kept, in plain words and without a key, and the reply goes on', async () => {
    const { session, events } = make(`mock/search?${FAST}&fail=too_many_requests`);
    await session.submit({ text: 'q' });
    const m = session.conv.head!;
    const s = m.content.find((p) => p.type === 'search') as Extract<ContentPart, { type: 'search' }>;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('too_many_requests');
    expect(s.error).not.toContain('sk-ant-api03-xxxxxxxx');
    expect(text(m)).toContain('from memory');
    expect(m.error).toBeUndefined();
    expect(m.content.some((p) => p.type === 'provider_data')).toBe(false);
    expect((events.find((e) => e.type === 'assistant-end') as { outcome: string }).outcome).toBe('done');
    const transcript = new TranscriptModel(session, 80, () => ({ kind: 'spacer', key: 'w' }) as Item);
    transcript.reprint(true);
    expect(transcript.items.map((x) => renderItem(x, 80)).join('\n')).toContain('Web search failed: The search failed (too_many_requests)');
    session.close();
  });

  it('interrupted during a search: the conversation opens again, resumes and sends, and nothing of the search is sent back', async () => {
    const { session, store } = make(`mock/search?tps=0&delay=0&connect=0&pre=1&hang=1`);
    const done = session.submit({ text: 'first question' });
    await waitFor(() => session.stream?.searching !== undefined);
    expect(session.stream!.searching).toBe('first question');
    session.interrupt();
    await done;
    const m = session.conv.head!;
    expect(m.interrupted).toBe(true);
    expect(m.content.find((p) => p.type === 'search')).toMatchObject({ status: 'interrupted' });
    expect(m.content.some((p) => p.type === 'provider_data')).toBe(false);
    const id = session.file!.id;
    session.close();

    const again = new Session({ config: { ...defaultConfig(), webSearch: true }, registry: new Registry(defaultConfig()), store, model: 'mock/echo?delay=0' });
    expect(again.resume(id)).toBe(true);
    again.setModel('mock/echo?delay=0');
    expect(again.conv.path().map(text)).toEqual(['first question', 'Let me look that up.\n\n']);
    const sent = toChatMessages(again.conv.context(), { provider: 'mock', model: 'echo?delay=0' });
    expect(JSON.stringify(sent)).not.toMatch(/"search"|"source"|provider_data/);
    await again.submit({ text: 'second question' });
    expect(text(again.conv.head)).toBe('You said: second question');
    again.close();
  });

  it('interrupted during a search before any text: nothing is kept of the reply, and the next message is sent', async () => {
    const { session } = make(`mock/search?tps=0&delay=0&connect=0&hang=1`);
    const done = session.submit({ text: 'q' });
    await waitFor(() => session.stream?.searching !== undefined);
    session.interrupt();
    await done;
    expect(session.conv.path().map((m) => m.role)).toEqual(['user']);
    session.setModel('mock/echo?delay=0');
    await session.submit({ text: 'again' });
    // As before web search: the unanswered message and the new one go together.
    expect(text(session.conv.head)).toBe('You said: q\n\nagain');
    session.close();
  });

  it('a connection lost during a search leaves a reply that is not replayed with provider data', async () => {
    const { session } = make(`mock/search?${FAST}&pre=1&drop=1`);
    await session.submit({ text: 'q' });
    const m = session.conv.head!;
    expect(m.error).toContain('lost');
    expect(m.content.find((p) => p.type === 'search')).toMatchObject({ status: 'interrupted' });
    expect(m.content.some((p) => p.type === 'provider_data')).toBe(false);
    session.close();
  });

  it('the query can arrive late, and is cleaned and cut', async () => {
    const q = encodeURIComponent(`evil \x1b[2J\u202e ${'long '.repeat(200)}`);
    const { session } = make(`mock/search?${FAST}&latequery=1&q=${q}`);
    await session.submit({ text: 'x' });
    const s = session.conv.head!.content.find((p) => p.type === 'search') as { query: string };
    expect(s.query.startsWith('evil [2J long')).toBe(true);
    expect(s.query.length).toBeLessThanOrEqual(300);
    session.close();
  });
});

describe('storage', () => {
  async function conversationWithSearch() {
    const { session, store } = make(`mock/search?${FAST}&think=1`);
    await session.submit({ text: 'first question' });
    session.setModel('mock/echo?delay=0');
    await session.submit({ text: 'second question' });
    const file = session.file!.file;
    const id = session.file!.id;
    const path = session.conv.path();
    session.close();
    return { file, id, path, store, raw: readFileSync(file, 'utf8') };
  }

  it('keeps web parts out of message events, and reads them back in place', async () => {
    const { raw, id, path } = await conversationWithSearch();
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; content?: Array<{ type: string }>; parts?: unknown[] });
    for (const e of events.filter((x) => x.type === 'message')) {
      for (const p of e.content!) expect(['text', 'reasoning', 'image', 'file']).toContain(p.type);
    }
    expect(events.filter((x) => x.type === 'annex').length).toBeGreaterThanOrEqual(1);
    expect((events.find((x) => x.type === 'meta') as unknown as { v: number }).v).toBe(1);
    const { conv } = replay(id, raw);
    expect(conv.path().map((m) => m.content)).toEqual(path.map((m) => m.content));
    expect(conv.path()[1]!.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'search', 'source', 'source', 'source', 'source', 'source', 'source', 'provider_data']);
  });

  it('every older reader still sees each message and all reply text, and no part it does not know', async () => {
    const { raw, id, path } = await conversationWithSearch();
    const want = path.map((m) => `${m.role}:${text(m)}`);
    for (const [name, read] of [['0.0.1', replay001], ['0.1.0', replay010], ['0.2.0', replay020]] as const) {
      const { conv } = read(id, raw);
      const got = conv.path();
      expect(got.map((m) => `${m.role}:${m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')}`), name).toEqual(want);
      for (const m of got) for (const p of m.content) expect(['text', 'reasoning', 'image', 'file'], name).toContain(p.type);
      expect(conv.headId, name).toBe(path[path.length - 1]!.id);
    }
  });

  it('recovers a reply cut off by a crash with the searches that had finished', async () => {
    const { session } = make(`mock/search?tps=150&delay=0&connect=0&searchms=0&searches=2`);
    const done = session.submit({ text: 'q' });
    // The second search has finished and the reply is still being written
    // when the process "dies": what is on disk then is all there is.
    await waitFor(() => (session.stream?.searches.filter((s) => s.status === 'done').length ?? 0) === 2);
    session.flushPersist();
    const cut = readFileSync(session.file!.file, 'utf8');
    const id = session.file!.id;
    expect(cut).not.toContain('"type":"message","id":"a_');
    session.interrupt();
    await done;
    session.close();
    const { conv, partial } = replay(id, cut);
    expect(partial).toBeDefined();
    expect(partial!.interrupted).toBe(true);
    expect(partial!.content.some((p) => p.type === 'search' && p.status === 'done')).toBe(true);
    expect(partial!.content.some((p) => p.type === 'provider_data')).toBe(false);
    expect(conv.head?.id).toBe(partial!.id);
    // Recorded on the next open, again split so older readers are safe.
    for (const e of messageEvents(partial!)) if (e.type === 'message') for (const p of e.content) expect(['text', 'reasoning']).toContain(p.type);
  });

  it('ignores annex parts that are malformed or unknown', () => {
    const lines = [
      { type: 'meta', v: 1, id: 'c', createdAt: 1, app: 'taria' },
      { type: 'message', id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'q' }], ts: 1 },
      { type: 'message', id: 'a', parentId: 'u', role: 'assistant', content: [{ type: 'text', text: 'r' }], ts: 2 },
      { type: 'annex', id: 'a', parts: [{ type: 'source', url: 5 }, { type: 'tool_call' }, null, { type: 'source', url: 'https://a.example/', title: 't', at: -3 }, { type: 'search', id: 's', query: 'q', status: 'odd' }] },
      { type: 'annex', id: 'missing', parts: [{ type: 'source', url: 'https://b.example/', title: 't' }] },
      { type: 'annex', parts: 'no' },
    ];
    const { conv } = replay('c', lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(conv.head!.content).toEqual([{ type: 'text', text: 'r' }, { type: 'source', url: 'https://a.example/', title: 't' }]);
  });
});

describe('history for the next turn', () => {
  it('gives provider data back only to the provider and model that wrote it; anyone else gets text and plain sources', async () => {
    const model = `search?${FAST}&n=2`;
    const { session } = make(`mock/${model}`);
    await session.submit({ text: 'owls' });
    session.conv.add({ id: 'u2', parentId: session.conv.headId, role: 'user', content: [{ type: 'text', text: 'more' }], ts: 3 });
    const same = toChatMessages(session.conv.context(), { provider: 'mock', model });
    expect(same[1]!.content.map((p) => p.type)).toEqual(['text', 'provider_data']);
    expect(JSON.stringify(same)).not.toContain('Sources:');
    for (const target of [{ provider: 'mock', model: 'echo' }, { provider: 'other', model }]) {
      const other = toChatMessages(session.conv.context(), target);
      expect(other[1]!.content.map((p) => p.type)).toEqual(['text', 'text']);
      expect((other[1]!.content[1] as { text: string }).text).toBe('\n\nSources:\n1. Result 1 for owls: https://example.com/1/1\n2. Result 2 for owls: https://example.com/1/2');
      expect(JSON.stringify(other)).not.toContain('eeee');
    }
    session.close();
  });
});

describe('config and command line', () => {
  it('web search is off by default, with a limit of 5', () => {
    expect(defaultConfig().webSearch).toBe(false);
    expect(defaultConfig().webSearchMax).toBe(5);
  });

  it('reads web_search, web_search_max, the per-model override and the search price', () => {
    const c = loadConfigText('web_search: true\nweb_search_max: 3\nproviders:\n  p:\n    type: mock\n    models:\n      a: { web_search: false }\nprices:\n  p/a: { input: 1, output: 2, search: 10 }\n');
    expect(c.webSearch).toBe(true);
    expect(c.webSearchMax).toBe(3);
    expect(c.providers.p!.models.a!.webSearch).toBe(false);
    expect(c.prices['p/a']!.search).toBe(10);
  });

  it('--search and --no-search override the config; --sources is for -p', () => {
    expect(parseArgs(['--search'])).toMatchObject({ search: true, sources: false });
    expect(parseArgs(['--no-search', '-p', 'q', '--sources'])).toMatchObject({ search: false, sources: true, print: true });
    expect((parseArgs([]) as { search?: boolean }).search).toBeUndefined();
  });
});

function loadConfigText(yaml: string): Config {
  const dir = mkdtempSync(join(tmpdir(), 'taria-search-cfg-'));
  const file = join(dir, 'config.yaml');
  writeFileSyncNow(file, yaml);
  const { config, issues } = loadConfig(file);
  expect(issues).toEqual([]);
  return config;
}

import { writeFileSync as writeFileSyncNow } from 'node:fs';

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
