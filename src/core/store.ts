// Append-only JSONL persistence. Every event is written (synchronously, one
// line, O_APPEND) the moment it happens, so a crash or closed terminal loses
// at most the last fraction of a second of a streaming reply. A per-file lock
// stops two parley instances from writing the same conversation.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Conversation, type StoredMessage } from './conversation.js';
import { paths } from '../config/paths.js';

export const SCHEMA_VERSION = 1;

export type StoreEvent =
  | { type: 'meta'; v: number; id: string; createdAt: number; app: 'parley'; cwd?: string }
  | ({ type: 'message' } & StoredMessage)
  | { type: 'partial'; id: string; parentId: string | null; model?: string; ts: number }
  | { type: 'delta'; id: string; text?: string; reasoning?: string }
  | { type: 'head'; id: string | null; ts: number }
  | { type: 'title'; title: string }
  | { type: 'system'; prompt: string | null }
  | { type: 'model'; model: string };

export interface ConversationSummary {
  id: string;
  title: string;
  model?: string;
  updatedAt: number;
  messageCount: number;
  file: string;
}

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ConversationLockedError extends Error {
  constructor(readonly pid: number) {
    super(`This conversation is open in another parley window (pid ${pid}).`);
  }
}

/** Replay events into a Conversation. Tolerates a truncated final line. */
export function replay(id: string, text: string): { conv: Conversation; partial?: StoredMessage } {
  const conv = new Conversation(id);
  const partials = new Map<string, StoredMessage>();
  let lastPartial: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: StoreEvent;
    try {
      ev = JSON.parse(line) as StoreEvent;
    } catch {
      continue; // half-written last line after a crash
    }
    switch (ev.type) {
      case 'meta':
        conv.createdAt = ev.createdAt;
        conv.updatedAt = ev.createdAt;
        break;
      case 'message': {
        const { type: _t, ...m } = ev;
        partials.delete(m.id);
        conv.add(m);
        break;
      }
      case 'partial':
        partials.set(ev.id, { id: ev.id, parentId: ev.parentId, role: 'assistant', content: [], model: ev.model, ts: ev.ts, interrupted: true });
        lastPartial = ev.id;
        break;
      case 'delta': {
        const p = partials.get(ev.id);
        if (!p) break;
        if (ev.reasoning) appendPart(p, 'reasoning', ev.reasoning);
        if (ev.text) appendPart(p, 'text', ev.text);
        break;
      }
      case 'head':
        conv.headId = ev.id;
        if (ev.ts) conv.updatedAt = Math.max(conv.updatedAt, ev.ts);
        break;
      case 'title':
        conv.title = ev.title;
        break;
      case 'system':
        conv.systemPrompt = ev.prompt ?? undefined;
        break;
      case 'model':
        conv.model = ev.model;
        break;
    }
  }
  // A reply that was streaming when the process died: recover what arrived.
  let partial: StoredMessage | undefined;
  if (lastPartial && partials.has(lastPartial)) {
    partial = partials.get(lastPartial)!;
    if (partial.content.length) conv.add(partial);
  }
  return { conv, partial };
}

function appendPart(m: StoredMessage, kind: 'text' | 'reasoning', text: string): void {
  const last = m.content[m.content.length - 1];
  if (kind === 'text') {
    if (last?.type === 'text') last.text += text;
    else m.content.push({ type: 'text', text });
  } else {
    if (last?.type === 'reasoning') last.text += text;
    else m.content.push({ type: 'reasoning', text, provider: '', model: '' });
  }
}

/** An open, writable conversation file. */
export class ConversationFile {
  private lockPath: string;
  private released = false;

  constructor(
    readonly file: string,
    readonly conv: Conversation,
  ) {
    this.lockPath = `${file}.lock`;
  }

  get id(): string {
    return this.conv.id;
  }

  acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(readFileSafe(this.lockPath).trim());
        if (pidAlive(pid) && pid !== process.pid) throw new ConversationLockedError(pid);
        if (pid === process.pid) return;
        try {
          unlinkSync(this.lockPath); // stale lock from a crashed process
        } catch {
          /* raced with another instance; retry */
        }
      }
    }
    throw new Error('Could not lock the conversation file.');
  }

  releaseLock(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (readFileSafe(this.lockPath).trim() === String(process.pid)) unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }

  append(ev: StoreEvent): void {
    // One write per event; with O_APPEND the line lands atomically at the end.
    appendFileSync(this.file, JSON.stringify(ev) + '\n', { mode: 0o600 });
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export class Store {
  constructor(private readonly root = paths.dataDir) {}

  get conversationsDir(): string {
    return join(this.root, 'conversations');
  }

  get attachmentsDir(): string {
    return join(this.root, 'attachments');
  }

  create(cwd = process.cwd()): ConversationFile {
    ensureDir(this.conversationsDir);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const id = `${stamp}-${randomBytes(3).toString('hex')}`;
    const file = join(this.conversationsDir, `${id}.jsonl`);
    const conv = new Conversation(id);
    const cf = new ConversationFile(file, conv);
    cf.acquireLock();
    cf.append({ type: 'meta', v: SCHEMA_VERSION, id, createdAt: conv.createdAt, app: 'parley', cwd });
    return cf;
  }

  fileFor(id: string): string {
    return join(this.conversationsDir, `${basename(id)}.jsonl`);
  }

  exists(id: string): boolean {
    return existsSync(this.fileFor(id));
  }

  open(id: string, opts: { lock?: boolean } = {}): ConversationFile {
    const file = this.fileFor(id);
    const { conv } = replay(id, readFileSync(file, 'utf8'));
    const cf = new ConversationFile(file, conv);
    if (opts.lock !== false) cf.acquireLock();
    return cf;
  }

  /** All conversations, most recently updated first. */
  list(): ConversationSummary[] {
    if (!existsSync(this.conversationsDir)) return [];
    const out: ConversationSummary[] = [];
    for (const f of readdirSync(this.conversationsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(this.conversationsDir, f);
      const id = f.slice(0, -'.jsonl'.length);
      try {
        const { conv } = replay(id, readFileSync(file, 'utf8'));
        const count = conv.messageCount;
        if (count === 0) continue;
        const first = conv.path().find((m) => m.role === 'user');
        const firstText = first?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
        out.push({
          id,
          title: conv.title ?? (firstText.split('\n')[0]?.slice(0, 80) || '(untitled)'),
          model: conv.model ?? conv.path().reverse().find((m) => m.model)?.model,
          updatedAt: Math.max(conv.updatedAt, statSync(file).mtimeMs),
          messageCount: count,
          file,
        });
      } catch {
        /* unreadable file: skip */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  }

  /** Full-text search across all conversations (case-insensitive). */
  search(query: string): Array<ConversationSummary & { snippet: string }> {
    const q = query.toLowerCase();
    const out: Array<ConversationSummary & { snippet: string }> = [];
    for (const s of this.list()) {
      const { conv } = replay(s.id, readFileSync(s.file, 'utf8'));
      let snippet = '';
      if (s.title.toLowerCase().includes(q)) snippet = s.title;
      for (const m of conv.messages.values()) {
        if (snippet) break;
        for (const p of m.content) {
          if (p.type !== 'text') continue;
          const i = p.text.toLowerCase().indexOf(q);
          if (i >= 0) {
            snippet = p.text.slice(Math.max(0, i - 30), i + q.length + 50).replace(/\s+/g, ' ');
            break;
          }
        }
      }
      if (snippet) out.push({ ...s, snippet });
    }
    return out;
  }

  /** Move a conversation to the trash directory (recoverable by hand). */
  trash(id: string): void {
    const trashDir = join(this.root, 'trash');
    ensureDir(trashDir);
    const file = this.fileFor(id);
    renameSync(file, join(trashDir, basename(file)));
    try {
      unlinkSync(`${file}.lock`);
    } catch {
      /* ignore */
    }
  }

  /** Store image bytes by content hash; returns the hash. */
  saveAttachment(data: Buffer, mediaType: string): string {
    ensureDir(this.attachmentsDir);
    const hash = createHash('sha256').update(data).digest('hex');
    const p = join(this.attachmentsDir, `${hash}.${extFor(mediaType)}`);
    if (!existsSync(p)) writeFileSync(p, data, { mode: 0o600 });
    return hash;
  }

  loadAttachment(hash: string, mediaType: string): Buffer | undefined {
    try {
      return readFileSync(join(this.attachmentsDir, `${hash}.${extFor(mediaType)}`));
    } catch {
      return undefined;
    }
  }
}

export function extFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}
