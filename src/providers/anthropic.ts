// Anthropic Messages API via the official SDK (loaded lazily). Streaming,
// adaptive/extended thinking with visible summaries, effort, image input and
// prompt caching on the conversation prefix. Retries are done by the session
// (so they are visible), so the SDK's own retries are disabled.

import type Anthropic from '@anthropic-ai/sdk';
import type { AdapterContext } from './registry.js';
import { getFetch, httpError, networkError, resolveHeaders, TtlCache } from './http.js';
import { debug } from '../debug.js';
import type { ChatMessage, ChatRequest, ContentPart, ModelCapabilities, ModelInfo, Provider, ReasoningEffort, StreamEvent, Usage } from './types.js';
import { ProviderError, UNKNOWN_CAPS } from './types.js';

let sdk: Promise<{ default: typeof Anthropic }> | undefined;
const loadSdk = () => (sdk ??= import('@anthropic-ai/sdk'));

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

type Caps = Record<string, unknown> | null | undefined;

function supported(caps: Caps, ...path: string[]): boolean {
  let cur: unknown = caps;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return !!cur && typeof cur === 'object' && (cur as { supported?: unknown }).supported === true;
}

interface AnthropicModelInfo {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Caps;
}

export function capsFromModel(m: AnthropicModelInfo): ModelCapabilities & { adaptive: boolean; budget: boolean } {
  const c = m.capabilities;
  const efforts = supported(c, 'effort') ? EFFORTS.filter((e) => supported(c, 'effort', e)) : [];
  const adaptive = supported(c, 'thinking', 'types', 'adaptive');
  const budget = supported(c, 'thinking', 'types', 'enabled');
  return {
    images: c ? supported(c, 'image_input') : 'unknown',
    reasoning: c ? supported(c, 'thinking') : 'unknown',
    reasoningEfforts: efforts,
    contextWindow: m.max_input_tokens,
    maxOutputTokens: m.max_tokens,
    adaptive,
    budget,
  };
}

/** Convert neutral messages to Anthropic message params. */
export function toAnthropicMessages(msgs: ChatMessage[], provider: string, model: string): Anthropic.MessageParam[] {
  return msgs.map((m) => {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const p of m.content) {
      const b = toBlock(p, provider, model, m.role);
      if (b) blocks.push(b);
    }
    // Thinking blocks must lead an assistant turn.
    blocks.sort((a, b) => Number(b.type === 'thinking' || b.type === 'redacted_thinking') - Number(a.type === 'thinking' || a.type === 'redacted_thinking'));
    if (!blocks.length) blocks.push({ type: 'text', text: '(empty)' });
    return { role: m.role, content: blocks };
  });
}

function toBlock(p: ContentPart, provider: string, model: string, role: 'user' | 'assistant'): Anthropic.ContentBlockParam | null {
  switch (p.type) {
    case 'text':
      return p.text ? { type: 'text', text: p.text } : null;
    case 'file':
      return { type: 'text', text: `<file name="${p.name}">\n${p.text}\n</file>` };
    case 'image':
      if (!p.data) return null;
      return { type: 'image', source: { type: 'base64', media_type: p.mediaType as 'image/png', data: p.data } };
    case 'reasoning':
      // Only replay reasoning to the model that produced it, unchanged.
      if (role !== 'assistant' || p.provider !== provider || p.model !== model) return null;
      if (p.redacted) return { type: 'redacted_thinking', data: p.redacted };
      if (p.signature) return { type: 'thinking', thinking: p.text, signature: p.signature };
      return null;
  }
}

export class AnthropicProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly name: string;
  readonly endpoint: string;
  private client?: Promise<Anthropic>;
  private models = new TtlCache<AnthropicModelInfo[]>(5 * 60_000);

  constructor(private readonly ctx: AdapterContext) {
    this.name = ctx.config.name;
    this.endpoint = ctx.config.baseUrl ?? 'https://api.anthropic.com';
  }

  private getClient(): Promise<Anthropic> {
    this.client ??= (async () => {
      const mod = await loadSdk();
      const fetch = await getFetch();
      const AnthropicCtor = mod.default;
      return new AnthropicCtor({
        apiKey: this.ctx.key.key ?? null,
        baseURL: this.ctx.config.baseUrl,
        maxRetries: 0,
        timeout: this.ctx.config.timeoutMs ?? 30 * 60_000,
        fetch: fetch as never,
        defaultHeaders: resolveHeaders(this.ctx.config.headers),
      });
    })();
    return this.client;
  }

  private async mapError(e: unknown, signal?: AbortSignal): Promise<ProviderError> {
    const mod = await loadSdk();
    const A = mod.default;
    if (e instanceof ProviderError) return e;
    if (e instanceof A.APIUserAbortError || signal?.aborted) return new ProviderError('aborted', 'Request cancelled');
    if (e instanceof A.APIConnectionError) return networkError((e as { cause?: unknown }).cause ?? e, this.endpoint, this.name, signal);
    if (e instanceof A.APIError && typeof e.status === 'number') {
      // Re-use the shared mapping by building a Response-like object.
      const body = JSON.stringify(e.error ?? { error: { message: e.message } });
      // The SDK's headers may come from undici's own Headers class, so copy
      // them rather than relying on instanceof.
      const headers = new Headers();
      const h = e.headers as unknown as { forEach?: (cb: (v: string, k: string) => void) => void } | Record<string, string> | undefined;
      if (h && typeof (h as { forEach?: unknown }).forEach === 'function') (h as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => headers.set(k, v));
      else if (h) for (const [k, v] of Object.entries(h)) if (typeof v === 'string') headers.set(k, v);
      const err = await httpError(new Response(body, { status: e.status, headers }), this.name);
      return err;
    }
    if (e instanceof A.APIError) {
      // Errors delivered inside the stream (e.g. overloaded_error) have no status.
      const body = (e.error ?? {}) as { error?: { type?: string; message?: string } };
      const type = body.error?.type ?? '';
      const msg = body.error?.message ?? e.message;
      if (type === 'overloaded_error') return new ProviderError('overloaded', `${this.name} is overloaded: ${msg}`, { retryable: true, providerMessage: msg });
      if (type === 'rate_limit_error') return new ProviderError('rate_limit', `Rate limited by ${this.name}: ${msg}`, { retryable: true, providerMessage: msg });
      if (type === 'api_error') return new ProviderError('server', `${this.name} returned an error: ${msg}`, { retryable: true, providerMessage: msg });
      return new ProviderError('unknown', `${this.name}: ${msg}`, { providerMessage: msg });
    }
    return networkError(e, this.endpoint, this.name, signal);
  }

  private async fetchModels(signal?: AbortSignal): Promise<AnthropicModelInfo[]> {
    const client = await this.getClient();
    try {
      const out: AnthropicModelInfo[] = [];
      for await (const m of client.models.list({ limit: 1000 }, { signal })) out.push(m as unknown as AnthropicModelInfo);
      return out;
    } catch (e) {
      throw await this.mapError(e, signal);
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models = await this.models.get(() => this.fetchModels(signal));
    return models.map((m) => ({ id: m.id, displayName: m.display_name, capabilities: capsFromModel(m) }));
  }

  private async modelInfo(model: string): Promise<AnthropicModelInfo | undefined> {
    try {
      const list = await this.models.get(() => this.fetchModels());
      return list.find((m) => m.id === model);
    } catch {
      return undefined;
    }
  }

  async capabilities(model: string): Promise<ModelCapabilities> {
    const m = await this.modelInfo(model);
    if (!m) return UNKNOWN_CAPS;
    const { adaptive: _a, budget: _b, ...caps } = capsFromModel(m);
    return caps;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const client = await this.getClient();
    const info = await this.modelInfo(req.model);
    const caps = info ? capsFromModel(info) : undefined;
    const s = req.sampling;
    const maxTokens = s.maxTokens ?? Math.min(caps?.maxOutputTokens ?? 32_000, 64_000);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      messages: toAnthropicMessages(req.messages, this.name, req.model),
      stream: true,
      // Cache the conversation prefix (the last cacheable block).
      cache_control: { type: 'ephemeral' },
    };
    if (req.system) body.system = req.system;
    if (caps?.adaptive) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
    } else if (caps?.budget && req.reasoningEffort && req.reasoningEffort !== 'off') {
      const budget = { minimal: 1024, low: 2048, medium: 8192, high: 16_000, xhigh: 24_000, max: 32_000 }[req.reasoningEffort];
      body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
    }
    if (req.reasoningEffort && req.reasoningEffort !== 'off' && caps?.reasoningEfforts.includes(req.reasoningEffort)) {
      body.output_config = { effort: req.reasoningEffort };
    }
    if (s.temperature !== undefined) body.temperature = s.temperature;
    if (s.topP !== undefined) body.top_p = s.topP;
    if (s.topK !== undefined) body.top_k = s.topK;
    if (s.extraBody) Object.assign(body, s.extraBody);

    yield { type: 'status', status: 'connecting' };
    debug('anthropic request', { model: req.model, max_tokens: maxTokens, thinking: body.thinking, effort: body.output_config });
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = (await client.messages.create(body as unknown as Anthropic.MessageCreateParamsStreaming, { signal: req.signal })) as unknown as AsyncIterable<Anthropic.RawMessageStreamEvent>;
    } catch (e) {
      throw await this.mapError(e, req.signal);
    }
    yield { type: 'status', status: 'waiting' };

    const usage: Usage = {};
    const blocks = new Map<number, { type: string; signature?: string; redacted?: string }>();
    let stopReason: string | undefined;
    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message.usage;
            usage.inputTokens = u.input_tokens;
            usage.cacheReadTokens = u.cache_read_input_tokens ?? undefined;
            usage.cacheWriteTokens = u.cache_creation_input_tokens ?? undefined;
            break;
          }
          case 'content_block_start': {
            const b = ev.content_block;
            blocks.set(ev.index, { type: b.type, ...(b.type === 'redacted_thinking' ? { redacted: b.data } : {}) });
            if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (d.type === 'text_delta') yield { type: 'text', text: d.text };
            else if (d.type === 'thinking_delta') yield { type: 'reasoning', text: d.thinking };
            else if (d.type === 'signature_delta') {
              const b = blocks.get(ev.index);
              if (b) b.signature = (b.signature ?? '') + d.signature;
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks.get(ev.index);
            if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
              yield { type: 'reasoning_block', signature: b.signature, redacted: b.redacted };
            }
            break;
          }
          case 'message_delta': {
            stopReason = ev.delta.stop_reason ?? stopReason;
            usage.outputTokens = ev.usage.output_tokens;
            if (ev.usage.input_tokens != null) usage.inputTokens = ev.usage.input_tokens;
            yield { type: 'usage', usage: { ...usage } };
            if (stopReason === 'refusal') {
              const details = (ev.delta as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
              yield {
                type: 'text',
                text: `\n\n_The model declined to continue${details?.category ? ` (${details.category})` : ''}${details?.explanation ? `: ${details.explanation}` : '.'}_`,
              };
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (e) {
      throw await this.mapError(e, req.signal);
    }
    yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }
}

