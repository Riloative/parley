import { describe, expect, it } from 'vitest';
import { KeyDecoder, type InputEvent } from '../../src/term/keys.js';

const keys = (evs: InputEvent[]) =>
  evs.map((e) => (e.type === 'key' ? `${e.key.ctrl ? 'C-' : ''}${e.key.alt ? 'M-' : ''}${e.key.shift ? 'S-' : ''}${e.key.name}${e.key.name === 'char' ? `(${e.key.text})` : ''}` : e.type === 'paste' ? `paste(${e.text})` : e.type));

describe('KeyDecoder', () => {
  it('decodes legacy keys', () => {
    const d = new KeyDecoder();
    expect(keys(d.feed('ab\r\x7f\x01\x0a\t\x1b[A\x1b[1;5C\x1b[Z\x1b[3~'))).toEqual([
      'char(ab)', 'enter', 'backspace', 'C-a', 'C-j', 'tab', 'up', 'C-right', 'S-tab', 'delete',
    ]);
  });
  it('decodes kitty CSI u keys', () => {
    const d = new KeyDecoder();
    expect(keys(d.feed('\x1b[13;2u\x1b[27u\x1b[97;5u\x1b[13;3u\x1b[99;5:3u'))).toEqual(['S-enter', 'escape', 'C-a', 'M-enter']);
  });
  it('decodes modifyOtherKeys', () => {
    expect(keys(new KeyDecoder().feed('\x1b[27;2;13~'))).toEqual(['S-enter']);
  });
  it('handles alt combos and lone escape via flush', () => {
    const d = new KeyDecoder();
    expect(keys(d.feed('\x1b\r\x1bb'))).toEqual(['M-enter', 'M-b']);
    expect(keys(d.feed('\x1b'))).toEqual([]);
    expect(d.pending).toBe(true);
    expect(keys(d.flush())).toEqual(['escape']);
  });
  it('assembles bracketed paste across chunks', () => {
    const d = new KeyDecoder();
    expect(keys(d.feed('\x1b[200~hello\r\nwor'))).toEqual([]);
    expect(keys(d.feed('ld\x1b[20'))).toEqual([]);
    expect(keys(d.feed('1~x'))).toEqual(['paste(hello\nworld)', 'char(x)']);
  });
  it('reports kitty flags and device attributes', () => {
    expect(keys(new KeyDecoder().feed('\x1b[?1u\x1b[?62;22c'))).toEqual(['kitty-flags', 'device-attributes']);
  });
  it('splits sequences across chunks', () => {
    const d = new KeyDecoder();
    expect(keys(d.feed('\x1b['))).toEqual([]);
    expect(keys(d.feed('1;2'))).toEqual([]);
    expect(keys(d.feed('D'))).toEqual(['S-left']);
  });
  it('passes emoji and CJK through as text', () => {
    expect(keys(new KeyDecoder().feed('日本👩‍👩‍👧'))).toEqual(['char(日本👩‍👩‍👧)']);
  });
});

describe('terminal replies split across reads', () => {
  it('a background-colour reply that arrives in two pieces is still a reply, never typed text', () => {
    for (const end of ['\x1b\\', '\x07']) {
      const d = new KeyDecoder();
      expect(d.feed('\x1b]11;rgb:ffff/ff')).toEqual([]);
      // The wait for the rest of the sequence runs out before the rest arrives.
      expect(d.flush()).toEqual([]);
      const evs = d.feed(`ff/ffff${end}cd`);
      expect(keys(evs)).toEqual(['background', 'char(cd)']);
      expect(evs[0]).toMatchObject({ type: 'background', background: 'light' });
    }
  });

  it('the same for DCS replies, while Alt+] and Alt+P stay keys', () => {
    const d = new KeyDecoder();
    expect(d.feed('\x1bP>|tmux 3')).toEqual([]);
    expect(d.flush()).toEqual([]);
    expect(keys(d.feed('.4\x1b\\x'))).toEqual(['char(x)']);
    expect(d.feed('\x1b]')).toEqual([]);
    expect(keys(d.flush())).toEqual(['M-]']);
    expect(d.feed('\x1bP')).toEqual([]);
    expect(keys(d.flush())).toEqual(['M-p']);
    expect(keys(d.feed('ok'))).toEqual(['char(ok)']);
  });

  it('a reply whose end never arrives stops swallowing input after two seconds', () => {
    let now = 1000;
    const d = new KeyDecoder(() => now);
    expect(d.feed('\x1b]11;rgb:ffff/ff')).toEqual([]);
    expect(d.flush()).toEqual([]);
    // Typing soon after is still taken for the reply (that is the bug being
    // avoided the other way round), but the wait is counted from its start.
    now += 1500;
    expect(d.feed('a')).toEqual([]);
    expect(d.flush()).toEqual([]);
    now += 1000;
    expect(keys(d.feed('hello'))).toEqual(['char(hello)']);
  });
});
