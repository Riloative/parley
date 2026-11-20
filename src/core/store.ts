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
import { execFileSync } from 'node:child_process';
import { Conversation, type StoredMessage } from './conversation.js';
import type { ContentPart } from '../providers/types.js';
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

interface LockInfo {
  pid: number;
  /** When the holding process started (ms since epoch), to detect PID reuse. */
  started?: number;
}

/** Locks written by parley 0.0.1 hold just the PID. */
function parseLock(text: string): LockInfo {
  const t = text.trim();
  try {
    const j = JSON.parse(t) as Partial<LockInfo>;
    if (j && typeof j === 'object' && typeof j.pid === 'number') return { pid: j.pid, started: typeof j.started === 'number' ? j.started : undefined };
  } catch {
    /* legacy format */
  }
  return { pid: Number(t) || 0 };
}

const ownStart = () => Date.now() - process.uptime() * 1000;

/** Start time of another process, from `ps -o etime=` ([[dd-]hh:]mm:ss). */
function processStart(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out);
    if (!m) return undefined;
    const secs = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    return Date.now() - secs * 1000;
  } catch {
    return undefined;
  }
}

/** Whether the process that wrote a lock is still the one running. */
function holderAlive(info: LockInfo): boolean {
  if (!pidAlive(info.pid)) return false;
  if (info.started === undefined) return true;
  const started = processStart(info.pid);
  // ps resolution is a second; allow generous slack for clock adjustments.
  return started === undefined || Math.abs(started - info.started) < 10_000;
}

export class ConversationLockedError extends Error {
  constructor(readonly pid: number) {
    super(`This conversation is open in another parley window (pid ${pid}).`);
  }
}

const ROLES = new Set(['user', 'assistant', 'summary']);
const isStr = (v: unknown): v is string => typeof v === 'string';

function validPart(p: unknown): ContentPart | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  switch (o.type) {
    case 'text':
      return isStr(o.text) ? { type: 'text', text: o.text } : null;
    case 'image':
      return isStr(o.hash) && isStr(o.mediaType) ? { type: 'image', hash: o.hash, mediaType: o.mediaType, ...(isStr(o.name) ? { name: o.name } : {}) } : null;
    case 'file':
      return isStr(o.name) && isStr(o.text) ? { type: 'file', name: o.name, text: o.text } : null;
    case 'reasoning':
      return isStr(o.text)
        ? {
            type: 'reasoning',
            text: o.text,
            provider: isStr(o.provider) ? o.provider : '',
            model: isStr(o.model) ? o.model : '',
            ...(isStr(o.signature) ? { signature: o.signature } : {}),
            ...(isStr(o.redacted) ? { redacted: o.redacted } : {}),
          }
        : null;
    default:
      return null;
  }
}

/** Check an event's shape; returns null for anything that cannot be used. */
export function validEvent(raw: unknown): StoreEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case 'meta':
      return typeof e.createdAt === 'number' ? (e as unknown as StoreEvent) : null;
    case 'message': {
      if (!isStr(e.id) || !isStr(e.role) || !ROLES.has(e.role)) return null;
      if (e.parentId !== null && !isStr(e.parentId)) return null;
      const content = Array.isArray(e.content) ? e.content.map(validPart).filter((p): p is ContentPart => p !== null) : null;
      if (!content) return null;
      return { ...(e as unknown as StoredMessage), type: 'message', ts: typeof e.ts === 'number' ? e.ts : 0, content };
    }
    case 'partial':
      return isStr(e.id) && (e.parentId === null || isStr(e.parentId)) ? (e as unknown as StoreEvent) : null;
    case 'delta':
      return isStr(e.id) && (e.text === undefined || isStr(e.text)) && (e.reasoning === undefined || isStr(e.reasoning)) ? (e as unknown as StoreEvent) : null;
    case 'head':
      return e.id === null || isStr(e.id) ? (e as unknown as StoreEvent) : null;
    case 'title':
      return isStr(e.title) ? (e as unknown as StoreEvent) : null;
    case 'system':
      return e.prompt === null || isStr(e.prompt) ? (e as unknown as StoreEvent) : null;
    case 'model':
      return isStr(e.model) ? (e as unknown as StoreEvent) : null;
    default:
      return null;
  }
}

/** Replay events into a Conversation. Tolerates a truncated final line. */
export function replay(id: string, text: string): { conv: Conversation; partial?: StoredMessage } {
  const conv = new Conversation(id);
  const partials = new Map<string, StoredMessage>();
  let lastPartial: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // half-written last line after a crash
    }
    // Hand-edited, newer or damaged files: skip anything malformed rather
    // than letting it crash rendering later.
    const ev = validEvent(raw);
    if (!ev) continue;
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
        if (ev.id !== null && !conv.messages.has(ev.id) && !partials.has(ev.id)) break;
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
  if (conv.headId && !conv.messages.has(conv.headId) && !partials.has(conv.headId)) conv.headId = null;
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
        writeSync(fd, JSON.stringify({ pid: process.pid, started: Math.round(ownStart()) }));
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const info = parseLock(readFileSafe(this.lockPath));
        if (info.pid === process.pid) return;
        if (holderAlive(info)) throw new ConversationLockedError(info.pid);
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
      if (parseLock(readFileSafe(this.lockPath)).pid === process.pid) unlinkSync(this.lockPath);
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
