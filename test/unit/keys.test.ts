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
