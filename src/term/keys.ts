// Raw stdin → key events. Handles legacy xterm sequences, SS3, the kitty
// keyboard protocol (CSI u), xterm modifyOtherKeys (CSI 27;m;c~), bracketed
// paste, and capability query responses. Pure and synchronous: feed bytes,
// get events; the caller arranges a short timer to flush a lone ESC.
import { backgroundFromRgb, type Background } from './probe.js';

export interface Key {
  name: string; // 'char' for text input, otherwise a key name
  text?: string; // for 'char': the inserted text (may be several characters)
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super?: boolean;
}

export type InputEvent =
  | { type: 'key'; key: Key }
  | { type: 'paste'; text: string }
  | { type: 'kitty-flags'; flags: number }
  | { type: 'device-attributes' }
  /** Focus reporting (DEC 1004): the terminal window gained or lost focus. */
  | { type: 'focus'; focused: boolean }
  /** The terminal's answer to the OSC 11 background-colour query. */
  | { type: 'background'; background: Background };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const k = (name: string, mods: Partial<Key> = {}): InputEvent => ({
  type: 'key',
  key: { name, ctrl: false, alt: false, shift: false, ...mods },
});

function modsFromParam(m: number | undefined): Pick<Key, 'shift' | 'alt' | 'ctrl' | 'super'> {
  const v = (m ?? 1) - 1;
  return { shift: !!(v & 1), alt: !!(v & 2), ctrl: !!(v & 4), super: !!(v & 8) };
}

const CSI_LETTER: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  E: 'begin',
};

const TILDE: Record<number, string> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

function codepointKey(code: number, mods: Pick<Key, 'shift' | 'alt' | 'ctrl' | 'super'>, text?: string): InputEvent | undefined {
  switch (code) {
    case 13:
    case 57414:
      return k('enter', mods);
    case 9:
      return k('tab', mods);
    case 127:
    case 8:
      return k('backspace', mods);
    case 27:
      return k('escape', mods);
    case 57399:
    case 57400:
    case 57401:
    case 57402:
    case 57403:
    case 57404:
    case 57405:
    case 57406:
    case 57407:
    case 57408:
      return { type: 'key', key: { name: 'char', text: String(code - 57399), ...mods } };
  }
  // Modifier-only key presses (shift, ctrl...) in the private-use range.
  if (code >= 57344 && code <= 63743) return undefined;
  if (mods.ctrl || mods.alt || mods.super) {
    const ch = String.fromCodePoint(code);
    return { type: 'key', key: { name: ch.toLowerCase(), text: ch, ...mods } };
  }
  return { type: 'key', key: { name: 'char', text: text ?? String.fromCodePoint(code), ...mods } };
}

/** An unterminated OSC, DCS or APC string that looks like a terminal's
 * reply (not Alt+] or Alt+P followed by typing). */
const REPLY_HEAD = /^\x1b(?:\]\d|P[0-9>+$!|=]|_G)/;
/** How long the end of such a reply is waited for before input is read as
 * keys again. */
const REPLY_WAIT_MS = 2000;

export class KeyDecoder {
  private buf = '';
  private paste: string | undefined;
  /** When the wait for the rest of a split reply began. */
  private replySince: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** True when a lone ESC (or partial sequence) is waiting for more bytes. */
  get pending(): boolean {
    return this.buf.length > 0 && this.paste === undefined;
  }

  feed(data: string): InputEvent[] {
    const out: InputEvent[] = [];
    if (this.replySince !== undefined) {
      // The start of a reply is waiting for its end. Give up on it after a
      // while, so a lost terminator cannot swallow what is typed later.
      if (this.now() - this.replySince > REPLY_WAIT_MS) {
        this.buf = '';
        this.replySince = undefined;
      }
    }
    this.buf += data;
    while (this.buf.length) {
      if (this.paste !== undefined) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible partial terminator in the buffer.
          const esc = this.buf.lastIndexOf('\x1b');
          const safe = esc >= 0 && PASTE_END.startsWith(this.buf.slice(esc)) ? esc : this.buf.length;
          this.paste += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + PASTE_END.length);
        out.push({ type: 'paste', text: this.paste.replace(/\r\n?/g, '\n') });
        this.paste = undefined;
        continue;
      }
      const consumed = this.parseOne(out);
      if (consumed === 0) break; // incomplete sequence: wait for more
      this.buf = this.buf.slice(consumed);
    }
    if (!REPLY_HEAD.test(this.buf)) this.replySince = undefined;
    return out;
  }

  /** Called after a short timeout: interpret buffered bytes as complete. */
  flush(): InputEvent[] {
    if (this.paste !== undefined || !this.buf) return [];
    const b = this.buf;
    if (REPLY_HEAD.test(b)) {
      // A terminal reply cut in two by the link (slow SSH): its second half
      // must not be read as typed text, so keep waiting for the terminator.
      this.replySince ??= this.now();
      return [];
    }
    this.buf = '';
    if (b === '\x1b') return [k('escape')];
    if (b === '\x1b\x1b') return [k('escape'), k('escape')];
    if (b.startsWith('\x1b') && b.length === 2) return [{ type: 'key', key: { name: b[1]!.toLowerCase(), text: b[1]!, ctrl: false, alt: true, shift: false } }];
    // Unknown partial sequence: drop it rather than inserting garbage.
    return [];
  }

  private parseOne(out: InputEvent[]): number {
    const b = this.buf;
    const c = b.charCodeAt(0);
    if (c === 0x1b) return this.parseEscape(out);
    if (c === 0x0d) {
      out.push(k('enter'));
      return b[1] === '\n' ? 2 : 1;
    }
    if (c === 0x0a) {
      out.push(k('j', { ctrl: true }));
      return 1;
    }
    if (c === 0x09) {
      out.push(k('tab'));
      return 1;
    }
    if (c === 0x7f || c === 0x08) {
      out.push(k('backspace'));
      return 1;
    }
    if (c === 0) {
      out.push(k('space', { ctrl: true }));
      return 1;
    }
    if (c < 0x20) {
      // Ctrl+A..Ctrl+Z and a few punctuation controls.
      const map: Record<number, string> = { 0x1c: '\\', 0x1d: ']', 0x1e: '^', 0x1f: '_' };
      const name = map[c] ?? String.fromCharCode(c + 0x60);
      out.push(k(name, { ctrl: true }));
      return 1;
    }
    // Printable run.
    let i = 0;
    while (i < b.length) {
      const cc = b.charCodeAt(i);
      if (cc < 0x20 || cc === 0x7f || cc === 0x1b) break;
      i++;
    }
    out.push({ type: 'key', key: { name: 'char', text: b.slice(0, i), ctrl: false, alt: false, shift: false } });
    return i;
  }

  private parseEscape(out: InputEvent[]): number {
    const b = this.buf;
    if (b.length === 1) return 0; // lone ESC: wait (flush() decides)
    const n = b[1]!;
    if (n === '[') return this.parseCsi(out);
    if (n === 'O') {
      if (b.length < 3) return 0;
      const name = CSI_LETTER[b[2]!];
      if (name) out.push(k(name));
      return 3;
    }
    if (n === ']' || n === 'P' || n === '_') {
      // OSC / DCS / APC reply (e.g. colour queries): never input. Report the
      // background colour; skip the rest to ST or BEL.
      const st = b.search(/\x07|\x1b\\/);
      if (st < 0) return b.length > 4096 ? b.length : 0;
      const bg = /^\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(b.slice(0, st));
      if (bg) out.push({ type: 'background', background: backgroundFromRgb(bg[1]!, bg[2]!, bg[3]!) });
      return st + (b[st] === '\x07' ? 1 : 2);
    }
    if (n === '\x1b') {
      // ESC ESC: either Alt+Esc or two presses. Treat as escape, then reparse.
      out.push(k('escape'));
      return 1;
    }
    if (n === '\r') {
      out.push(k('enter', { alt: true }));
      return 2;
    }
    if (n === '\n') {
      out.push(k('enter', { alt: true }));
      return 2;
    }
    if (n === '\x7f' || n === '\x08') {
      out.push(k('backspace', { alt: true }));
      return 2;
    }
    const cc = n.charCodeAt(0);
    if (cc < 0x20) {
      out.push(k(String.fromCharCode(cc + 0x60), { ctrl: true, alt: true }));
      return 2;
    }
    // Alt+character (one grapheme's worth of code units is enough here).
    const cp = n.codePointAt(0)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = b.slice(1, 1 + len);
    out.push({ type: 'key', key: { name: ch.toLowerCase(), text: ch, ctrl: false, alt: true, shift: false } });
    return 1 + len;
  }

  private parseCsi(out: InputEvent[]): number {
    const b = this.buf;
    // CSI params (0x30–0x3F)* intermediates (0x20–0x2F)* final (0x40–0x7E)
    let i = 2;
    while (i < b.length && b.charCodeAt(i) >= 0x30 && b.charCodeAt(i) <= 0x3f) i++;
    while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x2f) i++;
    if (i >= b.length) return b.length > 64 ? b.length : 0;
    const final = b[i]!;
    const params = b.slice(2, i);
    const len = i + 1;
    const seq = b.slice(0, len);

    if (seq === PASTE_START) {
      this.paste = '';
      return len;
    }
    if (seq === PASTE_END) return len; // stray

    if (params.startsWith('?')) {
      if (final === 'u') out.push({ type: 'kitty-flags', flags: Number(params.slice(1)) || 0 });
      else if (final === 'c') out.push({ type: 'device-attributes' });
      return len;
    }
    if (params.startsWith('>') || params.startsWith('=')) return len; // other replies

    const parts = params.split(';');
    const nums = parts.map((p) => Number(p.split(':')[0]));

    if (final === 'u') {
      // kitty: code[:shifted[:base]];mods[:event];text
      const code = nums[0] ?? 0;
      const modField = parts[1] ?? '1';
      const [modStr, eventStr] = modField.split(':');
      if (eventStr === '3') return len; // key release
      const mods = modsFromParam(Number(modStr) || 1);
      const textCodes = parts[2]?.split(':').map(Number).filter((x) => x > 0);
      const text = textCodes?.length ? String.fromCodePoint(...textCodes) : undefined;
      const shifted = parts[0]?.split(':')[1];
      let ev: InputEvent | undefined;
      if (mods.shift && shifted && !mods.ctrl && !mods.alt) {
        ev = codepointKey(Number(shifted), { ...mods, shift: false }, text);
      } else {
        ev = codepointKey(code, mods, text);
      }
      if (ev) out.push(ev);
      return len;
    }
    if (final === '~') {
      if (nums[0] === 27 && nums.length >= 3) {
        // xterm modifyOtherKeys: CSI 27 ; mods ; code ~
        const ev = codepointKey(nums[2]!, modsFromParam(nums[1]));
        if (ev) out.push(ev);
        return len;
      }
      const name = TILDE[nums[0] ?? 0];
      if (name) out.push(k(name, modsFromParam(nums[1])));
      return len;
    }
    if (final === 'Z') {
      out.push(k('tab', { shift: true }));
      return len;
    }
    if ((final === 'I' || final === 'O') && params === '') {
      // Focus in/out (DEC 1004): never input.
      out.push({ type: 'focus', focused: final === 'I' });
      return len;
    }
    const name = CSI_LETTER[final];
    if (name) out.push(k(name, modsFromParam(nums.length > 1 ? nums[1] : undefined)));
    return len;
  }
}

/** Is this key a "text insert" (no command modifiers)? */
export function isText(key: Key): key is Key & { text: string } {
  return key.name === 'char' && !key.ctrl && !key.alt && !key.super && typeof key.text === 'string';
}
