// Turns session events into write-once transcript items plus a small live
// tail. Finished content goes to <Static> exactly once; only the streaming
// tail is re-rendered each frame. Independent of React so it can be tested.

import { EventEmitter } from 'node:events';
import type { Session, SessionEvent, StreamState } from '../core/session.js';
import type { StoredMessage } from '../core/conversation.js';
import { StreamingMarkdown } from '../render/markdown.js';
import type { Line } from '../render/style.js';
import { contentWidth, type Item } from './blocks.js';
import { wrapSpans } from '../render/width.js';

export interface LiveView {
  /** Markdown tail lines of the streaming answer (content width). */
  lines: Line[];
  /** Whether the tail starts the answer (needs the ● bullet). */
  first: boolean;
  /** Last lines of streaming reasoning, when thinking is in progress. */
  thinking: Line[];
}

let seq = 0;
const key = (p: string) => `${p}${++seq}`;

export class TranscriptModel extends EventEmitter {
  items: Item[] = [];
  epoch = 0;
  cols: number;
  showThinking = false;
  live: LiveView = { lines: [], first: true, thinking: [] };
  private md: StreamingMarkdown | null = null;
  /** The stream being rendered (kept after the session clears it). */
  private current: StreamState | null = null;
  private bulletPending = true;
  private thoughtCommitted = false;
  private welcome: () => Item;
  /** After Ctrl+L: messages on the path before this count stay cleared when
   * the transcript is reprinted (e.g. on resize). */
  private clearedBefore = 0;

  constructor(
    private readonly session: Session,
    cols: number,
    welcome: () => Item,
  ) {
    super();
    this.cols = cols;
    this.welcome = welcome;
    this.items = [welcome()];
    session.on('event', (e: SessionEvent) => this.onEvent(e));
  }

  private push(...items: Item[]): void {
    this.items = [...this.items, ...items];
  }

  private changed(): void {
    this.emit('change');
  }

  onEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'user':
        this.push({ kind: 'user', key: key('u'), message: e.message });
        break;
      case 'assistant-start':
        this.current = e.state;
        this.startStream();
        break;
      case 'frame':
        this.updateStream(false);
        break;
      case 'assistant-end': {
        this.updateStream(true);
        const m = e.message;
        const reasoning = m.content.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('');
        if (!this.thoughtCommitted && (reasoning || m.reasoningMs)) {
          this.push({ kind: 'thought', key: key('t'), ms: m.reasoningMs ?? e.stats.durationMs, text: this.showThinking ? reasoning : undefined });
        }
        if (e.outcome === 'interrupted') this.push({ kind: 'outcome', key: key('o'), text: 'Interrupted', tone: 'error' });
        else if (e.outcome === 'done' && (m.content.length || m.usage)) this.push({ kind: 'stats', key: key('s'), stats: e.stats });
        this.md = null;
        this.current = null;
        this.live = { lines: [], first: true, thinking: [] };
        break;
      }
      case 'notice':
        this.push({ kind: 'notice', key: key('n'), text: e.text, tone: e.tone });
        break;
      case 'reset':
        // A different conversation or branch: show it from the top.
        this.clearedBefore = 0;
        this.reprint(true);
        return;
      default:
        break;
    }
    this.changed();
  }

  private startStream(): void {
    this.md = new StreamingMarkdown(contentWidth(this.cols), { numberCode: true });
    this.bulletPending = true;
    this.thoughtCommitted = false;
    this.live = { lines: [], first: true, thinking: [] };
  }

  private updateStream(final: boolean): void {
    const s: StreamState | null = this.current;
    if (!this.md) return;
    const text = s?.text ?? '';
    const reasoning = s?.reasoning ?? '';
    if (s && reasoning && !this.thoughtCommitted && (text || final)) {
      const ms = (s.firstTextAt ?? Date.now()) - (s.reasoningStartedAt ?? s.startedAt);
      this.push({ kind: 'thought', key: key('t'), ms, text: this.showThinking ? reasoning : undefined });
      this.thoughtCommitted = true;
    }
    if (!s) return;
    const u = this.md.update(text, final);
    if (u.commit.length) {
      this.push({ kind: 'chunk', key: key('c'), lines: u.commit, first: this.bulletPending });
      this.bulletPending = false;
    }
    let thinking: Line[] = [];
    if (reasoning && !text) {
      const lines = wrapSpans([{ text: reasoning.trim(), style: { fg: 'dim', italic: true } }], contentWidth(this.cols));
      thinking = this.showThinking ? lines : lines.slice(-4);
    }
    this.live = { lines: u.live, first: this.bulletPending, thinking };
  }

  /** Clear and rebuild the printed transcript from the conversation (after
   * resize, Ctrl+O, rewind, resume...). */
  reprint(includeHistory: boolean): void {
    this.epoch++;
    const items: Item[] = this.clearedBefore > 0 ? [{ kind: 'spacer', key: key('x') }] : [this.welcome()];
    if (includeHistory) {
      for (const m of this.session.conv.path().slice(this.clearedBefore)) items.push(...this.messageItems(m));
    }
    this.items = items;
    if (this.current) {
      this.startStream();
      this.updateStream(false);
    }
    this.emit('reprint');
    this.changed();
  }

  info(markdown: string): void {
    this.push({ kind: 'info', key: key('i'), markdown });
    this.changed();
  }

  notice(text: string, tone: 'dim' | 'error' | 'success' | 'warning' = 'dim'): void {
    this.push({ kind: 'notice', key: key('n'), text, tone });
    this.changed();
  }

  /** Ctrl+L: clear the screen but keep the conversation. */
  clearScreen(): void {
    // Messages so far stay cleared; a reply still streaming is not on the
    // path yet, so it is shown when it finishes.
    this.clearedBefore = this.session.conv.path().length;
    this.epoch++;
    this.items = [{ kind: 'spacer', key: key('x') }];
    if (this.current) {
      this.startStream();
      this.updateStream(false);
    }
    this.emit('reprint');
    this.changed();
  }

  setWidth(cols: number): void {
    if (cols === this.cols) return;
    this.cols = cols;
    this.reprint(true);
  }

  toggleThinking(): void {
    this.showThinking = !this.showThinking;
    this.reprint(true);
  }

  private messageItems(m: StoredMessage): Item[] {
    if (m.role === 'user') return [{ kind: 'user', key: key('u'), message: m }];
    if (m.role === 'summary') return [{ kind: 'summary', key: key('y'), message: m }];
    const out: Item[] = [{ kind: 'assistant', key: key('a'), message: m, showThinking: this.showThinking }];
    if (m.durationMs && !m.interrupted && !m.error && m.content.some((p) => p.type === 'text')) {
      out.push({
        kind: 'stats',
        key: key('s'),
        stats: {
          durationMs: m.durationMs,
          outputTokens: m.usage?.outputTokens ?? Math.round(m.content.map((p) => (p.type === 'text' ? p.text.length : 0)).reduce((a, b) => a + b, 0) / 4),
          tokensPerSecond: undefined,
        },
      });
    }
    return out;
  }
}
