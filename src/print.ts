// Non-interactive mode (`parley -p`): stream the answer to stdout and exit.
// No colour or spinner unless stdout is a terminal; errors go to stderr with
// a non-zero exit code.

import type { Args } from './cli.js';
import { boot, chooseModel } from './bootstrap.js';
import { Session, type SessionEvent } from './core/session.js';
import { StreamingMarkdown } from './render/markdown.js';
import { lineToAnsi, type Line } from './render/style.js';
import { loadHighlighter } from './render/highlight.js';
import { setColorLevel } from './term/caps.js';
import { FRAMES, STILL_FRAME } from './ui/Spinner.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runPrint(args: Args): Promise<number> {
  const tty = !!process.stdout.isTTY;
  if (!tty) setColorLevel(0);
  const b = boot(args.theme);
  for (const i of b.issues) process.stderr.write(`parley: ${i}\n`);

  const piped = await readStdin();
  let prompt = args.prompt ?? '';
  if (piped.trim()) prompt = prompt ? `${piped.replace(/\s+$/, '')}\n\n${prompt}` : piped;
  if (!prompt.trim()) {
    process.stderr.write('parley: no prompt given. Usage: parley -p "question"   or   cat file | parley -p "instruction"\n');
    return 2;
  }

  const session = new Session({ config: b.config, registry: b.registry, store: b.store, model: '' });
  // Report notices raised while opening the conversation (e.g. it is locked
  // by another parley window) before the main listener is attached.
  const early: string[] = [];
  const onEarly = (e: SessionEvent) => {
    if (e.type === 'notice' && e.tone === 'error') early.push(e.text);
  };
  session.on('event', onEarly);
  const resumeId = args.continue ? b.store.list()[0]?.id : args.resume ? args.resumeId : undefined;
  if (resumeId && !session.resume(resumeId)) {
    process.stderr.write(`parley: ${early[0] ?? `could not open conversation ${resumeId}`}\n`);
    return 1;
  }
  session.off('event', onEarly);
  const model = chooseModel(b, args.model, session.conv.model);
  if (!model) {
    process.stderr.write('parley: no model selected. Use -m provider/model-id, or set default_model in the config file.\n');
    return 2;
  }
  session.setModel(model);
  if (args.system) session.setSystemPrompt(args.system);

  const width = Math.min(process.stdout.columns || 100, 120);
  const md = tty && !args.json ? new StreamingMarkdown(width) : null;
  if (md) await loadHighlighter();
  let written = 0;
  let errorText: string | undefined;
  let final: SessionEvent | undefined;
  let spinner: NodeJS.Timeout | null = null;
  let frame = 0;
  const writeLines = (lines: Line[]) => {
    if (lines.length) process.stdout.write(lines.map(lineToAnsi).join('\n') + '\n');
  };
  const stopSpinner = () => {
    if (spinner) {
      clearInterval(spinner);
      spinner = null;
      process.stderr.write('\r\x1b[2K');
    }
  };
  if (tty && process.stderr.isTTY && !args.json && b.config.reducedMotion) {
    // Reduced motion: one still line, removed when the reply starts.
    process.stderr.write(`\x1b[38;2;217;119;87m${STILL_FRAME}\x1b[0m Thinking…`);
    spinner = setInterval(() => {
      if (session.stream?.text) stopSpinner();
    }, 120);
  } else if (tty && process.stderr.isTTY && !args.json) {
    spinner = setInterval(() => {
      if (session.stream?.text) return stopSpinner();
      process.stderr.write(`\r\x1b[2K\x1b[38;2;217;119;87m${FRAMES[frame++ % FRAMES.length]}\x1b[0m ${session.stream?.status === 'retrying' ? 'Retrying…' : 'Thinking…'}`);
    }, 120);
  }

  session.on('event', (e: SessionEvent) => {
    if (e.type === 'frame' || e.type === 'assistant-end') {
      const text = session.stream?.text ?? (e.type === 'assistant-end' ? e.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '');
      if (args.json) {
        /* collected at the end */
      } else if (md) {
        if (text) stopSpinner();
        const u = md.update(text, e.type === 'assistant-end');
        writeLines(u.commit);
      } else if (text.length > written) {
        process.stdout.write(text.slice(written));
        written = text.length;
      }
    }
    if (e.type === 'assistant-end') final = e;
    if (e.type === 'notice' && e.tone === 'error') errorText = e.text;
    if (e.type === 'notice' && e.tone === 'warning') process.stderr.write(`parley: ${e.text}\n`);
  });

  const onSig = () => session.interrupt();
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  // Make sure the last partial delta is on disk if the terminal goes away.
  process.once('SIGHUP', () => {
    session.flushPersist();
    session.interrupt();
  });

  await session.submit({ text: prompt });
  stopSpinner();
  session.close();

  const end = final && final.type === 'assistant-end' ? final : undefined;
  if (args.json) {
    const m = end?.message;
    const out = {
      model,
      conversation_id: session.file?.id ?? null,
      text: m?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '',
      reasoning: m?.content.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('') || undefined,
      stop_reason: m?.stopReason ?? null,
      interrupted: !!m?.interrupted,
      error: errorText ?? m?.error ?? null,
      usage: m?.usage ?? null,
      duration_ms: end?.stats.durationMs ?? null,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (!md && written > 0 && !(session.conv.head?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '').endsWith('\n')) {
    process.stdout.write('\n');
  }
  if (errorText) {
    process.stderr.write(`parley: ${errorText}\n`);
    return 1;
  }
  if (end?.outcome === 'interrupted') return 130;
  return 0;
}
