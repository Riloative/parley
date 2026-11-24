// Entry point. Kept deliberately tiny: argument parsing, --help and
// --version run without loading React, Ink, providers or the highlighter.

import { helpText } from './cliSpec.js';
import { parseArgs } from './args.js';
export type { Args } from './args.js';
import { adoptLegacyEnv, legacyEnvNotice, renameNotices } from './brand.js';
import { legacyDirsPresent } from './config/paths.js';
import { mark } from './trace.js';
import { startEarlyProbe } from './term/probe.js';

import { BUILD_KIND, VERSION, versionLine } from './version.js';

export { BUILD_KIND, VERSION, versionLine };


const HELP = helpText();


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
  if (args.command === 'completions') {
    const { completionScript } = await import('./completions.js');
    const script = completionScript(args.rest[0] ?? '');
    if (!script) {
      process.stderr.write('Usage: taria completions bash|zsh|fish\n');
      process.exit(2);
    }
    process.stdout.write(script);
    return;
  }
  if (args.command === 'man') {
    // Used by the build to write dist/taria.1 (no date, so the build is reproducible).
    const { manPage } = await import('./manpage.js');
    process.stdout.write(manPage(VERSION, ''));
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
