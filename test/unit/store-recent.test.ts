// Store.recent(n): the start screen's latest conversations, without reading
// every summary. It must agree with list() on what is newest.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/core/store.js';

function store(n: number): { s: Store; dir: string; write: (i: number, at: number, title?: string, empty?: boolean) => void } {
  const root = mkdtempSync(join(tmpdir(), 'taria-recent-'));
  const dir = join(root, 'conversations');
  mkdirSync(dir);
  const write = (i: number, at: number, title?: string, empty?: boolean) => {
    const id = `20260101-${String(i).padStart(6, '0')}-rcnt`;
    const lines: object[] = [{ type: 'meta', v: 1, id, createdAt: at, app: 'taria' }];
    if (!empty) lines.push({ type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: `question ${i}` }], ts: at });
    if (title) lines.push({ type: 'title', title });
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(join(dir, `${id}.jsonl`), at / 1000, at / 1000);
  };
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) write(i, base + ((i * 7919) % n) * 60_000, `Conversation ${i}`);
  return { s: new Store(root), dir, write };
}

describe('Store.recent()', () => {
  it('returns the same newest conversations as list(), with and without the summary cache', () => {
    const { s } = store(200);
    const first = s.recent(3); // no cache yet
    expect(first).toEqual(s.list().slice(0, 3));
    expect(s.recent(3)).toEqual(s.list().slice(0, 3)); // with the cache list() wrote
  });

  it('a conversation changed since the cache was written is read again, and moves to the top', () => {
    const { s, dir } = store(50);
    s.list();
    const id = '20260101-000007-rcnt';
    appendFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'title', title: 'Renamed just now' }) + '\n');
    const r = s.recent(3);
    expect(r[0]!.id).toBe(id);
    expect(r[0]!.title).toBe('Renamed just now');
    expect(r).toEqual(s.list().slice(0, 3));
  });

  it('skips conversations without messages, and an empty or missing folder gives nothing', () => {
    const { s, write } = store(5);
    write(99, Date.UTC(2027, 0, 1), undefined, true); // newest, but empty
    expect(s.recent(3).map((c) => c.id)).not.toContain('20260101-000099-rcnt');
    expect(s.recent(3)).toEqual(s.list().slice(0, 3));
    expect(new Store(mkdtempSync(join(tmpdir(), 'taria-none-'))).recent(3)).toEqual([]);
  });

  it('does not write the summary cache (start-up stays read-only)', () => {
    const { s, dir } = store(5);
    s.recent(3);
    expect(existsSync(join(dir, '..', 'summary-cache.json'))).toBe(false);
  });
});
