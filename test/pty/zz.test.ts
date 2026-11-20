import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnParley, makeHome } from './harness.js';
it('startup', async () => {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const home = makeHome();
    const f = join(home, 'trace');
    const s = spawnParley({ cols: 90, rows: 30, home, env: { PARLEY_STARTUP_TRACE: f } });
    await s.waitFor('Send a message');
    await new Promise((r) => setTimeout(r, 100));
    out.push(readFileSync(f, 'utf8').trim());
    await s.close();
  }
  console.log('first frame at ms', out.join(' '));
}, 60000);
