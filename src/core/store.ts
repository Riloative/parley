// Append-only JSONL persistence. Every event is written (synchronously, one
// line, O_APPEND) the moment it happens, so a crash or closed terminal loses
// at most the last fraction of a second of a streaming reply. A per-file lock
// stops two taria instances from writing the same conversation.

import { APP } from '../brand.js';
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
  utimesSync,
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
  /** `app` is "taria", or "parley" in files written before the rename. */
  | { type: 'meta'; v: number; id: string; createdAt: number; app: 'taria' | 'parley'; cwd?: string }
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

/** Locks written by taria 0.0.1 hold just the PID. */
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
export function holderAlive(info: LockInfo): boolean {
  if (!pidAlive(info.pid)) return false;
  if (info.started === undefined) return true;
  const started = processStart(info.pid);
  // ps resolution is a second; allow generous slack for clock adjustments.
  return started === undefined || Math.abs(started - info.started) < 10_000;
}

export class ConversationLockedError extends Error {
  constructor(readonly pid: number) {
    super(`This conversation is open in another taria window (pid ${pid}).`);
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
export function replay(id: string, text: string): { conv: Conversation; partial?: StoredMessage; lost: StoredMessage[] } {
  const conv = new Conversation(id);
  const partials = new Map<string, StoredMessage>();
  const hasChildren = new Set<string>();
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
        // A reply recorded after the conversation had already gone on from it
        // (a recovered partial): it is not the newest message, so the head
        // stays where it was.
        const keep = hasChildren.has(m.id) ? conv.headId : undefined;
        conv.add(m);
        if (keep !== undefined) conv.headId = keep;
        if (m.parentId) hasChildren.add(m.parentId);
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
  // Cut-off replies that the conversation went on from. parley 0.0.1 to 0.2.0
  // recovered only the last partial and never recorded it, so once the
  // conversation continued, everything before such a reply was hidden. Their
  // lines are all here: recover them, without moving the head.
  const tip = conv.headId;
  const lost: StoredMessage[] = [];
  for (const [pid, p] of partials) {
    if (!hasChildren.has(pid) || conv.messages.has(pid)) continue;
    conv.add(p);
    lost.push(p);
  }
  conv.headId = tip;
  let partial: StoredMessage | undefined;
  if (lastPartial && partials.has(lastPartial) && !hasChildren.has(lastPartial)) {
    partial = partials.get(lastPartial)!;
    // A reply that was streaming when the process died, with nothing after
    // it: recover what arrived, as the newest message.
    if (partial.content.length) conv.add(partial);
  }
  return { conv, partial, lost };
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
  /** Replies lost to the 0.0.1–0.2.0 crash bug that opening this file recorded. */
  repaired = 0;

  constructor(
    readonly file: string,
    readonly conv: Conversation,
  ) {
    this.lockPath = `${file}.lock`;
  }

  get id(): string {
    return this.conv.id;
  }

  /** Returns false when this process held the lock already. */
  acquireLock(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ pid: process.pid, started: Math.round(ownStart()) }));
        closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const info = parseLock(readFileSafe(this.lockPath));
        if (info.pid === process.pid) return false;
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

/**
 * Put a file's modification time back after appending bookkeeping lines.
 *
 * list() ranks by the later of the stored time and the file's mtime (the
 * mtime covers events that carry no time, and whatever older versions
 * wrote), so both must stay as they were, or a months-old conversation that
 * was merely repaired becomes the one `-c` continues. Only called with the
 * lock held, so no other window's write is dated back. The summary cache
 * still notices the new lines: it is keyed on the size and change time too.
 */
function keepMtime(file: string, mtimeMs: number): void {
  try {
    utimesSync(file, statSync(file).atimeMs / 1000, mtimeMs / 1000);
  } catch {
    /* not ours to change (another owner's file): only the order is affected */
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

interface CachedSummary {
  size: number;
  mtimeMs: number;
  /** Change time and inode: a rewrite that keeps size and mtime (a restore,
   * a sync tool) still changes one of them. */
  ctimeMs: number;
  ino: number;
  title: string;
  model?: string;
  updatedAt: number;
  messageCount: number;
}

const SUMMARY_CACHE_VERSION = 2;

function summarize(conv: Conversation): Omit<CachedSummary, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino'> {
  const path = conv.path();
  const first = path.find((m) => m.role === 'user');
  const firstText = first?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
  return {
    title: conv.title ?? (firstText.split('\n')[0]?.slice(0, 80) || '(untitled)'),
    model: conv.model ?? [...path].reverse().find((m) => m.model)?.model,
    updatedAt: conv.updatedAt,
    messageCount: conv.messageCount,
  };
}

function validCached(c: unknown): c is CachedSummary {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.size === 'number' &&
    typeof o.mtimeMs === 'number' &&
    typeof o.ctimeMs === 'number' &&
    typeof o.ino === 'number' &&
    typeof o.title === 'string' &&
    (o.model === undefined || typeof o.model === 'string') &&
    typeof o.updatedAt === 'number' &&
    typeof o.messageCount === 'number'
  );
}

function readSummaryCache(path: string): Record<string, CachedSummary> {
  const out: Record<string, CachedSummary> = {};
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; entries?: Record<string, unknown> };
    if (j?.v !== SUMMARY_CACHE_VERSION || !j.entries || typeof j.entries !== 'object') return out;
    for (const [id, c] of Object.entries(j.entries)) if (validCached(c)) out[id] = c;
  } catch {
    /* missing or damaged: rebuilt from the conversation files */
  }
  return out;
}

function writeSummaryCache(path: string, entries: Record<string, CachedSummary>): void {
  // Write a temporary file and rename it over the cache, so a concurrent
  // reader sees either the old or the new cache, never half of one.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: SUMMARY_CACHE_VERSION, entries }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
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
    cf.append({ type: 'meta', v: SCHEMA_VERSION, id, createdAt: conv.createdAt, app: APP, cwd });
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
    if (opts.lock === false) return new ConversationFile(file, replay(id, readFileSync(file, 'utf8')).conv);
    // The lock comes first, and the file is read only once it is held: what
    // is appended below is decided from the file's contents, and a window
    // that held the lock a moment ago may have finished a reply or gone on
    // since. (Read before locking, its finished reply would be recorded again
    // as the cut-off beginning it was, and the later line wins.)
    const lock = new ConversationFile(file, new Conversation(id));
    const fresh = lock.acquireLock();
    try {
      const text = readFileSync(file, 'utf8');
      const { conv, partial, lost } = replay(id, text);
      const cf = new ConversationFile(file, conv);
      // Settling is bookkeeping, not activity: the file keeps its
      // modification time (see keepMtime), and the head event below carries
      // no new time, so the conversation stays where it was in list().
      const mtimeMs = statSync(file).mtimeMs;
      let appended = false;
      try {
        // This process will append to the file. Two leftovers of a crash must
        // be settled first, by appending (nothing is rewritten):
        // - a torn last line: without a newline after it, the next event
        //   would be glued to the fragment and lost with it;
        // - a reply that was streaming: replay recovers only the *last*
        //   partial, so once the conversation continued it would be dropped,
        //   and every later message would hang off a parent that no longer
        //   exists. Recording it as an (interrupted) message keeps it.
        appended = (!!text && !text.endsWith('\n')) || !!partial?.content.length || lost.length > 0;
        if (text && !text.endsWith('\n')) appendFileSync(file, '\n', { mode: 0o600 });
        if (partial?.content.length) cf.append({ type: 'message', ...partial });
        // Replies lost to the 0.0.1–0.2.0 crash bug: recorded the same way, so
        // the file is whole for every reader.
        for (const m of lost) cf.append({ type: 'message', ...m });
        cf.repaired = lost.length;
        // Older readers move the head to the last message they read: point it
        // back at the real tip, which is `null` when the user had rewound to
        // the very start. The time is the conversation's own, not now.
        if (lost.length) cf.append({ type: 'head', id: conv.headId, ts: conv.updatedAt });
      } finally {
        if (appended) keepMtime(file, mtimeMs);
      }
      return cf;
    } catch (e) {
      // Not this call's lock to give up if the process held it before.
      if (fresh) lock.releaseLock();
      throw e;
    }
  }

  /**
   * All conversations, most recently updated first.
   *
   * Summaries are cached in `summary-cache.json`, keyed by each file's size,
   * modification and change time and inode
   * and modification time, so with a long history only conversations that
   * changed since the last listing are read again (about 130 ms saved for
   * 1,000 conversations, on every `-c` and `/resume`). Files are only ever
   * appended to, so a size or mtime change catches every write. The cache is
   * derived data: it is rebuilt when missing or unreadable, written
   * atomically, and nothing depends on it being current.
   */
  list(): ConversationSummary[] {
    if (!existsSync(this.conversationsDir)) return [];
    const cachePath = join(this.root, 'summary-cache.json');
    const cache = readSummaryCache(cachePath);
    const next: Record<string, CachedSummary> = {};
    let changed = false;
    const out: ConversationSummary[] = [];
    for (const f of readdirSync(this.conversationsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(this.conversationsDir, f);
      const id = f.slice(0, -'.jsonl'.length);
      try {
        // Stat before reading: a write in between makes the next listing
        // see a different size and read the file again.
        const st = statSync(file);
        let c = cache[id];
        if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs || c.ctimeMs !== st.ctimeMs || c.ino !== st.ino) {
          c = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, ...summarize(replay(id, readFileSync(file, 'utf8')).conv) };
          changed = true;
        }
        next[id] = c;
        if (c.messageCount === 0) continue;
        out.push({ id, title: c.title, model: c.model, updatedAt: Math.max(c.updatedAt, st.mtimeMs), messageCount: c.messageCount, file });
      } catch {
        /* unreadable file: skip */
      }
    }
    if (changed || Object.keys(cache).length !== Object.keys(next).length) writeSummaryCache(cachePath, next);
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

/** Conversations hit by the 0.0.1–0.2.0 crash bug and not repaired yet:
 * `lost` cut-off replies that were never recorded, and the `hidden` messages
 * the old versions stopped showing because of them (0 when every lost reply
 * is on a branch the user left). Reads only. */
export function scanForRepairs(store: Store): Array<{ id: string; title?: string; lost: number; hidden: number }> {
  const out: Array<{ id: string; title?: string; lost: number; hidden: number }> = [];
  let names: string[];
  try {
    names = readdirSync(store.conversationsDir);
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -'.jsonl'.length);
    let text: string;
    try {
      text = readFileSync(join(store.conversationsDir, n), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('"partial"')) continue; // the common case, cheaply
    const { conv, lost } = replay(id, text);
    if (!lost.length) continue;
    // What the old reading hid: it walked back from the newest message and
    // stopped at the first reply it did not have, so everything up to and
    // including the *last* lost reply on the current path was missing.
    const lastLost = conv.path().findLastIndex((m) => lost.includes(m));
    out.push({ id, title: conv.title, lost: lost.length, hidden: lastLost + 1 });
  }
  return out;
}
