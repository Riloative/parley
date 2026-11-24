// Entry point. Kept deliberately tiny: argument parsing, --help and
// --version run without loading React, Ink, providers or the highlighter.

import { adoptLegacyEnv, legacyEnvNotice, renameNotices } from './brand.js';
import { legacyDirsPresent } from './config/paths.js';
import { mark } from './trace.js';
import { startEarlyProbe } from './term/probe.js';

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

const HELP = `taria — a terminal chat client for Claude, OpenAI, Mistral and local models

Usage
  taria [options] [prompt]          start an interactive chat
  taria -p "question" [options]     print the answer and exit
  cat notes.md | taria -p "summarise"
  taria doctor                      check terminal, clipboard, keychain and providers
  taria doctor clipboard            try a copy the way /copy does it
  taria doctor repair                repair conversations a crash in parley < 0.2.0 cut short
  taria key set <provider>          store an API key in the keychain
  taria key remove <provider>       remove a stored key
  taria key status <provider>       show where the key for a provider comes from

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

Config:  $XDG_CONFIG_HOME/taria/config.yaml (default ~/.config/taria/config.yaml)
Data:    $XDG_DATA_HOME/taria (default ~/.local/share/taria)
Inside taria, type /help for commands and keys.
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
          if (arg.startsWith('-') && arg !== '-') return { error: `Unknown option ${arg}. Run taria --help.` };
          positional.push(arg);
      }
    } catch (e) {
      return { error: `${(e as Error).message}. Run taria --help.` };
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
    process.stderr.write(`taria: ${parsed.error}\n`);
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
  const oldEnv = legacyEnvNotice();
  if (oldEnv) renameNotices.push(oldEnv);
  // doctor only reports; everything else moves parley's files first.
  if (args.command !== 'doctor' && legacyDirsPresent()) {
    const { migrateFromParley, migrationNotices } = await import('./config/migrate.js');
    renameNotices.push(...migrationNotices(migrateFromParley()));
  }
  if (args.debug) {
    const { enableDebug } = await import('./debug.js');
    const f = enableDebug(args.debugFile);
    process.stderr.write(`taria: writing debug log to ${f}\n`);
  }
  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    process.exitCode = await runDoctor(args.rest);
    return;
  }
  if (args.command !== undefined || args.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    // Never on stdout: in -p mode that is the answer.
    for (const n of renameNotices.splice(0)) process.stderr.write(`taria: ${n}\n`);
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
  // Ask the terminal for its background now, while the interface loads.
  const probe = startEarlyProbe();
  const { runInteractive } = await import('./interactive.js');
  mark('interactive-loaded');
  await runInteractive(args, probe);
}

// PARLEY_* variables keep working as TARIA_*: adopted before anything reads them.
adoptLegacyEnv();

main().catch((e: Error) => {
  process.stderr.write(`taria: ${e?.stack ?? e}\n`);
  process.exit(1);
});
