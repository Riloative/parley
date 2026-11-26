# taria

A terminal chat client for Claude, OpenAI, Mistral and local models (llama.cpp, Ollama, LM Studio) — and anything else that speaks the OpenAI chat-completions protocol.

taria looks and behaves like a terminal coding assistant, but it only converses: no file editing, no shell, no agent loop. It streams without flicker, writes every conversation to disk as it happens, and never makes you reach for the mouse.

```
╭─── taria v0.5.0 ───────────────────────────────────────────────────────────────────────╮
│                                 │ Tips for getting started                             │
│       Welcome back, Sam!        │ Run /help to see every command and key               │
│                                 │ Type @ to attach a file, or paste an image           │
│          ██▄▄▄▄▄▄▄▄██           │ Press Ctrl+O to show the model's thinking            │
│          ██  ████  ██           │ ──────────────────────────────────────────────────── │
│          ▀██████████▀           │ Recent activity                                      │
│            ██▀▀▀▀██             │ Mutex or semaphore? · just now                       │
│                                 │ Planning the garden beds · 2h ago                    │
│        qwen3-30b · local        │ Regex for ISO dates · yesterday                      │
│             ~/notes             │                                                      │
╰────────────────────────────────────────────────────────────────────────────────────────╯

> what's the difference between a mutex and a semaphore?

● A mutex is a lock with an owner: …
  1.8s · 412 tokens · 231 tok/s

╭────────────────────────────────────────────────────────────────────────────────────────╮
│ > Send a message                                                                       │
╰────────────────────────────────────────────────────────────────────────────────────────╯
 / for commands · @ to attach · \⏎ for newline               local/qwen3-30b · 4% context
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Setting up providers](#setting-up-providers)
- [API keys](#api-keys)
- [Keys](#keys)
- [Slash commands](#slash-commands)
- [Configuration file](#configuration-file)
- [Non-interactive use](#non-interactive-use)
- [Files and directories](#files-and-directories)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

### Upgrading from parley

taria was called parley until 0.2.0. Upgrading keeps everything:

- **Your files move once, on the first start of taria.** `~/.config/parley`, `~/.local/share/parley`, `~/.local/state/parley` and `~/.cache/parley` become the `taria` folders (renamed in one step, so nothing is ever half-moved). The old paths become links to the new folders, so an old parley binary still finds everything. taria says in one line what it moved. If a parley window still has a conversation open, the move waits until the next start, and taria uses the old folder meanwhile. A read-only folder is copied and left as it was. Conversations are never rewritten: files parley wrote open as they are.
- **API keys** stored with `parley key set` are found under the old keychain name and copied to a `taria` entry the first time they are used. The old entry stays, for an old parley; `taria key status <provider>` mentions it and `taria key remove-old <provider>` removes it.
- **Environment variables:** the `PARLEY_*` names are no longer read since 0.4.0; use the `TARIA_*` names. If a `PARLEY_*` variable is still set, taria says so once per run, on stderr (never on stdout in `-p` mode), and `taria doctor` lists it.
- **The `parley` command** is gone since 0.4.0 (0.3.x kept it as an alias). Run `taria`.
- **Binary installs:** run the install command above. It installs `taria` and removes the `parley` alias that 0.3.x put in the same folder. A real `parley` binary from before the rename is left alone; the installer and `taria doctor` tell you how to remove it.
- **npm installs:** remove the old package first, because it owns the `parley` command: `npm uninstall -g parley`, then install taria as above.
- `taria doctor` has an *Upgrade from parley* section: an old binary on your `PATH`, folders that were not moved or exist twice, conversations that are only in the old folder, keys still stored under parley's name and old variable names, each with the command that deals with it. It changes nothing.
- If both `~/.local/share/parley` and `~/.local/share/taria` hold files (taria does not move a folder onto one that is in use), `taria doctor merge` lists the conversations that are only in the old folder and, after you agree, copies them over. It never overwrites, changes or removes a file in either folder; conversations that exist in both with different content are listed and left alone.

### Standalone binary (no Node.js needed)

```bash
curl -fsSL https://raw.githubusercontent.com/Riloative/taria/main/install.sh | sh
```

The script picks the build for your OS and CPU, downloads it from the latest [release](https://github.com/Riloative/taria/releases), verifies its SHA-256 against the release's `SHA256SUMS`, and installs it to `~/.local/bin/taria` without sudo. It prints a hint if that directory isn't on your `PATH`.

- **Choose a version:** `curl -fsSL …/install.sh | TARIA_VERSION=v0.4.0 sh`
- **Choose a directory:** `TARIA_INSTALL_DIR=~/bin`

| Target | Built and tested on | Notes |
| --- | --- | --- |
| macOS, Apple Silicon (`darwin-arm64`) | native GitHub runner (`macos-latest`) | ad-hoc signed, not notarized |
| Linux x64 (`linux-x64`) | native GitHub runner (`ubuntu-24.04`) | glibc 2.28 or newer, libatomic |

On Linux the binary needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 and later) and the `libatomic` library. Desktop systems have it; minimal containers may not (`sudo apt install libatomic1` or `sudo dnf install libatomic`). `install.sh` explains if the binary can't start.

The binary embeds the Node.js runtime, so it is large: about 150 MB on disk and about 48 MB to download. There are no builds for Intel Macs, arm64 Linux, musl (Alpine) or Windows; there, use the npm package below (on Alpine with Alpine's `nodejs`). `install.sh` says so on those platforms. Binaries for Intel Macs and arm64 Linux were published up to 0.3.0.

**macOS Gatekeeper.** The binaries are signed ad hoc but not notarized (that needs a paid Apple Developer ID). Files downloaded with `curl`, as `install.sh` does, are not quarantined, so they run normally. If you downloaded the archive with a browser and macOS refuses to open `taria`, remove the quarantine flag:

```bash
xattr -d com.apple.quarantine ~/.local/bin/taria
```

To install a release archive by hand, download `taria-<os>-<arch>.tar.gz` and `SHA256SUMS` from the release, check the archive with `shasum -a 256 -c SHA256SUMS --ignore-missing`, then unpack it and move `taria` onto your `PATH`. To upgrade, run the install command again. To uninstall, delete the file.

### npm (Node.js 22 or newer)

From a clone:

```bash
git clone https://github.com/Riloative/taria.git
cd taria
npm install -g .
```

Or from a release, without cloning:

```bash
npm install -g https://github.com/Riloative/taria/releases/download/v0.4.0/taria-0.4.0.tgz
```

The repository ships a prebuilt, self-contained bundle in `dist/`, so the global install has no dependencies and needs no compiler.

### Shell completions and the man page

```bash
taria completions bash > ~/.local/share/bash-completion/completions/taria
taria completions zsh > "${fpath[1]}/_taria"
taria completions fish > ~/.config/fish/completions/taria.fish
```

They complete commands, options and option values (`--theme`). The npm package installs the man page (`man taria`); with the standalone binary, `taria man > ~/.local/share/man/man1/taria.1` writes it. `--help`, the completions and the man page are generated from one description of the command line, so they always agree.

### Check the install

`taria --version` shows the version, whether you're running the standalone binary or the npm package, and the Node.js runtime. `taria doctor` checks your environment and shows the install method and location:

```bash
taria doctor
```

## Quick start

```bash
taria
```

The first time you run it, taria looks for API keys in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, …) and probes the usual local ports for llama.cpp (8080 and 9931), Ollama (11434) and LM Studio (1234). Pick one, choose a default model, and you're chatting. The setup writes a commented config file you can edit later.

Some things to try:

- Type `/` to see commands, `/model` to switch models (even mid-conversation).
- Press `Esc` to stop a reply; the partial answer is kept.
- Keep typing while a reply streams; `Enter` queues your next message.
- `Esc` `Esc` on an empty prompt to edit an earlier message and branch from there.
- Quit with `Ctrl+D` and come back with `taria -c` (continue) or `taria -r` (pick a conversation).

## Setting up providers

Every model is addressed as `provider/model-id`, where `provider` is a name you choose in the config file. You can define as many providers as you like — for example two local servers. You can add providers interactively with `/providers`, or edit `~/.config/taria/config.yaml`. Model names are never hard-coded: taria fetches each provider's model list at runtime (cached briefly), and you can always type any model id by hand in `/model`.

### Anthropic

```yaml
providers:
  anthropic:
    type: anthropic
default_model: anthropic/claude-opus-5-5
```

Uses the Messages API through the official SDK, with streaming, adaptive thinking (reasoning summaries shown dimmed, collapsed to "Thought for Ns"), reasoning effort, image input and prompt caching on the conversation prefix. Context size and capabilities come from the Models API. Key: `ANTHROPIC_API_KEY`, or `taria key set anthropic`.

### OpenAI

```yaml
providers:
  openai:
    type: openai
# default_model: openai/<model-id>   (pick one with /model)
```

Uses the Responses API (OpenAI's recommended endpoint for new work), with reasoning summaries and reasoning effort for reasoning models, and image input. OpenAI's model list doesn't report context sizes, so set `context_window` per model if you want a percentage in the status line (see [models](#per-model-settings)). Key: `OPENAI_API_KEY`.

### Mistral

```yaml
providers:
  mistral:
    type: openai-compatible
    base_url: https://api.mistral.ai/v1
    api_key_env: MISTRAL_API_KEY
```

Mistral's reasoning ("thinking" content chunks), vision flags and context sizes are read from the API.

### llama.cpp (`llama-server`)

```bash
llama-server -m qwen3-30b-q4_k_m.gguf --port 8080 --jinja --reasoning-format deepseek
```

```yaml
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:8080/v1
default_model: local/qwen3-30b-q4_k_m.gguf
```

No key is needed for local addresses. The context size is read from the server's `/props`; reasoning arrives as `reasoning_content` (or inside `<think>` tags, which taria also understands). Newer llama.cpp builds default to port 9931 — use whichever your server prints.

### Ollama

```yaml
providers:
  ollama:
    type: openai-compatible
    base_url: http://localhost:11434/v1
default_model: ollama/llama3.2-vision
```

Vision and thinking support and the loaded context size come from Ollama's `/api/show` and `/api/ps`.

### LM Studio

```yaml
providers:
  lmstudio:
    type: openai-compatible
    base_url: http://localhost:1234/v1
```

Start the server from LM Studio's Developer tab (or `lms server start`). Capabilities and context length come from `/api/v1/models`.

### OpenRouter, Groq and others

```yaml
providers:
  openrouter:
    type: openai-compatible
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    headers:
      X-Title: taria
  groq:
    type: openai-compatible
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY
```

The `openai-compatible` adapter is deliberately tolerant: it copes with missing usage data, several reasoning field names, servers without a model list, and servers that reject optional fields (it retries without them and remembers).

### Two local servers

```yaml
providers:
  big:
    type: openai-compatible
    base_url: http://gpu-box.local:8080/v1
    context_window: 65536
  small:
    type: openai-compatible
    base_url: http://localhost:8081/v1
```

### Per-model settings

Sampling settings are sent only when you set them. Model settings override provider settings.

```yaml
providers:
  local:
    type: openai-compatible
    base_url: http://localhost:8080/v1
    sampling:
      temperature: 0.7
      max_tokens: 4096
    models:
      qwen3-30b:
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 }
        context_window: 40960   # if the server doesn't report it
        images: false           # override detected capabilities
        reasoning: true
```

Note: current Anthropic API versions reject `temperature`, `top_p` and `top_k`; leave them unset for Anthropic models.

## API keys

Keys are looked up in this order, and never written to the config file, a transcript, a log or an error message:

1. **Environment variable** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, or the variable named by `api_key_env`. For other providers the default is `<NAME>_API_KEY`.
2. **OS keychain** — macOS Keychain, or the Secret Service (GNOME Keyring/KWallet via `secret-tool`) on Linux.
3. **Credentials file** — `~/.config/taria/credentials`, mode 0600, for headless and SSH machines without a keychain.

```bash
taria key set anthropic        # prompts without echo; stores in the keychain (or the file)
taria key status anthropic     # shows which store is in use
taria key remove anthropic
```

`/providers` inside taria shows where each provider's key comes from and checks connectivity live.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send. While a reply is streaming, queue the message (shown dimmed) to send when it ends |
| `Shift+Enter`, `Alt/Option+Enter`, `Ctrl+J`, `\` then `Enter` | New line (the hint line shows the one that works in your terminal) |
| `Esc` | Interrupt the reply (partial text is kept); when idle, clear the input |
| `Esc` `Esc` | Rewind: pick an earlier message of yours, edit it, and branch from there |
| `↑` / `↓` | Input history when the cursor is on the first/last line. With messages queued, `↑` edits the newest one where it is (`↑`/`↓` move between them, Enter saves, Ctrl+C puts it back as it was, saving it empty removes it). Nothing in the queue is sent while one is being edited |
| `Ctrl+_` or `Ctrl+Z`, `Alt+Z` | Undo and redo in the input box (typing is undone a word at a time). `Ctrl+Shift+Z` also redoes where the terminal reports it |
| `Ctrl+R` | Search input history (`Ctrl+R` again for older matches, `Tab`/`Esc` to accept, `Enter` to accept and send) |
| `Ctrl+C` | Interrupt or clear input; press twice on an empty prompt to exit |
| `Ctrl+D` | Exit (on an empty prompt); otherwise delete forward |
| `Ctrl+L` | Clear the screen, keep the conversation |
| `Shift+Tab` | Cycle reasoning effort (for models that support it) |
| `Ctrl+O` | Expand or collapse reasoning |
| `Ctrl+V` | Paste an image from the clipboard |
| `Ctrl+G` | Edit the input in `$VISUAL`/`$EDITOR` |
| `@` | Attach a text file or image from the current directory (fuzzy picker) |
| `Tab` | Complete a `/command` or `@file`; on an empty input at 80% context or more, run `/compact` |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+B` / `Ctrl+F`, `Alt+B` / `Alt+F`, `Ctrl+←/→` | Move by character / word |
| `Ctrl+W`, `Alt+Backspace` | Delete the previous word |
| `Ctrl+K` / `Ctrl+U` | Delete to end / start of line |
| `Ctrl+Y` | Paste the last deleted text |
| `Alt+D` | Delete the next word |

Large pastes collapse to `[Pasted text #1 +42 lines]` and are expanded when sent. Dragging files into the terminal attaches them.

## Slash commands

| Command | Description |
| --- | --- |
| `/model [provider/id]` | Pick a model (grouped by provider, fuzzy search, recent first), or switch directly |
| `/new`, `/clear` | Start a fresh conversation |
| `/resume` | Pick a past conversation: title, model, time, message count; searches all message text |
| `/rewind` | Same as `Esc` `Esc` |
| `/branches` | Switch between the branches that rewinding and retrying create (a `⑂ branch 2 of 3` line marks each branch point) |
| `/find <text>` | Search this conversation; Enter shows the chosen message again |
| `/history` | Show or hide the early part of a very long conversation (beyond 240 messages, only the newest 200 are printed) |
| `/retry [provider/id]` | Regenerate the last response, optionally with another model (a new branch) |
| `/system [text \| clear]` | View or set this conversation's system prompt |
| `/persona [name]` | Use a saved system prompt from the config |
| `/compact [instructions]` | Summarise the conversation so far to free context |
| `/copy`, `/copy code`, `/copy code 2` | Copy the last response, its last code block, or the block with that number (code blocks are labelled `python · 2`) |
| `/export [file.md]` | Write the conversation to Markdown |
| `/rename [title]`, `/delete` | Rename, or delete (asks first; moved to the trash directory) |
| `/cost` | Tokens and estimated cost for this session, per model |
| `/config` | Settings screen (edits the config file in place, keeping comments) |
| `/providers` | Providers with a live connectivity check; add or remove one |
| `/theme` | Dark, light, ANSI-16 or auto |
| `/terminal-setup [vscode\|tmux]` | Make Shift+Enter insert a new line in VS Code (and forks) and tmux: shows the settings, and writes them only if you confirm. With `vscode` or `tmux` it shows and offers that one even when taria is running somewhere else |
| `/help`, `/exit` | |

### Custom commands

Any Markdown file in `~/.config/taria/commands/` becomes a command. `$ARGUMENTS` is replaced with whatever follows the command; without it, the arguments are appended.

```markdown
---
description: Explain a concept to a beginner
argument-hint: <topic>
---
Explain $ARGUMENTS to a curious beginner, with one concrete example.
```

Saved as `explain.md`, this is used as `/explain recursion`.

## Configuration file

Editors that understand JSON Schema (VS Code with the YAML extension, Neovim with yaml-language-server, JetBrains IDEs) check and complete the file when its first line is

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Riloative/taria/main/schema/config.schema.json
```

New config files start with that line. The schema is [`schema/config.schema.json`](schema/config.schema.json); a test keeps it in step with what taria accepts.

`~/.config/taria/config.yaml` (honours `XDG_CONFIG_HOME`). Mistakes are reported with the line number and a plain explanation, and the rest of the file still loads.

```yaml
default_model: anthropic/claude-opus-5-5
title_model: local/qwen3-4b          # cheap model for conversation titles (optional)
compact_model: anthropic/claude-haiku-5-5   # model for /compact (default: current)
theme: auto                          # auto | dark | light | ansi
bell: true                           # bell when a reply took longer than…
bell_after_seconds: 10
notifications: auto                  # auto | off | osc9 | osc777 | osc99: desktop notification when a long reply finishes and the terminal is not focused
terminal_title: true                 # show the conversation title in the terminal title
name: Sam                            # "Welcome back, Sam!" on the start screen (no name: "Welcome back!")
welcome_recent: true                 # false: the start screen does not list your latest conversations (e.g. when sharing your screen)
soft_line_breaks: keep               # keep | join: a single newline inside a paragraph stays a line break, or joins the lines
reduced_motion: false                # true: a still spinner instead of an animated one
clipboard: auto                      # auto | native | osc52 | off: how /copy reaches the clipboard
# clipboard_command: wl-copy -p       # a program (and arguments) that takes the text on stdin, tried first; not run by a shell
check_for_updates: false             # true: once a day, ask GitHub for the latest release and mention a newer one (nothing is downloaded)
system_prompt: "You are concise."    # default for new conversations
reasoning_effort: medium             # default effort where supported

providers:
  anthropic:
    type: anthropic                  # anthropic | openai | openai-compatible | mock
  local:
    type: openai-compatible
    base_url: http://localhost:8080/v1
    api_key_env: LOCAL_KEY           # optional
    headers: { X-Team: research }    # optional; use "env:VAR" for secret values
    context_window: 32768
    timeout_ms: 600000
    sampling: { temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 4096, extra_body: { min_p: 0.05 } }
    models:
      some-model: { context_window: 8192, images: true, reasoning: false, sampling: { temperature: 0.2 } }

personas:
  terse: "Answer in one or two sentences."
  reviewer:
    prompt: "You are a meticulous reviewer."
    model: anthropic/claude-opus-5-5

prices:                              # USD per million tokens, for /cost
  anthropic/claude-opus-5-5: { input: 4, output: 20, cache_read: 0.2 }
  local/*: { input: 0, output: 0 }
```

`theme: auto` asks the terminal for its background colour at start-up (OSC 11), and otherwise uses `COLORFGBG`, then assumes a dark background. The question never delays start-up: an answer that arrives after the first frame applies to everything drawn after it, and a terminal that doesn't answer gets the fallback, so set `light` explicitly if detection misses. `NO_COLOR` turns colour off everywhere.

## Non-interactive use

```bash
taria -p "what is 2^20?"
cat notes.md | taria -p "summarise in three bullets"
git diff | taria -p -m local/qwen3 -s "You are a code reviewer" "review this"
taria -p --json "hello" | jq .text
taria -c -p "and in French?"       # continue the most recent conversation
```

| Option | |
| --- | --- |
| `-p, --print` | Print the answer and exit (streams as it goes) |
| `-m, --model provider/id` | Model |
| `-s, --system text` | System prompt |
| `-c, --continue` | Continue the most recent conversation |
| `-r, --resume [id]` | Resume a conversation (picker without an id) |
| `--json` | One JSON object: text, reasoning, usage, stop reason, conversation id |
| `--theme name`, `--no-color` | Appearance |
| `--debug [file]` | Log requests, responses and timings, keys redacted |
| `taria doctor` | Check terminal, clipboard, keychain and each provider |
| `taria doctor merge` | Copy conversations that are only in parley's old data folder into taria's |

When stdout isn't a terminal there is no colour and no spinner. Failures exit non-zero with the error on stderr (2 for usage errors, 130 when interrupted).

## Files and directories

| Path | Contents |
| --- | --- |
| `~/.config/taria/config.yaml` | Configuration |
| `~/.config/taria/credentials` | Keys for machines without a keychain (0600) |
| `~/.config/taria/commands/*.md` | Custom commands |
| `~/.local/share/taria/conversations/*.jsonl` | One append-only file per conversation |
| `~/.local/share/taria/attachments/` | Attached images, by content hash |
| `~/.local/share/taria/history.jsonl` | Input history, shared by all instances |
| `~/.local/share/taria/trash/` | Deleted conversations |
| `~/.local/state/taria/logs/` | `--debug` logs |

All honour the `XDG_*` variables (the same layout is used on macOS). Conversations are written event by event — the user message as soon as you send it, and streamed text every fraction of a second — so a crash or a closed terminal loses at most the last moment of a reply, which is recovered and marked as interrupted. Rewinding and regenerating add branches; nothing is ever deleted. Several taria windows can run at once: each conversation file is locked by the instance that has it open.

## Troubleshooting

**Shift+Enter inserts nothing / sends the message.** Your terminal doesn't report Shift+Enter distinctly. `Ctrl+J`, `Alt+Enter` and `\` then `Enter` always work, and the hint line shows which one to use. Shift+Enter works natively in kitty, WezTerm, Ghostty, iTerm2 and recent Alacritty. In VS Code and its forks, and in tmux, run `/terminal-setup`: it shows the keybinding (Shift+Enter sends `\u001b\r` when `terminalFocus`) and the tmux lines (`set -s extended-keys on`), and adds them to the right file if you confirm. In Terminal.app, enable *Use Option as Meta key* for Option+Enter.

**"Nothing is listening at http://localhost:8080".** The local server isn't running, or it's on another port (newer llama.cpp uses 9931). Fix `base_url` and check with `taria doctor`.

**The first reply from a local model takes a long time.** The spinner says *Waiting for the first token* while the model loads; taria never times out during a load.

**"No API key found".** Set the environment variable, or `taria key set <provider>`. `taria key status <provider>` shows what was found.

**`/copy` copies nothing.** Run `taria doctor clipboard`: it says which method `/copy` uses, copies a test line and, where a paste tool exists, reads it back. taria reports *Copied … via wl-copy* only when a tool confirmed the copy; *Sent … (OSC 52)* means the text was handed to the terminal, which never confirms it.
- **Linux desktop:** install `wl-clipboard` (Wayland) or `xclip` (X11). Without them, taria would fall back to OSC 52, which VTE-based terminals (GNOME Terminal, Ptyxis, Tilix, Terminator) ignore, so there it says nothing was copied and offers to write the text to a file instead.
- **WSL:** `clip.exe` is used (the text is sent as UTF-16, so accents and symbols survive).
- **SSH:** OSC 52 to the terminal on your own machine. Windows Terminal, iTerm2, kitty, WezTerm, Ghostty, foot and Alacritty accept it; some need it enabled (iTerm2: *Applications in terminal may access clipboard*). Texts over about 73 KB are not sent, because terminals drop larger ones silently.
- **tmux:** the text goes into tmux's paste buffer (`prefix ]`) with `load-buffer -w`, which also passes it to the terminal unless `set-clipboard` is `off`.
- `clipboard: native | osc52 | off` and `clipboard_command:` (a command that reads the text on stdin, such as `wl-copy -p`) override the choice. For image paste on Linux you still need `wl-clipboard` or `xclip`.
- `clipboard_command` is **not run by a shell**: it is a program and its arguments. Single or double quotes group a word that contains spaces (`"/opt/my tools/copy" --flag`), and a word that starts with `~/` gets your home directory. Nothing else is expanded: no `$VAR`, no backslash before a space, no `|`, `;` or `>`; for those, put the commands in a script and name the script. A quote that is never closed, or an empty first word, is reported as a config error and the setting is ignored. If the command fails, `/copy` goes on to the next method and names the command and the reason; a tool gets 5 seconds, then it is stopped.

**Odd characters or boxes instead of glyphs.** Use a UTF-8 locale (`export LANG=en_US.UTF-8`) and a font with box-drawing characters.

**Colours look wrong.** Try `/theme` (light, or ANSI to use only your terminal's palette). taria uses truecolour when `COLORTERM=truecolor` is set.

**Config errors at start-up.** They are printed with the file and line; fix them or run `taria doctor`.

**Something else.** Run with `--debug` and look at the log (keys are redacted).

## Development

```bash
npm install
npm run build      # bundle src/ into dist/ (commit dist/ with your change)
npm run dev        # build and run
npm run check      # type-check, lint and all tests
```

See [CLAUDE.md](CLAUDE.md) for the architecture and conventions. The mock provider (`mock/echo`, `mock/markdown`, `mock/long?lines=500&tps=4000`, `mock/reasoning`, `mock/slow-first?delay=5000`, `mock/retry?failures=2`, `mock/error?kind=auth`, `mock/disconnect?after=40`, …) is always available and is what the test suite uses, so tests need no network or keys.
