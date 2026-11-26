import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
import{w as b}from"./chunk-OC6UJYLR.js";import{a as h,c as f,d as u,e as m,f as p,g as w,h as k,i as $,j as v,k as g,l as K}from"./chunk-4IY63MIK.js";import"./chunk-HGI2T66H.js";import"./chunk-SGJ7RKDV.js";function R(c){return new Promise(o=>{let e=process.stdin;if(!e.isTTY){let s="";e.setEncoding("utf8"),e.on("data",r=>s+=r),e.on("end",()=>o(s.trim()));return}process.stderr.write(c),e.setRawMode(!0),e.setEncoding("utf8");let i="",n=s=>{for(let r of s){if(r==="\r"||r===`
`)return e.setRawMode(!1),e.off("data",n),e.pause(),process.stderr.write(`
`),o(i.trim());r===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),r==="\x7F"||r==="\b"?i=i.slice(0,-1):r>=" "&&(i+=r)}};e.on("data",n),e.resume()})}async function x(c){let[o,e]=c;if(!o||!e||!["set","remove","status","remove-old"].includes(o))return process.stderr.write(`Usage: taria key set|remove|status|remove-old <provider>
`),2;let{config:i}=b(),n=i.providers[e];if(n||process.stderr.write(`Note: "${e}" is not defined in the config file yet.
`),o==="set"){let t=await R(`API key for ${e} (input hidden): `);if(!t)return process.stderr.write(`No key entered; nothing changed.
`),1;let l=$(t);if(l)return process.stderr.write(`${l} Nothing was stored.
`),1;let d;try{d=await g(e,t)}catch(y){if(!(y instanceof k))throw y;return process.stderr.write(`${y.message} Nothing was stored.
`),1}return process.stdout.write(`Stored the key for ${e} in the ${d.store==="keychain"?d.detail:`credentials file ${d.detail} (no keychain available)`}.
`),0}if(o==="remove")return await K(e),process.stdout.write(`Removed any stored key for ${e}.
`),0;if(o==="remove-old"){let t=await p(e);return t==="copy-failed"||t==="remove-failed"||t==="no-answer"?(process.stderr.write(t==="no-answer"?`The keychain did not answer (it may be locked, or waiting for a password), so taria cannot tell whether the key for ${e} is stored under its own name. Nothing was removed.
`:t==="copy-failed"?`The old parley keychain entry for ${e} is the only copy of that key, and storing it under taria's name failed. Nothing was removed.
`:`The keychain refused to remove the old parley entry for ${e}. Nothing was removed.
`),1):(process.stdout.write(t==="none"?`There is no old parley keychain entry for ${e}.
`:t==="copied-and-removed"?`Stored the key for ${e} under taria's name first (it was only under parley's), then removed the old parley entry.
`:`Removed the old parley keychain entry for ${e}. The taria entry is unchanged.
`),0)}let s=await f();m();let r=n?await v(n):{source:"none"},a=n?n.apiKeyEnv??h(n):void 0,P=r.source!=="none"?`${r.source}${r.detail?` (${r.detail})`:""}${r.keychainProblem?`; the keychain did not answer (${r.keychainProblem})`:""}`:r.keychainProblem?`unknown: the keychain did not answer (${r.keychainProblem}), so a key may be stored there. Not in ${a?`$${a} or `:""}the credentials file. Unlock the keychain and try again.`:`none found${a?` (checked $${a}, keychain, credentials file)`:""}`;return process.stdout.write(`Provider: ${e}
Keychain: ${u(s)}
Key source: ${P}
`),!r.keychainProblem&&await w(e)&&process.stdout.write(`Old parley entry: still in the keychain (an old parley uses it). Remove it with: taria key remove-old ${e}
`),0}export{x as runKeyCommand};
