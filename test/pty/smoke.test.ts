import { afterEach, describe, expect, it } from 'vitest';
import { spawnParley, sleep, type Session } from './harness.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe('interactive smoke', () => {
  it('shows the welcome box and echoes a message', async () => {
    s = spawnParley({ cols: 80, rows: 24 });
    await s.waitFor('Welcome to parley');
    await s.waitFor('Send a message');
    s.write('hello there\r');
    await s.waitFor('You said: hello there');
    await sleep(300);
    const screen = s.screen().join('\n');
    console.log(screen);
    expect(screen).toContain('> hello there');
  });
});
