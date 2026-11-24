// Interactive overlays shown above the input: a generic fuzzy picker and a
// single-line text prompt. Both receive keys from the App's key router.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { Key } from '../term/keys.js';
import { isText } from '../term/keys.js';
import { fuzzyFilter } from './fuzzy.js';
import { themeHex } from '../render/theme.js';
import { padEnd, textWidth, truncate } from '../render/width.js';
import * as E from './editor.js';

/** Pasted text arrives as a Key named 'paste' with `text` set. A handler
 * returns 'hold' when it has just acted (selected, submitted, cancelled) and
 * the screen is about to change: the router keeps further keys and replays
 * them to whatever handles input next. */
export type KeyHandler = (key: Key) => boolean | 'hold';

export const pasteKey = (text: string): Key => ({ name: 'paste', text, ctrl: false, alt: false, shift: false });

export interface KeyRouter {
  push(h: KeyHandler): () => void;
  /** Replay held keys to the current handler (or the input box). */
  flush(): void;
}

export const KeyRouterContext = React.createContext<KeyRouter>({ push: () => () => {}, flush: () => {} });

export function useKeys(handler: KeyHandler, active = true): void {
  const router = React.useContext(KeyRouterContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return router.push((k) => ref.current(k));
  }, [router, active]);
}

/** For a component that hands off after acting: `act()` marks it done (so
 * further keys are held), and once it re-renders it takes keys again and
 * the held ones are replayed to whoever now has focus. */
function useHandoff(): { done: () => boolean; act: () => void } {
  const router = React.useContext(KeyRouterContext);
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) {
      doneRef.current = false;
      router.flush();
    }
  });
  return {
    done: () => doneRef.current,
    act: () => {
      doneRef.current = true;
    },
  };
}

export interface PickerItem<T = string> {
  value: T;
  label: string;
  detail?: string;
  /** Group heading shown above the first item of each group. */
  group?: string;
  /** Text matched by the filter (defaults to label + detail). */
  search?: string;
  disabled?: boolean;
}

export interface PickerProps<T> {
  title: string;
  items: Array<PickerItem<T>>;
  onSelect: (item: PickerItem<T>, query: string) => void;
  onCancel: () => void;
  /** Called as the query changes (for async searches). */
  onQuery?: (q: string) => void;
  /** Custom filtering; default is fuzzy over label/detail. */
  filter?: 'fuzzy' | 'none';
  placeholder?: string;
  emptyText?: string;
  footer?: string;
  cols: number;
  maxRows: number;
  loading?: string;
  /** Extra key handling (e.g. left/right to change a value). */
  onKey?: (key: Key, item: PickerItem<T> | undefined) => boolean;
  initialIndex?: number;
  searchable?: boolean;
  /** When the items change, keep the selection on the same item if it only
   * moved by one row (something was inserted or removed just above it). */
  follow?: boolean;
}

export function Picker<T>(props: PickerProps<T>): React.ReactElement {
  const searchable = props.searchable !== false;
  // Several keys can arrive in one input chunk (e.g. ↓ then Enter), faster
  // than React re-renders, so the authoritative state lives in refs.
  const [, rerender] = useState(0);
  const queryRef = useRef('');
  const indexRef = useRef(props.initialIndex ?? 0);
  const filterItems = (q: string) =>
    props.filter === 'none' || !searchable ? props.items : fuzzyFilter(props.items, q, (i) => i.search ?? `${i.group ?? ''} ${i.label} ${i.detail ?? ''}`);
  const query = queryRef.current;
  const visible = useMemo(() => filterItems(query), [props.items, query, props.filter, searchable]); 
  const lastSel = useRef<{ items: unknown; value: unknown } | null>(null);
  if (props.follow && lastSel.current && lastSel.current.items !== props.items) {
    const i = indexRef.current;
    const want = lastSel.current.value;
    if (visible[i]?.value !== want) {
      if (visible[i + 1]?.value === want) indexRef.current = i + 1;
      else if (i > 0 && visible[i - 1]?.value === want) indexRef.current = i - 1;
    }
  }
  const sel = Math.min(indexRef.current, Math.max(0, visible.length - 1));
  lastSel.current = { items: props.items, value: visible[sel]?.value };

  const setQuery = (q: string) => {
    queryRef.current = q;
    indexRef.current = 0;
    props.onQuery?.(q);
    rerender((n) => n + 1);
  };
  const setIndex = (i: number) => {
    indexRef.current = i;
    rerender((n) => n + 1);
  };

  const handoff = useHandoff();
  useKeys((key) => {
    if (handoff.done()) return 'hold';
    const vis = filterItems(queryRef.current);
    const cur = Math.min(indexRef.current, Math.max(0, vis.length - 1));
    if (key.name === 'paste') {
      if (searchable) setQuery(queryRef.current + (key.text ?? '').replace(/\n/g, ' '));
      return true;
    }
    if (props.onKey?.(key, vis[cur])) {
      handoff.act();
      return true;
    }
    if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'g'))) {
      handoff.act();
      props.onCancel();
      return true;
    }
    if (key.name === 'enter') {
      const item = vis[cur];
      if (item && !item.disabled) {
        handoff.act();
        props.onSelect(item, queryRef.current);
      }
      return true;
    }
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      setIndex(Math.max(0, cur - 1));
      return true;
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n') || key.name === 'tab') {
      setIndex(Math.min(vis.length - 1, cur + 1));
      return true;
    }
    if (key.name === 'pageup') {
      setIndex(Math.max(0, cur - props.maxRows));
      return true;
    }
    if (key.name === 'pagedown') {
      setIndex(Math.min(vis.length - 1, cur + props.maxRows));
      return true;
    }
    if (!searchable) return true;
    if (key.name === 'backspace') {
      setQuery(queryRef.current.slice(0, -1));
      return true;
    }
    if (key.ctrl && key.name === 'u') {
      setQuery('');
      return true;
    }
    if (isText(key)) {
      setQuery(queryRef.current + key.text);
      return true;
    }
    return true; // swallow everything else while open
  });

  const accent = themeHex('accent');
  const dim = themeHex('dim');
  const rows = Math.max(3, props.maxRows);
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), visible.length - rows));
  const shown = visible.slice(start, start + rows);
  const labelWidth = Math.min(Math.max(10, ...shown.map((i) => textWidth(i.label))) + 2, Math.floor(props.cols * 0.55));

  const lines: React.ReactElement[] = [];
  let lastGroup: string | undefined;
  shown.forEach((item, i) => {
    const idx = start + i;
    if (item.group && item.group !== lastGroup && (!query || props.filter === 'none')) {
      lines.push(
        <Text key={`g${idx}`} color={dim} bold>
          {truncate(item.group, props.cols - 2)}
        </Text>,
      );
    }
    lastGroup = item.group;
    const selected = idx === sel;
    const label = padEnd(truncate(item.label, labelWidth - 2), labelWidth);
    const detail = item.detail ? truncate(item.detail, Math.max(0, props.cols - labelWidth - 4)) : '';
    lines.push(
      <Text key={`i${idx}`} wrap="truncate-end">
        <Text color={selected ? accent : undefined}>{selected ? '❯ ' : '  '}</Text>
        <Text color={item.disabled ? dim : selected ? accent : undefined} bold={selected}>
          {label}
        </Text>
        <Text color={dim}>{detail}</Text>
      </Text>,
    );
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{props.title}</Text>
      {searchable ? (
        <Text>
          <Text color={dim}>{'> '}</Text>
          {query ? <Text>{query}</Text> : <Text color={dim}>{props.placeholder ?? 'Type to filter'}</Text>}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {props.loading ? <Text color={dim}>{props.loading}</Text> : null}
      {visible.length === 0 && !props.loading ? <Text color={dim}>{props.emptyText ?? 'No matches'}</Text> : lines}
      <Text color={dim}>{props.footer ?? `↑/↓ to select · enter to choose · esc to cancel${visible.length > rows ? ` · ${visible.length} items` : ''}`}</Text>
    </Box>
  );
}

export interface PromptProps {
  title: string;
  description?: string;
  initial?: string;
  mask?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  cols: number;
}

/** A single-line text prompt (used by setup flows, /rename, key entry). */
export function Prompt(props: PromptProps): React.ReactElement {
  const [ed, setEdState] = useState<E.EditorState>(E.editorWith(props.initial ?? ''));
  // As in the main input: the text lives in a ref so Enter sees every key
  // that arrived before it, even within one input chunk.
  const edRef = useRef(ed);
  const setEd = (f: (s: E.EditorState) => E.EditorState) => {
    edRef.current = f(edRef.current);
    setEdState(edRef.current);
  };
  const handoff = useHandoff();
  useKeys((key) => {
    if (handoff.done()) return 'hold';
    if (key.name === 'paste') {
      setEd((s) => E.insert(s, (key.text ?? '').replace(/\n/g, '')));
      return true;
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      handoff.act();
      props.onCancel();
      return true;
    }
    if (key.name === 'enter') {
      handoff.act();
      props.onSubmit(edRef.current.text.trim());
      return true;
    }
    setEd((s) => editKey(s, key) ?? s);
    return true;
  });
  const dim = themeHex('dim');
  const shown = props.mask ? '•'.repeat(Math.min(ed.text.length, 40)) : ed.text;
  const cur = props.mask ? shown.length : ed.cursor;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{props.title}</Text>
      {props.description ? <Text color={dim}>{props.description}</Text> : null}
      <Text>
        <Text color={dim}>{'> '}</Text>
        {shown || !props.placeholder ? (
          <>
            <Text>{shown.slice(0, cur)}</Text>
            <Text inverse>{shown.slice(cur, cur + 1) || ' '}</Text>
            <Text>{shown.slice(cur + 1)}</Text>
          </>
        ) : (
          <>
            <Text inverse> </Text>
            <Text color={dim}>{props.placeholder}</Text>
          </>
        )}
      </Text>
      <Text color={dim}>enter to confirm · esc to cancel</Text>
    </Box>
  );
}

/** Shared single-line editing keys. Returns null if the key is not an edit. */
export function editKey(s: E.EditorState, key: Key): E.EditorState | null {
  if (isText(key)) return E.insert(s, key.text);
  if (key.name === 'backspace') return key.alt || key.ctrl ? E.killWordBack(s) : E.backspace(s);
  if (key.name === 'delete') return E.deleteForward(s);
  if (key.name === 'left') return key.ctrl || key.alt ? E.wordLeft(s) : E.left(s);
  if (key.name === 'right') return key.ctrl || key.alt ? E.wordRight(s) : E.right(s);
  if (key.name === 'home') return E.lineStart(s);
  if (key.name === 'end') return E.lineEnd(s);
  if (key.ctrl) {
    switch (key.name) {
      case 'a':
        return E.lineStart(s);
      case 'e':
        return E.lineEnd(s);
      case 'b':
        return E.left(s);
      case 'f':
        return E.right(s);
      case 'w':
        return E.killWordBack(s);
      case 'k':
        return E.killToEnd(s);
      case 'u':
        return E.killToStart(s);
      case 'y':
        return E.yank(s);
      case 'h':
        return E.backspace(s);
      case 'd':
        return E.deleteForward(s);
    }
  }
  if (key.alt) {
    switch (key.name) {
      case 'b':
        return E.wordLeft(s);
      case 'f':
        return E.wordRight(s);
      case 'd':
        return E.killWordForward(s);
    }
  }
  return null;
}
