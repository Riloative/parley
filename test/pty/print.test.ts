// Non-interactive mode, driven through pipes (stdout is not a terminal).
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tariaCommand } from '../build-once.js';
import { makeHome, testEnv, DEFAULT_CONFIG } from './harness.js';

const homes: string[] = [];

function run(args: string[], opts: { stdin?: string; home?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string; ms: number }> {
  const home = opts.home ?? makeHome();
  homes.push(home);
  return new Promise((resolve) => {
    const started = Date.now();
    const launch = tariaCommand(args);
    const p = spawn(launch.command, launch.args, { env: testEnv(home, opts.env), cwd: home });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err, ms: Date.now() - started }));
    p.stdin.end(opts.stdin ?? '');
  });
}

beforeAll(() => void tariaCommand());
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('taria -p', () => {
  it('prints the answer without colour or spinner when piped', async () => {
    const r = await run(['-p', 'hello there', '-m', 'mock/echo']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('You said: hello there\n');
    expect(r.out).not.toContain('\x1b');
    expect(r.err).toBe('');
  });

  it('includes piped stdin as context', async () => {
    const r = await run(['-p', 'summarise', '-m', 'mock/echo'], { stdin: 'my notes\n' });
    expect(r.out).toBe('You said: my notes\n\nsummarise\n');
  });

  it('emits structured output with --json', async () => {
    const r = await run(['-p', 'hi', '-m', 'mock/reasoning?tps=5000', '--json']);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j).toMatchObject({ model: 'mock/reasoning?tps=5000', interrupted: false, error: null, stop_reason: 'end_turn' });
    expect(String(j.text)).toContain('# Streaming markdown');
    expect(String(j.reasoning)).toContain('Let me think');
    expect(typeof j.conversation_id).toBe('string');
  });

  it('fails with a non-zero exit code and the error on stderr', async () => {
    const r = await run(['-p', 'hi', '-m', 'mock/error?kind=auth']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/Authentication failed/);
  });

  it('uses -s as the system prompt and -c to continue the last conversation', async () => {
    const home = makeHome();
    await run(['-p', 'first', '-s', 'be brief'], { home });
    const r = await run(['-p', 'second', '-c'], { home });
    expect(r.code).toBe(0);
    const dir = join(home, 'data', 'taria', 'conversations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    expect(text).toContain('"prompt":"be brief"');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('explains when no model is configured', async () => {
    const r = await run(['-p', 'hi'], { home: makeHome('providers: {}\n') });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no model selected/);
  });

  it('reports config errors with line numbers but still runs', async () => {
    const r = await run(['-p', 'hi'], { home: makeHome(DEFAULT_CONFIG + 'bel: true\n') });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/config\.yaml:7: config: unknown setting "bel"\. Did you mean "bell"\?/);
  });

  it('prints shell completions and the man page; an unknown shell is a usage error', async () => {
    const b = await run(['completions', 'bash']);
    expect(b.code).toBe(0);
    expect(b.out).toContain('complete -F _taria taria');
    const m = await run(['man']);
    expect(m.out.startsWith('.TH TARIA 1')).toBe(true);
    const bad = await run(['completions', 'tcsh']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('Usage: taria completions bash|zsh|fish');
  });

  it('answers --help and --version quickly without loading the interface', async () => {
    const v = await run(['--version']);
    const kind = process.env.TARIA_BIN ? 'standalone binary' : 'node package';
    expect(v.out).toMatch(new RegExp(`^taria \\d+\\.\\d+\\.\\d+ \\(${kind}, Node v\\d+\\.\\d+\\.\\d+, (linux|darwin)-(x64|arm64)\\)\\n$`));
    const h = await run(['--help']);
    expect(h.out).toContain('Usage');
    expect(h.ms).toBeLessThan(2000);
  });

  it('rejects unknown options', async () => {
    const r = await run(['--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Unknown option --bogus/);
  });
});

describe('a data folder that cannot be written', () => {
  // Stands in for a read-only file system or a full disk: the conversations
  // folder cannot be created, because a file is in its place.
  function unwritableHome(): string {
    const home = makeHome(DEFAULT_CONFIG);
    mkdirSync(join(home, 'data', 'taria'), { recursive: true });
    writeFileSync(join(home, 'data', 'taria', 'conversations'), 'not a folder');
    return home;
  }

  it('-p still answers on stdout, says once on stderr that the conversation is not saved, and prints no stack trace', async () => {
    const home = unwritableHome();
    const r = await run(['-p', 'hello there'], { home });
    expect(r.out).toBe('You said: hello there\n');
    expect(r.err).toMatch(/^taria: This conversation is not being saved: /m);
    expect(r.err).toContain(join(home, 'data', 'taria', 'conversations'));
    expect(r.err.match(/not being saved/g)).toHaveLength(1);
    expect(r.err).not.toMatch(/\n\s+at |node:fs|Error: E[A-Z]+/);
    expect(r.code).toBe(0);
  });
});

describe('--debug', () => {
  let server: ReturnType<typeof createServer>;
  let url = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  it('logs requests and timings with the key redacted', async () => {
    const home = makeHome(`default_model: remote/m\nproviders:\n  remote:\n    type: openai-compatible\n    base_url: ${url}\n    api_key_env: REMOTE_KEY\n`);
    const log = join(home, 'debug.log');
    const r = await run(['-p', 'hi', '--debug', log], { home, env: { REMOTE_KEY: 'super-secret-key-value-123' } });
    expect(r.out).toBe('ok\n');
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('"status":200');
    expect(text).toContain('/chat/completions');
    expect(text).not.toContain('super-secret-key-value-123');
  });
});

// Real HTTP through the built program (Node package or standalone binary):
// the SDK-based Anthropic adapter, the Responses API, and proxy handling.
describe('providers over HTTP', () => {
  const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
  const seen: Array<{ url: string; auth?: string; body: string; via: 'direct' | 'proxy' }> = [];
  let direct: ReturnType<typeof createServer>;
  let proxy: ReturnType<typeof createServer>;
  let directUrl = '';
  let proxyUrl = '';
  const respond = (url: string, res: ServerResponse) => {
    if (url.split('?')[0]!.endsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-test', type: 'model', display_name: 'T', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 100000, max_tokens: 8000, capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } } } }], has_more: false }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (url.endsWith('/v1/messages')) res.end(fixture('anthropic-thinking.sse'));
    else if (url.endsWith('/v1/responses')) res.end(fixture('openai-responses.sse'));
    else res.end('data: {"choices":[{"index":0,"delta":{"content":"via ' + url + '"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const handler = (via: 'direct' | 'proxy') => (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body, via });
      respond(req.url ?? '', res);
    });
  };
  beforeAll(async () => {
    direct = createServer(handler('direct'));
    proxy = createServer(handler('proxy'));
    await new Promise<void>((r) => direct.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    directUrl = `http://127.0.0.1:${(direct.address() as AddressInfo).port}`;
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    direct.close();
    proxy.close();
  });

  it('streams from the Anthropic adapter (SDK) with thinking', async () => {
    seen.length = 0;
    const home = makeHome(`default_model: a/claude-test\nproviders:\n  a:\n    type: anthropic\n    base_url: ${directUrl}\n    api_key_env: A_KEY\n`);
    const r = await run(['-p', 'hi', '--json'], { home, env: { A_KEY: 'sk-ant-test-0123456789' } });
    const j = JSON.parse(r.out) as { text: string; reasoning: string; usage: { outputTokens: number } };
    expect(j.text).toBe('Hello, world!');
    expect(j.reasoning).toContain('Keep it short.');
    expect(j.usage.outputTokens).toBe(42);
    const req = seen.find((s) => s.url.startsWith('/v1/messages'))!;
    expect(req.auth).toBe('Bearer sk-ant-test-0123456789');
    expect(JSON.parse(req.body)).toMatchObject({ model: 'claude-test', stream: true, thinking: { type: 'adaptive' } });
  });

  it('streams from the OpenAI Responses adapter', async () => {
    const home = makeHome(`default_model: o/gpt-5-test\nproviders:\n  o:\n    type: openai\n    base_url: ${directUrl}/v1\n    api_key_env: O_KEY\n`);
    const r = await run(['-p', 'hi'], { home, env: { O_KEY: 'sk-test-0123456789' } });
    expect(r.out).toBe('Hi there.\n');
  });

  it('sends requests through HTTP_PROXY and honours NO_PROXY', async () => {
    seen.length = 0;
    const viaProxy = makeHome(`default_model: r/m\nproviders:\n  r:\n    type: openai-compatible\n    base_url: http://upstream.taria.invalid/v1\n`);
    const a = await run(['-p', 'hi'], { home: viaProxy, env: { HTTP_PROXY: proxyUrl } });
    expect(a.out).toBe('via http://upstream.taria.invalid/v1/chat/completions\n');
    expect(seen.at(-1)?.via).toBe('proxy');
    const bypass = makeHome(`default_model: r/m\nproviders:\n  r:\n    type: openai-compatible\n    base_url: ${directUrl}/v1\n`);
    const b = await run(['-p', 'hi'], { home: bypass, env: { HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' } });
    expect(b.out).toBe('via /v1/chat/completions\n');
    expect(seen.at(-1)?.via).toBe('direct');
  });
});

describe('taria doctor', () => {
  it('runs without a terminal and reports providers', async () => {
    const r = await run(['doctor']);
    expect(r.out).toContain('taria doctor');
    expect(r.out).toMatch(/✓ mock\s+mock · reachable/);
    expect(r.code).toBe(0);
  });
});
