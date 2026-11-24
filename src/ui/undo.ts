// Undo and redo for the input box. Pure bookkeeping over editor states: the
// app records every change of text and asks for the state to go back to.
// Consecutive typing is grouped, so one undo removes a run of typed
// characters (up to a pause or a word boundary), not a single letter.

import type { EditorState } from './editor.js';

const MAX_DEPTH = 200;
const GROUP_MS = 1000;

export class UndoStack {
  private past: EditorState[] = [];
  private future: EditorState[] = [];
  private typingUntil = 0;

  /** Note that the text changed from `prev` to `next` (not by undo/redo). */
  record(prev: EditorState, next: EditorState, now = Date.now()): void {
    if (prev.text === next.text) return;
    this.future = [];
    // A single character appended where the cursor was: part of a typing run.
    const typed = next.text.length === prev.text.length + 1 && next.cursor === prev.cursor + 1 && next.text.slice(0, prev.cursor) + next.text.slice(next.cursor) === prev.text;
    const ch = typed ? next.text[prev.cursor]! : '';
    const continues = typed && now <= this.typingUntil && !/\s/.test(ch);
    this.typingUntil = typed ? now + GROUP_MS : 0;
    if (continues) return;
    this.past.push(prev);
    if (this.past.length > MAX_DEPTH) this.past.shift();
  }

  /** The state before the last change, or undefined if there is none. */
  undo(current: EditorState): EditorState | undefined {
    const prev = this.past.pop();
    if (!prev) return undefined;
    this.future.push(current);
    this.typingUntil = 0;
    return { ...prev, kill: current.kill };
  }

  redo(current: EditorState): EditorState | undefined {
    const next = this.future.pop();
    if (!next) return undefined;
    this.past.push(current);
    this.typingUntil = 0;
    return { ...next, kill: current.kill };
  }

  /** Forget everything (the message was sent). */
  clear(): void {
    this.past = [];
    this.future = [];
    this.typingUntil = 0;
  }
}
