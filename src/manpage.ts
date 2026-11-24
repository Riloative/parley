// The man page, generated from the command-line description in cliSpec.ts.
// The build writes it to dist/taria.1; package.json's "man" installs it with
// the npm package.

import { COMMANDS, FILES, OPTIONS, SUMMARY, USAGE } from './cliSpec.js';

/** roff text: backslashes, leading dots and quotes made literal. */
const r = (s: string) => s.replace(/\\/g, '\\e').replace(/-/g, '\\-').replace(/^\./gm, '\\&.').replace(/^'/gm, "\\&'");

export function manPage(version: string, date: string): string {
  const out: string[] = [
    `.TH TARIA 1 "${date}" "taria ${version}" "User Commands"`,
    '.SH NAME',
    `taria \\- ${r(SUMMARY)}`,
    '.SH SYNOPSIS',
    ...USAGE.flatMap((u) => ['.B taria', r(u.usage), '.br']),
    ...COMMANDS.flatMap((c) => ['.B taria', r(c.usage), '.br']),
    '.SH DESCRIPTION',
    'taria streams answers from Claude, OpenAI, Mistral and local models (llama.cpp, Ollama, LM Studio, or any server that speaks the OpenAI chat\\-completions protocol) in the terminal. Every conversation is written to disk as it happens. Inside taria, type',
    '.B /help',
    'for commands and keys.',
    '.SH OPTIONS',
  ];
  for (const o of OPTIONS) {
    const arg = o.arg ? (o.optionalArg ? ` [\\fI${o.arg}\\fR]` : ` \\fI${o.arg}\\fR`) : '';
    out.push('.TP', `${o.short ? `\\fB\\-${o.short}\\fR, ` : ''}\\fB\\-\\-${r(o.long)}\\fR${arg}`, r(o.help.charAt(0).toUpperCase() + o.help.slice(1)) + '.');
  }
  out.push('.SH COMMANDS');
  for (const c of COMMANDS) out.push('.TP', `\\fBtaria ${r(c.usage)}\\fR`, r(c.help.charAt(0).toUpperCase() + c.help.slice(1)) + '.');
  out.push('.SH FILES');
  for (const f of FILES) out.push('.TP', `\\fI${r(f.path)}\\fR`, `${r(f.help.charAt(0).toUpperCase() + f.help.slice(1))} (default \\fI${r(f.fallback)}\\fR).`);
  out.push(
    '.SH ENVIRONMENT',
    '.TP',
    '\\fBANTHROPIC_API_KEY\\fR, \\fBOPENAI_API_KEY\\fR, ...',
    'API keys, read before the keychain and the credentials file.',
    '.TP',
    '\\fBNO_COLOR\\fR',
    'Disable colour.',
    '.TP',
    '\\fBTARIA_NO_KEYCHAIN\\fR',
    'Do not use the system keychain.',
    '.TP',
    '\\fBPARLEY_*\\fR',
    'Names from before the rename from parley; each works as the matching \\fBTARIA_*\\fR until 0.4.0.',
    '.SH EXIT STATUS',
    '0 on success, 1 on an error, 2 for a usage error, 130 when interrupted.',
    '.SH SEE ALSO',
    'https://github.com/Riloative/taria',
    '',
  );
  return out.join('\n');
}
