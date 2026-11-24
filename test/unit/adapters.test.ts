// Each adapter is exercised end to end (request building, HTTP, SSE parsing)
// against a local server that replays recorded-format fixtures.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { CompatProvider, ThinkTagSplitter } from '../../src/providers/compat.js';
import type { ProviderConfig } from '../../src/config/config.js';
import type { ChatRequest, StreamEvent } from '../../src/providers/types.js';
import { ProviderError } from '../../src/providers/types.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');

interface Route {
  status?: number;
  body: string | object;
  type?: string;
  headers?: Record<string, string>;
}
let routes: Record<string, Route | ((body: Record<string, unknown>) => Route)> = {};
const seen: Array<{ url: string; method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
let server: Server;
let base = '';

beforeAll(async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
      seen.push({ url: req.url!, method: req.method!, headers: req.headers, body });
      const key = `${req.method} ${req.url!.split('?')[0]}`;
      const r0 = routes[key];
      const r = typeof r0 === 'function' ? r0(body) : r0;
      if (!r) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route ${key}` } }));
        return;
      }
      res.writeHead(r.status ?? 200, { 'content-type': r.type ?? (typeof r.body === 'string' ? 'text/event-stream' : 'application/json'), ...(r.headers ?? {}) });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const pc = (over: Partial<ProviderConfig>): ProviderConfig => ({ name: 'p', type: 'openai-compatible', headers: {}, models: {}, ...over });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  sampling: {},
  signal: new AbortController().signal,
  ...over,
});

async function collect(it: AsyncIterable<StreamEvent>): Promise<{ text: string; reasoning: string; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  return {
    events,
    text: events.map((e) => (e.type === 'text' ? e.text : '')).join(''),
    reasoning: events.map((e) => (e.type === 'reasoning' ? e.text : '')).join(''),
  };
}

const ANTHROPIC_MODELS = {
  data: [
    {
      id: 'claude-test',
      type: 'model',
      display_name: 'Claude Test',
      created_at: '2026-01-01T00:00:00Z',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
      },
    },
  ],
  has_more: false,
  first_id: 'claude-test',
  last_id: 'claude-test',
};

describe('Anthropic adapter', () => {
  const make = () => new AnthropicProvider({ config: pc({ name: 'anthropic', type: 'anthropic', baseUrl: base }), key: { key: 'sk-ant-test-key-1234567890', source: 'env' } });

  it('reads capabilities from the models API', async () => {
    routes = { 'GET /v1/models': { body: ANTHROPIC_MODELS } };
    const caps = await make().capabilities('claude-test');
    expect(caps).toMatchObject({ images: true, reasoning: true, contextWindow: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  it('streams thinking with signature, text and usage; sends caching, adaptive thinking and effort', async () => {
    routes = { 'GET /v1/models': { body: ANTHROPIC_MODELS }, 'POST /v1/messages': { body: fixture('anthropic-thinking.sse') } };
    seen.length = 0;
    const r = await collect(
      make().stream(
        req({
          model: 'claude-test',
          system: 'Be nice',
          reasoningEffort: 'high',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', hash: 'h', data: 'AAAA' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'old', provider: 'anthropic', model: 'claude-test', signature: 'sig' }] },
            { role: 'assistant', content: [{ type: 'reasoning', text: 'other model', provider: 'openai', model: 'x', signature: 'zzz' }, { type: 'text', text: 'x' }] },
            { role: 'user', content: [{ type: 'text', text: 'again' }] },
          ],
        }),
      ),
    );
    expect(r.text).toBe('Hello, world!');
    expect(r.reasoning).toBe('The user wants a greeting. Keep it short.');
    expect(r.events.find((e) => e.type === 'reasoning_block')).toMatchObject({ signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds' });
    const usage = [...r.events].reverse().find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputTokens: 21, outputTokens: 42, cacheReadTokens: 1500 } });
    expect(r.events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const sent = seen.find((s) => s.url.startsWith('/v1/messages'))!;
    expect(sent.headers.authorization).toBe('Bearer sk-ant-test-key-1234567890');
    expect(sent.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(sent.body.output_config).toEqual({ effort: 'high' });
    expect(sent.body.system).toBe('Be nice');
    expect(sent.body.temperature).toBeUndefined();
    const msgs = sent.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]!.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    // Same-model thinking is replayed first and unchanged; other providers' is dropped.
    expect(msgs[1]!.content[0]).toEqual({ type: 'thinking', thinking: 'old', signature: 'sig' });
    expect(JSON.stringify(msgs[2])).not.toContain('other model');
  });

  it('turns a mid-stream overloaded error into a retryable error after partial text', async () => {
    routes = { 'GET /v1/models': { body: ANTHROPIC_MODELS }, 'POST /v1/messages': { body: fixture('anthropic-overloaded.sse') } };
    const events: StreamEvent[] = [];
    let err: unknown;
    try {
      for await (const e of make().stream(req({ model: 'claude-test' }))) events.push(e);
    } catch (e) {
      err = e;
    }
    expect(events.some((e) => e.type === 'text' && e.text === 'Partial')).toBe(true);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('overloaded');
  });

  it('maps HTTP errors with the provider message and never leaks the key', async () => {
    routes = {
      'GET /v1/models': { body: ANTHROPIC_MODELS },
      'POST /v1/messages': { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-test-key-1234567890' } } },
    };
    let err: ProviderError | undefined;
    try {
      await collect(make().stream(req({ model: 'claude-test' })));
    } catch (e) {
      err = e as ProviderError;
    }
    expect(err?.kind).toBe('auth');
    expect(err?.message).toContain('invalid x-api-key');
    expect(err?.message).not.toContain('1234567890');
  });

  it('marks 429 as retryable with retry-after', async () => {
    routes = {
      'GET /v1/models': { body: ANTHROPIC_MODELS },
      'POST /v1/messages': { status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
    };
    let err: ProviderError | undefined;
    try {
      await collect(make().stream(req({ model: 'claude-test' })));
    } catch (e) {
      err = e as ProviderError;
    }
    expect(err).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 3000 });
  });
});

describe('OpenAI adapter (Responses API)', () => {
  const make = () => new OpenAIProvider({ config: pc({ name: 'openai', type: 'openai', baseUrl: `${base}/v1` }), key: { key: 'sk-test-openai-0123456789', source: 'env' } });

  it('streams reasoning summaries and text with normalised usage', async () => {
    routes = { 'POST /v1/responses': { body: fixture('openai-responses.sse') } };
    seen.length = 0;
    const r = await collect(make().stream(req({ model: 'gpt-5-test', system: 'sys', reasoningEffort: 'low', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', mediaType: 'image/jpeg', hash: 'h', data: 'BBBB' }] }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'text', text: 'q2' }] }] })));
    expect(r.text).toBe('Hi there.');
    expect(r.reasoning).toBe('**Planning** the answer.\n\nSecond part.');
    expect(r.events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 36, outputTokens: 50, cacheReadTokens: 64, reasoningTokens: 30 } });
    const body = seen[0]!.body;
    expect(body.instructions).toBe('sys');
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' }] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
    ]);
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-test-openai-0123456789');
  });

  it('keeps encrypted reasoning (store: false) and sends it back, before the reply it led to', async () => {
    routes = { 'POST /v1/responses': { body: fixture('openai-responses-encrypted.sse') } };
    seen.length = 0;
    const r = await collect(make().stream(req({ model: 'gpt-5-test' })));
    expect(seen[0]!.body.store).toBe(false);
    expect(seen[0]!.body.include).toEqual(['reasoning.encrypted_content']);
    const block = r.events.find((e) => e.type === 'reasoning_block') as { signature: string } | undefined;
    expect(block).toBeDefined();
    expect(r.text).toBe('Hi there.');

    // Next turn: the reasoning goes back verbatim, ahead of the assistant text.
    seen.length = 0;
    await collect(
      make().stream(
        req({
          model: 'gpt-5-test',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'q' }] },
            { role: 'assistant', content: [{ type: 'reasoning', text: '**Planning** the answer.', provider: 'openai', model: 'gpt-5-test', signature: block!.signature }, { type: 'text', text: 'Hi there.' }] },
            { role: 'user', content: [{ type: 'text', text: 'q2' }] },
          ],
        }),
      ),
    );
    expect(seen[0]!.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [
          { type: 'summary_text', text: '**Planning** the answer.' },
          { type: 'summary_text', text: 'Second part.' },
        ],
        encrypted_content: 'gAAAAABencryptedreasoningblob==',
      },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
    ]);
  });

  it('does not ask a non-reasoning model for encrypted reasoning, and ignores unusable signatures', async () => {
    routes = { 'POST /v1/responses': { body: fixture('openai-responses.sse') } };
    seen.length = 0;
    await collect(
      make().stream(
        req({
          model: 'gpt-4.1',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'q' }] },
            { role: 'assistant', content: [{ type: 'reasoning', text: 't', provider: 'openai', model: 'gpt-4.1', signature: 'not json' }, { type: 'text', text: 'a' }] },
            { role: 'user', content: [{ type: 'text', text: 'q2' }] },
          ],
        }),
      ),
    );
    expect(seen[0]!.body.include).toBeUndefined();
    expect((seen[0]!.body.input as unknown[]).length).toBe(3);
  });

  it('retries without reasoning summaries when the organisation cannot receive them', async () => {
    let calls = 0;
    routes = {
      'POST /v1/responses': (body) => {
        calls++;
        if ((body.reasoning as { summary?: string } | undefined)?.summary) return { status: 400, body: { error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error' } } };
        return { body: fixture('openai-responses.sse') };
      },
    };
    const r = await collect(make().stream(req({ model: 'o4-test' })));
    expect(calls).toBe(2);
    expect(r.text).toBe('Hi there.');
  });

  it('surfaces response.failed as an error', async () => {
    routes = { 'POST /v1/responses': { body: fixture('openai-failed.sse') } };
    await expect(collect(make().stream(req({ model: 'gpt-4.1' })))).rejects.toMatchObject({ kind: 'server', retryable: true });
  });

  it('lists only chat models', async () => {
    routes = { 'GET /v1/models': { body: { data: [{ id: 'gpt-5-test', created: 2 }, { id: 'text-embedding-3-small', created: 3 }, { id: 'whisper-1', created: 1 }] } } };
    expect((await make().listModels()).map((m) => m.id)).toEqual(['gpt-5-test']);
  });
});

describe('OpenAI-compatible adapter', () => {
  const make = (over: Partial<ProviderConfig> = {}) => new CompatProvider({ config: pc({ name: 'local', baseUrl: `${base}/v1`, ...over }), key: { source: 'none' } });

  it('llama.cpp: reasoning_content, timings as usage, and context size from /props', async () => {
    routes = {
      'POST /v1/chat/completions': { body: fixture('llamacpp.sse') },
      'GET /v1/models': { body: { object: 'list', data: [{ id: 'qwen3', object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 40960 } }] } },
      'GET /props': { body: { default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } } },
    };
    seen.length = 0;
    const r = await collect(make().stream(req({ model: 'qwen3', system: 'S', sampling: { temperature: 0.3, topK: 20 } })));
    expect(r.reasoning).toBe('Let me think.');
    expect(r.text).toBe('The answer is 42.');
    expect(r.events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 12, outputTokens: 9 } });
    const body = seen[0]!.body;
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, temperature: 0.3, top_k: 20 });
    expect(body.max_tokens).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
    const caps = await make().capabilities('qwen3');
    expect(caps).toMatchObject({ contextWindow: 8192, images: false });
  });

  it('Ollama: <think> tags split across chunks become reasoning', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('ollama-think-tags.sse') } };
    const r = await collect(make().stream(req()));
    expect(r.reasoning.trim()).toBe('Pondering');
    expect(r.text).toBe('Final answer.');
    expect(r.events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 20, outputTokens: 11 } });
  });

  it('Ollama: delta.reasoning and finish_reason length', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('ollama-reasoning.sse') } };
    const r = await collect(make().stream(req()));
    expect(r.reasoning).toBe('Thinking hard');
    expect(r.text).toBe('Done.');
    expect(r.events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('Ollama: capabilities from /api/show and /api/ps', async () => {
    routes = {
      'GET /v1/models': { body: { object: 'list', data: [{ id: 'llava:7b', object: 'model', owned_by: 'library' }] } },
      'POST /api/show': { body: { capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } } },
      'GET /api/ps': { body: { models: [{ name: 'llava:7b', model: 'llava:7b', context_length: 4096 }] } },
    };
    expect(await make().capabilities('llava:7b')).toMatchObject({ images: true, reasoning: false, contextWindow: 4096 });
  });

  it('Mistral: content arrays with thinking chunks', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('mistral-thinking.sse') } };
    const r = await collect(make().stream(req()));
    expect(r.reasoning).toBe('Reasoning step. More.');
    expect(r.text).toBe('Bonjour !');
    expect(r.events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 8, outputTokens: 12 } });
  });

  it('retries without stream_options when the server rejects it', async () => {
    let calls = 0;
    routes = {
      'POST /v1/chat/completions': (body) => {
        calls++;
        if (body.stream_options) return { status: 422, body: { detail: [{ loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] } };
        return { body: fixture('groq.sse') };
      },
    };
    const p = make();
    const r = await collect(p.stream(req()));
    expect(calls).toBe(2);
    expect(r.text).toBe('Fast.');
    expect(r.events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 } });
    calls = 0;
    await collect(p.stream(req()));
    expect(calls).toBe(1); // remembered
  });

  it('OpenRouter: mid-stream error after partial text', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('openrouter-error.sse') } };
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of make().stream(req())) events.push(e);
      })(),
    ).rejects.toMatchObject({ message: expect.stringContaining('Provider disconnected') });
    expect(events.some((e) => e.type === 'text' && e.text === 'Start')).toBe(true);
  });

  it('sends images as data URLs and keys as bearer tokens', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('groq.sse') } };
    seen.length = 0;
    const p = new CompatProvider({ config: pc({ name: 'mistral', baseUrl: `${base}/v1`, headers: { 'X-Extra': 'yes' } }), key: { key: 'mk-abcdefghijkl', source: 'env' } });
    await collect(p.stream(req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', hash: 'h', data: 'CCCC' }] }] })));
    expect(seen[0]!.headers.authorization).toBe('Bearer mk-abcdefghijkl');
    expect(seen[0]!.headers['x-extra']).toBe('yes');
    expect((seen[0]!.body.messages as unknown[])[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }] });
  });

  it('reports a server that is not running, with the address', async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const p = new CompatProvider({ config: pc({ name: 'local', baseUrl: `http://127.0.0.1:${port}/v1` }), key: { source: 'none' } });
    await expect(collect(p.stream(req()))).rejects.toMatchObject({ kind: 'not_running', message: expect.stringContaining(`http://127.0.0.1:${port}`) });
  });

  it('explains a missing model list', async () => {
    routes = {};
    await expect(make().listModels()).rejects.toMatchObject({ message: expect.stringContaining('Type a model id') });
  });

  it('aborts immediately', async () => {
    routes = { 'POST /v1/chat/completions': { body: fixture('llamacpp.sse') } };
    const ac = new AbortController();
    ac.abort();
    await expect(collect(make().stream(req({ signal: ac.signal })))).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('ThinkTagSplitter', () => {
  it('passes through content without think tags untouched', () => {
    const t = new ThinkTagSplitter();
    const out = [...t.push('  <b>bold</b> text'), ...t.flush()];
    expect(out.map((o) => o.kind + ':' + o.text).join('|')).toBe('text:  <b>bold</b> text');
  });
});

describe('openai: replayed reasoning the API refuses', () => {
  it('is left out and the request sent again, instead of failing every later turn', async () => {
    const hasReasoning = (body: Record<string, unknown>) => (body.input as Array<{ type?: string }>).some((i) => i.type === 'reasoning');
    routes = {
      'POST /v1/responses': (body) =>
        hasReasoning(body)
          ? { status: 400, body: { error: { message: 'The encrypted content for item rs_1 could not be verified.', type: 'invalid_request_error' } } }
          : { body: fixture('openai-responses.sse') },
    };
    seen.length = 0;
    const provider = new OpenAIProvider({ config: pc({ name: 'openai', type: 'openai', baseUrl: `${base}/v1` }), key: { key: 'sk-test-openai-0123456789', source: 'env' } });
    const signature = JSON.stringify({ id: 'rs_1', encrypted_content: 'blob', summary: [] });
    const r = await collect(
      provider.stream(
        req({
          model: 'gpt-5-test',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'q' }] },
            { role: 'assistant', content: [{ type: 'reasoning', text: '', provider: 'openai', model: 'gpt-5-test', signature }, { type: 'text', text: 'a' }] },
            { role: 'user', content: [{ type: 'text', text: 'q2' }] },
          ],
        }),
      ),
    );
    expect(r.text.length).toBeGreaterThan(0);
    expect(seen.length).toBe(2);
    expect(hasReasoning(seen[0]!.body)).toBe(true);
    expect(hasReasoning(seen[1]!.body)).toBe(false);
    expect(seen[1]!.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
    ]);

    // A 400 that has nothing to do with reasoning is still reported, once.
    routes = { 'POST /v1/responses': { status: 400, body: { error: { message: 'Unknown parameter: foo', type: 'invalid_request_error' } } } };
    seen.length = 0;
    await expect(collect(provider.stream(req({ model: 'gpt-5-test' })))).rejects.toThrow(/Unknown parameter/);
    expect(seen.length).toBe(1);
  });
});
