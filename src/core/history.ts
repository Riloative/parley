// Shared input history (one JSON line per submitted prompt). Many taria
// instances append concurrently; each append is a single O_APPEND write, and
// readers tolerate partial lines.

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LOAD_BYTES = 512 * 1024;

export class InputHistory {
  private entries: string[] = [];

  constructor(private readonly file: string) {}

  load(): void {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    const start = Math.max(0, size - MAX_LOAD_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // probably a partial line
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const t = (JSON.parse(lines[i]!) as { text?: string }).text;
        if (t && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      } catch {
        /* skip */
      }
    }
    this.entries = out.reverse().slice(-1000);
  }

  add(text: string): void {
    if (!text.trim()) return;
    this.entries = this.entries.filter((e) => e !== text);
    this.entries.push(text);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify({ t: Date.now(), text }) + '\n', { mode: 0o600 });
    } catch {
      /* history is best effort */
    }
  }

  /** Oldest first. */
  all(): readonly string[] {
    return this.entries;
  }

  /** Most recent entries containing `query`, newest first. */
  search(query: string): string[] {
    const q = query.toLowerCase();
    const out: string[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.toLowerCase().includes(q)) out.push(this.entries[i]!);
    }
    return out;
  }
}
