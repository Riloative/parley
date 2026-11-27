// A scripted provider used for development, demos and every automated test.
// It is a permanent part of the codebase, not a test double: `mock/<script>`
// models are always available, and `mock` providers can be configured like
// any other.
//
// The model id selects a script and options, e.g.
//   mock/echo                 echo the last user message back
//   mock/long?lines=500&tps=2000
//   mock/reasoning
//   mock/slow-first?delay=4000
//   mock/error?kind=rate_limit
//   mock/disconnect?after=40
//   mock/markdown
//   mock/search?n=3           a reply that searches the web, when web search
//                             is on (see the options at searchScript())
// Options: tps (tokens/second, default 400), delay (ms before first token),
// chunk (characters per token, default 4).

import type { ChatRequest, ModelCapabilities, ModelInfo, Provider, StreamEvent } from './types.js';
import { ProviderError, textOf } from './types.js';

const SCRIPTS = [
  'echo',
  'markdown',
  'long',
  'reasoning',
  'slow-first',
  'error',
  'disconnect',
  'retry',
  'table',
  'code',
  'title',
  'search',
] as const;

export function mockScriptText(script: string, opts: URLSearchParams, req: ChatRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  const lastText = last ? textOf(last.content) : '';
  switch (script) {
    case 'echo':
      return lastText ? `You said: ${lastText}` : 'Hello from the mock provider.';
    case 'title':
      return 'Mock conversation title';
    case 'table':
      return TABLE_SAMPLE;
    case 'code':
      return CODE_SAMPLE;
    case 'long':
      return longResponse(Number(opts.get('lines') ?? 500));
    case 'markdown':
    case 'reasoning':
    case 'slow-first':
    case 'disconnect':
    case 'retry':
    default:
      return MARKDOWN_SAMPLE;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('aborted', 'Request cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'Request cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Split text into pseudo-tokens of roughly `size` characters. */
function* tokens(text: string, size: number): Generator<string> {
  let i = 0;
  while (i < text.length) {
    // Prefer to break after whitespace so tokens look natural.
    let end = Math.min(text.length, i + size);
    const ws = text.slice(i, end + 3).search(/\s/);
    if (ws >= 0 && ws < size + 3) end = Math.min(text.length, i + ws + 1);
    yield text.slice(i, end);
    i = end;
  }
}

export class MockProvider implements Provider {
  readonly type = 'mock' as const;
  readonly endpoint = 'mock://local';
  constructor(readonly name: string) {}

  async listModels(): Promise<ModelInfo[]> {
    return SCRIPTS.map((id) => ({ id, displayName: `Mock ${id}`, capabilities: this.caps(id) }));
  }

  private caps(model: string): ModelCapabilities {
    const script = model.split('?')[0] ?? model;
    return {
      images: true,
      reasoning: script === 'reasoning',
      reasoningEfforts: script === 'reasoning' ? ['low', 'medium', 'high'] : [],
      contextWindow: 32_000,
      // Only the search script searches; `caps=unknown` and `caps=no` are
      // for testing what taria does when it cannot tell, or is wrong.
      webSearch: script !== 'search' ? false : /caps=unknown/.test(model) ? 'unknown' : !/caps=no/.test(model),
      searchLimit: script === 'search' && !/nolimit=1/.test(model),
    };
  }

  async capabilities(model: string): Promise<ModelCapabilities> {
    return this.caps(model);
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const [script = 'echo', query = ''] = req.model.split('?');
    const opts = new URLSearchParams(query);
    const tps = Number(opts.get('tps') ?? 400);
    const chunk = Number(opts.get('chunk') ?? 4);
    const interval = tps > 0 ? 1000 / tps : 0;
    const signal = req.signal;
    const inputTokens = Math.ceil(JSON.stringify(req.messages).length / 4);

    yield { type: 'status', status: 'connecting' };
    await sleep(Number(opts.get('connect') ?? 20), signal);
    yield { type: 'status', status: 'waiting' };

    if (script === 'error') {
      const kind = opts.get('kind') ?? 'server';
      if (kind === 'rate_limit') {
        throw new ProviderError('rate_limit', 'Rate limited (mock)', { status: 429, retryable: false, providerMessage: 'Too many requests' });
      }
      if (kind === 'auth') {
        throw new ProviderError('auth', 'Authentication failed (mock)', { status: 401, providerMessage: 'invalid x-api-key' });
      }
      if (kind === 'not_running') {
        throw new ProviderError('not_running', 'Nothing is listening at mock://local');
      }
      if (kind === 'overflow') {
        throw new ProviderError('context_overflow', 'The conversation is too long for this model (mock)', { status: 400 });
      }
      throw new ProviderError('server', 'The server returned an error (mock)', { status: 500, providerMessage: 'internal error' });
    }

    if (script === 'retry') {
      // Fails transiently a given number of times; the session's retry logic
      // treats this exactly like a real 429/529.
      const failures = Number(opts.get('failures') ?? 1);
      const attempt = (retryCounter.get(req.signal) ?? 0) + 1;
      retryCounter.set(req.signal, attempt);
      // `block=1`: every attempt produces a signed reasoning block before
      // it fails or answers (as a provider with encrypted reasoning does).
      if (opts.get('block')) yield { type: 'reasoning_block', signature: `attempt-${attempt}` };
      if (attempt <= failures) {
        throw new ProviderError('overloaded', 'Overloaded (mock)', { status: 529, retryable: true, retryAfterMs: 200 });
      }
    }

    const firstDelay = Number(opts.get('delay') ?? (script === 'slow-first' ? 3000 : 150));
    await sleep(firstDelay, signal);

    if (script === 'reasoning') {
      // hidden=1: a signed block with no visible text, as OpenAI sends
      // encrypted reasoning when summaries are unavailable.
      if (opts.get('hidden') !== '1') {
        for (const t of tokens(REASONING_SAMPLE, chunk)) {
          await sleep(interval, signal);
          yield { type: 'reasoning', text: t };
        }
      }
      yield { type: 'reasoning_block', signature: 'mock-signature' };
    }

    if (script === 'search' && req.webSearch) {
      yield* searchScript(req, opts, { interval, chunk, inputTokens });
      return;
    }

    yield { type: 'status', status: 'streaming' };
    const text = mockScriptText(script, opts, req);
    const disconnectAfter = script === 'disconnect' ? Number(opts.get('after') ?? 40) : Infinity;
    let n = 0;
    let pending = 0;
    for (const t of tokens(text, chunk)) {
      if (n >= disconnectAfter) {
        throw new ProviderError('network', 'The connection was lost mid-response (mock)', { retryable: false });
      }
      n++;
      // Sleep in batches so very high token rates are still honoured with
      // timer granularity of ~1ms.
      pending += interval;
      if (pending >= 4) {
        await sleep(pending, signal);
        pending = 0;
      } else if (signal.aborted) {
        throw new ProviderError('aborted', 'Request cancelled');
      }
      yield { type: 'text', text: t };
    }
    yield { type: 'usage', usage: { inputTokens, outputTokens: n } };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

const retryCounter = new WeakMap<AbortSignal, number>();

/** Titles, URLs and snippets as a hostile web page might write them. */
export const HOSTILE_SOURCES: Array<{ url: string; title: string; snippet?: string }> = [
  { url: 'https://evil.example/a', title: 'Clears \x1b[2J\x1b[H the screen \x1b]0;pwned\x07 and retitles', snippet: 'bell \x07 and \x9b31m C1 colour' },
  { url: 'https://evil.example/b', title: 'Link \x1b]8;;https://phish.example\x1b\\click\x1b]8;;\x1b\\ injection' },
  { url: 'https://evil.example/c', title: 'Reversed \u202egpj.exe\u202c name \u2066isolated\u2069 \u200bzero width' },
  { url: `https://long.example/${'a'.repeat(1979)}`, title: 'A URL of 2,000 characters' },
  { url: 'https://wide.example/漢字', title: '漢字のタイトル 🦉 가나다라마바사 全角文字がたくさん並ぶ長い長い見出し' },
  { url: 'https://empty.example/no-title', title: '' },
  { url: 'javascript:alert(1)', title: 'Not a web address' },
  { url: 'https://bank.example.attacker.example/login', title: 'bank.example · Official site' },
  { url: `https://toolong.example/${'b'.repeat(3000)}`, title: 'A URL too long to be a link' },
];

/**
 * `mock/search`, when the request asks for web search:
 *   n=3          sources each search finds (the reply cites all of them)
 *   searches=1   searches to run (never more than the request's maxUses)
 *   searchms=300 how long a search takes
 *   q=…          the query (default: the user's last message)
 *   pre=1        some text before the first search
 *   fail=code    the search fails inside the stream with this code
 *   hang=1       the search never finishes (for interrupting it)
 *   drop=1       the connection is lost during the search
 *   reject=1     the provider refuses the whole request because of search
 *   hostile=1    sources as a hostile page would write them
 *   uncited=1    sources are found but none is cited
 *   blob=200     size in bytes of the opaque data for later turns
 *   latequery=1  the query arrives only when the search has finished
 *   think=1      reasoning before the first search
 * Without web search in the request it answers like mock/markdown.
 */
async function* searchScript(req: ChatRequest, opts: URLSearchParams, t: { interval: number; chunk: number; inputTokens: number }): AsyncGenerator<StreamEvent> {
  const signal = req.signal;
  if (opts.get('reject') === '1') {
    throw new ProviderError('search_unavailable', 'mock refused web search', { status: 400, providerMessage: 'Web search is not enabled for this organization (mock)' });
  }
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  const query = opts.get('q') ?? (last ? textOf(last.content) : 'mock');
  const perSearch = Number(opts.get('n') ?? 3);
  const wanted = Number(opts.get('searches') ?? 1);
  const count = req.webSearch?.maxUses ? Math.min(wanted, req.webSearch.maxUses) : wanted;
  const hostile = opts.get('hostile') === '1';
  let out = 0;
  const say = async function* (text: string): AsyncGenerator<StreamEvent> {
    for (const tok of tokens(text, t.chunk)) {
      if (t.interval >= 1) await sleep(t.interval, signal);
      else if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled');
      out++;
      yield { type: 'text', text: tok };
    }
  };
  if (opts.get('think') === '1') {
    for (const tok of tokens('I should look this up before answering.', t.chunk)) yield { type: 'reasoning', text: tok };
    yield { type: 'reasoning_block', signature: 'mock-signature' };
  }
  yield { type: 'status', status: 'streaming' };
  if (opts.get('pre') === '1') yield* say('Let me look that up.\n\n');
  let done = 0;
  for (let i = 0; i < count; i++) {
    const id = `mock-search-${i + 1}`;
    const q = count > 1 ? `${query} (${i + 1})` : query;
    const late = opts.get('latequery') === '1';
    yield { type: 'search', id, status: 'started', ...(late ? {} : { query: q }) };
    if (opts.get('hang') === '1') await sleep(3_600_000, signal);
    await sleep(Number(opts.get('searchms') ?? 300), signal);
    if (opts.get('drop') === '1') throw new ProviderError('network', 'The connection was lost mid-response (mock)', { retryable: false });
    const fail = opts.get('fail');
    if (fail) {
      yield { type: 'search', id, status: 'failed', query: q, error: `The search failed (${fail}); key sk-ant-api03-${'x'.repeat(40)} must not show` };
      continue;
    }
    done++;
    yield { type: 'search', id, status: 'done', query: q };
    const found = hostile ? HOSTILE_SOURCES : Array.from({ length: perSearch }, (_, k) => ({ url: `https://example.com/${i + 1}/${k + 1}`, title: `Result ${k + 1} for ${q}`, snippet: `Snippet ${k + 1}: what the page says about ${q}.` }));
    for (const s of found) yield { type: 'source', ...s, cite: 'none' };
    if (opts.get('uncited') === '1') {
      yield* say(`Here is what I found for search ${i + 1}.\n\n`);
      continue;
    }
    for (const [k, s] of found.entries()) {
      yield* say(`Finding ${k + 1} of search ${i + 1} is **supported** by a page`);
      yield { type: 'source', ...s, cite: 'mark' };
      yield* say(k % 2 ? '.\n\n' : ', and there is more. ');
    }
  }
  yield* say(done ? '\n\nThat is what the web says.\n' : 'I could not search the web, so this is from memory.\n');
  if (done) yield { type: 'provider_data', data: `mock:${'e'.repeat(Math.max(0, Number(opts.get('blob') ?? 200) - 5))}` };
  yield { type: 'usage', usage: { inputTokens: t.inputTokens + done * 2000, outputTokens: out, searches: done } };
  yield { type: 'done', stopReason: 'end_turn' };
}

const REASONING_SAMPLE = `The user is asking a question. Let me think about how best to structure the answer.
First I should consider the context, then outline the main points, and finally give a concise example.
A short code sample would make this concrete, followed by a summary table.`;

export const MARKDOWN_SAMPLE = `# Streaming markdown

Here is a paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).
It continues on a second line to check soft wrapping behaves in narrow terminals and that nothing jumps around while text streams in.

## A list

- First item
- Second item with \`code\`
  - Nested item
- Third item

1. One
2. Two
3. Three

> A block quote that spans
> more than one line.

\`\`\`typescript
interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  // Euclidean distance
  return Math.hypot(a.x - b.x, a.y - b.y);
}
\`\`\`

| Language | Typing | First appeared |
| --- | --- | ---: |
| TypeScript | static | 2012 |
| Python | dynamic | 1991 |
| Rust | static | 2015 |

That's all — a final paragraph after the table.
`;

const TABLE_SAMPLE = `| Name | Description | Value |
| :--- | :--- | ---: |
| alpha | The first letter of the Greek alphabet, used here to check that long cells wrap rather than overflow | 1 |
| beta | Second | 2 |
| gamma | Third | 3 |
`;

const CODE_SAMPLE = `\`\`\`python
import sys

def main(argv: list[str]) -> int:
    """Print the arguments, one per line."""
    for i, arg in enumerate(argv):
        print(f"{i}: {arg} — a deliberately long line that will need to wrap in a sixty column terminal")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
\`\`\`
`;

function longResponse(lines: number): string {
  const out: string[] = ['# A very long answer', ''];
  let section = 0;
  while (out.length < lines) {
    section++;
    out.push(`## Section ${section}`, '');
    out.push(
      `Paragraph ${section} has **bold text**, \`code\`, and enough words to wrap across the width of a typical terminal window so that wrapping is exercised.`,
      '',
    );
    if (section % 3 === 0) {
      out.push('```js', `function section${section}() {`, `  const values = [${section}, ${section + 1}, ${section + 2}];`, '  return values.map((v) => v * 2);', '}', '```', '');
    } else if (section % 3 === 1) {
      out.push('| key | value |', '| --- | --- |', `| section | ${section} |`, `| square | ${section * section} |`, '');
    } else {
      out.push(`- item ${section}.1`, `- item ${section}.2`, `- item ${section}.3`, '');
    }
  }
  out.push('The end.');
  return out.join('\n') + '\n';
}
