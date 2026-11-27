// Anthropic Messages API via the official SDK (loaded lazily). Streaming,
// adaptive/extended thinking with visible summaries, effort, image input and
// prompt caching on the conversation prefix. Retries are done by the session
// (so they are visible), so the SDK's own retries are disabled.

import type Anthropic from '@anthropic-ai/sdk';
import type { AdapterContext } from './registry.js';
import { getFetch, httpError, networkError, resolveHeaders, TtlCache } from './http.js';
import { debug } from '../debug.js';
import { cleanText } from '../render/clean.js';
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
    // "true when the model accepts at least one version of that tool".
    webSearch: c ? supported(c, 'server_tools', 'web_search') : 'unknown',
    searchLimit: true,
    adaptive,
    budget,
  };
}

// ------------------------------------------------------------- web search
//
// Claude's web search runs on Anthropic's servers (a "server tool"). Its
// rules, from the documentation (read 2026-11-27):
// - the reply's content blocks, with each result's encrypted_content and
//   each citation's encrypted_index, must be sent back exactly as received,
//   or the request fails with a 400;
// - a server_tool_use block without its result is rejected, except when a
//   paused turn (stop_reason "pause_turn") is continued with the response
//   added unchanged and no user message after it;
// - thinking blocks are bound to the request they were made for, tools
//   included: after the tool list changes, earlier thinking must be left
//   out (the newest models answer 400 otherwise).
//
// So the adapter keeps every reply made with the tool declared as it came
// (the session stores it as opaque provider data), and from the first such
// reply on it keeps the tool declared in that conversation. With web search
// off the tool stays declared with tool_choice "none": nothing is searched,
// and the tool list, the thinking and the prompt cache stay valid.

/** The tool version every model and platform accepts; Claude searches
 * directly (no code execution involved). */
const SEARCH_TOOL = 'web_search_20250305';
/** How often a paused turn is continued before the reply ends as it is. */
const MAX_CONTINUATIONS = 3;

type Block = Record<string, unknown> & { type: string };

/** What goes into a reply's provider data: the content of each response of
 * the turn (several when the turn paused), as received. */
interface Kept {
  v: 1;
  turns: Block[][];
}

export function parseKept(data: string): Kept | undefined {
  try {
    const j = JSON.parse(data) as Partial<Kept>;
    if (j.v !== 1 || !Array.isArray(j.turns) || !j.turns.length) return undefined;
    for (const t of j.turns) if (!Array.isArray(t) || t.some((b) => !b || typeof b !== 'object' || typeof b.type !== 'string')) return undefined;
    return j as Kept;
  } catch {
    return undefined;
  }
}

const isThinking = (b: { type: string }) => b.type === 'thinking' || b.type === 'redacted_thinking';

/** A kept reply as plain text: its text, then the pages it cites. For when
 * the kept blocks cannot be sent (search is unavailable, or was refused). */
function keptAsText(kept: Kept): string {
  let text = '';
  const cited = new Map<string, string>();
  for (const turn of kept.turns) {
    for (const b of turn) {
      if (b.type !== 'text') continue;
      text += typeof b.text === 'string' ? b.text : '';
      for (const c of Array.isArray(b.citations) ? (b.citations as Array<Record<string, unknown>>) : []) {
        if (typeof c.url === 'string' && /^https?:\/\//i.test(c.url) && !cited.has(c.url) && cited.size < 10) cited.set(c.url, typeof c.title === 'string' ? cleanText(c.title) : '');
      }
    }
  }
  if (cited.size) text += `\n\nSources:\n${[...cited].map(([url, title], i) => `${i + 1}. ${title ? `${title}: ` : ''}${url}`).join('\n')}`;
  return text;
}

const SEARCH_ERRORS: Record<string, string> = {
  too_many_requests: 'the search service is rate limited right now',
  max_uses_exceeded: 'the limit of searches for one reply was reached',
  query_too_long: 'the search query was too long',
  invalid_tool_input: 'the model asked for a search the service did not understand',
  request_too_large: 'the search request was too large',
  unavailable: 'the search service is unavailable right now',
};

export interface MessageOptions {
  /** The web search tool is declared in this request. */
  declared?: boolean;
  /** Send kept replies as plain text (their blocks were refused). */
  plain?: boolean;
  /** Leave every thinking block out. */
  noThinking?: boolean;
}

/** Does the history hold a reply of this provider and model that was made
 * with the web search tool declared? */
export function hasKept(msgs: ChatMessage[], provider: string, model: string): boolean {
  return msgs.some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'provider_data' && p.provider === provider && p.model === model && !!parseKept(p.data)));
}

/** Convert neutral messages to Anthropic message params. */
export function toAnthropicMessages(msgs: ChatMessage[], provider: string, model: string, opts: MessageOptions = {}): Anthropic.MessageParam[] {
  return msgs.flatMap((m): Anthropic.MessageParam[] => {
    // A reply made with the search tool declared goes back as it came. (A
    // message that somehow holds two of them is sent as its text.)
    const data = m.role === 'assistant' ? m.content.filter((p) => p.type === 'provider_data' && p.provider === provider && p.model === model) : [];
    const kept = data.length === 1 && data[0]!.type === 'provider_data' ? parseKept(data[0]!.data) : undefined;
    if (kept && opts.declared && !opts.plain) {
      return kept.turns.map((turn) => ({ role: 'assistant' as const, content: (opts.noThinking ? turn.filter((b) => !isThinking(b)) : turn) as unknown as Anthropic.ContentBlockParam[] })).filter((t) => t.content.length);
    }
    if (kept) return [{ role: 'assistant', content: [{ type: 'text', text: keptAsText(kept) || '(empty)' }] }];
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const p of m.content) {
      // Thinking from a reply made without the tool is not valid in a
      // request that declares it.
      if (p.type === 'reasoning' && (opts.declared || opts.noThinking)) continue;
      const b = toBlock(p, provider, model, m.role);
      if (b) blocks.push(b);
    }
    // Thinking blocks must lead an assistant turn.
    blocks.sort((a, b) => Number(b.type === 'thinking' || b.type === 'redacted_thinking') - Number(a.type === 'thinking' || a.type === 'redacted_thinking'));
    if (!blocks.length) blocks.push({ type: 'text', text: '(empty)' });
    return [{ role: m.role, content: blocks }];
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
    default:
      // Web search parts never reach an adapter as they are (toChatMessages).
      return null;
  }
}

export class AnthropicProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly name: string;
  readonly endpoint: string;
  private client?: Promise<Anthropic>;
  /** Web search was refused for this account or model: never declare it. */
  private searchRefused = new Set<string>();
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
    const base: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      stream: true,
      // Cache the conversation prefix (the last cacheable block).
      cache_control: { type: 'ephemeral' },
    };
    if (req.system) base.system = req.system;
    if (caps?.adaptive) {
      base.thinking = { type: 'adaptive', display: 'summarized' };
    } else if (caps?.budget && req.reasoningEffort && req.reasoningEffort !== 'off') {
      const budget = { minimal: 1024, low: 2048, medium: 8192, high: 16_000, xhigh: 24_000, max: 32_000 }[req.reasoningEffort];
      base.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
    }
    if (req.reasoningEffort && req.reasoningEffort !== 'off' && caps?.reasoningEfforts.includes(req.reasoningEffort)) {
      base.output_config = { effort: req.reasoningEffort };
    }
    if (s.temperature !== undefined) base.temperature = s.temperature;
    if (s.topP !== undefined) base.top_p = s.topP;
    if (s.topK !== undefined) base.top_k = s.topK;

    // The search tool is declared when search is wanted, and from then on in
    // that conversation (see the notes at the top of the web search part).
    let declared = !this.searchRefused.has(req.model) && (!!req.webSearch || hasKept(req.messages, this.name, req.model));
    let plain = false;
    let noThinking = false;
    /** The responses of this turn so far, as received (several if it paused). */
    const turns: Block[][] = [];
    const build = (): Record<string, unknown> => {
      const messages = toAnthropicMessages(req.messages, this.name, req.model, { declared, plain, noThinking });
      // Continuing a paused turn: its responses go back unchanged, with no
      // user message after them.
      for (const t of turns) messages.push({ role: 'assistant', content: t as unknown as Anthropic.ContentBlockParam[] });
      const body: Record<string, unknown> = { ...base, messages };
      if (declared) {
        body.tools = [{ type: SEARCH_TOOL, name: 'web_search', ...(req.webSearch?.maxUses ? { max_uses: req.webSearch.maxUses } : {}) }];
        if (!req.webSearch) body.tool_choice = { type: 'none' };
      }
      if (s.extraBody) Object.assign(body, s.extraBody);
      return body;
    };

    yield { type: 'status', status: 'connecting' };
    const usage: Usage = {};
    let stopReason: string | undefined;
    let outputBefore = 0;
    let searchesBefore = 0;
    for (let round = 0; ; round++) {
      let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
      for (;;) {
        const body = build();
        debug('anthropic request', { model: req.model, max_tokens: maxTokens, thinking: body.thinking, effort: body.output_config, tools: body.tools, tool_choice: body.tool_choice, round });
        try {
          stream = (await client.messages.create(body as unknown as Anthropic.MessageCreateParamsStreaming, { signal: req.signal })) as unknown as AsyncIterable<Anthropic.RawMessageStreamEvent>;
          break;
        } catch (e) {
          const err = await this.mapError(e, req.signal);
          // A request that is refused before anything was produced may be
          // one this adapter can put right, once for each cause.
          if (err.kind !== 'bad_request' || round > 0) throw err;
          const why = `${err.message} ${err.providerMessage ?? ''}`;
          if (declared && !plain && /encrypted_content|encrypted_index|decrypt/i.test(why)) {
            // Kept search results can no longer be read (another
            // organization's key, say): send those replies as text.
            debug('anthropic refused kept search results; sending those replies as text', { message: err.message });
            plain = true;
            noThinking = true;
            continue;
          }
          if (declared && /web[_ ]search/i.test(why)) {
            // Web search is not available to this account or model.
            this.searchRefused.add(req.model);
            if (req.webSearch) throw new ProviderError('search_unavailable', err.message, { status: err.status, providerMessage: err.providerMessage });
            declared = false;
            noThinking = true;
            continue;
          }
          if (!noThinking && /thinking|signature|bound to a different conversation/i.test(why) && JSON.stringify(body.messages).includes('"thinking"')) {
            // Earlier thinking no longer fits this request: leave it out.
            debug('anthropic refused replayed thinking; retrying without it', { message: err.message });
            noThinking = true;
            continue;
          }
          throw err;
        }
      }
      if (round === 0) yield { type: 'status', status: 'waiting' };

      const blocks = new Map<number, Block & { json?: string }>();
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
              const b = structuredClone(ev.content_block) as unknown as Block;
              blocks.set(ev.index, b);
              if (b.type === 'text' && typeof b.text === 'string' && b.text) yield { type: 'text', text: b.text };
              else if (b.type === 'server_tool_use' && b.name === 'web_search') yield { type: 'search', id: String(b.id), status: 'started' };
              else if (b.type === 'web_search_tool_result') {
                // The result arrives whole. A list: the pages found. An
                // object: the search failed (the HTTP status is still 200).
                const id = String(b.tool_use_id);
                if (Array.isArray(b.content)) {
                  yield { type: 'search', id, status: 'done' };
                  for (const r of b.content as Array<Record<string, unknown>>) {
                    if (typeof r.url === 'string') yield { type: 'source', url: r.url, title: typeof r.title === 'string' ? r.title : '', cite: 'none' };
                  }
                } else {
                  const code = String((b.content as { error_code?: unknown } | null)?.error_code ?? 'unknown');
                  yield { type: 'search', id, status: 'failed', error: SEARCH_ERRORS[code] ?? `the search failed (${code})` };
                }
              }
              break;
            }
            case 'content_block_delta': {
              const d = ev.delta as unknown as Record<string, unknown> & { type: string };
              const b = blocks.get(ev.index);
              if (d.type === 'text_delta') {
                if (b) b.text = String(b.text ?? '') + String(d.text);
                yield { type: 'text', text: String(d.text) };
              } else if (d.type === 'thinking_delta') {
                if (b) b.thinking = String(b.thinking ?? '') + String(d.thinking);
                yield { type: 'reasoning', text: String(d.thinking) };
              } else if (d.type === 'signature_delta') {
                if (b) b.signature = String(b.signature ?? '') + String(d.signature);
              } else if (d.type === 'input_json_delta') {
                if (b) b.json = (b.json ?? '') + String(d.partial_json ?? '');
              } else if (d.type === 'citations_delta') {
                if (b) b.citations = [...(Array.isArray(b.citations) ? b.citations : []), d.citation];
              }
              break;
            }
            case 'content_block_stop': {
              const b = blocks.get(ev.index);
              if (!b) break;
              if (b.type === 'thinking' || b.type === 'redacted_thinking') {
                yield { type: 'reasoning_block', signature: typeof b.signature === 'string' && b.signature ? b.signature : undefined, redacted: typeof b.data === 'string' ? b.data : undefined };
              } else if (b.type === 'server_tool_use') {
                // The input streamed as JSON text: now the query is known.
                if (b.json) {
                  try {
                    b.input = JSON.parse(b.json) as unknown;
                  } catch {
                    /* keep the input as it started */
                  }
                }
                delete b.json;
                const query = (b.input as { query?: unknown } | undefined)?.query;
                if (b.name === 'web_search' && typeof query === 'string') yield { type: 'search', id: String(b.id), status: 'started', query };
              } else if (b.type === 'text' && Array.isArray(b.citations)) {
                // The text of this block rests on these pages.
                for (const c of b.citations as Array<Record<string, unknown>>) {
                  if (c?.type === 'web_search_result_location' && typeof c.url === 'string') {
                    yield { type: 'source', url: c.url, title: typeof c.title === 'string' ? c.title : '', snippet: typeof c.cited_text === 'string' ? c.cited_text : undefined, cite: 'mark' };
                  }
                }
              }
              break;
            }
            case 'message_delta': {
              stopReason = ev.delta.stop_reason ?? stopReason;
              usage.outputTokens = outputBefore + ev.usage.output_tokens;
              if (ev.usage.input_tokens != null) usage.inputTokens = ev.usage.input_tokens;
              const searched = (ev.usage as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use?.web_search_requests;
              if (typeof searched === 'number') usage.searches = searchesBefore + searched;
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
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      for (const b of content) delete b.json;
      turns.push(content);
      // The server stopped its search loop early; the turn is not over.
      // Ask it to go on, a few times at most.
      if (stopReason !== 'pause_turn' || round >= MAX_CONTINUATIONS) break;
      outputBefore = usage.outputTokens ?? outputBefore;
      searchesBefore = usage.searches ?? searchesBefore;
    }

    // What later turns must send back unchanged. Only for a turn that is
    // whole: a search call without its result would be refused.
    if (declared && stopReason !== 'pause_turn') {
      const all = turns.flat();
      const answered = new Set(all.filter((b) => b.type === 'web_search_tool_result').map((b) => b.tool_use_id));
      if (all.every((b) => b.type !== 'server_tool_use' || answered.has(b.id))) {
        yield { type: 'provider_data', data: JSON.stringify({ v: 1, turns } satisfies Kept) };
      }
    }
    yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }
}
