// Interactive mode: wires the terminal, session, transcript and Ink together
// and guarantees the terminal is restored however the process ends.

import React from 'react';
import { PassThrough } from 'node:stream';
import { appendFileSync, writeSync } from 'node:fs';
import type { Args } from './cli.js';
import { boot, chooseModel, resolveTheme } from './bootstrap.js';
import { getTheme, setTheme } from './render/theme.js';
import { Session } from './core/session.js';
import { InputHistory } from './core/history.js';
import { paths } from './config/paths.js';
import { TerminalController, installExitHandlers, restoreTerminal } from './term/terminal.js';
import type { Background, EarlyProbe } from './term/probe.js';
import { flushDrafts, pruneDrafts } from './core/drafts.js';
import { renameNotices } from './brand.js';
import { VERSION } from './version.js';
import { notifier } from './ui/notify.js';
import { TranscriptModel } from './ui/transcript.js';
import { App } from './ui/App.js';
import type { Item } from './ui/blocks.js';
import { loadConfig } from './config/config.js';
import { lineToAnsi } from './render/style.js';
import { mark, startupMarks } from './trace.js';
import { redact } from './config/credentials.js';

function crashReport(e: unknown): string {
  return `\ntaria crashed: ${redact(String((e as Error)?.stack ?? e))}\n`;
}

/**
 * Catches an exception thrown while rendering, before Ink's own error screen
 * can show it. That screen prints the message unredacted and a "source"
 * excerpt read from the file in the stack trace, which in the standalone
 * binary is the 150 MB executable: seconds of raw bytes written to the
 * terminal. Render nothing, and let shutdown restore the terminal and print
 * a redacted report.
 */
class CrashBoundary extends React.Component<{ onCrash: (e: unknown) => void; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(e: unknown): void {
    this.props.onCrash(e);
  }
  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Write before process.exit(): synchronously, so nothing is dropped, with an
 * async fallback if the descriptor is non-blocking and full (EAGAIN). */
function writeNow(fd: 1 | 2, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    (fd === 1 ? process.stdout : process.stderr).write(text);
  }
}

export async function runInteractive(args: Args, probe?: EarlyProbe): Promise<void> {
  mark('boot-start');
  const b = boot(args.theme, probe?.background());
  mark('booted');
  const history = new InputHistory(paths.historyFile);
  history.load();
  pruneDrafts();

  let initialConv: string | undefined;
  if (args.continue) initialConv = b.store.list()[0]?.id;
  if (args.resume && args.resumeId) initialConv = args.resumeId;

  const session = new Session({ config: b.config, registry: b.registry, store: b.store, model: chooseModel(b, args.model) });
  if (args.system) session.setSystemPrompt(args.system);

  const notes: Array<{ text: string; tone: 'dim' | 'error' | 'success' | 'warning' }> = b.issues.map((t) => ({ text: t, tone: 'error' as const }));
  for (const n of renameNotices.splice(0)) notes.push({ text: n, tone: /^(Migration|Note):/.test(n) ? 'warning' : 'dim' });
  if (args.continue && !initialConv) notes.push({ text: 'No previous conversation to continue.', tone: 'dim' });
  const resumeFailed = initialConv ? !session.resume(initialConv) : false;
  if (resumeFailed) notes.push({ text: `Could not open conversation ${initialConv}.`, tone: 'error' });
  if (args.model) session.setModel(args.model);
  if (!session.model && b.configExists) notes.push({ text: 'No model selected yet. Pick one with /model (or set default_model in the config).', tone: 'warning' });

  const terminal = new TerminalController({ setTitle: b.config.terminalTitle, probe, focusReports: notifier(b.config) !== undefined });
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
  const shutdown = (code: number, report?: string) => {
    if (exiting) {
      // A crash during shutdown: the terminal is already being restored.
      if (report) writeNow(2, report);
      return;
    }
    exiting = true;
    // The unsent draft first: it is the one thing not on disk yet.
    flushDrafts();
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
    if (report) writeNow(2, report);
    if (code === 0 && session.file) {
      // Synchronous: process.exit() follows, and an async write to a pipe or
      // (on macOS) a pty could be dropped.
      writeNow(1, lineToAnsi([{ text: `\nResume this conversation with: taria -r ${session.file.id}\n`, style: { fg: 'dim' } }]));
    }
    process.exit(code);
  };
  installExitHandlers((code, _reason, report) => shutdown(code, report));

  // The terminal's background answer may have arrived since boot(). Loading
  // the interface is synchronous, so a reply already sitting in the input
  // buffer has not been read yet: give the event loop one turn to read it
  // (well under a millisecond; this never waits for the terminal). Nothing
  // has been drawn yet and the probe still owns stdin, so the answer can
  // still choose the palette.
  if (probe && !probe.background()) await new Promise((r) => setImmediate(r));
  let background = probe?.background();
  if (background) setTheme(resolveTheme(args.theme ?? b.config.theme, process.env, background));
  // A later answer (a slow link) still applies to everything drawn from then
  // on. What is already printed keeps its colours: reprinting would clear
  // the scrollback, including the shell history above taria. The one
  // exception is a welcome box that is still alone on the screen, which the
  // app draws again in place.

  terminal.on('background', (bg: Background) => {
    if (background) return;
    background = bg;
    const t = resolveTheme(args.theme ?? session.config.theme, process.env, bg);
    if (t === getTheme().name) return;
    setTheme(t);
    transcript.emit('repaint-welcome');
    transcript.emit('change');
  });
  terminal.start();
  if (session.conv.title && b.config.terminalTitle) terminal.setTitle(session.conv.title);
  else if (b.config.terminalTitle) terminal.setTitle('taria');

  mark('terminal-started');
  const { render } = await import('ink');
  mark('ink-loaded');
  const instance = render(
    <CrashBoundary onCrash={(e) => setImmediate(() => shutdown(1, crashReport(e)))}>
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
        resolveTheme={(t) => resolveTheme(t, process.env, background)}
        ink={ink}
      />
    </CrashBoundary>,
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
  if (process.env.TARIA_STARTUP_TRACE) {
    // Time from process start to the first rendered frame (for profiling).
    void instance.waitUntilRenderFlush().then(() => {
      mark('first-frame');
      appendFileSync(process.env.TARIA_STARTUP_TRACE!, `${performance.now().toFixed(1)}\n${JSON.stringify(startupMarks())}\n`);
    });
  }

  if (b.config.checkForUpdates) {
    // Opt-in, and only once the interface is up: it never delays a frame.
    setTimeout(() => {
      void import('./core/update.js').then(async (u) => {
        const v = await u.newerVersion({ enabled: true });
        if (v && !exiting) transcript.notice(`taria ${v} is available (this is ${VERSION}): ${u.RELEASES_PAGE} · check_for_updates: false turns this notice off`);
      });
    }, 1000).unref();
  }

  if (args.prompt) {
    const p = args.prompt;
    setTimeout(() => void session.submit({ text: p }), 50);
  }
  if (process.env.TARIA_DEBUG_CRASH?.startsWith('uncaught')) {
    // Test hook: crash outside React after a delay.
    const ms = Number(process.env.TARIA_DEBUG_CRASH.split(':')[1] ?? 0);
    setTimeout(() => {
      throw new Error('debug crash (uncaught)');
    }, ms);
  }
  let crash: unknown;
  await instance.waitUntilExit().catch((e: unknown) => {
    crash = e;
  });
  if (crash) {
    // Ink unmounts on an exception inside a component; report it instead of
    // exiting as if nothing happened.
    shutdown(1, crashReport(crash));
    return;
  }
  shutdown(0);
}
