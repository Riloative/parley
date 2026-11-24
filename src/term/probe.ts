// Asks the terminal for its background colour (OSC 11) as early as possible,
// so `theme: auto` can pick the light or dark palette before anything is
// drawn. The question goes out as soon as the CLI knows it is interactive;
// the answer is used only if it has arrived by the time the theme is chosen
// (~100 ms later on a typical start). Nothing waits for it, so it never
// delays the first frame, and a terminal that does not answer simply keeps
// the default.
//
// Until the terminal controller takes over stdin (handOver), this module
// owns it: raw mode, so the reply is not echoed; every byte that is not a
// reply to these queries is kept, in order, for the controller. Raw mode is
// undone if the process exits or is killed before the handover.
//
// Deliberately free of imports: it runs before the interface is loaded.

const OSC11_QUERY = '\x1b]11;?\x1b\\';
const DA1_QUERY = '\x1b[c';
// rgb:R/G/B with 1-4 hex digits per channel, ended by BEL or ST.
const OSC11_REPLY = /\x1b\]11;([^\x07\x1b]{1,64})(?:\x07|\x1b\\)/;
const DA1_REPLY = /\x1b\[\?[\d;]*c/;

export type Background = 'light' | 'dark';

export interface EarlyProbe {
  /** The terminal's background, if it has answered by now. */
  background(): Background | undefined;
  /** Stop reading stdin. Returns the bytes read that were not replies (keys
   * typed during start-up), and whether the DA1 reply is still to come, so
   * the controller can ignore it. */
  handOver(): { pending: string; da1Outstanding: boolean };
}

/**
 * The background from the body of an OSC 11 answer: `rgb:R/G/B` or
 * `rgba:R/G/B/A` (1-4 hex digits per channel, as xterm and most terminals
 * answer), or `#rgb`, `#rrggbb`, `#rrrgggbbb`, `#rrrrggggbbbb` (some
 * terminals answer in the form they were configured with).
 */
export function parseBackgroundReply(body: string): Background | undefined {
  const x = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(body.trim());
  if (x && (body.startsWith('rgba') ? body.split('/').length === 4 : body.split('/').length === 3)) return backgroundFromRgb(x[1]!, x[2]!, x[3]!);
  const h = /^#((?:[0-9a-f]{3}){1,4})$/i.exec(body.trim());
  if (h) {
    const n = h[1]!.length / 3;
    return backgroundFromRgb(h[1]!.slice(0, n), h[1]!.slice(n, 2 * n), h[1]!.slice(2 * n));
  }
  return undefined;
}

/** Relative luminance of an `rgb:` reply; above one half is a light background. */
export function backgroundFromRgb(r: string, g: string, b: string): Background {
  const channel = (h: string) => parseInt(h, 16) / (16 ** h.length - 1);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * lin(channel(r)) + 0.7152 * lin(channel(g)) + 0.0722 * lin(channel(b));
  return y > 0.5 ? 'light' : 'dark';
}

export function startEarlyProbe(): EarlyProbe | undefined {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) return undefined;
  try {
    stdin.setRawMode(true);
  } catch {
    return undefined;
  }
  let buf = '';
  let bg: Background | undefined;
  let da1Seen = false;
  const onData = (d: string | Buffer) => {
    buf += String(d);
    const osc = OSC11_REPLY.exec(buf);
    if (osc) {
      bg = parseBackgroundReply(osc[1]!);
      buf = buf.slice(0, osc.index) + buf.slice(osc.index + osc[0].length);
    }
    const da1 = DA1_REPLY.exec(buf);
    if (da1 && !da1Seen) {
      da1Seen = true;
      buf = buf.slice(0, da1.index) + buf.slice(da1.index + da1[0].length);
    }
  };
  const restore = () => {
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  };
  // Killed before the controller takes over: leave the terminal as it was,
  // then die of the same signal.
  const onSignal = (sig: NodeJS.Signals) => {
    restore();
    process.kill(process.pid, sig);
  };
  process.once('exit', restore);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.resume();
  process.stdout.write(OSC11_QUERY + DA1_QUERY);

  let handedOver = false;
  return {
    background: () => bg,
    handOver() {
      if (!handedOver) {
        handedOver = true;
        stdin.off('data', onData);
        stdin.pause();
        process.off('exit', restore);
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
      }
      const pending = buf;
      buf = '';
      return { pending, da1Outstanding: !da1Seen };
    },
  };
}
