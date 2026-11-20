// The interactive interface. Completed transcript items are written once via
// <Static>; only the live tail, spinner, input box and status line are
// dynamic, and their total height is always kept below the terminal height so
// Ink never has to redraw the whole screen.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionEvent } from '../core/session.js';
import type { InputHistory } from '../core/history.js';
import type { Store } from '../core/store.js';
import type { TerminalController } from '../term/terminal.js';
import { CLEAR_SCREEN, holdInterrupts } from '../term/terminal.js';
import type { InputEvent, Key } from '../term/keys.js';
import { isText } from '../term/keys.js';
import { BULLET, renderItem } from './blocks.js';
import type { TranscriptModel } from './transcript.js';
import * as E from './editor.js';
import { Spinner } from './Spinner.js';
import { KeyRouterContext, Picker, Prompt, editKey, pasteKey, type KeyHandler, type KeyRouter, type PickerItem, type PickerProps, type PromptProps } from './overlays.js';
import { lineToAnsi } from '../render/style.js';
import { getTheme, setTheme, themeHex, type ThemeName } from '../render/theme.js';
import { textWidth, truncate } from '../render/width.js';
import { allCommands, findCommand, type CommandDef, type UiApi } from '../commands/commands.js';
import { fuzzyFilter, relativeTime } from './fuzzy.js';
import { formatTokens } from '../core/usage.js';
import type { ContentPart } from '../providers/types.js';
import { parseModelRef } from '../providers/types.js';
import { copyText, readImage, ClipboardError } from '../term/clipboard.js';
import { listFiles, parseDroppedPaths, readAttachment, AttachError } from './attachments.js';
import { loadState, rememberModel } from '../core/state.js';
import { ProvidersScreen, ConfigScreen, SetupScreen } from './screens.js';
import type { Config } from '../config/config.js';
import { loadHighlighter } from '../render/highlight.js';
import { parseDocument, type Document } from 'yaml';

export interface AppProps {
  session: Session;
  transcript: TranscriptModel;
  terminal: TerminalController;
  history: InputHistory;
  store: Store;
  config: Config;
  configFile: string;
  reloadConfig: () => Config;
  onExit: () => void;
  initial?: 'setup' | 'resume';
  /** Re-detect the theme (for theme: auto). */
  resolveTheme: (t: Config['theme']) => ThemeName;
  /** Erases Ink's live frame (set once Ink has started). */
  ink: { clear?: () => void };
}

type Overlay =
  | { type: 'picker'; props: Omit<PickerProps<unknown>, 'cols' | 'maxRows'> }
  | { type: 'prompt'; props: Omit<PromptProps, 'cols'> }
  | { type: 'node'; render: (cols: number, rows: number) => React.ReactElement };

interface SearchState {
  query: string;
  index: number;
}

const PASTE_COLLAPSE_LINES = 8;
const PASTE_COLLAPSE_CHARS = 1000;

function useForceUpdate(): () => void {
  const [, f] = useReducer((x: number) => x + 1, 0);
  return f;
}

export function App(props: AppProps): React.ReactElement {
  if (process.env.PARLEY_DEBUG_CRASH === 'render') throw new Error('debug crash (render) key=sk-ant-api03-DEBUGCRASHSECRETVALUE0123456789');
  const { session, transcript, terminal, history, store } = props;
  const app = useApp();
  const force = useForceUpdate();
  const [size, setSize] = useState({ cols: terminal.inkStdout.columns, rows: terminal.inkStdout.rows });
  const [ed, setEdState] = useState<E.EditorState>(E.emptyEditor());
  // Key events can arrive faster than React renders (a whole pasted line
  // plus Enter in one chunk), so the editor state lives in a ref that is
  // updated synchronously; React state only drives rendering.
  const edRef = useRef(ed);
  const setEd = useCallback((next: E.EditorState | ((s: E.EditorState) => E.EditorState)) => {
    const v = typeof next === 'function' ? next(edRef.current) : next;
    edRef.current = v;
    setEdState(v);
  }, []);
  const [overlay, setOverlayState] = useState<Overlay | null>(null);
  const [search, setSearchState] = useState<SearchState | null>(null);
  const searchRef = useRef<SearchState | null>(null);
  const setSearch = useCallback((v: SearchState | null) => {
    searchRef.current = v;
    setSearchState(v);
  }, []);
  const [hint, setHint] = useState<{ text: string; until: number } | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [busyLabel, setBusyLabel] = useState<string | undefined>();
  const [config, setConfig] = useState(props.config);
  const configRef = useRef(config);
  configRef.current = config;
  const pastes = useRef(new Map<number, string>());
  const attachments = useRef(new Map<string, ContentPart>());
  const counters = useRef({ paste: 0, image: 0, file: 0 });
  const historyPos = useRef<{ index: number; draft: string } | null>(null);
  const lastEsc = useRef(0);
  const lastCtrlC = useRef(0);
  const imageWarned = useRef(false);
  const files = useRef<string[] | null>(null);
  const [kitty, setKitty] = useState(terminal.kitty);
  const commands = useMemo(() => allCommands(), []);

  const { cols, rows } = size;

  // ------------------------------------------------------------ key routing
  const stack = useRef<KeyHandler[]>([]);
  // Keys can arrive faster than screens change: right after an overlay is
  // opened (before it registers its handler) or after a picker has acted
  // (it answers 'hold'). Such keys are held and replayed, in order, to
  // whatever handles input next — a new screen, or the input box once the
  // overlay has closed.
  const overlayOpen = useRef(false);
  const heldKeys = useRef<Key[]>([]);
  const dispatchRef = useRef<(k: Key) => void>(() => {});
  const replayHeld = useCallback(() => {
    queueMicrotask(() => {
      while (heldKeys.current.length) {
        const top = stack.current[stack.current.length - 1];
        // Still nobody to take them (overlay mounting): keep holding.
        if (!top && overlayOpen.current) return;
        const k = heldKeys.current.shift()!;
        if (top) {
          if (top(k) === 'hold') {
            heldKeys.current.unshift(k);
            return;
          }
        } else dispatchRef.current(k);
      }
    });
  }, []);
  const router = useMemo<KeyRouter>(
    () => ({
      push(h) {
        stack.current.push(h);
        if (heldKeys.current.length) replayHeld();
        return () => {
          stack.current = stack.current.filter((x) => x !== h);
        };
      },
      flush: replayHeld,
    }),
    [replayHeld],
  );

  const setOverlay = useCallback((o: Overlay | null) => {
    overlayOpen.current = o !== null;
    setOverlayState(o);
  }, []);
  const closeOverlay = useCallback(() => setOverlay(null), [setOverlay]);

  const flashHint = useCallback((text: string, ms = 1500) => {
    setHint({ text, until: Date.now() + ms });
    setTimeout(() => setHint((h) => (h && h.until <= Date.now() ? null : h)), ms + 20);
  }, []);

  // --------------------------------------------------------- session events
  useEffect(() => {
    const onEvent = (e: SessionEvent) => {
      if (e.type === 'restore-input') {
        setEd((s) => E.editorWith(s.text ? `${e.text}\n${s.text}` : e.text));
      }
      if (e.type === 'busy') setBusyLabel(e.busy ? e.label : undefined);
      if (e.type === 'title' && configRef.current.terminalTitle) terminal.setTitle(e.title);
      if (e.type === 'reset') {
        if (!session.conv.title) terminal.setTitle('parley');
        else if (configRef.current.terminalTitle) terminal.setTitle(session.conv.title);
      }
      if (e.type === 'model') rememberModel(e.model);
      if (e.type === 'assistant-end') {
        const cfg = configRef.current;
        if (cfg.bell && e.stats.durationMs > cfg.bellAfterSeconds * 1000 && e.outcome !== 'interrupted') terminal.bell();
      }
      force();
    };
    const onTranscript = () => force();
    const onReprint = () => {
      // Erase the live frame, clear screen and scrollback, then let <Static>
      // (remounted with a new key) print the transcript from the top.
      inkClear.current?.();
      process.stdout.write(CLEAR_SCREEN);
    };
    session.on('event', onEvent);
    transcript.on('change', onTranscript);
    transcript.on('reprint', onReprint);
    return () => {
      session.off('event', onEvent);
      transcript.off('change', onTranscript);
      transcript.off('reprint', onReprint);
    };
  }, [session, transcript, terminal, force]);

  const inkClear = useRef<(() => void) | null>(null);
  inkClear.current = () => props.ink.clear?.();

  useEffect(() => {
    const onResize = (c: number, r: number) => {
      const widthChanged = c !== transcript.cols;
      if (widthChanged) {
        inkClear.current?.();
        process.stdout.write(CLEAR_SCREEN);
      }
      terminal.inkStdout.applySize();
      setSize({ cols: c, rows: r });
      if (widthChanged) {
        transcript.cols = c;
        transcript.reprint(true);
      }
    };
    terminal.on('resize', onResize);
    void terminal.probed.then(() => setKitty(terminal.kitty));
    return () => {
      terminal.off('resize', onResize);
    };
  }, [terminal, transcript]);

  useEffect(() => {
    // After the first frame, warm what the first reply will need: the syntax
    // highlighter, and the emoji width table (built lazily, see
    // scripts/esbuild-plugins.mjs), so neither stalls streaming later.
    const t = setTimeout(() => {
      textWidth('\u{1F44D}');
      void loadHighlighter();
    }, 30);
    return () => clearTimeout(t);
  }, []);

  // --------------------------------------------------------------- helpers
  const inputWidth = Math.max(10, cols - 6);

  const notice = useCallback((text: string, tone: 'dim' | 'error' | 'success' | 'warning' = 'dim') => transcript.notice(text, tone), [transcript]);

  const exit = useCallback(() => {
    props.onExit();
    app.exit();
  }, [app, props]);

  const addImage = useCallback(
    (data: Buffer, mediaType: string, name?: string) => {
      const hash = store.saveAttachment(data, mediaType);
      const n = ++counters.current.image;
      const chip = `[Image #${n}]`;
      attachments.current.set(chip, { type: 'image', hash, mediaType, name });
      setEd((s) => E.insert(s, (s.text && !/\s$/.test(s.text.slice(0, s.cursor)) ? ' ' : '') + chip + ' '));
      const caps = session.cachedCapabilities();
      if (caps?.images === false) flashHint(`${session.model} cannot read images`, 3000);
    },
    [store, session, flashHint],
  );

  const attachPath = useCallback(
    (path: string, replaceRange?: [number, number]) => {
      try {
        const a = readAttachment(path);
        if (a.kind === 'image') {
          if (replaceRange) setEd((s) => ({ ...s, text: s.text.slice(0, replaceRange[0]) + s.text.slice(replaceRange[1]), cursor: replaceRange[0] }));
          addImage(a.data, a.mediaType, a.name);
        } else {
          const n = ++counters.current.file;
          const chip = `[File #${n}: ${a.name}]`;
          attachments.current.set(chip, { type: 'file', name: a.name, text: a.text });
          setEd((s) => {
            const base = replaceRange ? { ...s, text: s.text.slice(0, replaceRange[0]) + s.text.slice(replaceRange[1]), cursor: replaceRange[0] } : s;
            return E.insert(base, chip + ' ');
          });
        }
      } catch (e) {
        notice(e instanceof AttachError ? e.message : `Could not attach ${path}: ${(e as Error).message}`, 'error');
      }
    },
    [addImage, notice],
  );

  const pasteImage = useCallback(async () => {
    try {
      const img = await readImage();
      if (!img) {
        flashHint('No image on the clipboard', 2000);
        return;
      }
      addImage(img.data, img.mediaType, 'clipboard image');
    } catch (e) {
      notice(e instanceof ClipboardError ? e.message : `Could not read the clipboard: ${(e as Error).message}`, 'error');
    }
  }, [addImage, flashHint, notice]);

  const openEditor = useCallback(() => {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const dir = mkdtempSync(join(tmpdir(), 'parley-edit-'));
    const file = join(dir, 'prompt.md');
    writeFileSync(file, edRef.current.text);
    terminal.suspend();
    holdInterrupts(true);
    try {
      const r = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' });
      if (r.status === 0) {
        const text = readFileSync(file, 'utf8').replace(/\n$/, '');
        setEd(E.editorWith(text));
      } else {
        notice(`The editor (${editor}) exited with status ${r.status ?? 'unknown'}; input unchanged.`, 'warning');
      }
    } catch (e) {
      notice(`Could not run ${editor}: ${(e as Error).message}`, 'error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      terminal.resume();
      // Signals raised while the editor ran are delivered after spawnSync
      // returns; keep ignoring them until they have been.
      setTimeout(() => holdInterrupts(false), 200);
      inkClear.current?.();
      transcript.reprint(true);
    }
  }, [terminal, notice, transcript]);

  // -------------------------------------------------------------- pickers
  const openModelPicker = useCallback(
    (opts: { onPick?: (model: string) => void; title?: string } = {}) => {
      const recent = loadState().recentModels;
      const build = (results: Array<{ provider: string; models?: string[]; error?: string }>): Array<PickerItem<unknown>> => {
        const items: Array<PickerItem<unknown>> = [];
        const known = new Set<string>();
        for (const r of results) for (const m of r.models ?? []) known.add(`${r.provider}/${m}`);
        const recentItems = recent.filter((m) => session.registry.has(parseModelRef(m)?.provider ?? ''));
        for (const m of recentItems) items.push({ value: m, label: m, detail: m === session.model ? 'current' : 'recent', group: 'Recent' });
        for (const r of results) {
          if (r.error) {
            items.push({ value: null, label: `${r.provider}: could not list models`, detail: truncate(r.error, 80), group: r.provider, disabled: true });
            continue;
          }
          for (const m of r.models ?? []) {
            const ref = `${r.provider}/${m}`;
            items.push({ value: ref, label: m, detail: ref === session.model ? 'current' : '', group: r.provider, search: ref });
          }
        }
        return items;
      };
      const providers = session.registry.providerConfigs().map((p) => p.name);
      const results: Array<{ provider: string; models?: string[]; error?: string }> = providers.map((p) => ({ provider: p }));
      const pick = (item: PickerItem<unknown>, query: string) => {
        let ref = item.value as string | null;
        if (item.value === '__custom__') ref = query.trim();
        if (!ref) return;
        closeOverlay();
        if (opts.onPick) return opts.onPick(ref);
        session.setModel(ref);
        rememberModel(ref);
        notice(`Model set to ${ref}`, 'success');
      };
      let current = build([]);
      let loading: string | undefined = providers.length ? `Loading models from ${providers.join(', ')}…` : undefined;
      let query = '';
      const render = () =>
        setOverlay({
          type: 'picker',
          props: {
            title: opts.title ?? 'Select a model',
            items: query.includes('/') && parseModelRef(query.trim()) && !current.some((i) => i.value === query.trim())
              ? [...current, { value: '__custom__', label: `Use "${query.trim()}"`, detail: 'type any provider/model-id', search: query }]
              : current,
            onSelect: pick,
            onCancel: closeOverlay,
            onQuery: (q) => {
              query = q;
              render();
            },
            placeholder: 'Type to search, or enter provider/model-id',
            loading,
            emptyText: providers.length ? 'No models match. Type provider/model-id to use any model.' : 'No providers configured. Run /providers to add one.',
          },
        });
      render();
      let pending = providers.length;
      for (const [i, name] of providers.entries()) {
        session.registry
          .get(name)
          .then((p) => p.listModels())
          .then((models) => {
            results[i] = { provider: name, models: models.map((m) => m.id) };
          })
          .catch((e: Error) => {
            results[i] = { provider: name, error: e.message };
          })
          .finally(() => {
            pending--;
            loading = pending ? loading : undefined;
            current = build(results);
            render();
          });
      }
    },
    [session, setOverlay, closeOverlay, notice],
  );

  const openResumePicker = useCallback(() => {
    const all = store.list();
    const toItems = (list: typeof all, snippets?: Map<string, string>): Array<PickerItem<unknown>> =>
      list.map((c) => ({
        value: c.id,
        label: c.title,
        detail: `${relativeTime(c.updatedAt)} · ${c.messageCount} msg${c.messageCount === 1 ? '' : 's'}${c.model ? ` · ${c.model}` : ''}${snippets?.get(c.id) ? ` · “${snippets.get(c.id)}”` : ''}${c.id === session.file?.id ? ' · current' : ''}`,
        search: `${c.title} ${c.model ?? ''}`,
      }));
    let timer: NodeJS.Timeout | null = null;
    const render = (items: Array<PickerItem<unknown>>) =>
      setOverlay({
        type: 'picker',
        props: {
          title: 'Resume a conversation',
          items,
          filter: 'none',
          onSelect: (item) => {
            closeOverlay();
            if (item.value === session.file?.id) return;
            session.resume(item.value as string);
          },
          onCancel: closeOverlay,
          onQuery: (q) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              if (!q.trim()) return render(toItems(all));
              const titleHits = fuzzyFilter(all, q, (c) => c.title);
              const full = store.search(q.trim());
              const seen = new Set(titleHits.map((c) => c.id));
              const snippets = new Map(full.map((f) => [f.id, f.snippet]));
              render(toItems([...titleHits, ...full.filter((f) => !seen.has(f.id))], snippets));
            }, 120);
          },
          placeholder: 'Search titles and message text',
          emptyText: all.length ? 'No conversations match.' : 'No saved conversations yet.',
        },
      });
    render(toItems(all));
  }, [store, session, setOverlay, closeOverlay]);

  const openRewindPicker = useCallback(() => {
    const msgs = session.userMessages();
    if (!msgs.length) {
      flashHint('Nothing to rewind to yet', 2000);
      return;
    }
    setOverlay({
      type: 'picker',
      props: {
        title: 'Rewind: pick a message to edit (the conversation branches from there; nothing is deleted)',
        items: [...msgs].reverse().map((m) => ({
          value: m.id,
          label: truncate((m.display ?? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).replace(/\s+/g, ' '), Math.max(20, cols - 22)),
          detail: relativeTime(m.ts),
        })),
        onSelect: (item) => {
          closeOverlay();
          const text = session.rewindTo(item.value as string);
          if (text !== undefined) setEd(E.editorWith(text));
        },
        onCancel: closeOverlay,
        searchable: false,
      },
    });
  }, [session, setOverlay, closeOverlay, flashHint, cols]);

  const applyTheme = useCallback(
    (t: Config['theme']) => {
      setTheme(props.resolveTheme(t));
      transcript.reprint(true);
    },
    [props, transcript],
  );

  const writeConfig = useCallback(
    (update: (doc: Document) => void): boolean => {
      try {
        // Edit the YAML document in place so comments survive.
        let text = '';
        try {
          text = readFileSync(props.configFile, 'utf8');
        } catch {
          text = '';
        }
        const doc = parseDocument(text);
        if (!doc.contents) doc.contents = doc.createNode({}) as never;
        update(doc);
        writeFileSync(props.configFile, String(doc), { mode: 0o600 });
        const c = props.reloadConfig();
        setConfig(c);
        session.config = c;
        session.registry.setConfig(c);
        return true;
      } catch (e) {
        notice(`Could not update ${props.configFile}: ${(e as Error).message}`, 'error');
        return false;
      }
    },
    [props, session, notice],
  );

  const openThemePicker = useCallback(() => {
    const themes: Array<Config['theme']> = ['auto', 'dark', 'light', 'ansi'];
    setOverlay({
      type: 'picker',
      props: {
        title: 'Theme',
        items: themes.map((t) => ({
          value: t,
          label: t,
          detail: t === 'auto' ? 'follow the terminal background' : t === 'ansi' ? 'use only the terminal’s 16 colours' : `${t} background`,
        })),
        initialIndex: Math.max(0, themes.indexOf(configRef.current.theme)),
        searchable: false,
        onSelect: (item) => {
          closeOverlay();
          const t = item.value as Config['theme'];
          writeConfig((doc) => doc.set('theme', t));
          applyTheme(t);
        },
        onCancel: closeOverlay,
      },
    });
  }, [setOverlay, closeOverlay, writeConfig, applyTheme]);

  const openPersonaPicker = useCallback(() => {
    const ps = Object.values(configRef.current.personas);
    if (!ps.length) {
      notice('No personas configured. Add them under "personas" in the config file:\n  personas:\n    reviewer: "You are a meticulous code reviewer."', 'dim');
      return;
    }
    setOverlay({
      type: 'picker',
      props: {
        title: 'Persona (sets the system prompt)',
        items: [
          ...ps.map((p) => ({ value: p.name, label: p.name, detail: truncate(p.prompt.replace(/\s+/g, ' '), 80) })),
          { value: '__none__', label: '(none)', detail: 'remove the system prompt' },
        ],
        onSelect: (item) => {
          closeOverlay();
          if (item.value === '__none__') {
            session.setSystemPrompt(null);
            notice('System prompt removed.', 'success');
            return;
          }
          const p = configRef.current.personas[item.value as string]!;
          session.setSystemPrompt(p.prompt);
          if (p.model) session.setModel(p.model);
          notice(`Persona "${p.name}" active.`, 'success');
        },
        onCancel: closeOverlay,
      },
    });
  }, [setOverlay, closeOverlay, session, notice]);

  const prompt = useCallback(
    (opts: Omit<PromptProps, 'cols' | 'onCancel'>) => {
      setOverlay({
        type: 'prompt',
        props: {
          ...opts,
          onSubmit: (v) => {
            closeOverlay();
            opts.onSubmit(v);
          },
          onCancel: closeOverlay,
        },
      });
    },
    [setOverlay, closeOverlay],
  );

  const confirm = useCallback(
    (question: string, onYes: () => void) => {
      setOverlay({
        type: 'picker',
        props: {
          title: question,
          items: [
            { value: false, label: 'No, keep it' },
            { value: true, label: 'Yes' },
          ],
          searchable: false,
          onSelect: (item) => {
            closeOverlay();
            if (item.value === true) onYes();
          },
          onCancel: closeOverlay,
        },
      });
    },
    [setOverlay, closeOverlay],
  );

  const copy = useCallback(
    (text: string, what: string) => {
      copyText(text)
        .then((r) => notice(`Copied the last ${what} (${text.length.toLocaleString()} characters) via ${r.method}.`, 'success'))
        .catch((e: Error) => notice(`Copy failed: ${e.message}`, 'error'));
    },
    [notice],
  );

  // ------------------------------------------------------------- submitting
  const submitText = useCallback(
    async (raw: string, force = false) => {
      let text = raw;
      const display = raw.trim();
      // Expand collapsed pastes; collect attachments in order of appearance.
      const parts: ContentPart[] = [];
      text = text.replace(E.CHIP_RE, (chip) => {
        const pm = /^\[Pasted text #(\d+)/.exec(chip);
        if (pm) return pastes.current.get(Number(pm[1])) ?? chip;
        const a = attachments.current.get(chip);
        if (a) parts.push(a);
        return chip;
      });
      text = text.trim();
      if (!text && !parts.length) return;
      if (parts.some((p) => p.type === 'image') && !force) {
        const caps = await session.capabilities().catch(() => undefined);
        if (caps?.images === false && !imageWarned.current) {
          imageWarned.current = true;
          notice(`${session.model} cannot read images. Press Enter again to send without them, or switch model with /model.`, 'warning');
          return;
        }
      }
      imageWarned.current = false;
      history.add(display);
      historyPos.current = null;
      setEd(E.emptyEditor());
      pastes.current.clear();
      attachments.current.clear();
      counters.current = { paste: 0, image: 0, file: 0 };
      await session.submit({ text, display: display !== text ? display : undefined, attachments: parts });
    },
    [session, history, notice],
  );

  const uiRef = useRef<UiApi | null>(null);
  const ui: UiApi = {
    session,
    config,
    notice,
    info: (md) => transcript.info(md),
    openModelPicker,
    openResumePicker,
    openRewindPicker,
    openConfig: () =>
      setOverlay({
        type: 'node',
        render: (c, r) => (
          <ConfigScreen
            config={configRef.current}
            session={session}
            cols={c}
            maxRows={r}
            onClose={closeOverlay}
            writeConfig={writeConfig}
            applyTheme={applyTheme}
            openModelPicker={(title, onPick) => openModelPicker({ title, onPick })}
          />
        ),
      }),
    openProviders: () =>
      setOverlay({
        type: 'node',
        render: (c, r) => <ProvidersScreen session={session} config={configRef.current} cols={c} maxRows={r} onClose={closeOverlay} writeConfig={writeConfig} notice={notice} />,
      }),
    openThemePicker,
    openPersonaPicker,
    prompt,
    confirm,
    setInput: (t) => setEd(E.editorWith(t)),
    submitPrompt: (t) => void submitText(t, true),
    copy,
    clearScreen: () => transcript.clearScreen(),
    exit,
    commands: () => commands,
  };
  uiRef.current = ui;

  useEffect(() => {
    if (props.initial === 'resume') openResumePicker();
    if (props.initial === 'setup')
      setOverlay({
        type: 'node',
        render: (c, r) => (
          <SetupScreen
            cols={c}
            maxRows={r}
            configFile={props.configFile}
            onDone={(model) => {
              closeOverlay();
              const cfg = props.reloadConfig();
              setConfig(cfg);
              session.config = cfg;
              session.registry.setConfig(cfg);
              if (model) {
                session.setModel(model);
                rememberModel(model);
              }
              transcript.reprint(true);
            }}
          />
        ),
      });
  }, []);

  const runCommand = useCallback(
    (line: string): boolean => {
      const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
      if (!m) return false;
      const cmd = findCommand(commands, m[1]!);
      if (!cmd) {
        notice(`Unknown command /${m[1]}. Type /help for the list.`, 'error');
        return true;
      }
      history.add(line.trim());
      setEd(E.emptyEditor());
      void Promise.resolve(cmd.run(uiRef.current!, m[2] ?? '')).catch((e: Error) => notice(`/${cmd.name} failed: ${e.message}`, 'error'));
      return true;
    },
    [commands, history, notice],
  );

  // ----------------------------------------------------- completion menus
  const menuIndexRef = useRef(0);
  const menuKey = useRef('');
  const menus = useCallback(
    (st: E.EditorState) => {
      const slashQuery = /^\/(\S*)$/.exec(st.text)?.[1];
      const slashItems = slashQuery === undefined ? [] : fuzzyFilter(commands, slashQuery, (c) => `${c.name} ${(c.aliases ?? []).join(' ')}`).slice(0, 50);
      const before = st.text.slice(0, st.cursor);
      const am = /(^|\s)@(\S*)$/.exec(before);
      const atMatch = am ? { query: am[2]!, start: before.length - am[2]!.length - 1, end: st.cursor } : null;
      let fileItems: string[] = [];
      if (atMatch) {
        files.current ??= listFiles();
        fileItems = fuzzyFilter(files.current, atMatch.query, (f) => f).slice(0, 50);
      }
      const menu: 'slash' | 'file' | null = slashItems.length ? 'slash' : atMatch && fileItems.length ? 'file' : null;
      const menuLen = menu === 'slash' ? slashItems.length : menu === 'file' ? fileItems.length : 0;
      // Reset the selection whenever the query changes.
      const k = `${menu}:${slashQuery ?? ''}:${atMatch?.query ?? ''}`;
      if (k !== menuKey.current) {
        menuKey.current = k;
        menuIndexRef.current = 0;
      }
      const sel = Math.min(menuIndexRef.current, Math.max(0, menuLen - 1));
      return { slashQuery, slashItems, atMatch, fileItems, menu, menuLen, sel };
    },
    [commands],
  );
  const setMenuSel = useCallback((i: number) => {
    menuIndexRef.current = i;
    setMenuIndex(i);
  }, []);
  const view = menus(ed);
  const menu = overlay ? null : view.menu;
  const { slashItems, fileItems, menuLen, sel } = view;
  void menuIndex;

  // ------------------------------------------------------------- key input
  const handleInputKey = useCallback(
    (key: Key) => {
      const s = edRef.current;
      const w = inputWidth;
      const { menu, sel, menuLen, slashItems, atMatch, fileItems } = menus(s);
      // Completion menus take arrows / tab / enter.
      if (menu) {
        if (key.name === 'up') return setMenuSel(Math.max(0, sel - 1));
        if (key.name === 'down') return setMenuSel(Math.min(menuLen - 1, sel + 1));
        if (key.name === 'escape') {
          if (menu === 'slash') setEd(E.emptyEditor());
          else if (atMatch) setEd({ ...s, text: s.text.slice(0, atMatch.start) + s.text.slice(atMatch.end), cursor: atMatch.start });
          return;
        }
        if (menu === 'slash' && (key.name === 'tab' || (key.name === 'enter' && !key.shift && !key.alt))) {
          const c = slashItems[sel]!;
          // Enter runs the command (arguments are optional for most); Tab
          // completes it so arguments can be typed.
          if (key.name === 'enter' && !c.argHint?.startsWith('<')) {
            runCommand(`/${c.name}`);
          } else {
            setEd(E.editorWith(`/${c.name} `));
          }
          return;
        }
        if (menu === 'file' && (key.name === 'tab' || key.name === 'enter') && atMatch) {
          attachPath(fileItems[sel]!, [atMatch.start, atMatch.end]);
          return;
        }
      }

      if (key.name === 'enter') {
        if (key.shift || key.alt) return setEd(E.insert(s, '\n'));
        const before = s.text.slice(0, s.cursor);
        if (before.endsWith('\\')) {
          return setEd(E.insert({ ...s, text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 }, '\n'));
        }
        if (s.text.trim().startsWith('/') && !s.text.includes('\n') && runCommand(s.text)) return;
        void submitText(s.text, imageWarned.current);
        return;
      }
      if (key.ctrl && key.name === 'j') return setEd(E.insert(s, '\n'));

      if (key.name === 'escape') {
        const now = Date.now();
        if (session.streaming || session.busy) {
          session.interrupt();
          lastEsc.current = 0;
          return;
        }
        if (s.text) {
          history.add(s.text);
          setEd(E.emptyEditor());
          lastEsc.current = now;
          return;
        }
        if (now - lastEsc.current < 800) {
          lastEsc.current = 0;
          openRewindPicker();
          return;
        }
        lastEsc.current = now;
        flashHint('Esc again to rewind', 800);
        return;
      }

      if (key.ctrl && key.name === 'c') {
        const now = Date.now();
        if (session.streaming || session.busy) {
          session.interrupt();
          return;
        }
        if (s.text) {
          setEd(E.emptyEditor());
          pastes.current.clear();
          attachments.current.clear();
          return;
        }
        if (now - lastCtrlC.current < 1500) return exit();
        lastCtrlC.current = now;
        flashHint('Press Ctrl-C again to exit', 1500);
        return;
      }
      if (key.ctrl && key.name === 'd') {
        if (!s.text) return exit();
        return setEd(E.deleteForward(s));
      }
      if (key.ctrl && key.name === 'l') return transcript.clearScreen();
      if (key.ctrl && key.name === 'o') return transcript.toggleThinking();
      if (key.ctrl && key.name === 'r') return setSearch({ query: '', index: 0 });
      if (key.ctrl && key.name === 'v') return void pasteImage();
      if (key.ctrl && key.name === 'g') return openEditor();
      if (key.name === 'tab' && key.shift) {
        void session.cycleEffort().then((e) => flashHint(e ? `Reasoning effort: ${e}` : `${session.model} has no reasoning effort setting`, 1500));
        return;
      }

      if (key.name === 'up' && !key.ctrl && !key.alt) {
        if (session.queue.length && (!s.text || E.layout(s.text, s.cursor, w).cursorRow === 0)) {
          const q = session.popQueue();
          if (q) setEd(E.editorWith(s.text ? `${q.display ?? q.text}\n${s.text}` : (q.display ?? q.text)));
          return;
        }
        const moved = E.up(s, w);
        if (moved) return setEd(moved);
        const h = history.all();
        if (!h.length) return;
        const pos = historyPos.current ?? { index: h.length, draft: s.text };
        if (pos.index <= 0) return;
        pos.index--;
        historyPos.current = pos;
        setEd(E.editorWith(h[pos.index]!));
        return;
      }
      if (key.name === 'down' && !key.ctrl && !key.alt) {
        const moved = E.down(s, w);
        if (moved) return setEd(moved);
        const pos = historyPos.current;
        if (!pos) return;
        const h = history.all();
        pos.index++;
        if (pos.index >= h.length) {
          historyPos.current = null;
          setEd(E.editorWith(pos.draft));
        } else setEd(E.editorWith(h[pos.index]!));
        return;
      }
      if (key.name === 'pageup' || key.name === 'pagedown') return;
      if (key.name === 'home' && key.ctrl) return setEd(E.bufferStart(s));
      if (key.name === 'end' && key.ctrl) return setEd(E.bufferEnd(s));
      if (key.name === 'tab') return;

      const next = editKey(s, key);
      if (next) {
        historyPos.current = null;
        setEd(next);
      }
    },
    [menus, setMenuSel, setEd, runCommand, submitText, session, history, exit, transcript, pasteImage, openEditor, openRewindPicker, flashHint, attachPath, inputWidth],
  );

  const handlePaste = useCallback(
    (text: string) => {
      const dropped = parseDroppedPaths(text);
      if (dropped) {
        for (const p of dropped) attachPath(p);
        return;
      }
      const lines = text.split('\n').length;
      if (lines > PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS) {
        const n = ++counters.current.paste;
        pastes.current.set(n, text);
        setEd((s) => E.insert(s, `[Pasted text #${n} +${lines} line${lines === 1 ? '' : 's'}]`));
        return;
      }
      setEd((s) => E.insert(s, text));
    },
    [attachPath],
  );

  const handleSearchKey = useCallback(
    (k: Key) => {
      const st = searchRef.current!;
      const matches = history.search(st.query);
      if (k.name === 'paste') return setSearch({ query: st.query + (k.text ?? '').replace(/\n/g, ' '), index: 0 });
      if (k.ctrl && k.name === 'r') return setSearch({ ...st, index: Math.min(st.index + 1, Math.max(0, matches.length - 1)) });
      if ((k.ctrl && (k.name === 'c' || k.name === 'g')) || (k.name === 'backspace' && !st.query)) return setSearch(null);
      const m = matches[st.index];
      if (k.name === 'escape' || k.name === 'tab') {
        if (m) setEd(E.editorWith(m));
        return setSearch(null);
      }
      if (k.name === 'enter') {
        setSearch(null);
        if (m) {
          if (m.startsWith('/') && runCommand(m)) return;
          void submitText(m);
        }
        return;
      }
      if (k.name === 'backspace') return setSearch({ query: st.query.slice(0, -1), index: 0 });
      if (isText(k)) return setSearch({ query: st.query + k.text, index: 0 });
    },
    [history, runCommand, submitText, setSearch, setEd],
  );

  useEffect(() => {
    // Keys for the input box (no overlay); also used to replay held keys.
    dispatchRef.current = (k: Key) => {
      if (searchRef.current) handleSearchKey(k);
      else if (k.name === 'paste') handlePaste(k.text ?? '');
      else handleInputKey(k);
    };
    const onInput = (e: InputEvent) => {
      if (e.type !== 'key' && e.type !== 'paste') return;
      const key = e.type === 'paste' ? pasteKey(e.text) : e.key;
      if (heldKeys.current.length) {
        // Keep order behind keys that are already waiting.
        heldKeys.current.push(key);
        replayHeld();
        return;
      }
      const top = stack.current[stack.current.length - 1];
      if (top) {
        if (top(key) === 'hold') heldKeys.current.push(key);
        return;
      }
      if (overlayOpen.current) {
        heldKeys.current.push(key);
        return;
      }
      dispatchRef.current(key);
    };
    terminal.on('input', onInput);
    return () => {
      terminal.off('input', onInput);
    };
  }, [terminal, handleInputKey, handlePaste, handleSearchKey, replayHeld]);

  // An overlay that closed while keys were held: they belong to the input box.
  useEffect(() => {
    if (!overlay && heldKeys.current.length) replayHeld();
  }, [overlay, replayHeld]);

  // --------------------------------------------------------------- layout
  const dim = themeHex('dim');
  const accent = themeHex('accent');
  const stream = session.stream;
  const queue = session.queue;

  const maxInputRows = Math.max(2, Math.min(12, rows - 12));
  const lay = E.layout(ed.text, ed.cursor, inputWidth);
  const inputRows = Math.min(lay.rows.length, maxInputRows);
  const scrollTop = Math.max(0, Math.min(lay.cursorRow - inputRows + 1, lay.rows.length - inputRows));

  const overlayRows = overlay ? Math.max(3, Math.min(12, rows - inputRows - 12)) : 0;
  const menuRows = menu ? Math.min(menuLen, Math.max(3, Math.min(8, rows - inputRows - 12))) : 0;
  const spinnerRows = stream || busyLabel ? 2 : 0;
  const queueRows = queue.length ? queue.length + 1 : 0;
  const chrome = inputRows + 2 + 1 + spinnerRows + queueRows + (overlay ? overlayRows + 6 : 0) + (menu ? menuRows + 1 : 0) + (search ? 1 : 0);
  const liveBudget = Math.max(0, rows - chrome - 3);

  const live = transcript.live;
  const liveLines: string[] = [];
  if (stream) {
    const thinking = live.thinking.map((l) => lineToAnsi([{ text: '  ' }, ...l]));
    const body = live.lines.map((l, i) => lineToAnsi([{ text: i === 0 && live.first ? `${BULLET} ` : '  ' }, ...l]));
    if (thinking.length) liveLines.push('', ...thinking);
    if (body.length) liveLines.push(...(live.first ? [''] : []), ...body);
  }
  const clipped = liveLines.length > liveBudget ? liveLines.slice(liveLines.length - liveBudget) : liveLines;

  const ctx = session.contextUsage();
  const caps = session.cachedCapabilities();
  if (!caps) void session.capabilities().then(() => force()).catch(() => {});
  const effortText = caps?.reasoningEfforts.length && session.effort ? ` · ${session.effort} effort` : caps?.reasoningEfforts.length ? ' · default effort' : '';
  const ctxText = ctx.pct !== undefined ? ` · ${ctx.pct}% context` : ctx.used > 0 ? ` · ${formatTokens(ctx.used)} tokens` : '';
  const right = `${session.model}${effortText}${ctxText}`;
  const newlineHint = kitty ? 'shift+⏎ for newline' : '\\⏎ for newline';
  let left: string;
  if (hint && hint.until > Date.now()) left = hint.text;
  else if (queue.length) left = '↑ to edit queued message';
  else if (stream) left = 'esc to interrupt · enter to queue';
  else if (ed.text.startsWith('/')) left = 'tab to complete · enter to run';
  else left = `/ for commands · @ to attach · ${newlineHint}`;
  const ctxColor = ctx.pct !== undefined && ctx.pct >= 80 ? themeHex('warning') : dim;
  const gap = Math.max(1, cols - textWidth(left) - textWidth(right) - 2);
  const rightShown = textWidth(left) + textWidth(right) + 3 > cols ? truncate(right, Math.max(0, cols - textWidth(left) - 3)) : right;

  const theme = getTheme().name;
  return (
    <KeyRouterContext.Provider value={router}>
      <Static key={`${transcript.epoch}-${theme}`} items={transcript.items}>
        {(item) => {
          const str = renderItem(item, cols);
          const lead = /^\n*/.exec(str)![0].length;
          return (
            <Box key={item.key} marginTop={lead}>
              <Text>{str.slice(lead)}</Text>
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column" width={cols}>
        {clipped.length ? (
          <Box marginTop={clipped[0] === '' ? 1 : 0}>
            <Text>{(clipped[0] === '' ? clipped.slice(1) : clipped).join('\n')}</Text>
          </Box>
        ) : null}
        {spinnerRows ? (
          <Box marginTop={1}>
            <Spinner stream={stream} busyLabel={busyLabel} cols={cols} />
          </Box>
        ) : null}
        {queue.length ? (
          <Box flexDirection="column" marginTop={1}>
            {queue.map((q, i) => (
              <Text key={i} color={dim} wrap="truncate-end">
                {'> '}
                {(q.display ?? q.text).replace(/\s+/g, ' ')}
              </Text>
            ))}
          </Box>
        ) : null}
        {overlay?.type === 'picker' ? <Picker {...overlay.props} cols={cols} maxRows={overlayRows} /> : null}
        {overlay?.type === 'prompt' ? <Prompt {...overlay.props} cols={cols} /> : null}
        {overlay?.type === 'node' ? overlay.render(cols, overlayRows) : null}
        {menu === 'slash' ? <SlashMenu items={slashItems} sel={sel} rows={menuRows} cols={cols} /> : null}
        {menu === 'file' ? <FileMenu items={fileItems} sel={sel} rows={menuRows} cols={cols} /> : null}
        <Box borderStyle="round" borderColor={overlay ? dim : themeHex('border')} flexDirection="column" width={cols} marginTop={1} paddingLeft={1}>
          {lay.rows.slice(scrollTop, scrollTop + inputRows).map((row, i) => {
            const r = scrollTop + i;
            const prefix = r === 0 ? '> ' : '  ';
            const showCursor = !overlay && !search && r === lay.cursorRow;
            if (!ed.text && r === 0) {
              return (
                <Text key={r}>
                  <Text color={dim}>{prefix}</Text>
                  {showCursor ? <Text inverse> </Text> : null}
                  <Text color={dim}>{truncate(stream ? 'Type to queue a message' : 'Send a message', inputWidth - 2)}</Text>
                </Text>
              );
            }
            if (!showCursor) {
              return (
                <Text key={r}>
                  <Text color={r === 0 ? undefined : dim}>{prefix}</Text>
                  {row}
                </Text>
              );
            }
            const col = lay.cursorCol;
            const g = sliceCols(row, col);
            return (
              <Text key={r}>
                {prefix}
                {g.before}
                <Text inverse>{g.at || ' '}</Text>
                {g.after}
              </Text>
            );
          })}
        </Box>
        {search ? (
          <Text wrap="truncate-end">
            <Text color={dim}>{'(reverse-i-search)`'}</Text>
            <Text>{search.query}</Text>
            <Text color={dim}>{"': "}</Text>
            <Text>{(history.search(search.query)[search.index] ?? '').replace(/\s+/g, ' ')}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <Text color={hint && hint.until > Date.now() ? accent : dim}>{' ' + left}</Text>
            <Text>{' '.repeat(gap)}</Text>
            <Text color={ctxColor}>{rightShown}</Text>
          </Text>
        )}
      </Box>
    </KeyRouterContext.Provider>
  );
}

/** Split a row at a visual column for drawing the cursor. */
function sliceCols(row: string, col: number): { before: string; at: string; after: string } {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let c = 0;
  let before = '';
  let at = '';
  let after = '';
  for (const { segment } of seg.segment(row)) {
    if (c < col) before += segment;
    else if (!at && c === col) at = segment;
    else after += segment;
    c += textWidth(segment);
  }
  return { before, at, after };
}

function SlashMenu({ items, sel, rows, cols }: { items: CommandDef[]; sel: number; rows: number; cols: number }): React.ReactElement {
  const dim = themeHex('dim');
  const accent = themeHex('suggestion');
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), items.length - rows));
  const nameW = Math.min(Math.floor(cols / 2), Math.max(...items.map((c) => c.name.length + (c.argHint ? c.argHint.length + 1 : 0))) + 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      {items.slice(start, start + rows).map((c, i) => {
        const selected = start + i === sel;
        const name = `/${c.name}${c.argHint ? ` ${c.argHint}` : ''}`;
        return (
          <Text key={c.name} wrap="truncate-end">
            <Text color={selected ? accent : undefined} bold={selected}>
              {'  '}
              {name.padEnd(nameW)}
            </Text>
            <Text color={dim}>{truncate(c.description, Math.max(0, cols - nameW - 3))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function FileMenu({ items, sel, rows, cols }: { items: string[]; sel: number; rows: number; cols: number }): React.ReactElement {
  const accent = themeHex('suggestion');
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), items.length - rows));
  return (
    <Box flexDirection="column" marginTop={1}>
      {items.slice(start, start + rows).map((f, i) => {
        const selected = start + i === sel;
        return (
          <Text key={f} color={selected ? accent : undefined} bold={selected} wrap="truncate-start">
            {'  '}
            {truncate(f, cols - 4)}
          </Text>
        );
      })}
    </Box>
  );
}
