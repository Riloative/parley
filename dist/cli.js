import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
import{a as m}from"./chunk-T6E7CJ2B.js";import{b as f}from"./chunk-QDY3HYY4.js";import{a as g,b,c as h}from"./chunk-WVQUU5EB.js";import{d,e as p,f as l,j as u}from"./chunk-A5CHC2K6.js";import"./chunk-SGJ7RKDV.js";var y=`taria \u2014 a terminal chat client for Claude, OpenAI, Mistral and local models

Usage
  taria [options] [prompt]          start an interactive chat
  taria -p "question" [options]     print the answer and exit
  cat notes.md | taria -p "summarise"
  taria doctor                      check terminal, clipboard, keychain and providers
  taria doctor clipboard            try a copy the way /copy does it
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
`;function k(o){let e={print:!1,continue:!1,resume:!1,json:!1,debug:!1,noColor:!1,rest:[]},s=[];for(let n=0;n<o.length;n++){let t=o[n],a=()=>{let r=o[n+1];if(!(r===void 0||r.startsWith("-")&&r!=="-"))return n++,r},c=r=>{let i=a();if(i===void 0)throw new Error(`${r} needs a value`);return i};try{if(t==="--"){s.push(...o.slice(n+1));break}if(t.startsWith("--")&&t.includes("=")){let[r,...i]=t.split("=");o.splice(n+1,0,i.join("=")),o[n]=r,n--;continue}switch(t){case"-p":case"--print":e.print=!0;break;case"-m":case"--model":e.model=c(t);break;case"-s":case"--system":e.system=c(t);break;case"-c":case"--continue":e.continue=!0;break;case"-r":case"--resume":e.resume=!0,e.resumeId=a();break;case"--json":e.json=!0;break;case"--debug":e.debug=!0,e.debugFile=a();break;case"--no-color":e.noColor=!0;break;case"--theme":e.theme=c(t);break;case"-h":case"--help":e.command="help";break;case"-v":case"--version":e.command="version";break;default:if(t.startsWith("-")&&t!=="-")return{error:`Unknown option ${t}. Run taria --help.`};s.push(t)}}catch(r){return{error:`${r.message}. Run taria --help.`}}}return!e.command&&(s[0]==="doctor"||s[0]==="key")?(e.command=s[0],e.rest=s.slice(1)):s.length&&(e.prompt=s.join(" ")),e}async function w(){m("cli");let o=k(process.argv.slice(2));"error"in o&&(process.stderr.write(`taria: ${o.error}
`),process.exit(2));let e=o;if(e.command==="help"){process.stdout.write(y);return}if(e.command==="version"){process.stdout.write(`${h()}
`);return}e.noColor&&(process.env.NO_COLOR="1");let s=l();if(s&&d.push(s),e.command!=="doctor"&&u()){let{migrateFromParley:r,migrationNotices:i}=await import("./migrate-MHHTWGY4.js");d.push(...i(r()))}if(e.debug){let{enableDebug:r}=await import("./debug-Q2OCKHIS.js"),i=r(e.debugFile);process.stderr.write(`taria: writing debug log to ${i}
`)}if(e.command==="doctor"){let{runDoctor:r}=await import("./doctor-GFIYQNMR.js");process.exitCode=await r(e.rest);return}if(e.command!==void 0||e.print||!process.stdin.isTTY||!process.stdout.isTTY)for(let r of d.splice(0))process.stderr.write(`taria: ${r}
`);if(e.command==="key"){let{runKeyCommand:r}=await import("./keycmd-N3WHPTT4.js");process.exitCode=await r(e.rest);return}let n=!!process.stdin.isTTY,t=!!process.stdout.isTTY;if(e.print||!n||!t){let{runPrint:r}=await import("./print-3CBAZYAB.js");process.exitCode=await r(e);return}let a=f(),{runInteractive:c}=await import("./interactive-2VEFTK33.js");m("interactive-loaded"),await c(e,a)}p();w().catch(o=>{process.stderr.write(`taria: ${o?.stack??o}
`),process.exit(1)});export{b as BUILD_KIND,g as VERSION,k as parseArgs,h as versionLine};
