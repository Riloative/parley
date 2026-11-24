// `taria completions bash|zsh|fish`: completion scripts generated from the
// command-line description in cliSpec.ts.

import { COMMANDS, DOCTOR_TOPICS, KEY_ACTIONS, OPTIONS, type OptionSpec } from './cliSpec.js';

const SUBCOMMANDS = [...new Set(COMMANDS.map((c) => c.usage.split(' ')[0]!))];
const takesValue = (o: OptionSpec) => !!o.arg && !o.optionalArg;

function bash(): string {
  const words = OPTIONS.flatMap((o) => [`--${o.long}`, ...(o.short ? [`-${o.short}`] : [])]).join(' ');
  const valueCases = OPTIONS.filter((o) => o.values)
    .map((o) => `    --${o.long}) COMPREPLY=($(compgen -W "${o.values!.join(' ')}" -- "$cur")); return ;;`)
    .join('\n');
  const needArg = OPTIONS.filter(takesValue)
    .flatMap((o) => [`--${o.long}`, ...(o.short ? [`-${o.short}`] : [])])
    .join('|');
  return `# bash completion for taria. Install:
#   taria completions bash > ~/.local/share/bash-completion/completions/taria
_taria() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${valueCases}
    ${needArg}) return ;;
  esac
  if [ "$COMP_CWORD" -ge 2 ]; then
    case "\${COMP_WORDS[1]}" in
      doctor) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "${DOCTOR_TOPICS.join(' ')}" -- "$cur")); return ;;
      key) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "${KEY_ACTIONS.join(' ')}" -- "$cur")); return ;;
      completions) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return ;;
    esac
  fi
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${words}" -- "$cur"))
  elif [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(' ')}" -- "$cur"))
  fi
}
complete -F _taria taria
complete -F _taria parley
`;
}

const zq = (s: string) => s.replace(/[[\]:']/g, (c) => (c === "'" ? `'\\''` : `\\${c}`));

function zsh(): string {
  const specs = OPTIONS.map((o) => {
    const names = o.short ? `{-${o.short},--${o.long}}` : `--${o.long}`;
    const action = o.values ? `:${o.arg}:(${o.values.join(' ')})` : o.file ? `::${o.arg}:_files` : o.arg ? `${o.optionalArg ? '::' : ':'}${o.arg}:` : '';
    return `    '${o.short ? `(-${o.short} --${o.long})` : ''}'${names}'[${zq(o.help)}]${action}'`;
  }).join(' \\\n');
  const cmds = SUBCOMMANDS.map((c) => `'${c}:${zq(COMMANDS.find((x) => x.usage.startsWith(c))!.help)}'`).join(' ');
  return `#compdef taria parley
# zsh completion for taria. Install: put this file in a directory on $fpath
# as _taria, e.g.  taria completions zsh > "\${fpath[1]}/_taria"
_taria() {
  local state
  _arguments -C \\
${specs} \\
    '1: :->first' \\
    '*:: :->rest'
  case $state in
    first) _describe 'command' "(${cmds})" ;;
    rest)
      case $words[1] in
        doctor) _values 'topic' ${DOCTOR_TOPICS.join(' ')} ;;
        key) (( CURRENT == 2 )) && _values 'action' ${KEY_ACTIONS.join(' ')} ;;
        completions) _values 'shell' bash zsh fish ;;
      esac ;;
  esac
}
_taria "$@"
`;
}

const fq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function fish(): string {
  const lines = ['# fish completion for taria. Install:', '#   taria completions fish > ~/.config/fish/completions/taria.fish', 'complete -c taria -f'];
  const first = '__fish_use_subcommand';
  for (const c of SUBCOMMANDS) lines.push(`complete -c taria -n ${first} -a ${c} -d ${fq(COMMANDS.find((x) => x.usage.startsWith(c))!.help)}`);
  lines.push(`complete -c taria -n '__fish_seen_subcommand_from doctor' -a ${fq(DOCTOR_TOPICS.join(' '))}`);
  lines.push(`complete -c taria -n '__fish_seen_subcommand_from key' -a ${fq(KEY_ACTIONS.join(' '))}`);
  lines.push(`complete -c taria -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'`);
  for (const o of OPTIONS) {
    const parts = ['complete -c taria', ...(o.short ? [`-s ${o.short}`] : []), `-l ${o.long}`];
    if (o.values) parts.push(`-x -a ${fq(o.values.join(' '))}`);
    else if (o.file) parts.push('-F');
    else if (takesValue(o)) parts.push('-x');
    parts.push(`-d ${fq(o.help)}`);
    lines.push(parts.join(' '));
  }
  lines.push('complete -c parley -w taria');
  return lines.join('\n') + '\n';
}

export function completionScript(shell: string): string | undefined {
  if (shell === 'bash') return bash();
  if (shell === 'zsh') return zsh();
  if (shell === 'fish') return fish();
  return undefined;
}
