import { createRequire as __parleyCreateRequire } from 'node:module'; const require = __parleyCreateRequire(import.meta.url);
import{a as f,b as g,c as u}from"./chunk-TKNT4BIY.js";import{a as p}from"./chunk-HMWX45IS.js";import"./chunk-URYMO42N.js";var h="\x1B]11;?\x1B\\";var b=/\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i,y=/\x1b\[\?[\d;]*c/;function k(r,e,n){let s=t=>parseInt(t,16)/(16**t.length-1),o=t=>t<=.03928?t/12.92:((t+.055)/1.055)**2.4;return .2126*o(s(r))+.7152*o(s(e))+.0722*o(s(n))>.5?"light":"dark"}function m(){let r=process.stdin;if(!r.isTTY||!process.stdout.isTTY)return;try{r.setRawMode(!0)}catch{return}let e="",n,s=!1,o=c=>{e+=String(c);let d=b.exec(e);d&&(n=k(d[1],d[2],d[3]),e=e.slice(0,d.index)+e.slice(d.index+d[0].length));let l=y.exec(e);l&&!s&&(s=!0,e=e.slice(0,l.index)+e.slice(l.index+l[0].length))},a=()=>{try{r.setRawMode(!1)}catch{}},t=c=>{a(),process.kill(process.pid,c)};process.once("exit",a),process.once("SIGTERM",t),process.once("SIGHUP",t),r.setEncoding("utf8"),r.on("data",o),r.resume(),process.stdout.write(h+"\x1B[c");let i=!1;return{background:()=>n,handOver(){i||(i=!0,r.off("data",o),r.pause(),process.off("exit",a),process.off("SIGTERM",t),process.off("SIGHUP",t));let c=e;return e="",{pending:c,da1Outstanding:!s}}}}var x=`parley \u2014 a terminal chat client for Claude, OpenAI, Mistral and local models

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
`;function w(r){let e={print:!1,continue:!1,resume:!1,json:!1,debug:!1,noColor:!1,rest:[]},n=[];for(let s=0;s<r.length;s++){let o=r[s],a=()=>{let i=r[s+1];if(!(i===void 0||i.startsWith("-")&&i!=="-"))return s++,i},t=i=>{let c=a();if(c===void 0)throw new Error(`${i} needs a value`);return c};try{if(o==="--"){n.push(...r.slice(s+1));break}if(o.startsWith("--")&&o.includes("=")){let[i,...c]=o.split("=");r.splice(s+1,0,c.join("=")),r[s]=i,s--;continue}switch(o){case"-p":case"--print":e.print=!0;break;case"-m":case"--model":e.model=t(o);break;case"-s":case"--system":e.system=t(o);break;case"-c":case"--continue":e.continue=!0;break;case"-r":case"--resume":e.resume=!0,e.resumeId=a();break;case"--json":e.json=!0;break;case"--debug":e.debug=!0,e.debugFile=a();break;case"--no-color":e.noColor=!0;break;case"--theme":e.theme=t(o);break;case"-h":case"--help":e.command="help";break;case"-v":case"--version":e.command="version";break;default:if(o.startsWith("-")&&o!=="-")return{error:`Unknown option ${o}. Run parley --help.`};n.push(o)}}catch(i){return{error:`${i.message}. Run parley --help.`}}}return!e.command&&(n[0]==="doctor"||n[0]==="key")?(e.command=n[0],e.rest=n.slice(1)):n.length&&(e.prompt=n.join(" ")),e}async function v(){p("cli");let r=w(process.argv.slice(2));"error"in r&&(process.stderr.write(`parley: ${r.error}
`),process.exit(2));let e=r;if(e.command==="help"){process.stdout.write(x);return}if(e.command==="version"){process.stdout.write(`${u()}
`);return}if(e.noColor&&(process.env.NO_COLOR="1"),e.debug){let{enableDebug:t}=await import("./debug-35PLF4CG.js"),i=t(e.debugFile);process.stderr.write(`parley: writing debug log to ${i}
`)}if(e.command==="doctor"){let{runDoctor:t}=await import("./doctor-DAL5VJNC.js");process.exitCode=await t();return}if(e.command==="key"){let{runKeyCommand:t}=await import("./keycmd-PC2GIIFF.js");process.exitCode=await t(e.rest);return}let n=!!process.stdin.isTTY,s=!!process.stdout.isTTY;if(e.print||!n||!s){let{runPrint:t}=await import("./print-CL3RHGOQ.js");process.exitCode=await t(e);return}let o=m(),{runInteractive:a}=await import("./interactive-GGMRUKYB.js");p("interactive-loaded"),await a(e,o)}v().catch(r=>{process.stderr.write(`parley: ${r?.stack??r}
`),process.exit(1)});export{g as BUILD_KIND,f as VERSION,w as parseArgs,u as versionLine};
