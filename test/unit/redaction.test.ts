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
import { redact } from '../../src/config/credentials.js';

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

describe('keys that the ordinary patterns do not catch', () => {
  // A gateway that repeats the credentials it was sent in its 401, as some do.
  let echo: Server;
  let echoBase = '';
  beforeAll(async () => {
    echo = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"data":[{"id":"m"}]}');
        }
        const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const extra = String(req.headers['x-auth-token'] ?? '');
        if (req.headers['x-shape'] === 'ok') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          return res.end('data: {"choices":[{"index":0,"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth}`, token_seen: extra } }));
      });
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => echo.close());

  /** One turn against the echoing server; everything taria wrote or said. */
  async function turn(name: string, key: string, headers: Record<string, string> = {}): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'taria-redact-'));
    const log = enableDebug(join(dir, 'debug.log'));
    process.env[`REDACT_${name.toUpperCase()}_KEY`] = key;
    const config: Config = { ...defaultConfig(), providers: { [name]: { name, type: 'openai-compatible', baseUrl: echoBase, apiKeyEnv: `REDACT_${name.toUpperCase()}_KEY`, headers, models: {} } } };
    const session = new Session({ config, registry: new Registry(config), store: new Store(dir), model: `${name}/m` });
    const notices: string[] = [];
    session.on('event', (e: SessionEvent) => e.type === 'notice' && notices.push(e.text));
    await session.submit({ text: 'hi' });
    session.close();
    const files = readdirSync(join(dir, 'conversations')).filter((f) => f.endsWith('.jsonl'));
    return [notices.join('\n'), readFileSync(log, 'utf8'), ...files.map((f) => readFileSync(join(dir, 'conversations', f), 'utf8'))].join('\n');
  }

  it('a short key (7 characters, as local gateways use) is redacted everywhere', async () => {
    const all = await turn('short', 'FAKE123');
    expect(all).toMatch(/short rejected the API key/);
    expect(all).not.toContain('FAKE123');
  });

  it('redact() covers every known secret of 4 characters or more, the longest first; shorter ones are left', () => {
    expect(redact('token abcd and abcdefgh end', ['abcd', 'abcdefgh'])).toBe('token [redacted] and [redacted] end');
    expect(redact('pin 1234', ['1234'])).toBe('pin [redacted]');
    // Below 4 characters a "secret" is a common substring: redacting it would garble every message.
    expect(redact('the cat sat', ['at', undefined, ''])).toBe('the cat sat');
  });

  it('a key with a quote and a backslash is redacted in its JSON-escaped forms too (the debug log)', async () => {
    const key = 'tok"en\\FAKE-0123456789abcdef';
    const all = await turn('quoted', key);
    expect(all).toMatch(/quoted rejected the API key/);
    expect(all).not.toContain(key);
    expect(all).not.toContain('FAKE-0123456789abcdef');
    const once = JSON.stringify(key).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    expect(redact(`a ${key} b ${once} c ${twice} d`, [key])).toBe('a [redacted] b [redacted] c [redacted] d');
  });

  it('a secret header read from the environment (env:NAME) never reaches the debug log, sent or echoed back', async () => {
    const token = 'tok-FAKE-HEADER-0123456789';
    process.env.REDACT_HEADER_TOKEN = token;
    // The request succeeds: the log holds the request's headers.
    const ok = await turn('hdrok', 'sk-test-FAKE-0123456789abcdef', { 'X-Auth-Token': 'env:REDACT_HEADER_TOKEN', 'X-Shape': 'ok' });
    expect(ok).toMatch(/"X-Auth-Token":"\[redacted\]"/);
    expect(ok).not.toContain(token);
    // The server repeats the header in its error body.
    const echoed = await turn('hdrecho', 'sk-test-FAKE-0123456789abcdef', { 'X-Auth-Token': '${REDACT_HEADER_TOKEN}' });
    expect(echoed).toMatch(/hdrecho rejected the API key/);
    expect(echoed).not.toContain(token);
  });

  it('configured header values are not logged, whatever the header is called; harmless standard ones are', async () => {
    const all = await turn('hdrlit', 'sk-test-FAKE-0123456789abcdef', { 'X-Tenant': 'tenant-FAKE-42', 'X-Shape': 'ok' });
    expect(all).not.toContain('tenant-FAKE-42');
    expect(all).toMatch(/"X-Tenant":"\[redacted\]"/);
    expect(all).toMatch(/"content-type":"application\/json"/);
  });
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
