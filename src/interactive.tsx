// Interactive mode: wires the terminal, session, transcript and Ink together
// and guarantees the terminal is restored however the process ends.

import React from 'react';
import { PassThrough } from 'node:stream';
import { appendFileSync } from 'node:fs';
import type { Args } from './cli.js';
import { boot, chooseModel, resolveTheme } from './bootstrap.js';
import { Session } from './core/session.js';
import { InputHistory } from './core/history.js';
import { paths } from './config/paths.js';
import { TerminalController, installExitHandlers, restoreTerminal } from './term/terminal.js';
import { TranscriptModel } from './ui/transcript.js';
import { App } from './ui/App.js';
import type { Item } from './ui/blocks.js';
import { loadConfig } from './config/config.js';
import { lineToAnsi } from './render/style.js';

export async function runInteractive(args: Args): Promise<void> {
  const b = boot(args.theme);
  const history = new InputHistory(paths.historyFile);
  history.load();

  let initialConv: string | undefined;
  if (args.continue) initialConv = b.store.list()[0]?.id;
  if (args.resume && args.resumeId) initialConv = args.resumeId;

  const session = new Session({ config: b.config, registry: b.registry, store: b.store, model: chooseModel(b, args.model) });
  if (args.system) session.setSystemPrompt(args.system);

  const notes: Array<{ text: string; tone: 'dim' | 'error' | 'success' | 'warning' }> = b.issues.map((t) => ({ text: t, tone: 'error' as const }));
  if (args.continue && !initialConv) notes.push({ text: 'No previous conversation to continue.', tone: 'dim' });
  const resumeFailed = initialConv ? !session.resume(initialConv) : false;
  if (resumeFailed) notes.push({ text: `Could not open conversation ${initialConv}.`, tone: 'error' });
  if (args.model) session.setModel(args.model);
  if (!session.model && b.configExists) notes.push({ text: 'No model selected yet. Pick one with /model (or set default_model in the config).', tone: 'warning' });

  const terminal = new TerminalController({ setTitle: b.config.terminalTitle });
  const welcome = (): Item => ({
    kind: 'welcome',
    key: `w${Math.random()}`,
    model: session.model || '(none — use /model)',
    hint: '/help for commands · /model to switch · esc to interrupt',
    notes: welcomeNotes(),
  });
  const welcomeNotes = () => notes;
  const transcript = new TranscriptModel(session, process.stdout.columns || 80, welcome);
  if (initialConv && !resumeFailed) transcript.reprint(true);
  // After the first print, start-up notes should not be repeated on reprints.
  setTimeout(() => notes.splice(0), 0);

  // Ink must not touch the real stdin: input is decoded by TerminalController.
  const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const ink: { clear?: () => void } = {};
  let exiting = false;
  const shutdown = (code: number) => {
    if (exiting) return;
    exiting = true;
    try {
      session.flushPersist();
      session.close();
    } catch {
      /* keep going */
    }
    try {
      instance?.unmount();
    } catch {
      /* ignore */
    }
    terminal.stop();
    restoreTerminal();
    if (code === 0 && session.file) {
      process.stdout.write(lineToAnsi([{ text: `\nResume this conversation with: parley -r ${session.file.id}\n`, style: { fg: 'dim' } }]));
    }
    process.exit(code);
  };
  installExitHandlers((code) => shutdown(code));

  terminal.start();
  if (session.conv.title && b.config.terminalTitle) terminal.setTitle(session.conv.title);
  else if (b.config.terminalTitle) terminal.setTitle('parley');

  const { render } = await import('ink');
  const instance = render(
    <App
      session={session}
      transcript={transcript}
      terminal={terminal}
      history={history}
      store={b.store}
      config={b.config}
      configFile={b.configFile}
      reloadConfig={() => loadConfig(b.configFile).config}
      onExit={() => setTimeout(() => shutdown(0), 0)}
      initial={!b.configExists && !args.model ? 'setup' : args.resume && !args.resumeId ? 'resume' : undefined}
      resolveTheme={(t) => resolveTheme(t)}
      ink={ink}
    />,
    {
      stdout: terminal.inkStdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin,
      exitOnCtrlC: false,
      patchConsole: true,
      maxFps: 30,
      incrementalRendering: true,
      interactive: true,
    },
  );
  ink.clear = () => instance.clear();
  if (process.env.PARLEY_STARTUP_TRACE) {
    // Time from process start to the first rendered frame (for profiling).
    void instance.waitUntilRenderFlush().then(() => {
      appendFileSync(process.env.PARLEY_STARTUP_TRACE!, `${performance.now().toFixed(1)}\n`);
    });
  }

  if (args.prompt) {
    const p = args.prompt;
    setTimeout(() => void session.submit({ text: p }), 50);
  }
  await instance.waitUntilExit().catch(() => undefined);
  shutdown(0);
}
