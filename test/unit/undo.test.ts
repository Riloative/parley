import { describe, expect, it } from 'vitest';
import { UndoStack } from '../../src/ui/undo.js';
import { editorWith, emptyEditor, type EditorState } from '../../src/ui/editor.js';

function type(u: UndoStack, s: EditorState, text: string, t: { now: number }, gap = 50): EditorState {
  for (const ch of text) {
    const next = { ...s, text: s.text.slice(0, s.cursor) + ch + s.text.slice(s.cursor), cursor: s.cursor + 1 };
    t.now += gap;
    u.record(s, next, t.now);
    s = next;
  }
  return s;
}

describe('UndoStack', () => {
  it('groups a run of typing by word and by pause', () => {
    const u = new UndoStack();
    const t = { now: 1000 };
    let s = type(u, emptyEditor(), 'hello world', t);
    s = u.undo(s)!;
    expect(s.text).toBe('hello');
    s = u.undo(s)!;
    expect(s.text).toBe('');
    expect(u.undo(s)).toBeUndefined();
    s = u.redo(s)!;
    expect(s.text).toBe('hello');
    s = u.redo(s)!;
    expect(s.text).toBe('hello world');
    expect(u.redo(s)).toBeUndefined();

    // A pause starts a new group.
    const v = new UndoStack();
    let e = type(v, emptyEditor(), 'ab', t);
    t.now += 5000;
    e = type(v, e, 'cd', t);
    expect(v.undo(e)!.text).toBe('ab');
  });

  it('records pastes, deletions and replacements one by one, and a new edit drops redo', () => {
    const u = new UndoStack();
    let s = emptyEditor();
    const step = (text: string) => {
      const next = editorWith(text);
      u.record(s, next, 0);
      s = next;
    };
    step('pasted text');
    step('pasted');
    step('pasted again');
    s = u.undo(s)!;
    expect(s.text).toBe('pasted');
    s = u.undo(s)!;
    expect(s.text).toBe('pasted text');
    step('different');
    expect(u.redo(s)).toBeUndefined();
    expect(u.undo(s)!.text).toBe('pasted text');
    u.clear();
    expect(u.undo(s)).toBeUndefined();
  });

  it('ignores cursor moves and is bounded', () => {
    const u = new UndoStack();
    const s = editorWith('abc');
    u.record(s, { ...s, cursor: 0 }, 0);
    expect(u.undo(s)).toBeUndefined();
    let e = emptyEditor();
    for (let i = 0; i < 500; i++) {
      const next = editorWith(`v${i}`);
      u.record(e, next, 0);
      e = next;
    }
    let n = 0;
    while (true) {
      const p = u.undo(e);
      if (!p) break;
      e = p;
      n++;
    }
    expect(n).toBe(200);
  });
});
