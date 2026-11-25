// Repairing conversations hit by the 0.0.1–0.2.0 crash bug: the cases a review
// of the first repair found wrong. The old readers are the real ones, from
// the releases (test/fixtures/old-readers).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Run "another process" at a chosen moment of Store.open(): just before it
// creates the lock file, or just before it reads the conversation.
const hook: { beforeLock?: () => void; beforeRead?: () => void } = {};
function fire(k: 'beforeLock' | 'beforeRead'): void {
  const f = hook[k];
  hook[k] = undefined;
  f?.();
}
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof Fs>();
  return {
    ...real,
    openSync: (...a: Parameters<typeof real.openSync>) => {
      if (String(a[0]).endsWith('.lock')) fire('beforeLock');
      return real.openSync(...a);
    },
    readFileSync: (...a: Parameters<typeof real.readFileSync>) => {
      if (String(a[0]).endsWith('.jsonl')) fire('beforeRead');
      return real.readFileSync(...a);
    },
  };
});

const { Store, replay, scanForRepairs, ConversationLockedError } = await import('../../src/core/store.js');
const { repairNotice } = await import('../../src/core/session.js');
const { replay: replay020 } = await import('../fixtures/old-readers/v020/store.js');
const { replay: replay010 } = await import('../fixtures/old-readers/v010/store.js');
const { replay: replay001 } = await import('../fixtures/old-readers/v001/store.js');

const msg = (id: string, parentId: string | null, role: string, text: string, ts: number) => ({ type: 'message', id, parentId, role, content: [{ type: 'text', text }], ts });
const lines = (ev: object[]) => ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ids = (c: { path(): Array<{ id: string }> }) => c.path().map((m) => m.id);
type Ev = { type: string; id?: string | null; ts?: number; interrupted?: boolean };
/** The events of a file (a torn line is skipped, as every reader does). */
const parse = (t: string) =>
  t.split('\n').flatMap((l): Ev[] => {
    try {
      return l ? [JSON.parse(l) as Ev] : [];
    } catch {
      return [];
    }
  });

function newStore() {
  const root = mkdtempSync(join(tmpdir(), 'taria-review-'));
  mkdirSync(join(root, 'conversations'), { recursive: true });
  return { root, store: new Store(root), dir: join(root, 'conversations') };
}

/** One lost reply (a1); the conversation went on to a2. */
const hit = (ID: string, t = 1) =>
  lines([
    { type: 'meta', v: 1, id: ID, createdAt: t, app: 'parley' },
    msg('u1', null, 'user', 'q1', t),
    { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: t + 1 },
    { type: 'delta', id: 'a1', text: 'cut off' },
    msg('u2', 'a1', 'user', 'q2', t + 2),
    { type: 'partial', id: 'a2', parentId: 'u2', model: 'mock/echo', ts: t + 3 },
    { type: 'delta', id: 'a2', text: 'answer 2' },
    msg('a2', 'u2', 'assistant', 'answer 2', t + 3),
  ]);

describe('F1: the user rewound to the very start (head: null)', () => {
  it('the repair appends `head: null`, so every older reader still opens at the start', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-aaaa';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(
      file,
      lines([
        { type: 'meta', v: 1, id: ID, createdAt: 1, app: 'parley' },
        msg('u1', null, 'user', 'first question', 1),
        { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 2 },
        { type: 'delta', id: 'a1', text: 'cut off' },
        msg('u2', 'a1', 'user', 'second question', 3),
        { type: 'partial', id: 'a2', parentId: 'u2', model: 'mock/echo', ts: 4 },
        { type: 'delta', id: 'a2', text: 'second answer' },
        msg('a2', 'u2', 'assistant', 'second answer', 5),
        // /rewind to the first message: "start over from an empty conversation"
        { type: 'head', id: null, ts: 6 },
      ]),
    );
    const before = readFileSync(file, 'utf8');
    for (const rp of [replay, replay020, replay010, replay001]) expect(rp(ID, before).conv.headId).toBe(null);

    const f = store.open(ID);
    f.releaseLock();
    expect(f.repaired).toBe(1);
    expect(f.conv.headId).toBe(null);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(parse(after.slice(before.length)).map((e) => `${e.type}:${e.id}`)).toEqual(['message:a1', 'head:null']);
    // The head is where the user left it, for every reader.
    for (const rp of [replay, replay020, replay010, replay001]) {
      const c = rp(ID, after).conv;
      expect(c.headId).toBe(null);
      expect(ids(c)).toEqual([]);
      expect(c.messages.has('a1')).toBe(true); // and the reply is recorded
    }
  });
});

describe('F2: what doctor says was hidden', () => {
  it('counts what the old reader hid: everything up to the last lost reply on the path', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-bbbb';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(
      file,
      lines([
        { type: 'meta', v: 1, id: ID, createdAt: 1, app: 'parley' },
        msg('u1', null, 'user', 'the very first question', 1),
        { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 2 },
        { type: 'delta', id: 'a1', text: 'the answer that was cut off' },
        msg('u2', 'a1', 'user', 'question after the crash', 3),
        { type: 'partial', id: 'a2', parentId: 'u2', model: 'mock/echo', ts: 4 },
        { type: 'delta', id: 'a2', text: 'answer after the crash' },
        msg('a2', 'u2', 'assistant', 'answer after the crash', 4),
        msg('u3', 'a2', 'user', 'one more', 5),
        { type: 'partial', id: 'a3', parentId: 'u3', model: 'mock/echo', ts: 6 },
        { type: 'delta', id: 'a3', text: 'cut off as well' },
        msg('u4', 'a3', 'user', 'and the last question', 7),
        { type: 'partial', id: 'a4', parentId: 'u4', model: 'mock/echo', ts: 8 },
        { type: 'delta', id: 'a4', text: 'and the last answer' },
        msg('a4', 'u4', 'assistant', 'and the last answer', 8),
      ]),
    );
    const text = readFileSync(file, 'utf8');
    const oldView = ids(replay020(ID, text).conv);
    const newView = ids(replay(ID, text).conv);
    expect(oldView).toEqual(['u4', 'a4']);
    expect(newView).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    expect(scanForRepairs(store)[0]).toMatchObject({ lost: 2, hidden: newView.length - oldView.length });
    expect(scanForRepairs(store)[0]).toMatchObject({ lost: 2, hidden: 6 });
  });

  it('a lost reply on a branch the user left hid nothing of what shows: hidden is 0, and no text claims otherwise', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-cccc';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(
      file,
      lines([
        { type: 'meta', v: 1, id: ID, createdAt: 1, app: 'parley' },
        msg('u1', null, 'user', 'q', 1),
        { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: 2 },
        { type: 'delta', id: 'a1', text: 'cut off' },
        msg('u2', 'a1', 'user', 'q2', 3),
        { type: 'head', id: null, ts: 4 }, // rewound to the start, new branch:
        msg('u1b', null, 'user', 'q again', 5),
        { type: 'partial', id: 'a1b', parentId: 'u1b', model: 'mock/echo', ts: 6 },
        { type: 'delta', id: 'a1b', text: 'answer' },
        msg('a1b', 'u1b', 'assistant', 'answer', 6),
      ]),
    );
    const text = readFileSync(file, 'utf8');
    // The old reader showed the same messages as the new one: nothing was hidden.
    expect(ids(replay020(ID, text).conv)).toEqual(ids(replay(ID, text).conv));
    expect(scanForRepairs(store)).toEqual([{ id: ID, title: undefined, lost: 1, hidden: 0 }]);
    // The notice shown on opening does not know which case it is, so it must
    // not state that messages were hidden.
    for (const n of [1, 2]) {
      expect(repairNotice(n)).toMatch(/^Repaired this conversation: /);
      expect(repairNotice(n)).not.toMatch(/which hid|shows again/);
    }
  });
});

describe('F3: a repair is bookkeeping, not activity: it never reorders the list', () => {
  const jan = Date.UTC(2025, 0, 1) / 1000;
  const nov = Date.UTC(2025, 10, 20) / 1000;
  const OLD = '20250101-090000-0001';
  const NEW = '20251120-090000-0002';
  function twoConversations(oldText: string) {
    const s = newStore();
    const oldFile = join(s.dir, `${OLD}.jsonl`);
    const newFile = join(s.dir, `${NEW}.jsonl`);
    writeFileSync(oldFile, oldText);
    writeFileSync(newFile, lines([{ type: 'meta', v: 1, id: NEW, createdAt: nov * 1000, app: 'taria' }, msg('u1', null, 'user', 'what I was working on yesterday', nov * 1000), msg('a1', 'u1', 'assistant', 'answer', nov * 1000)]));
    utimesSync(oldFile, jan, jan + 60);
    utimesSync(newFile, nov, nov);
    return { ...s, oldFile };
  }

  it('after `doctor repair`, list()[0] (what `taria -c` continues) is still the newest conversation', () => {
    const { store, oldFile } = twoConversations(hit(OLD, jan * 1000));
    const listedBefore = store.list();
    expect(listedBefore.map((s) => s.id)).toEqual([NEW, OLD]);
    const updatedBefore = replay(OLD, readFileSync(oldFile, 'utf8')).conv.updatedAt;
    // What `taria doctor repair` does for each hit:
    for (const h of scanForRepairs(store)) {
      const f = store.open(h.id);
      f.releaseLock();
      expect(f.repaired).toBe(1);
    }
    const listed = store.list();
    expect(listed.map((s) => s.id)).toEqual([NEW, OLD]);
    expect(listed.map((s) => s.updatedAt)).toEqual(listedBefore.map((s) => s.updatedAt));
    // Both inputs of the ranking are as they were: the stored time ...
    const after = readFileSync(oldFile, 'utf8');
    expect(replay(OLD, after).conv.updatedAt).toBe(updatedBefore);
    expect(parse(after).at(-1)).toEqual({ type: 'head', id: 'a2', ts: updatedBefore });
    for (const rp of [replay020, replay010, replay001]) expect(rp(OLD, after).conv.updatedAt).toBeLessThanOrEqual(updatedBefore);
    // ... and the file's modification time.
    expect(statSync(oldFile).mtimeMs).toBe((jan + 60) * 1000);
    // The listing still sees the new lines (its cache is keyed on the size too).
    expect(store.list().map((s) => s.id)).toEqual([NEW, OLD]);
  });

  it('opening a conversation that needs settling (a reply cut off by a crash, a torn line) does not reorder either', () => {
    const crashed = lines([
      { type: 'meta', v: 1, id: OLD, createdAt: jan * 1000, app: 'taria' },
      msg('u1', null, 'user', 'q', jan * 1000),
      { type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/echo', ts: jan * 1000 + 1 },
      { type: 'delta', id: 'a1', text: 'cut off by the crash' },
    ]);
    const { store, oldFile } = twoConversations(crashed + '{"type":"delta","id":"a1","te');
    const listedBefore = store.list();
    expect(listedBefore.map((s) => s.id)).toEqual([NEW, OLD]);
    const f = store.open(OLD);
    f.releaseLock();
    expect(parse(readFileSync(oldFile, 'utf8')).at(-1)).toMatchObject({ type: 'message', id: 'a1', interrupted: true });
    expect(statSync(oldFile).mtimeMs).toBe((jan + 60) * 1000);
    expect(store.list()).toEqual(listedBefore);
  });

  it('writing to the conversation afterwards does move it to the top', () => {
    const { store } = twoConversations(hit(OLD, jan * 1000));
    const f = store.open(OLD);
    f.append({ type: 'message', id: 'u3', parentId: 'a2', role: 'user', content: [{ type: 'text', text: 'back to this' }], ts: Date.now() });
    f.releaseLock();
    expect(store.list().map((s) => s.id)).toEqual([OLD, NEW]);
  });
});

describe('F4: Store.open() takes the lock before it reads the file', () => {
  it('a reply the other window finished just before it released the lock stays whole', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-dddd';
    const file = join(dir, `${ID}.jsonl`);
    // Window A (holding the lock) is streaming a2.
    writeFileSync(
      file,
      lines([
        { type: 'meta', v: 1, id: ID, createdAt: 1, app: 'taria' },
        msg('u1', null, 'user', 'q1', 1),
        msg('a1', 'u1', 'assistant', 'answer 1', 2),
        msg('u2', 'a1', 'user', 'q2', 3),
        { type: 'partial', id: 'a2', parentId: 'u2', model: 'mock/echo', ts: 4 },
        { type: 'delta', id: 'a2', text: 'The first words' },
      ]),
    );
    // Process B calls open(). Before it creates the lock, A finishes the
    // reply, the user asks one more thing, and A exits (lock released).
    const rest = lines([{ type: 'delta', id: 'a2', text: ' and then the whole rest of the answer.' }, msg('a2', 'u2', 'assistant', 'The first words and then the whole rest of the answer.', 5), msg('u3', 'a2', 'user', 'q3', 6), msg('a3', 'u3', 'assistant', 'answer 3', 7)]);
    const whole = readFileSync(file, 'utf8') + rest;
    hook.beforeLock = () => appendFileSync(file, rest);
    const f = store.open(ID);
    f.releaseLock();
    expect(hook.beforeLock).toBeUndefined(); // it ran
    // Nothing was appended: there was nothing to settle.
    expect(readFileSync(file, 'utf8')).toBe(whole);
    // B's own view is the current one.
    expect(ids(f.conv)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(f.conv.messages.get('a2')).toMatchObject({ content: [{ type: 'text', text: 'The first words and then the whole rest of the answer.' }] });
    expect(f.conv.messages.get('a2')!.interrupted).toBeUndefined();
  });

  it('with a lost reply in the file: the head appended is the current one, not a stale one', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-eeee';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, hit(ID));
    hook.beforeLock = () => appendFileSync(file, lines([msg('u3', 'a2', 'user', 'q3', 5), msg('a3', 'u3', 'assistant', 'answer 3', 6)]));
    const f = store.open(ID); // `doctor repair`, or opening the conversation
    f.releaseLock();
    expect(f.repaired).toBe(1);
    const text = readFileSync(file, 'utf8');
    expect(parse(text).at(-1)).toMatchObject({ type: 'head', id: 'a3' });
    for (const rp of [replay, replay020, replay010, replay001]) expect(ids(rp(ID, text).conv)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(ids(f.conv)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  });

  it('the file is read only once the lock is held', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-abcd';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, hit(ID));
    let lockedAtRead: boolean | undefined;
    hook.beforeRead = () => {
      lockedAtRead = statSync(`${file}.lock`, { throwIfNoEntry: false }) !== undefined;
    };
    store.open(ID).releaseLock();
    expect(lockedAtRead).toBe(true);
    // Without the lock nothing is locked or written.
    const before = readFileSync(file, 'utf8');
    hook.beforeRead = () => {
      lockedAtRead = statSync(`${file}.lock`, { throwIfNoEntry: false }) !== undefined;
    };
    store.open(ID, { lock: false });
    expect(lockedAtRead).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(`${file}.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('locked by a live process: open throws, nothing is written, the lock stays', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-ffff';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, hit(ID) + '{"type":"delta","id":"zz","te'); // a torn line as well
    const lock = JSON.stringify({ pid: process.ppid });
    writeFileSync(`${file}.lock`, lock);
    const before = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    expect(() => store.open(ID)).toThrow(ConversationLockedError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(lock);
    expect(scanForRepairs(store).length).toBe(1);
  });

  it('a conversation that does not exist: open throws and leaves no lock file behind', () => {
    const { store, dir } = newStore();
    expect(() => store.open('20250601-120000-none')).toThrow(/ENOENT/);
    expect(statSync(join(dir, '20250601-120000-none.jsonl.lock'), { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe('repairs that were already right', () => {
  it('torn last line + lost reply + unknown future events; then idempotent', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-9999';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, hit(ID) + JSON.stringify({ type: 'tool_call', id: 't1', parentId: 'a2', whatever: [1, 2] }) + '\n' + JSON.stringify({ type: 'partial', id: 'a3', parentId: 'u2', ts: 9 }) + '\n' + '{"type":"delta","id":"a3","te');
    const before = readFileSync(file, 'utf8');
    const f = store.open(ID);
    f.releaseLock();
    expect(f.repaired).toBe(1);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(parse(after.slice(before.length)).map((e) => `${e.type}:${e.id}`)).toEqual(['message:a1', 'head:a2']);
    expect(after.slice(before.length).startsWith('\n')).toBe(true);
    expect(ids(replay(ID, after).conv)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(ids(replay020(ID, after).conv)).toEqual(['u1', 'a1', 'u2', 'a2']);
    const g = store.open(ID);
    g.releaseLock();
    expect(g.repaired).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('empty file, and a healthy file: nothing appended', () => {
    const { store, dir } = newStore();
    const E = '20250601-120000-0000';
    writeFileSync(join(dir, `${E}.jsonl`), '');
    const f = store.open(E);
    f.releaseLock();
    expect(f.repaired).toBe(0);
    expect(readFileSync(join(dir, `${E}.jsonl`), 'utf8')).toBe('');
    const H = '20250601-120000-0001';
    const healthy = lines([{ type: 'meta', v: 1, id: H, createdAt: 1, app: 'taria' }, msg('u1', null, 'user', 'q', 1), msg('a1', 'u1', 'assistant', 'a', 2), { type: 'head', id: 'u1', ts: 3 }]);
    writeFileSync(join(dir, `${H}.jsonl`), healthy);
    store.open(H).releaseLock();
    expect(readFileSync(join(dir, `${H}.jsonl`), 'utf8')).toBe(healthy);
  });

  it('compaction after the crash, and a retry of the lost reply', () => {
    const { store, dir } = newStore();
    const ID = '20250601-120000-1111';
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(
      file,
      hit(ID) +
        lines([
          { type: 'message', id: 's1', parentId: 'a2', role: 'summary', content: [{ type: 'text', text: 'summary' }], ts: 5 },
          msg('u3', 's1', 'user', 'q3', 6),
          msg('a3', 'u3', 'assistant', 'answer 3', 7),
        ]),
    );
    const f = store.open(ID);
    f.releaseLock();
    expect(f.repaired).toBe(1);
    expect(ids(f.conv)).toEqual(['u1', 'a1', 'u2', 'a2', 's1', 'u3', 'a3']);
    expect(f.conv.context().map((m) => m.id)).toEqual(['s1', 'u3', 'a3']);
    expect(ids(replay020(ID, readFileSync(file, 'utf8')).conv)).toEqual(['u1', 'a1', 'u2', 'a2', 's1', 'u3', 'a3']);

    const R = '20250601-120000-2222';
    const rf = join(dir, `${R}.jsonl`);
    // u2 hangs off a1; then the user rewound to u2 and retried u1.
    writeFileSync(rf, hit(R) + lines([{ type: 'head', id: 'a1', ts: 5 }, { type: 'head', id: 'u1', ts: 6 }, { type: 'partial', id: 'a1b', parentId: 'u1', ts: 7 }, { type: 'delta', id: 'a1b', text: 'retry' }, msg('a1b', 'u1', 'assistant', 'retry', 8)]));
    const g = store.open(R);
    g.releaseLock();
    expect(g.repaired).toBe(1);
    expect(ids(g.conv)).toEqual(['u1', 'a1b']);
    expect(g.conv.siblings(g.conv.messages.get('a1b')!).map((m) => m.id).sort()).toEqual(['a1', 'a1b']);
    expect(ids(replay020(R, readFileSync(rf, 'utf8')).conv)).toEqual(['u1', 'a1b']);
  });
});
