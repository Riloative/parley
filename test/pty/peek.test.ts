// Manual inspection helper: PEEK="<scenario>" npx vitest run test/pty/peek.test.ts
// Scenarios are sequences separated by "|": text to type, or @wait:<text>,
// @sleep:<ms>, @key:<name> (enter, esc, up, down, ctrl-c, tab, shift-tab, ctrl-o),
// @resize:<cols>x<rows>, @screen (print the screen), @all (print scrollback).
import { it } from 'vitest';
import { spawnTaria, sleep } from './harness.js';

const KEYS: Record<string, string> = {
  enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', 'shift-tab': '\x1b[Z',
  'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-o': '\x0f', 'ctrl-r': '\x12', 'ctrl-l': '\x0c', 'ctrl-j': '\n', backspace: '\x7f', 'alt-enter': '\x1b\r',
};

it.runIf(!!process.env.PEEK)('peek', async () => {
  const [c, r] = (process.env.PEEK_SIZE ?? '80x24').split('x').map(Number);
  const s = spawnTaria({ cols: c, rows: r, args: (process.env.PEEK_ARGS ?? '').split(' ').filter(Boolean), config: process.env.PEEK_CONFIG?.replace(/\\n/g, '\n') });
  try {
    await s.waitFor('Welcome to taria');
    await sleep(300);
    for (const step of process.env.PEEK!.split('|')) {
      if (step.startsWith('@wait:')) await s.waitFor(step.slice(6), 20000);
      else if (step.startsWith('@sleep:')) await sleep(Number(step.slice(7)));
      else if (step.startsWith('@key:')) s.write(KEYS[step.slice(5)] ?? '');
      else if (step.startsWith('@resize:')) {
        const [rc, rr] = step.slice(8).split('x').map(Number);
        s.resize(rc!, rr!);
      } else if (step === '@screen') console.log('┏' + '━'.repeat(s.term.cols) + '┓\n' + s.screen().map((l) => '┃' + l.padEnd(s.term.cols) + '┃').join('\n') + '\n┗' + '━'.repeat(s.term.cols) + '┛');
      else if (step === '@all') console.log(s.all().join('\n'));
      else if (step === '@raw') console.log(JSON.stringify(s.raw.slice(-3000)));
      else s.write(step);
    }
  } finally {
    await s.close();
  }
}, 120000);
