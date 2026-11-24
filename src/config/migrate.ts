// Moving a user's files from parley's directories to taria's, once.
//
// For each kind of directory (config, data, state, cache) whose taria
// location does not exist yet while the parley one does:
//
//   1. If a parley process still holds a conversation lock in the old data
//      directory, the data move waits: this run uses the old directory.
//   2. A marker file is written into the old directory, then the directory is
//      renamed to the new name. The rename is atomic: at every moment the
//      files are complete in exactly one place.
//   3. The old path becomes a symlink to the new directory, so an old parley
//      binary (and anything a running one appends) still finds everything.
//
// When a rename is impossible (the old directory is a mount point, or it is
// not writable), the files are copied to a temporary directory next to the
// new one, checked file by file, and the copy is renamed into place. Then the
// old directory is renamed aside and replaced by the symlink where that is
// allowed; otherwise it is left exactly as it was.
//
// Every step can be interrupted: a rerun sees which state it is in and
// finishes the job. Nothing is ever deleted except a half-finished copy this
// code made itself. Conversation files are never rewritten; files that grew
// in the old directory after a copy get only their new bytes appended.

import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { APP, OLD_APP } from '../brand.js';
import { DIR_KINDS, dirIsExplicit, paths, setDirOverride, type DirKind } from './paths.js';

export const MARKER = `.migrated-from-${OLD_APP}`;
const COPYING = `.${APP}-migrating`;

interface Marker {
  from: string;
  to: string;
  at: number;
  /** renamed: moved in one step. copied: copied, old directory not retired yet.
   * done: copied and the old directory retired (or deliberately kept). */
  how: 'renamed' | 'copied' | 'done';
  kept?: string;
}

/** The file-system calls the migration makes, so tests can fail any of them. */
export type Fs = Pick<
  typeof realFs,
  'renameSync' | 'symlinkSync' | 'writeFileSync' | 'readFileSync' | 'mkdirSync' | 'copyFileSync' | 'readdirSync' | 'lstatSync' | 'statSync' | 'existsSync' | 'rmSync' | 'chmodSync' | 'accessSync' | 'appendFileSync' | 'readlinkSync'
>;

export interface MigrationStep {
  kind: DirKind;
  from: string;
  to: string;
  how: 'renamed' | 'copied' | 'linked';
  /** The old path is now a symlink to the new one. */
  linked: boolean;
  /** Why the old directory was left in place, when it was. */
  kept?: string;
}

export interface MigrationResult {
  steps: MigrationStep[];
  /** Kinds whose move had to wait, and why (this run uses the old directory). */
  deferred: Array<{ kind: DirKind; reason: string; using: string }>;
  /** Old and new both exist and are unrelated: the new one is used. */
  both: Array<{ kind: DirKind; from: string; to: string }>;
  problems: string[];
}

export interface MigrateOptions {
  fs?: Fs;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  kinds?: DirKind[];
}

function defaultIsAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lexists = (fs: Fs, p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function readMarker(fs: Fs, dir: string): Marker | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(join(dir, MARKER), 'utf8') as string) as Marker;
    return typeof m.at === 'number' ? m : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(fs: Fs, dir: string, m: Marker): void {
  fs.writeFileSync(join(dir, MARKER), JSON.stringify(m) + '\n', { mode: 0o600 });
}

/** The pid of a parley that has a conversation open in `dataDir`, if any. */
function liveLock(fs: Fs, dataDir: string, isAlive: (pid: number) => boolean): number | undefined {
  const dir = join(dataDir, 'conversations');
  let names: string[];
  try {
    names = fs.readdirSync(dir) as string[];
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (!n.endsWith('.lock')) continue;
    try {
      const text = (fs.readFileSync(join(dir, n), 'utf8') as string).trim();
      // 0.0.1 locks hold just the pid; later ones are JSON with a pid field.
      const pid = /^\d+$/.test(text) ? Number(text) : Number((JSON.parse(text) as { pid?: unknown }).pid);
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
    } catch {
      /* unreadable lock: not a reason to wait */
    }
  }
  return undefined;
}

function writable(fs: Fs, dir: string): boolean {
  try {
    fs.accessSync(dir, realFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every regular file under `root`, as paths relative to it. */
function walk(fs: Fs, root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(join(root, rel), { withFileTypes: true }) as realFs.Dirent[]) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(fs, root, r));
    else if (e.isFile()) out.push(r);
    // Symlinks and sockets are not data parley wrote; they are left alone.
  }
  return out;
}

/** No files anywhere below `dir` (only empty folders). */
function emptyTree(fs: Fs, dir: string): boolean {
  try {
    return walk(fs, dir).length === 0 && !hasOther(fs, dir);
  } catch {
    return false;
  }
}

/** Anything but folders and regular files (links, sockets) counts as content. */
function hasOther(fs: Fs, dir: string): boolean {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }) as realFs.Dirent[]) {
    if (e.isDirectory()) {
      if (hasOther(fs, join(dir, e.name))) return true;
    } else if (!e.isFile()) return true;
  }
  return false;
}

function hashFile(fs: Fs, f: string): string {
  return createHash('sha256').update(fs.readFileSync(f) as Buffer).digest('hex');
}

/** Copy `from` to `to` (which must not exist), then check every file. */
function copyTree(fs: Fs, from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const rel of walk(fs, from)) {
    const src = join(from, rel);
    const dst = join(to, rel);
    fs.mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    // Keep the file's mode, but taria must be able to append to it.
    fs.chmodSync(dst, ((fs.statSync(src) as realFs.Stats).mode & 0o777) | 0o600);
  }
  for (const rel of walk(fs, from)) {
    if (hashFile(fs, join(from, rel)) !== hashFile(fs, join(to, rel))) throw new Error(`the copy of ${rel} does not match the original`);
  }
}

/**
 * After a copy, the old directory may have changed (an old parley appended to
 * a conversation). Bring those changes over without rewriting anything:
 * missing files are copied, and a file that grew gets only its new bytes,
 * provided the copy is still a prefix of it.
 */
function catchUp(fs: Fs, from: string, to: string, problems: string[]): void {
  for (const rel of walk(fs, from)) {
    if (rel === MARKER) continue;
    const src = join(from, rel);
    const dst = join(to, rel);
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      fs.copyFileSync(src, dst);
      continue;
    }
    if ((fs.statSync(src) as realFs.Stats).size === (fs.statSync(dst) as realFs.Stats).size) continue;
    const a = fs.readFileSync(src) as Buffer;
    const b = fs.readFileSync(dst) as Buffer;
    if (a.length > b.length && a.subarray(0, b.length).equals(b)) fs.appendFileSync(dst, a.subarray(b.length));
    else if (a.length > b.length) problems.push(`${src} and ${dst} differ; both are kept`);
  }
}

function migrateOne(kind: DirKind, from: string, to: string, fs: Fs, isAlive: (pid: number) => boolean, now: () => number, r: MigrationResult): void {
  const fromIsLink = lexists(fs, from) && (fs.lstatSync(from) as realFs.Stats).isSymbolicLink();
  const toExists = fs.existsSync(to);

  // A copy that was interrupted before it was put in place: it is ours, and
  // only a copy, so start it again.
  const tmp = join(dirname(to), `${COPYING}-${basename(to)}`);
  if (lexists(fs, tmp)) fs.rmSync(tmp, { recursive: true, force: true });

  if (fromIsLink) return; // done before, or a link the user made
  if (!lexists(fs, from)) {
    // Renamed, but interrupted before the old path became a link.
    const m = toExists ? readMarker(fs, to) : undefined;
    if (m && m.how === 'renamed') {
      try {
        fs.symlinkSync(to, from, 'dir');
        r.steps.push({ kind, from, to, how: 'linked', linked: true });
      } catch (e) {
        r.problems.push(`could not link ${from} to ${to}: ${(e as Error).message}`);
      }
    }
    return;
  }
  if (!(fs.statSync(from) as realFs.Stats).isDirectory()) return;

  // A taria folder with no files in it (created before the move could run)
  // holds nothing to lose: take it away and move as usual.
  if (toExists && !readMarker(fs, to) && emptyTree(fs, to)) {
    fs.rmSync(to, { recursive: true });
    return migrateOne(kind, from, to, fs, isAlive, now, r);
  }
  if (toExists) {
    const m = readMarker(fs, to);
    if (m?.how === 'copied') return retire(kind, from, to, m, fs, now, r);
    // The old directory had to be kept (read-only, or it could not be
    // replaced by a link): an old parley may still write there, so bring its
    // new lines over on every start. Only files whose size changed are read.
    if (m?.how === 'done') return catchUp(fs, from, to, r.problems);
    r.both.push({ kind, from, to });
    return;
  }

  if (kind === 'data') {
    const pid = liveLock(fs, from, isAlive);
    if (pid !== undefined) {
      r.deferred.push({ kind, reason: `parley (pid ${pid}) has a conversation open`, using: from });
      return;
    }
  }

  const marker: Marker = { from, to, at: now(), how: 'renamed' };
  if (writable(fs, from)) {
    try {
      writeMarker(fs, from, marker);
      fs.renameSync(from, to);
      try {
        fs.symlinkSync(to, from, 'dir');
        r.steps.push({ kind, from, to, how: 'renamed', linked: true });
      } catch (e) {
        r.steps.push({ kind, from, to, how: 'renamed', linked: false, kept: `the old path could not become a link: ${(e as Error).message}` });
      }
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw e;
      // The marker stays in the old directory; it is harmless there.
    }
  }

  // Copy, check, then put the copy in place in one rename.
  copyTree(fs, from, tmp);
  writeMarker(fs, tmp, { ...marker, how: 'copied' });
  fs.renameSync(tmp, to);
  retire(kind, from, to, { ...marker, how: 'copied' }, fs, now, r);
}

/** After a copy: bring over late changes, then replace the old directory with
 * a link where allowed, else leave it as it was. */
function retire(kind: DirKind, from: string, to: string, m: Marker, fs: Fs, now: () => number, r: MigrationResult): void {
  catchUp(fs, from, to, r.problems);
  const aside = `${from}.moved-to-${APP}`;
  let kept: string | undefined;
  if (!writable(fs, dirname(from)) || !writable(fs, from)) {
    kept = `${from} is read-only, so it was copied and left as it was`;
  } else {
    try {
      fs.renameSync(from, aside);
      try {
        fs.symlinkSync(to, from, 'dir');
      } catch (e) {
        fs.renameSync(aside, from); // keep the old path working
        throw e;
      }
    } catch (e) {
      kept = `${from} was copied and left as it was (${(e as Error).message})`;
    }
  }
  writeMarker(fs, to, { ...m, at: now(), how: 'done', ...(kept ? { kept } : {}) });
  r.steps.push({ kind, from, to, how: 'copied', linked: !kept, ...(kept ? { kept } : {}) });
}

/** Move parley's directories to taria's where needed. Never throws. */
export function migrateFromParley(opts: MigrateOptions = {}): MigrationResult {
  const fs = opts.fs ?? realFs;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const now = opts.now ?? Date.now;
  const r: MigrationResult = { steps: [], deferred: [], both: [], problems: [] };
  for (const kind of opts.kinds ?? DIR_KINDS) {
    if (dirIsExplicit(kind)) continue;
    const from = paths.legacyDir(kind);
    const to = paths[`${kind}Dir` as 'dataDir'];
    try {
      migrateOne(kind, from, to, fs, isAlive, now, r);
    } catch (e) {
      // Whatever failed, the old directory is still complete: use it.
      r.problems.push(`could not move ${from} to ${to}: ${(e as Error).message}`);
      if (lexists(fs, from) && !fs.existsSync(to)) r.deferred.push({ kind, reason: 'the move failed', using: from });
    }
  }
  for (const d of r.deferred) setDirOverride(d.kind, d.using);
  return r;
}

const tilde = (p: string) => {
  const h = homedir();
  return p === h || p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p;
};

/** Plain-language lines about what happened, for the user. */
export function migrationNotices(r: MigrationResult): string[] {
  const out: string[] = [];
  const moved = r.steps.filter((s) => s.how !== 'linked');
  if (moved.length) {
    const list = moved.map((s) => `${tilde(s.from)} → ${tilde(s.to)}`).join(', ');
    const linked = moved.every((s) => s.linked);
    out.push(`parley is now ${APP}: moved your files (${list}).${linked ? ' The old paths point to the new ones, so an old parley still finds everything.' : ''}`);
    for (const s of moved) if (s.kept) out.push(`Note: ${s.kept}.`);
  }
  for (const d of r.deferred) out.push(`Your parley ${d.kind} files stay in ${tilde(d.using)} for now: ${d.reason}. They move to ${APP}'s folder the next time ${APP} starts after that.`);
  for (const b of r.both) out.push(`Both ${tilde(b.from)} and ${tilde(b.to)} exist; ${APP} uses ${tilde(b.to)}. \`${APP} doctor\` shows what is in each.`);
  for (const p of r.problems) out.push(`Migration: ${p}.`);
  return out;
}

