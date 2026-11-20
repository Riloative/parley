# parley — notes for working on this codebase

parley is a terminal chat client (TypeScript, strict; React + Ink 8; Node ≥ 22) that imitates the look and behaviour of a terminal coding-assistant CLI but only converses. Users run it daily, so reliability and smooth rendering beat features.

Priorities when they conflict: (1) no lost conversations, no corrupted terminal, no leaked keys; (2) smooth streaming and typing; (3) visual/behavioural fidelity; (4) breadth.

## Commands

```bash
npm install
npm run build        # esbuild bundle → dist/ (dist/ IS committed; rebuild and commit it with every src change)
npm run typecheck
npm run lint
npm test             # all tests (unit + PTY); no network or keys needed
npx vitest run test/unit            # fast unit tests
npx vitest run test/pty             # drive the real binary in a pseudo-terminal
PEEK='hello|@key:enter|@sleep:800|@screen' npx vitest run test/pty/peek.test.ts --silent=false   # look at frames
npm run check:dist   # rebuild and fail if dist/ differs from the commit
```

`PEEK` steps: plain text is typed; `@key:enter|esc|up|down|tab|shift-tab|ctrl-c|ctrl-o|…`, `@wait:<text>`, `@sleep:<ms>`, `@resize:<cols>x<rows>`, `@screen`, `@all` (scrollback), `@raw`. `PEEK_SIZE=60x20`, `PEEK_ARGS="-m mock/long?lines=200"`, `PEEK_CONFIG` (YAML, `\n` escaped).

Why dist/ is committed: `npm install -g .` packs the folder *before* installing any dependency, so no build step can run there. Everything is bundled, so the package has no runtime dependencies (all packages are devDependencies). CI fails if dist/ is stale.

## Layout

```
bin/parley.js            enables Node's compile cache, imports dist/cli.js
src/cli.ts               arg parsing; --help/--version without loading anything else; dispatch
src/interactive.tsx      wires terminal + session + transcript + Ink; exit/signal handling
src/print.ts             -p mode (pipes, --json, exit codes)
src/doctor.ts, keycmd.ts `parley doctor`, `parley key …`
src/bootstrap.ts         config + theme + registry + store; model selection
src/debug.ts             --debug log (redacted)

src/providers/
  types.ts               Provider interface, ContentPart/ChatMessage/StreamEvent, ProviderError
  registry.ts            builds providers from config (adapters lazy-imported), capability overrides, sampling merge
  http.ts                proxy-aware fetch (undici, no timeouts during model loads), SSE parser, HTTP→ProviderError mapping
  anthropic.ts           official SDK (lazy), adaptive thinking + summaries, effort, caching, typed errors
  openai.ts              Responses API over SSE
  compat.ts              chat-completions, tolerant parsing, server probes (llama.cpp /props, Ollama /api/show, LM Studio)
  mock.ts                scripted provider used by every test (permanent feature)

src/core/
  conversation.ts        message tree + head pointer; toChatMessages() (provider-neutral history, reasoning filtering)
  store.ts               append-only JSONL per conversation, replay/crash recovery, locks, list/search, attachments
  session.ts             turns, frame batching (33ms), delta persistence (400ms), retries, queue, rewind/retry, compaction, titles
  history.ts, state.ts, usage.ts

src/render/
  markdown.ts            marked lexer → styled Lines; StreamingMarkdown (commit-once incremental renderer)
  highlight.ts           highlight.js, lazily imported; finished code is held back until it is loaded
  style.ts, theme.ts, width.ts   spans/lines → ANSI; themes; grapheme-aware widths and wrapping

src/term/
  keys.ts                stdin bytes → key events (legacy, SS3, kitty CSI u, modifyOtherKeys, bracketed paste)
  terminal.ts            raw mode, protocol negotiation, InkStdout proxy, resize debounce, restore on every exit path
  caps.ts, clipboard.ts

src/ui/
  App.tsx                the interface: <Static> transcript + dynamic area (live tail, spinner, queue, overlays, input, status)
  transcript.ts          TranscriptModel: session events → write-once items + live tail; reprint on resize/Ctrl+O/rewind
  blocks.ts              item → ANSI string (welcome box, user/assistant blocks, stats, notices)
  editor.ts              pure input buffer (graphemes, readline kills, atomic chips, word-wrapped layout)
  overlays.tsx           Picker / Prompt and the key-router context
  screens.tsx            first-run setup, /providers, /config
  attachments.ts, fuzzy.ts, Spinner.tsx

src/commands/commands.ts built-in slash commands + Markdown custom commands
src/config/              config.ts (YAML + validation with line numbers), credentials.ts (env → keychain → file), presets.ts, paths.ts
```

## How rendering stays flicker-free

- Finished content goes through Ink's `<Static>` exactly once. Each item is pre-rendered to an ANSI string no wider than the terminal, so Ink never re-wraps it.
- `StreamingMarkdown.update(text)` lexes only the uncommitted tail, commits every block that can no longer change (and complete lines of an open code fence), and returns the rest as the live tail. Invariant (tested with random chunkings): concatenated commits == one-shot render.
- The dynamic area is clamped so it is always shorter than the terminal (Ink falls back to clearing the viewport otherwise). The live tail shows its last lines if it is taller.
- Session frames are batched to ~30 fps; Ink runs with `maxFps: 30`, `incrementalRendering`, and DEC 2026 synchronized output.
- Ink gets a proxy stdout (`InkStdout`). On a width change the app clears screen + scrollback and remounts `<Static>` (new key) to reprint the conversation at the new width, then forwards the resize to Ink. The same "reprint" path handles Ctrl+O, rewind, retry, resume and theme changes.
- Keys can arrive faster than React renders (a paste plus Enter in one chunk), so editor/search/picker state that key handlers read lives in refs updated synchronously. Keep it that way.

## Conventions

- Provider-specific details stay inside `src/providers/*`. Everything above talks in `ContentPart`/`StreamEvent`. Tool calls would be new `ContentPart` variants.
- Never hard-code model names in code; capabilities come from provider APIs, heuristics on ids (OpenAI), or config overrides.
- Errors shown to the user are plain language and include the provider's own message, passed through `redact()`. Never put a key in a message, log, transcript or config.
- Persistence is append-only; never rewrite or delete conversation lines. New event types must be ignored safely by older readers (bump `SCHEMA_VERSION` only for incompatible changes).
- Colours: use theme tokens (`fg: 'accent' | 'dim' | …`), never raw hex in UI code. `themeHex()` for Ink props respects NO_COLOR and the ANSI theme.
- Tests: no network. Use the mock provider (`mock/<script>?opts`) or the local HTTP fixture server in `test/unit/adapters.test.ts`. PTY tests go through `test/pty/harness.ts`, which strips CI/proxy/key variables from the child environment and isolates XDG directories.
- Fix root causes; don't special-case tests.

## Gotchas

- Ink treats CI environments as non-interactive; we pass `interactive: true` explicitly.
- The Anthropic SDK (1.x) sends `Authorization: Bearer` and API version 2026-10-21, which rejects sampling parameters.
- Fetch refuses some ports ("bad port", e.g. 1, 9); tests pick free ephemeral ports instead.
- `listFiles()` refuses to crawl `$HOME` itself (the @ picker would be enormous); PTY tests that use @ run in a subdirectory.
- The PTY harness answers the terminal's DA1 query; `kitty: true` also answers the kitty keyboard query (xterm.js itself doesn't implement the protocol).
