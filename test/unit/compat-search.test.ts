// Provider-run web search over chat completions: DeepSeek, Venice and
// OpenRouter, through the openai-compatible adapter against a local HTTP
// server (no network, no real key). Field names follow each service's
// documentation as read on 2026-11-27; see src/providers/compat.ts.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompatProvider, modelFromListEntry, searchStyleOf } from '../../src/providers/compat.js';
import { defaultConfig, loadConfig, type Config, type ProviderConfig } from '../../src/config/config.js';
import { PRESETS } from '../../src/config/presets.js';
import { ProviderError, type ChatMessage, type ChatRequest, type StreamEvent } from '../../src/providers/types.js';
import { Registry } from '../../src/providers/registry.js';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { Store } from '../../src/core/store.js';
import { listSources } from '../../src/core/sources.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

interface Route {
  status?: number;
  body: unknown;
}
type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>>; tools?: unknown[] };
let onChat: (body: Body) => Route = () => ({ body: fixture('deepseek-search.sse') });
let models: unknown[] = [];
const seen: Body[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  server = createServer((req: IncomingMessage, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let r: Route;
      if (req.method === 'GET') {
        r = req.url!.endsWith('/models') ? { body: { data: models } } : { status: 404, body: {} };
      } else if (req.url!.endsWith('/chat/completions')) {
        const body = JSON.parse(data) as Body;
        seen.push(body);
        r = onChat(body);
      } else {
        r = { status: 404, body: {} };
      }
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
  models = [];
  onChat = () => ({ body: fixture('deepseek-search.sse') });
});

const pc = (webSearchStyle?: string): ProviderConfig => ({ name: 'svc', type: 'openai-compatible', baseUrl: base, headers: {}, models: {}, noKey: true, ...(webSearchStyle ? { webSearchStyle } : {}) });
const make = (style?: string) => new CompatProvider({ config: pc(style), key: { source: 'none' } as never });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'm', messages: [user('q')], sampling: {}, signal: new AbortController().signal, ...over });
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}
const textOf = (events: StreamEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
const dataOf = (events: StreamEvent[]) => (events.find((e) => e.type === 'provider_data') as { data: string } | undefined)?.data;
const usageOf = (events: StreamEvent[]) => ([...events].reverse().find((e) => e.type === 'usage') as { usage: Record<string, unknown> } | undefined)?.usage;
const bad = (message: string): Route => ({ status: 400, body: { error: { message, type: 'invalid_request_error' } } });
const DS = 'srvtoolu_s_00_72b1a35619ec4611884415c48d35ba34';

describe('which search a service speaks', () => {
  it('is read from the address, or set in the config; any other server has none', () => {
    expect(searchStyleOf('https://api.deepseek.com')).toBe('deepseek');
    expect(searchStyleOf('https://api.deepseek.com/beta')).toBe('deepseek');
    expect(searchStyleOf('https://api.venice.ai/api/v1')).toBe('venice');
    expect(searchStyleOf('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(searchStyleOf('http://localhost:8080/v1')).toBeUndefined();
    expect(searchStyleOf('https://api.mistral.ai/v1')).toBeUndefined();
    // A look-alike host is not the service.
    expect(searchStyleOf('https://api.deepseek.com.example.org/v1')).toBeUndefined();
    expect(searchStyleOf('http://localhost:8080/v1', 'venice')).toBe('venice');
    expect(searchStyleOf('https://openrouter.ai/api/v1', 'none')).toBeUndefined();
    expect(searchStyleOf(undefined)).toBeUndefined();
  });

  it('web_search_style is a provider key with fixed values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-compat-cfg-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'providers:\n  gw:\n    type: openai-compatible\n    base_url: http://gw.internal/v1\n    web_search_style: openrouter\n');
    expect(loadConfig(file).issues).toEqual([]);
    expect(loadConfig(file).config.providers.gw!.webSearchStyle).toBe('openrouter');
    writeFileSync(file, 'providers:\n  gw:\n    type: openai-compatible\n    base_url: http://gw.internal/v1\n    web_search_style: bing\n');
    expect(JSON.stringify(loadConfig(file).issues)).toMatch(/web_search_style must be one of deepseek, venice, openrouter, none/);
    expect(loadConfig(file).config.providers.gw!.webSearchStyle).toBeUndefined();
  });

  it('says what each can do: none for an unknown server, any model on OpenRouter (with a limit), per model on Venice, unknown on DeepSeek', async () => {
    models = [{ id: 'm' }, { id: 'venice-yes', model_spec: { capabilities: { supportsWebSearch: true } } }, { id: 'venice-no', model_spec: { capabilities: { supportsWebSearch: false } } }];
    expect(await make().capabilities('m')).toMatchObject({ webSearch: false, searchLimit: false });
    expect(await make('openrouter').capabilities('m')).toMatchObject({ webSearch: true, searchLimit: true });
    expect(await make('deepseek').capabilities('m')).toMatchObject({ webSearch: 'unknown', searchLimit: false });
    expect(await make('venice').capabilities('venice-yes')).toMatchObject({ webSearch: true, searchLimit: false });
    expect((await make('venice').capabilities('venice-no')).webSearch).toBe(false);
    expect((await make('venice').capabilities('m')).webSearch).toBe('unknown');
    expect(modelFromListEntry({ id: 'x' }).webSearch).toBeUndefined();
  });

  it('DeepSeek and Venice are offered when adding a provider', () => {
    expect(PRESETS.find((p) => p.id === 'deepseek')).toMatchObject({ type: 'openai-compatible', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY' });
    expect(PRESETS.find((p) => p.id === 'venice')).toMatchObject({ type: 'openai-compatible', baseUrl: 'https://api.venice.ai/api/v1', keyEnv: 'VENICE_API_KEY' });
    for (const p of PRESETS) if (p.baseUrl && !p.local) expect(searchStyleOf(p.baseUrl) === undefined, p.id).toBe(!['deepseek', 'venice', 'openrouter'].includes(p.id));
  });
});

describe('without web search', () => {
  it('the request is what it was before, whatever the service', async () => {
    onChat = () => ({ body: fixture('openrouter-search.sse') });
    for (const style of [undefined, 'deepseek', 'venice', 'openrouter']) {
      seen.length = 0;
      await collect(make(style).stream(req()));
      expect(Object.keys(seen[0]!).sort(), String(style)).toEqual(['messages', 'model', 'stream', 'stream_options']);
    }
  });

  it('a server with no known search refuses the request before sending anything', async () => {
    await expect(collect(make().stream(req({ webSearch: {} })))).rejects.toMatchObject({ kind: 'search_unavailable' });
    expect(seen).toHaveLength(0);
  });
});

describe('DeepSeek', () => {
  it('declares the tool, and turns call events, sources, citations and usage into neutral events', async () => {
    const events = await collect(make('deepseek').stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen[0]!.tools).toEqual([{ type: 'deepseek_web_search' }]);
    expect(events.filter((e) => e.type === 'search')).toEqual([
      { type: 'search', id: DS, status: 'started', query: 'Iceland population 2025 · Iceland population 2026' },
      { type: 'search', id: DS, status: 'done', query: 'Iceland population 2025 · Iceland population 2026' },
    ]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      { type: 'source', url: 'https://statice.is/population', title: 'Population - Statistics Iceland', snippet: 'The population of Iceland was 394,000 at the start of 2026.', cite: 'none' },
      { type: 'source', url: 'https://example.org/iceland', title: 'Iceland facts', snippet: 'About 400 thousand people live in Iceland.', cite: 'none' },
      { type: 'source', url: 'https://statice.is/population', title: 'Population - Statistics Iceland', snippet: undefined, cite: 'list' },
    ]);
    expect(textOf(events)).toBe("Iceland's population is about **394,000** (early 2026).");
    expect(usageOf(events)).toMatchObject({ inputTokens: 1905, outputTokens: 72, searches: 2 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const kept = JSON.parse(dataOf(events)!) as { v: number; server_tool_calls: Array<{ calls: Array<{ id: string; status: string }> }> };
    expect(kept.server_tool_calls[0]!.calls[0]).toMatchObject({ id: DS, status: 'completed' });
  });

  it('passes server_tool_calls back unchanged while search is on, and only text when it is off', async () => {
    const first = await collect(make('deepseek').stream(req({ webSearch: {} })));
    const reply: ChatMessage = { role: 'assistant', content: [{ type: 'text', text: textOf(first) }, { type: 'provider_data', provider: 'svc', model: 'm', data: dataOf(first)! }] };
    seen.length = 0;
    await collect(make('deepseek').stream(req({ webSearch: {}, messages: [user('q'), reply, user('more')] })));
    expect(seen[0]!.messages[1]).toEqual({ role: 'assistant', content: textOf(first), server_tool_calls: (JSON.parse(dataOf(first)!) as { server_tool_calls: unknown[] }).server_tool_calls });
    seen.length = 0;
    onChat = () => ({ body: fixture('llamacpp.sse') });
    await collect(make('deepseek').stream(req({ messages: [user('q'), reply, user('more')] })));
    expect(seen[0]!.messages[1]).toEqual({ role: 'assistant', content: textOf(first) });
    expect(seen[0]!.tools).toBeUndefined();
  });

  it('a failed call is a failed search in plain words; the reply goes on', async () => {
    onChat = () => ({ body: fixture('deepseek-search-failed.sse') });
    const events = await collect(make('deepseek').stream(req({ webSearch: {} })));
    expect(events.filter((e) => e.type === 'search').at(-1)).toEqual({ type: 'search', id: DS, status: 'failed', query: 'Iceland population 2025 · Iceland population 2026', error: 'the search did not succeed (unavailable)' });
    expect(textOf(events)).toBe('I could not search, so this is from memory.');
  });

  it('a refusal that names the tool is search_unavailable, before anything is produced', async () => {
    onChat = (body) => (body.tools ? bad('This model does not support server tools: deepseek_web_search') : { body: fixture('llamacpp.sse') });
    let err: unknown;
    try {
      await collect(make('deepseek').stream(req({ webSearch: {} })));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('search_unavailable');
    expect(seen).toHaveLength(1);
  });

  it('through a session: stored parts, the listed source, and the calls on the next turn', async () => {
    const config: Config = { ...defaultConfig(), webSearch: true, providers: { svc: pc('deepseek') } };
    const session = new Session({ config, registry: new Registry(config), store: new Store(mkdtempSync(join(tmpdir(), 'taria-compat-search-'))), model: 'svc/m' });
    const notices: string[] = [];
    const ends: Array<Extract<SessionEvent, { type: 'assistant-end' }>> = [];
    session.on('event', (e: SessionEvent) => {
      if (e.type === 'notice') notices.push(e.text);
      if (e.type === 'assistant-end') ends.push(e);
    });
    await session.submit({ text: 'How many people live in Iceland?' });
    const m = session.conv.head!;
    expect(m.error).toBeUndefined();
    expect(m.content.map((p) => p.type)).toEqual(['text', 'search', 'source', 'source', 'source', 'provider_data']);
    expect(listSources(m.content)).toEqual([{ n: 1, url: 'https://statice.is/population', title: 'Population - Statistics Iceland' }]);
    expect(ends[0]!.stats.searches).toBeGreaterThanOrEqual(1);
    expect(m.usage?.searches).toBe(2);
    // No limit is sent: DeepSeek has none.
    expect(JSON.stringify(seen[0])).not.toContain('max_');
    seen.length = 0;
    await session.submit({ text: 'and Greenland?' });
    expect(seen[0]!.messages[1]!.server_tool_calls).toBeDefined();
    expect(notices).toEqual([]);
    session.close();
  });
});

describe('Venice', () => {
  it('asks with venice_parameters, lists the pages it reports, and counts one search', async () => {
    onChat = () => ({ body: fixture('venice-search.sse') });
    const events = await collect(make('venice').stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen[0]!.venice_parameters).toEqual({ enable_web_search: 'auto', enable_web_citations: false, include_search_results_in_stream: true });
    expect(seen[0]!.tools).toBeUndefined();
    expect(events.filter((e) => e.type === 'search')).toEqual([{ type: 'search', id: 'web-search', status: 'done' }]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      { type: 'source', url: 'https://www.skyatnightmagazine.com/space-science/why-is-the-sky-blue', title: 'Why is the sky blue? | BBC Sky at Night Magazine', snippet: 'The sky is blue because of Rayleigh scattering.', cite: 'none' },
      { type: 'source', url: 'https://example.org/sky', title: 'Blue sky ‮evil‬', snippet: 'Short wavelengths scatter more.', cite: 'none' },
    ]);
    expect(textOf(events)).toBe('The sky is blue because air scatters short wavelengths the most.');
    expect(dataOf(events)).toBeUndefined();
  });

  it('a reply that did not search has no search and no sources', async () => {
    onChat = () => ({ body: fixture('llamacpp.sse') });
    const events = await collect(make('venice').stream(req({ webSearch: {} })));
    expect(events.some((e) => e.type === 'search' || e.type === 'source')).toBe(false);
  });

  it("the user's own venice_parameters in extra_body win", async () => {
    onChat = () => ({ body: fixture('venice-search.sse') });
    await collect(make('venice').stream(req({ webSearch: {}, sampling: { extraBody: { venice_parameters: { enable_web_search: 'on' } } } })));
    expect(seen[0]!.venice_parameters).toEqual({ enable_web_search: 'on' });
  });
});

describe('OpenRouter', () => {
  it('declares its server tool with the limit, lists each cited page once, and counts the searches it reports', async () => {
    onChat = () => ({ body: fixture('openrouter-search.sse') });
    const events = await collect(make('openrouter').stream(req({ webSearch: { maxUses: 5 } })));
    expect(seen[0]!.tools).toEqual([{ type: 'openrouter:web_search', parameters: { max_uses: 5 } }]);
    expect(events.filter((e) => e.type === 'source')).toEqual([
      { type: 'source', url: 'https://www.example.com/btc', title: 'Bitcoin price today', snippet: 'BTC trades at $63,992 [...] down 1.5%', cite: 'list' },
      { type: 'source', url: 'https://markets.example.net/crypto', title: 'Crypto markets', snippet: undefined, cite: 'list' },
    ]);
    expect(events.filter((e) => e.type === 'search')).toEqual([{ type: 'search', id: 'web-search', status: 'done' }]);
    expect(usageOf(events)).toMatchObject({ inputTokens: 105, outputTokens: 250, searches: 2 });
    expect(textOf(events)).toBe('Bitcoin is at $63,992 today.');
  });

  it('without a limit it sends none', async () => {
    onChat = () => ({ body: fixture('openrouter-search.sse') });
    await collect(make('openrouter').stream(req({ webSearch: {} })));
    expect(seen[0]!.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });
});
