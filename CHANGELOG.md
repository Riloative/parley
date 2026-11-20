# Changelog

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
