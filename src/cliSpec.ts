// The command line, described once. `--help`, the shell completions
// (`taria completions <shell>`) and the man page are all generated from this,
// so they cannot disagree. `parseArgs` in cli.ts is the code that reads it;
// test/unit/cli-spec.test.ts checks that every option here is accepted there.

export interface OptionSpec {
  short?: string;
  long: string;
  /** Placeholder for the option's value; in brackets when it is optional. */
  arg?: string;
  optionalArg?: boolean;
  help: string;
  /** Fixed values, for completion. */
  values?: string[];
  /** Complete the value as a file name. */
  file?: boolean;
}

export interface CommandSpec {
  /** As typed, e.g. "doctor clipboard" or "key set <provider>". */
  usage: string;
  help: string;
}

export const SUMMARY = 'a terminal chat client for Claude, OpenAI, Mistral and local models';

export const USAGE: CommandSpec[] = [
  { usage: '[options] [prompt]', help: 'start an interactive chat' },
  { usage: '-p "question" [options]', help: 'print the answer and exit' },
];

export const COMMANDS: CommandSpec[] = [
  { usage: 'doctor', help: 'check terminal, clipboard, keychain and providers' },
  { usage: 'doctor clipboard', help: 'try a copy the way /copy does it' },
  { usage: 'doctor repair', help: 'repair conversations a crash in parley < 0.2.0 cut short' },
  { usage: 'doctor merge', help: "copy conversations that are only in parley's old folder" },
  { usage: 'key set <provider>', help: 'store an API key in the keychain' },
  { usage: 'key remove <provider>', help: 'remove a stored key' },
  { usage: 'key status <provider>', help: 'show where the key for a provider comes from' },
  { usage: 'key remove-old <provider>', help: "remove parley's old keychain entry for a provider" },
  { usage: 'completions <bash|zsh|fish>', help: 'print a shell completion script' },
  { usage: 'man', help: 'print the man page (installed with the npm package)' },
];

export const OPTIONS: OptionSpec[] = [
  { short: 'p', long: 'print', help: 'non-interactive: stream the answer to stdout and exit' },
  { short: 'm', long: 'model', arg: 'ref', help: 'model as provider/model-id' },
  { short: 's', long: 'system', arg: 'text', help: 'system prompt' },
  { short: 'c', long: 'continue', help: 'continue the most recent conversation' },
  { short: 'r', long: 'resume', arg: 'id', optionalArg: true, help: 'resume a conversation (opens a picker without an id)' },
  { long: 'json', help: 'with -p: print one JSON object instead of text' },
  { long: 'search', help: "let the model search the web with its provider's search (costs extra)" },
  { long: 'no-search', help: 'no web search, whatever the config says' },
  { long: 'sources', help: 'with -p: list the web sources after the answer' },
  { long: 'theme', arg: 'name', help: 'dark, light, ansi or auto', values: ['dark', 'light', 'ansi', 'auto'] },
  { long: 'no-color', help: 'disable colour (NO_COLOR is honoured too)' },
  { long: 'debug', arg: 'file', optionalArg: true, file: true, help: 'log requests, responses and timings (keys redacted)' },
  { short: 'h', long: 'help', help: 'show this help' },
  { short: 'v', long: 'version', help: 'show the version' },
];

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export const KEY_ACTIONS = ['set', 'remove', 'status', 'remove-old'];
export const DOCTOR_TOPICS = ['clipboard', 'repair', 'merge'];

export const FILES = [
  { path: '$XDG_CONFIG_HOME/taria/config.yaml', fallback: '~/.config/taria/config.yaml', help: 'configuration' },
  { path: '$XDG_DATA_HOME/taria', fallback: '~/.local/share/taria', help: 'conversations, input history, attachments' },
];

export function optionLabel(o: OptionSpec): string {
  const arg = o.arg ? (o.optionalArg ? ` [${o.arg}]` : ` <${o.arg}>`) : '';
  return `${o.short ? `-${o.short}, ` : '    '}--${o.long}${arg}`;
}

/** The text `taria --help` prints. */
export function helpText(name = 'taria'): string {
  const usage = [...USAGE.map((u) => [`${name} ${u.usage}`, u.help]), [`cat notes.md | ${name} -p "summarise"`, ''], ...COMMANDS.map((c) => [`${name} ${c.usage}`, c.help])];
  const uw = Math.max(...usage.filter(([, h]) => h).map(([u]) => u!.length)) + 2;
  const ow = Math.max(...OPTIONS.map((o) => optionLabel(o).length)) + 2;
  return [
    `${name} — ${SUMMARY}`,
    '',
    'Usage',
    ...usage.map(([u, h]) => (h ? `  ${u!.padEnd(uw)}${h}` : `  ${u}`)),
    '',
    'Options',
    ...OPTIONS.map((o) => `  ${optionLabel(o).padEnd(ow)}${o.help}`),
    '',
    `Config:  ${FILES[0]!.path} (default ${FILES[0]!.fallback})`,
    `Data:    ${FILES[1]!.path} (default ${FILES[1]!.fallback})`,
    `Inside ${name}, type /help for commands and keys.`,
    '',
  ].join('\n');
}
