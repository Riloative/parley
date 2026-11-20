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
