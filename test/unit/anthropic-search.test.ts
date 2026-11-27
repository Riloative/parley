// Claude's web search through the Anthropic adapter, against a local HTTP
// server that replays recorded-shape streams (no network, no real key).
// Event shapes follow Anthropic's documentation as read on 2026-11-27; see
// the notes in src/providers/anthropic.ts.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, capsFromModel, parseKept } from '../../src/providers/anthropic.js';
import type { ProviderConfig } from '../../src/config/config.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { ProviderError, type ChatMessage, type ChatRequest, type ContentPart, type StreamEvent } from '../../src/providers/types.js';
import { Registry } from '../../src/providers/registry.js';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { toChatMessages } from '../../src/core/conversation.js';
import { Store } from '../../src/core/store.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

interface Route {
  status?: number;
  body: unknown;
}
type Body = Record<string, unknown> & { messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; tools?: unknown[]; tool_choice?: unknown };
let onMessages: (body: Body, n: number) => Route = () => ({ body: fixture('anthropic-search.sse') });
let modelCaps: Record<string, unknown> = {};
const seen: Body[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  process.env.ANTHROPIC_SEARCH_TEST_KEY = 'sk-ant-test-key-1234567890';
  server = createServer((req: IncomingMessage, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let r: Route;
      if (req.method === 'GET') {
        r = { body: { data: [{ id: 'claude-test', type: 'model', display_name: 'Claude Test', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: modelCaps }], has_more: false, first_id: 'claude-test', last_id: 'claude-test' } };
      } else {
        const body = JSON.parse(data) as Body;
        seen.push(body);
        r = onMessages(body, seen.length);
      }
      res.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' ? 'text/event-stream' : 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  onMessages = () => ({ body: fixture('anthropic-search.sse') });
  modelCaps = CAPS;
});

const CAPS = {
  image_input: { supported: true },
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, high: { supported: true } },
  server_tools: { web_search: { supported: true } },
};
const pc: ProviderConfig = { name: 'anthropic', type: 'anthropic', headers: {}, models: {} };
const make = () => new AnthropicProvider({ config: { ...pc, baseUrl: base }, key: { key: 'sk-ant-test-key-1234567890', source: 'env' } });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'claude-test', messages: [user('weather in NYC?')], sampling: {}, signal: new AbortController().signal, ...over });
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}
const textOf = (events: StreamEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
const dataOf = (events: StreamEvent[]) => (events.find((e) => e.type === 'provider_data') as { data: string } | undefined)?.data;
const bad = (message: string): Route => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } });

/** The reply of anthropic-search.sse as the session would store and replay it. */
async function searchedReply(): Promise<ChatMessage> {
  const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
  seen.length = 0;
  return { role: 'assistant', content: [{ type: 'text', text: textOf(events) }, { type: 'provider_data', provider: 'anthropic', model: 'claude-test', data: dataOf(events)! }] };
}

describe('Claude web search', () => {
  it('learns from the models API whether a model can search', () => {
    expect(capsFromModel({ id: 'a', capabilities: CAPS })).toMatchObject({ webSearch: true, searchLimit: true });
    expect(capsFromModel({ id: 'a', capabilities: { ...CAPS, server_tools: { web_search: { supported: false } } } }).webSearch).toBe(false);
    expect(capsFromModel({ id: 'a', capabilities: { image_input: { supported: true } } }).webSearch).toBe(false);
    expect(capsFromModel({ id: 'a' }).webSearch).toBe('unknown');
  });

  it('without web search the request is what it was before: no tools at all', async () => {
    await collect(make().stream(req()));
    expect(Object.keys(seen[0]!).sort()).toEqual(['cache_control', 'max_tokens', 'messages', 'model', 'stream', 'thinking']);
  });

  it('declares the search tool with the limit, and turns the stream into searches, sources, text and usage', async () => {
    const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen[0]!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    expect(seen[0]!.tool_choice).toBeUndefined();
    const id = 'srvtoolu_014hJH82Qum7Td6UV8gDXThB';
    expect(events.filter((e) => e.type === 'search')).toEqual([
      { type: 'search', id, status: 'started' },
      { type: 'search', id, status: 'started', query: 'weather NYC today' },
      { type: 'search', id, status: 'done' },
    ]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      { type: 'source', url: 'https://world-weather.info/forecast/usa/new_york/may-2025/', title: 'Weather in New York City in May 2025 (New York) - detailed Weather Forecast for a month', cite: 'none' },
      { type: 'source', url: 'https://www.accuweather.com/en/us/new-york/10021/weather-forecast/349727', title: 'New York, NY Weather Forecast | AccuWeather', cite: 'none' },
      { type: 'source', url: 'https://www.accuweather.com/en/us/new-york/10021/weather-forecast/349727', title: 'New York, NY Weather Forecast | AccuWeather', snippet: 'Today: partly sunny with a high of 68 and a light breeze from the west.', cite: 'mark' },
    ]);
    expect(textOf(events)).toBe('Here is the forecast for New York. It is partly sunny with a high of 68.');
    // The citation comes right after the text it supports, before the next text.
    const order = events.map((e) => (e.type === 'text' ? e.text : e.type === 'source' ? `<${e.cite}>` : '')).join('');
    expect(order).toContain('It is partly sunny with a high of 68<mark>.');
    expect([...events].reverse().find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 10682, outputTokens: 510, searches: 1 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    expect(events.filter((e) => e.type === 'reasoning_block')).toEqual([{ type: 'reasoning_block', signature: 'EuYBCkQYAiJASEARCHSIG', redacted: undefined }]);
  });

  it('without a limit it sends none', async () => {
    await collect(make().stream(req({ webSearch: {} })));
    expect(seen[0]!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  it('keeps the reply exactly as it came, encrypted content and index included, and sends it back unchanged', async () => {
    const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
    const kept = parseKept(dataOf(events)!)!;
    expect(kept.turns).toHaveLength(1);
    expect(kept.turns[0]!.map((b) => b.type)).toEqual(['thinking', 'server_tool_use', 'web_search_tool_result', 'text', 'text', 'text']);
    expect(kept.turns[0]![0]).toEqual({ type: 'thinking', thinking: 'I should check the forecast.', signature: 'EuYBCkQYAiJASEARCHSIG' });
    expect(kept.turns[0]![1]).toEqual({ type: 'server_tool_use', id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB', name: 'web_search', input: { query: 'weather NYC today' } });
    expect((kept.turns[0]![2] as unknown as { content: Array<{ encrypted_content: string; page_age: string | null }> }).content.map((r) => [r.encrypted_content, r.page_age])).toEqual([
      ['Ev0DCioIAxgCIiQ3NmU4ZmI4OC1kRESULT1', null],
      ['EqgfCioIARgBIiQ3YTAwMjY1Mi1mRESULT2', 'April 30, 2025'],
    ]);
    expect(kept.turns[0]![3]).toEqual({ type: 'text', text: 'Here is the forecast for New York. ', citations: null });
    expect((kept.turns[0]![4] as unknown as { text: string; citations: Array<{ encrypted_index: string }> }).citations[0]!.encrypted_index).toBe('Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNmINDEX');

    const reply = await searchedReply();
    await collect(make().stream(req({ webSearch: { maxUses: 5 }, messages: [user('weather in NYC?'), reply, user('and tomorrow?')] })));
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(seen[0]!.messages[1]!.content).toEqual(kept.turns[0]);
  });

  it('with search switched off later, the tool stays declared with tool_choice none, so thinking and kept results stay valid', async () => {
    const reply = await searchedReply();
    const events = await collect(make().stream(req({ messages: [user('weather in NYC?'), reply, user('thanks')] })));
    expect(seen[0]!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(seen[0]!.tool_choice).toEqual({ type: 'none' });
    expect(seen[0]!.messages[1]!.content.map((b) => b.type)).toEqual(['thinking', 'server_tool_use', 'web_search_tool_result', 'text', 'text', 'text']);
    // That reply too is kept, so the conversation stays consistent.
    expect(dataOf(events)).toBeDefined();
  });

  it('thinking from a reply made before search was on is left out once the tool is declared', async () => {
    const before: ChatMessage = { role: 'assistant', content: [{ type: 'reasoning', text: 'old thought', provider: 'anthropic', model: 'claude-test', signature: 'OLDSIG' }, { type: 'text', text: 'Hello.' }] };
    await collect(make().stream(req({ webSearch: {}, messages: [user('hi'), before, user('weather?')] })));
    expect(seen[0]!.messages[1]!.content).toEqual([{ type: 'text', text: 'Hello.' }]);
    // Without the tool it goes back as before.
    seen.length = 0;
    await collect(make().stream(req({ messages: [user('hi'), before, user('weather?')] })));
    expect(seen[0]!.messages[1]!.content[0]).toEqual({ type: 'thinking', thinking: 'old thought', signature: 'OLDSIG' });
    expect(seen[0]!.tools).toBeUndefined();
  });

  it('another model or provider gets the text and a plain list of sources, never the kept blocks', async () => {
    const reply = await searchedReply();
    const stored: ContentPart[] = [...reply.content, { type: 'source', url: 'https://www.accuweather.com/x', title: 'AccuWeather', cited: true, at: 10 }];
    const path = [
      { id: 'u', parentId: null, role: 'user' as const, content: user('q').content, ts: 1 },
      { id: 'a', parentId: 'u', role: 'assistant' as const, content: stored, ts: 2 },
      { id: 'u2', parentId: 'a', role: 'user' as const, content: user('more').content, ts: 3 },
    ];
    for (const target of [{ provider: 'anthropic', model: 'claude-other' }, { provider: 'openai', model: 'claude-test' }]) {
      const msgs = toChatMessages(path, target);
      expect(JSON.stringify(msgs)).not.toMatch(/encrypted|provider_data|srvtoolu/);
      expect(JSON.stringify(msgs)).toContain('Sources:\\n1. AccuWeather: https://www.accuweather.com/x');
    }
    // And the adapter itself, for the other model: no tools, plain text.
    await collect(make().stream(req({ model: 'claude-other', messages: toChatMessages(path, { provider: 'anthropic', model: 'claude-other' }) })));
    expect(seen[0]!.tools).toBeUndefined();
    expect(JSON.stringify(seen[0]!.messages)).not.toContain('encrypted');
  });

  it('a search that fails arrives inside a successful stream: plain words, and the reply goes on', async () => {
    onMessages = () => ({ body: fixture('anthropic-search-error.sse') });
    const events = await collect(make().stream(req({ webSearch: { maxUses: 1 } })));
    expect(events.filter((e) => e.type === 'search').at(-1)).toEqual({ type: 'search', id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB', status: 'failed', error: 'the limit of searches for one reply was reached' });
    expect(textOf(events)).toBe('I could not search, so this is from memory.');
    expect([...events].reverse().find((e) => e.type === 'usage')).toMatchObject({ usage: { searches: 0 } });
    // The call has its (error) result, so the reply can be kept.
    expect(parseKept(dataOf(events)!)!.turns[0]!.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
  });

  it('continues a paused turn: the response goes back unchanged, with the same tools and no user message after it', async () => {
    onMessages = (body) => ({ body: fixture(body.messages.at(-1)!.role === 'assistant' ? 'anthropic-pause-2.sse' : 'anthropic-pause-1.sse') });
    const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toEqual(seen[0]!.tools);
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(seen[1]!.messages[1]!.content).toEqual([
      { type: 'text', text: 'Let me look. ', citations: null },
      { type: 'server_tool_use', id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB', name: 'web_search', input: { query: 'weather NYC today' } },
    ]);
    expect(textOf(events)).toBe('Let me look. Partly sunny, high of 68.');
    expect(events.filter((e) => e.type === 'search').map((e) => (e as { status: string }).status)).toEqual(['started', 'started', 'done']);
    expect(events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status)).toEqual(['connecting', 'waiting']);
    expect([...events].reverse().find((e) => e.type === 'usage')).toMatchObject({ usage: { outputTokens: 55, searches: 1, inputTokens: 2720 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    // Both responses are kept, in order, and go back as two assistant messages.
    const kept = parseKept(dataOf(events)!)!;
    expect(kept.turns.map((t) => t.map((b) => b.type))).toEqual([['text', 'server_tool_use'], ['web_search_tool_result', 'text']]);
    seen.length = 0;
    onMessages = () => ({ body: fixture('anthropic-search.sse') });
    const reply: ChatMessage = { role: 'assistant', content: [{ type: 'text', text: textOf(events) }, { type: 'provider_data', provider: 'anthropic', model: 'claude-test', data: dataOf(events)! }] };
    await collect(make().stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] })));
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });

  it('stops continuing after three times, and then keeps no search call without its result', async () => {
    onMessages = () => ({ body: fixture('anthropic-pause-1.sse') });
    const events = await collect(make().stream(req({ webSearch: {} })));
    expect(seen).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'pause_turn' });
    expect(dataOf(events)).toBeUndefined();
    expect(textOf(events)).toBe('Let me look. '.repeat(4));
  });

  it('web search not enabled for the organization: a search_unavailable error before anything is produced, and no tool afterwards', async () => {
    const reply = await searchedReply();
    onMessages = (body) => (body.tools ? bad('Web search is not enabled for this organization. Ask an administrator to enable it in the Console.') : { body: fixture('anthropic-thinking.sse') });
    const provider = make();
    const events: StreamEvent[] = [];
    let err: unknown;
    try {
      for await (const e of provider.stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] }))) events.push(e);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('search_unavailable');
    expect((err as ProviderError).providerMessage).toContain('not enabled');
    expect(events.every((e) => e.type === 'status')).toBe(true);
    // The session sends the message again without search. The tool is not
    // declared any more, and the searched reply goes as text with its sources.
    seen.length = 0;
    const again = await collect(provider.stream(req({ messages: [user('q'), reply, user('next')] })));
    expect(textOf(again)).toBe('Hello, world!');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toBeUndefined();
    expect(seen[0]!.messages[1]!.content).toEqual([
      { type: 'text', text: 'Here is the forecast for New York. It is partly sunny with a high of 68.\n\nSources:\n1. New York, NY Weather Forecast | AccuWeather: https://www.accuweather.com/en/us/new-york/10021/weather-forecast/349727' },
    ]);
    expect(dataOf(again)).toBeUndefined();
  });

  it('search off, tool still declared for an earlier searched reply, and the provider refuses it: one quiet retry without the tool', async () => {
    const reply = await searchedReply();
    onMessages = (body) => (body.tools ? bad('This model does not support the web_search tool.') : { body: fixture('anthropic-thinking.sse') });
    const events = await collect(make().stream(req({ messages: [user('q'), reply, user('next')] })));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toBeUndefined();
    expect(JSON.stringify(seen[1]!.messages)).not.toMatch(/thinking|encrypted/);
    expect(textOf(events)).toBe('Hello, world!');
  });

  it('kept results the API can no longer read: the reply is sent as text instead, once', async () => {
    const reply = await searchedReply();
    onMessages = (body) => (JSON.stringify(body.messages).includes('encrypted_content') ? bad('Invalid `encrypted_content` in `search_result` block') : { body: fixture('anthropic-search.sse') });
    const events = await collect(make().stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] })));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(seen[1]!.messages[1]!.content[0]!.type).toBe('text');
    expect(String(seen[1]!.messages[1]!.content[0]!.text)).toContain('Sources:\n1. New York, NY Weather Forecast');
    expect(textOf(events)).toContain('partly sunny');
  });

  it('thinking that no longer fits the request: one retry without any thinking', async () => {
    const reply = await searchedReply();
    onMessages = (body) => (JSON.stringify(body.messages).includes('"thinking"') ? bad('messages.1.content.0: thinking block is bound to a different conversation') : { body: fixture('anthropic-search.sse') });
    await collect(make().stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] })));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages[1]!.content.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text', 'text', 'text']);
  });

  it('another 400 is reported as it is, not retried', async () => {
    onMessages = () => bad('max_tokens: must be at least 1');
    await expect(collect(make().stream(req({ webSearch: {} })))).rejects.toMatchObject({ kind: 'bad_request' });
    expect(seen).toHaveLength(1);
  });

  it('through a session: sources and markers are stored, the next turn replays the reply, and a refusal is retried without search with one notice', async () => {
    const config: Config = { ...defaultConfig(), webSearch: true, providers: { anthropic: { ...pc, baseUrl: base, apiKeyEnv: 'ANTHROPIC_SEARCH_TEST_KEY' } } };
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-claude-search-')));
    const session = new Session({ config, registry: new Registry(config), store, model: 'anthropic/claude-test' });
    const notices: string[] = [];
    session.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    await session.submit({ text: 'weather in NYC?' });
    const m = session.conv.head!;
    expect(m.error).toBeUndefined();
    expect(m.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'search', 'source', 'source', 'source', 'provider_data']);
    expect(m.content.find((p) => p.type === 'search')).toMatchObject({ query: 'weather NYC today', status: 'done' });
    const cited = m.content.find((p) => p.type === 'source' && p.at !== undefined) as { at: number; snippet: string };
    expect(cited.at).toBe('Here is the forecast for New York. It is partly sunny with a high of 68'.length);
    expect(m.usage?.searches).toBe(1);
    expect(seen[0]!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    seen.length = 0;
    await session.submit({ text: 'and tomorrow?' });
    expect(seen[0]!.messages[1]!.content.map((b) => b.type)).toEqual(['thinking', 'server_tool_use', 'web_search_tool_result', 'text', 'text', 'text']);
    expect(notices).toEqual([]);
    session.close();

    onMessages = (body) => (body.tools ? bad('Web search is not enabled for this organization.') : { body: fixture('anthropic-thinking.sse') });
    seen.length = 0;
    const second = new Session({ config, registry: new Registry(config), store, model: 'anthropic/claude-test' });
    second.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    await second.submit({ text: 'hello' });
    expect(second.conv.path().map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(second.conv.head!.content.find((p) => p.type === 'text')).toMatchObject({ text: 'Hello, world!' });
    expect(seen).toHaveLength(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('anthropic refused web search for claude-test');
    expect(notices[0]).toContain('not enabled for this organization');
    expect(notices[0]).not.toContain('sk-ant-test-key');
    second.close();
  });
});
