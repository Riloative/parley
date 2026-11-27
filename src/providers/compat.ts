// Generic OpenAI-compatible adapter (/chat/completions). Covers Mistral,
// llama.cpp's server, Ollama, LM Studio, OpenRouter, Groq, vLLM and others.
// Deliberately tolerant: optional fields are retried without when a server
// rejects them, usage may be missing, reasoning arrives under several names
// (or inside <think> tags), and model lists or context sizes may be absent.

import type { AdapterContext } from './registry.js';
import { getFetch, parseSse, request, resolveHeaders, TtlCache } from './http.js';
import { debug } from '../debug.js';
import type { ChatMessage, ChatRequest, ModelCapabilities, ModelInfo, Provider, ReasoningEffort, StreamEvent, Usage } from './types.js';
import { ProviderError } from './types.js';

interface CompatModel {
  id: string;
  contextWindow?: number;
  images?: boolean;
  reasoning?: boolean;
  efforts?: ReasoningEffort[];
  /** The model list says whether the model can search (Venice). */
  webSearch?: boolean;
}

// ------------------------------------------------------------- web search
//
// Chat completions has no standard for provider-run web search. taria
// knows three services whose documentation (read 2026-11-27) describes both
// how to turn it on and how the sources come back:
//
// - DeepSeek: `tools: [{ type: "deepseek_web_search" }]`. Progress arrives
//   in `server_tool_event` next to `delta` (call_started, call_completed
//   with sources); the last chunk's delta carries `annotations` and the
//   whole `server_tool_calls`, which later requests should pass back
//   unchanged. No limit on searches; they are not billed.
// - Venice: `venice_parameters: { enable_web_search: "auto",
//   include_search_results_in_stream: true }`. The pages found come as
//   `venice_parameters.web_search_citations` in one chunk (the first or the
//   last: its pages disagree). Labelled experimental. No limit.
// - OpenRouter: `tools: [{ type: "openrouter:web_search", parameters: {
//   max_uses } }]`. Citations are `annotations[].url_citation` on the
//   message; where they sit in a stream is not documented, so any chunk is
//   accepted. `usage.server_tool_use_details.web_search_requests` counts.
//
// Which one a provider speaks is read from its address, or set with
// `web_search_style` in its config. Any other server gets no search.

export type SearchStyle = 'deepseek' | 'venice' | 'openrouter';
export const SEARCH_STYLES: SearchStyle[] = ['deepseek', 'venice', 'openrouter'];

export function searchStyleOf(baseUrl: string | undefined, configured?: string): SearchStyle | undefined {
  if (configured === 'none') return undefined;
  if (configured && (SEARCH_STYLES as string[]).includes(configured)) return configured as SearchStyle;
  let host = '';
  try {
    host = new URL(baseUrl ?? '').hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.venice.ai') return 'venice';
  if (host === 'openrouter.ai') return 'openrouter';
  return undefined;
}

/** DeepSeek's `server_tool_calls` of a reply, to pass back unchanged. */
interface KeptCalls {
  v: 1;
  server_tool_calls: unknown[];
}

function parseKeptCalls(data: string): KeptCalls | undefined {
  try {
    const j = JSON.parse(data) as Partial<KeptCalls>;
    return j.v === 1 && Array.isArray(j.server_tool_calls) && j.server_tool_calls.length ? (j as KeptCalls) : undefined;
  } catch {
    return undefined;
  }
}

const isWebUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

/** What a DeepSeek call did, in words. */
function actionText(action: unknown): string | undefined {
  const a = (action ?? {}) as { type?: string; queries?: unknown; url?: unknown; pattern?: unknown };
  if (Array.isArray(a.queries) && a.queries.length) return a.queries.filter((q) => typeof q === 'string').join(' · ');
  if ((a.type === 'open_page' || a.type === 'read_link') && typeof a.url === 'string') return `reading ${a.url}`;
  if (a.type === 'find_in_page' && typeof a.pattern === 'string') return `looking for "${a.pattern}" in a page`;
  return undefined;
}

export function toChatCompletionMessages(msgs: ChatMessage[], system?: string, opts: { keptCalls?: boolean } = {}): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of msgs) {
    const hasImage = m.content.some((p) => p.type === 'image' && p.data);
    if (m.role === 'assistant' || !hasImage) {
      // Plain string content is the most widely supported form.
      const text = m.content
        .map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `<file name="${p.name}">\n${p.text}\n</file>\n` : ''))
        .join('');
      // DeepSeek: a reply that searched goes back with its calls unchanged.
      const data = opts.keptCalls && m.role === 'assistant' ? m.content.filter((p) => p.type === 'provider_data') : [];
      const kept = data.length === 1 && data[0]!.type === 'provider_data' ? parseKeptCalls(data[0]!.data) : undefined;
      out.push({ role: m.role, content: text || '(empty)', ...(kept ? { server_tool_calls: kept.server_tool_calls } : {}) });
      continue;
    }
    const parts: unknown[] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ type: 'text', text: p.text });
      else if (p.type === 'file') parts.push({ type: 'text', text: `<file name="${p.name}">\n${p.text}\n</file>` });
      else if (p.type === 'image' && p.data) parts.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
    }
    out.push({ role: 'user', content: parts });
  }
  return out;
}

/** Splits `<think>…</think>` at the start of the content into reasoning. */
export class ThinkTagSplitter {
  private state: 'start' | 'think' | 'text' = 'start';
  private buf = '';

  push(chunk: string): Array<{ kind: 'text' | 'reasoning'; text: string }> {
    const out: Array<{ kind: 'text' | 'reasoning'; text: string }> = [];
    this.buf += chunk;
    for (;;) {
      if (this.state === 'start') {
        const t = this.buf.replace(/^\s+/, '');
        if (!t) return out;
        if ('<think>'.startsWith(t)) return out; // could still become <think>
        if (t.startsWith('<think>')) {
          this.buf = t.slice('<think>'.length);
          this.state = 'think';
          continue;
        }
        this.state = 'text';
        continue;
      }
      if (this.state === 'think') {
        const end = this.buf.indexOf('</think>');
        if (end < 0) {
          // Keep a possible partial closing tag.
          const keep = Math.min(this.buf.length, 7);
          const tail = this.buf.slice(-keep);
          const partial = [...Array(keep).keys()].map((i) => tail.slice(i)).find((s) => '</think>'.startsWith(s) && s.length > 0);
          const emit = partial ? this.buf.slice(0, this.buf.length - partial.length) : this.buf;
          if (emit) out.push({ kind: 'reasoning', text: emit });
          this.buf = partial ?? '';
          return out;
        }
        if (end > 0) out.push({ kind: 'reasoning', text: this.buf.slice(0, end) });
        this.buf = this.buf.slice(end + '</think>'.length).replace(/^\s+/, '');
        this.state = 'text';
        continue;
      }
      if (this.buf) out.push({ kind: 'text', text: this.buf });
      this.buf = '';
      return out;
    }
  }

  flush(): Array<{ kind: 'text' | 'reasoning'; text: string }> {
    const b = this.buf;
    this.buf = '';
    if (!b) return [];
    return [{ kind: this.state === 'think' ? 'reasoning' : 'text', text: b }];
  }
}

interface ChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

function usageOf(u: ChunkUsage | undefined | null): Usage | undefined {
  if (!u || (u.prompt_tokens === undefined && u.completion_tokens === undefined)) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: u.prompt_tokens !== undefined ? u.prompt_tokens - cached : undefined,
    outputTokens: u.completion_tokens,
    cacheReadTokens: cached || undefined,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? undefined,
  };
}

/** Parse a chat-completions event stream into neutral events. */
export async function* parseChatStream(body: AsyncIterable<Uint8Array>, providerName: string): AsyncGenerator<StreamEvent> {
  const think = new ThinkTagSplitter();
  let stop: string | undefined;
  let usage: Usage | undefined;
  let sawReasoningField = false;
  let searches: number | undefined;
  let searched = false;
  let veniceSeen = false;
  let kept: unknown[] | undefined;
  const citedUrls = new Set<string>();
  for await (const ev of parseSse(body)) {
    const data = ev.data.trim();
    if (!data) continue;
    if (data === '[DONE]') break;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.error) {
      const e = j.error as { message?: string; code?: unknown } | string;
      const msg = typeof e === 'string' ? e : (e.message ?? JSON.stringify(e));
      throw new ProviderError(/context|too long|n_ctx/i.test(msg) ? 'context_overflow' : 'server', `${providerName}: ${msg}`, { providerMessage: msg });
    }
    const u = usageOf((j.usage as ChunkUsage | undefined) ?? (j.x_groq as { usage?: ChunkUsage } | undefined)?.usage);
    if (u) usage = u;
    const timings = j.timings as { predicted_n?: number; prompt_n?: number; cache_n?: number } | undefined;
    if (timings && !usage) {
      usage = { inputTokens: timings.prompt_n, outputTokens: timings.predicted_n, cacheReadTokens: timings.cache_n || undefined };
    }
    // Web search, in whichever of the known forms it arrives.
    // Venice: the pages found, in one chunk.
    const found = (j.venice_parameters as { web_search_citations?: unknown } | undefined)?.web_search_citations;
    if (Array.isArray(found) && found.length && !veniceSeen) {
      veniceSeen = true;
      searched = true;
      yield { type: 'search', id: 'web-search', status: 'done' };
      for (const s of found as Array<Record<string, unknown>>) {
        if (isWebUrl(s?.url)) yield { type: 'source', url: s.url, title: typeof s.title === 'string' ? s.title : '', snippet: typeof s.content === 'string' ? s.content : undefined, cite: 'none' };
      }
    }
    // OpenRouter and DeepSeek report how many searches ran.
    const counted = (j.usage as { server_tool_use_details?: { web_search_requests?: unknown }; server_tool_use?: { tool_search?: unknown } } | undefined) ?? {};
    const n = counted.server_tool_use_details?.web_search_requests ?? counted.server_tool_use?.tool_search;
    if (typeof n === 'number') searches = n;
    const choices = (j.choices as Array<Record<string, unknown>> | undefined) ?? [];
    for (const c of choices) {
      const delta = (c.delta ?? c.message ?? {}) as Record<string, unknown>;
      // DeepSeek: the progress of a call, next to the delta.
      const tool = c.server_tool_event as { type?: string; call?: Record<string, unknown> } | undefined;
      if (tool?.call && typeof tool.call.id === 'string' && (tool.type === 'call_started' || tool.type === 'call_completed')) {
        const call = tool.call;
        const id = String(call.id);
        const query = actionText(call.action);
        searched = true;
        if (tool.type === 'call_started') {
          yield { type: 'search', id, status: 'started', ...(query ? { query } : {}) };
        } else if (call.status === 'failed') {
          const code = (call.error as { code?: unknown } | undefined)?.code;
          yield { type: 'search', id, status: 'failed', ...(query ? { query } : {}), error: typeof code === 'string' ? `the search did not succeed (${code})` : 'the search did not succeed' };
        } else {
          yield { type: 'search', id, status: 'done', ...(query ? { query } : {}) };
          for (const s of Array.isArray(call.sources) ? (call.sources as Array<Record<string, unknown>>) : []) {
            if (isWebUrl(s?.url)) yield { type: 'source', url: s.url, title: typeof s.title === 'string' ? s.title : '', snippet: typeof s.snippet === 'string' ? s.snippet : undefined, cite: 'none' };
          }
        }
      }
      // Citations (OpenRouter, DeepSeek): url_citation annotations on the
      // delta or the message, usually in the last chunk. Their positions
      // are known only when the text is complete, so they are listed.
      const notes = delta.annotations ?? (c.message as { annotations?: unknown } | undefined)?.annotations;
      for (const a of Array.isArray(notes) ? (notes as Array<Record<string, unknown>>) : []) {
        const u = (a?.type === 'url_citation' ? (a.url_citation ?? a) : undefined) as { url?: unknown; title?: unknown; content?: unknown } | undefined;
        if (!u || !isWebUrl(u.url) || citedUrls.has(u.url)) continue;
        citedUrls.add(u.url);
        // DeepSeek: "title is the URL when the title is unknown".
        const title = typeof u.title === 'string' && u.title !== u.url ? u.title : '';
        yield { type: 'source', url: u.url, title, snippet: typeof u.content === 'string' ? u.content : undefined, cite: 'list' };
      }
      // DeepSeek: the calls of the whole reply, to pass back next turn.
      if (Array.isArray(delta.server_tool_calls) && delta.server_tool_calls.length) kept = delta.server_tool_calls;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === 'string' && r) {
        sawReasoningField = true;
        yield { type: 'reasoning', text: r };
      } else if (Array.isArray(delta.reasoning_details)) {
        for (const d of delta.reasoning_details as Array<{ type?: string; text?: string; summary?: string }>) {
          const t = d.text ?? d.summary;
          if (t) {
            sawReasoningField = true;
            yield { type: 'reasoning', text: t };
          }
        }
      }
      const content = delta.content;
      if (typeof content === 'string' && content) {
        for (const piece of sawReasoningField ? [{ kind: 'text' as const, text: content }] : think.push(content)) {
          yield piece.kind === 'text' ? { type: 'text', text: piece.text } : { type: 'reasoning', text: piece.text };
        }
      } else if (Array.isArray(content)) {
        // Mistral: [{type:"thinking", thinking:[{type:"text",text}]}, {type:"text",text}]
        for (const part of content as Array<Record<string, unknown>>) {
          if (part.type === 'thinking') {
            const inner = part.thinking;
            const t = Array.isArray(inner) ? inner.map((x: { text?: string }) => x.text ?? '').join('') : typeof inner === 'string' ? inner : '';
            if (t) yield { type: 'reasoning', text: t };
          } else if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            yield { type: 'text', text: part.text };
          }
        }
      }
      if (typeof c.finish_reason === 'string' && c.finish_reason) {
        stop = c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason === 'stop' ? 'end_turn' : c.finish_reason;
        if (c.finish_reason === 'error') throw new ProviderError('server', `${providerName} reported an error mid-response.`);
      }
    }
  }
  for (const piece of think.flush()) yield piece.kind === 'text' ? { type: 'text', text: piece.text } : { type: 'reasoning', text: piece.text };
  // A service that says only that it searched, or only what it cites
  // (OpenRouter): one search, so the reply shows that the web was used.
  if (!searched && (citedUrls.size > 0 || (searches ?? 0) > 0)) yield { type: 'search', id: 'web-search', status: 'done' };
  if (kept && stop !== undefined) yield { type: 'provider_data', data: JSON.stringify({ v: 1, server_tool_calls: kept } satisfies KeptCalls) };
  if (usage || searches !== undefined) yield { type: 'usage', usage: { ...(usage ?? {}), ...(searches !== undefined ? { searches } : {}) } };
  yield { type: 'done', stopReason: stop };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Pull whatever capability hints a /models entry carries. */
export function modelFromListEntry(m: Record<string, unknown>): CompatModel {
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  const arch = (m.architecture ?? {}) as { input_modalities?: string[]; modality?: string };
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  const top = (m.top_provider ?? {}) as Record<string, unknown>;
  const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
  const reasoningInfo = m.reasoning as { supported_efforts?: string[] } | undefined;
  const images =
    typeof caps.vision === 'boolean'
      ? caps.vision
      : Array.isArray(arch.input_modalities)
        ? arch.input_modalities.includes('image')
        : typeof arch.modality === 'string'
          ? arch.modality.split('->')[0]!.includes('image')
          : m.type === 'vlm'
            ? true
            : undefined;
  const reasoning = caps.reasoning !== undefined ? !!caps.reasoning : params.includes('reasoning') || params.includes('include_reasoning') ? true : undefined;
  return {
    id: String(m.id ?? m.key ?? m.name ?? ''),
    contextWindow: num(m.context_length) ?? num(m.max_context_length) ?? num(m.context_window) ?? num(m.max_model_len) ?? num(top.context_length) ?? num(meta.n_ctx_train),
    images,
    reasoning,
    // Venice: model_spec.capabilities.supportsWebSearch.
    webSearch: typeof ((m.model_spec as { capabilities?: { supportsWebSearch?: unknown } } | undefined)?.capabilities?.supportsWebSearch) === 'boolean' ? !!(m.model_spec as { capabilities: { supportsWebSearch: boolean } }).capabilities.supportsWebSearch : undefined,
    efforts: reasoningInfo?.supported_efforts?.filter((e): e is ReasoningEffort => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(e)),
  };
}

export class CompatProvider implements Provider {
  readonly type = 'openai-compatible' as const;
  readonly name: string;
  readonly endpoint: string;
  private models = new TtlCache<CompatModel[]>(60_000);
  private extra = new Map<string, Promise<Partial<CompatModel>>>();
  /** Optional request fields this server rejected; never sent again. */
  private rejected = new Set<string>();
  /** The web search this service runs itself, if taria knows its form. */
  private readonly searchStyle: SearchStyle | undefined;

  constructor(private readonly ctx: AdapterContext) {
    this.name = ctx.config.name;
    this.endpoint = ctx.config.baseUrl!;
    this.searchStyle = searchStyleOf(ctx.config.baseUrl, ctx.config.webSearchStyle);
  }

  private get origin(): string {
    try {
      return new URL(this.endpoint).origin;
    } catch {
      return this.endpoint;
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.ctx.key.key ? { authorization: `Bearer ${this.ctx.key.key}` } : {}),
      ...resolveHeaders(this.ctx.config.headers),
    };
  }

  private async fetchModels(signal?: AbortSignal): Promise<CompatModel[]> {
    const res = await request({ url: `${this.endpoint}/models`, method: 'GET', headers: this.headers(), signal, providerName: this.name });
    const j = (await res.json().catch(() => ({}))) as { data?: unknown[]; models?: unknown[] };
    const list = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []) as Array<Record<string, unknown>>;
    return list.map(modelFromListEntry).filter((m) => m.id && !/embed/i.test(m.id));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let models: CompatModel[];
    try {
      models = await this.models.get(() => this.fetchModels(signal));
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'not_found') {
        throw new ProviderError('not_found', `${this.name} has no model list endpoint. Type a model id as ${this.name}/<model-id>.`);
      }
      throw e;
    }
    return models.map((m) => ({ id: m.id, capabilities: this.capsOf(m, {}) }));
  }

  private capsOf(m: CompatModel | undefined, extra: Partial<CompatModel>): ModelCapabilities {
    const reasoning = extra.reasoning ?? m?.reasoning;
    const efforts = extra.efforts ?? m?.efforts;
    return {
      images: extra.images ?? m?.images ?? 'unknown',
      reasoning: reasoning ?? 'unknown',
      reasoningEfforts: efforts?.length ? efforts : reasoning ? ['low', 'medium', 'high'] : [],
      contextWindow: extra.contextWindow ?? m?.contextWindow,
      // A server taria knows no search form for has none. OpenRouter gives
      // it to any model; Venice says per model; DeepSeek does not say.
      webSearch: !this.searchStyle ? false : this.searchStyle === 'openrouter' ? true : (m?.webSearch ?? 'unknown'),
      searchLimit: this.searchStyle === 'openrouter',
    };
  }

  /** Server-specific probes for context size and capabilities (llama.cpp
   * /props, Ollama /api/show and /api/ps, LM Studio /api/v1/models). */
  private probeExtra(model: string): Promise<Partial<CompatModel>> {
    const cached = this.extra.get(model);
    if (cached) return cached;
    const p = (async () => {
      const f = await getFetch();
      const get = async (url: string, init?: RequestInit): Promise<unknown> => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2500);
        try {
          const r = await f(url, { ...init, headers: { ...this.headers(), ...(init?.headers ?? {}) }, signal: ac.signal });
          return r.ok ? await r.json() : undefined;
        } catch {
          return undefined;
        } finally {
          clearTimeout(t);
        }
      };
      const out: Partial<CompatModel> = {};
      // llama.cpp
      const props = (await get(`${this.origin}/props`)) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number; modalities?: { vision?: boolean } } | undefined;
      if (props && (props.default_generation_settings || props.n_ctx)) {
        out.contextWindow = num(props.default_generation_settings?.n_ctx) ?? num(props.n_ctx);
        if (typeof props.modalities?.vision === 'boolean') out.images = props.modalities.vision;
        return out;
      }
      // Ollama
      const show = (await get(`${this.origin}/api/show`, { method: 'POST', body: JSON.stringify({ model }) })) as { capabilities?: string[]; model_info?: Record<string, unknown> } | undefined;
      if (show && (show.capabilities || show.model_info)) {
        if (show.capabilities) {
          out.images = show.capabilities.includes('vision');
          out.reasoning = show.capabilities.includes('thinking');
        }
        const arch = show.model_info?.['general.architecture'];
        const trained = typeof arch === 'string' ? num(show.model_info?.[`${arch}.context_length`]) : undefined;
        const ps = (await get(`${this.origin}/api/ps`)) as { models?: Array<{ name?: string; model?: string; context_length?: number }> } | undefined;
        const loaded = ps?.models?.find((m) => m.name === model || m.model === model);
        out.contextWindow = num(loaded?.context_length) ?? trained;
        return out;
      }
      // LM Studio
      const lms = (await get(`${this.origin}/api/v1/models`)) as { models?: Array<Record<string, unknown>> } | undefined;
      const entry = lms?.models?.find((m) => m.key === model || m.id === model);
      if (entry) {
        const caps = (entry.capabilities ?? {}) as { vision?: boolean; reasoning?: unknown };
        const inst = (entry.loaded_instances as Array<{ config?: { context_length?: number } }> | undefined)?.[0];
        out.contextWindow = num(inst?.config?.context_length) ?? num(entry.max_context_length);
        if (typeof caps.vision === 'boolean') out.images = caps.vision;
        if (caps.reasoning !== undefined) out.reasoning = !!caps.reasoning;
      }
      return out;
    })();
    this.extra.set(model, p);
    return p;
  }

  async capabilities(model: string): Promise<ModelCapabilities> {
    let entry: CompatModel | undefined;
    try {
      entry = (await this.models.get(() => this.fetchModels())).find((m) => m.id === model);
    } catch {
      entry = undefined;
    }
    const extra = await this.probeExtra(model).catch(() => ({}));
    return this.capsOf(entry, extra);
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const s = req.sampling;
    // Search goes out only in a form this service is known to understand.
    const search = req.webSearch ? this.searchStyle : undefined;
    if (req.webSearch && !search) {
      throw new ProviderError('search_unavailable', `${this.name} has no web search that taria knows how to use.`, { providerMessage: 'taria knows the web search of DeepSeek, Venice and OpenRouter; set web_search_style for another address of theirs' });
    }
    const build = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toChatCompletionMessages(req.messages, req.system, { keptCalls: search === 'deepseek' }),
        stream: true,
      };
      if (search === 'deepseek') body.tools = [{ type: 'deepseek_web_search' }];
      else if (search === 'openrouter') body.tools = [{ type: 'openrouter:web_search', ...(req.webSearch?.maxUses ? { parameters: { max_uses: req.webSearch.maxUses } } : {}) }];
      else if (search === 'venice') body.venice_parameters = { enable_web_search: 'auto', enable_web_citations: false, include_search_results_in_stream: true };
      if (!this.rejected.has('stream_options')) body.stream_options = { include_usage: true };
      if (s.maxTokens !== undefined) body.max_tokens = s.maxTokens;
      if (s.temperature !== undefined) body.temperature = s.temperature;
      if (s.topP !== undefined) body.top_p = s.topP;
      if (s.topK !== undefined) body.top_k = s.topK;
      if (req.reasoningEffort && req.reasoningEffort !== 'off' && !this.rejected.has('reasoning_effort')) body.reasoning_effort = req.reasoningEffort;
      if (s.extraBody) Object.assign(body, s.extraBody);
      return body;
    };
    yield { type: 'status', status: 'connecting' };
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await request({ url: `${this.endpoint}/chat/completions`, headers: this.headers(), body: build(), signal: req.signal, providerName: this.name });
      } catch (e) {
        // Tolerate servers that reject optional fields: drop the field named
        // in the error and try again.
        if (e instanceof ProviderError && (e.kind === 'bad_request' || e.status === 422)) {
          const msg = `${e.providerMessage ?? e.message}`;
          const field = ['stream_options', 'reasoning_effort'].find((f) => msg.includes(f) && !this.rejected.has(f));
          if (field) {
            debug('compat: server rejected field, retrying without it', { provider: this.name, field });
            this.rejected.add(field);
            continue;
          }
          // The request asked for web search and was refused for it (the
          // model has none, or the account may not use it). Nothing was
          // produced: the session sends the message again without search.
          if (search && /search|tool|venice_parameters/i.test(msg)) {
            throw new ProviderError('search_unavailable', e.message, { status: e.status, providerMessage: e.providerMessage });
          }
        }
        throw e;
      }
    }
    if (!res) throw new ProviderError('bad_request', `${this.name} rejected the request.`);
    yield { type: 'status', status: 'waiting' };
    if (!res.body) throw new ProviderError('server', `${this.name} returned an empty response`);
    try {
      yield* parseChatStream(res.body as unknown as AsyncIterable<Uint8Array>, this.name);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (req.signal.aborted) throw new ProviderError('aborted', 'Request cancelled');
      throw new ProviderError('network', `The connection to ${this.name} (${this.origin}) was lost mid-response.`);
    }
  }
}
