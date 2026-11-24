import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
import{b as v}from"./chunk-Y47ZSWLP.js";import{a as l,c as y,d as u,e as p,f as c,g as h,h as m,i as w}from"./chunk-ZBY3FUV2.js";import"./chunk-A5CHC2K6.js";import"./chunk-SGJ7RKDV.js";function $(a){return new Promise(n=>{let e=process.stdin;if(!e.isTTY){let o="";e.setEncoding("utf8"),e.on("data",t=>o+=t),e.on("end",()=>n(o.trim()));return}process.stderr.write(a),e.setRawMode(!0),e.setEncoding("utf8");let i="",r=o=>{for(let t of o){if(t==="\r"||t===`
`)return e.setRawMode(!1),e.off("data",r),e.pause(),process.stderr.write(`
`),n(i.trim());t===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),t==="\x7F"||t==="\b"?i=i.slice(0,-1):t>=" "&&(i+=t)}};e.on("data",r),e.resume()})}async function E(a){let[n,e]=a;if(!n||!e||!["set","remove","status","remove-old"].includes(n))return process.stderr.write(`Usage: taria key set|remove|status|remove-old <provider>
`),2;let{config:i}=v(),r=i.providers[e];if(r||process.stderr.write(`Note: "${e}" is not defined in the config file yet.
`),n==="set"){let s=await $(`API key for ${e} (input hidden): `);if(!s)return process.stderr.write(`No key entered; nothing changed.
`),1;let d=await m(e,s);return process.stdout.write(`Stored the key for ${e} in the ${d.store==="keychain"?d.detail:`credentials file ${d.detail} (no keychain available)`}.
`),0}if(n==="remove")return await w(e),process.stdout.write(`Removed any stored key for ${e}.
`),0;if(n==="remove-old"){let s=await c(e);return s&&await p(e),process.stdout.write(s?`Removed the old parley keychain entry for ${e}. The taria entry is unchanged.
`:`There is no old parley keychain entry for ${e}.
`),0}let o=await y(),t=r?await h(r):{source:"none"},f=r?r.apiKeyEnv??l(r):void 0;return process.stdout.write(`Provider: ${e}
Keychain: ${u(o)}
Key source: ${t.source==="none"?`none found${f?` (checked $${f}, keychain, credentials file)`:""}`:`${t.source}${"detail"in t&&t.detail?` (${t.detail})`:""}`}
`),await c(e)&&process.stdout.write(`Old parley entry: still in the keychain (an old parley uses it). Remove it with: taria key remove-old ${e}
`),0}export{E as runKeyCommand};
