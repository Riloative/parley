# Changelog

## Unreleased

**parley is now taria.** The command, the npm package and the release archives are called `taria`. See *Upgrading from parley* below.

### Upgrading from parley

- **Files move on the first start of taria:** `~/.config/parley`, `~/.local/share/parley`, `~/.local/state/parley` and `~/.cache/parley` become the `taria` folders, and the old paths become links to them, so an old parley still finds everything. taria says in one line what it moved. The move waits while a parley window has a conversation open, and a read-only folder is copied and left as it was. Conversations are never rewritten.
- **Keys** stored by parley are read under the old keychain name and copied to a taria entry when first used; the old entry stays until `taria key remove-old <provider>`. A credentials file moves with the config folder.
- **`PARLEY_*` environment variables** still work, as `TARIA_*`, with one notice per run on stderr.
- **The `parley` command** still works in 0.3.x (one line on stderr, then taria with the same arguments and exit status). **It will be removed in 0.4.0**, together with the `PARLEY_*` names.
- **npm:** run `npm uninstall -g parley` before installing taria; the old package owns the `parley` command.
- Conversation files written by parley open unchanged (`meta.app` may be `parley` or `taria`; the schema version stays 1). `/terminal-setup` backups are now `.taria-backup`, and existing `.parley-backup` files are never overwritten.
- 0.2.0 with `check_for_updates: true` is told about 0.3.0: GitHub redirects the old repository's API address to the renamed one.
- `taria doctor` reports an old parley binary on `PATH` and old folders, and changes nothing.

### Fixed

- **Conversations cut short by the crash bug in parley 0.0.1–0.2.0 show their whole history again.** If parley died while a reply was streaming and the conversation was then continued, older versions opened it at the first message after the crash. Every line was still in the file: taria now recovers the cut-off replies when reading, and records them (marked as interrupted) the first time it opens such a conversation for writing, with one line saying so. `taria doctor` lists affected conversations and `taria doctor repair` repairs them all after asking. Repairs only add lines.
- **`theme: auto`** now understands terminals that answer the background query as `rgba:…` or `#rrggbb`; they used to get the dark palette. The answer is still never waited for.
- **The conversation list** (`-c`, `/resume`) could show a stale title or message count for a file rewritten with the same size and modification time (by a restore or sync tool); the cache now also compares the change time and inode.
- **`/terminal-setup`** keeps Windows line endings in a `keybindings.json` that uses them.
- A conversation that 0.2.0 had already patched this way, by recording the recovered reply at the end of the file, opened at that reply instead of the newest message; it now opens at the newest message.
- **`/copy` said it copied when it had not.** On a Linux desktop without `wl-clipboard` or `xclip`, `/copy` fell back to OSC 52 and reported "Copied … via OSC 52", but VTE-based terminals (GNOME Terminal, Ptyxis, Tilix, Terminator) ignore OSC 52, so nothing reached the clipboard. parley now says *Copied* only when a tool confirmed it, *Sent … (OSC 52)* when it handed the text to the terminal, and *Nothing was copied* (with what it tried, what to install, and an offer to write the text to a file) when no method applies.
- **tmux:** `/copy` used to wrap OSC 52 for passthrough, which tmux 3.3 and later drop by default. It now hands the text to tmux (`load-buffer -w`), which keeps it in tmux's paste buffer and passes it on to the terminal.

### Added

- **WSL:** `/copy` uses `clip.exe`, sending UTF-16 so non-ASCII text survives.
- **`clipboard: auto | native | osc52 | off`** and **`clipboard_command:`** in the config (also in `/config`).
- **`parley doctor`** says which method `/copy` uses and why; **`parley doctor clipboard`** copies a test line and reads it back where a paste tool exists.
- OSC 52 copies larger than about 73 KB are not sent (terminals drop them silently); parley says so and offers a file.
- GNU screen: OSC 52 is sent in pieces screen passes through.

## 0.2.0 — 2026-11-24

### Added

- **Unsent drafts are kept.** Whatever is in the input box is saved as you type and comes back the next time you open that conversation, after a crash, a closed terminal or a killed process. Pasted blocks and attachments come back with it. Sending or clearing the input removes the draft.
- **Desktop notification** when a reply that took longer than `bell_after_seconds` finishes while the terminal window is not focused. It works in iTerm2, WezTerm, Ghostty, kitty, foot and urxvt; `notifications: off | osc9 | osc777 | osc99` turns it off or forces a protocol. Other terminals, and tmux, are left alone.
- **Clickable links.** In terminals with hyperlink support (iTerm2, WezTerm, Ghostty, kitty, VS Code, GNOME Terminal, Alacritty), web and mail links are real links and the URL is no longer printed after the text. Elsewhere, including tmux and SSH, links stay as `text (url)`. `FORCE_HYPERLINK=1` or `0` overrides the detection. Links with other schemes always show their URL.
- **Numbered code blocks.** Each code block in a reply is labelled with its number (`python · 2`), and `/copy code 2` copies that one. `/copy code` still copies the last.
- **`/find <text>`** searches the current conversation and shows the chosen message again.
- **Branches are visible.** A `⑂ branch 2 of 3` line marks every point where the conversation was rewound or a reply retried, and `/branches` switches between branches.
- **Very long conversations** print only their newest 200 messages when the screen is redrawn (resume, resize, Ctrl+O), with a line saying how many are hidden; `/history` shows everything. The model still receives the whole conversation.
- **`/compact` on one key.** From 80% of the context window, the status line offers "tab to compact" while the input is empty, instead of waiting for a message to be refused.
- **Queued messages are edited in place.** `↑` on a queued message now opens it where it is in the queue instead of pulling it out: `↑`/`↓` move between queued messages, Enter saves, Ctrl+C puts it back as it was, and saving it empty removes it. Whatever was in the input box comes back afterwards, and nothing in the queue is sent while one is being edited.
- **Undo and redo in the input box:** `Ctrl+_` or `Ctrl+Z` undoes, `Alt+Z` (or `Ctrl+Shift+Z` where the terminal reports it) redoes. Typing is undone a word at a time; pastes and deletions one by one.
- **Model picker details and favourites.** Each model shows its context window and whether it takes images and reasons, where the provider or your config says so. `Ctrl+F` marks a favourite; favourites are listed first.
- **`/config`** can now change `soft_line_breaks` (the conversation is redrawn at once), `reduced_motion` and `check_for_updates`.
- **`/terminal-setup vscode` and `/terminal-setup tmux`** show the settings for that terminal and offer to write them even when parley is running somewhere else. It still asks before writing anything.
- **`reduced_motion: true`** replaces the animated spinner with a still one (also in `-p` mode). The elapsed time still counts.
- **`check_for_updates: true`** (off by default) asks GitHub for the latest release at most once a day and mentions a newer version once. Nothing is downloaded or installed, and the request carries only parley's version.

### Performance

- Measured against 0.1.0 on a Linux dev container: start-up is unchanged (154 ms median first frame for both, 100 runs each), and so is streaming (26 ms of CPU per frame at 20,000 tokens/s; 6 ms per frame at 80 tokens/s). Opening or resizing a 300-turn conversation is faster because only the newest 200 messages are printed (resume 348 → 268 ms, resize 233 → 148 ms).

### Fixed

- **A conversation continued after a crash could lose its earlier messages.** If parley died while a reply was streaming and the conversation was then resumed and continued, the next time it was opened it started at the first message sent after the crash; everything before it was hidden and no longer sent to the model. The recovered partial reply is now recorded when the conversation is reopened. Conversations already affected still have every line in their file.
- **The first message after a crash could be lost.** When the file ended in a half-written line, the next event was written onto the same line and both were unreadable. The line is now ended first.
- **Conversation printed twice on a slow link.** With `theme: auto`, a background-colour answer that arrived after messages had been exchanged printed the conversation a second time.
- **Terminal replies typed into the input box.** A reply from the terminal that arrived in two pieces more than a moment apart (slow SSH) left its second half in the input box. The rest of such a reply is now waited for, for up to two seconds.
- **OpenAI: a failed attempt's reasoning was kept.** When a request was retried, encrypted reasoning from the attempt that failed was stored with the reply and sent back on later turns.
- **OpenAI: a conversation could get stuck.** If the API refused a request because of reasoning replayed from an earlier turn, every later message failed the same way. parley now sends the request again without the earlier reasoning.
- **`/terminal-setup`** no longer reports "already has this setting" for a tmux.conf that sets `extended-keys off` (or only `extended-keys-format`), or for a Shift+Enter keybinding that sends something else. It writes through a symlinked config instead of replacing the link, keeps the file's permissions, never overwrites an earlier backup, and accepts a keybindings.json that starts with a byte-order mark.
- **Editing a queued message** could, under load, replace the queued text with what had been in the input box (found by CI before release).
- **Welcome box colours on a slow link.** When the terminal's background answer arrives after the first frame, the welcome box is now drawn again in the right palette if it is still alone on the screen. It is redrawn where it is, without clearing anything, and the first frame is not delayed.
- **`/copy code`** now finds code blocks inside lists and quotes, and indented code blocks; it used to see only top-level fenced blocks.
- **`/help` table.** The `/system` and `/theme` rows were split in the wrong place and lost their descriptions, because the `|` in their argument hints was read as a column separator. Tables built from dynamic text (`/help`, `/cost`) now escape every cell, so custom commands and model names containing `|` or Markdown are shown literally too.

## 0.1.0 — 2026-11-20

### Added

- **Standalone binaries** for macOS (arm64, x64) and Linux (x64, arm64). They are built with Node.js single executable applications (Node 26.13.1 embedded), so Node doesn't need to be installed. Each release attaches `parley-<os>-<arch>.tar.gz` and `SHA256SUMS`. Linux binaries need glibc 2.28+ and libatomic.
- **`install.sh`:** `curl -fsSL …/install.sh | sh` installs the binary to `~/.local/bin` after verifying its checksum. `PARLEY_VERSION` and `PARLEY_INSTALL_DIR` choose the version and directory.
- **Build details:** `parley --version` shows the build kind (standalone binary or node package), the Node runtime and the platform. `parley doctor` shows the install method and location.
- **OpenAI reasoning carries over between turns.** With the Responses API in stateless mode (`store: false`), parley now keeps each reply's encrypted reasoning and sends it back with the next request to the same model, so reasoning models keep their train of thought across turns.
- **`theme: auto` follows the terminal's background.** parley asks the terminal for its background colour (OSC 11) at start-up and picks the light or dark palette. It never waits for the answer: a late answer (a slow link) applies to everything drawn after it, and a terminal that doesn't answer gets the previous behaviour.
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
