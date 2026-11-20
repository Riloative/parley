// Attachments: listing files for the @ picker, turning files into content
// parts, and recognising file paths dropped into the terminal.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const MAX_TEXT_FILE = 1024 * 1024;
export const MAX_IMAGE_FILE = 20 * 1024 * 1024;

export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

export function sniffImage(buf: Buffer): string | undefined {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage']);

/** Files under `root` for the @ picker (git-aware, capped). */
export function listFiles(root = process.cwd(), cap = 5000): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').filter(Boolean);
    if (files.length) return files.slice(0, cap);
  } catch {
    /* not a git repo */
  }
  const files: string[] = [];
  if (resolve(root) === homedir()) return files; // never crawl the whole home directory
  const walk = (dir: string, depth: number) => {
    if (files.length >= cap || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile()) files.push(relative(root, p));
    }
  };
  walk(root, 0);
  return files;
}

export type FileAttachment =
  | { kind: 'image'; name: string; data: Buffer; mediaType: string }
  | { kind: 'text'; name: string; text: string };

export class AttachError extends Error {}

export function readAttachment(path: string): FileAttachment {
  const p = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new AttachError(`File not found: ${path}`);
  }
  if (!st.isFile()) throw new AttachError(`Not a file: ${path}`);
  const name = basename(p);
  const it = imageType(p);
  if (it) {
    if (st.size > MAX_IMAGE_FILE) throw new AttachError(`${name} is too large to attach (${Math.round(st.size / 1e6)} MB; the limit is 20 MB).`);
    const data = readFileSync(p);
    return { kind: 'image', name, data, mediaType: sniffImage(data) ?? it };
  }
  if (st.size > MAX_TEXT_FILE) throw new AttachError(`${name} is too large to attach as text (${Math.round(st.size / 1024)} KB; the limit is 1 MB).`);
  const buf = readFileSync(p);
  const img = sniffImage(buf);
  if (img) return { kind: 'image', name, data: buf, mediaType: img };
  if (buf.subarray(0, 8000).includes(0)) throw new AttachError(`${name} looks like a binary file; only text files and images can be attached.`);
  return { kind: 'text', name: displayName(p), text: buf.toString('utf8') };
}

/** Path relative to the working directory when inside it, else absolute.
 * Resolves symlinks on both sides (macOS: /var → /private/var, /tmp → /private/tmp). */
function displayName(p: string): string {
  let real = p;
  let cwd = process.cwd();
  try {
    real = realpathSync(p);
    cwd = realpathSync(cwd);
  } catch {
    /* keep as is */
  }
  const rel = relative(cwd, real);
  return rel.startsWith('..') ? p : rel;
}

/**
 * If pasted text consists only of existing file paths (as terminals produce
 * when files are dragged in: quoted, or with backslash-escaped spaces),
 * return them.
 */
export function parseDroppedPaths(text: string): string[] | null {
  const t = text.trim();
  if (!t || t.length > 4096 || t.includes('\n')) return null;
  const parts: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|((?:\\.|[^\s\\])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    let p = m[1] ?? m[2] ?? m[3]!.replace(/\\(.)/g, '$1');
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(new URL(p).pathname);
      } catch {
        return null;
      }
    }
    parts.push(p);
  }
  if (!parts.length) return null;
  for (const p of parts) {
    if (!(p.startsWith('/') || p.startsWith('~/'))) return null;
    const abs = p.replace(/^~(?=\/)/, homedir());
    if (!existsSync(abs)) return null;
    try {
      if (!statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
  }
  return parts;
}
