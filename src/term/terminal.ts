// Owns the real TTY: raw mode, bracketed paste, kitty keyboard protocol
// negotiation, the stdout proxy handed to Ink, resize debouncing, and —
// most importantly — restoring the terminal on every kind of exit.

import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { KeyDecoder, type InputEvent } from './keys.js';
import { inTmux } from './caps.js';

const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const KITTY_QUERY = '\x1b[?u';
const DA1_QUERY = '\x1b[c';
const KITTY_PUSH = '\x1b[>1u'; // disambiguate escape codes
const KITTY_POP = '\x1b[<u';
const MOK_ON = '\x1b[>4;1m'; // xterm modifyOtherKeys level 1
const MOK_OFF = '\x1b[>4;0m';
const SHOW_CURSOR = '\x1b[?25h';
const TITLE_PUSH = '\x1b[22;0t';
const TITLE_POP = '\x1b[23;0t';
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** The stdout Ink renders to. Resize events are forwarded only after the
 * app has cleared the screen, so Ink never redraws over reflowed text. */
export class InkStdout extends EventEmitter {
  columns: number;
  rows: number;
  readonly isTTY = true;
  writable = true;

  constructor(private readonly out: NodeJS.WriteStream) {
    super();
    this.columns = out.columns || 80;
    this.rows = out.rows || 24;
  }

  write(data: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  write(data: string | Uint8Array, enc?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
  write(data: string | Uint8Array, a?: unknown, b?: unknown): boolean {
    const cb = (typeof a === 'function' ? a : b) as ((err?: Error | null) => void) | undefined;
    return this.out.write(data, cb);
  }

  /** Called by the app once it has handled a resize. */
  applySize(): void {
    this.columns = this.out.columns || this.columns;
    this.rows = this.out.rows || this.rows;
    this.emit('resize');
  }
}

let restoreSequence = '';
let restored = true;

/** Synchronously undo every terminal mode we changed. Safe to call twice. */
export function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    writeSync(1, restoreSequence);
  } catch {
    /* stdout may be gone (SIGHUP) */
  }
}

export interface TerminalOptions {
  setTitle: boolean;
}

export class TerminalController extends EventEmitter {
  readonly decoder = new KeyDecoder();
  readonly inkStdout: InkStdout;
  kitty = false;
  private escTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private probeDone!: () => void;
  readonly probed: Promise<void>;
  private titleSet = false;

  constructor(private readonly opts: TerminalOptions) {
    super();
    this.inkStdout = new InkStdout(process.stdout);
    this.probed = new Promise((r) => (this.probeDone = r));
  }

  start(): void {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', this.onData);
    stdin.resume();
    restored = false;
    restoreSequence = BRACKETED_PASTE_OFF + KITTY_POP + MOK_OFF + SHOW_CURSOR + '\x1b[0m';
    if (this.opts.setTitle) restoreSequence += TITLE_POP;
    let init = BRACKETED_PASTE_ON + KITTY_QUERY + DA1_QUERY;
    if (this.opts.setTitle) init += TITLE_PUSH;
    process.stdout.write(init);
    // If the terminal answers neither query, give up after a moment.
    setTimeout(() => this.finishProbe(false), 300).unref();
    process.stdout.on('resize', this.onResize);
  }

  private finishProbe(kitty: boolean): void {
    if (this.kitty || !this.probeDone) return;
    if (kitty) {
      this.kitty = true;
      process.stdout.write(KITTY_PUSH);
    } else {
      // Harmless where unsupported; enables Shift+Enter in xterm and in tmux
      // with extended-keys.
      process.stdout.write(MOK_ON);
    }
    const done = this.probeDone;
    this.probeDone = undefined as unknown as () => void;
    done();
  }

  private onData = (data: string): void => {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.dispatch(this.decoder.feed(data));
    if (this.decoder.pending) {
      // A lone ESC: wait briefly for the rest of a sequence (longer over SSH
      // and tmux, where sequences can be split).
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        this.dispatch(this.decoder.flush());
      }, inTmux() || process.env.SSH_TTY ? 60 : 25);
    }
  };

  private dispatch(events: InputEvent[]): void {
    for (const e of events) {
      if (e.type === 'kitty-flags') {
        this.finishProbe(true);
        continue;
      }
      if (e.type === 'device-attributes') {
        // DA1 always answers; if kitty did not answer first, it's unsupported.
        setTimeout(() => this.finishProbe(false), 0);
        continue;
      }
      this.emit('input', e);
    }
  }

  private onResize = (): void => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.emit('resize', process.stdout.columns, process.stdout.rows);
    }, 60);
  };

  setTitle(title: string): void {
    if (!this.opts.setTitle) return;
    this.titleSet = true;
    // Strip control characters so a title can never inject escape codes.
    const clean = title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 120);
    process.stdout.write(`\x1b]0;${clean}\x07`);
  }

  bell(): void {
    process.stdout.write('\x07');
  }

  /** Hand the terminal to a child process (e.g. $EDITOR). */
  suspend(): void {
    process.stdin.off('data', this.onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(BRACKETED_PASTE_OFF + (this.kitty ? KITTY_POP : MOK_OFF) + SHOW_CURSOR);
  }

  resume(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', this.onData);
    process.stdin.resume();
    process.stdout.write(BRACKETED_PASTE_ON + (this.kitty ? KITTY_PUSH : MOK_ON));
  }

  stop(): void {
    process.stdin.off('data', this.onData);
    process.stdout.off('resize', this.onResize);
    if (this.titleSet || this.opts.setTitle) {
      /* title restored by restore sequence */
    }
    restoreTerminal();
    process.stdin.pause();
  }
}

/** Install handlers so the terminal is restored after crashes and signals. */
export function installExitHandlers(onExit: (code: number, reason: string) => void): void {
  const handle = (code: number, reason: string) => () => onExit(code, reason);
  process.on('SIGTERM', handle(143, 'SIGTERM'));
  process.on('SIGHUP', handle(129, 'SIGHUP'));
  process.on('SIGINT', handle(130, 'SIGINT'));
  process.on('SIGQUIT', handle(131, 'SIGQUIT'));
  process.on('exit', () => restoreTerminal());
  process.on('uncaughtException', (err) => {
    restoreTerminal();
    process.stderr.write(`\nparley crashed: ${err?.stack ?? err}\n`);
    onExit(1, 'crash');
  });
  process.on('unhandledRejection', (err) => {
    restoreTerminal();
    process.stderr.write(`\nparley crashed (unhandled rejection): ${(err as Error)?.stack ?? err}\n`);
    onExit(1, 'crash');
  });
}
