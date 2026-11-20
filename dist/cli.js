import { createRequire as __parleyCreateRequire } from 'node:module'; const require = __parleyCreateRequire(import.meta.url);
import"./chunk-URYMO42N.js";var p="0.0.1",l=`parley \u2014 a terminal chat client for Claude, OpenAI, Mistral and local models

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
`;function d(t){let e={print:!1,continue:!1,resume:!1,json:!1,debug:!1,noColor:!1,rest:[]},n=[];for(let s=0;s<t.length;s++){let r=t[s],o=()=>{let a=t[s+1];if(!(a===void 0||a.startsWith("-")&&a!=="-"))return s++,a},i=a=>{let c=o();if(c===void 0)throw new Error(`${a} needs a value`);return c};try{if(r==="--"){n.push(...t.slice(s+1));break}if(r.startsWith("--")&&r.includes("=")){let[a,...c]=r.split("=");t.splice(s+1,0,c.join("=")),t[s]=a,s--;continue}switch(r){case"-p":case"--print":e.print=!0;break;case"-m":case"--model":e.model=i(r);break;case"-s":case"--system":e.system=i(r);break;case"-c":case"--continue":e.continue=!0;break;case"-r":case"--resume":e.resume=!0,e.resumeId=o();break;case"--json":e.json=!0;break;case"--debug":e.debug=!0,e.debugFile=o();break;case"--no-color":e.noColor=!0;break;case"--theme":e.theme=i(r);break;case"-h":case"--help":e.command="help";break;case"-v":case"--version":e.command="version";break;default:if(r.startsWith("-")&&r!=="-")return{error:`Unknown option ${r}. Run parley --help.`};n.push(r)}}catch(a){return{error:`${a.message}. Run parley --help.`}}}return!e.command&&(n[0]==="doctor"||n[0]==="key")?(e.command=n[0],e.rest=n.slice(1)):n.length&&(e.prompt=n.join(" ")),e}async function m(){let t=d(process.argv.slice(2));"error"in t&&(process.stderr.write(`parley: ${t.error}
`),process.exit(2));let e=t;if(e.command==="help"){process.stdout.write(l);return}if(e.command==="version"){process.stdout.write(`parley ${p}
`);return}if(e.noColor&&(process.env.NO_COLOR="1"),e.debug){let{enableDebug:o}=await import("./debug-35PLF4CG.js"),i=o(e.debugFile);process.stderr.write(`parley: writing debug log to ${i}
`)}if(e.command==="doctor"){let{runDoctor:o}=await import("./doctor-HUZM2HJY.js");process.exitCode=await o();return}if(e.command==="key"){let{runKeyCommand:o}=await import("./keycmd-J26INFNC.js");process.exitCode=await o(e.rest);return}let n=!!process.stdin.isTTY,s=!!process.stdout.isTTY;if(e.print||!n||!s){let{runPrint:o}=await import("./print-HAP3OJUO.js");process.exitCode=await o(e);return}let{runInteractive:r}=await import("./interactive-LMXIQW5X.js");await r(e)}m().catch(t=>{process.stderr.write(`parley: ${t?.stack??t}
`),process.exit(1)});export{p as VERSION,d as parseArgs};
