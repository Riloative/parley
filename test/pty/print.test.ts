// Non-interactive mode, driven through pipes (stdout is not a terminal).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBuilt } from '../build-once.js';
import { makeHome, testEnv, DEFAULT_CONFIG } from './harness.js';

const BIN = new URL('../../bin/parley.js', import.meta.url).pathname;
const homes: string[] = [];

function run(args: string[], opts: { stdin?: string; home?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string; ms: number }> {
  const home = opts.home ?? makeHome();
  homes.push(home);
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [BIN, ...args], { env: testEnv(home, opts.env), cwd: home });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err, ms: Date.now() - started }));
    p.stdin.end(opts.stdin ?? '');
  });
}

beforeAll(() => ensureBuilt());
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('parley -p', () => {
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
    const dir = join(home, 'data', 'parley', 'conversations');
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

  it('answers --help and --version quickly without loading the interface', async () => {
    const v = await run(['--version']);
    expect(v.out).toMatch(/^parley \d+\.\d+\.\d+\n$/);
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

describe('parley doctor', () => {
  it('runs without a terminal and reports providers', async () => {
    const r = await run(['doctor']);
    expect(r.out).toContain('parley doctor');
    expect(r.out).toMatch(/✓ mock\s+mock · reachable/);
    expect(r.code).toBe(0);
  });
});
