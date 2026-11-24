import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// PTY tests drive the real, bundled binary. Rebuild when sources are newer.
function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

export function ensureBuilt(): void {
  const root = new URL('..', import.meta.url).pathname;
  const out = join(root, 'dist', 'cli.js');
  if (!existsSync(out) || statSync(out).mtimeMs < newest(join(root, 'src'))) {
    execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
  }
}

/**
 * How to launch the taria under test: the standalone binary named by
 * TARIA_BIN, or the Node build (bin/taria.js, rebuilt when stale).
 */
export function tariaCommand(args: string[] = []): { command: string; args: string[]; shell: string } {
  const root = new URL('..', import.meta.url).pathname;
  // PARLEY_BIN is the name from before the rename.
  const bin = process.env.TARIA_BIN ?? process.env.PARLEY_BIN;
  if (bin) return { command: bin, args, shell: `'${bin}'` };
  ensureBuilt();
  const script = join(root, 'bin', 'taria.js');
  return { command: process.execPath, args: [script, ...args], shell: `'${process.execPath}' '${script}'` };
}
