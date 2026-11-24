import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
import{b as $}from"./chunk-Y47ZSWLP.js";import{a as y,c as l,d as f,e as u,f as h,g as p,h as m,i as w,j as v}from"./chunk-ZKAVJ6LF.js";import"./chunk-A5CHC2K6.js";import"./chunk-SGJ7RKDV.js";function k(a){return new Promise(n=>{let e=process.stdin;if(!e.isTTY){let s="";e.setEncoding("utf8"),e.on("data",r=>s+=r),e.on("end",()=>n(s.trim()));return}process.stderr.write(a),e.setRawMode(!0),e.setEncoding("utf8");let i="",t=s=>{for(let r of s){if(r==="\r"||r===`
`)return e.setRawMode(!1),e.off("data",t),e.pause(),process.stderr.write(`
`),n(i.trim());r===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),r==="\x7F"||r==="\b"?i=i.slice(0,-1):r>=" "&&(i+=r)}};e.on("data",t),e.resume()})}async function E(a){let[n,e]=a;if(!n||!e||!["set","remove","status","remove-old"].includes(n))return process.stderr.write(`Usage: taria key set|remove|status|remove-old <provider>
`),2;let{config:i}=$(),t=i.providers[e];if(t||process.stderr.write(`Note: "${e}" is not defined in the config file yet.
`),n==="set"){let o=await k(`API key for ${e} (input hidden): `);if(!o)return process.stderr.write(`No key entered; nothing changed.
`),1;let d=await w(e,o);return process.stdout.write(`Stored the key for ${e} in the ${d.store==="keychain"?d.detail:`credentials file ${d.detail} (no keychain available)`}.
`),0}if(n==="remove")return await v(e),process.stdout.write(`Removed any stored key for ${e}.
`),0;if(n==="remove-old"){let o=await h(e);return o==="copy-failed"||o==="remove-failed"?(process.stderr.write(o==="copy-failed"?`The old parley keychain entry for ${e} is the only copy of that key, and storing it under taria's name failed. Nothing was removed.
`:`The keychain refused to remove the old parley entry for ${e}. Nothing was removed.
`),1):(process.stdout.write(o==="none"?`There is no old parley keychain entry for ${e}.
`:o==="copied-and-removed"?`Stored the key for ${e} under taria's name first (it was only under parley's), then removed the old parley entry.
`:`Removed the old parley keychain entry for ${e}. The taria entry is unchanged.
`),0)}let s=await l();u();let r=t?await m(t):{source:"none"},c=t?t.apiKeyEnv??y(t):void 0;return process.stdout.write(`Provider: ${e}
Keychain: ${f(s)}
Key source: ${r.source==="none"?`none found${c?` (checked $${c}, keychain, credentials file)`:""}`:`${r.source}${"detail"in r&&r.detail?` (${r.detail})`:""}`}
`),await p(e)&&process.stdout.write(`Old parley entry: still in the keychain (an old parley uses it). Remove it with: taria key remove-old ${e}
`),0}export{E as runKeyCommand};
