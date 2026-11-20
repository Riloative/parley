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
