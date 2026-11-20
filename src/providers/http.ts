// Shared HTTP plumbing for the adapters: a fetch that honours HTTPS_PROXY /
// HTTP_PROXY / NO_PROXY and never times out while a local model loads, an SSE
// parser, and translation of failures into plain-language ProviderErrors.

import { debug, debugEnabled } from '../debug.js';
import { redact } from '../config/credentials.js';
import { ProviderError } from './types.js';

import type * as UndiciNs from 'undici';

type FetchFn = typeof globalThis.fetch;
type Undici = typeof UndiciNs;

let fetchPromise: Promise<FetchFn> | undefined;

function hasProxyEnv(): boolean {
  return !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
}

/** The fetch used for every provider request (lazily loads undici). */
export function getFetch(): Promise<FetchFn> {
  fetchPromise ??= (async () => {
    try {
      // undici is CommonJS: in the code-split npm bundle the dynamic import
      // yields only a `default` export, while the single-file binary exposes
      // named exports. Accept both.
      const mod = (await import('undici')) as Undici & { default?: Undici };
      const undici = typeof mod.EnvHttpProxyAgent === 'function' ? mod : mod.default!;
      const opts = {
        // A local model may take minutes to load before sending anything.
        headersTimeout: 0,
        bodyTimeout: 0,
        connectTimeout: 15_000,
      };
      const dispatcher = hasProxyEnv() ? new undici.EnvHttpProxyAgent(opts) : new undici.Agent(opts);
      const f = undici.fetch as unknown as FetchFn;
      return ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) =>
        f(input, { ...(init ?? {}), dispatcher } as RequestInit)) as FetchFn;
    } catch (e) {
      // Without undici there is no proxy support and fetch's default
      // timeouts apply; say so rather than failing silently.
      debug('undici unavailable; using the built-in fetch (no proxy support, default timeouts)', { error: (e as Error).message });
      if (hasProxyEnv()) process.emitWarning('parley could not load its HTTP client; HTTPS_PROXY/HTTP_PROXY will be ignored.');
      return globalThis.fetch.bind(globalThis);
    }
  })();
  return fetchPromise;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a text/event-stream body. Tolerates CRLF, comments and missing
 * trailing blank lines. */
export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  const flush = function* (): Generator<SseEvent> {
    if (data.length) yield { event, data: data.join('\n') };
    event = undefined;
    data = [];
  };
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
      if (line === '') {
        yield* flush();
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    for (const line of buf.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
  }
  yield* flush();
}

export function parseRetryAfter(h: Headers): number | undefined {
  const ms = h.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = h.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  }
  // OpenAI style reset durations: "6m0s", "1.5s", "250ms"
  const reset = h.get('x-ratelimit-reset-requests') ?? h.get('x-ratelimit-reset-tokens');
  if (reset) {
    let total = 0;
    for (const m of reset.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
      const v = Number(m[1]);
      total += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60_000 : v * 3_600_000;
    }
    if (total > 0) return total;
  }
  return undefined;
}

function extractMessage(body: string): { message?: string; code?: string; type?: string } {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const e = (j.error ?? j) as Record<string, unknown> | string;
    if (typeof e === 'string') return { message: e };
    const message = (e.message ?? j.message ?? j.detail ?? j.msg) as unknown;
    return {
      message: typeof message === 'string' ? message : message !== undefined ? JSON.stringify(message) : undefined,
      code: typeof e.code === 'string' ? e.code : typeof e.code === 'number' ? String(e.code) : undefined,
      type: typeof e.type === 'string' ? e.type : undefined,
    };
  } catch {
    const t = body.trim();
    return { message: t ? t.slice(0, 300) : undefined };
  }
}

const OVERFLOW_RE = /context(_length| length| window)|too long|maximum context|prompt is too long|exceeds the (model'?s )?(context|maximum)|n_ctx|reduce the length|too many tokens/i;
const QUOTA_RE = /insufficient_quota|quota|billing|credit|spend_limit/i;

/** Build a ProviderError from a non-2xx response. */
export async function httpError(res: Response, providerName: string): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const { message, code, type } = extractMessage(body);
  const pm = message ? redact(message) : undefined;
  const status = res.status;
  const retryAfterMs = parseRetryAfter(res.headers);
  const suffix = pm ? `: ${pm}` : '';
  debug('http error', { provider: providerName, status, body: body.slice(0, 2000) });
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${providerName} rejected the API key (${status})${suffix}`, { status, providerMessage: pm });
  }
  if (status === 404) {
    return new ProviderError('not_found', `${providerName} returned 404 — the model or endpoint was not found${suffix}`, { status, providerMessage: pm });
  }
  if (status === 413 || (status === 400 && OVERFLOW_RE.test(`${pm ?? ''} ${code ?? ''}`))) {
    return new ProviderError('context_overflow', `The conversation is too long for this model${suffix}`, { status, providerMessage: pm });
  }
  if (status === 429) {
    const quota = QUOTA_RE.test(`${code ?? ''} ${type ?? ''} ${pm ?? ''}`) && !/rate/i.test(code ?? '');
    return new ProviderError('rate_limit', quota ? `${providerName}: quota or billing limit reached${suffix}` : `Rate limited by ${providerName}${suffix}`, {
      status,
      retryable: !quota,
      retryAfterMs,
      providerMessage: pm,
    });
  }
  if (status === 529 || status === 503) {
    return new ProviderError('overloaded', `${providerName} is overloaded (${status})${suffix}`, { status, retryable: true, retryAfterMs, providerMessage: pm });
  }
  if (status >= 500 || status === 408 || status === 409 || status === 425) {
    return new ProviderError('server', `${providerName} returned a server error (${status})${suffix}`, { status, retryable: true, retryAfterMs, providerMessage: pm });
  }
  return new ProviderError('bad_request', `${providerName} rejected the request (${status})${suffix}`, { status, providerMessage: pm });
}

/** Translate a thrown fetch/network error. */
export function networkError(err: unknown, url: string, providerName: string, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) return new ProviderError('aborted', 'Request cancelled');
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'AbortError') return new ProviderError('aborted', 'Request cancelled');
  const code = e?.cause?.code ?? e?.code ?? '';
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep */
  }
  debug('network error', { provider: providerName, url, code, message: e?.message, cause: e?.cause?.message });
  if (code === 'ECONNREFUSED') {
    return new ProviderError('not_running', `Nothing is listening at ${origin}. Is the ${providerName} server running?`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ProviderError('network', `Could not resolve ${origin} — check the address and your network connection.`, { retryable: code === 'EAI_AGAIN' });
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new ProviderError('network', `Timed out connecting to ${origin}.`, { retryable: true });
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE' || code === 'UND_ERR_CLOSED') {
    return new ProviderError('network', `The connection to ${origin} was lost.`, { retryable: true });
  }
  if (/bad port/i.test(`${e?.cause?.message ?? ''} ${e?.message ?? ''}`)) {
    return new ProviderError('bad_request', `${origin} uses a port that fetch refuses to connect to; use a different port.`);
  }
  if (/certificate|SSL|TLS/i.test(`${code} ${e?.message ?? ''} ${e?.cause?.message ?? ''}`)) {
    return new ProviderError('network', `TLS error talking to ${origin}: ${e?.cause?.message ?? e?.message}`);
  }
  return new ProviderError('network', `Network error talking to ${origin}: ${redact(e?.cause?.message ?? e?.message ?? String(err))}`, { retryable: true });
}

export interface RequestOptions {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  providerName: string;
}

/** Perform a request; throws ProviderError on network or HTTP failure. */
export async function request(opts: RequestOptions): Promise<Response> {
  const f = await getFetch();
  const started = Date.now();
  if (debugEnabled()) debug('request', { provider: opts.providerName, method: opts.method ?? 'POST', url: opts.url, headers: opts.headers, body: opts.body });
  let res: Response;
  try {
    res = await f(opts.url, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: opts.headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    throw networkError(err, opts.url, opts.providerName, opts.signal);
  }
  debug('response', { provider: opts.providerName, url: opts.url, status: res.status, ms: Date.now() - started, requestId: res.headers.get('request-id') ?? res.headers.get('x-request-id') });
  if (!res.ok) throw await httpError(res, opts.providerName);
  return res;
}

/** Resolve "env:NAME" / "${NAME}" header values. */
export function resolveHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v) ?? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v);
    out[k] = m ? (process.env[m[1]!] ?? '') : v;
  }
  return out;
}

/** Simple time-boxed cache for model lists. */
export class TtlCache<T> {
  private value?: T;
  private at = 0;
  private inflight?: Promise<T>;
  constructor(private readonly ttlMs: number) {}
  async get(load: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && Date.now() - this.at < this.ttlMs) return this.value;
    this.inflight ??= load()
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
  peek(): T | undefined {
    return this.value;
  }
}
