// The chat session: owns the current conversation, runs turns against a
// provider, batches stream updates into frames, persists every event, queues
// messages typed during a response, retries transient failures visibly, and
// implements branching operations (retry, rewind) and compaction.

import { EventEmitter } from 'node:events';
import type { Config } from '../config/config.js';
import { Conversation, newId, toChatMessages, type StoredMessage } from './conversation.js';
import { ConversationLockedError, type ConversationFile, type Store } from './store.js';
import { CostTracker, estimateTokens } from './usage.js';
import type { Registry } from '../providers/registry.js';
import {
  ProviderError,
  parseModelRef,
  type ChatMessage,
  type ContentPart,
  type ModelCapabilities,
  type ReasoningEffort,
  type Usage,
} from '../providers/types.js';
import { debug } from '../debug.js';
import { redact } from '../config/credentials.js';

export type StreamStatus = 'connecting' | 'waiting' | 'streaming' | 'retrying';

export interface StreamState {
  id: string;
  model: string;
  endpoint: string;
  startedAt: number;
  status: StreamStatus;
  text: string;
  reasoning: string;
  reasoningStartedAt?: number;
  firstTextAt?: number;
  outputTokens: number;
  outputEstimated: boolean;
  retry?: { attempt: number; max: number; until: number; reason: string };
}

export interface TurnStats {
  durationMs: number;
  outputTokens: number;
  tokensPerSecond?: number;
  reasoningMs?: number;
}

export type Tone = 'dim' | 'error' | 'success' | 'warning';

export type SessionEvent =
  | { type: 'user'; message: StoredMessage }
  | { type: 'assistant-start'; state: StreamState }
  | { type: 'frame' }
  | { type: 'assistant-end'; message: StoredMessage; stats: TurnStats; outcome: 'done' | 'interrupted' | 'error' }
  | { type: 'notice'; text: string; tone: Tone }
  | { type: 'reset' }
  | { type: 'title'; title: string }
  | { type: 'queue' }
  | { type: 'restore-input'; text: string }
  | { type: 'model'; model: string }
  | { type: 'busy'; busy: boolean; label?: string };

export interface OutgoingMessage {
  /** Text sent to the model (pastes expanded). */
  text: string;
  /** Text shown in the transcript (pastes collapsed); defaults to text. */
  display?: string;
  attachments?: ContentPart[];
}

const FRAME_MS = 33;
const PERSIST_MS = 400;
const MAX_ATTEMPTS = 6;
const MAX_RETRY_WAIT_MS = 60_000;

function scrubbed(e: ProviderError): ProviderError {
  const message = redact(e.message);
  const providerMessage = e.providerMessage === undefined ? undefined : redact(e.providerMessage);
  if (message === e.message && providerMessage === e.providerMessage) return e;
  return new ProviderError(e.kind, message, { status: e.status, retryable: e.retryable, retryAfterMs: e.retryAfterMs, providerMessage });
}

export interface SessionOptions {
  config: Config;
  registry: Registry;
  store: Store | null;
  model: string;
  /** Do not write anything to disk (e.g. `parley -p` without persistence). */
  ephemeral?: boolean;
}

export class Session extends EventEmitter {
  config: Config;
  readonly registry: Registry;
  readonly store: Store | null;
  file: ConversationFile | null = null;
  conv: Conversation;
  model: string;
  effort: ReasoningEffort | undefined;
  stream: StreamState | null = null;
  queue: OutgoingMessage[] = [];
  readonly costs = new CostTracker();
  /** Parent for the next user message, set by rewind. */
  private branchFrom: string | null | undefined;
  private abort: AbortController | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private pendingDelta = { text: '', reasoning: '' };
  private capsCache = new Map<string, ModelCapabilities>();
  private warned80 = false;
  private titlePending = false;
  private ephemeral: boolean;
  busy = false;

  constructor(opts: SessionOptions) {
    super();
    this.config = opts.config;
    this.registry = opts.registry;
    this.store = opts.store;
    this.model = opts.model;
    this.ephemeral = !!opts.ephemeral || !opts.store;
    this.effort = (opts.config.reasoningEffort as ReasoningEffort | undefined) ?? undefined;
    this.conv = new Conversation('unsaved');
    this.conv.systemPrompt = opts.config.systemPrompt;
  }

  override emit(event: 'event', e: SessionEvent): boolean {
    return super.emit(event, e);
  }

  private send_(e: SessionEvent): void {
    this.emit('event', e);
  }

  notice(text: string, tone: Tone = 'dim'): void {
    this.send_({ type: 'notice', text, tone });
  }

  get streaming(): boolean {
    return this.stream !== null;
  }

  // ------------------------------------------------------- conversation file

  /** Lazily create the file on the first message so empty sessions leave no
   * trace on disk. */
  private ensureFile(): void {
    if (this.file || this.ephemeral || !this.store) return;
    this.file = this.store.create();
    const old = this.conv;
    this.conv = this.file.conv;
    this.conv.systemPrompt = old.systemPrompt;
    this.conv.title = old.title;
    if (old.systemPrompt) this.file.append({ type: 'system', prompt: old.systemPrompt });
    this.file.append({ type: 'model', model: this.model });
  }

  private persist(ev: Parameters<ConversationFile['append']>[0]): void {
    try {
      this.file?.append(ev);
    } catch (e) {
      this.notice(`Could not save the conversation: ${(e as Error).message}`, 'error');
    }
  }

  newConversation(): void {
    if (this.streaming) this.interrupt();
    this.file?.releaseLock();
    this.file = null;
    this.conv = new Conversation('unsaved');
    this.conv.systemPrompt = this.config.systemPrompt;
    this.queue = [];
    this.branchFrom = undefined;
    this.warned80 = false;
    this.send_({ type: 'reset' });
  }

  resume(id: string): boolean {
    if (!this.store) return false;
    if (this.streaming) this.interrupt();
    let f: ConversationFile;
    try {
      f = this.store.open(id);
    } catch (e) {
      if (e instanceof ConversationLockedError) this.notice(e.message, 'error');
      else this.notice(`Could not open conversation ${id}: ${(e as Error).message}`, 'error');
      return false;
    }
    this.file?.releaseLock();
    this.file = f;
    this.conv = f.conv;
    if (f.conv.model && this.registry.has(parseModelRef(f.conv.model)?.provider ?? '')) this.model = f.conv.model;
    this.queue = [];
    this.branchFrom = undefined;
    this.warned80 = false;
    this.send_({ type: 'reset' });
    this.send_({ type: 'model', model: this.model });
    return true;
  }

  close(): void {
    this.flushPersist();
    this.file?.releaseLock();
  }

  /** Synchronously save whatever has streamed so far (used on SIGHUP etc.). */
  flushPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.stream) return;
    const { text, reasoning } = this.pendingDelta;
    if (text || reasoning) {
      this.persist({ type: 'delta', id: this.stream.id, ...(text ? { text } : {}), ...(reasoning ? { reasoning } : {}) });
      this.pendingDelta = { text: '', reasoning: '' };
    }
  }

  // ------------------------------------------------------------- settings

  async capabilities(model = this.model): Promise<ModelCapabilities> {
    const c = this.capsCache.get(model);
    if (c) return c;
    const caps = await this.registry.capabilities(model);
    this.capsCache.set(model, caps);
    return caps;
  }

  cachedCapabilities(model = this.model): ModelCapabilities | undefined {
    return this.capsCache.get(model);
  }

  setModel(model: string): void {
    this.model = model;
    this.warned80 = false;
    if (this.file) this.persist({ type: 'model', model });
    this.conv.model = model;
    this.send_({ type: 'model', model });
    void this.capabilities(model).then((caps) => {
      if (this.effort && caps.reasoningEfforts.length && !caps.reasoningEfforts.includes(this.effort)) {
        this.effort = caps.reasoningEfforts.includes('medium') ? 'medium' : caps.reasoningEfforts[0];
      }
      this.send_({ type: 'frame' });
    });
  }

  /** Shift+Tab: cycle through the efforts the model supports. */
  async cycleEffort(): Promise<ReasoningEffort | undefined> {
    const caps = await this.capabilities();
    const levels = caps.reasoningEfforts;
    if (!levels.length) return undefined;
    const i = this.effort ? levels.indexOf(this.effort) : -1;
    this.effort = levels[(i + 1) % levels.length];
    this.send_({ type: 'frame' });
    return this.effort;
  }

  setSystemPrompt(prompt: string | null): void {
    this.conv.systemPrompt = prompt ?? undefined;
    if (this.file) this.persist({ type: 'system', prompt });
  }

  rename(title: string): void {
    this.conv.title = title;
    if (!this.file && this.conv.messageCount > 0) this.ensureFile();
    this.persist({ type: 'title', title });
    this.send_({ type: 'title', title });
  }

  deleteCurrent(): boolean {
    if (!this.file || !this.store) {
      this.newConversation();
      return false;
    }
    const id = this.file.id;
    this.file.releaseLock();
    this.store.trash(id);
    this.file = null;
    this.newConversation();
    return true;
  }

  // ---------------------------------------------------------------- context

  contextUsage(): { used: number; window?: number; pct?: number; estimated: boolean } {
    const caps = this.capsCache.get(this.model);
    const window = caps?.contextWindow;
    const ctx = this.conv.context();
    let used = 0;
    let estimated = true;
    // Use the provider's own count from the latest reply on this model, plus
    // estimates for anything after it.
    let i = ctx.length - 1;
    for (; i >= 0; i--) {
      const m = ctx[i]!;
      if (m.role === 'assistant' && m.usage?.inputTokens !== undefined && m.model === this.model) {
        used = (m.usage.inputTokens ?? 0) + (m.usage.cacheReadTokens ?? 0) + (m.usage.cacheWriteTokens ?? 0) + (m.usage.outputTokens ?? 0);
        estimated = false;
        break;
      }
    }
    for (const m of ctx.slice(i + 1)) used += estimateTokens(m.content);
    if (i < 0) used += estimateTokens(this.conv.systemPrompt ?? '');
    if (this.stream) used += Math.ceil(this.stream.text.length / 4);
    return { used, window, pct: window ? Math.min(999, Math.round((used / window) * 100)) : undefined, estimated };
  }

  // ------------------------------------------------------------------ turns

  /** Send (or queue, if a response is streaming) a user message. */
  async submit(msg: OutgoingMessage): Promise<void> {
    if (this.streaming || this.busy) {
      this.queue.push(msg);
      this.send_({ type: 'queue' });
      return;
    }
    if (!parseModelRef(this.model)) {
      this.notice(this.model ? `"${this.model}" is not a valid model. Use provider/model-id; see /model.` : 'No model selected. Choose one with /model.', 'warning');
      this.send_({ type: 'restore-input', text: msg.display ?? msg.text });
      return;
    }
    const caps = await this.capabilities().catch(() => undefined);
    const window = caps?.contextWindow;
    if (window) {
      const projected = this.contextUsage().used + estimateTokens([{ type: 'text', text: msg.text }, ...(msg.attachments ?? [])]);
      if (projected > window) {
        this.notice(`This message would overflow ${this.model}'s context window (${projected.toLocaleString()} of ${window.toLocaleString()} tokens). Run /compact to summarise the conversation first, or /new to start fresh.`, 'warning');
        this.send_({ type: 'restore-input', text: msg.display ?? msg.text });
        return;
      }
    }
    const content: ContentPart[] = [...(msg.attachments ?? [])];
    if (msg.text) content.push({ type: 'text', text: msg.text });
    this.ensureFile();
    const parentId = this.branchFrom !== undefined ? this.branchFrom : this.conv.headId;
    this.branchFrom = undefined;
    const user: StoredMessage = {
      id: newId('u'),
      parentId,
      role: 'user',
      content,
      ts: Date.now(),
      model: this.model,
      ...(msg.display && msg.display !== msg.text ? { display: msg.display } : {}),
    };
    this.conv.add(user);
    this.persist({ type: 'message', ...user });
    this.send_({ type: 'user', message: user });
    await this.runTurn(this.model);
  }

  /** Esc: stop the response, keeping the partial text. */
  interrupt(): void {
    this.abort?.abort();
  }

  private queueHeld = false;

  /** While a queued message is being edited, nothing in the queue is sent. */
  holdQueue(on: boolean): void {
    this.queueHeld = on;
    if (!on) void this.flushQueue();
  }

  /** Replace the queued message at `index`, or remove it (null). */
  replaceQueued(index: number, msg: OutgoingMessage | null): void {
    if (index < 0 || index >= this.queue.length) return;
    if (msg) this.queue[index] = msg;
    else this.queue.splice(index, 1);
    this.send_({ type: 'queue' });
  }

  /** Remove and return the most recently queued message (Up arrow). */
  popQueue(): OutgoingMessage | undefined {
    const m = this.queue.pop();
    if (m) this.send_({ type: 'queue' });
    return m;
  }

  /** Regenerate the last reply (optionally with another model) as a branch. */
  async retry(model?: string): Promise<void> {
    if (this.streaming) return;
    const path = this.conv.path();
    let lastUser = -1;
    for (let i = path.length - 1; i >= 0; i--) if (path[i]!.role === 'user') {
      lastUser = i;
      break;
    }
    if (lastUser < 0) {
      this.notice('Nothing to retry yet.', 'dim');
      return;
    }
    const user = path[lastUser]!;
    this.conv.headId = user.id;
    this.persist({ type: 'head', id: user.id, ts: Date.now() });
    if (model && model !== this.model) this.setModel(model);
    this.send_({ type: 'reset' });
    await this.runTurn(this.model);
  }

  /** User messages on the active branch, for the rewind picker. */
  userMessages(): StoredMessage[] {
    return this.conv.path().filter((m) => m.role === 'user');
  }

  /** Rewind: move the head to just before `messageId`; the next message
   * branches from there. Returns the original text for editing. */
  rewindTo(messageId: string): string | undefined {
    const m = this.conv.messages.get(messageId);
    if (!m || m.role !== 'user') return undefined;
    if (this.streaming) this.interrupt();
    this.branchFrom = m.parentId;
    this.conv.headId = m.parentId;
    this.persist({ type: 'head', id: m.parentId, ts: Date.now() });
    this.send_({ type: 'reset' });
    return m.display ?? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  }

  /** Make another branch the active one: `leafId` is its newest message. */
  switchBranch(leafId: string): boolean {
    if (!this.conv.messages.has(leafId) || leafId === this.conv.headId) return false;
    if (this.streaming || this.busy) {
      this.notice('Wait for the reply to finish (or press Esc) before switching branches.', 'dim');
      return false;
    }
    this.branchFrom = undefined;
    this.conv.headId = leafId;
    this.persist({ type: 'head', id: leafId, ts: Date.now() });
    this.send_({ type: 'reset' });
    return true;
  }

  private scheduleFrame(): void {
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.send_({ type: 'frame' });
    }, FRAME_MS);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersist();
    }, PERSIST_MS);
  }

  private async buildMessages(model: string): Promise<ChatMessage[]> {
    const ref = parseModelRef(model)!;
    const msgs = toChatMessages(this.conv.context(), ref);
    const caps = await this.capabilities(model).catch(() => undefined);
    // Load image bytes; replace images for models that cannot read them.
    for (const m of msgs) {
      m.content = m.content.map((p) => {
        if (p.type !== 'image') return p;
        if (caps?.images === false) return { type: 'text', text: `[image omitted: ${p.name ?? 'image'} — this model cannot read images]` };
        const data = this.store?.loadAttachment(p.hash, p.mediaType);
        if (!data) return { type: 'text', text: `[image missing: ${p.name ?? p.hash.slice(0, 8)}]` };
        return { ...p, data: data.toString('base64') };
      });
    }
    return msgs;
  }

  private async runTurn(model: string): Promise<void> {
    const ref = parseModelRef(model);
    if (!ref) {
      this.notice(`"${model}" is not a valid model. Use provider/model-id; see /model.`, 'error');
      return;
    }
    const parentId = this.conv.headId;
    const id = newId('a');
    const abort = new AbortController();
    this.abort = abort;
    const state: StreamState = {
      id,
      model,
      endpoint: '',
      startedAt: Date.now(),
      status: 'connecting',
      text: '',
      reasoning: '',
      outputTokens: 0,
      outputEstimated: true,
    };
    this.stream = state;
    this.pendingDelta = { text: '', reasoning: '' };
    this.persist({ type: 'partial', id, parentId, model, ts: state.startedAt });
    this.send_({ type: 'assistant-start', state });

    let usage: Usage | undefined;
    let stopReason: string | undefined;
    let error: ProviderError | undefined;
    let reasoningSig: { signature?: string; redacted?: string } | undefined;
    const reasoningParts: ContentPart[] = [];
    let inputEstimate = 0;

    try {
      const provider = await this.registry.get(ref.provider);
      state.endpoint = provider.endpoint;
      const messages = await this.buildMessages(model);
      inputEstimate = messages.reduce((a, m) => a + estimateTokens(m.content), 0);
      const sampling = this.registry.sampling(model);
      const caps = await this.capabilities(model).catch(() => undefined);
      const effort = caps?.reasoningEfforts.length && this.effort && caps.reasoningEfforts.includes(this.effort) ? this.effort : undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          for await (const ev of provider.stream({
            model: ref.model,
            system: this.conv.systemPrompt,
            messages,
            sampling,
            reasoningEffort: effort,
            signal: abort.signal,
          })) {
            switch (ev.type) {
              case 'status':
                if (state.status !== 'streaming') state.status = ev.status;
                break;
              case 'reasoning':
                state.status = 'streaming';
                state.reasoningStartedAt ??= Date.now();
                state.reasoning += ev.text;
                state.outputTokens += Math.max(1, Math.round(ev.text.length / 4));
                this.pendingDelta.reasoning += ev.text;
                this.schedulePersist();
                break;
              case 'reasoning_block':
                reasoningSig = { signature: ev.signature, redacted: ev.redacted };
                // A signed block is kept even without visible text: OpenAI
                // sends encrypted reasoning when summaries are unavailable.
                if (state.reasoning || ev.redacted || ev.signature) {
                  reasoningParts.push({ type: 'reasoning', text: state.reasoning.slice(reasoningParts.reduce((a, p) => a + (p.type === 'reasoning' ? p.text.length : 0), 0)), provider: ref.provider, model: ref.model, ...reasoningSig });
                }
                break;
              case 'text':
                state.status = 'streaming';
                state.firstTextAt ??= Date.now();
                state.text += ev.text;
                state.outputTokens += Math.max(1, Math.round(ev.text.length / 4));
                this.pendingDelta.text += ev.text;
                this.schedulePersist();
                break;
              case 'usage':
                usage = { ...usage, ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v !== undefined)) };
                if (ev.usage.outputTokens !== undefined) {
                  state.outputTokens = ev.usage.outputTokens;
                  state.outputEstimated = false;
                }
                break;
              case 'retry':
                break;
              case 'error':
                throw ev.error;
              case 'done':
                stopReason = ev.stopReason;
                break;
            }
            this.scheduleFrame();
          }
          break;
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError('unknown', (e as Error)?.message ?? String(e));
          const nothingYet = !state.text && !state.reasoning;
          // Honour Retry-After; if the provider wants a longer wait than we
          // are willing to sit through, stop and say how long instead of
          // retrying early (which would only be refused again).
          const tooLong = err.retryAfterMs !== undefined && err.retryAfterMs > MAX_RETRY_WAIT_MS;
          if (err.kind !== 'aborted' && err.retryable && !tooLong && nothingYet && attempt < MAX_ATTEMPTS && !abort.signal.aborted) {
            const delay = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
            state.status = 'retrying';
            state.retry = { attempt: attempt + 1, max: MAX_ATTEMPTS, until: Date.now() + delay, reason: redact(err.message) };
            debug('retrying', { attempt, delay, reason: err.message });
            this.send_({ type: 'frame' });
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay);
              abort.signal.addEventListener('abort', () => {
                clearTimeout(t);
                resolve();
              }, { once: true });
            });
            state.retry = undefined;
            if (abort.signal.aborted) throw new ProviderError('aborted', 'Request cancelled');
            state.status = 'connecting';
            this.send_({ type: 'frame' });
            continue;
          }
          throw err;
        }
      }
    } catch (e) {
      error = e instanceof ProviderError ? e : new ProviderError('unknown', (e as Error)?.message ?? String(e));
      // Errors can quote request details back at us; whatever path they took,
      // scrub known keys before the text reaches a notice or the transcript.
      error = scrubbed(error);
    }

    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.pendingDelta = { text: '', reasoning: '' };

    const interrupted = abort.signal.aborted || error?.kind === 'aborted';
    const end = Date.now();
    const content: ContentPart[] = [];
    if (reasoningParts.length) content.push(...reasoningParts);
    else if (state.reasoning) content.push({ type: 'reasoning', text: state.reasoning, provider: ref.provider, model: ref.model, ...(reasoningSig ?? {}) });
    if (state.text) content.push({ type: 'text', text: state.text });
    const message: StoredMessage = {
      id,
      parentId,
      role: 'assistant',
      content,
      model,
      ts: end,
      usage,
      durationMs: end - state.startedAt,
      reasoningMs: state.reasoningStartedAt ? (state.firstTextAt ?? end) - state.reasoningStartedAt : undefined,
      ...(interrupted ? { interrupted: true } : {}),
      ...(error && !interrupted ? { error: error.message } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
    // Only keep a node for replies that produced something (or failed
    // visibly) so the transcript and context stay clean.
    if (content.length || (error && !interrupted)) {
      this.conv.add(message);
      this.persist({ type: 'message', ...message });
    } else {
      this.persist({ type: 'head', id: parentId, ts: end });
      this.conv.headId = parentId;
    }
    if (usage || state.text) this.costs.add(model, usage, state.outputTokens, inputEstimate);

    const genMs = state.firstTextAt ? end - (state.reasoningStartedAt ?? state.firstTextAt) : end - state.startedAt;
    const stats: TurnStats = {
      durationMs: end - state.startedAt,
      outputTokens: state.outputTokens,
      tokensPerSecond: state.outputTokens > 0 && genMs > 200 ? state.outputTokens / (genMs / 1000) : undefined,
      reasoningMs: message.reasoningMs,
    };
    this.stream = null;
    this.abort = null;
    this.send_({ type: 'assistant-end', message, stats, outcome: interrupted ? 'interrupted' : error ? 'error' : 'done' });

    if (error && !interrupted) {
      this.notice(this.describeError(error, state.endpoint), 'error');
    }
    if (!error && !interrupted) {
      this.maybeWarnContext();
      void this.maybeTitle();
    }
    if (this.queue.length) {
      if (interrupted || error) {
        // Give queued text back to the user rather than sending it blindly.
        const text = this.queue.map((q) => q.display ?? q.text).filter((t) => t.trim()).join('\n\n');
        this.queue = [];
        this.send_({ type: 'queue' });
        this.send_({ type: 'restore-input', text });
      } else {
        await this.flushQueue();
      }
    }
  }

  describeError(e: ProviderError, endpoint: string): string {
    if (e.retryAfterMs !== undefined && e.retryAfterMs > MAX_RETRY_WAIT_MS) {
      const mins = Math.ceil(e.retryAfterMs / 60_000);
      return `${e.message}\nThe provider asks to wait before retrying: try again in ${mins} minute${mins === 1 ? '' : 's'} (/retry).`;
    }
    switch (e.kind) {
      case 'context_overflow':
        return `${e.message}\nRun /compact to summarise the conversation and free up context, then /retry.`;
      case 'not_running':
        return e.message;
      case 'auth':
        return e.message;
      case 'not_found':
        return `${e.message}\nCheck the model id with /model.`;
      default:
        return endpoint && e.kind === 'network' ? e.message : e.message;
    }
  }

  private maybeWarnContext(): void {
    const u = this.contextUsage();
    if (u.pct !== undefined && u.pct >= 80 && !this.warned80) {
      this.warned80 = true;
      this.notice(`Context is ${u.pct}% full. Run /compact to summarise the conversation so far.`, 'warning');
    }
  }

  // ------------------------------------------------------------------ titles

  private async maybeTitle(): Promise<void> {
    if (this.conv.title || this.titlePending || !this.file) return;
    const first = this.conv.path().find((m) => m.role === 'user');
    const firstText = first?.display ?? first?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    const fallback = firstText.split('\n').find((l) => l.trim())?.trim().slice(0, 60) || 'Untitled';
    const titleModel = this.config.titleModel;
    if (!titleModel) {
      this.rename(fallback);
      return;
    }
    this.titlePending = true;
    try {
      const reply = this.conv.path().find((m) => m.role === 'assistant');
      const replyText = reply?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      const title = await this.complete(
        titleModel,
        'You write short titles for chat conversations. Reply with only the title: 2 to 6 words, no quotes, no trailing punctuation.',
        `User: ${firstText.slice(0, 2000)}\n\nAssistant: ${replyText.slice(0, 1000)}\n\nTitle:`,
        30,
      );
      const clean = title.replace(/^["'#\s]+|["'.\s]+$/g, '').split('\n')[0]!.slice(0, 80);
      this.rename(clean || fallback);
    } catch (e) {
      debug('title generation failed', { error: (e as Error).message });
      this.rename(fallback);
    } finally {
      this.titlePending = false;
    }
  }

  /** One-shot non-streaming-style completion used for titles and compaction. */
  async complete(model: string, system: string, prompt: string, maxTokens?: number, signal?: AbortSignal): Promise<string> {
    const ref = parseModelRef(model);
    if (!ref) throw new Error(`Invalid model "${model}"`);
    const provider = await this.registry.get(ref.provider);
    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const timer = maxTokens && maxTokens < 100 ? setTimeout(() => ac.abort(), 30_000) : null;
    let out = '';
    try {
      for await (const ev of provider.stream({
        model: ref.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        sampling: { ...this.registry.sampling(model), ...(maxTokens ? { maxTokens: Math.max(maxTokens, this.registry.sampling(model).maxTokens ?? 0) || maxTokens } : {}) },
        signal: ac.signal,
        reasoningEffort: undefined,
      })) {
        if (ev.type === 'text') out += ev.text;
        if (ev.type === 'error') throw ev.error;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return out.trim();
  }

  // -------------------------------------------------------------- compaction

  async compact(instructions?: string): Promise<void> {
    if (this.streaming || this.busy) return;
    const ctx = this.conv.context();
    if (ctx.filter((m) => m.role !== 'summary').length < 2) {
      this.notice('Nothing to compact yet.', 'dim');
      return;
    }
    const model = this.config.compactModel ?? this.model;
    const transcript = ctx
      .map((m) => {
        const text = m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[file ${p.name}]` : p.type === 'image' ? `[image ${p.name ?? ''}]` : '')).join('');
        return `${m.role === 'assistant' ? 'Assistant' : m.role === 'summary' ? 'Earlier summary' : 'User'}: ${text}`;
      })
      .join('\n\n');
    this.busy = true;
    const ac = new AbortController();
    this.abort = ac;
    this.send_({ type: 'busy', busy: true, label: 'Compacting conversation' });
    try {
      const summary = await this.complete(
        model,
        'You summarise conversations so they can be continued with less context. Preserve facts, decisions, code, names, numbers, open questions and the user\'s goals. Write in compact Markdown.',
        `Summarise the following conversation so that it can be continued seamlessly.${instructions ? ` Additional instructions: ${instructions}` : ''}\n\n<conversation>\n${transcript}\n</conversation>`,
        undefined,
        ac.signal,
      );
      if (!summary) throw new Error('the model returned an empty summary');
      this.ensureFile();
      const msg: StoredMessage = { id: newId('s'), parentId: this.conv.headId, role: 'summary', content: [{ type: 'text', text: summary }], model, ts: Date.now() };
      this.conv.add(msg);
      this.persist({ type: 'message', ...msg });
      this.warned80 = false;
      this.send_({ type: 'busy', busy: false });
      this.send_({ type: 'reset' });
      this.notice(`Conversation compacted (${estimateTokens(transcript).toLocaleString()} → ${estimateTokens(summary).toLocaleString()} tokens). Earlier messages stay in the transcript but are no longer sent.`, 'success');
    } catch (e) {
      this.send_({ type: 'busy', busy: false });
      if (ac.signal.aborted) this.notice('Compaction cancelled.', 'dim');
      else this.notice(`Compaction failed: ${redact((e as Error).message)}`, 'error');
    } finally {
      this.busy = false;
      this.abort = null;
    }
    await this.flushQueue();
  }

  /** Send messages queued while busy (e.g. during compaction). */
  private async flushQueue(): Promise<void> {
    if (!this.queue.length || this.streaming || this.busy || this.queueHeld) return;
    const q = this.queue.filter((m) => m.text.trim() || m.attachments?.length);
    this.queue = [];
    this.send_({ type: 'queue' });
    await this.submit({
      text: q.map((m) => m.text).join('\n\n'),
      display: q.map((m) => m.display ?? m.text).join('\n\n'),
      attachments: q.flatMap((m) => m.attachments ?? []),
    });
  }
}
