// The unsent text in the input box, kept on disk so that a crash, a closed
// terminal or a killed process doesn't lose it. One small file per
// conversation ("new" for a conversation that has no file yet), written
// atomically; writes are debounced while typing and flushed on shutdown.
//
// A draft is derived, private, best-effort data: nothing fails if it can't
// be written or read, and it lives beside the conversations with the same
// permissions.

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths.js';
import type { ContentPart } from '../providers/types.js';

export interface Draft {
  text: string;
  /** Collapsed pastes ("[Pasted text #n …]" chips) by number. */
  pastes: Record<string, string>;
  /** Attachment chips ("[Image #n]", "[File: …]") and what they stand for. */
  attachments: Record<string, ContentPart>;
  counters: { paste: number; image: number; file: number };
}

const DEBOUNCE_MS = 400;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const dir = (): string => join(paths.dataDir, 'drafts');
const fileFor = (key: string): string => join(dir(), `${key.replace(/[^\w.-]/g, '_')}.json`);

let pending: { key: string; draft: Draft | null } | null = null;
let timer: NodeJS.Timeout | null = null;

function write(key: string, draft: Draft | null): void {
  try {
    const file = fileFor(key);
    if (!draft || !draft.text.trim()) {
      try {
        unlinkSync(file);
      } catch {
        /* nothing to remove */
      }
      return;
    }
    let json = JSON.stringify({ v: 1, savedAt: Date.now(), ...draft });
    // A draft with huge pastes or files: keep the text, which is what the
    // user typed; the chips then stay as plain text.
    if (json.length > MAX_BYTES) json = JSON.stringify({ v: 1, savedAt: Date.now(), text: draft.text, pastes: {}, attachments: {}, counters: draft.counters });
    if (json.length > MAX_BYTES) return;
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

/** Save (or, for an empty draft, remove) the draft for `key` soon. */
export function scheduleDraft(key: string, draft: Draft | null): void {
  if (pending && pending.key !== key) flushDrafts();
  pending = { key, draft };
  timer ??= setTimeout(flushDrafts, DEBOUNCE_MS);
  timer.unref?.();
}

/** Write any pending draft now. Synchronous: safe to call while exiting. */
export function flushDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const p = pending;
  pending = null;
  if (p) write(p.key, p.draft);
}

function isPart(p: unknown): p is ContentPart {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (o.type === 'image') return typeof o.hash === 'string' && typeof o.mediaType === 'string';
  if (o.type === 'file') return typeof o.name === 'string' && typeof o.text === 'string';
  return false;
}

export function loadDraft(key: string): Draft | null {
  try {
    const j = JSON.parse(readFileSync(fileFor(key), 'utf8')) as Record<string, unknown>;
    if (j.v !== 1 || typeof j.text !== 'string' || !j.text.trim()) return null;
    const pastes: Record<string, string> = {};
    if (j.pastes && typeof j.pastes === 'object') for (const [k, v] of Object.entries(j.pastes)) if (typeof v === 'string') pastes[k] = v;
    const attachments: Record<string, ContentPart> = {};
    if (j.attachments && typeof j.attachments === 'object') for (const [k, v] of Object.entries(j.attachments)) if (isPart(v)) attachments[k] = v;
    const c = (j.counters ?? {}) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    return { text: j.text, pastes, attachments, counters: { paste: n(c.paste), image: n(c.image), file: n(c.file) } };
  } catch {
    return null;
  }
}

/** Remove drafts nobody came back for. Called once at start-up. */
export function pruneDrafts(now = Date.now()): void {
  try {
    for (const f of readdirSync(dir())) {
      const p = join(dir(), f);
      // Old drafts, and temporary files left by a process that died mid-write.
      if (now - statSync(p).mtimeMs > (f.endsWith('.tmp') ? 60_000 : MAX_AGE_MS)) unlinkSync(p);
    }
  } catch {
    /* no drafts directory yet */
  }
}
