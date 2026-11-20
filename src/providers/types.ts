// The provider-agnostic core types. Everything above src/providers talks only
// in these terms; each adapter converts to and from its own wire format.

/** A piece of message content. Designed so tool calls can be added later as
 * further variants without touching existing ones. */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      /** MIME type, e.g. image/png */
      mediaType: string;
      /** sha256 of the bytes; the bytes live in the attachment store. */
      hash: string;
      /** Original file name, for display only. */
      name?: string;
      /** Base64 data, filled in just before sending. Never persisted. */
      data?: string;
    }
  | {
      /** A text file attached by the user (via @ or drag and drop). */
      type: 'file';
      name: string;
      text: string;
    }
  | {
      /** Model reasoning. `signature`/`redacted` let the originating
       * provider verify the block when it is sent back; other providers
       * must drop it. */
      type: 'reasoning';
      text: string;
      provider: string;
      model: string;
      signature?: string;
      redacted?: string;
    };
// Future: | { type: 'tool_call'; ... } | { type: 'tool_result'; ... }

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: ContentPart[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SamplingSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  /** Arbitrary extra fields merged into the request body. */
  extraBody?: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  sampling: SamplingSettings;
  reasoningEffort?: ReasoningEffort;
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: 'status'; status: 'connecting' | 'waiting' | 'streaming' }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** A complete reasoning block with provider-specific verification data,
   * emitted once the block ends. */
  | { type: 'reasoning_block'; signature?: string; redacted?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'error'; error: ProviderError }
  | { type: 'done'; stopReason?: string };

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'not_running'
  | 'bad_request'
  | 'not_found'
  | 'context_overflow'
  | 'server'
  | 'aborted'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** The provider's own message, already scrubbed of secrets. */
  readonly providerMessage?: string;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; providerMessage?: string } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerMessage = opts.providerMessage;
  }
}

export interface ModelCapabilities {
  images: boolean | 'unknown';
  reasoning: boolean | 'unknown';
  /** Effort levels the model accepts, in increasing order. Empty = none. */
  reasoningEfforts: ReasoningEffort[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  capabilities: ModelCapabilities;
}

export interface Provider {
  /** The configured name, e.g. "anthropic" or "local". */
  readonly name: string;
  readonly type: ProviderType;
  /** Human-readable address for messages, e.g. http://localhost:8080 */
  readonly endpoint: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Best-effort capabilities for a model id (may consult the cached list). */
  capabilities(model: string): Promise<ModelCapabilities>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export type ProviderType = 'anthropic' | 'openai' | 'openai-compatible' | 'mock';

export const UNKNOWN_CAPS: ModelCapabilities = {
  images: 'unknown',
  reasoning: 'unknown',
  reasoningEfforts: [],
};

/** "provider/model-id" → parts. The model id may itself contain slashes. */
export function parseModelRef(ref: string): { provider: string; model: string } | undefined {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
