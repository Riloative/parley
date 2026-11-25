# taria — notes for working on this codebase

taria is a terminal chat client (TypeScript, strict; React + Ink 8; Node ≥ 22) that imitates the look and behaviour of a terminal coding-assistant CLI but only converses. Users run it daily, so reliability and smooth rendering beat features.

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

## Standalone binaries

`node scripts/build-binary.mjs` builds `build/bin/taria` (and `build/bin/taria-<os>-<arch>.tar.gz`) for the machine it runs on. Binaries are never committed; CI builds them on native runners (`.github/workflows/binaries.yml`). Test any build with the PTY suite: `TARIA_BIN=$PWD/build/bin/taria npx vitest run test/pty`.

- **Technology: Node.js single executable applications (SEA).** Pinned runtime: Node **26.13.1** (active LTS), in `scripts/binary-runtime.json`. The script downloads the official build for the host platform, checks it against `SHASUMS256.txt`, and runs `node --build-sea`.
- **Shape of the build:** one ESM file (`mainFormat: "module"`, so yoga-layout's top-level await works) with code splitting off, because an executable can't load chunk files. esbuild inlines the lazily imported modules. `react-devtools-core` is aliased to a stub (`scripts/stubs/`), because Ink's optional DevTools import would otherwise be linked eagerly and fail. Code cache on; `execArgvExtension: "none"`, so `NODE_OPTIONS` can't change the binary's behaviour.
- **Why SEA over `bun build --compile`.** Both passed the full PTY suite (49 tests) and the HTTP tests (Anthropic SDK, Responses API, `HTTP_PROXY`/`NO_PROXY`) locally on linux-x64. Bun was smaller (110 MB vs 153 MB) and faster to start (169 ms vs 229 ms median first frame in a cloud container). SEA was chosen for reliability:
  - it is the same runtime the npm package and every test already use, from official, checksummed builds with LTS support
  - Bun's Node compatibility layer is a second runtime whose differences (tty, signals, streams, undici internals) the tests might not catch
  - the start-up gap is the runtime (Node 26 runs the npm build equally slowly), and is addressed by start-up work that benefits both builds
- **Why not Node 22/24 SEA:** only CommonJS entry points before Node 25. **Why not `deno compile`:** not needed, since SEA passed.
- **Targets:** darwin-arm64 and linux-x64, each built and tested on a native GitHub runner (`macos-latest`, `ubuntu-24.04`). darwin-x64 and linux-arm64 binaries were published up to 0.3.0 and dropped in 0.3.1 (nobody used them, and each cost a scarce runner per run); `install.sh` there says to use the npm package.
  - **macOS:** binaries are signed ad hoc (`codesign --sign -`), not notarized.
  - **Linux:** binaries need glibc ≥ 2.28 (Node's official builds), plus libstdc++ (GLIBCXX_3.4.21) and libatomic, which minimal images such as `debian:10` lack. CI runs the binaries in AlmaLinux 8 (glibc 2.28) and checks that they fail with taria's own glibc error on Ubuntu 18.04. Both containers get the runner's libatomic mounted instead of installing it, so distribution mirror outages can't fail the check.
  - **Not built:** musl (Node has no official musl builds) and Windows.
- **To upgrade the embedded Node:** change `scripts/binary-runtime.json`, rebuild locally, and run the PTY suite with `TARIA_BIN`.

`install.sh` (POSIX sh, shellcheck-clean, tested in `test/unit/install.test.ts` and in CI against the real archives) installs a release binary. `TARIA_RELEASES_URL` points it at another layout, such as `file://` in tests.

## Releasing

1. Bump the version: `npm version X.Y.Z --no-git-tag-version`, then `npm run build` (the version is baked into dist/).
2. Add a `## X.Y.Z — date` section to CHANGELOG.md.
3. Merge to main. Tags cannot be pushed from Claude Code cloud sessions (HTTP 403), so give the user these commands to run in a GitHub Codespace, with the merge commit's full SHA:
   `git fetch origin main --tags` · `git tag -a vX.Y.Z -m "taria X.Y.Z" <sha>` · `git push origin vX.Y.Z`.
4. `.github/workflows/release.yml` then checks the tag against package.json, re-runs the checks, builds and tests the two binaries through the reusable `binaries.yml`, and publishes a GitHub Release. The release carries `taria-<os>-<arch>.tar.gz`, the npm tarball and `SHA256SUMS`, with that CHANGELOG section as its notes. CI runs the same build-and-package steps on every pull request.

## Layout

```
bin/taria.js             enables Node's compile cache, imports dist/cli.js
src/brand.ts             the names (taria, and parley before 0.3.0); the notice for PARLEY_* variables (not read since 0.4.0); rename notices
src/version.ts           version, build kind (node package vs standalone binary)
src/trace.ts             start-up phase marks for TARIA_STARTUP_TRACE
scripts/build-binary.mjs standalone executable (Node SEA)
scripts/esbuild-plugins.mjs build-time patches to dependencies (shared by both builds; equivalence-tested)
scripts/bench-*.mjs      start-up, streaming and long-history benchmarks (see Gotchas)
install.sh               curl | sh installer for the release binaries
src/cli.ts               --help/--version without loading anything else; migration; dispatch (importing it runs the program)
src/args.ts              parseArgs (no side effects; tests import this, never cli.ts)
src/cliSpec.ts           the command line described once: --help, completions.ts and manpage.ts are generated from it
schema/config.schema.json JSON Schema of the config file; test/unit/cli-spec.test.ts keeps it equal to config.ts's key lists and enums
src/interactive.tsx      wires terminal + session + transcript + Ink; exit/signal handling
src/print.ts             -p mode (pipes, --json, exit codes)
src/doctor.ts, keycmd.ts `taria doctor`, `taria key …`
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
  drafts.ts              the unsent input text per conversation (debounced, atomic, flushed on shutdown)
  update.ts              opt-in daily check for a newer release (lazy-imported after the first frame; `TARIA_UPDATE_URL` in tests)
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
  undo.ts                undo/redo stack over editor states (recorded in setEd; typing grouped by word)
  overlays.tsx           Picker / Prompt and the key-router context
  screens.tsx            first-run setup, /providers, /config
  attachments.ts, fuzzy.ts, Spinner.tsx

src/commands/commands.ts built-in slash commands + Markdown custom commands
src/config/              config.ts (YAML + validation with line numbers), credentials.ts (env → keychain (taria, then parley's entry) → file), presets.ts, paths.ts
  migrate.ts             one-time move of parley's folders to taria's (rename + link, or copy + verify; resumable)
```

## How rendering stays flicker-free

- Finished content is printed exactly once: through Ink's `<Static>` while streaming, or directly on a reprint (below). Each item is pre-rendered to an ANSI string no wider than the terminal, so Ink never re-wraps it.
- `StreamingMarkdown.update(text)` lexes only the uncommitted tail, commits every block that can no longer change (and complete lines of an open code fence), and returns the rest as the live tail. Invariant (tested with random chunkings): concatenated commits == one-shot render.
- The dynamic area is clamped so it is always shorter than the terminal (Ink falls back to clearing the viewport otherwise). The live tail shows its last lines if it is taller.
- Session frames are batched to ~30 fps; Ink runs with `maxFps: 30`, `incrementalRendering`, and DEC 2026 synchronized output.
- Ink gets a proxy stdout (`InkStdout`). On a width change the app clears screen + scrollback, reprints the conversation at the new width, then forwards the resize to Ink. The same "reprint" path handles Ctrl+O, rewind, retry, resume and theme changes.
- A reprint (and the first render) writes the transcript's items directly to stdout, after `ink.clear()`, and remounts `<Static>` (new key) with only the items added afterwards. Through `<Static>`, Ink would take every character of the history through its cell grid: about 0.7 s for a 300-turn conversation, against about 0.2 s written directly. This is safe because Ink never replays static output on the primary screen.
- Keys can arrive faster than React renders (a paste plus Enter in one chunk). Three layers deal with it:
  - `TerminalController` delivers the events of a chunk one at a time, yielding to the event loop in between, so React commits each key's effect before the next.
  - State that key handlers read (editor, search, picker, prompt) lives in refs that are updated synchronously.
  - A picker or prompt that has just acted answers `'hold'`, and the router replays held keys to whatever handles input next.

  Keep all three.
- Terminal modes are switched on only when used and are always in `restoreSequence`: focus reporting (DEC 1004) is on only if a notification protocol is configured or detected (`src/ui/notify.ts`), and its reports are decoded to `focus` events, never keys.
- Code blocks in assistant messages are numbered (`numberCode`), in the order `codeBlockTexts()` returns them; `StreamingMarkdown` carries the count across committed blocks, and the streaming invariant is tested with numbering on. Links are OSC 8 only when `hyperlinksEnabled()` and `linkTarget()` accept the URL.
- Reprints of conversations longer than `COLLAPSE_ABOVE` messages print the newest `COLLAPSE_KEEP` (`src/ui/transcript.ts`); `/history` toggles.
- While a queued message is being edited, `session.holdQueue(true)` keeps the queue from being sent, and the queue slot always holds the text typed so far, so an interrupted reply hands back the edited text.
- A late background answer repaints the welcome box in place (`repaint-welcome`: cursor up, erase down) only when it is the sole item, the size is unchanged since the first print, and the input is empty and idle. Every other case keeps the old colours; never clear the scrollback for this.
- `TARIA_DEBUG_CRASH=render|uncaught[:ms]` forces a crash, for the terminal-restore tests in `test/pty/bugs.test.ts`.

## Conventions

- Provider-specific details stay inside `src/providers/*`. Everything above talks in `ContentPart`/`StreamEvent`. Tool calls would be new `ContentPart` variants.
- Never hard-code model names in code; capabilities come from provider APIs, heuristics on ids (OpenAI), or config overrides.
- Errors shown to the user are plain language and include the provider's own message, passed through `redact()`. Never put a key in a message, log, transcript or config.
- Persistence is append-only; never rewrite or delete conversation lines. `replay()` recovers every partial reply that later messages hang off (the 0.0.1–0.2.0 crash bug left such files) without moving the head, and a `message` event for an id that already has children does not move the head either; `Store.open()` with the lock records those replies and then appends a `head` event, because older readers move the head to the last message they read. `Store.open()` (with the lock) settles what a crash left behind by appending: a newline after a torn last line, and the recovered partial reply as a `message`, because replay only recovers the *last* partial. New event types must be ignored safely by older readers (bump `SCHEMA_VERSION` only for incompatible changes).
- Colours: use theme tokens (`fg: 'accent' | 'dim' | …`), never raw hex in UI code. `themeHex()` for Ink props respects NO_COLOR and the ANSI theme.
- Tests: no network. Use the mock provider (`mock/<script>?opts`) or the local HTTP fixture server in `test/unit/adapters.test.ts`. PTY tests go through `test/pty/harness.ts`, which strips CI/proxy/key variables from the child environment and isolates XDG directories.
- Fix root causes; don't special-case tests.

## The rename from parley (0.3.0)

- The old name lives only in `src/brand.ts` (`OLD_APP`) and the code that reads old data: `src/config/migrate.ts`, `src/config/merge.ts`, the keychain fallback, `meta.app` ("parley" or "taria"), `.parley-backup` recognition, and the places that tell the user about leftovers (`taria doctor`, `install.sh`).
- The move (`src/config/migrate.ts`) must stay safe when several taria processes start at once: taria's folder is never removed recursively (an empty one goes with plain `rmdir`, folders are put in place with `rename`, and a step that fails because something appeared means "look again"), and `.taria-migration.lock` next to the folders lets one process do the work. The marker (`.migrated-from-parley`) records each copied file as `[size, old mtime, copy mtime]`, so a kept old folder never brings back what taria trashed or cleared. `test/unit/migrate-review.test.ts` runs a second migration between every two file-system calls of the first.
- `taria doctor` and `taria key status` call `setKeychainReadOnly()`: they must not copy parley's keychain entry. A keychain lookup answers found, missing or error; only "missing" under taria's name allows the old entry to be copied.
- `test/fixtures/old-readers/` holds `store.ts` and `conversation.ts` from 0.0.1, 0.1.0 and 0.2.0, unchanged. `test/unit/repair-fuzz.test.ts` writes files with them and checks that every reader agrees after a repair (`FUZZ_N=30000` for a long run).
- `Store.open()` with a lock takes the lock first and reads afterwards, and restores the file's mtime after its settling appends: a repair is not user activity and must not reorder `store.list()`.
- The migration runs in `src/cli.ts` before anything opens a file, except for plain `doctor` and `doctor clipboard`, which must never change anything (`doctor repair` writes, so it moves the files first) (or create a taria folder: an existing one with files stops the move). Notices go to the welcome box, or stderr outside the interactive interface; never stdout.
- 0.4.0 removed the `parley` command (`bin/parley.js`, the alias script in the archives) and the `PARLEY_*` names. A `PARLEY_*` variable that is set is never read, but never ignored silently: `legacyEnvNotice()` (taria) and `install.sh` name it on stderr, because a silently ignored `PARLEY_DATA_DIR` or `PARLEY_INSTALL_DIR` would put files somewhere else. `install.sh` removes the 0.3 alias script from the install folder (recognised by its text, `parley is now taria`) and leaves any other `parley` file alone.
- Reading old data stays, with no end date: the migration and its links, the keychain fallback and `taria key remove-old`, `meta.app: "parley"`, `.parley-backup`, parley's credentials file as a fallback, the repair of files from 0.0.1–0.2.0, `taria doctor repair` and `doctor merge`, and `scripts/bench-startup.mjs` running a pre-rename build. Conversations written by parley must always open.
- Before a release that touches any of this, run the upgrade from a real parley 0.2.0 again (release binary and npm tarball), as was done for 0.3.1 and 0.4.0.

## Gotchas

- Ink treats CI environments as non-interactive; we pass `interactive: true` explicitly.
- The Anthropic SDK (1.x) sends `Authorization: Bearer` and API version 2026-10-21, which rejects sampling parameters.
- Fetch refuses some ports ("bad port", e.g. 1, 9); tests pick free ephemeral ports instead.
- `listFiles()` refuses to crawl `$HOME` itself (the @ picker would be enormous); PTY tests that use @ run in a subdirectory.
- Start-up differences under about 15 ms need `--runs 100`: at 30 runs the benchmark's noise in a container is that large.
- An unterminated OSC/DCS/APC that looks like a terminal reply (`REPLY_HEAD` in `src/term/keys.ts`) stays buffered across the escape timeout for up to 2 s; Alt+] and Alt+P alone are still keys.
- Clipboard (`src/term/clipboard.ts`): `planCopy()` is pure and decides the methods from env, platform and PATH; `copyText()` runs them. Report *Copied* only for a tool's exit status 0; OSC 52 and tmux are *sent*. VTE terminals (`VTE_VERSION`, locally) ignore OSC 52, so it is skipped there in `auto`. PTY tests put fake tools on `PATH` (with `/bin/cat`, since PATH holds only the fake directory).
- PTY tests: call `s.waitStable({ lastLine })` before asserting on the screen or scrollback; it waits until nothing new has arrived and everything is parsed. While a reply is still streaming the screen never settles: pass `region: () => belowSpinner(s)` to wait for the queue, input box and status line only.
- CI (`ci.yml`) runs once per commit: `pull_request` for branches, `push` only on main, and a newer commit on a pull request cancels the older run (`concurrency`). A branch without a pull request gets no CI. Jobs per run: tests on Ubuntu (Node 22, LTS) and macOS (Node 22), shellcheck, two binaries plus packaging, and the stress job on both systems: 9 jobs, 3 of them on macOS. Keep at most two pull requests open at once, and push a fix once, not once per stacked branch: in 0.3.0 seven stacked PRs queued about 40 macOS jobs and cost hours.
- `node scripts/stress-pty.mjs [--runs 5] [--load N] [files]` reruns PTY tests with every CPU busy (default: the files changed against `origin/main`). CI runs it on Ubuntu and macOS as the non-blocking `stress` job; run it locally before pushing new PTY tests.
- Third-party actions are pinned by commit SHA (the tag in a comment); Dependabot proposes updates for actions and devDependencies weekly. A dependency bump changes `dist/`, so its PR needs `npm run build` and a commit before CI passes.
- Releases get GitHub build provenance attestations (`actions/attest-build-provenance`); verify with `gh attestation verify <file> --repo Riloative/taria`.
- `<Static>` is keyed on the transcript epoch only. Anything else in the key (the theme was, once) remounts it and prints every item since the last reprint again.
- `TARIA_STARTUP_TRACE=<file>` appends the time (ms since process start) of the first rendered frame, then a JSON line of phase marks (`src/trace.ts`). `node scripts/bench-startup.mjs [--bin path] [--runs 20]` reports median and p95 over many runs (`BENCH_MARKS=1` prints the marks). Node's compile cache (enabled in bin/taria.js) roughly halves module compile time after the first run. Repeat `--bin` (a `.js` path runs with Node) to compare builds; runs alternate, so machine noise hits all alike.
- `node scripts/bench-stream.mjs [--lines 2000 --tps 20000]` measures CPU, frames, bytes per frame, typing latency and RSS while a reply streams. `node scripts/bench-history.mjs [--conversations 1000 --long-turns 300]` measures `-p -c`, opening `/resume`, resuming a long conversation and a resize reprint. Both take `--bin` like bench-startup.
- Typing latency must be measured on a parsed screen (xterm headless), not by searching raw output: with incremental rendering Ink writes only the cells that changed.
- `scripts/esbuild-plugins.mjs` patches yoga-layout (no `fetch()` for its embedded WASM) and string-width (lazy RGI_Emoji regex). Each plugin fails the build if its pattern disappears after an upgrade; `test/unit/build-plugins.test.ts` proves the patched code matches the original.
- `TARIA_BIN=/path/to/taria` makes the PTY and print-mode tests run against that executable instead of `node bin/taria.js`.
- node-pty's macOS prebuilt `spawn-helper` can lose its execute bit on install; the harness chmods it.
- The PTY harness answers the terminal's DA1 query; `kitty: true` also answers the kitty keyboard query (xterm.js itself doesn't implement the protocol).
