#!/usr/bin/env node
// parley is now taria. This alias runs taria with the same arguments and exit
// status, for one release: it goes away in taria 0.4.0.
process.stderr.write('parley is now taria: run taria instead (the parley command goes away in 0.4.0).\n');
await import('./taria.js');
