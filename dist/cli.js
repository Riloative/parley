import { createRequire as __parleyCreateRequire } from 'node:module'; const require = __parleyCreateRequire(import.meta.url);
import{a as m,b as u,c as d}from"./chunk-TKNT4BIY.js";import{a as p}from"./chunk-HMWX45IS.js";import{b as l}from"./chunk-WLKREDWK.js";import"./chunk-URYMO42N.js";var h=`parley \u2014 a terminal chat client for Claude, OpenAI, Mistral and local models

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
`;function f(t){let e={print:!1,continue:!1,resume:!1,json:!1,debug:!1,noColor:!1,rest:[]},a=[];for(let s=0;s<t.length;s++){let r=t[s],i=()=>{let o=t[s+1];if(!(o===void 0||o.startsWith("-")&&o!=="-"))return s++,o},n=o=>{let c=i();if(c===void 0)throw new Error(`${o} needs a value`);return c};try{if(r==="--"){a.push(...t.slice(s+1));break}if(r.startsWith("--")&&r.includes("=")){let[o,...c]=r.split("=");t.splice(s+1,0,c.join("=")),t[s]=o,s--;continue}switch(r){case"-p":case"--print":e.print=!0;break;case"-m":case"--model":e.model=n(r);break;case"-s":case"--system":e.system=n(r);break;case"-c":case"--continue":e.continue=!0;break;case"-r":case"--resume":e.resume=!0,e.resumeId=i();break;case"--json":e.json=!0;break;case"--debug":e.debug=!0,e.debugFile=i();break;case"--no-color":e.noColor=!0;break;case"--theme":e.theme=n(r);break;case"-h":case"--help":e.command="help";break;case"-v":case"--version":e.command="version";break;default:if(r.startsWith("-")&&r!=="-")return{error:`Unknown option ${r}. Run parley --help.`};a.push(r)}}catch(o){return{error:`${o.message}. Run parley --help.`}}}return!e.command&&(a[0]==="doctor"||a[0]==="key")?(e.command=a[0],e.rest=a.slice(1)):a.length&&(e.prompt=a.join(" ")),e}async function y(){p("cli");let t=f(process.argv.slice(2));"error"in t&&(process.stderr.write(`parley: ${t.error}
`),process.exit(2));let e=t;if(e.command==="help"){process.stdout.write(h);return}if(e.command==="version"){process.stdout.write(`${d()}
`);return}if(e.noColor&&(process.env.NO_COLOR="1"),e.debug){let{enableDebug:n}=await import("./debug-35PLF4CG.js"),o=n(e.debugFile);process.stderr.write(`parley: writing debug log to ${o}
`)}if(e.command==="doctor"){let{runDoctor:n}=await import("./doctor-T4AE33MJ.js");process.exitCode=await n();return}if(e.command==="key"){let{runKeyCommand:n}=await import("./keycmd-PC2GIIFF.js");process.exitCode=await n(e.rest);return}let a=!!process.stdin.isTTY,s=!!process.stdout.isTTY;if(e.print||!a||!s){let{runPrint:n}=await import("./print-CL3RHGOQ.js");process.exitCode=await n(e);return}let r=l(),{runInteractive:i}=await import("./interactive-BKUJTXX7.js");p("interactive-loaded"),await i(e,r)}y().catch(t=>{process.stderr.write(`parley: ${t?.stack??t}
`),process.exit(1)});export{u as BUILD_KIND,m as VERSION,f as parseArgs,d as versionLine};
