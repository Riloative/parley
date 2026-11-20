// OpenAI via the Responses API (OpenAI's recommended endpoint for new work),
// streamed over SSE with raw fetch. Reasoning summaries are requested for
// reasoning models; if the organisation is not allowed to receive summaries,
// the request is retried once without them.

import type { AdapterContext } from './registry.js';
import { parseSse, request, resolveHeaders, TtlCache } from './http.js';
import type { ChatMessage, ChatRequest, ModelCapabilities, ModelInfo, Provider, ReasoningEffort, StreamEvent, Usage } from './types.js';
import { ProviderError } from './types.js';

const NON_CHAT = /embedding|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|davinci|babbage|search|computer-use|sora/i;

/** Model capabilities from the id alone (OpenAI's model list has none). */
export function guessOpenAICaps(id: string): ModelCapabilities {
  const reasoning = /^(o\d|gpt-5|gpt-6|codex)/i.test(id) && !/chat-latest/i.test(id);
  const images = /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|gpt-6|o1(?!-mini)|o3|o4|chatgpt)/i.test(id) ? true : /gpt-3\.5/i.test(id) ? false : 'unknown';
  return {
    images,
    reasoning,
    reasoningEfforts: reasoning ? (['low', 'medium', 'high'] as ReasoningEffort[]) : [],
  };
}

/**
 * With `store: false` the API keeps nothing, so reasoning can only carry over
 * to the next turn if the client sends it back. A reasoning output item is
 * kept whole (id, encrypted content, summary) as the reasoning part's opaque
 * signature, and replayed as it came.
 */
interface EncryptedReasoning {
  id: string;
  encrypted_content: string;
  summary: unknown[];
}

export function reasoningSignature(item: Record<string, unknown> | undefined): string | undefined {
  if (!item || item.type !== 'reasoning' || typeof item.encrypted_content !== 'string' || typeof item.id !== 'string') return undefined;
  const kept: EncryptedReasoning = { id: item.id, encrypted_content: item.encrypted_content, summary: Array.isArray(item.summary) ? item.summary : [] };
  return JSON.stringify(kept);
}

function reasoningItem(signature: string | undefined): Record<string, unknown> | undefined {
  if (!signature) return undefined;
  try {
    const j = JSON.parse(signature) as Partial<EncryptedReasoning>;
    if (typeof j.id !== 'string' || typeof j.encrypted_content !== 'string') return undefined;
    return { type: 'reasoning', id: j.id, summary: Array.isArray(j.summary) ? j.summary : [], encrypted_content: j.encrypted_content };
  } catch {
    return undefined;
  }
}

export function toResponsesInput(msgs: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      // Encrypted reasoning from this model goes back verbatim, ahead of the
      // reply it led to (toChatMessages keeps it only for the same model).
      for (const p of m.content) {
        const item = p.type === 'reasoning' ? reasoningItem(p.signature) : undefined;
        if (item) out.push(item);
      }
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (text) out.push({ role: 'assistant', content: text });
      continue;
    }
    const parts: unknown[] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ type: 'input_text', text: p.text });
      else if (p.type === 'file') parts.push({ type: 'input_text', text: `<file name="${p.name}">\n${p.text}\n</file>` });
      else if (p.type === 'image' && p.data) parts.push({ type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` });
    }
    out.push({ role: 'user', content: parts.length ? parts : [{ type: 'input_text', text: '(empty)' }] });
  }
  return out;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export function usageFromResponses(u: ResponsesUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: u.input_tokens !== undefined ? u.input_tokens - cached : undefined,
    outputTokens: u.output_tokens,
    cacheReadTokens: cached || undefined,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens,
  };
}

/** Parse a Responses API event stream into neutral events. */
export async function* parseResponsesStream(body: AsyncIterable<Uint8Array>, providerName: string): AsyncGenerator<StreamEvent> {
  let stop: string | undefined;
  let lastSummaryPart = -1;
  for await (const ev of parseSse(body)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (j.type as string | undefined) ?? ev.event;
    switch (type) {
      case 'response.output_text.delta':
        yield { type: 'text', text: String(j.delta ?? '') };
        break;
      case 'response.reasoning_summary_text.delta': {
        const idx = Number(j.summary_index ?? 0) + Number(j.output_index ?? 0) * 1000;
        if (lastSummaryPart >= 0 && idx !== lastSummaryPart) yield { type: 'reasoning', text: '\n\n' };
        lastSummaryPart = idx;
        yield { type: 'reasoning', text: String(j.delta ?? '') };
        break;
      }
      case 'response.reasoning_text.delta':
        yield { type: 'reasoning', text: String(j.delta ?? '') };
        break;
      case 'response.output_item.done': {
        const signature = reasoningSignature(j.item as Record<string, unknown> | undefined);
        if (signature) yield { type: 'reasoning_block', signature };
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = j.response as { usage?: ResponsesUsage; incomplete_details?: { reason?: string }; status?: string } | undefined;
        const u = usageFromResponses(r?.usage);
        if (u) yield { type: 'usage', usage: u };
        stop = type === 'response.incomplete' ? (r?.incomplete_details?.reason ?? 'incomplete') : 'end_turn';
        if (stop === 'max_output_tokens') stop = 'max_tokens';
        break;
      }
      case 'response.failed': {
        const r = j.response as { error?: { message?: string; code?: string } } | undefined;
        const msg = r?.error?.message ?? 'the response failed';
        const code = r?.error?.code ?? '';
        throw new ProviderError(/rate_limit/.test(code) ? 'rate_limit' : /server|overloaded/.test(code) ? 'server' : 'unknown', `${providerName}: ${msg}`, {
          retryable: /rate_limit|server_error|overloaded/.test(code),
          providerMessage: msg,
        });
      }
      case 'error': {
        const e = (j.error as { message?: string; code?: string } | undefined) ?? (j as { message?: string; code?: string });
        const msg = e.message ?? 'stream error';
        throw new ProviderError(/context|too long/i.test(msg) ? 'context_overflow' : 'server', `${providerName}: ${msg}`, {
          retryable: /server_error|overloaded|rate_limit/.test(String(e.code ?? '')),
          providerMessage: msg,
        });
      }
      default:
        break;
    }
  }
  yield { type: 'done', stopReason: stop };
}

export class OpenAIProvider implements Provider {
  readonly type = 'openai' as const;
  readonly name: string;
  readonly endpoint: string;
  private models = new TtlCache<string[]>(5 * 60_000);
  private noSummaries = false;

  constructor(private readonly ctx: AdapterContext) {
    this.name = ctx.config.name;
    this.endpoint = ctx.config.baseUrl ?? 'https://api.openai.com/v1';
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.ctx.key.key ? { authorization: `Bearer ${this.ctx.key.key}` } : {}),
      ...resolveHeaders(this.ctx.config.headers),
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const ids = await this.models.get(async () => {
      const res = await request({ url: `${this.endpoint}/models`, method: 'GET', headers: this.headers(), signal, providerName: this.name });
      const j = (await res.json()) as { data?: Array<{ id: string; created?: number }> };
      return (j.data ?? [])
        .filter((m) => !NON_CHAT.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id);
    });
    return ids.map((id) => ({ id, capabilities: guessOpenAICaps(id) }));
  }

  async capabilities(model: string): Promise<ModelCapabilities> {
    return guessOpenAICaps(model);
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const caps = guessOpenAICaps(req.model);
    const s = req.sampling;
    const build = (summaries: boolean) => {
      const body: Record<string, unknown> = {
        model: req.model,
        input: toResponsesInput(req.messages),
        stream: true,
        store: false,
      };
      if (req.system) body.instructions = req.system;
      if (s.maxTokens !== undefined) body.max_output_tokens = Math.max(16, s.maxTokens);
      if (s.temperature !== undefined) body.temperature = s.temperature;
      if (s.topP !== undefined) body.top_p = s.topP;
      if (caps.reasoning || req.reasoningEffort) {
        const reasoning: Record<string, unknown> = {};
        if (req.reasoningEffort && req.reasoningEffort !== 'off') reasoning.effort = req.reasoningEffort;
        if (summaries) reasoning.summary = 'auto';
        if (Object.keys(reasoning).length) body.reasoning = reasoning;
        // Stateless (store: false): ask for the encrypted reasoning so it can
        // be sent back next turn. Newer models include it by default.
        body.include = ['reasoning.encrypted_content'];
      }
      if (s.extraBody) Object.assign(body, s.extraBody);
      return body;
    };
    yield { type: 'status', status: 'connecting' };
    let res: Response;
    try {
      res = await request({ url: `${this.endpoint}/responses`, headers: this.headers(), body: build(caps.reasoning === true && !this.noSummaries), signal: req.signal, providerName: this.name });
    } catch (e) {
      // Organisations that are not verified cannot receive reasoning
      // summaries; fall back to plain reasoning without them.
      if (e instanceof ProviderError && e.kind === 'bad_request' && /summar/i.test(e.message) && !this.noSummaries) {
        this.noSummaries = true;
        res = await request({ url: `${this.endpoint}/responses`, headers: this.headers(), body: build(false), signal: req.signal, providerName: this.name });
      } else throw e;
    }
    yield { type: 'status', status: 'waiting' };
    if (!res.body) throw new ProviderError('server', `${this.name} returned an empty response`);
    try {
      yield* parseResponsesStream(res.body as unknown as AsyncIterable<Uint8Array>, this.name);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (req.signal.aborted) throw new ProviderError('aborted', 'Request cancelled');
      throw new ProviderError('network', `The connection to ${this.name} was lost mid-response.`, { retryable: false });
    }
  }
}
