# Changelog

## Unreleased

### Added

- **Standalone binaries** for macOS (arm64, x64) and Linux (x64, arm64). They are built with Node.js single executable applications (Node 26.13.1 embedded), so Node doesn't need to be installed. Each release attaches `parley-<os>-<arch>.tar.gz` and `SHA256SUMS`. Linux binaries need glibc 2.28+ and libatomic.
- **`install.sh`:** `curl -fsSL …/install.sh | sh` installs the binary to `~/.local/bin` after verifying its checksum. `PARLEY_VERSION` and `PARLEY_INSTALL_DIR` choose the version and directory.
- **Build details:** `parley --version` shows the build kind (standalone binary or node package), the Node runtime and the platform. `parley doctor` shows the install method and location.
- **OpenAI reasoning carries over between turns.** With the Responses API in stateless mode (`store: false`), parley now keeps each reply's encrypted reasoning and sends it back with the next request to the same model, so reasoning models keep their train of thought across turns.
- **`theme: auto` follows the terminal's background.** parley asks the terminal for its background colour (OSC 11) at start-up and picks the light or dark palette. It never waits for the answer: a terminal that answers late or not at all gets the previous behaviour.
- **`/terminal-setup`** shows the VS Code keybinding and the tmux setting that make Shift+Enter insert a new line, and writes them to the right file (with a backup) only if you confirm.
- **`soft_line_breaks: join`** renders a single newline inside a Markdown paragraph as a space, as CommonMark does. The default, `keep`, is unchanged.

### Performance

- **Faster start-up.** Two dependencies did avoidable work before the first frame: Ink's layout engine loaded Node's whole HTTP stack to decode its embedded WebAssembly, and the text-width library built a large emoji table. Both are now avoided or deferred (measured on a Linux dev container, median first frame: npm build 179 → 146 ms, standalone binary 231 → 140 ms).
- **Long conversations reprint about 3–4× faster.** Resuming, resizing, Ctrl+O, rewind and theme changes now write the already-rendered history straight to the terminal (300-turn conversation: resume 859 → 302 ms, resize 704 → 186 ms).
- **`-c` and `/resume` with a long history.** Conversation summaries are cached, so only conversations that changed are read again (1,000 conversations: `-p -c` 324 → 141 ms, opening `/resume` 170 → 35 ms).
- **No stalls in the first reply.** One-time renderer work (Markdown, the first code block of common languages) now happens while you type your first message instead of mid-reply.

### Fixed

- **Keys typed ahead across screens.** Several keys arriving at once (fast typing, slow SSH links) could land on the previous screen of a multi-step dialog. In the provider wizard, the name you typed could even be saved as the API key. Input is now delivered one key at a time, letting the interface catch up in between; held keys are replayed to the next screen; and each wizard step has its own text field.
- **Crashes and signals.**
  - An error inside the interface now restores the terminal, prints the error (redacted) and exits with status 1. It used to exit 0 silently; in the standalone binary, Ink's error screen also dumped raw bytes of the executable to the terminal for several seconds.
  - A crash report is printed after cleanup, so it is no longer drawn over.
  - Ctrl+C reaching parley while `$EDITOR` is open no longer quits parley.
- **Conversation files.**
  - A damaged or hand-edited line (`null`, a message without content, an unknown role or content type, a dangling branch pointer) is skipped instead of crashing later.
  - A lock left by a killed parley whose process ID has since been reused by another program is recognised as stale. Locks now record the holder's start time; old locks are still read.
- **`parley -p -c`** now says when the latest conversation is open in another window, instead of exiting 1 with no message.
- **Streaming Markdown.** A code fence's language label was committed before its opening line had fully arrived, so `python` could be shown as `p`.
- **Ctrl+L then resize.** Resizing the terminal after Ctrl+L brought the cleared conversation back.
- **Keys in error text.** An error message quoting the API key (from a mid-stream error, a crash report or a retry reason) is now redacted everywhere: notices, the transcript and logs.
- **Keys typed while parley starts** are no longer dropped.
- **Two confirmations in a row** no longer start on the previous answer: a dialog opened right after another one inherited its selection.
- **Long Retry-After.** When a provider asks for a wait longer than a minute, parley now stops and says how long to wait, instead of retrying early.
- **Proxy support in the npm package.** In the code-split npm bundle, parley couldn't load its HTTP client and silently fell back to the built-in `fetch`. As a result, `HTTPS_PROXY`/`HTTP_PROXY` were ignored and the no-timeout settings for slow local model loads didn't apply. A test now drives the built program through a proxy.

## 0.0.1 — 2026-11-20

First release.

### Features

- **Chat in the terminal** with a provider-agnostic core and three adapters:
  - Anthropic, through the official SDK (adaptive thinking, effort, images, prompt caching)
  - OpenAI, through the Responses API (reasoning summaries, effort, images)
  - a tolerant OpenAI-compatible adapter for Mistral, llama.cpp, Ollama, LM Studio, OpenRouter, Groq and similar servers
- **Interface modelled on terminal coding-assistant CLIs:**
  - a welcome box, write-once transcript and streaming Markdown with syntax highlighting
  - reasoning collapsed to "Thought for Ns"
  - a spinner that distinguishes connecting, waiting and streaming
  - dark, light and ANSI-16 themes; `NO_COLOR` is honoured
- **Flicker-free streaming:**
  - finished content is written to scrollback once
  - the live area always fits the terminal
  - updates are batched to about 30 fps and wrapped in synchronized output
  - the conversation reflows cleanly on resize
- **Keyboard:**
  - readline editing and input history
  - `Ctrl+R` history search; `Esc` `Esc` to rewind and branch
  - typing and queueing while a reply streams
  - collapsed pastes, `@` file attachments, drag and drop, `Ctrl+V` images, `Ctrl+G` to edit in `$EDITOR`
  - Shift+Enter through the kitty keyboard protocol
- **Slash commands:** `/model`, `/new`, `/resume`, `/rewind`, `/retry`, `/system`, `/persona`, `/compact`, `/copy`, `/export`, `/rename`, `/delete`, `/cost`, `/config`, `/providers`, `/theme`, `/help`, `/exit`, plus custom Markdown commands.
- **Persistence:**
  - append-only JSONL conversations, written as events happen and recovered after a crash
  - branches are never deleted
  - several instances can run at once
- **Configuration and keys:**
  - commented YAML config, validated with line-numbered errors
  - API keys looked up from environment variables, then the OS keychain, then a private credentials file
- **Non-interactive mode:** `parley -p` (with piped stdin, `--json`, `-m/-s/-c/-r`), `--debug` logging with keys redacted, and `parley doctor`.

### Known limitations

- The provider adapters have been tested against recorded-format fixtures only, not against live APIs.
- The OS keychain, clipboard image paste and Shift+Enter in real kitty-protocol terminals have not yet been checked on real machines.
