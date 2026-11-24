import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);
var r=[];function t(n){process.env.TARIA_STARTUP_TRACE&&r.push([n,Math.round(performance.now()*10)/10])}function o(){return r}export{t as a,o as b};
