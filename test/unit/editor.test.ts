import { describe, expect, it } from 'vitest';
import * as E from '../../src/ui/editor.js';

const at = (text: string, cursor = text.length): E.EditorState => ({ text, cursor, kill: '' });

describe('editor', () => {
  it('inserts and deletes by grapheme', () => {
    let s = E.insert(E.emptyEditor(), 'aé👩‍👩‍👧日');
    s = E.backspace(s);
    expect(s.text).toBe('aé👩‍👩‍👧');
    s = E.backspace(s);
    expect(s.text).toBe('aé');
    s = E.left(s);
    expect(s.cursor).toBe(1);
    s = E.deleteForward(s);
    expect(s.text).toBe('a');
  });

  it('moves by word and line', () => {
    const s = at('foo bar_baz qux\nsecond line', 13);
    expect(E.wordLeft(s).cursor).toBe(12);
    expect(E.wordLeft(E.wordLeft(s)).cursor).toBe(4);
    expect(E.wordRight(at('foo bar', 0)).cursor).toBe(3);
    expect(E.lineStart(at('ab\ncd', 4)).cursor).toBe(3);
    expect(E.lineEnd(at('ab\ncd', 0)).cursor).toBe(2);
  });

  it('implements readline kills and yank', () => {
    let s = at('hello big world', 10);
    s = E.killWordBack(s);
    expect(s.text).toBe('hello world');
    expect(s.kill).toBe('big ');
    s = E.yank(s);
    expect(s.text).toBe('hello big world');
    expect(E.killToEnd(at('abc\ndef', 1)).text).toBe('a\ndef');
    expect(E.killToEnd(at('abc\ndef', 3)).text).toBe('abcdef');
    expect(E.killToStart(at('abc\ndef', 6)).text).toBe('abc\nf');
  });

  it('treats chips atomically', () => {
    const t = 'see [Pasted text #1 +40 lines] ok';
    let s = at(t, t.indexOf(']') + 1);
    s = E.backspace(s);
    expect(s.text).toBe('see  ok');
    s = E.left(at(t, t.indexOf(']') + 1));
    expect(s.cursor).toBe(4);
  });

  it('word-wraps and locates the cursor', () => {
    const l = E.layout('hello world foo', 15, 10);
    expect(l.rows).toEqual(['hello ', 'world foo']);
    expect(l.cursorRow).toBe(1);
    expect(l.cursorCol).toBe(9);
    const wide = E.layout('日本語日本語', 6, 6);
    expect(wide.rows).toEqual(['日本', '語日', '本語']);
    expect(wide.cursorRow).toBe(2);
    expect(wide.cursorCol).toBe(4);
  });

  it('moves vertically keeping the goal column and reports edges', () => {
    const s = at('abcdef\nxy\nlonger line', 4);
    expect(E.up(s, 40)).toBeNull();
    const d1 = E.down(s, 40)!;
    expect(d1.cursor).toBe(9); // clamped to end of "xy"
    const d2 = E.down(d1, 40)!;
    expect(d2.cursor).toBe(10 + 4); // goal column 4 restored
    expect(E.down(d2, 40)).toBeNull();
  });
});
