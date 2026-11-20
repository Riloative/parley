import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { Store, replay } from '../../src/core/store.js';
import { Registry } from '../../src/providers/registry.js';
import { defaultConfig, type Config } from '../../src/config/config.js';

function make(model = 'mock/echo', over: Partial<Config> = {}) {
  const config: Config = { ...defaultConfig(), ...over };
  const store = new Store(mkdtempSync(join(tmpdir(), 'parley-sess-')));
  const session = new Session({ config, registry: new Registry(config), store, model });
  const events: SessionEvent[] = [];
  session.on('event', (e: SessionEvent) => events.push(e));
  return { session, store, events };
}

const textOf = (s: Session) => s.conv.path().map((m) => `${m.role}:${m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')}`);

describe('session', () => {
  it('runs a turn, persists it, and names the conversation from the first line', async () => {
    const { session, store } = make();
    await session.submit({ text: 'hello world\nmore' });
    expect(textOf(session)).toEqual(['user:hello world\nmore', 'assistant:You said: hello world\nmore']);
    await new Promise((r) => setTimeout(r, 20));
    const { conv } = replay(session.file!.id, readFileSync(session.file!.file, 'utf8'));
    expect(conv.title).toBe('hello world');
    expect(conv.path()).toHaveLength(2);
    expect(store.list()[0]!.title).toBe('hello world');
    session.close();
  });

  it('generates titles with the configured title model', async () => {
    const { session } = make('mock/echo', { titleModel: 'mock/title' });
    await session.submit({ text: 'question' });
    await new Promise((r) => setTimeout(r, 400));
    expect(session.conv.title).toBe('Mock conversation title');
  });

  it('retries transient failures visibly, then succeeds', async () => {
    const { session, events } = make('mock/retry?failures=2');
    const statuses: string[] = [];
    session.on('event', (e: SessionEvent) => {
      if (e.type === 'frame' && session.stream?.retry) statuses.push(`retry ${session.stream.retry.attempt}`);
    });
    await session.submit({ text: 'x' });
    expect(statuses).toContain('retry 2');
    expect(statuses).toContain('retry 3');
    const end = events.find((e) => e.type === 'assistant-end');
    expect(end && end.type === 'assistant-end' && end.outcome).toBe('done');
  });

  it('shows non-retryable errors in plain language and keeps going', async () => {
    const { session, events } = make('mock/error?kind=auth');
    await session.submit({ text: 'x' });
    const n = events.find((e) => e.type === 'notice' && e.tone === 'error');
    expect(n && n.type === 'notice' && n.text).toMatch(/Authentication failed/);
    expect(session.streaming).toBe(false);
  });

  it('keeps partial text when the connection drops mid-stream', async () => {
    const { session } = make('mock/disconnect?after=10&tps=2000');
    await session.submit({ text: 'x' });
    const last = session.conv.head!;
    expect(last.role).toBe('assistant');
    expect(last.error).toMatch(/connection was lost/);
    expect(last.content[0]).toMatchObject({ type: 'text' });
  });

  it('interrupts, marking the partial reply', async () => {
    const { session } = make('mock/long?lines=300&tps=200');
    const p = session.submit({ text: 'go' });
    await new Promise((r) => setTimeout(r, 400));
    session.interrupt();
    await p;
    expect(session.conv.head!.interrupted).toBe(true);
    expect(textOf(session)[1]).toMatch(/^assistant:# A very long answer/);
  });

  it('queues messages typed during a reply and sends them afterwards', async () => {
    const { session } = make('mock/echo?delay=150');
    const p = session.submit({ text: 'first' });
    await new Promise((r) => setTimeout(r, 30));
    await session.submit({ text: 'second' });
    await session.submit({ text: 'third' });
    expect(session.queue).toHaveLength(2);
    await p;
    expect(textOf(session)).toEqual(['user:first', 'assistant:You said: first', 'user:second\n\nthird', 'assistant:You said: second\n\nthird']);
  });

  it('returns queued text to the input when the reply is interrupted', async () => {
    const { session, events } = make('mock/long?lines=300&tps=100');
    const p = session.submit({ text: 'go' });
    await new Promise((r) => setTimeout(r, 300));
    await session.submit({ text: 'later' });
    session.interrupt();
    await p;
    expect(events.find((e) => e.type === 'restore-input')).toMatchObject({ text: 'later' });
  });

  it('rewinds: edits an earlier message on a new branch, keeping the old one', async () => {
    const { session } = make();
    await session.submit({ text: 'one' });
    await session.submit({ text: 'two' });
    const two = session.userMessages()[1]!;
    expect(session.rewindTo(two.id)).toBe('two');
    await session.submit({ text: 'two (edited)' });
    expect(textOf(session)).toEqual(['user:one', 'assistant:You said: one', 'user:two (edited)', 'assistant:You said: two (edited)']);
    expect(session.conv.messages.size).toBe(6);
    const { conv } = replay(session.file!.id, readFileSync(session.file!.file, 'utf8'));
    expect(conv.path().map((m) => m.id)).toEqual(session.conv.path().map((m) => m.id));
  });

  it('/retry regenerates the last reply with another model as a sibling branch', async () => {
    const { session } = make();
    await session.submit({ text: 'q' });
    const firstAnswer = session.conv.head!.id;
    await session.retry('mock/markdown');
    const path = session.conv.path();
    expect(path).toHaveLength(2);
    expect(path[1]!.model).toBe('mock/markdown');
    expect(path[1]!.parentId).toBe(path[0]!.id);
    expect(session.conv.messages.has(firstAnswer)).toBe(true);
    expect(session.model).toBe('mock/markdown');
  });

  it('switching models drops another model\'s reasoning from the history it sends', async () => {
    const { session } = make('mock/reasoning?tps=5000');
    await session.submit({ text: 'think' });
    const a = session.conv.head!;
    expect(a.content[0]).toMatchObject({ type: 'reasoning', provider: 'mock', model: 'reasoning?tps=5000', signature: 'mock-signature' });
    expect(a.reasoningMs).toBeGreaterThanOrEqual(0);
    session.setModel('mock/echo');
    await session.submit({ text: 'next' });
    expect(textOf(session)[3]).toBe('assistant:You said: next');
  });

  it('refuses to send a message that would overflow the context window and suggests /compact', async () => {
    const config: Partial<Config> = { providers: { tiny: { name: 'tiny', type: 'mock', headers: {}, models: {}, contextWindow: 300 } } };
    const { session, events } = make('tiny/echo', config);
    // Mock reports 32k; the per-model override wins when configured.
    session.registry.setConfig({ ...defaultConfig(), providers: { tiny: { name: 'tiny', type: 'mock', headers: {}, models: { echo: { contextWindow: 300 } } } } });
    await session.submit({ text: 'x'.repeat(2000) });
    expect(session.conv.messageCount).toBe(0);
    const n = events.find((e) => e.type === 'notice');
    expect(n && n.type === 'notice' && n.text).toMatch(/overflow.*\/compact/s);
    expect(events.find((e) => e.type === 'restore-input')).toBeDefined();
  });

  it('compacts the conversation into a summary that later requests start from', async () => {
    const { session } = make();
    await session.submit({ text: 'one' });
    await session.submit({ text: 'two' });
    await session.compact('keep numbers');
    const ctx = session.conv.context();
    expect(ctx[0]!.role).toBe('summary');
    expect(session.conv.path()).toHaveLength(5);
    await session.submit({ text: 'three' });
    expect(session.conv.context().map((m) => m.role)).toEqual(['summary', 'user', 'assistant']);
  });

  it('reports a provider that is not running with its address', async () => {
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise((r) => srv.close(r));
    const config: Config = { ...defaultConfig(), providers: { local: { name: 'local', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, headers: {}, models: {} } } };
    const store = new Store(mkdtempSync(join(tmpdir(), 'parley-sess-')));
    const session = new Session({ config, registry: new Registry(config), store, model: 'local/m' });
    const notices: string[] = [];
    session.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    await session.submit({ text: 'hi' });
    expect(notices.join('\n')).toContain(`Nothing is listening at http://127.0.0.1:${port}`);
  });

  it('does not save a message when no model is selected', async () => {
    const { session, events } = make('');
    await session.submit({ text: 'hello' });
    expect(session.conv.messageCount).toBe(0);
    expect(session.file).toBeNull();
    expect(events.find((e) => e.type === 'restore-input')).toMatchObject({ text: 'hello' });
  });

  it('sends messages queued during compaction afterwards', async () => {
    const { session } = make();
    await session.submit({ text: 'one' });
    await session.submit({ text: 'two' });
    const p = session.compact();
    await session.submit({ text: 'queued' });
    await p;
    expect(session.conv.context().map((m) => m.role)).toEqual(['summary', 'user', 'assistant']);
    expect(textOf(session).at(-1)).toMatch(/^assistant:You said: Summary of the conversation so far:[\s\S]*queued$/);
  });
});
