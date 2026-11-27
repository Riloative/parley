// OpenAI via the Responses API (OpenAI's recommended endpoint for new work),
// streamed over SSE with raw fetch. Reasoning summaries are requested for
// reasoning models; if the organisation is not allowed to receive summaries,
// the request is retried once without them.

import { debug } from '../debug.js';
import { cleanText } from '../render/clean.js';
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
    // No API says which models have the web search tool. The current
    // families do; anything else is tried, and a refusal is handled.
    webSearch: /^(gpt-[5-9]|chat-latest|gpt-oss)/i.test(id) ? true : 'unknown',
    searchLimit: true,
  };
}

// ------------------------------------------------------------- web search
//
// The Responses API's web search is a hosted tool: `tools: [{ type:
// "web_search" }]`, limited by `max_tool_calls` (which counts every hosted
// tool call of the response). From the documentation, read 2026-11-27:
// - a search is an output item of type web_search_call; its query is only
//   certain in response.output_item.done (`action.query` / `action.queries`);
//   on reasoning models there are also open_page and find_in_page actions,
//   which are not billed as searches;
// - citations arrive as response.output_text.annotation.added with a
//   url_citation (url, title, character indices); the models usually also
//   write the link into the text itself;
// - "preserve every item in the response's output array" for the next
//   stateless request. Whether a reply may instead go back as plain text is
//   not documented, so the items are kept as provider data and sent back
//   unchanged while search is on; if the API refuses them, the reply goes
//   as text (once, and that is remembered).

type Item = Record<string, unknown> & { type: string };

/** A searched reply's output items, as the API returned them. */
interface Kept {
  v: 1;
  output: Item[];
}

export function parseKept(data: string): Kept | undefined {
  try {
    const j = JSON.parse(data) as Partial<Kept>;
    if (j.v !== 1 || !Array.isArray(j.output) || !j.output.length) return undefined;
    if (j.output.some((i) => !i || typeof i !== 'object' || typeof i.type !== 'string')) return undefined;
    return j as Kept;
  } catch {
    return undefined;
  }
}

/** Kept items as plain text: the message text, then the pages it cites. */
function keptAsText(kept: Kept): string {
  let text = '';
  const cited = new Map<string, string>();
  for (const item of kept.output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type !== 'output_text') continue;
      text += typeof part.text === 'string' ? part.text : '';
      for (const a of Array.isArray(part.annotations) ? (part.annotations as Array<Record<string, unknown>>) : []) {
        if (a.type === 'url_citation' && typeof a.url === 'string' && /^https?:\/\//i.test(a.url) && !cited.has(a.url) && cited.size < 10) cited.set(a.url, typeof a.title === 'string' ? cleanText(a.title) : '');
      }
    }
  }
  if (cited.size) text += `\n\nSources:\n${[...cited].map(([url, title], i) => `${i + 1}. ${title ? `${title}: ` : ''}${url}`).join('\n')}`;
  return text;
}

const isWebUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

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

export function toResponsesInput(msgs: ChatMessage[], opts: { kept?: boolean } = {}): unknown[] {
  const out: unknown[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      // A reply that searched: its output items go back as they came, in
      // order (reasoning, searches, message with its annotations), or, when
      // they are not wanted or were refused, as text with its sources.
      const data = m.content.filter((p) => p.type === 'provider_data');
      const kept = data.length === 1 && data[0]!.type === 'provider_data' ? parseKept(data[0]!.data) : undefined;
      if (kept && opts.kept) {
        out.push(...kept.output);
        continue;
      }
      if (kept) {
        out.push({ role: 'assistant', content: keptAsText(kept) || '(empty)' });
        continue;
      }
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
  let text = '';
  /** Output items as they finish, for a reply that searched. */
  const items: Item[] = [];
  const started = new Set<string>();
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
        text += String(j.delta ?? '');
        yield { type: 'text', text: String(j.delta ?? '') };
        break;
      case 'response.output_item.added':
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching': {
        // A search has begun. Its query may not be known until it is done.
        const item = j.item as Item | undefined;
        const id = type === 'response.output_item.added' ? (item?.type === 'web_search_call' ? String(item.id ?? '') : '') : String(j.item_id ?? '');
        if (!id || started.has(id)) break;
        started.add(id);
        const q = (item?.action as { query?: unknown } | undefined)?.query;
        yield { type: 'search', id, status: 'started', ...(typeof q === 'string' && q ? { query: q } : {}) };
        break;
      }
      case 'response.output_text.annotation.added': {
        const a = j.annotation as Record<string, unknown> | undefined;
        if (a?.type !== 'url_citation' || !isWebUrl(a.url)) break;
        // The models usually write the link into the text themselves; a
        // marker is added only when they did not.
        yield { type: 'source', url: a.url, title: typeof a.title === 'string' ? a.title : '', cite: text.includes(a.url) ? 'list' : 'mark' };
        break;
      }
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
        const item = j.item as Item | undefined;
        if (item && typeof item.type === 'string') items.push(item);
        const signature = reasoningSignature(item);
        if (signature) yield { type: 'reasoning_block', signature };
        if (item?.type === 'web_search_call') {
          const id = String(item.id ?? '');
          const action = (item.action ?? {}) as { type?: string; query?: unknown; queries?: unknown; url?: unknown; pattern?: unknown; sources?: unknown };
          // What it did, in words: a search, or (reasoning models) reading
          // a page it found.
          const query =
            typeof action.query === 'string' && action.query
              ? action.query
              : Array.isArray(action.queries) && action.queries.length
                ? action.queries.filter((q) => typeof q === 'string').join(' · ')
                : action.type === 'open_page' && typeof action.url === 'string'
                  ? `reading ${action.url}`
                  : action.type === 'find_in_page' && typeof action.pattern === 'string'
                    ? `looking for "${action.pattern}" in a page`
                    : undefined;
          if (!started.has(id)) {
            started.add(id);
            yield { type: 'search', id, status: 'started', ...(query ? { query } : {}) };
          }
          if (item.status === 'failed' || item.status === 'incomplete') {
            yield { type: 'search', id, status: 'failed', ...(query ? { query } : {}), error: item.status === 'failed' ? 'the search did not succeed' : 'the search was cut short' };
          } else {
            yield { type: 'search', id, status: 'done', ...(query ? { query } : {}) };
            // With include: web_search_call.action.sources, the pages it
            // looked at (addresses only; other entries are data feeds).
            for (const s of Array.isArray(action.sources) ? (action.sources as Array<Record<string, unknown>>) : []) {
              if (isWebUrl(s?.url)) yield { type: 'source', url: s.url, title: typeof s.title === 'string' ? s.title : '', cite: 'none' };
            }
          }
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = j.response as { usage?: ResponsesUsage; incomplete_details?: { reason?: string }; status?: string; output?: Item[]; tool_usage?: { web_search?: { num_requests?: number } } } | undefined;
        const u = usageFromResponses(r?.usage);
        // Billable searches, when the API reports them.
        const billed = r?.tool_usage?.web_search?.num_requests;
        if (u || typeof billed === 'number') yield { type: 'usage', usage: { ...(u ?? {}), ...(typeof billed === 'number' ? { searches: billed } : {}) } };
        // A complete reply that searched: keep its items for later turns
        // (the response's own list when it carries one).
        if (type === 'response.completed') {
          const output = Array.isArray(r?.output) && r.output.length ? r.output : items;
          if (output.some((i) => i?.type === 'web_search_call')) yield { type: 'provider_data', data: JSON.stringify({ v: 1, output } satisfies Kept) };
        }
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
  /** The API refused kept search items once: send such replies as text. */
  private noKept = false;

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
    // Kept search items go back only while search is on: without the tool
    // in the request they have nothing to belong to.
    const hasKept = req.messages.some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'provider_data' && !!parseKept(p.data)));
    let sendKept = !!req.webSearch && hasKept && !this.noKept;
    let fullInput = toResponsesInput(req.messages, { kept: sendKept });
    const replaysReasoning = fullInput.some((i) => (i as { type?: string }).type === 'reasoning');
    const build = (summaries: boolean, withReasoning = true) => {
      const body: Record<string, unknown> = {
        model: req.model,
        input: withReasoning ? fullInput : fullInput.filter((i) => (i as { type?: string }).type !== 'reasoning'),
        stream: true,
        store: false,
      };
      if (req.webSearch) {
        body.tools = [{ type: 'web_search' }];
        if (req.webSearch.maxUses) body.max_tool_calls = req.webSearch.maxUses;
      }
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
      if (req.webSearch) body.include = [...((body.include as string[] | undefined) ?? []), 'web_search_call.action.sources'];
      if (s.extraBody) Object.assign(body, s.extraBody);
      return body;
    };
    yield { type: 'status', status: 'connecting' };
    const send = (withReasoning: boolean) =>
      request({ url: `${this.endpoint}/responses`, headers: this.headers(), body: build(caps.reasoning === true && !this.noSummaries, withReasoning), signal: req.signal, providerName: this.name });
    let res: Response;
    let withReasoning = true;
    for (;;) {
      try {
        res = await send(withReasoning);
        break;
      } catch (e) {
        if (!(e instanceof ProviderError) || e.kind !== 'bad_request') throw e;
        // Organisations that are not verified cannot receive reasoning
        // summaries; fall back to plain reasoning without them.
        if (/summar/i.test(e.message) && !this.noSummaries) {
          this.noSummaries = true;
          continue;
        }
        // Kept search items the API will not take back (not documented
        // either way): from now on such replies go as text. This comes
        // before the next check because such a refusal names web search
        // too; if search itself is the problem, the retry fails the same way.
        if (sendKept) {
          debug('openai refused the request with kept search items; sending those replies as text', { message: e.message });
          this.noKept = true;
          sendKept = false;
          fullInput = toResponsesInput(req.messages, { kept: false });
          continue;
        }
        // The model, the project or the reasoning effort does not allow the
        // web search tool. Nothing was produced: the session sends the
        // message again without search.
        if (req.webSearch && /web[_ ]search|hosted tool|tools? (is|are) not (supported|enabled|allowed|available)|max_tool_calls/i.test(`${e.message} ${e.providerMessage ?? ''}`)) {
          throw new ProviderError('search_unavailable', e.message, { status: e.status, providerMessage: e.providerMessage });
        }
        // Earlier reasoning is sent back as an optimisation. If the API
        // refuses the request with it (the encrypted content can no longer
        // be verified, say), try once without: the conversation must stay
        // usable. A request that is wrong for another reason fails again
        // and that error is reported.
        if (withReasoning && replaysReasoning) {
          debug('openai refused the request with replayed reasoning; retrying without it', { message: e.message });
          withReasoning = false;
          continue;
        }
        throw e;
      }
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
