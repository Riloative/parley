import { createRequire as __parleyCreateRequire } from 'node:module'; const require = __parleyCreateRequire(import.meta.url);
import{b as m}from"./chunk-E23DKPLR.js";import{b as f,d as u,e as l,f as y,g as p,h as w}from"./chunk-EZHQ5SEV.js";import"./chunk-URYMO42N.js";function $(i){return new Promise(n=>{let e=process.stdin;if(!e.isTTY){let o="";e.setEncoding("utf8"),e.on("data",t=>o+=t),e.on("end",()=>n(o.trim()));return}process.stderr.write(i),e.setRawMode(!0),e.setEncoding("utf8");let s="",r=o=>{for(let t of o){if(t==="\r"||t===`
`)return e.setRawMode(!1),e.off("data",r),e.pause(),process.stderr.write(`
`),n(s.trim());t===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),t==="\x7F"||t==="\b"?s=s.slice(0,-1):t>=" "&&(s+=t)}};e.on("data",r),e.resume()})}async function g(i){let[n,e]=i;if(!n||!e||!["set","remove","status"].includes(n))return process.stderr.write(`Usage: parley key set|remove|status <provider>
`),2;let{config:s}=m(),r=s.providers[e];if(r||process.stderr.write(`Note: "${e}" is not defined in the config file yet.
`),n==="set"){let c=await $(`API key for ${e} (input hidden): `);if(!c)return process.stderr.write(`No key entered; nothing changed.
`),1;let a=await p(e,c);return process.stdout.write(`Stored the key for ${e} in the ${a.store==="keychain"?a.detail:`credentials file ${a.detail} (no keychain available)`}.
`),0}if(n==="remove")return await w(e),process.stdout.write(`Removed any stored key for ${e}.
`),0;let o=await u(),t=r?await y(r):{source:"none"},d=r?r.apiKeyEnv??f(r):void 0;return process.stdout.write(`Provider: ${e}
Keychain: ${l(o)}
Key source: ${t.source==="none"?`none found${d?` (checked $${d}, keychain, credentials file)`:""}`:`${t.source}${"detail"in t&&t.detail?` (${t.detail})`:""}`}
`),0}export{g as runKeyCommand};
