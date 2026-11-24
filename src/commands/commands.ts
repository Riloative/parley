// Slash commands. Built-ins operate through the UiApi the App provides;
// custom commands are Markdown prompt templates from the config directory.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  SHIFT_ENTER_BINDING,
  TMUX_LINES,
  addShiftEnterBinding,
  addTmuxLines,
  readIfExists,
  tmuxConfFile,
  vscodeKeybindingFiles,
  writeConfigFile,
  type EditResult,
} from '../term/setup.js';
import type { Session, Tone } from '../core/session.js';
import type { Config } from '../config/config.js';
import { paths } from '../config/paths.js';
import { costOf, formatTokens, priceFor } from '../core/usage.js';
import type { StoredMessage } from '../core/conversation.js';
import { parseModelRef } from '../providers/types.js';
import { codeBlockTexts, mdCode, mdTable } from '../render/markdown.js';

export interface UiApi {
  session: Session;
  config: Config;
  notice(text: string, tone?: Tone): void;
  info(markdown: string): void;
  openModelPicker(opts?: { onPick?: (model: string) => void; title?: string }): void;
  openResumePicker(): void;
  openRewindPicker(): void;
  openBranchPicker(): void;
  /** Search the current conversation; with no query, ask for one. */
  openFind(query: string): void;
  /** Show or hide the early part of a very long conversation. */
  toggleHistory(): void;
  openConfig(): void;
  openProviders(): void;
  openThemePicker(): void;
  openPersonaPicker(): void;
  prompt(opts: { title: string; description?: string; initial?: string; mask?: boolean; placeholder?: string; onSubmit: (v: string) => void }): void;
  /** Ask yes/no; "no" is the default. onNo also runs on Esc. */
  confirm(question: string, onYes: () => void, onNo?: () => void): void;
  /** Whether the terminal speaks the kitty keyboard protocol (Shift+Enter works). */
  keyboard(): { kitty: boolean };
  setInput(text: string): void;
  submitPrompt(text: string): void;
  copy(text: string, what: string): void;
  clearScreen(): void;
  exit(): void;
  commands(): CommandDef[];
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  argHint?: string;
  /** Runs immediately on Enter from the menu (no arguments expected). */
  noArgs?: boolean;
  run(ui: UiApi, args: string): void | Promise<void>;
  custom?: boolean;
}

function terminalSetup(ui: UiApi, target = ''): void {
  if (target && target !== 'vscode' && target !== 'tmux') return ui.notice('Usage: /terminal-setup, /terminal-setup vscode or /terminal-setup tmux', 'warning');
  const env = process.env;
  const home = homedir();
  const kitty = ui.keyboard().kitty;
  const editors = vscodeKeybindingFiles(env, process.platform, home);
  const tmuxFile = tmuxConfFile(env, home);
  const shortTmux = tmuxFile.startsWith(home) ? `~${tmuxFile.slice(home.length)}` : tmuxFile;
  const vscodeText = [
    '**VS Code, Cursor and other forks:** add this to keybindings.json (Command Palette → *Preferences: Open Keyboard Shortcuts (JSON)*). It makes Shift+Enter send what Alt+Enter sends.',
    '',
    '```json',
    JSON.stringify(SHIFT_ENTER_BINDING, null, 2),
    '```',
  ];
  const tmuxText = [
    `**tmux:** if Shift+Enter still sends the message inside tmux (3.2 or later), add these lines to \`${shortTmux}\`, then run \`tmux source-file ${shortTmux}\`.`,
    '',
    '```',
    ...TMUX_LINES,
    '```',
  ];
  if (target) {
    // Settings for a terminal taria is not necessarily running in: show
    // them, then offer to write each file (never without asking).
    ui.info((target === 'vscode' ? vscodeText : tmuxText).join('\n'));
    const wanted: Array<{ question: string; apply: () => void }> = [];
    if (target === 'vscode') {
      if (!editors.length) ui.notice('No VS Code, Cursor or other fork settings folder was found on this machine, so there is nothing to write. Add the snippet by hand where the editor runs.', 'dim');
      for (const e of editors) {
        wanted.push({
          question: `Add the Shift+Enter keybinding to ${e.name} (${e.file})?`,
          apply: () => applyEdit(ui, e.file, addShiftEnterBinding(readIfExists(e.file)), `${e.name} now sends a new line for Shift+Enter in its terminal.`),
        });
      }
    } else {
      wanted.push({
        question: `Add extended-keys to ${shortTmux}?`,
        apply: () => applyEdit(ui, tmuxFile, addTmuxLines(readIfExists(tmuxFile)), `Run \`tmux source-file ${shortTmux}\` (or restart tmux) to apply it.`),
      });
    }
    return askEach(ui, wanted);
  }
  ui.info(
    [
      kitty
        ? '**Shift+Enter** already inserts a new line in this terminal (kitty keyboard protocol).'
        : '**Shift+Enter** may arrive as a plain Enter in this terminal. Alt+Enter, Ctrl+J and `\\` then Enter always insert a new line.',
      '',
      ...vscodeText,
      '',
      ...tmuxText,
    ].join('\n'),
  );

  // Offer to write only the files for the terminal taria is running in,
  // one question at a time; "no" (the default) moves on.
  const offers: Array<{ question: string; apply: () => void }> = [];
  if (env.TERM_PROGRAM === 'vscode' && !kitty) {
    for (const e of editors) {
      offers.push({
        question: `Add the Shift+Enter keybinding to ${e.name} (${e.file})?`,
        apply: () => applyEdit(ui, e.file, addShiftEnterBinding(readIfExists(e.file)), `${e.name} now sends a new line for Shift+Enter in its terminal.`),
      });
    }
  }
  if (env.TMUX) {
    offers.push({
      question: `Add extended-keys to ${shortTmux} (only needed if Shift+Enter sends the message in tmux)?`,
      apply: () => applyEdit(ui, tmuxFile, addTmuxLines(readIfExists(tmuxFile)), `Run \`tmux source-file ${shortTmux}\` (or restart tmux) to apply it.`),
    });
  }
  askEach(ui, offers);
}

/** One question at a time; "no" (the default) moves on to the next. */
function askEach(ui: UiApi, offers: Array<{ question: string; apply: () => void }>): void {
  const ask = (i: number): void => {
    const o = offers[i];
    if (!o) return;
    ui.confirm(
      o.question,
      () => {
        o.apply();
        ask(i + 1);
      },
      () => ask(i + 1),
    );
  };
  ask(0);
}

function applyEdit(ui: UiApi, file: string, r: EditResult, done: string): void {
  if (!r.ok) return ui.notice(`Did not change ${file}: ${r.reason}. Add the snippet above by hand.`, 'warning');
  if (!r.changed) return ui.notice(`${file} already has this setting.`, 'dim');
  try {
    mkdirSync(dirname(file), { recursive: true });
    const { backup } = writeConfigFile(file, r.text);
    ui.notice(`Updated ${file}${backup ? ` (previous version: ${backup})` : ''}. ${done}`, 'success');
  } catch (e) {
    ui.notice(`Could not write ${file}: ${(e as Error).message}`, 'error');
  }
}

function lastAssistant(session: Session): StoredMessage | undefined {
  return [...session.conv.path()].reverse().find((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'text'));
}

function textOf(m: StoredMessage): string {
  return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** Code blocks of a response, numbered as the transcript shows them. */
export function codeBlocks(md: string): string[] {
  return codeBlockTexts(md);
}

export function exportMarkdown(session: Session): string {
  const c = session.conv;
  const lines: string[] = [`# ${c.title ?? 'Conversation'}`, ''];
  lines.push(`_Exported from taria on ${new Date().toLocaleString()}_`, '');
  if (c.systemPrompt) lines.push('**System prompt:**', '', '> ' + c.systemPrompt.split('\n').join('\n> '), '');
  for (const m of c.path()) {
    if (m.role === 'user') {
      lines.push('## You', '', m.display ?? textOf(m), '');
      for (const p of m.content) if (p.type === 'file') lines.push(`<details><summary>${p.name}</summary>\n\n\`\`\`\n${p.text}\n\`\`\`\n\n</details>`, '');
    } else if (m.role === 'summary') {
      lines.push('## Summary of earlier conversation', '', textOf(m), '');
    } else {
      lines.push(`## ${m.model ?? 'Assistant'}`, '', textOf(m), '');
      if (m.interrupted) lines.push('_(interrupted)_', '');
      if (m.error) lines.push(`_Error: ${m.error}_`, '');
    }
  }
  return lines.join('\n');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conversation';
}

export const HELP_KEYS: Array<[string, string]> = [
  ['Enter', 'Send (queues while a reply is streaming)'],
  ['Shift+Enter, Alt+Enter, Ctrl+J, \\ then Enter', 'New line'],
  ['Esc', 'Interrupt the reply; when idle, clear the input'],
  ['Esc Esc', 'Rewind: edit an earlier message and branch from it'],
  ['↑ / ↓', 'Input history (on the first/last line); ↑ edits a queued message in place'],
  ['Ctrl+_ or Ctrl+Z, Alt+Z', 'Undo, redo in the input box'],
  ['Ctrl+R', 'Search input history'],
  ['Ctrl+C', 'Clear input; press twice to exit'],
  ['Ctrl+D', 'Exit (on empty input)'],
  ['Ctrl+L', 'Clear the screen'],
  ['Shift+Tab', 'Cycle reasoning effort'],
  ['Ctrl+O', 'Expand or collapse reasoning'],
  ['Ctrl+V', 'Paste an image from the clipboard'],
  ['Ctrl+G', 'Edit the input in $EDITOR'],
  ['@', 'Attach a file'],
  ['Ctrl+A/E/W/K/U/Y, Alt+B/F/D', 'Readline editing'],
];

export function builtinCommands(): CommandDef[] {
  return [
    {
      name: 'model',
      description: 'Switch model (picker, or /model provider/id)',
      argHint: '[provider/model]',
      run(ui, args) {
        const ref = args.trim();
        if (!ref) return ui.openModelPicker();
        if (!parseModelRef(ref)) return ui.notice(`"${ref}" is not a model reference. Use provider/model-id, e.g. anthropic/claude-opus-5-5.`, 'error');
        if (!ui.session.registry.has(parseModelRef(ref)!.provider)) return ui.notice(`Unknown provider "${parseModelRef(ref)!.provider}". See /providers.`, 'error');
        ui.session.setModel(ref);
        ui.notice(`Model set to ${ref}`, 'success');
      },
    },
    {
      name: 'new',
      aliases: ['clear'],
      description: 'Start a fresh conversation',
      noArgs: true,
      run(ui) {
        ui.session.newConversation();
      },
    },
    {
      name: 'resume',
      description: 'Resume a past conversation (searchable)',
      noArgs: true,
      run(ui) {
        ui.openResumePicker();
      },
    },
    {
      name: 'rewind',
      description: 'Edit an earlier message and branch from there',
      noArgs: true,
      run(ui) {
        ui.openRewindPicker();
      },
    },
    {
      name: 'branches',
      description: 'Switch between branches made by rewinding or retrying',
      noArgs: true,
      run(ui) {
        ui.openBranchPicker();
      },
    },
    {
      name: 'find',
      description: 'Search this conversation',
      argHint: '<text>',
      run(ui, args) {
        ui.openFind(args.trim());
      },
    },
    {
      name: 'history',
      description: 'Show or hide the early messages of a very long conversation',
      noArgs: true,
      run(ui) {
        ui.toggleHistory();
      },
    },
    {
      name: 'retry',
      description: 'Regenerate the last response, optionally with another model',
      argHint: '[provider/model]',
      run(ui, args) {
        const ref = args.trim() || undefined;
        if (ref && !parseModelRef(ref)) return ui.notice(`"${ref}" is not a model reference (provider/model-id).`, 'error');
        void ui.session.retry(ref);
      },
    },
    {
      name: 'system',
      description: 'View or set the system prompt for this conversation',
      argHint: '[prompt | clear]',
      run(ui, args) {
        const a = args.trim();
        if (!a) {
          const cur = ui.session.conv.systemPrompt;
          if (cur) ui.info(`**System prompt:**\n\n> ${cur.split('\n').join('\n> ')}\n\nChange it with \`/system <text>\`, remove it with \`/system clear\`.`);
          else ui.notice('No system prompt is set. Set one with /system <text>, or pick a saved one with /persona.');
          return;
        }
        if (a === 'clear' || a === 'none' || a === 'off') {
          ui.session.setSystemPrompt(null);
          ui.notice('System prompt removed.', 'success');
          return;
        }
        ui.session.setSystemPrompt(a);
        ui.notice('System prompt set for this conversation.', 'success');
      },
    },
    {
      name: 'persona',
      description: 'Use a saved system prompt from the config',
      argHint: '[name]',
      run(ui, args) {
        const name = args.trim();
        if (!name) return ui.openPersonaPicker();
        const p = ui.config.personas[name];
        if (!p) return ui.notice(`No persona named "${name}". Personas live under "personas" in the config file.`, 'error');
        ui.session.setSystemPrompt(p.prompt);
        if (p.model) ui.session.setModel(p.model);
        ui.notice(`Persona "${name}" active.`, 'success');
      },
    },
    {
      name: 'compact',
      description: 'Summarise the conversation to free context',
      argHint: '[what to keep]',
      run(ui, args) {
        void ui.session.compact(args.trim() || undefined);
      },
    },
    {
      name: 'copy',
      description: 'Copy the last response (/copy code for its last code block, /copy code 2 for the second)',
      argHint: '[code [n]]',
      run(ui, args) {
        const m = lastAssistant(ui.session);
        if (!m) return ui.notice('There is no response to copy yet.');
        const text = textOf(m);
        const code = /^code(?:\s+(\S+))?$/.exec(args.trim());
        if (code) {
          const blocks = codeBlocks(text);
          if (!blocks.length) return ui.notice('The last response has no code block.');
          const n = code[1] === undefined ? blocks.length : Number(code[1]);
          if (!Number.isInteger(n) || n < 1 || n > blocks.length) {
            return ui.notice(`The last response has ${blocks.length} code block${blocks.length === 1 ? '' : 's'}; use /copy code ${blocks.length === 1 ? '1' : `1 to ${blocks.length}`}.`);
          }
          return ui.copy(blocks[n - 1]!, code[1] === undefined ? 'the last code block' : `code block ${n} of ${blocks.length}`);
        }
        ui.copy(text, 'the last response');
      },
    },
    {
      name: 'export',
      description: 'Write the conversation to a Markdown file',
      argHint: '[file.md]',
      run(ui, args) {
        if (!ui.session.conv.messageCount) return ui.notice('Nothing to export yet.');
        const name = args.trim() || `${slug(ui.session.conv.title ?? 'conversation')}-${new Date().toISOString().slice(0, 10)}.md`;
        const file = resolve(name.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
        try {
          writeFileSync(file, exportMarkdown(ui.session), { flag: 'w' });
          ui.notice(`Exported to ${file}`, 'success');
        } catch (e) {
          ui.notice(`Could not write ${file}: ${(e as Error).message}`, 'error');
        }
      },
    },
    {
      name: 'rename',
      description: 'Rename this conversation',
      argHint: '<title>',
      run(ui, args) {
        const t = args.trim();
        if (!ui.session.conv.messageCount) return ui.notice('Send a message first; empty conversations are not saved.');
        if (t) {
          ui.session.rename(t);
          return ui.notice(`Renamed to "${t}".`, 'success');
        }
        ui.prompt({
          title: 'Rename conversation',
          initial: ui.session.conv.title ?? '',
          onSubmit: (v) => {
            if (v) {
              ui.session.rename(v);
              ui.notice(`Renamed to "${v}".`, 'success');
            }
          },
        });
      },
    },
    {
      name: 'delete',
      description: 'Delete this conversation (asks first)',
      noArgs: true,
      run(ui) {
        if (!ui.session.file) return ui.notice('This conversation has not been saved, so there is nothing to delete.');
        ui.confirm(`Delete "${ui.session.conv.title ?? 'this conversation'}"? It is moved to ${join(paths.dataDir, 'trash')}.`, () => {
          ui.session.deleteCurrent();
          ui.notice('Conversation deleted.', 'success');
        });
      },
    },
    {
      name: 'cost',
      description: 'Tokens and estimated cost for this session',
      noArgs: true,
      run(ui) {
        const rows = [...ui.session.costs.byModel.entries()];
        if (!rows.length) return ui.notice('No requests in this session yet.');
        let total = 0;
        let anyPrice = false;
        const table: string[][] = [];
        for (const [model, u] of rows) {
          const c = costOf(u, priceFor(ui.config.prices, model));
          if (c !== undefined) {
            total += c;
            anyPrice = true;
          }
          table.push([model, String(u.requests), `${formatTokens(u.inputTokens)}${u.estimated ? '~' : ''}`, formatTokens(u.outputTokens), formatTokens(u.cacheReadTokens), c === undefined ? '—' : `$${c.toFixed(4)}`]);
        }
        let md = mdTable(['Model', 'Requests', 'Input', 'Output', 'Cache read', 'Cost'], table, ['left', 'right', 'right', 'right', 'right', 'right']);
        if (anyPrice) md += `\n\n**Estimated total: $${total.toFixed(4)}**`;
        else md += '\n\nNo prices are configured, so cost is not estimated. Add a `prices` table to the config file.';
        if (rows.some(([, u]) => u.estimated)) md += '\n\n~ marks estimates for providers that do not report usage.';
        ui.info(md);
      },
    },
    {
      name: 'config',
      aliases: ['settings'],
      description: 'Settings',
      noArgs: true,
      run(ui) {
        ui.openConfig();
      },
    },
    {
      name: 'providers',
      description: 'Check, add or remove providers',
      noArgs: true,
      run(ui) {
        ui.openProviders();
      },
    },
    {
      name: 'terminal-setup',
      description: 'Make Shift+Enter insert a new line in VS Code and tmux',
      argHint: '[vscode|tmux]',
      run(ui, args) {
        terminalSetup(ui, args.trim().toLowerCase());
      },
    },
    {
      name: 'theme',
      description: 'Change the colour theme',
      argHint: '[dark|light|ansi|auto]',
      run(ui) {
        ui.openThemePicker();
      },
    },
    {
      name: 'help',
      description: 'Commands and keyboard shortcuts',
      noArgs: true,
      run(ui) {
        const cmds = ui.commands().map((c) => [`/${c.name}${c.argHint ? ` ${c.argHint}` : ''}`, `${c.description}${c.aliases?.length ? ` (also /${c.aliases.join(', /')})` : ''}`]);
        ui.info(
          `**Commands**\n\n${mdTable(['Command', 'Description'], cmds)}\n\n**Keys**\n\n${mdTable(['Key', 'Action'], HELP_KEYS)}\n\nConfig: ${mdCode(paths.configFile)} · Custom commands: ${mdCode(`${paths.commandsDir}/*.md`)}`,
        );
      },
    },
    {
      name: 'exit',
      aliases: ['quit'],
      description: 'Exit taria',
      noArgs: true,
      run(ui) {
        ui.exit();
      },
    },
  ];
}

/** Custom commands: commands/<name>.md, optional YAML-ish front matter with
 * `description:`. `$ARGUMENTS` is replaced with everything after the name;
 * if absent, arguments are appended. */
export function loadCustomCommands(dir = paths.commandsDir): CommandDef[] {
  if (!existsSync(dir)) return [];
  const out: CommandDef[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  for (const f of files) {
    const name = f.slice(0, -3).replace(/\s+/g, '-');
    if (!/^[\w.:-]+$/.test(name)) continue;
    let body: string;
    try {
      body = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    let description = '';
    let argHint: string | undefined;
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
    if (fm) {
      body = body.slice(fm[0].length);
      for (const line of fm[1]!.split('\n')) {
        const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
        if (m?.[1] === 'description') description = m[2]!.replace(/^["']|["']$/g, '');
        if (m?.[1] === 'argument-hint') argHint = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
    if (!description) description = body.trim().split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 70);
    const template = body;
    out.push({
      name,
      description: description || '(custom command)',
      argHint,
      custom: true,
      run(ui, args) {
        ui.submitPrompt(expandTemplate(template, args));
      },
    });
  }
  return out;
}

export function expandTemplate(template: string, args: string): string {
  const a = args.trim();
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(a).trim();
  return a ? `${template.trim()}\n\n${a}` : template.trim();
}

export function allCommands(): CommandDef[] {
  const builtins = builtinCommands();
  const names = new Set(builtins.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  return [...builtins, ...loadCustomCommands().filter((c) => !names.has(c.name))];
}

export function findCommand(cmds: CommandDef[], name: string): CommandDef | undefined {
  return cmds.find((c) => c.name === name || c.aliases?.includes(name));
}

export type { Tone };
