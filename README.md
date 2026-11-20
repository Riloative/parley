# parley

A terminal chat client for Claude, OpenAI, Mistral and local models (llama.cpp, Ollama, LM Studio) — and anything else that speaks the OpenAI chat-completions protocol.

parley looks and behaves like a terminal coding assistant, but it only converses: no file editing, no shell, no agent loop. It streams without flicker, writes every conversation to disk as it happens, and never makes you reach for the mouse.

```
╭──────────────────────────────────────────────────────────────────────╮
│ ◆ Welcome to parley                                                  │
│                                                                      │
│   model: local/qwen3-30b                                             │
│   /help for commands · /model to switch · esc to interrupt           │
╰──────────────────────────────────────────────────────────────────────╯

> what's the difference between a mutex and a semaphore?

● A mutex is a lock with an owner: …
  1.8s · 412 tokens · 231 tok/s

╭──────────────────────────────────────────────────────────────────────╮
│ > Send a message                                                     │
╰──────────────────────────────────────────────────────────────────────╯
 / for commands · @ to attach · \⏎ for newline   local/qwen3-30b · 4% context
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

### Standalone binary (no Node.js needed)

```bash
curl -fsSL https://raw.githubusercontent.com/Riloative/parley/main/install.sh | sh
```

The script picks the build for your OS and CPU, downloads it from the latest [release](https://github.com/Riloative/parley/releases), verifies its SHA-256 against the release's `SHA256SUMS`, and installs it to `~/.local/bin/parley` without sudo. It prints a hint if that directory isn't on your `PATH`.

- **Choose a version:** `curl -fsSL …/install.sh | PARLEY_VERSION=v0.1.0 sh`
- **Choose a directory:** `PARLEY_INSTALL_DIR=~/bin`

| Target | Built and tested on | Notes |
| --- | --- | --- |
| macOS, Apple Silicon (`darwin-arm64`) | native GitHub runner (`macos-latest`) | ad-hoc signed, not notarized |
| macOS, Intel (`darwin-x64`) | native GitHub runner (`macos-15-intel`) | ad-hoc signed, not notarized |
| Linux x64 (`linux-x64`) | native GitHub runner (`ubuntu-24.04`) | glibc 2.28 or newer, libatomic |
| Linux arm64 (`linux-arm64`) | native GitHub runner (`ubuntu-24.04-arm`) | glibc 2.28 or newer, libatomic |

On Linux the binary needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 and later) and the `libatomic` library. Desktop systems have it; minimal containers may not (`sudo apt install libatomic1` or `sudo dnf install libatomic`). `install.sh` explains if the binary can't start.

The binary embeds the Node.js runtime, so it is large: about 150 MB on disk and about 48 MB to download. There are no musl (Alpine) or Windows builds; on Alpine use the npm package below with Alpine's `nodejs`.

**macOS Gatekeeper.** The binaries are signed ad hoc but not notarized (that needs a paid Apple Developer ID). Files downloaded with `curl`, as `install.sh` does, are not quarantined, so they run normally. If you downloaded the archive with a browser and macOS refuses to open `parley`, remove the quarantine flag:

```bash
xattr -d com.apple.quarantine ~/.local/bin/parley
```

To install a release archive by hand, download `parley-<os>-<arch>.tar.gz` and `SHA256SUMS` from the release, check the archive with `shasum -a 256 -c SHA256SUMS --ignore-missing`, then unpack it and move `parley` onto your `PATH`. To upgrade, run the install command again. To uninstall, delete the file.

### npm (Node.js 22 or newer)

From a clone:

```bash
git clone https://github.com/Riloative/parley.git
cd parley
npm install -g .
```

Or from a release, without cloning:

```bash
npm install -g https://github.com/Riloative/parley/releases/download/v0.1.0/parley-0.1.0.tgz
```

The repository ships a prebuilt, self-contained bundle in `dist/`, so the global install has no dependencies and needs no compiler.

### Check the install

`parley --version` shows the version, whether you're running the standalone binary or the npm package, and the Node.js runtime. `parley doctor` checks your environment and shows the install method and location:

```bash
parley doctor
```

## Quick start

```bash
parley
```

The first time you run it, parley looks for API keys in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, …) and probes the usual local ports for llama.cpp (8080 and 9931), Ollama (11434) and LM Studio (1234). Pick one, choose a default model, and you're chatting. The setup writes a commented config file you can edit later.

Some things to try:

- Type `/` to see commands, `/model` to switch models (even mid-conversation).
- Press `Esc` to stop a reply; the partial answer is kept.
- Keep typing while a reply streams; `Enter` queues your next message.
- `Esc` `Esc` on an empty prompt to edit an earlier message and branch from there.
- Quit with `Ctrl+D` and come back with `parley -c` (continue) or `parley -r` (pick a conversation).

## Setting up providers

Every model is addressed as `provider/model-id`, where `provider` is a name you choose in the config file. You can define as many providers as you like — for example two local servers. You can add providers interactively with `/providers`, or edit `~/.config/parley/config.yaml`. Model names are never hard-coded: parley fetches each provider's model list at runtime (cached briefly), and you can always type any model id by hand in `/model`.

### Anthropic

```yaml
providers:
  anthropic:
    type: anthropic
default_model: anthropic/claude-opus-5-5
```

Uses the Messages API through the official SDK, with streaming, adaptive thinking (reasoning summaries shown dimmed, collapsed to "Thought for Ns"), reasoning effort, image input and prompt caching on the conversation prefix. Context size and capabilities come from the Models API. Key: `ANTHROPIC_API_KEY`, or `parley key set anthropic`.

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

No key is needed for local addresses. The context size is read from the server's `/props`; reasoning arrives as `reasoning_content` (or inside `<think>` tags, which parley also understands). Newer llama.cpp builds default to port 9931 — use whichever your server prints.

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
      X-Title: parley
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
3. **Credentials file** — `~/.config/parley/credentials`, mode 0600, for headless and SSH machines without a keychain.

```bash
parley key set anthropic        # prompts without echo; stores in the keychain (or the file)
parley key status anthropic     # shows which store is in use
parley key remove anthropic
```

`/providers` inside parley shows where each provider's key comes from and checks connectivity live.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send. While a reply is streaming, queue the message (shown dimmed) to send when it ends |
| `Shift+Enter`, `Alt/Option+Enter`, `Ctrl+J`, `\` then `Enter` | New line (the hint line shows the one that works in your terminal) |
| `Esc` | Interrupt the reply (partial text is kept); when idle, clear the input |
| `Esc` `Esc` | Rewind: pick an earlier message of yours, edit it, and branch from there |
| `↑` / `↓` | Input history when the cursor is on the first/last line; `↑` also withdraws a queued message |
| `Ctrl+R` | Search input history (`Ctrl+R` again for older matches, `Tab`/`Esc` to accept, `Enter` to accept and send) |
| `Ctrl+C` | Interrupt or clear input; press twice on an empty prompt to exit |
| `Ctrl+D` | Exit (on an empty prompt); otherwise delete forward |
| `Ctrl+L` | Clear the screen, keep the conversation |
| `Shift+Tab` | Cycle reasoning effort (for models that support it) |
| `Ctrl+O` | Expand or collapse reasoning |
| `Ctrl+V` | Paste an image from the clipboard |
| `Ctrl+G` | Edit the input in `$VISUAL`/`$EDITOR` |
| `@` | Attach a text file or image from the current directory (fuzzy picker) |
| `Tab` | Complete a `/command` or `@file` |
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
| `/retry [provider/id]` | Regenerate the last response, optionally with another model (a new branch) |
| `/system [text \| clear]` | View or set this conversation's system prompt |
| `/persona [name]` | Use a saved system prompt from the config |
| `/compact [instructions]` | Summarise the conversation so far to free context |
| `/copy`, `/copy code` | Copy the last response, or its last code block |
| `/export [file.md]` | Write the conversation to Markdown |
| `/rename [title]`, `/delete` | Rename, or delete (asks first; moved to the trash directory) |
| `/cost` | Tokens and estimated cost for this session, per model |
| `/config` | Settings screen (edits the config file in place, keeping comments) |
| `/providers` | Providers with a live connectivity check; add or remove one |
| `/theme` | Dark, light, ANSI-16 or auto |
| `/help`, `/exit` | |

### Custom commands

Any Markdown file in `~/.config/parley/commands/` becomes a command. `$ARGUMENTS` is replaced with whatever follows the command; without it, the arguments are appended.

```markdown
---
description: Explain a concept to a beginner
argument-hint: <topic>
---
Explain $ARGUMENTS to a curious beginner, with one concrete example.
```

Saved as `explain.md`, this is used as `/explain recursion`.

## Configuration file

`~/.config/parley/config.yaml` (honours `XDG_CONFIG_HOME`). Mistakes are reported with the line number and a plain explanation, and the rest of the file still loads.

```yaml
default_model: anthropic/claude-opus-5-5
title_model: local/qwen3-4b          # cheap model for conversation titles (optional)
compact_model: anthropic/claude-haiku-5-5   # model for /compact (default: current)
theme: auto                          # auto | dark | light | ansi
bell: true                           # bell when a reply took longer than…
bell_after_seconds: 10
terminal_title: true                 # show the conversation title in the terminal title
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

`theme: auto` uses `COLORFGBG` when the terminal sets it and otherwise assumes a dark background; set `light` explicitly for light terminals. `NO_COLOR` turns colour off everywhere.

## Non-interactive use

```bash
parley -p "what is 2^20?"
cat notes.md | parley -p "summarise in three bullets"
git diff | parley -p -m local/qwen3 -s "You are a code reviewer" "review this"
parley -p --json "hello" | jq .text
parley -c -p "and in French?"       # continue the most recent conversation
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
| `parley doctor` | Check terminal, clipboard, keychain and each provider |

When stdout isn't a terminal there is no colour and no spinner. Failures exit non-zero with the error on stderr (2 for usage errors, 130 when interrupted).

## Files and directories

| Path | Contents |
| --- | --- |
| `~/.config/parley/config.yaml` | Configuration |
| `~/.config/parley/credentials` | Keys for machines without a keychain (0600) |
| `~/.config/parley/commands/*.md` | Custom commands |
| `~/.local/share/parley/conversations/*.jsonl` | One append-only file per conversation |
| `~/.local/share/parley/attachments/` | Attached images, by content hash |
| `~/.local/share/parley/history.jsonl` | Input history, shared by all instances |
| `~/.local/share/parley/trash/` | Deleted conversations |
| `~/.local/state/parley/logs/` | `--debug` logs |

All honour the `XDG_*` variables (the same layout is used on macOS). Conversations are written event by event — the user message as soon as you send it, and streamed text every fraction of a second — so a crash or a closed terminal loses at most the last moment of a reply, which is recovered and marked as interrupted. Rewinding and regenerating add branches; nothing is ever deleted. Several parley windows can run at once: each conversation file is locked by the instance that has it open.

## Troubleshooting

**Shift+Enter inserts nothing / sends the message.** Your terminal doesn't report Shift+Enter distinctly. `Ctrl+J`, `Alt+Enter` and `\` then `Enter` always work, and the hint line shows which one to use. Shift+Enter works natively in kitty, WezTerm, Ghostty, iTerm2 and recent Alacritty. In VS Code, add a keybinding that sends `\u001b\r` for `shift+enter` when `terminalFocus` (`parley doctor` prints it). In tmux add `set -g extended-keys on` to `~/.tmux.conf`. In Terminal.app, enable *Use Option as Meta key* for Option+Enter.

**"Nothing is listening at http://localhost:8080".** The local server isn't running, or it's on another port (newer llama.cpp uses 9931). Fix `base_url` and check with `parley doctor`.

**The first reply from a local model takes a long time.** The spinner says *Waiting for the first token* while the model loads; parley never times out during a load.

**"No API key found".** Set the environment variable, or `parley key set <provider>`. `parley key status <provider>` shows what was found.

**Copy or image paste doesn't work on Linux.** Install `wl-clipboard` (Wayland) or `xclip` (X11). Over SSH, copying uses OSC 52, which most terminals support (in tmux, `set -g set-clipboard on`); image paste needs a local clipboard, so attach files with `@` instead.

**Odd characters or boxes instead of glyphs.** Use a UTF-8 locale (`export LANG=en_US.UTF-8`) and a font with box-drawing characters.

**Colours look wrong.** Try `/theme` (light, or ANSI to use only your terminal's palette). parley uses truecolour when `COLORTERM=truecolor` is set.

**Config errors at start-up.** They are printed with the file and line; fix them or run `parley doctor`.

**Something else.** Run with `--debug` and look at the log (keys are redacted).

## Development

```bash
npm install
npm run build      # bundle src/ into dist/ (commit dist/ with your change)
npm run dev        # build and run
npm run check      # type-check, lint and all tests
```

See [CLAUDE.md](CLAUDE.md) for the architecture and conventions. The mock provider (`mock/echo`, `mock/markdown`, `mock/long?lines=500&tps=4000`, `mock/reasoning`, `mock/slow-first?delay=5000`, `mock/retry?failures=2`, `mock/error?kind=auth`, `mock/disconnect?after=40`, …) is always available and is what the test suite uses, so tests need no network or keys.
