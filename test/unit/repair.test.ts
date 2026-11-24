// Conversations hit by the crash bug in parley 0.0.1 to 0.2.0: a reply that
// was streaming when the process died, then the conversation continued. The
// old code recovered only the last partial reply, so once a later one
// existed, the conversation opened at the first message after the crash.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, replay, scanForRepairs } from '../../src/core/store.js';

const ID = '20250601-120000-dead';
const text = (role: string, t: string) => ({ role, content: [{ type: 'text', text: t }] });

/** The lines a 0.1.0/0.2.0 parley wrote: crash mid-reply (a1), resumed, the
 * user went on (u2 -> a1), and a later reply was cut off too (a3). */
function hitFile(dir: string, opts: { twice?: boolean } = {}): string {
  const ev = [
    { type: 'meta', v: 1, id: ID, createdAt: 1, app: 'parley' },
    { type: 'message', id: 'u1', parentId: null, ...text('user', 'first question'), ts: 1 },
    { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 2 },
    { type: 'delta', id: 'a1', reasoning: 'thinking ' },
    { type: 'delta', id: 'a1', text: 'An answer that was ' },
    { type: 'delta', id: 'a1', text: 'cut off' },
    // The process died here. parley was restarted and resumed; it showed a1
    // (recovered in memory) but never wrote it as a message.
    { type: 'message', id: 'u2', parentId: 'a1', ...text('user', 'second question'), ts: 3 },
    { type: 'message', id: 'a2', parentId: 'u2', ...text('assistant', 'second answer'), ts: 4, model: 'mock/echo' },
    ...(opts.twice
      ? [
          { type: 'message', id: 'u3', parentId: 'a2', ...text('user', 'third question'), ts: 5 },
          { type: 'partial', id: 'a3', parentId: 'u3', model: 'mock/echo', ts: 6 },
          { type: 'delta', id: 'a3', text: 'also cut off' },
          { type: 'message', id: 'u4', parentId: 'a3', ...text('user', 'fourth question'), ts: 7 },
          { type: 'partial', id: 'a4', parentId: 'u4', model: 'mock/echo', ts: 8 },
          { type: 'delta', id: 'a4', text: 'the reply being written when it last stopped' },
        ]
      : []),
  ];
  const file = join(dir, `${ID}.jsonl`);
  writeFileSync(file, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const pathOf = (conv: ReturnType<typeof replay>['conv']) => conv.path().map((m) => m.id);

describe('conversations hit by the 0.0.1–0.2.0 crash bug', () => {
  it('open with their whole history, the cut-off reply marked as interrupted', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-repair-')));
    store.create().releaseLock(); // makes the folder
    const file = hitFile(store.conversationsDir);
    const { conv } = replay(ID, readFileSync(file, 'utf8'));
    expect(pathOf(conv)).toEqual(['u1', 'a1', 'u2', 'a2']);
    const a1 = conv.messages.get('a1')!;
    expect(a1.interrupted).toBe(true);
    expect(a1.content).toMatchObject([{ type: 'reasoning', text: 'thinking ' }, { type: 'text', text: 'An answer that was cut off' }]);
  });

  it('opening one for writing records each lost reply as a message, once, without touching earlier lines', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-repair-')));
    store.create().releaseLock();
    const file = hitFile(store.conversationsDir, { twice: true });
    const before = readFileSync(file, 'utf8');
    const f = store.open(ID);
    expect(f.repaired).toBe(2); // a1 and a3; a4 is the ordinary last partial
    expect(pathOf(f.conv)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    f.releaseLock();
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length).trim().split('\n').map((l) => JSON.parse(l) as { type: string; id: string; interrupted?: boolean });
    // The lost replies, the ordinary last partial, and the head put back on
    // the newest message (older readers move it to the last line they read).
    expect(added.map((e) => `${e.type}:${e.id}`)).toEqual(['message:a4', 'message:a1', 'message:a3', 'head:a4']);
    expect(added.filter((e) => e.type === 'message').every((e) => e.interrupted)).toBe(true);
    // An older reader, which recovers only the last partial, now sees it all.
    expect(pathOf(oldReplay(after))).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    // Opening again adds nothing.
    const g = store.open(ID);
    expect(g.repaired).toBe(0);
    g.releaseLock();
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('reading without the lock (doctor, -p -c listing) changes nothing; the scan finds them', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-repair-')));
    store.create().releaseLock();
    const file = hitFile(store.conversationsDir);
    const before = readFileSync(file, 'utf8');
    expect(store.open(ID, { lock: false }).repaired).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(scanForRepairs(store)).toEqual([{ id: ID, title: undefined, lost: 1, hidden: 2 }]);
    store.open(ID).releaseLock();
    expect(scanForRepairs(store)).toEqual([]);
  });

  it('a file 0.2.0 already wrote the recovered reply into (at the end) opens at its newest message', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-repair-')));
    store.create().releaseLock();
    const file = hitFile(store.conversationsDir);
    // parley 0.2.0 recorded the last partial when it opened the file.
    appendFileSync(file, JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'text', text: 'An answer that was cut off' }], ts: 2, interrupted: true }) + '\n');
    expect(pathOf(replay(ID, readFileSync(file, 'utf8')).conv)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(scanForRepairs(store)).toEqual([]);
  });

  it('a healthy conversation and an ordinary crash are not reported', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-repair-')));
    store.create().releaseLock();
    const file = join(store.conversationsDir, `${ID}.jsonl`);
    writeFileSync(file, [{ type: 'meta', v: 1, id: ID, createdAt: 1, app: 'taria' }, { type: 'message', id: 'u1', parentId: null, ...text('user', 'q'), ts: 1 }, { type: 'partial', id: 'a1', parentId: 'u1', model: 'm', ts: 2 }, { type: 'delta', id: 'a1', text: 'x' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    expect(scanForRepairs(store)).toEqual([]);
    appendFileSync(file, '{"type":"delta","id":"a1","te');
    expect(scanForRepairs(store)).toEqual([]);
  });
});

/** How parley 0.2.0 read a file: only the last partial is recovered. */
function oldReplay(t: string) {
  const lines = t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; id: string });
  const ids = new Set(lines.filter((l) => l.type === 'message').map((l) => l.id));
  const lastPartial = [...lines].reverse().find((l) => l.type === 'partial' && !ids.has(l.id));
  const kept = lines.filter((l) => l.type !== 'partial' || l === lastPartial);
  return replay(ID, kept.map((l) => JSON.stringify(l)).join('\n') + '\n').conv;
}
