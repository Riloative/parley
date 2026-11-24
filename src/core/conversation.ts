// The conversation model: a tree of messages (rewinding and regenerating
// create branches; nothing is ever removed) with a head pointer that selects
// the active branch.

import { randomBytes } from 'node:crypto';
import type { ChatMessage, ContentPart, Usage } from '../providers/types.js';

export type MessageRole = 'user' | 'assistant' | 'summary';

export interface StoredMessage {
  id: string;
  parentId: string | null;
  role: MessageRole;
  content: ContentPart[];
  /** provider/model that produced an assistant message (or was active). */
  model?: string;
  ts: number;
  usage?: Usage;
  durationMs?: number;
  /** Milliseconds spent before the first answer token (for "Thought for"). */
  reasoningMs?: number;
  interrupted?: boolean;
  error?: string;
  stopReason?: string;
  /** Transcript text for user messages whose pastes were collapsed. */
  display?: string;
}

export function newId(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export class Conversation {
  id: string;
  title?: string;
  systemPrompt?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  readonly messages = new Map<string, StoredMessage>();
  headId: string | null = null;

  constructor(id: string, createdAt = Date.now()) {
    this.id = id;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  add(m: StoredMessage): void {
    this.messages.set(m.id, m);
    this.headId = m.id;
    this.updatedAt = Math.max(this.updatedAt, m.ts);
  }

  /** Messages on the active branch, oldest first. */
  path(headId: string | null = this.headId): StoredMessage[] {
    const out: StoredMessage[] = [];
    let id = headId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const m = this.messages.get(id);
      if (!m) break;
      out.push(m);
      id = m.parentId;
    }
    return out.reverse();
  }

  get head(): StoredMessage | undefined {
    return this.headId ? this.messages.get(this.headId) : undefined;
  }

  /** The messages sent to a model: everything after the latest summary. */
  context(): StoredMessage[] {
    const p = this.path();
    let start = 0;
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i]!.role === 'summary') {
        start = i;
        break;
      }
    }
    return p.slice(start);
  }

  /** Messages that share `m`'s parent (the alternatives at a branch point),
   * oldest first; `m` itself included. */
  siblings(m: StoredMessage): StoredMessage[] {
    const out: StoredMessage[] = [];
    for (const x of this.messages.values()) if (x.parentId === m.parentId) out.push(x);
    return out;
  }

  /** The newest message of every branch: messages nothing continues from. */
  leaves(): StoredMessage[] {
    const parents = new Set<string>();
    for (const m of this.messages.values()) if (m.parentId) parents.add(m.parentId);
    return [...this.messages.values()].filter((m) => !parents.has(m.id));
  }

  get messageCount(): number {
    return this.path().filter((m) => m.role !== 'summary').length;
  }
}

/**
 * Convert stored messages into the provider-neutral wire form. Reasoning
 * blocks are kept only when they came from the same provider and model that
 * will receive them; empty or failed assistant turns are skipped; adjacent
 * messages with the same role are merged so every provider accepts them.
 */
export function toChatMessages(msgs: StoredMessage[], target: { provider: string; model: string }): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    let role: 'user' | 'assistant';
    let content: ContentPart[];
    if (m.role === 'summary') {
      role = 'user';
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      content = [{ type: 'text', text: `Summary of the conversation so far:\n\n${text}` }];
    } else {
      role = m.role;
      content = m.content.filter((p) => {
        if (p.type !== 'reasoning') return true;
        return p.provider === target.provider && p.model === target.model && (p.signature || p.redacted);
      });
    }
    if (role === 'assistant' && !content.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'reasoning')) continue;
    if (role === 'assistant' && !content.some((p) => p.type === 'text' && p.text.trim())) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = [...prev.content, { type: 'text', text: '\n\n' }, ...content];
    } else {
      out.push({ role, content: [...content] });
    }
  }
  // Providers require the conversation to start with a user turn.
  while (out[0] && out[0].role !== 'user') out.shift();
  return out;
}
