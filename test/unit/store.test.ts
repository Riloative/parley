import { mkdtempSync, readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Store, replay, ConversationLockedError, SCHEMA_VERSION } from '../../src/core/store.js';
import { toChatMessages, newId } from '../../src/core/conversation.js';
import { InputHistory } from '../../src/core/history.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'parley-store-'));

describe('conversation store', () => {
  it('writes a schema version and one JSON line per event', () => {
    const store = new Store(tmp());
    const f = store.create('/x');
    f.append({ type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }], ts: 1 });
    const lines = readFileSync(f.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'meta', v: SCHEMA_VERSION, app: 'parley' });
    expect(lines[1]).toMatchObject({ type: 'message', id: 'u1' });
    f.releaseLock();
  });

  it('recovers a reply that was streaming when the process died, and ignores a torn last line', () => {
    const store = new Store(tmp());
    const f = store.create();
    f.append({ type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'q' }], ts: 1 });
    f.append({ type: 'partial', id: 'a1', parentId: 'u1', model: 'mock/x', ts: 2 });
    f.append({ type: 'delta', id: 'a1', reasoning: 'hmm ' });
    f.append({ type: 'delta', id: 'a1', text: 'Hello ' });
    f.append({ type: 'delta', id: 'a1', text: 'wor' });
    appendFileSync(f.file, '{"type":"delta","id":"a1","te'); // crash mid-write
    f.releaseLock();
    const reopened = store.open(f.id);
    const path = reopened.conv.path();
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(path[1]!.interrupted).toBe(true);
    expect(path[1]!.content).toEqual([
      { type: 'reasoning', text: 'hmm ', provider: '', model: '' },
      { type: 'text', text: 'Hello wor' },
    ]);
    reopened.releaseLock();
  });

  it('skips malformed and unknown lines instead of crashing later', () => {
    const store = new Store(tmp());
    const f = store.create();
    f.append({ type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'ok' }], ts: 1 });
    for (const line of [
      '{"type":"message","id":"a1","parentId":"u1","role":"assistant"}',
      '{"type":"message","id":"a2","parentId":"u1","role":"wizard","content":[]}',
      '{"type":"message","id":"a3","parentId":"u1","role":"assistant","content":"just a string"}',
      '{"type":"message","parentId":"u1","role":"assistant","content":[]}',
      '{"type":"message","id":"a4","parentId":"u1","role":"assistant","content":[{"type":"text"},{"type":"mystery","x":1},null]}',
      '{"type":"from-the-future","id":"z"}',
      'null',
      '[]',
      '"text"',
      '{"type":"title","title":42}',
      '{"type":"head","id":"does-not-exist","ts":5}',
    ])
      appendFileSync(f.file, line + '\n');
    f.releaseLock();
    const { conv } = store.open(f.id, { lock: false });
    // The dangling head falls back to the newest valid message.
    const path = conv.path();
    expect(path.map((m) => m.id)).toEqual(['u1', 'a4']);
    expect(path[1]!.content).toEqual([]);
    expect(conv.title).toBeUndefined();
    expect(toChatMessages(path, { provider: 'p', model: 'm' })).toEqual([{ role: 'user', content: [{ type: 'text', text: 'ok' }] }]);
    expect(store.list()[0]!.messageCount).toBe(2);
  });

  it('branches on rewind without deleting anything', () => {
    const store = new Store(tmp());
    const f = store.create();
    const msg = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string) => {
      const m = { id, parentId, role, content: [{ type: 'text' as const, text }], ts: Date.now() };
      f.conv.add(m);
      f.append({ type: 'message', ...m });
    };
    msg('u1', null, 'user', 'one');
    msg('a1', 'u1', 'assistant', 'A1');
    msg('u2', 'a1', 'user', 'two');
    msg('a2', 'u2', 'assistant', 'A2');
    // Rewind to edit u2: head moves to a1 and the edit becomes a sibling.
    f.append({ type: 'head', id: 'a1', ts: Date.now() });
    msg('u2b', 'a1', 'user', 'two, edited');
    msg('a2b', 'u2b', 'assistant', 'A2b');
    f.releaseLock();
    const { conv } = replay(f.id, readFileSync(f.file, 'utf8'));
    expect(conv.path().map((m) => m.id)).toEqual(['u1', 'a1', 'u2b', 'a2b']);
    expect(conv.messages.size).toBe(6);
    expect(conv.path('a2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('lists conversations newest first with titles and counts, and searches full text', () => {
    const store = new Store(tmp());
    const a = store.create();
    a.append({ type: 'message', id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'about penguins' }], ts: 1 });
    a.append({ type: 'title', title: 'Penguins' });
    a.releaseLock();
    const b = store.create();
    b.append({ type: 'message', id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'first line\nsecond' }], ts: 2 });
    b.append({ type: 'message', id: 'a', parentId: 'u', role: 'assistant', content: [{ type: 'text', text: 'the zebra answer' }], ts: Date.now() + 60_000 });
    b.releaseLock();
    const empty = store.create();
    empty.releaseLock();
    const list = store.list();
    expect(list.map((c) => c.title)).toEqual(['first line', 'Penguins']);
    expect(list[0]!.messageCount).toBe(2);
    expect(store.search('ZEBRA').map((c) => c.id)).toEqual([b.id]);
    expect(store.search('penguin').map((c) => c.id)).toEqual([a.id]);
  });

  it('locks a conversation against a second live instance but takes over stale locks', () => {
    const store = new Store(tmp());
    const f = store.create();
    f.append({ type: 'message', id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'x' }], ts: 1 });
    // A live foreign pid holds the lock.
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.ppid)']);
    void child;
    writeFileSync(`${f.file}.lock`, String(process.ppid));
    expect(() => store.open(f.id)).toThrow(ConversationLockedError);
    // A dead pid's lock is stale.
    writeFileSync(`${f.file}.lock`, '999999');
    const g = store.open(f.id);
    const lock = JSON.parse(readFileSync(`${f.file}.lock`, 'utf8')) as { pid: number; started: number };
    expect(lock.pid).toBe(process.pid);
    expect(Math.abs(lock.started - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
    g.releaseLock();
    expect(existsSync(`${f.file}.lock`)).toBe(false);
  });

  it('treats a lock whose PID now belongs to a different process as stale', async () => {
    const { spawn } = await import('node:child_process');
    const store = new Store(tmp());
    const f = store.create();
    f.append({ type: 'message', id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'x' }], ts: 1 });
    f.releaseLock();
    const child = spawn('sleep', ['30']);
    await new Promise((r) => setTimeout(r, 200));
    try {
      // The recorded holder started an hour before this unrelated process
      // did, so the PID has been reused: the lock is stale.
      writeFileSync(`${f.file}.lock`, JSON.stringify({ pid: child.pid, started: Date.now() - 3_600_000 }));
      const g = store.open(f.id);
      g.releaseLock();
      // A matching start time means the holder is still running.
      writeFileSync(`${f.file}.lock`, JSON.stringify({ pid: child.pid, started: Date.now() - 200 }));
      expect(() => store.open(f.id)).toThrow(ConversationLockedError);
    } finally {
      child.kill();
    }
  });

  it('two processes appending to the shared history never corrupt it', async () => {
    const dir = tmp();
    const file = join(dir, 'history.jsonl');
    const script = `
      const { appendFileSync } = require('node:fs');
      for (let i = 0; i < 300; i++) appendFileSync(${JSON.stringify(file)}, JSON.stringify({ t: Date.now(), text: process.argv[1] + ' ' + i + ' ' + 'x'.repeat(200) }) + '\\n');
    `;
    const { spawn } = await import('node:child_process');
    await Promise.all(
      ['alpha', 'beta', 'gamma'].map(
        (n) => new Promise<void>((r) => spawn(process.execPath, ['-e', script, n]).on('close', () => r())),
      ),
    );
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(900);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const h = new InputHistory(file);
    h.load();
    expect(h.all().length).toBe(900);
    expect(h.search('gamma 299')).toHaveLength(1);
  });

  it('stores attachments by content hash', () => {
    const store = new Store(tmp());
    const hash = store.saveAttachment(Buffer.from('png-bytes'), 'image/png');
    expect(store.saveAttachment(Buffer.from('png-bytes'), 'image/png')).toBe(hash);
    expect(store.loadAttachment(hash, 'image/png')?.toString()).toBe('png-bytes');
  });
});

describe('history conversion for a model switch', () => {
  it('keeps reasoning only for the producing provider/model and merges same-role turns', () => {
    const msgs = [
      { id: newId(), parentId: null, role: 'user' as const, content: [{ type: 'text' as const, text: 'q1' }], ts: 1 },
      {
        id: newId(),
        parentId: null,
        role: 'assistant' as const,
        content: [
          { type: 'reasoning' as const, text: 't', provider: 'anthropic', model: 'claude-x', signature: 's' },
          { type: 'text' as const, text: 'a1' },
        ],
        ts: 2,
      },
      { id: newId(), parentId: null, role: 'assistant' as const, content: [], ts: 3, error: 'failed' },
      { id: newId(), parentId: null, role: 'user' as const, content: [{ type: 'text' as const, text: 'q2' }], ts: 4 },
      { id: newId(), parentId: null, role: 'user' as const, content: [{ type: 'text' as const, text: 'q3' }], ts: 5 },
    ];
    const same = toChatMessages(msgs, { provider: 'anthropic', model: 'claude-x' });
    expect(same[1]!.content[0]).toMatchObject({ type: 'reasoning' });
    const other = toChatMessages(msgs, { provider: 'local', model: 'qwen' });
    expect(other.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(other[1]!.content).toEqual([{ type: 'text', text: 'a1' }]);
    expect(other[2]!.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe('q2\n\nq3');
  });
});
