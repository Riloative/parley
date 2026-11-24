import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
import{c as i,d as a,e as o,f as c}from"./chunk-B55T77Z6.js";import"./chunk-SGJ7RKDV.js";var l=[...new Set(i.map(e=>e.usage.split(" ")[0]))],$=e=>!!e.arg&&!e.optionalArg;function h(){let e=a.flatMap(s=>[`--${s.long}`,...s.short?[`-${s.short}`]:[]]).join(" "),n=a.filter(s=>s.values).map(s=>`    --${s.long}) COMPREPLY=($(compgen -W "${s.values.join(" ")}" -- "$cur")); return ;;`).join(`
`),t=a.filter($).flatMap(s=>[`--${s.long}`,...s.short?[`-${s.short}`]:[]]).join("|");return`# bash completion for taria. Install:
#   taria completions bash > ~/.local/share/bash-completion/completions/taria
_taria() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${n}
    ${t}) return ;;
  esac
  if [ "$COMP_CWORD" -ge 2 ]; then
    case "\${COMP_WORDS[1]}" in
      doctor) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "${c.join(" ")}" -- "$cur")); return ;;
      key) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "${o.join(" ")}" -- "$cur")); return ;;
      completions) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return ;;
    esac
  fi
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${e}" -- "$cur"))
  elif [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${l.join(" ")}" -- "$cur"))
  fi
}
complete -F _taria taria
complete -F _taria parley
`}var p=e=>e.replace(/[[\]:']/g,n=>n==="'"?"'\\''":`\\${n}`);function u(){let e=a.map(t=>{let s=t.short?`{-${t.short},--${t.long}}`:`--${t.long}`,f=t.values?`:${t.arg}:(${t.values.join(" ")})`:t.file?`::${t.arg}:_files`:t.arg?`${t.optionalArg?"::":":"}${t.arg}:`:"";return`    '${t.short?`(-${t.short} --${t.long})`:""}'${s}'[${p(t.help)}]${f}'`}).join(` \\
`),n=l.map(t=>`'${t}:${p(i.find(s=>s.usage.startsWith(t)).help)}'`).join(" ");return`#compdef taria parley
# zsh completion for taria. Install: put this file in a directory on $fpath
# as _taria, e.g.  taria completions zsh > "\${fpath[1]}/_taria"
_taria() {
  local state
  _arguments -C \\
${e} \\
    '1: :->first' \\
    '*:: :->rest'
  case $state in
    first) _describe 'command' "(${n})" ;;
    rest)
      case $words[1] in
        doctor) _values 'topic' ${c.join(" ")} ;;
        key) (( CURRENT == 2 )) && _values 'action' ${o.join(" ")} ;;
        completions) _values 'shell' bash zsh fish ;;
      esac ;;
  esac
}
_taria "$@"
`}var r=e=>`'${e.replace(/\\/g,"\\\\").replace(/'/g,"\\'")}'`;function m(){let e=["# fish completion for taria. Install:","#   taria completions fish > ~/.config/fish/completions/taria.fish","complete -c taria -f"],n="__fish_use_subcommand";for(let t of l)e.push(`complete -c taria -n ${n} -a ${t} -d ${r(i.find(s=>s.usage.startsWith(t)).help)}`);e.push(`complete -c taria -n '__fish_seen_subcommand_from doctor' -a ${r(c.join(" "))}`),e.push(`complete -c taria -n '__fish_seen_subcommand_from key' -a ${r(o.join(" "))}`),e.push("complete -c taria -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'");for(let t of a){let s=["complete -c taria",...t.short?[`-s ${t.short}`]:[],`-l ${t.long}`];t.values?s.push(`-x -a ${r(t.values.join(" "))}`):t.file?s.push("-F"):$(t)&&s.push("-x"),s.push(`-d ${r(t.help)}`),e.push(s.join(" "))}return e.push("complete -c parley -w taria"),e.join(`
`)+`
`}function g(e){if(e==="bash")return h();if(e==="zsh")return u();if(e==="fish")return m()}export{g as completionScript};
