// Entry point. Kept deliberately tiny: argument parsing, --help and
// --version run without loading React, Ink, providers or the highlighter.

import { mark } from './trace.js';

import { BUILD_KIND, VERSION, versionLine } from './version.js';

export { BUILD_KIND, VERSION, versionLine };

export interface Args {
  print: boolean;
  prompt?: string;
  model?: string;
  system?: string;
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  json: boolean;
  debug: boolean;
  debugFile?: string;
  noColor: boolean;
  theme?: string;
  command?: 'doctor' | 'key' | 'help' | 'version';
  rest: string[];
}

const HELP = `parley — a terminal chat client for Claude, OpenAI, Mistral and local models

Usage
  parley [options] [prompt]          start an interactive chat
  parley -p "question" [options]     print the answer and exit
  cat notes.md | parley -p "summarise"
  parley doctor                      check terminal, clipboard, keychain and providers
  parley key set <provider>          store an API key in the keychain
  parley key remove <provider>       remove a stored key
  parley key status <provider>       show where the key for a provider comes from

Options
  -p, --print            non-interactive: stream the answer to stdout and exit
  -m, --model <ref>      model as provider/model-id
  -s, --system <text>    system prompt
  -c, --continue         continue the most recent conversation
  -r, --resume [id]      resume a conversation (opens a picker without an id)
      --json             with -p: print one JSON object instead of text
      --theme <name>     dark, light, ansi or auto
      --no-color         disable colour (NO_COLOR is honoured too)
      --debug [file]     log requests, responses and timings (keys redacted)
  -h, --help             show this help
  -v, --version          show the version

Config:  $XDG_CONFIG_HOME/parley/config.yaml (default ~/.config/parley/config.yaml)
Data:    $XDG_DATA_HOME/parley (default ~/.local/share/parley)
Inside parley, type /help for commands and keys.
`;

export function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = { print: false, continue: false, resume: false, json: false, debug: false, noColor: false, rest: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && v !== '-')) return undefined;
      i++;
      return v;
    };
    const need = (name: string) => {
      const v = next();
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    try {
      if (arg === '--') {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (arg.startsWith('--') && arg.includes('=')) {
        const [k, ...v] = arg.split('=');
        argv.splice(i + 1, 0, v.join('='));
        argv[i] = k!;
        i--;
        continue;
      }
      switch (arg) {
        case '-p':
        case '--print':
          a.print = true;
          break;
        case '-m':
        case '--model':
          a.model = need(arg);
          break;
        case '-s':
        case '--system':
          a.system = need(arg);
          break;
        case '-c':
        case '--continue':
          a.continue = true;
          break;
        case '-r':
        case '--resume':
          a.resume = true;
          a.resumeId = next();
          break;
        case '--json':
          a.json = true;
          break;
        case '--debug':
          a.debug = true;
          a.debugFile = next();
          break;
        case '--no-color':
          a.noColor = true;
          break;
        case '--theme':
          a.theme = need(arg);
          break;
        case '-h':
        case '--help':
          a.command = 'help';
          break;
        case '-v':
        case '--version':
          a.command = 'version';
          break;
        default:
          if (arg.startsWith('-') && arg !== '-') return { error: `Unknown option ${arg}. Run parley --help.` };
          positional.push(arg);
      }
    } catch (e) {
      return { error: `${(e as Error).message}. Run parley --help.` };
    }
  }
  if (!a.command && (positional[0] === 'doctor' || positional[0] === 'key')) {
    a.command = positional[0];
    a.rest = positional.slice(1);
  } else if (positional.length) {
    a.prompt = positional.join(' ');
  }
  return a;
}

async function main(): Promise<void> {
  mark('cli');
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`parley: ${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed;
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === 'version') {
    process.stdout.write(`${versionLine()}\n`);
    return;
  }
  if (args.noColor) process.env.NO_COLOR = '1';
  if (args.debug) {
    const { enableDebug } = await import('./debug.js');
    const f = enableDebug(args.debugFile);
    process.stderr.write(`parley: writing debug log to ${f}\n`);
  }
  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    process.exitCode = await runDoctor();
    return;
  }
  if (args.command === 'key') {
    const { runKeyCommand } = await import('./keycmd.js');
    process.exitCode = await runKeyCommand(args.rest);
    return;
  }
  const stdinIsTty = !!process.stdin.isTTY;
  const stdoutIsTty = !!process.stdout.isTTY;
  if (args.print || !stdinIsTty || !stdoutIsTty) {
    const { runPrint } = await import('./print.js');
    process.exitCode = await runPrint(args);
    return;
  }
  const { runInteractive } = await import('./interactive.js');
  mark('interactive-loaded');
  await runInteractive(args);
}

main().catch((e: Error) => {
  process.stderr.write(`parley: ${e?.stack ?? e}\n`);
  process.exit(1);
});
