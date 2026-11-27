// OpenAI's web search (the Responses API's hosted web_search tool) through
// the OpenAI adapter, against a local HTTP server (no network, no real key).
// Event and item shapes follow OpenAI's documentation as read on
// 2026-11-27; see the notes in src/providers/openai.ts.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAIProvider, guessOpenAICaps, parseKept } from '../../src/providers/openai.js';
import { defaultConfig, type Config, type ProviderConfig } from '../../src/config/config.js';
import { ProviderError, type ChatMessage, type ChatRequest, type StreamEvent } from '../../src/providers/types.js';
import { Registry } from '../../src/providers/registry.js';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { Store } from '../../src/core/store.js';
import { displayText, listSources } from '../../src/core/sources.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

interface Route {
  status?: number;
  body: unknown;
}
type Body = Record<string, unknown> & { input: Array<Record<string, unknown>>; tools?: unknown[]; include?: string[] };
let onResponses: (body: Body, n: number) => Route = () => ({ body: fixture('openai-search.sse') });
const seen: Body[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  process.env.OPENAI_SEARCH_TEST_KEY = 'sk-test-key-1234567890abcdef';
  server = createServer((req: IncomingMessage, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}') as Body;
      seen.push(body);
      const r = onResponses(body, seen.length);
      res.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' ? 'text/event-stream' : 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  onResponses = () => ({ body: fixture('openai-search.sse') });
});

const pc: ProviderConfig = { name: 'openai', type: 'openai', headers: {}, models: {} };
const make = () => new OpenAIProvider({ config: { ...pc, baseUrl: base }, key: { key: 'sk-test-key-1234567890abcdef', source: 'env' } });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'gpt-5.5', messages: [user('AI news?')], sampling: {}, signal: new AbortController().signal, ...over });
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}
const textOf = (events: StreamEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
const dataOf = (events: StreamEvent[]) => (events.find((e) => e.type === 'provider_data') as { data: string } | undefined)?.data;
const bad = (message: string): Route => ({ status: 400, body: { error: { message, type: 'invalid_request_error' } } });
const WS = 'ws_67c9fa0502748190b7dd390736892e100be649c1a5ff9609';
const TEXT = 'Several things happened today ([example.com](https://example.com/ai-news?utm_source=chatgpt.com)). A second report agrees.';

async function searchedReply(): Promise<ChatMessage> {
  const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
  seen.length = 0;
  return { role: 'assistant', content: [{ type: 'reasoning', text: '', provider: 'openai', model: 'gpt-5.5', signature: 'ignored-when-kept' }, { type: 'text', text: textOf(events) }, { type: 'provider_data', provider: 'openai', model: 'gpt-5.5', data: dataOf(events)! }] };
}

describe('OpenAI web search', () => {
  it('guesses from the model id: current families can search, anything else is tried', () => {
    expect(guessOpenAICaps('gpt-5.5')).toMatchObject({ webSearch: true, searchLimit: true });
    expect(guessOpenAICaps('gpt-6.2-sol').webSearch).toBe(true);
    expect(guessOpenAICaps('chat-latest').webSearch).toBe(true);
    expect(guessOpenAICaps('some-future-model').webSearch).toBe('unknown');
  });

  it('without web search the request is what it was before', async () => {
    onResponses = () => ({ body: fixture('openai-responses.sse') });
    await collect(make().stream(req()));
    expect(Object.keys(seen[0]!).sort()).toEqual(['include', 'input', 'model', 'reasoning', 'store', 'stream']);
    expect(seen[0]!.include).toEqual(['reasoning.encrypted_content']);
  });

  it('asks for the tool with the limit, and turns the stream into searches, sources, text and usage', async () => {
    const events = await collect(make().stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen[0]!.tools).toEqual([{ type: 'web_search' }]);
    expect(seen[0]!.max_tool_calls).toBe(5);
    expect(seen[0]!.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources']);
    expect(seen[0]!.store).toBe(false);
    expect(events.filter((e) => e.type === 'search')).toEqual([
      { type: 'search', id: WS, status: 'started' },
      { type: 'search', id: WS, status: 'done', query: 'latest news about AI' },
      { type: 'search', id: 'ws_open', status: 'started' },
      { type: 'search', id: 'ws_open', status: 'done', query: 'reading https://example.com/ai-news' },
    ]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      // What the search looked at (web addresses only; the data feed is not one).
      { type: 'source', url: 'https://example.com/ai-news', title: '', cite: 'none' },
      { type: 'source', url: 'https://news.example.org/today', title: '', cite: 'none' },
      // Cited, and already linked in the text by the model: listed, no marker.
      { type: 'source', url: 'https://example.com/ai-news?utm_source=chatgpt.com', title: 'AI news today', cite: 'list' },
      // Cited without a link in the text: a marker after the text so far.
      { type: 'source', url: 'https://news.example.org/today?utm_source=chatgpt.com', title: 'Today in AI ‮\x1b[2J', cite: 'mark' },
    ]);
    expect(textOf(events)).toBe(TEXT);
    expect([...events].reverse().find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 8200, outputTokens: 120, reasoningTokens: 64, searches: 1 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('without a limit it sends none', async () => {
    await collect(make().stream(req({ webSearch: {} })));
    expect(seen[0]!.tools).toEqual([{ type: 'web_search' }]);
    expect('max_tool_calls' in seen[0]!).toBe(false);
  });

  it("keeps the reply's output items as they came and sends them back in order while search is on", async () => {
    const events = await collect(make().stream(req({ webSearch: {} })));
    const kept = parseKept(dataOf(events)!)!;
    expect(kept.output.map((i) => i.type)).toEqual(['reasoning', 'web_search_call', 'web_search_call', 'message']);
    expect(kept.output[0]).toEqual({ id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAAAABsearchreasoning==' });
    expect((kept.output[3] as unknown as { phase: string; content: Array<{ annotations: unknown[] }> }).phase).toBe('final_answer');
    expect((kept.output[3] as unknown as { content: Array<{ annotations: unknown[] }> }).content[0]!.annotations).toHaveLength(2);

    const reply = await searchedReply();
    await collect(make().stream(req({ webSearch: {}, messages: [user('AI news?'), reply, user('more')] })));
    expect(seen[0]!.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'AI news?' }] }, ...kept.output, { role: 'user', content: [{ type: 'input_text', text: 'more' }] }]);
  });

  it('with search off, a searched reply goes back as text with its sources, and nothing of the search', async () => {
    const reply = await searchedReply();
    onResponses = () => ({ body: fixture('openai-responses.sse') });
    await collect(make().stream(req({ messages: [user('AI news?'), reply, user('thanks')] })));
    expect(seen[0]!.tools).toBeUndefined();
    expect(seen[0]!.input[1]).toEqual({
      role: 'assistant',
      content: `${TEXT}\n\nSources:\n1. AI news today: https://example.com/ai-news?utm_source=chatgpt.com\n2. Today in AI [2J: https://news.example.org/today?utm_source=chatgpt.com`,
    });
    expect(JSON.stringify(seen[0]!.input)).not.toMatch(/web_search_call|encrypted_content|ignored-when-kept/);
  });

  it('a reply that did not search keeps nothing: it is replayed as before', async () => {
    onResponses = () => ({ body: fixture('openai-responses-encrypted.sse') });
    const events = await collect(make().stream(req({ webSearch: {} })));
    expect(dataOf(events)).toBeUndefined();
    expect(events.some((e) => e.type === 'reasoning_block')).toBe(true);
  });

  it('a search that fails is an item with status failed: plain words, and the reply goes on', async () => {
    onResponses = () => ({ body: fixture('openai-search-failed.sse') });
    const events = await collect(make().stream(req({ webSearch: {} })));
    expect(events.filter((e) => e.type === 'search')).toEqual([
      { type: 'search', id: 'ws_failed', status: 'started' },
      { type: 'search', id: 'ws_failed', status: 'failed', error: 'the search did not succeed' },
    ]);
    expect(textOf(events)).toBe('I could not search just now.');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('the API will not take kept items back: the reply goes as text instead, once, and that is remembered', async () => {
    const reply = await searchedReply();
    onResponses = (body) => (JSON.stringify(body.input).includes('web_search_call') ? bad("Item with id 'ws_67c9' not found. Items are not persisted when `store` is set to false.") : { body: fixture('openai-search.sse') });
    const provider = make();
    const events = await collect(provider.stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] })));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toEqual([{ type: 'web_search' }]);
    expect(String((seen[1]!.input[1] as { content: string }).content)).toContain('Sources:\n1. AI news today');
    expect(textOf(events)).toBe(TEXT);
    seen.length = 0;
    await collect(provider.stream(req({ webSearch: {}, messages: [user('q'), reply, user('next')] })));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.input)).not.toContain('web_search_call');
  });

  it('the model or project does not allow the tool: search_unavailable before anything is produced', async () => {
    onResponses = (body) => (body.tools ? bad("Hosted tool 'web_search' is not supported with gpt-5.5 in this project.") : { body: fixture('openai-responses.sse') });
    const events: StreamEvent[] = [];
    let err: unknown;
    try {
      for await (const e of make().stream(req({ webSearch: { maxUses: 5 } }))) events.push(e);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('search_unavailable');
    expect((err as ProviderError).providerMessage).toContain('not supported');
    expect(events.every((e) => e.type === 'status')).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('another 400 with search on is still reported as it is', async () => {
    onResponses = () => bad('Unknown parameter: foo');
    await expect(collect(make().stream(req({ webSearch: {} })))).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('through a session: sources and the marker are stored, the next turn replays the items, and a refusal is retried without search with one notice', async () => {
    const config: Config = { ...defaultConfig(), webSearch: true, providers: { openai: { ...pc, baseUrl: base, apiKeyEnv: 'OPENAI_SEARCH_TEST_KEY' } } };
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-openai-search-')));
    const session = new Session({ config, registry: new Registry(config), store, model: 'openai/gpt-5.5' });
    const notices: string[] = [];
    const ends: Array<Extract<SessionEvent, { type: 'assistant-end' }>> = [];
    session.on('event', (e: SessionEvent) => {
      if (e.type === 'notice') notices.push(e.text);
      if (e.type === 'assistant-end') ends.push(e);
    });
    await session.submit({ text: 'AI news?' });
    const m = session.conv.head!;
    expect(m.error).toBeUndefined();
    expect(m.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'search', 'search', 'source', 'source', 'source', 'source', 'provider_data']);
    // Two cited pages are listed; only the one the text does not link gets a marker.
    expect(listSources(m.content).map((s) => [s.n, s.title])).toEqual([
      [1, 'AI news today'],
      [2, 'Today in AI [2J'],
    ]);
    expect(displayText(TEXT, m.content)).toBe(`${TEXT} [2]`);
    // One search was billed (reading a page is not one).
    expect(ends[0]!.stats.searches).toBe(1);
    expect(seen[0]!.max_tool_calls).toBe(5);
    seen.length = 0;
    await session.submit({ text: 'more' });
    expect(seen[0]!.input.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'web_search_call', 'web_search_call', 'message', 'user']);
    expect(notices).toEqual([]);
    session.close();

    onResponses = (body) => (body.tools ? bad("Hosted tool 'web_search' is not supported with this model.") : { body: fixture('openai-responses.sse') });
    seen.length = 0;
    const second = new Session({ config, registry: new Registry(config), store, model: 'openai/gpt-5.5' });
    second.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    await second.submit({ text: 'hello' });
    expect(second.conv.path().map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(second.conv.head!.error).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('openai refused web search for gpt-5.5');
    expect(notices[0]).not.toContain('sk-test-key');
    second.close();
  });
});
