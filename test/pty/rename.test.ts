// The rename, end to end: a home directory as parley 0.2.0 left it, opened by
// taria; the parley command; old variable names; doctor changing nothing.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTaria, testEnv, type Session } from './harness.js';
import { tariaCommand } from '../build-once.js';

let s: Session | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const CONV = '20260102-030405-beef';

/** A home directory with what parley 0.2.0 writes, and nothing of taria's. */
function parleyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'taria-rename-'));
  mkdirSync(join(home, 'config', 'parley', 'commands'), { recursive: true });
  writeFileSync(join(home, 'config', 'parley', 'config.yaml'), 'default_model: mock/echo\ntheme: dark\nbell: false\nproviders:\n  mock:\n    type: mock\n');
  writeFileSync(join(home, 'config', 'parley', 'commands', 'shout.md'), '---\ndescription: Shout it\n---\nSHOUT $ARGUMENTS\n');
  mkdirSync(join(home, 'data', 'parley', 'conversations'), { recursive: true });
  const lines = [
    { type: 'meta', v: 1, id: CONV, createdAt: 1_700_000_000_000, app: 'parley' },
    { type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'written by parley' }], ts: 1_700_000_000_000 },
    { type: 'message', id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'text', text: 'You said: written by parley' }], ts: 1_700_000_000_001, model: 'mock/echo' },
    { type: 'title', title: 'Old chat' },
  ];
  writeFileSync(join(home, 'data', 'parley', 'conversations', `${CONV}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(home, 'data', 'parley', 'history.jsonl'), JSON.stringify({ text: 'written by parley', ts: 1 }) + '\n');
  return home;
}

function run(home: string, args: string[], env: Record<string, string> = {}, input = '') {
  const cmd = tariaCommand(args);
  return spawnSync(cmd.command, cmd.args, { env: testEnv(home, env), input, encoding: 'utf8', timeout: 30_000 });
}

const flat = () => s!.all().map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');

describe('opening a parley install with taria', () => {
  it('moves the files, says so once in the welcome box, and the old conversation, history and commands are there', async () => {
    const home = parleyHome();
    s = spawnTaria({ cols: 110, rows: 32, home, args: ['-c'] });
    await s.waitFor('Send a message');
    await s.waitStable({ lastLine: '% context' });
    expect(flat()).toMatch(/parley is now taria: moved your files \(~\/config\/parley → ~\/config\/taria, ~\/data\/parley → ~\/data\/taria\)/);
    expect(flat()).toContain('You said: written by parley');
    expect(lstatSync(join(home, 'data', 'parley')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, 'data', 'taria', 'conversations', `${CONV}.jsonl`), 'utf8')).toContain('"app":"parley"');
    // Custom commands came along.
    s.write('/sho');
    await s.waitFor('Shout it');
    s.write('\x15');
    // Input history came along: ↑ on an empty input.
    s.write('\x1b[A');
    await s.waitFor('│ > written by parley');
    s.write('\x15\x04');
    await s.exited;
    await s.close(true);

    // The next start says nothing about it.
    s = spawnTaria({ cols: 110, rows: 32, home });
    await s.waitFor('Send a message');
    await s.waitStable({ lastLine: '% context' });
    expect(flat()).not.toContain('parley is now taria');
  }, 40_000);

  it('-p: the answer alone on stdout; the move and old variable names reported once on stderr', () => {
    const home = parleyHome();
    const r = run(home, ['-p', '-c', 'again'], { PARLEY_NO_KEYCHAIN: '1', PARLEY_UPDATE_URL: 'http://127.0.0.1:9/x' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('You said: again\n');
    expect(r.stderr).toMatch(/^taria: Renamed environment variables: PARLEY_NO_KEYCHAIN → TARIA_NO_KEYCHAIN, PARLEY_UPDATE_URL → TARIA_UPDATE_URL\./m);
    expect(r.stderr.match(/Renamed environment variable/g)).toHaveLength(1);
    expect(r.stderr).toMatch(/^taria: parley is now taria: moved your files/m);
    // The reply was added to the parley conversation, now in taria's folder.
    expect(readFileSync(join(home, 'data', 'taria', 'conversations', `${CONV}.jsonl`), 'utf8')).toContain('You said: again');
  });

  it('waits while a parley still has a conversation open, and uses the old folder meanwhile', () => {
    const home = parleyHome();
    // A lock held by a live process (this test runner).
    writeFileSync(join(home, 'data', 'parley', 'conversations', `${CONV}.jsonl.lock`), JSON.stringify({ pid: process.pid, host: 'here', at: Date.now() }));
    const r = run(home, ['-p', 'hello']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('You said: hello\n');
    expect(r.stderr).toMatch(/Your parley data files stay in ~\/data\/parley for now: parley \(pid \d+\) has a conversation open/);
    expect(lstatSync(join(home, 'data', 'parley')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(home, 'data', 'taria'))).toBe(false);
    // The new conversation went to the old folder, with everything else.
    expect(readdirSync(join(home, 'data', 'parley', 'conversations')).filter((f) => f.endsWith('.jsonl'))).toHaveLength(2);
    // The config, which no lock protects, did move.
    expect(lstatSync(join(home, 'config', 'parley')).isSymbolicLink()).toBe(true);
  });

  it('doctor reports the old folders and changes nothing', () => {
    const home = parleyHome();
    const r = run(home, ['doctor'], { NO_COLOR: '1' });
    expect(r.stdout).toMatch(/Old config folder\s+.*config\/parley: moves to .*config\/taria the next time taria starts \(doctor changes nothing\)/);
    expect(r.stdout).toMatch(/Old data folder/);
    expect(lstatSync(join(home, 'data', 'parley')).isDirectory()).toBe(true);
    expect(existsSync(join(home, 'data', 'taria'))).toBe(false);
    expect(existsSync(join(home, 'config', 'taria'))).toBe(false);
  });
});

describe('the parley command', () => {
  /** A directory holding `parley` as the release ships it, next to `taria`. */
  function aliasDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'taria-alias-'));
    const bin = process.env.TARIA_BIN ?? process.env.PARLEY_BIN;
    if (bin) {
      symlinkSync(bin, join(dir, 'taria'));
      copyFileSync(new URL('../../scripts/parley-alias.sh', import.meta.url), join(dir, 'parley'));
      chmodSync(join(dir, 'parley'), 0o755);
    } else {
      const js = new URL('../../bin/parley.js', import.meta.url).pathname;
      writeFileSync(join(dir, 'parley'), `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`);
      chmodSync(join(dir, 'parley'), 0o755);
    }
    return join(dir, 'parley');
  }

  it('runs taria with the same arguments and exit status, after one line on stderr', () => {
    const parley = aliasDir();
    const home = parleyHome();
    const ok = spawnSync(parley, ['-p', '-m', 'mock/echo', 'two words'], { env: testEnv(home), encoding: 'utf8', timeout: 30_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('You said: two words\n');
    expect(ok.stderr.split('\n')[0]).toBe('parley is now taria: run taria instead (the parley command goes away in 0.4.0).');
    const bad = spawnSync(parley, ['--no-such-option'], { env: testEnv(home), encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Unknown option --no-such-option/);
  });
});

describe('the keychain, with real processes and a fake keychain tool', () => {
  /** `secret-tool` and `security` that keep entries as files and log every call. */
  function fakeKeychainTools(home: string): { bin: string; dir: string; entries: () => string[]; log: () => string } {
    const bin = join(home, 'kcbin');
    const dir = join(home, 'kc');
    mkdirSync(bin);
    mkdirSync(dir);
    const script = `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/log"
op=$1
case "$0" in
  *security) while [ $# -gt 0 ]; do case "$1" in -s) svc=$2; shift;; -a) acc=$2; shift;; -w) key=$2; [ $# -gt 1 ] && shift;; esac; shift; done
    case "$op" in
      find-generic-password) [ -f "$D/$svc.$acc" ] || exit 44; /bin/cat "$D/$svc.$acc";;
      add-generic-password) printf '%s' "$key" > "$D/$svc.$acc";;
      delete-generic-password) [ -f "$D/$svc.$acc" ] || exit 44; /bin/rm "$D/$svc.$acc";;
    esac;;
  *) [ "$op" = --version ] && exit 0
    while [ $# -gt 0 ]; do case "$1" in service) svc=$2; shift;; account) acc=$2; shift;; esac; shift; done
    case "$op" in
      lookup) [ "$FAKE_SLOW" = "$svc" ] && exec /bin/sleep 20; [ -f "$D/$svc.$acc" ] || exit 1; /bin/cat "$D/$svc.$acc";;
      store) /bin/cat > "$D/$svc.$acc";;
      clear) /bin/rm -f "$D/$svc.$acc";;
    esac;;
esac
`;
    for (const t of ['secret-tool', 'security']) {
      writeFileSync(join(bin, t), script);
      chmodSync(join(bin, t), 0o755);
    }
    return { bin, dir, entries: () => readdirSync(dir).filter((f) => f !== 'log').sort(), log: () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '') };
  }
  const KEY = 'sk-test-FAKE-OLD-0123456789abcdef';
  const CONFIG = 'default_model: mock/echo\nproviders:\n  mock:\n    type: mock\n  acme:\n    type: openai-compatible\n    base_url: http://127.0.0.1:1/v1\n';
  function setup() {
    const home = mkdtempSync(join(tmpdir(), 'taria-kc-'));
    mkdirSync(join(home, 'config', 'taria'), { recursive: true });
    writeFileSync(join(home, 'config', 'taria', 'config.yaml'), CONFIG);
    const kc = fakeKeychainTools(home);
    writeFileSync(join(kc.dir, 'parley.acme'), KEY);
    const env = { PATH: kc.bin, TARIA_NO_KEYCHAIN: '', XDG_RUNTIME_DIR: home, NO_COLOR: '1' };
    return { home, kc, env };
  }

  it('`taria doctor` and `taria key status` find a key stored by parley and change nothing in the keychain', () => {
    const { home, kc, env } = setup();
    const d = run(home, ['doctor'], env);
    expect(d.stdout).toMatch(/acme.*key from keychain/);
    expect(d.stdout + d.stderr).not.toContain(KEY);
    expect(kc.entries()).toEqual(['parley.acme']);
    const st = run(home, ['key', 'status', 'acme'], env);
    expect(st.stdout).toMatch(/Key source: keychain \(.*the parley entry\)/);
    expect(st.stdout).toContain('taria key remove-old acme');
    expect(kc.entries()).toEqual(['parley.acme']);
    expect(kc.log()).not.toMatch(/^(store|add-generic-password|clear|delete-generic-password)/m);
  });

  it('`taria key remove-old` stores the key under taria\'s name before it removes the only copy', () => {
    const { home, kc, env } = setup();
    const r = run(home, ['key', 'remove-old', 'acme'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/under taria's name first/);
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(kc.entries()).toEqual(['taria.acme']);
    expect(readFileSync(join(kc.dir, 'taria.acme'), 'utf8')).toBe(KEY);
    expect(run(home, ['key', 'status', 'acme'], env).stdout).toMatch(/Key source: keychain/);
  });

  it('a keychain that is slow to answer for taria\'s entry: the old parley key never replaces the newer taria key, and nothing says "none found"', () => {
    const { home, kc, env } = setup();
    const NEWER = 'sk-test-FAKE-NEW-fedcba9876543210';
    writeFileSync(join(kc.dir, 'taria.acme'), NEWER);
    const slow = { ...env, FAKE_SLOW: 'taria' };
    // A normal run, which would copy parley's key if taria's entry were missing.
    const p = run(home, ['-p', '-m', 'acme/m', 'hi'], slow);
    expect(p.stdout + p.stderr).not.toMatch(/FAKE/);
    expect(readFileSync(join(kc.dir, 'taria.acme'), 'utf8')).toBe(NEWER);
    expect(kc.log()).not.toMatch(/^(store|add-generic-password)/m);
    const st = run(home, ['key', 'status', 'acme'], slow);
    expect(st.stdout).toMatch(/Key source: unknown: the keychain did not answer \(secret-tool did not answer within 4 s\)/);
    expect(st.stdout).not.toMatch(/none found|remove-old/);
    const rm = run(home, ['key', 'remove-old', 'acme'], slow);
    expect(rm.status).toBe(1);
    expect(rm.stderr).toMatch(/keychain did not answer.*Nothing was removed/);
    expect(kc.entries()).toEqual(['parley.acme', 'taria.acme']);
    expect(readFileSync(join(kc.dir, 'taria.acme'), 'utf8')).toBe(NEWER);
    // Once it answers, taria's own key is the one found.
    expect(run(home, ['key', 'status', 'acme'], env).stdout).toMatch(/Key source: keychain \(Secret Service \(libsecret\)\)/);
  }, 60_000);

  it('`taria key set` refuses input of more than one line, and a provider name the credentials file cannot hold', () => {
    const { home } = setup();
    const env = { TARIA_NO_KEYCHAIN: '1', NO_COLOR: '1' };
    const file = join(home, 'config', 'taria', 'credentials');
    const two = run(home, ['key', 'set', 'acme'], env, `${KEY}\nmock = injected-FAKE-value-000000\n`);
    expect(two.status).toBe(1);
    expect(two.stderr).toMatch(/The key contains a line break.*Nothing was stored/s);
    expect(two.stdout + two.stderr).not.toMatch(/FAKE|    at /);
    expect(existsSync(file)).toBe(false);
    const name = run(home, ['key', 'set', 'two words'], env, `${KEY}\n`);
    expect(name.status).toBe(1);
    expect(name.stderr).toMatch(/provider name may only contain/);
    expect(name.stdout + name.stderr).not.toMatch(/FAKE|    at /);
    expect(existsSync(file)).toBe(false);
    // One line, with the newline that echo and printf '%s\n' add, is a key.
    const one = run(home, ['key', 'set', 'acme'], env, `${KEY}\r\n`);
    expect(one.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^acme = ${KEY}\\n$`, 'm'));
    expect(readFileSync(file, 'utf8')).not.toMatch(/^mock/m);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('both folders exist: `taria doctor` reports it and `taria doctor merge` brings conversations over', () => {
  const file = (id: string, text: string) => `{"type":"meta","v":1,"id":"${id}","createdAt":1,"app":"parley"}\n{"type":"message","id":"u1","parentId":null,"role":"user","content":[{"type":"text","text":"${text}"}],"ts":1}\n`;
  function bothHome(): string {
    const home = parleyHome(); // data/parley holds CONV
    mkdirSync(join(home, 'config', 'taria'), { recursive: true });
    writeFileSync(join(home, 'config', 'taria', 'config.yaml'), 'default_model: mock/echo\nproviders:\n  mock:\n    type: mock\n');
    mkdirSync(join(home, 'data', 'taria', 'conversations'), { recursive: true });
    writeFileSync(join(home, 'data', 'taria', 'conversations', '20260301-000000-aaaa.jsonl'), file('20260301-000000-aaaa', 'written by taria'));
    return home;
  }

  it('doctor says how many conversations are only in the old folder, with the command, and changes nothing', () => {
    const home = bothHome();
    const d = run(home, ['doctor'], { NO_COLOR: '1' });
    expect(d.stdout).toMatch(/Only in the old folder\s+1 conversation .*data\/parley/);
    expect(d.stdout).toContain('taria doctor merge');
    expect(readdirSync(join(home, 'data', 'taria', 'conversations'))).toEqual(['20260301-000000-aaaa.jsonl']);
    // Without a terminal, merge lists and asks to be run in one.
    const m = run(home, ['doctor', 'merge'], { NO_COLOR: '1' });
    expect(m.status).toBe(1);
    expect(m.stdout).toContain(CONV);
    expect(m.stdout).toMatch(/Run this in a terminal to confirm/);
    expect(readdirSync(join(home, 'data', 'taria', 'conversations'))).toEqual(['20260301-000000-aaaa.jsonl']);
  });

  it('merge copies after a yes, leaves the old folder alone, and then has nothing left to do', async () => {
    const home = bothHome();
    const before = readFileSync(join(home, 'data', 'parley', 'conversations', `${CONV}.jsonl`), 'utf8');
    s = spawnTaria({ home, args: ['doctor', 'merge'], noConfig: true });
    await s.waitFor(/Copy 1 conversation.*\[y\/N\]/);
    s.write('y\r');
    await s.waitFor(/copied Old chat/);
    await s.exited;
    expect(readFileSync(join(home, 'data', 'taria', 'conversations', `${CONV}.jsonl`), 'utf8')).toBe(before);
    expect(readFileSync(join(home, 'data', 'parley', 'conversations', `${CONV}.jsonl`), 'utf8')).toBe(before);
    expect(readdirSync(join(home, 'data', 'taria', 'conversations')).sort()).toEqual([`${CONV}.jsonl`, '20260301-000000-aaaa.jsonl'].sort());
    const again = run(home, ['doctor', 'merge'], { NO_COLOR: '1' });
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/Nothing to bring over/);
    // The merged conversation opens.
    const p = run(home, ['-p', '-r', CONV, 'after the merge'], {});
    expect(p.stdout).toBe('You said: after the merge\n');
  });
});
