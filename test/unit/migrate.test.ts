// Moving parley's files to taria's directories: every state the user can be
// in, an interruption at every step, and a parley that is still running.
import * as fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER, migrateFromParley, migrationNotices, type Fs } from '../../src/config/migrate.js';
import { paths, setDirOverride, DIR_KINDS } from '../../src/config/paths.js';
import { Store } from '../../src/core/store.js';

let home = '';
const saved: Record<string, string | undefined> = {};
const VARS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TARIA_CONFIG_DIR', 'TARIA_DATA_DIR', 'TARIA_STATE_DIR', 'TARIA_CACHE_DIR'];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'taria-migrate-')));
  for (const v of VARS) saved[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  process.env.XDG_DATA_HOME = join(home, 'data');
  process.env.XDG_STATE_HOME = join(home, 'state');
  process.env.XDG_CACHE_HOME = join(home, 'cache');
  for (const k of DIR_KINDS) setDirOverride(k, undefined);
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  for (const k of DIR_KINDS) setDirOverride(k, undefined);
  try {
    chmodSync(join(home, 'data', 'parley'), 0o755);
  } catch {
    /* not there */
  }
});

const CONV = '20260101-000000-abcd';
const LINES = [
  { type: 'meta', v: 1, id: CONV, createdAt: 1, app: 'parley' },
  { type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hello' }], ts: 1 },
  { type: 'message', id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'text', text: 'hi there' }], ts: 2 },
];

/** What parley 0.2.0 leaves on disk. */
function oldInstall(): Record<string, string> {
  const files: Record<string, string> = {
    'config/parley/config.yaml': 'default_model: mock/echo\nproviders:\n  mock:\n    type: mock\n',
    'config/parley/credentials': '# parley credentials\nlocal = sk-test-not-a-real-key\n',
    'config/parley/commands/review.md': 'Review $ARGUMENTS\n',
    [`data/parley/conversations/${CONV}.jsonl`]: LINES.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'data/parley/drafts/new.json': JSON.stringify({ text: 'unsent', pastes: [], attachments: [], counters: { paste: 0, image: 0, file: 0 } }),
    'data/parley/history.jsonl': '{"text":"hello","ts":1}\n',
    'data/parley/state.json': '{"recentModels":["mock/echo"],"favouriteModels":[]}',
    'data/parley/summary-cache.json': '{"v":1,"entries":{}}',
    'data/parley/attachments/abc.png': 'PNGDATA',
    'state/parley/logs/debug.log': 'log\n',
    'cache/parley/x': 'cached',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  chmodSync(join(home, 'config/parley/credentials'), 0o600);
  return files;
}

/** Every file of the old install is readable at its new path, unchanged. */
function expectAllAtNewPaths(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const next = rel.replace(/^(\w+)\/parley\//, '$1/taria/');
    expect(readFileSync(join(home, next), 'utf8'), next).toBe(text);
  }
}

/** ...and still at the old path (through the link), for an old parley. */
function expectAllAtOldPaths(files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) expect(readFileSync(join(home, rel), 'utf8'), rel).toBe(text);
}

const isLink = (p: string) => lstatSync(p).isSymbolicLink();

describe('migration from parley', () => {
  it('fresh install: nothing to do, nothing created', () => {
    const r = migrateFromParley();
    expect(r).toEqual({ steps: [], deferred: [], both: [], problems: [] });
    expect(readdirSync(home)).toEqual([]);
    expect(migrationNotices(r)).toEqual([]);
  });

  it('old data only: every directory is moved, the old paths become links, and the conversation opens', () => {
    const files = oldInstall();
    const r = migrateFromParley();
    expect(r.steps.map((s) => [s.kind, s.how, s.linked])).toEqual([
      ['config', 'renamed', true],
      ['data', 'renamed', true],
      ['state', 'renamed', true],
      ['cache', 'renamed', true],
    ]);
    expectAllAtNewPaths(files);
    expectAllAtOldPaths(files);
    for (const k of ['config', 'data', 'state', 'cache']) {
      expect(isLink(join(home, k, 'parley'))).toBe(true);
      expect(readlinkSync(join(home, k, 'parley'))).toBe(join(home, k, 'taria'));
    }
    expect((fs.statSync(join(home, 'config/taria/credentials')).mode & 0o777).toString(8)).toBe('600');
    const conv = new Store(paths.dataDir).open(CONV, { lock: false }).conv;
    expect(conv.path().map((m) => m.id)).toEqual(['u1', 'a1']);
    const notice = migrationNotices(r);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/^parley is now taria: moved your files \(~\/config\/parley → ~\/config\/taria, ~\/data\/parley → ~\/data\/taria/);
    expect(notice[0]).not.toContain('sk-test');
  });

  it('is idempotent: a second run changes nothing and says nothing', () => {
    const files = oldInstall();
    migrateFromParley();
    const r = migrateFromParley();
    expect(r).toEqual({ steps: [], deferred: [], both: [], problems: [] });
    expectAllAtNewPaths(files);
  });

  it('both present and unrelated: the new one is used, the old one is not touched, and the user is told', () => {
    const files = oldInstall();
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true });
    writeFileSync(join(home, 'data/taria/conversations/20260301-000000-new0.jsonl'), '{"type":"meta","v":1,"id":"20260301-000000-new0","createdAt":2,"app":"taria"}\n');
    const r = migrateFromParley({ kinds: ['data'] });
    expect(r.both).toEqual([{ kind: 'data', from: join(home, 'data/parley'), to: join(home, 'data/taria') }]);
    expect(isLink(join(home, 'data/parley'))).toBe(false);
    expect(readFileSync(join(home, `data/parley/conversations/${CONV}.jsonl`), 'utf8')).toBe(files[`data/parley/conversations/${CONV}.jsonl`]);
    expect(migrationNotices(r)[0]).toMatch(/Both ~\/data\/parley and ~\/data\/taria exist; taria uses ~\/data\/taria\. `taria doctor`/);
  });

  it('both present: the notice is shown once, not on every start; the result still lists it', () => {
    oldInstall();
    for (const k of ['config', 'data', 'state', 'cache']) {
      mkdirSync(join(home, k, 'taria'), { recursive: true });
      writeFileSync(join(home, k, 'taria', 'in-use'), 'x');
    }
    const first = migrateFromParley();
    expect(first.both).toHaveLength(4);
    expect(migrationNotices(first).filter((n) => n.startsWith('Both '))).toHaveLength(4);
    for (const k of DIR_KINDS) setDirOverride(k, undefined);
    const second = migrateFromParley();
    // Still reported to callers such as doctor, but not said again.
    expect(second.both.map((b) => b.kind)).toEqual(['config', 'data', 'state', 'cache']);
    expect(migrationNotices(second)).toEqual([]);
    // Nothing was written into the old folders, and only the record into taria's state folder.
    expect(readdirSync(join(home, 'data/taria'))).toEqual(['in-use']);
    expect(readdirSync(join(home, 'state/taria')).sort()).toEqual(['in-use', 'rename-noticed.json']);
    expect(readdirSync(join(home, 'state/parley'))).toEqual(readdirSync(join(home, 'state/parley')).filter((f) => f !== 'rename-noticed.json'));
  });

  it('both present for data only: the record never creates taria\'s state folder ahead of the state move', () => {
    const files = oldInstall();
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true });
    writeFileSync(join(home, 'data/taria/conversations/20260301-000000-new0.jsonl'), '{"type":"meta","v":1,"id":"20260301-000000-new0","createdAt":2,"app":"taria"}\n');
    // Only the data folder is looked at first (as when another kind is deferred).
    const r = migrateFromParley({ kinds: ['data'] });
    expect(migrationNotices(r).filter((n) => n.startsWith('Both '))).toHaveLength(1);
    expect(existsSync(join(home, 'state/taria'))).toBe(false);
    for (const k of DIR_KINDS) setDirOverride(k, undefined);
    // The full run still moves state, and from then on the notice is recorded.
    const full = migrateFromParley();
    expect(full.steps.map((s) => s.kind)).toEqual(['config', 'state', 'cache']);
    expect(readFileSync(join(home, 'state/taria/logs/debug.log'), 'utf8')).toBe(files['state/parley/logs/debug.log']);
    for (const k of DIR_KINDS) setDirOverride(k, undefined);
    expect(migrationNotices(migrateFromParley())).toEqual([]);
  });

  it('an empty taria folder (made before the move could run) does not block it', () => {
    const files = oldInstall();
    mkdirSync(join(home, 'data/taria/conversations'), { recursive: true });
    mkdirSync(join(home, 'config/taria'), { recursive: true });
    const r = migrateFromParley();
    expect(r.both).toEqual([]);
    expect(r.steps.map((s) => s.kind)).toEqual(['config', 'data', 'state', 'cache']);
    expectAllAtNewPaths(files);
  });

  it('a conversation open in a running parley: the data move waits, and this run uses the old directory', () => {
    const files = oldInstall();
    writeFileSync(join(home, `data/parley/conversations/${CONV}.jsonl.lock`), JSON.stringify({ pid: 4242, host: 'x', at: 1 }));
    const r = migrateFromParley({ isAlive: (pid) => pid === 4242 });
    expect(r.deferred).toEqual([{ kind: 'data', reason: 'parley (pid 4242) has a conversation open', using: join(home, 'data/parley') }]);
    expect(paths.dataDir).toBe(join(home, 'data/parley'));
    expect(isLink(join(home, 'data/parley'))).toBe(false);
    // The other directories moved; the data is complete where it was.
    expect(r.steps.map((s) => s.kind)).toEqual(['config', 'state', 'cache']);
    expectAllAtOldPaths(files);
    expect(migrationNotices(r).join('\n')).toMatch(/Your parley data files stay in ~\/data\/parley for now: parley \(pid 4242\) has a conversation open/);
    // Once parley has quit, the next run moves it.
    setDirOverride('data', undefined);
    const again = migrateFromParley({ isAlive: () => false });
    expect(again.steps.map((s) => s.kind)).toEqual(['data']);
    expectAllAtNewPaths(files);
  });

  it('a stale lock (the parley that wrote it is gone) does not hold the move up; a 0.0.1 lock with just a pid is read too', () => {
    oldInstall();
    writeFileSync(join(home, `data/parley/conversations/${CONV}.jsonl.lock`), '999999');
    expect(migrateFromParley({ isAlive: () => false, kinds: ['data'] }).steps).toHaveLength(1);
  });

  it('a read-only old directory is copied, checked, and left exactly as it was', () => {
    const files = oldInstall();
    const old = join(home, 'data/parley');
    chmodSync(old, 0o555);
    // Root ignores file modes, so the read-only directory is also simulated.
    const denied = (p: fs.PathLike) => String(p) === old || String(p).startsWith(old + '/');
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const readOnly: Fs = {
      ...fs,
      accessSync: (p: fs.PathLike, mode?: number) => {
        if (denied(p) && mode === fs.constants.W_OK) throw eacces();
        fs.accessSync(p, mode);
      },
      renameSync: (a: fs.PathLike, b: fs.PathLike) => {
        if (denied(a)) throw eacces();
        fs.renameSync(a, b);
      },
      writeFileSync: ((p: fs.PathLike, ...rest: unknown[]) => {
        if (denied(p)) throw eacces();
        return (fs.writeFileSync as (...x: unknown[]) => void)(p, ...rest);
      }) as Fs['writeFileSync'],
    };
    const r = migrateFromParley({ fs: readOnly, kinds: ['data'] });
    expect(r.problems).toEqual([]);
    expect(r.steps).toEqual([expect.objectContaining({ kind: 'data', how: 'copied', linked: false, kept: expect.stringMatching(/read-only/) })]);
    expectAllAtNewPaths(Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('data/'))));
    expect(isLink(old)).toBe(false);
    expect(readdirSync(old).sort()).toEqual(['attachments', 'conversations', 'drafts', 'history.jsonl', 'state.json', 'summary-cache.json']);
    // taria can write to its copy.
    fs.appendFileSync(join(home, `data/taria/conversations/${CONV}.jsonl`), '\n');
    expect(migrationNotices(r).join('\n')).toMatch(/read-only, so it was copied and left as it was/);
    // Rerunning does not copy again or complain.
    expect(migrateFromParley({ fs: readOnly, kinds: ['data'] })).toEqual({ steps: [], deferred: [], both: [], problems: [] });
  });

  it('across file systems (rename refused with EXDEV): copied, verified, then the old directory is replaced by a link', () => {
    const files = oldInstall();
    let refused = 0;
    const exdev: Fs = {
      ...fs,
      renameSync: (a: fs.PathLike, b: fs.PathLike) => {
        if (String(a) === join(home, 'data/parley') && String(b) === join(home, 'data/taria')) {
          refused++;
          throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        }
        fs.renameSync(a, b);
      },
    };
    const r = migrateFromParley({ fs: exdev, kinds: ['data'] });
    expect(refused).toBe(1);
    expect(r.steps).toEqual([expect.objectContaining({ kind: 'data', how: 'copied', linked: true })]);
    expectAllAtNewPaths(Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('data/'))));
    expect(isLink(join(home, 'data/parley'))).toBe(true);
    // The original is kept next to it, untouched.
    expect(readFileSync(join(home, `data/parley.moved-to-taria/conversations/${CONV}.jsonl`), 'utf8')).toBe(files[`data/parley/conversations/${CONV}.jsonl`]);
    expect(readdirSync(join(home, 'data')).filter((n) => n.includes('migrating'))).toEqual([]);
  });

  it('interrupted at any step, a rerun finishes the job and nothing is lost', () => {
    // Make every write-like call fail in turn: the n-th call throws (as if the
    // process were killed there), then a normal run follows.
    const writes = ['renameSync', 'symlinkSync', 'writeFileSync', 'mkdirSync', 'copyFileSync', 'chmodSync', 'appendFileSync'] as const;
    for (const forceCopy of [false, true]) {
      for (let n = 1; n <= 40; n++) {
        for (const v of VARS.slice(1, 5)) process.env[v] = join(home, `run-${forceCopy}-${n}`, v.split('_')[1]!.toLowerCase());
        const base = join(home, `run-${forceCopy}-${n}`);
        mkdirSync(join(base, 'data/parley/conversations'), { recursive: true });
        const text = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n';
        writeFileSync(join(base, `data/parley/conversations/${CONV}.jsonl`), text);
        writeFileSync(join(base, 'data/parley/history.jsonl'), 'h\n');
        let calls = 0;
        let crashed = false;
        const failing: Fs = { ...fs };
        for (const w of writes) {
          (failing as unknown as Record<string, unknown>)[w] = (...a: unknown[]) => {
            if (++calls === n) {
              crashed = true;
              throw new Error(`killed at call ${n}`);
            }
            if (w === 'renameSync' && forceCopy && String(a[0]).endsWith('/data/parley') && String(a[1]).endsWith('/data/taria')) {
              throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
            }
            return (fs[w] as (...x: unknown[]) => unknown)(...a);
          };
        }
        migrateFromParley({ fs: failing, kinds: ['data'] });
        for (const k of DIR_KINDS) setDirOverride(k, undefined);
        // Whatever state the crash left: the conversation is complete in one
        // of the two places, then a normal run completes the move.
        const somewhere = [join(base, 'data/taria'), join(base, 'data/parley'), join(base, 'data/parley.moved-to-taria')].some(
          (d) => existsSync(join(d, `conversations/${CONV}.jsonl`)) && readFileSync(join(d, `conversations/${CONV}.jsonl`), 'utf8') === text,
        );
        expect(somewhere, `crash at call ${n} (copy: ${forceCopy})`).toBe(true);
        const r = migrateFromParley({ kinds: ['data'] });
        expect(r.problems, `crash at call ${n} (copy: ${forceCopy})`).toEqual([]);
        expect(readFileSync(join(base, `data/taria/conversations/${CONV}.jsonl`), 'utf8'), `crash at call ${n}`).toBe(text);
        expect(readFileSync(join(base, `data/parley/conversations/${CONV}.jsonl`), 'utf8'), `old path after crash at ${n}`).toBe(text);
        expect(readdirSync(join(base, 'data')).filter((x) => x.includes('migrating'))).toEqual([]);
        if (!crashed) break; // n went past the last call: every step was covered
      }
    }
  });

  it('after a copy, lines an old parley appended in the old directory are carried over, never rewritten', () => {
    const files = oldInstall();
    const conv = `data/parley/conversations/${CONV}.jsonl`;
    let first = true;
    const exdev: Fs = {
      ...fs,
      renameSync: (a: fs.PathLike, b: fs.PathLike) => {
        if (String(a) === join(home, 'data/parley') && String(b) === join(home, 'data/taria')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        // Just before the old directory is retired, parley appends a line.
        if (first && String(a) === join(home, 'data/parley')) {
          first = false;
          throw new Error('killed before retiring');
        }
        fs.renameSync(a, b);
      },
    };
    migrateFromParley({ fs: exdev, kinds: ['data'] });
    const extra = JSON.stringify({ type: 'message', id: 'u2', parentId: 'a1', role: 'user', content: [{ type: 'text', text: 'later' }], ts: 3 }) + '\n';
    fs.appendFileSync(join(home, conv), extra);
    const r = migrateFromParley({ kinds: ['data'] });
    expect(r.problems).toEqual([]);
    expect(readFileSync(join(home, `data/taria/conversations/${CONV}.jsonl`), 'utf8')).toBe(files[conv] + extra);
  });

  it('an explicit TARIA_DATA_DIR (or PARLEY_DATA_DIR) is never migrated', () => {
    oldInstall();
    process.env.TARIA_DATA_DIR = join(home, 'elsewhere');
    const r = migrateFromParley();
    expect(r.steps.map((s) => s.kind)).toEqual(['config', 'state', 'cache']);
    expect(isLink(join(home, 'data/parley'))).toBe(false);
  });

  it('the marker records where the files came from', () => {
    oldInstall();
    migrateFromParley({ kinds: ['config'], now: () => 1234 });
    expect(JSON.parse(readFileSync(join(home, 'config/taria', MARKER), 'utf8'))).toEqual({ from: join(home, 'config/parley'), to: join(home, 'config/taria'), at: 1234, how: 'renamed' });
  });
});

