// The migration from parley under the conditions a review found it wrong in:
// several taria processes starting at once, a kill -9 (not an exception) at
// every step, an old folder that is the user's own link, an old folder that
// has to be kept (a mount point) and is used alternately with taria, and the
// details of the copy (links inside the folder, modification times).
import * as fs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER, migrateFromParley, migrationNotices, oldFolderReport, type Fs } from '../../src/config/migrate.js';
import { DIR_KINDS, paths, setDirOverride } from '../../src/config/paths.js';

let home = '';
const saved: Record<string, string | undefined> = {};
const VARS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TARIA_CONFIG_DIR', 'TARIA_DATA_DIR', 'TARIA_STATE_DIR', 'TARIA_CACHE_DIR'];
const CONV = 'conversations/20260101-000000-abcd.jsonl';
const CONV2 = 'conversations/20250101-000000-ffff.jsonl';
const TEXT = '{"type":"meta","v":1,"id":"20260101-000000-abcd","createdAt":1,"app":"parley"}\n{"type":"message","id":"u1","parentId":null,"role":"user","content":[{"type":"text","text":"hello"}],"ts":1}\n';
const TEXT2 = '{"type":"meta","v":1,"id":"20250101-000000-ffff","createdAt":1,"app":"parley"}\n';
const EMPTY = { steps: [], deferred: [], both: [], problems: [] };

function setHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, 'config');
  process.env.XDG_DATA_HOME = join(dir, 'data');
  process.env.XDG_STATE_HOME = join(dir, 'state');
  process.env.XDG_CACHE_HOME = join(dir, 'cache');
  for (const k of DIR_KINDS) setDirOverride(k, undefined);
}
function oldData(dir: string): void {
  mkdirSync(join(dir, 'data/parley/conversations'), { recursive: true });
  writeFileSync(join(dir, 'data/parley', CONV), TEXT);
  writeFileSync(join(dir, 'data/parley/history.jsonl'), 'h\n');
}
const readOrNull = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const isLink = (p: string) => lstatSync(p).isSymbolicLink();
const code = (c: string) => Object.assign(new Error(c), { code: c });
/** The pid of a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

/** The old data folder is a mount point: it can be neither renamed nor moved aside, so it is copied and kept. */
function mountPoint(base = home): Fs {
  const from = join(base, 'data/parley');
  return {
    ...fs,
    renameSync: (a: fs.PathLike, b: fs.PathLike) => {
      if (String(a) === from) throw code('EBUSY');
      fs.renameSync(a, b);
    },
  };
}
/** The old data folder cannot be renamed to the new name (another file system), so it is copied. */
function otherDisk(base = home): Fs {
  return {
    ...fs,
    renameSync: (a: fs.PathLike, b: fs.PathLike) => {
      if (String(a) === join(base, 'data/parley') && String(b) === join(base, 'data/taria')) throw code('EXDEV');
      fs.renameSync(a, b);
    },
  };
}
/** One start of taria (the migration only), with the per-run directory choice reset. */
function start(o: Parameters<typeof migrateFromParley>[0] = {}): ReturnType<typeof migrateFromParley> {
  setDirOverride('data', undefined);
  return migrateFromParley({ kinds: ['data'], ...o });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'taria-review-')));
  for (const v of VARS) saved[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
  setHome(home);
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  for (const k of DIR_KINDS) setDirOverride(k, undefined);
});

describe('several taria processes start at once (F1, F9)', () => {
  it('an empty taria folder is never removed recursively: a taria that finishes the move just before this one removes it loses nothing', () => {
    oldData(home);
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true }); // an empty taria folder
    const to = join(home, 'data/taria');
    let interleaved = false;
    const other = (p: fs.PathLike) => {
      if (interleaved || (String(p) !== to && !String(p).startsWith(to + '/'))) return;
      interleaved = true;
      // Process A runs here, start to finish, with the real file system.
      const a = migrateFromParley({ kinds: ['data'] });
      expect(a.problems).toEqual([]);
      expect(readFileSync(join(to, CONV), 'utf8')).toBe(TEXT); // A moved the conversation into data/taria
    };
    const procB: Fs = {
      ...fs,
      rmSync: (p: fs.PathLike, o?: fs.RmOptions) => {
        other(p);
        expect(String(p), 'the folder taria uses is never removed with its contents').not.toBe(to);
        return fs.rmSync(p, o);
      },
      rmdirSync: (p: fs.PathLike, o?: fs.RmDirOptions) => {
        other(p);
        expect(o?.recursive, 'only empty folders are removed').toBeFalsy();
        return fs.rmdirSync(p, o);
      },
    };
    const b = migrateFromParley({ fs: procB, kinds: ['data'] });
    expect(interleaved).toBe(true);
    expect(readOrNull(join(to, CONV))).toBe(TEXT);
    expect(readOrNull(join(home, 'data/parley', CONV))).toBe(TEXT);
    expect(readOrNull(join(to, 'history.jsonl'))).toBe('h\n');
    expect(isLink(join(home, 'data/parley'))).toBe(true);
    expect(b.problems).toEqual([]);
    expect(migrationNotices(b)).toEqual([]); // the other process did the move and said so
    expect(readdirSync(join(home, 'data')).sort()).toEqual(['parley', 'taria']);
  });

  // Process B makes its file-system calls one at a time; before its k-th call
  // (reads included) process A runs from start to finish. Whatever k is, the
  // conversation must be complete at both paths and B must not complain.
  for (const scenario of ['plain', 'empty-taria', 'copy', 'copy+empty-taria', 'kept'] as const) {
    it(`another taria finishing the move between any two steps of this one loses nothing and causes no message (${scenario})`, () => {
      const names = (Object.keys(fs) as Array<keyof typeof fs>).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function');
      let covered = false;
      for (let k = 1; k <= 400 && !covered; k++) {
        const base = join(home, `run-${k}`);
        setHome(base);
        oldData(base);
        if (scenario.includes('empty-taria')) mkdirSync(join(base, 'data/taria/conversations'), { recursive: true });
        const real = scenario === 'kept' ? mountPoint(base) : scenario.startsWith('copy') ? otherDisk(base) : fs;
        let calls = 0;
        let a: ReturnType<typeof migrateFromParley> | undefined;
        const procB = { ...real } as unknown as Record<string, (...x: unknown[]) => unknown>;
        for (const name of names) {
          const call = (real as unknown as typeof procB)[name]!;
          procB[name] = (...x: unknown[]) => {
            if (++calls === k) a = migrateFromParley({ fs: real, kinds: ['data'] });
            return call(...x);
          };
        }
        const b = migrateFromParley({ fs: procB as unknown as Fs, kinds: ['data'] });
        if (!a) {
          covered = true; // k went past B's last call
          break;
        }
        const where = `A ran before call ${k} of B`;
        expect(readOrNull(join(base, 'data/taria', CONV)), where).toBe(TEXT);
        expect(readOrNull(join(base, 'data/parley', CONV)), where).toBe(TEXT);
        expect(readOrNull(join(base, 'data/taria/history.jsonl')), where).toBe('h\n');
        expect([...a.problems, ...b.problems], where).toEqual([]);
        expect([...a.deferred, ...b.deferred, ...a.both, ...b.both], where).toEqual([]);
        // One of them reports the move. (After a copy, both can finish the last
        // step at once here, where A ignores B's lock: then both say so.)
        const reports = [...a.steps, ...b.steps].filter((s) => s.how !== 'linked').length;
        expect(reports, where).toBeGreaterThanOrEqual(1);
        expect(reports, where).toBeLessThanOrEqual(scenario === 'plain' || scenario === 'empty-taria' ? 1 : 2);
        // Nothing half-made is left behind.
        expect(readdirSync(join(base, 'data')).filter((n) => !['parley', 'taria', 'parley.moved-to-taria'].includes(n)), where).toEqual([]);
        // The next start has nothing to do and nothing to say.
        setDirOverride('data', undefined);
        expect(migrateFromParley({ fs: real, kinds: ['data'] }), where).toEqual(EMPTY);
        expect(readOrNull(join(base, 'data/taria', CONV)), where).toBe(TEXT);
      }
      expect(covered).toBe(true);
    });
  }

  it('while another live process holds the migration lock, this one waits; if that takes too long it uses the old folder for this run and says why', () => {
    oldData(home);
    const lock = join(home, 'data/.taria-migration.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.ppid }));
    const r = start({ lockWaitMs: 60 });
    expect(r.steps).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.deferred).toEqual([{ kind: 'data', reason: 'another taria is moving them right now', using: join(home, 'data/parley') }]);
    expect(paths.dataDir).toBe(join(home, 'data/parley'));
    expect(existsSync(join(home, 'data/taria'))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(JSON.stringify({ pid: process.ppid })); // not ours to remove
    // The other process is done: the next start moves the files.
    rmSync(lock);
    expect(start().steps).toHaveLength(1);
    expect(readOrNull(join(home, 'data/taria', CONV))).toBe(TEXT);
  });

  it('the lock of a process that was killed does not hold the move up, and no lock is left behind', () => {
    oldData(home);
    writeFileSync(join(home, 'data/.taria-migration.lock'), JSON.stringify({ pid: deadPid(), started: Date.now() }));
    const r = start({ lockWaitMs: 60 });
    expect(r.deferred).toEqual([]);
    expect(r.steps).toHaveLength(1);
    expect(readdirSync(join(home, 'data')).sort()).toEqual(['parley', 'taria']);
  });

  it('a parley (or a taria that could not wait) that opens a conversation in the old folder during the copy: the folder is not moved aside under it', () => {
    oldData(home);
    const from = join(home, 'data/parley');
    let opened = false;
    const disk = otherDisk();
    const during: Fs = {
      ...disk,
      copyFileSync: (a: fs.PathLike, b: fs.PathLike, m?: number) => {
        fs.copyFileSync(a, b, m);
        if (opened) return;
        opened = true;
        writeFileSync(join(from, 'conversations/new.jsonl'), 'started during the copy\n');
        writeFileSync(join(from, 'conversations/new.jsonl.lock'), JSON.stringify({ pid: 4242 }));
      },
    };
    const r = start({ fs: during, isAlive: (pid) => pid === 4242 });
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([expect.objectContaining({ how: 'copied', linked: false, kept: expect.stringMatching(/still in use \(pid 4242\)/) })]);
    expect(isLink(from)).toBe(false);
    expect(existsSync(from + '.moved-to-taria')).toBe(false);
    // It writes more, then exits; the next start brings everything over and finishes.
    fs.appendFileSync(join(from, 'conversations/new.jsonl'), 'and more\n');
    rmSync(join(from, 'conversations/new.jsonl.lock'));
    const next = start({ fs: disk, isAlive: () => false });
    expect(next.problems).toEqual([]);
    expect(next.steps).toEqual([expect.objectContaining({ how: 'copied', linked: true })]);
    expect(readOrNull(join(home, 'data/taria/conversations/new.jsonl'))).toBe('started during the copy\nand more\n');
    expect(isLink(from)).toBe(true);
    expect(start()).toEqual(EMPTY);
  });

  it('a lock that can be neither read nor removed does not make a start hang, or stop the move', () => {
    oldData(home);
    const lock = join(home, 'data/.taria-migration.lock');
    writeFileSync(lock, JSON.stringify({ pid: deadPid() }));
    for (const unreadable of [true, false]) {
      const stuck: Fs = {
        ...fs,
        readFileSync: ((p: fs.PathOrFileDescriptor, o?: unknown) => {
          if (unreadable && String(p) === lock) throw code('EACCES');
          return (fs.readFileSync as (...x: unknown[]) => unknown)(p, o);
        }) as Fs['readFileSync'],
        renameSync: (a: fs.PathLike, b: fs.PathLike) => {
          if (String(a) === lock) throw code('EPERM');
          fs.renameSync(a, b);
        },
      };
      const t = Date.now();
      const r = start({ fs: stuck, lockWaitMs: 5000 });
      expect(Date.now() - t).toBeLessThan(2000);
      expect(r.problems).toEqual([]);
      expect(r.steps).toHaveLength(1);
      expect(readOrNull(join(home, 'data/taria', CONV))).toBe(TEXT);
      // Back to the start for the second round.
      rmSync(join(home, 'data/parley'));
      renameSync(join(home, 'data/taria'), join(home, 'data/parley'));
      rmSync(join(home, 'data/parley', MARKER));
    }
  });

  it("a half-finished copy of another process that is still running is not deleted; one of a process that is gone is", () => {
    oldData(home);
    const live = join(home, `data/.taria-migrating-taria-${process.ppid}-abc`);
    const dead = join(home, `data/.taria-migrating-taria-${deadPid()}-abc`);
    for (const d of [live, dead]) {
      mkdirSync(d);
      writeFileSync(join(d, 'history.jsonl'), 'h\n');
    }
    const r = start({ fs: otherDisk() });
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([expect.objectContaining({ how: 'copied', linked: true })]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it("a regular file at taria's path: said plainly, the old folder is used for this run, nothing is touched", () => {
    oldData(home);
    writeFileSync(join(home, 'data/taria'), 'oops\n');
    const r = start();
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.deferred).toEqual([{ kind: 'data', reason: '~/data/taria is a file, not a folder (move it out of the way)', using: join(home, 'data/parley') }]);
    expect(paths.dataDir).toBe(join(home, 'data/parley'));
    expect(readFileSync(join(home, 'data/taria'), 'utf8')).toBe('oops\n');
    expect(readOrNull(join(home, 'data/parley', CONV))).toBe(TEXT);
    expect(migrationNotices(r).join('\n')).toMatch(/^Your parley data files stay in ~\/data\/parley for now: ~\/data\/taria is a file, not a folder/);
  });

  it("the folder taria's folder would be made in is read-only: said plainly, the old folder is used for this run", () => {
    oldData(home);
    const parent = join(home, 'data');
    const readOnly: Fs = {
      ...fs,
      accessSync: (p: fs.PathLike, mode?: number) => {
        if (String(p) === parent && mode === fs.constants.W_OK) throw code('EROFS');
        fs.accessSync(p, mode);
      },
      writeFileSync: ((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).startsWith(parent + '/.')) throw code('EROFS');
        return (fs.writeFileSync as (...x: unknown[]) => void)(p, ...rest);
      }) as Fs['writeFileSync'],
      mkdirSync: ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
        if (String(p).startsWith(parent + '/.')) throw code('ENOENT'); // what Node reports for a recursive mkdir there
        return fs.mkdirSync(p, o);
      }) as Fs['mkdirSync'],
      renameSync: (a: fs.PathLike, b: fs.PathLike) => {
        if (String(a) === join(parent, 'parley')) throw code('EROFS');
        fs.renameSync(a, b);
      },
    };
    const r = start({ fs: readOnly });
    expect(r.problems).toEqual([]);
    expect(r.deferred).toEqual([{ kind: 'data', reason: "~/data is read-only, so taria's folder cannot be made there", using: join(home, 'data/parley') }]);
    expect(readdirSync(parent)).toEqual(['parley']);
    expect(readOrNull(join(parent, 'parley', CONV))).toBe(TEXT);
  });

  it("a dangling link at taria's path: said plainly, the old folder is used for this run", () => {
    oldData(home);
    symlinkSync(join(home, 'nowhere'), join(home, 'data/taria'));
    const r = start();
    expect(r.problems).toEqual([]);
    expect(r.deferred).toEqual([{ kind: 'data', reason: '~/data/taria is a link to ~/nowhere, which does not exist', using: join(home, 'data/parley') }]);
    expect(readlinkSync(join(home, 'data/taria'))).toBe(join(home, 'nowhere'));
  });
});

describe("the old folder is the user's own link (F2)", () => {
  function linkedElsewhere(): string {
    oldData(home);
    const target = join(home, 'bigdisk/parley-data');
    mkdirSync(join(home, 'bigdisk'));
    renameSync(join(home, 'data/parley'), target);
    symlinkSync(target, join(home, 'data/parley'));
    return target;
  }
  const listing = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort();

  it("taria's path becomes a link to the same folder; the user's link and the folder are left exactly as they were, and the user is told", () => {
    const target = linkedElsewhere();
    const before = listing(target);
    const r = start();
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([{ kind: 'data', from: join(home, 'data/parley'), to: join(home, 'data/taria'), how: 'shared', linked: true, target }]);
    expect(isLink(join(home, 'data/taria'))).toBe(true);
    expect(realpathSync(join(home, 'data/taria'))).toBe(target);
    expect(readlinkSync(join(home, 'data/parley'))).toBe(target);
    expect(listing(target)).toEqual(before); // nothing written into the user's folder
    expect(readOrNull(join(home, 'data/taria', CONV))).toBe(TEXT);
    expect(migrationNotices(r)).toEqual([`parley is now taria: ~/data/parley is your own link to ~/bigdisk/parley-data, so taria uses that folder too, through a new link at ~/data/taria. Nothing was moved.`]);
    // The next start has nothing to do.
    expect(start()).toEqual(EMPTY);
  });

  it('an empty taria folder (made by a taria that did not see the files) is replaced by the link', () => {
    const target = linkedElsewhere();
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true });
    const r = start();
    expect(r.steps.map((s) => s.how)).toEqual(['shared']);
    expect(realpathSync(join(home, 'data/taria'))).toBe(target);
  });

  it('a taria folder with files in it is kept and used, and the user is told that both exist', () => {
    const target = linkedElsewhere();
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true });
    writeFileSync(join(home, 'data/taria/conversations/new.jsonl'), 'x\n');
    const r = start();
    expect(r.steps).toEqual([]);
    expect(r.both).toEqual([{ kind: 'data', from: join(home, 'data/parley'), to: join(home, 'data/taria') }]);
    expect(isLink(join(home, 'data/taria'))).toBe(false);
    expect(readlinkSync(join(home, 'data/parley'))).toBe(target);
    expect(readOrNull(join(target, CONV))).toBe(TEXT);
  });

  it('a link that leads nowhere: the user is told, and nothing is created', () => {
    mkdirSync(join(home, 'data'));
    symlinkSync(join(home, 'nowhere'), join(home, 'data/parley'));
    const r = start();
    expect(r.steps).toEqual([]);
    expect(migrationNotices(r)).toEqual(['Migration: ~/data/parley is a link to ~/nowhere, which does not exist, so there are no parley data files to bring over. Delete the link if you no longer need it.']);
    expect(readdirSync(join(home, 'data'))).toEqual(['parley']);
    expect(readlinkSync(join(home, 'data/parley'))).toBe(join(home, 'nowhere'));
  });

  it('doctor names the real target of the link', () => {
    const target = linkedElsewhere();
    const old = join(home, 'data/parley');
    const current = join(home, 'data/taria');
    // The user's link, before taria has made its own.
    expect(oldFolderReport(old, current)).toEqual({ level: 'info', text: `${old} → ${target} (your own link); ${current} becomes a link to the same folder the next time taria starts (doctor changes nothing)` });
    // Next to an unrelated taria folder.
    mkdirSync(join(current, 'conversations'), { recursive: true });
    writeFileSync(join(current, 'conversations/new.jsonl'), 'x\n');
    expect(oldFolderReport(old, current)).toEqual({ level: 'warn', text: `${old} → ${target} (your own link), which is not the folder taria uses: ${current}`, hint: expect.stringContaining(current) });
    rmSync(current, { recursive: true });
    // Both lead to the same folder.
    start();
    expect(oldFolderReport(old, current)).toEqual({ level: 'info', text: `${old} → ${target} (your own link; ${current} leads to the same folder)` });
    // A link that leads nowhere.
    rmSync(old);
    symlinkSync(join(home, 'nowhere'), old);
    expect(oldFolderReport(old, current)).toEqual({ level: 'warn', text: `${old} → ${join(home, 'nowhere')} (a link to a folder that does not exist)`, hint: expect.any(String) });
  });

  it('doctor: the link the migration made, a plain old folder, and no old folder', () => {
    const old = join(home, 'data/parley');
    const current = join(home, 'data/taria');
    expect(oldFolderReport(old, current)).toBeUndefined();
    oldData(home);
    expect(oldFolderReport(old, current)).toEqual({ level: 'info', text: `${old}: moves to ${current} the next time taria starts (doctor changes nothing)` });
    start();
    expect(oldFolderReport(old, current)).toEqual({ level: 'info', text: `${old} → ${current} (a link, for an old parley)` });
  });
});

describe('the old folder had to be kept and is still used by an old parley (F3)', () => {
  const OLD = () => join(home, 'data/parley');
  const NEW = () => join(home, 'data/taria');
  /** parley's files, copied by the first start of taria; the old folder stays. */
  function copiedAndKept(): void {
    oldData(home);
    writeFileSync(join(OLD(), CONV2), TEXT2);
    mkdirSync(join(OLD(), 'drafts'));
    writeFileSync(join(OLD(), 'drafts/new.json'), '{"text":"unsent"}');
    writeFileSync(join(OLD(), 'state.json'), '{"recentModels":["a"]}');
    // Files from the past, so that a change made "now" is always a change of the modification time.
    for (const f of [CONV, CONV2, 'drafts/new.json', 'state.json', 'history.jsonl']) utimesSync(join(OLD(), f), 1_700_000_000, 1_700_000_000);
    const r = start({ fs: mountPoint() });
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([expect.objectContaining({ how: 'copied', linked: false })]);
    expect(isLink(OLD())).toBe(false);
  }
  const again = () => start({ fs: mountPoint() });

  it('a conversation trashed in taria and a draft cleared in taria do not come back', () => {
    copiedAndKept();
    mkdirSync(join(NEW(), 'trash'));
    renameSync(join(NEW(), CONV2), join(NEW(), 'trash/20250101-000000-ffff.jsonl'));
    rmSync(join(NEW(), 'drafts/new.json'));
    expect(again()).toEqual(EMPTY);
    expect(existsSync(join(NEW(), CONV2))).toBe(false);
    expect(existsSync(join(NEW(), 'drafts/new.json'))).toBe(false);
    expect(again()).toEqual(EMPTY);
  });

  it('a file an old parley creates later is copied once; deleted in taria afterwards, it stays deleted', () => {
    copiedAndKept();
    writeFileSync(join(OLD(), 'conversations/later.jsonl'), 'later\n');
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), 'conversations/later.jsonl'))).toBe('later\n');
    rmSync(join(NEW(), 'conversations/later.jsonl'));
    expect(again()).toEqual(EMPTY);
    expect(existsSync(join(NEW(), 'conversations/later.jsonl'))).toBe(false);
  });

  it('lines an old parley appends are carried over on every later start, while taria has not changed its copy', () => {
    copiedAndKept();
    fs.appendFileSync(join(OLD(), CONV), 'ONE\n');
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'ONE\n');
    fs.appendFileSync(join(OLD(), CONV), 'TWO\n');
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'ONE\nTWO\n');
    // ...and the copy keeps the time of the last change in parley, not of the copy.
    expect(Math.abs(statSync(join(NEW(), CONV)).mtimeMs - statSync(join(OLD(), CONV)).mtimeMs)).toBeLessThan(2);
  });

  it('a conversation taria continued is not a difference: the old file did not change', () => {
    copiedAndKept();
    fs.appendFileSync(join(NEW(), CONV), 'TARIA\n');
    writeFileSync(join(NEW(), 'state.json'), '{"recentModels":["b","a"]}');
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'TARIA\n');
  });

  it('both sides added to a conversation: both files are kept, and it is said once per change of the old file, not on every start', () => {
    copiedAndKept();
    fs.appendFileSync(join(NEW(), CONV), 'TARIA wrote a long reply here\n');
    fs.appendFileSync(join(OLD(), CONV), 'PARLEY\n'); // shorter than taria's file: 0.3.0 said nothing at all
    const r = again();
    expect(r.problems).toEqual([`${CONV} changed in ~/data/parley after taria copied it, and no longer fits taria's own copy in ~/data/taria. Both files are kept as they are; taria uses its own`]);
    expect(migrationNotices(r)).toEqual([`Migration: ${r.problems[0]}.`]);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'TARIA wrote a long reply here\n');
    expect(readOrNull(join(OLD(), CONV))).toBe(TEXT + 'PARLEY\n');
    expect(again()).toEqual(EMPTY);
    expect(again()).toEqual(EMPTY);
    // parley goes on until its file is the longer one: said once more, still nothing rewritten.
    fs.appendFileSync(join(OLD(), CONV), 'PARLEY more and more and more text than taria has\n');
    expect(again().problems).toHaveLength(1);
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'TARIA wrote a long reply here\n');
  });

  it('an old file rewritten to the same size is noticed; a file that is not a log is never overwritten or appended to', () => {
    copiedAndKept();
    writeFileSync(join(OLD(), 'state.json'), '{"recentModels":["z"]}'); // same length as before
    const r = again();
    expect(r.problems).toEqual([expect.stringMatching(/^state\.json changed in ~\/data\/parley after taria copied it/)]);
    expect(readOrNull(join(NEW(), 'state.json'))).toBe('{"recentModels":["a"]}');
    expect(again()).toEqual(EMPTY);
  });

  it("taria's newer file is never overwritten, even when it is the beginning of the old one", () => {
    copiedAndKept();
    // The user shortened the file in taria; later the old one gets a line added.
    writeFileSync(join(NEW(), 'state.json'), '{"recentModels"');
    fs.appendFileSync(join(OLD(), 'state.json'), '\n');
    expect(again().problems).toEqual([expect.stringMatching(/^state\.json changed/)]);
    expect(readOrNull(join(NEW(), 'state.json'))).toBe('{"recentModels"');
  });

  it('several files that differ are named in one line', () => {
    copiedAndKept();
    for (const f of [CONV, CONV2, 'history.jsonl', 'state.json', 'drafts/new.json']) {
      writeFileSync(join(NEW(), f), 'taria\n');
      writeFileSync(join(OLD(), f), 'parley!\n');
    }
    const r = again();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^5 files changed in ~\/data\/parley after taria copied them, and no longer fit taria's own copies in ~\/data\/taria \(.*, .*, .* and 2 more\)\. All are kept as they are; taria uses its own$/);
    expect(again()).toEqual(EMPTY);
  });

  it('a conversation that is open in a running taria is not appended to; the lines come over at a later start', () => {
    copiedAndKept();
    fs.appendFileSync(join(OLD(), CONV), 'ONE\n');
    writeFileSync(join(NEW(), CONV + '.lock'), JSON.stringify({ pid: 4242 }));
    expect(start({ fs: mountPoint(), isAlive: (pid) => pid === 4242 })).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT);
    rmSync(join(NEW(), CONV + '.lock'));
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'ONE\n');
  });

  it('a folder copied by taria 0.3.0 (no record of what was copied): nothing deleted in taria comes back, nothing is reported, later lines still arrive', () => {
    copiedAndKept();
    const marker = JSON.parse(readFileSync(join(NEW(), MARKER), 'utf8')) as Record<string, unknown>;
    expect(marker.how).toBe('done');
    expect(Object.keys(marker.files as object).sort()).toEqual([CONV2, CONV, 'drafts/new.json', 'history.jsonl', 'state.json'].sort());
    delete marker.files;
    writeFileSync(join(NEW(), MARKER), JSON.stringify(marker) + '\n');
    // Since then, in taria: one conversation trashed, one continued, the draft sent.
    rmSync(join(NEW(), CONV2));
    rmSync(join(NEW(), 'drafts/new.json'));
    fs.appendFileSync(join(NEW(), CONV), 'TARIA\n');
    expect(again()).toEqual(EMPTY);
    expect(existsSync(join(NEW(), CONV2))).toBe(false);
    expect(existsSync(join(NEW(), 'drafts/new.json'))).toBe(false);
    expect(readOrNull(join(NEW(), CONV))).toBe(TEXT + 'TARIA\n');
    // An old parley uses the other conversation: its lines arrive (the file is recreated, since the old one changed).
    fs.appendFileSync(join(OLD(), CONV2), 'PARLEY\n');
    fs.appendFileSync(join(OLD(), 'history.jsonl'), 'h2\n');
    expect(again()).toEqual(EMPTY);
    expect(readOrNull(join(NEW(), CONV2))).toBe(TEXT2 + 'PARLEY\n');
    expect(readOrNull(join(NEW(), 'history.jsonl'))).toBe('h\nh2\n');
    expect(again()).toEqual(EMPTY);
  });
});

describe('what a copy brings over (F4, F5)', () => {
  it('links inside the folder arrive as links (a stow-style file link, a folder kept on another disk)', () => {
    const top = home;
    for (const kind of ['other-disk', 'mount-point']) {
      home = join(top, kind);
      setHome(home);
      oldData(home);
      mkdirSync(join(home, 'dotfiles'));
      mkdirSync(join(home, 'bigdisk/attachments'), { recursive: true });
      writeFileSync(join(home, 'dotfiles/state.json'), '{"recentModels":[]}');
      writeFileSync(join(home, 'bigdisk/attachments/abc.png'), 'PNGDATA');
      symlinkSync(join(home, 'dotfiles/state.json'), join(home, 'data/parley/state.json'));
      symlinkSync(join(home, 'bigdisk/attachments'), join(home, 'data/parley/attachments'));
      symlinkSync('history.jsonl', join(home, 'data/parley/history-link')); // a relative link
      const disk = kind === 'other-disk' ? otherDisk() : mountPoint();
      const r = start({ fs: disk });
      expect(r.problems).toEqual([]);
      expect(r.steps).toEqual([expect.objectContaining({ how: 'copied', linked: kind === 'other-disk' })]);
      const to = join(home, 'data/taria');
      expect(readlinkSync(join(to, 'state.json'))).toBe(join(home, 'dotfiles/state.json'));
      expect(readlinkSync(join(to, 'attachments'))).toBe(join(home, 'bigdisk/attachments'));
      expect(readlinkSync(join(to, 'history-link'))).toBe('history.jsonl');
      expect(readOrNull(join(to, 'state.json'))).toBe('{"recentModels":[]}');
      expect(readOrNull(join(to, 'attachments/abc.png'))).toBe('PNGDATA');
      expect(readOrNull(join(to, 'history-link'))).toBe('h\n');
      expect(start({ fs: disk })).toEqual(EMPTY);
    }
  });

  it('copied files keep their modification time, so the most recently used conversation stays the most recent', () => {
    oldData(home);
    writeFileSync(join(home, 'data/parley', CONV2), TEXT2);
    const yesterday = Math.floor(Date.now() / 1000) - 86_400;
    utimesSync(join(home, 'data/parley', CONV2), yesterday, yesterday);
    utimesSync(join(home, 'data/parley', CONV), 1_700_000_000, 1_700_000_000);
    start({ fs: mountPoint() });
    expect(statSync(join(home, 'data/taria', CONV2)).mtimeMs).toBe(yesterday * 1000);
    expect(statSync(join(home, 'data/taria', CONV)).mtimeMs).toBe(1_700_000_000_000);
    // A file copied at a later start, too.
    writeFileSync(join(home, 'data/parley/conversations/later.jsonl'), 'later\n');
    utimesSync(join(home, 'data/parley/conversations/later.jsonl'), 1_750_000_000, 1_750_000_000);
    start({ fs: mountPoint() });
    expect(statSync(join(home, 'data/taria/conversations/later.jsonl')).mtimeMs).toBe(1_750_000_000_000);
  });
});

describe('a lock file left by a parley that is gone (F6)', () => {
  it('a lock whose pid now belongs to another process (it started at another time) does not hold the move up', () => {
    oldData(home);
    // The pid is alive (the test runner's parent), but the lock says its holder started long before that process did.
    // (Longer ago than this test run has lasted, so it cannot be the parent's real start time.)
    for (const ago of [30 * 86_400_000, 3_600_000]) {
      writeFileSync(join(home, 'data/parley', CONV + '.lock'), JSON.stringify({ pid: process.ppid, started: Math.round(Date.now() - process.uptime() * 1000 - ago) }));
      const r = start();
      expect(r.deferred, `started ${ago} ms before`).toEqual([]);
      expect(r.steps).toHaveLength(1);
      rmSync(join(home, 'data/parley'));
      renameSync(join(home, 'data/taria'), join(home, 'data/parley'));
      rmSync(join(home, 'data/parley', MARKER));
    }
  });

  it('a lock of a live process without a start time (parley 0.0.1) still makes the move wait; this process itself never counts', () => {
    oldData(home);
    writeFileSync(join(home, 'data/parley', CONV + '.lock'), String(process.ppid));
    expect(start().deferred).toEqual([{ kind: 'data', reason: `parley (pid ${process.ppid}) has a conversation open`, using: join(home, 'data/parley') }]);
    // The test process itself cannot hold a parley lock: its own pid never counts.
    writeFileSync(join(home, 'data/parley', CONV + '.lock'), JSON.stringify({ pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000) }));
    expect(start().deferred).toEqual([]);
  });
});

describe('a process killed outright (F7, F8)', () => {
  it('kill -9 at every step (every later call fails too, so no clean-up runs): the next starts finish the job, at both paths', () => {
    const writes = ['renameSync', 'symlinkSync', 'writeFileSync', 'mkdirSync', 'copyFileSync', 'chmodSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'utimesSync', 'linkSync', 'unlinkSync'] as const;
    for (const disk of ['same', 'other', 'other+empty-taria', 'same+empty-taria'] as const) {
      const bad: string[] = [];
      let covered = false;
      for (let n = 1; n <= 200 && !covered; n++) {
        const base = join(home, `run-${disk}-${n}`);
        setHome(base);
        oldData(base);
        if (disk.includes('empty-taria')) mkdirSync(join(base, 'data/taria/conversations'), { recursive: true });
        let calls = 0;
        let dead = false;
        let diedIn = '';
        const killed: Fs = { ...fs };
        for (const w of writes) {
          (killed as unknown as Record<string, unknown>)[w] = (...a: unknown[]) => {
            if (dead) throw new Error('process is dead');
            if (++calls === n) {
              dead = true;
              diedIn = `${w}(${a.slice(0, 2).map((x) => String(x).replace(base, '')).join(', ')})`;
              throw new Error('killed');
            }
            // The old directory cannot be renamed straight to the new name (EXDEV), so it is copied.
            if (w === 'renameSync' && disk.startsWith('other') && String(a[0]).endsWith('/data/parley') && String(a[1]).endsWith('/data/taria')) throw code('EXDEV');
            return (fs[w] as (...x: unknown[]) => unknown)(...a);
          };
        }
        migrateFromParley({ fs: killed, kinds: ['data'] });
        if (!dead) covered = true;
        const somewhere = ['taria', 'parley', 'parley.moved-to-taria'].some((d) => readOrNull(join(base, 'data', d, CONV)) === TEXT);
        expect(somewhere, `after a kill in ${diedIn}`).toBe(true);
        setDirOverride('data', undefined);
        const r1 = migrateFromParley({ kinds: ['data'] }); // the next start
        setDirOverride('data', undefined);
        const r2 = migrateFromParley({ kinds: ['data'] }); // and the one after
        const viaNew = readOrNull(join(base, 'data/taria', CONV));
        const viaOld = readOrNull(join(base, 'data/parley', CONV));
        const left = readdirSync(join(base, 'data')).filter((x) => !['parley', 'taria', 'parley.moved-to-taria'].includes(x));
        const inside = readdirSync(join(base, 'data/taria')).filter((x) => x.startsWith(MARKER) && x !== MARKER);
        if (viaNew !== TEXT || viaOld !== TEXT || r1.problems.length || r2.problems.length || r2.steps.length || left.length || inside.length) {
          bad.push(`kill at call ${n} ${diedIn}: new path ${viaNew === TEXT ? 'ok' : 'MISSING'}, old path ${viaOld === TEXT ? 'ok' : 'MISSING'}; data/ = ${readdirSync(join(base, 'data')).join(' ')}; left in taria/: ${inside.join(' ')}; notices on reruns = ${JSON.stringify([...migrationNotices(r1), ...migrationNotices(r2)])}`);
        }
      }
      expect(bad, disk).toEqual([]);
      expect(covered, disk).toBe(true);
    }
  });

  it('a kill while the marker is being written never leaves an empty marker: later lines of an old parley still arrive', () => {
    oldData(home);
    const from = join(home, 'data/parley');
    const to = join(home, 'data/taria');
    let markerWrites = 0;
    const procA: Fs = {
      ...mountPoint(),
      writeFileSync: ((p: fs.PathOrFileDescriptor, d: string, o?: fs.WriteFileOptions) => {
        if (String(p).startsWith(join(to, MARKER)) && ++markerWrites === 1) {
          fs.writeFileSync(p, ''); // open(O_TRUNC) happened, the write did not
          throw new Error('killed');
        }
        fs.writeFileSync(p, d, o);
      }) as typeof fs.writeFileSync,
    };
    migrateFromParley({ fs: procA, kinds: ['data'] });
    expect(markerWrites).toBe(1);
    expect((JSON.parse(readFileSync(join(to, MARKER), 'utf8')) as { how: string }).how).toBe('copied');
    // An old parley appends a turn in the old folder; taria starts again.
    fs.appendFileSync(join(from, CONV), 'LATER\n');
    const r = start({ fs: mountPoint() });
    expect(r.both).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(readFileSync(join(to, CONV), 'utf8')).toBe(TEXT + 'LATER\n');
    expect(readdirSync(to).filter((x) => x.startsWith(MARKER))).toEqual([MARKER]);
  });
});
