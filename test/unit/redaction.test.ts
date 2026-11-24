// Keys must never reach a notice, a transcript, or a log, whatever path an
// error takes.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, type SessionEvent } from '../../src/core/session.js';
import { Store } from '../../src/core/store.js';
import { Registry } from '../../src/providers/registry.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { enableDebug } from '../../src/debug.js';

const KEY = 'sk-live-THIS-IS-A-SECRET-KEY-0123456789';
let server: Server;
let base = '';
let mode = 'http';

beforeAll(async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
  process.env.REDACT_TEST_KEY = KEY;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[{"id":"m"}]}');
      } else if (mode === 'http') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Bad key ${req.headers.authorization} (${KEY})` } }));
      } else if (mode === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"upstream rejected ${KEY}"}}\n\n`);
      } else {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end(`Internal error for key=${KEY}`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

describe('key redaction', () => {
  for (const m of ['http', 'stream', 'plain']) {
    it(`keeps the key out of notices, transcripts and logs (${m} error)`, async () => {
      mode = m;
      const dir = mkdtempSync(join(tmpdir(), 'taria-redact-'));
      const log = enableDebug(join(dir, 'debug.log'));
      const config: Config = { ...defaultConfig(), providers: { r: { name: 'r', type: 'openai-compatible', baseUrl: base, apiKeyEnv: 'REDACT_TEST_KEY', headers: {}, models: {} } } };
      const store = new Store(dir);
      const session = new Session({ config, registry: new Registry(config), store, model: 'r/m' });
      const notices: string[] = [];
      session.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
      await session.submit({ text: 'hi' });
      session.close();
      expect(notices.join('\n')).toMatch(/r (rejected|returned)|upstream rejected|Internal error/);
      const files = readdirSync(join(dir, 'conversations')).filter((f) => f.endsWith('.jsonl'));
      const all = [notices.join('\n'), readFileSync(log, 'utf8'), ...files.map((f) => readFileSync(join(dir, 'conversations', f), 'utf8'))].join('\n');
      expect(all).not.toContain(KEY);
      expect(all).not.toContain('0123456789');
    });
  }
});

describe('retry policy', () => {
  it('does not retry early when the provider asks for a long wait, and says how long', async () => {
    let calls = 0;
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.endsWith('/chat/completions')) calls++;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '600' });
        res.end('{"error":{"message":"Too many requests","type":"rate_limit_error"}}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
    const dir = mkdtempSync(join(tmpdir(), 'taria-retry-'));
    const config: Config = { ...defaultConfig(), providers: { r: { name: 'r', type: 'openai-compatible', baseUrl: url, headers: {}, models: {} } } };
    const session = new Session({ config, registry: new Registry(config), store: new Store(dir), model: 'r/m' });
    const notices: string[] = [];
    session.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    const started = Date.now();
    await session.submit({ text: 'hi' });
    srv.close();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toBe(1);
    expect(notices.join('\n')).toMatch(/Rate limited by r: Too many requests[\s\S]*try again in 10 minutes/);
  });
});
