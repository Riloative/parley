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
// allowed; otherwise it is left exactly as it was, and the marker records
// what was copied (size and time of each old file), so that later starts
// bring over only what an old parley changed since.
//
// An old path that is the user's own symlink (to another disk, a dotfiles
// folder) is never moved, rewritten or written into: taria's path becomes a
// second link to the same folder.
//
// Several taria processes may start at once. Two things keep that safe:
//
//   - Every step is safe on its own. The folder taria uses is never removed
//     with its contents: an empty one is removed with rmdir, which fails as
//     soon as anything is in it, and a folder is put in place with rename,
//     which fails if the target has contents. A step that fails because
//     another process got there first is not an error: the state is looked
//     at again.
//   - A lock file next to the folders lets one process at a time do the work,
//     so that the others wait and then find it done (and so that two of them
//     never append the same lines to a file). No data depends on the lock: if
//     it cannot be made, or is wrongly taken for stale, the first point holds.
//
// Every step can be interrupted: a rerun sees which state it is in and
// finishes the job. Nothing is ever deleted except a half-finished copy this
// code made itself, and folders with nothing in them. Files in taria's folder
// are never rewritten; a file that grew in the old directory after a copy
// gets only its new bytes appended, and only while taria's copy is unchanged.

import { createHash, randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { APP, OLD_APP } from '../brand.js';
import { holderAlive } from '../core/store.js';
import { DIR_KINDS, dirIsExplicit, paths, setDirOverride, type DirKind } from './paths.js';

export const MARKER = `.migrated-from-${OLD_APP}`;
const COPYING = `.${APP}-migrating`;
const LOCK = `.${APP}-migration.lock`;
/** How long a start waits for another taria that is moving the files. */
const LOCK_WAIT_MS = 15_000;

/** An old file as it was when it was last brought over: its size, its
 * modification time, and the modification time taria's copy had right after
 * (-1 when taria's copy was not written then). */
type Brought = [size: number, mtimeMs: number, copyMtimeMs: number];

interface Marker {
  from: string;
  to: string;
  at: number;
  /** renamed: moved in one step. copied: copied, old directory not retired yet.
   * done: copied and the old directory retired (or deliberately kept). */
  how: 'renamed' | 'copied' | 'done';
  kept?: string;
  /** While the old directory is kept: what was brought over, by relative path.
   * (Absent in markers written by 0.3.0, which kept no record.) */
  files?: Record<string, Brought>;
}

/** The file-system calls the migration makes, so tests can fail any of them. */
export type Fs = Pick<
  typeof realFs,
  'renameSync' | 'symlinkSync' | 'writeFileSync' | 'readFileSync' | 'mkdirSync' | 'copyFileSync' | 'readdirSync' | 'lstatSync' | 'statSync' | 'existsSync' | 'rmSync' | 'chmodSync' | 'accessSync' | 'appendFileSync' | 'readlinkSync' | 'rmdirSync' | 'utimesSync' | 'realpathSync' | 'linkSync'
>;

export interface MigrationStep {
  kind: DirKind;
  from: string;
  to: string;
  /** shared: the old path is the user's own link; the new path is now a link to the same folder. */
  how: 'renamed' | 'copied' | 'linked' | 'shared';
  /** The old path is now a symlink to the new one (shared: both lead to the same folder). */
  linked: boolean;
  /** Why the old directory was left in place, when it was. */
  kept?: string;
  /** shared: the folder both links lead to. */
  target?: string;
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
  /** Is the process that wrote a conversation lock (its pid, and its start time when the lock has one) still running? */
  isAlive?: (pid: number, started?: number) => boolean;
  now?: () => number;
  kinds?: DirKind[];
  /** How long to wait for another taria that is moving the files (ms). */
  lockWaitMs?: number;
}

interface Ctx {
  fs: Fs;
  isAlive: (pid: number, started?: number) => boolean;
  now: () => number;
  lockWaitMs: number;
}

/** The same check the store makes for its own locks: a pid that is alive but
 * started at another time is another process (the pid was reused). This
 * process has nothing open yet, so its own pid is never a holder. */
function defaultIsAlive(pid: number, started?: number): boolean {
  if (pid === process.pid) return false;
  return holderAlive({ pid, started });
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? '';
/** What a step fails with when another process got there first. */
const LOST_RACE = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR']);
const lostRace = (what: string) => Object.assign(new Error(what), { code: 'ENOTEMPTY' });
const unique = () => `${process.pid}-${randomBytes(4).toString('hex')}`;
/** Temporary files and folders this process is writing at this moment (the
 * rest of what carries its pid was left by an earlier process with that pid). */
const inUse = new Set<string>();

function lstat(fs: Fs, p: string): realFs.Stats | undefined {
  try {
    return fs.lstatSync(p) as realFs.Stats;
  } catch {
    return undefined;
  }
}

const lexists = (fs: Fs, p: string) => lstat(fs, p) !== undefined;

/** A directory, or a link to one. */
function isDir(fs: Fs, p: string): boolean {
  try {
    return (fs.statSync(p) as realFs.Stats).isDirectory();
  } catch {
    return false;
  }
}

/** Where a path really is; undefined when it (or a link on the way) does not exist. */
function real(fs: Fs, p: string): string | undefined {
  try {
    return fs.realpathSync(p) as string;
  } catch {
    return undefined;
  }
}

function names(fs: Fs, dir: string): string[] {
  try {
    return fs.readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

function readMarker(fs: Fs, dir: string): Marker | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(join(dir, MARKER), 'utf8') as string) as Marker;
    return typeof m.at === 'number' ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Written to a file of its own and renamed into place: a kill leaves the
 * marker as it was, never empty. */
function writeMarker(fs: Fs, dir: string, m: Marker): void {
  const tmp = join(dir, `${MARKER}.tmp-${unique()}`);
  inUse.add(tmp);
  try {
    fs.writeFileSync(tmp, JSON.stringify(m) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, join(dir, MARKER));
  } finally {
    inUse.delete(tmp);
  }
}

/** The marker and its temporary files: ours, not the user's data. */
const isMarker = (rel: string) => rel === MARKER || rel.startsWith(`${MARKER}.tmp-`);

/** What a lock file says about its holder. 0.0.1 locks hold just the pid;
 * later ones are JSON with a pid and (from 0.2.0) the holder's start time. */
function lockHolder(text: string): { pid: number; started?: number } | undefined {
  const t = text.trim();
  let pid: number;
  let started: unknown;
  if (/^\d+$/.test(t)) pid = Number(t);
  else {
    try {
      const j = JSON.parse(t) as { pid?: unknown; started?: unknown };
      pid = Number(j.pid);
      started = j.started;
    } catch {
      return undefined;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, ...(typeof started === 'number' ? { started } : {}) };
}

/** The pid of the running process that wrote this lock file, if there is one. */
function lockedBy(fs: Fs, lockFile: string, isAlive: Ctx['isAlive']): number | undefined {
  try {
    const h = lockHolder(fs.readFileSync(lockFile, 'utf8') as string);
    if (h && isAlive(h.pid, h.started)) return h.pid;
  } catch {
    /* no lock, or unreadable: not a reason to wait */
  }
  return undefined;
}

/** The pid of a parley that has a conversation open in `dataDir`, if any. */
function liveLock(fs: Fs, dataDir: string, isAlive: Ctx['isAlive']): number | undefined {
  const dir = join(dataDir, 'conversations');
  for (const n of names(fs, dir)) {
    if (!n.endsWith('.lock')) continue;
    const pid = lockedBy(fs, join(dir, n), isAlive);
    if (pid !== undefined) return pid;
  }
  return undefined;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One process at a time works on a pair of folders. Returns the function that
 * releases the lock, or 'busy' when a live process kept it for `waitMs`.
 * Where no lock file can be made (a read-only parent) the work goes on
 * without one: every step is safe by itself.
 */
function lockMigration(fs: Fs, file: string, waitMs: number): (() => void) | 'busy' {
  const mine = JSON.stringify({ pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), id: randomBytes(6).toString('hex') });
  const release = () => {
    try {
      if ((fs.readFileSync(file, 'utf8') as string) === mine) fs.rmSync(file, { force: true });
    } catch {
      /* gone, or taken over: nothing of ours to remove */
    }
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx', mode: 0o600 });
      return release;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') return () => {};
    }
    let held: boolean;
    try {
      held = !clearStaleLock(fs, file);
    } catch {
      return () => {}; // a lock that can be neither read nor removed: go on without
    }
    if (Date.now() >= deadline) return 'busy';
    sleep(held ? 25 : 1);
  }
}

/** Remove the lock if the process that made it is gone (killed before it
 * could). True when no live process holds the lock any more; throws when the
 * lock cannot be read or removed. */
function clearStaleLock(fs: Fs, file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8') as string;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return true;
    throw e;
  }
  const h = lockHolder(text);
  // A lock that is still being written (no pid in it yet) is given a few seconds.
  if (h ? defaultIsAlive(h.pid, h.started) : Date.now() - (lstat(fs, file)?.mtimeMs ?? 0) < 5000) return false;
  breakLock(fs, file, text);
  return true;
}

/** Take a stale lock away. It is renamed first, so only one process removes
 * it; if what was renamed is not the stale lock that was read (another process
 * broke it and took the lock in between), it is put back. */
function breakLock(fs: Fs, file: string, stale: string): void {
  const aside = `${file}.${unique()}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return; // another process took it away
    throw e;
  }
  try {
    if ((fs.readFileSync(aside, 'utf8') as string) !== stale) fs.linkSync(aside, file);
  } catch {
    /* the place is taken again: that process has the lock */
  }
  try {
    fs.rmSync(aside, { force: true });
  } catch {
    /* swept up at a later start */
  }
}

/** Remove what a killed process left next to (and in) taria's folder: copies
 * that were never put in place, temporary marker and lock files. Only names
 * this code makes, and only when the process that made them is gone. */
function sweep(fs: Fs, to: string | undefined, inside: string[]): void {
  const age = (path: string) => Date.now() - (lstat(fs, path)?.mtimeMs ?? 0);
  const gone = (pid: string | undefined, path: string) => pid !== undefined && (Number(pid) === process.pid ? !inUse.has(path) : !defaultIsAlive(Number(pid)) || age(path) > 86_400_000);
  const copy = `${COPYING}-${basename(to ?? '')}`;
  for (const n of to ? names(fs, dirname(to)) : []) {
    const path = join(dirname(to ?? ''), n);
    let stale: boolean;
    if (n === copy) stale = age(path) > 600_000; // 0.3.0's name, shared by all its processes
    else if (n.startsWith(`${copy}-`)) stale = gone(/^-(\d+)-[0-9a-f]+$/.exec(n.slice(copy.length))?.[1], path);
    else if (n.startsWith(`${LOCK}.`)) stale = gone(/^\.(\d+)-[0-9a-f]+$/.exec(n.slice(LOCK.length))?.[1], path);
    else continue;
    if (stale) fs.rmSync(path, { recursive: true, force: true });
  }
  for (const dir of inside) {
    for (const n of names(fs, dir)) {
      if (!n.startsWith(`${MARKER}.tmp-`)) continue;
      if (gone(/^(\d+)-[0-9a-f]+$/.exec(n.slice(MARKER.length + 5))?.[1], join(dir, n))) fs.rmSync(join(dir, n), { force: true });
    }
  }
}

function writable(fs: Fs, dir: string): boolean {
  try {
    fs.accessSync(dir, realFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every regular file and symlink under `root`, as paths relative to it. */
function walk(fs: Fs, root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(join(root, rel), { withFileTypes: true }) as realFs.Dirent[]) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(fs, root, r));
    else if (e.isFile() || e.isSymbolicLink()) out.push(r);
    // Sockets and pipes are not data parley wrote; they are left alone.
  }
  return out;
}

/** Nothing anywhere below `dir` but empty folders. */
function emptyTree(fs: Fs, dir: string): boolean {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }) as realFs.Dirent[]) {
      if (!e.isDirectory() || !emptyTree(fs, join(dir, e.name))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a folder that holds nothing but empty folders, with rmdir only:
 * rmdir fails as soon as anything is in a folder, so whatever another process
 * puts there between the check and now stays. (Removing "the empty folder"
 * together with its contents is how 0.3.0 could delete the files another
 * taria had just finished moving.)
 */
function removeEmptyFolders(fs: Fs, dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }) as realFs.Dirent[]) {
    if (!e.isDirectory()) throw lostRace(`${dir} is not empty any more`);
    removeEmptyFolders(fs, join(dir, e.name));
  }
  fs.rmdirSync(dir);
}

function hashFile(fs: Fs, f: string): string {
  return createHash('sha256').update(fs.readFileSync(f) as Buffer).digest('hex');
}

/** Copy one file or symlink to a path where nothing is yet (never over
 * something), with its mode and modification time. Returns what the original
 * was when it was copied. */
function copyEntry(fs: Fs, src: string, dst: string): Brought {
  const st = fs.lstatSync(src) as realFs.Stats;
  fs.mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  if (st.isSymbolicLink()) {
    // A link stays a link (a config file kept in a dotfiles folder, attachments on another disk).
    fs.symlinkSync(fs.readlinkSync(src) as string, dst);
    return [st.size, st.mtimeMs, -1];
  }
  fs.copyFileSync(src, dst, realFs.constants.COPYFILE_EXCL);
  // Keep the file's mode, but taria must be able to append to it.
  fs.chmodSync(dst, (st.mode & 0o777) | 0o600);
  // "Continue the most recent conversation" goes by modification time.
  fs.utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
  return [st.size, st.mtimeMs, (fs.lstatSync(dst) as realFs.Stats).mtimeMs];
}

function sameEntry(fs: Fs, a: string, b: string): boolean {
  const sa = fs.lstatSync(a) as realFs.Stats;
  const sb = fs.lstatSync(b) as realFs.Stats;
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  return sb.isFile() && hashFile(fs, a) === hashFile(fs, b);
}

/** Copy `from` to `to` (which must not exist), then check every file. */
function copyTree(fs: Fs, from: string, to: string): Record<string, Brought> {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const files: Record<string, Brought> = {};
  const rels = walk(fs, from).filter((rel) => !isMarker(rel));
  for (const rel of rels) files[rel] = copyEntry(fs, join(from, rel), join(to, rel));
  for (const rel of rels) {
    if (!sameEntry(fs, join(from, rel), join(to, rel))) throw new Error(`the copy of ${rel} does not match the original`);
  }
  return files;
}

/**
 * After a copy, the old directory may have changed (an old parley is still
 * used). Bring those changes over without rewriting anything of taria's.
 * The marker says what each old file was when it was brought over, so:
 *
 *   - an old file that has not changed since is not looked at again, whatever
 *     happened to taria's copy (continued, trashed, deleted: all taria's
 *     business, and nothing comes back);
 *   - an old file that is new, or that changed while taria's copy is gone, is
 *     copied;
 *   - an old file that grew gets its new bytes appended to taria's copy when
 *     that copy is still the beginning of it and was not changed in taria
 *     (for .jsonl files, which are only ever appended to, being the beginning
 *     is enough);
 *   - anything else is a real difference: both files stay as they are, and it
 *     is reported once, until the old file changes again.
 *
 * Returns the new record, and whether it differs from the marker's.
 */
function catchUp(c: Ctx, from: string, to: string, m: Marker, problems: string[]): { files: Record<string, Brought>; changed: boolean } {
  const { fs } = c;
  const before = m.files;
  const files: Record<string, Brought> = {};
  const differ: string[] = [];
  let changed = !before;
  for (const rel of walk(fs, from)) {
    if (isMarker(rel)) continue;
    const src = join(from, rel);
    const dst = join(to, rel);
    const st = fs.lstatSync(src) as realFs.Stats;
    const rec = before?.[rel];
    if (rec && rec[0] === st.size && rec[1] === st.mtimeMs) {
      files[rel] = rec;
      continue;
    }
    changed = true;
    const seen: Brought = [st.size, st.mtimeMs, -1];
    // 0.3.0 kept no record, but it copied everything that was there: a file
    // not touched since that copy was brought over then.
    if (!before && st.mtimeMs <= m.at) {
      files[rel] = seen;
      continue;
    }
    const have = lstat(fs, dst);
    if (!have) {
      try {
        files[rel] = copyEntry(fs, src, dst);
      } catch (e) {
        if (errCode(e) !== 'EEXIST') throw e;
        // It appeared this moment: compared at the next start.
      }
      continue;
    }
    if (st.isSymbolicLink() || !have.isFile()) {
      if (!sameEntry(fs, src, dst)) differ.push(rel);
      files[rel] = seen;
      continue;
    }
    const a = fs.readFileSync(src) as Buffer;
    const b = fs.readFileSync(dst) as Buffer;
    if (a.equals(b)) {
      files[rel] = [st.size, st.mtimeMs, have.mtimeMs];
      continue;
    }
    // taria's file has everything the old one has, and more: nothing to bring.
    if (b.length > a.length && b.subarray(0, a.length).equals(a)) {
      files[rel] = seen;
      continue;
    }
    const untouched = rel.endsWith('.jsonl') || (rec !== undefined && have.size === rec[0] && have.mtimeMs === rec[2]);
    if (untouched && a.length > b.length && a.subarray(0, b.length).equals(b)) {
      // Open in a running taria, which may be writing: left for a later start.
      if (lockedBy(fs, `${dst}.lock`, c.isAlive) !== undefined) {
        if (rec) files[rel] = rec;
        continue;
      }
      fs.appendFileSync(dst, a.subarray(b.length));
      fs.utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
      files[rel] = [st.size, st.mtimeMs, (fs.lstatSync(dst) as realFs.Stats).mtimeMs];
      continue;
    }
    differ.push(rel);
    files[rel] = seen;
  }
  if (before && Object.keys(before).length !== Object.keys(files).length) changed = true;
  if (differ.length === 1) problems.push(`${differ[0]} changed in ${tilde(from)} after ${APP} copied it, and no longer fits ${APP}'s own copy in ${tilde(to)}. Both files are kept as they are; ${APP} uses its own`);
  else if (differ.length) {
    const list = differ.slice(0, 3).join(', ') + (differ.length > 3 ? ` and ${differ.length - 3} more` : '');
    problems.push(`${differ.length} files changed in ${tilde(from)} after ${APP} copied them, and no longer fit ${APP}'s own copies in ${tilde(to)} (${list}). All are kept as they are; ${APP} uses its own`);
  }
  return { files, changed };
}

/** The old directory was moved (or moved aside after a copy), and a kill came
 * before the old path became a link. */
const owesLink = (m: Marker, from: string) => m.how === 'renamed' || (m.how === 'copied' && m.from === from);

/** Is there nothing to do for this pair? (Checked without the lock, on every
 * start: after a finished move the old path is a link to the new one.) */
function settled(fs: Fs, from: string, to: string): boolean {
  const st = lstat(fs, from);
  if (!st) {
    const m = readMarker(fs, to);
    return !m || !owesLink(m, from);
  }
  if (!st.isSymbolicLink()) return false;
  const target = real(fs, from);
  return target !== undefined && target === real(fs, to);
}

function migrateOne(kind: DirKind, from: string, to: string, c: Ctx, r: MigrationResult): void {
  const { fs } = c;
  const lock = join(dirname(to), LOCK);
  if (settled(fs, from, to)) {
    // What a process killed right after it finished left lying about.
    try {
      clearStaleLock(fs, lock);
      sweep(fs, undefined, [to]);
    } catch {
      /* tidying up only */
    }
    return;
  }
  const unlock = lockMigration(fs, lock, c.lockWaitMs);
  if (unlock === 'busy') {
    // Another taria has been at work on these folders for a long time (a big
    // copy). Its result is not there yet, so this run reads the old folder.
    if (isDir(fs, from) && !isDir(fs, to)) r.deferred.push({ kind, reason: `another ${APP} is moving them right now`, using: from });
    return;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      const mark = [r.steps.length, r.deferred.length, r.both.length, r.problems.length] as const;
      try {
        return inspect(kind, from, to, c, r);
      } catch (e) {
        if (attempt >= 3 || !LOST_RACE.has(errCode(e))) throw e;
        // Another process changed the folders in between (it removed the
        // empty folder, finished the move, made the link): not a failure.
        // Forget what this attempt was about to report, and look again.
        r.steps.length = mark[0];
        r.deferred.length = mark[1];
        r.both.length = mark[2];
        r.problems.length = mark[3];
      }
    }
  } finally {
    unlock();
  }
}

/** Look at the state the two paths are in, and take it as far as it goes. */
function inspect(kind: DirKind, from: string, to: string, c: Ctx, r: MigrationResult): void {
  const { fs } = c;
  // taria's path: nothing, a folder (or a link to one), or something that no
  // folder can be put in place of.
  const toSt = lstat(fs, to);
  const toDir = toSt !== undefined && isDir(fs, to);
  let blocked: string | undefined;
  if (toSt && !toDir) {
    if (toSt.isSymbolicLink() && !fs.existsSync(to)) blocked = `${tilde(to)} is a link to ${tilde(fs.readlinkSync(to) as string)}, which does not exist`;
    else blocked = `${tilde(to)} is a file, not a folder (move it out of the way)`;
  }

  const fromSt = lstat(fs, from);
  sweep(fs, to, [...(toDir ? [to] : []), ...(fromSt?.isDirectory() ? [from] : [])]);
  // Old and new both exist and are unrelated. (Unless the old one is no longer
  // what it was a moment ago: then another process is at work.)
  const both = () => {
    if (lstat(fs, from)?.isSymbolicLink() !== fromSt?.isSymbolicLink()) throw lostRace(`${from} changed`);
    r.both.push({ kind, from, to });
  };
  if (!fromSt) {
    // Moved (or moved aside after a copy), but killed before the old path became a link.
    const m = toDir ? readMarker(fs, to) : undefined;
    if (!m || !owesLink(m, from)) return;
    try {
      fs.symlinkSync(to, from, 'dir');
    } catch (e) {
      if (LOST_RACE.has(errCode(e))) throw e;
      r.problems.push(`could not link ${from} to ${to}: ${(e as Error).message}`);
      return;
    }
    // After a copy this was the last step, and the process that was killed
    // never got to say that the files moved.
    if (m.how === 'copied') writeMarker(fs, to, { from: m.from, to: m.to, at: c.now(), how: 'done' });
    r.steps.push({ kind, from, to, how: m.how === 'copied' ? 'copied' : 'linked', linked: true });
    return;
  }

  if (fromSt.isSymbolicLink()) {
    const target = real(fs, from);
    if (target === undefined) {
      // Said until taria has a folder of its own; `taria doctor` shows it after that.
      if (!toSt) r.problems.push(`${tilde(from)} is a link to ${tilde(fs.readlinkSync(from) as string)}, which does not exist, so there are no parley ${kind} files to bring over. Delete the link if you no longer need it`);
      return;
    }
    if (!isDir(fs, target)) return;
    if (blocked) {
      r.deferred.push({ kind, reason: blocked, using: from });
      return;
    }
    // Only a link that leads to taria's folder means "moved before". Any
    // other is the user's own (another disk, a dotfiles folder): the files
    // stay where the user put them, and taria's path becomes a link to the
    // same place. The user's link and folder are not touched, and nothing is
    // written there.
    if (toSt) {
      if (real(fs, to) === target) return;
      if (toSt.isSymbolicLink() || readMarker(fs, to) || !emptyTree(fs, to)) return both();
      removeEmptyFolders(fs, to);
    }
    fs.symlinkSync(target, to, 'dir');
    r.steps.push({ kind, from, to, how: 'shared', linked: true, target });
    return;
  }

  if (!fromSt.isDirectory()) return;
  if (blocked) {
    r.deferred.push({ kind, reason: blocked, using: from });
    return;
  }

  if (toSt) {
    const m = readMarker(fs, to);
    if (m?.how === 'copied') return retire(kind, from, to, m, c, r, false);
    // The old directory had to be kept (read-only, or it could not be
    // replaced by a link): an old parley may still write there, so bring its
    // changes over on every start. Only files that changed are read.
    if (m?.how === 'done') {
      const caught = catchUp(c, from, to, m, r.problems);
      if (caught.changed) writeMarker(fs, to, { ...m, files: caught.files });
      return;
    }
    if (m || toSt.isSymbolicLink() || !emptyTree(fs, to)) return both();
  }

  if (kind === 'data') {
    const pid = liveLock(fs, from, c.isAlive);
    if (pid !== undefined) {
      r.deferred.push({ kind, reason: `parley (pid ${pid}) has a conversation open`, using: from });
      return;
    }
  }

  if (!toSt && !writable(fs, dirname(to))) {
    r.deferred.push({ kind, reason: `${tilde(dirname(to))} is read-only, so ${APP}'s folder cannot be made there`, using: from });
    return;
  }

  // A taria folder with no files in it (created before the move could run)
  // holds nothing to lose: take it away and move as usual.
  if (toSt) removeEmptyFolders(fs, to);

  const marker: Marker = { from, to, at: c.now(), how: 'renamed' };
  if (writable(fs, from)) {
    try {
      writeMarker(fs, from, marker);
      // Fails, changing nothing, if taria's folder is there by now with anything in it.
      fs.renameSync(from, to);
      try {
        fs.symlinkSync(to, from, 'dir');
        r.steps.push({ kind, from, to, how: 'renamed', linked: true });
      } catch (e) {
        r.steps.push({ kind, from, to, how: 'renamed', linked: false, kept: `the old path could not become a link: ${(e as Error).message}` });
      }
      return;
    } catch (e) {
      const code = errCode(e);
      if (code !== 'EXDEV' && code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw e;
      // The marker stays in the old directory; it is harmless there.
    }
  }

  // Copy, check, then put the copy in place in one rename. The copy has a
  // name of its own, so two processes never work in (or clear away) the same one.
  const tmp = join(dirname(to), `${COPYING}-${basename(to)}-${unique()}`);
  let copied: Marker;
  inUse.add(tmp);
  try {
    copied = { ...marker, how: 'copied', files: copyTree(fs, from, tmp) };
    writeMarker(fs, tmp, copied);
    // Fails, changing nothing, if taria's folder is there by now with anything in it.
    fs.renameSync(tmp, to);
  } catch (e) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* removed at a later start */
    }
    throw e;
  } finally {
    inUse.delete(tmp);
  }
  retire(kind, from, to, copied, c, r, true);
}

/** After a copy: bring over late changes, then replace the old directory with
 * a link where allowed, else leave it as it was. */
function retire(kind: DirKind, from: string, to: string, m: Marker, c: Ctx, r: MigrationResult, first: boolean): void {
  const { fs } = c;
  const caught = catchUp(c, from, to, m, r.problems);
  const aside = `${from}.moved-to-${APP}`;
  let kept: string | undefined;
  const pid = kind === 'data' ? liveLock(fs, from, c.isAlive) : undefined;
  if (pid !== undefined) {
    // Someone started using the old directory during the copy. Moving it
    // aside now would hide what they write: it stays, and a later start
    // brings their changes over and finishes.
    if (caught.changed) writeMarker(fs, to, { ...m, files: caught.files });
    if (first) r.steps.push({ kind, from, to, how: 'copied', linked: false, kept: `${from} is still in use (pid ${pid}), so it stays where it is for now` });
    return;
  }
  if (!writable(fs, dirname(from)) || !writable(fs, from)) {
    kept = `${from} is read-only, so it was copied and left as it was`;
  } else if (lexists(fs, aside)) {
    kept = `${from} was copied and left as it was (${aside} is in the way)`;
  } else {
    try {
      fs.renameSync(from, aside);
      try {
        fs.symlinkSync(to, from, 'dir');
      } catch (e) {
        // (Fine if another process made that very link in between.)
        if (errCode(e) !== 'EEXIST' || real(fs, from) !== real(fs, to)) {
          fs.renameSync(aside, from); // keep the old path working
          throw e;
        }
      }
    } catch (e) {
      if (LOST_RACE.has(errCode(e))) throw e;
      kept = `${from} was copied and left as it was (${(e as Error).message})`;
    }
  }
  // (Without the lock, another process may have finished this very step, and said so.)
  if (readMarker(fs, to)?.how === 'done') return;
  writeMarker(fs, to, { from: m.from, to: m.to, at: c.now(), how: 'done', ...(kept ? { kept, files: caught.files } : {}) });
  r.steps.push({ kind, from, to, how: 'copied', linked: !kept, ...(kept ? { kept } : {}) });
}

/** Move parley's directories to taria's where needed. Never throws. */
export function migrateFromParley(opts: MigrateOptions = {}): MigrationResult {
  const c: Ctx = { fs: opts.fs ?? realFs, isAlive: opts.isAlive ?? defaultIsAlive, now: opts.now ?? Date.now, lockWaitMs: opts.lockWaitMs ?? LOCK_WAIT_MS };
  const { fs } = c;
  const r: MigrationResult = { steps: [], deferred: [], both: [], problems: [] };
  for (const kind of opts.kinds ?? DIR_KINDS) {
    if (dirIsExplicit(kind)) continue;
    const from = paths.legacyDir(kind);
    const to = paths[`${kind}Dir` as 'dataDir'];
    try {
      migrateOne(kind, from, to, c, r);
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
  const moved = r.steps.filter((s) => s.how === 'renamed' || s.how === 'copied');
  if (moved.length) {
    const list = moved.map((s) => `${tilde(s.from)} → ${tilde(s.to)}`).join(', ');
    const linked = moved.every((s) => s.linked);
    out.push(`parley is now ${APP}: moved your files (${list}).${linked ? ' The old paths point to the new ones, so an old parley still finds everything.' : ''}`);
    for (const s of moved) if (s.kept) out.push(`Note: ${s.kept}.`);
  }
  for (const s of r.steps) {
    if (s.how === 'shared') out.push(`parley is now ${APP}: ${tilde(s.from)} is your own link to ${tilde(s.target ?? '')}, so ${APP} uses that folder too, through a new link at ${tilde(s.to)}. Nothing was moved.`);
  }
  for (const d of r.deferred) out.push(`Your parley ${d.kind} files stay in ${tilde(d.using)} for now: ${d.reason}. They move to ${APP}'s folder the next time ${APP} starts after that.`);
  for (const b of r.both) out.push(`Both ${tilde(b.from)} and ${tilde(b.to)} exist; ${APP} uses ${tilde(b.to)}. \`${APP} doctor\` shows what is in each.`);
  for (const p of r.problems) out.push(`Migration: ${p}.`);
  return out;
}

/** What `taria doctor` says about one of parley's old folders. It only looks. */
export function oldFolderReport(old: string, current: string): { level: 'info' | 'warn'; text: string; hint?: string } | undefined {
  const fs = realFs;
  const st = lstat(fs, old);
  if (!st) return undefined;
  if (st.isSymbolicLink()) {
    // Say where the link really leads: not every link here was made by the move.
    const shown = `${old} → ${fs.readlinkSync(old)}`;
    const target = real(fs, old);
    const cur = lstat(fs, current);
    if (target === undefined) return { level: 'warn', text: `${shown} (a link to a folder that does not exist)`, hint: `Delete ${old} if you no longer need it.` };
    if (cur && target === real(fs, current)) return { level: 'info', text: cur.isSymbolicLink() ? `${shown} (your own link; ${current} leads to the same folder)` : `${shown} (a link, for an old parley)` };
    if (!cur) return { level: 'info', text: `${shown} (your own link); ${current} becomes a link to the same folder the next time ${APP} starts (doctor changes nothing)` };
    return { level: 'warn', text: `${shown} (your own link), which is not the folder ${APP} uses: ${current}`, hint: `Compare them. To use the old files, move ${current} away and start ${APP}.` };
  }
  if (fs.existsSync(current) && current !== old) return { level: 'warn', text: `${old} still exists next to ${current}; ${APP} uses ${current}`, hint: `Compare them, and delete ${old} when you no longer need it.` };
  return { level: 'info', text: `${old}: moves to ${current} the next time ${APP} starts (doctor changes nothing)` };
}
