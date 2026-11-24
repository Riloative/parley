// install.sh against a fake release layout served from file:// URLs.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../install.sh', import.meta.url).pathname;
const ASSET = 'taria-linux-x64.tar.gz';
let root: string;

function makeRelease(dir: string, version: string, opts: { badSum?: boolean; broken?: string; alias?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'taria-stage-'));
  writeFileSync(join(stage, 'taria'), opts.broken ? `#!/bin/sh\necho "${opts.broken}" >&2\nexit 127\n` : `#!/bin/sh\necho "taria ${version} (fake) $*"\nexit \${FAKE_EXIT:-0}\n`);
  chmodSync(join(stage, 'taria'), 0o755);
  const names = ['taria'];
  if (opts.alias) {
    // The real alias script, as the release ships it.
    writeFileSync(join(stage, 'parley'), readFileSync(new URL('../../scripts/parley-alias.sh', import.meta.url)));
    chmodSync(join(stage, 'parley'), 0o755);
    names.push('parley');
  }
  execFileSync('tar', ['czf', join(dir, ASSET), '-C', stage, ...names]);
  rmSync(stage, { recursive: true, force: true });
  const sum = createHash('sha256').update(readFileSync(join(dir, ASSET))).digest('hex');
  writeFileSync(join(dir, 'SHA256SUMS'), `${opts.badSum ? '0'.repeat(64) : sum}  ${ASSET}\n${'1'.repeat(64)}  taria-darwin-arm64.tar.gz\n`);
}

function run(env: Record<string, string>, script = SCRIPT): { code: number; out: string; err: string; dir: string } {
  const home = mkdtempSync(join(root, 'home-'));
  const dir = join(home, 'bin');
  const r = spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      TARIA_RELEASES_URL: `file://${root}/releases`,
      TARIA_INSTALL_DIR: dir,
      TARIA_OS: 'Linux',
      TARIA_ARCH: 'x86_64',
      ...env,
    },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, dir };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'taria-install-'));
  makeRelease(join(root, 'releases', 'latest', 'download'), '9.9.9');
  makeRelease(join(root, 'releases', 'download', 'v0.0.7'), '0.0.7');
  makeRelease(join(root, 'bad', 'latest', 'download'), '6.6.6', { badSum: true });
  makeRelease(join(root, 'noatomic', 'latest', 'download'), '5.5.5', { broken: './taria: error while loading shared libraries: libatomic.so.1: cannot open shared object file' });
  makeRelease(join(root, 'alias', 'latest', 'download'), '0.3.0', { alias: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('install.sh', () => {
  it('installs the latest release, verifies it, and prints a PATH hint', () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed ${r.dir}/taria — taria 9.9.9 (fake) --version`);
    expect(r.out).toContain('is not on your PATH');
    expect(execFileSync(join(r.dir, 'taria'), { encoding: 'utf8' })).toBe('taria 9.9.9 (fake) \n');
    // Nothing left behind next to the binary.
    expect(spawnSync('ls', ['-A', r.dir], { encoding: 'utf8' }).stdout.trim()).toBe('taria');
  });

  it('installs the parley alias when the release has one: same arguments, same exit status, a notice on stderr', () => {
    const r = run({ TARIA_RELEASES_URL: `file://${root}/alias` });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed ${r.dir}/parley as an alias for taria`);
    const a = spawnSync(join(r.dir, 'parley'), ['-p', 'two words'], { encoding: 'utf8', env: { PATH: process.env.PATH!, FAKE_EXIT: '3' } });
    expect(a.stdout).toBe('taria 0.3.0 (fake) -p two words\n');
    expect(a.stderr).toBe('parley is now taria: run taria instead (the parley command goes away in 0.4.0).\n');
    expect(a.status).toBe(3);
    expect(spawnSync('ls', ['-A', r.dir], { encoding: 'utf8' }).stdout.trim().split('\n').sort()).toEqual(['parley', 'taria']);
  });

  it('still reads the PARLEY_* variable names from before the rename', () => {
    const home = mkdtempSync(join(root, 'oldvars-'));
    const r = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH!, HOME: home, PARLEY_RELEASES_URL: `file://${root}/releases`, PARLEY_INSTALL_DIR: join(home, 'old-bin'), PARLEY_VERSION: '0.0.7', PARLEY_OS: 'Linux', PARLEY_ARCH: 'x86_64' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Installed ${join(home, 'old-bin')}/taria — taria 0.0.7 (fake)`);
  });

  it('installs a pinned version with or without the v prefix', () => {
    for (const v of ['0.0.7', 'v0.0.7']) {
      const r = run({ TARIA_VERSION: v });
      expect(r.code).toBe(0);
      expect(r.out).toContain('taria 0.0.7 (fake)');
    }
  });

  it('does not print the PATH hint when the directory is on PATH', () => {
    const home = mkdtempSync(join(root, 'onpath-'));
    const dir = join(home, 'bin');
    const r = run({ TARIA_INSTALL_DIR: dir, PATH: `${dir}:${process.env.PATH}` });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('is not on your PATH');
  });

  it('refuses a download whose checksum does not match', () => {
    const r = run({ TARIA_RELEASES_URL: `file://${root}/bad` });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/checksum mismatch for taria-linux-x64\.tar\.gz/);
    expect(existsSync(join(r.dir, 'taria'))).toBe(false);
  });

  it('explains a binary that cannot start, naming the missing library', () => {
    const r = run({ TARIA_RELEASES_URL: `file://${root}/noatomic` });
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not start on this system');
    expect(r.out).toContain('sudo apt install libatomic1');
  });

  it('explains unsupported platforms', () => {
    expect(run({ TARIA_OS: 'FreeBSD' }).err).toMatch(/unsupported operating system: FreeBSD/);
    expect(run({ TARIA_ARCH: 'riscv64' }).err).toMatch(/unsupported architecture: riscv64/);
  });

  it('refuses to install when no SHA-256 tool exists', () => {
    // A PATH with the tools the script needs, minus sha256sum and shasum.
    const tools = mkdtempSync(join(root, 'tools-'));
    for (const t of ['sh', 'uname', 'curl', 'mktemp', 'awk', 'tar', 'gzip', 'cut', 'chmod', 'mkdir', 'cp', 'mv', 'rm', 'cat', 'sysctl']) {
      const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (p) symlinkSync(p, join(tools, t));
    }
    const r = run({ PATH: tools });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/needs sha256sum or shasum/);
  });

  it('does nothing when the script was cut off mid-download', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const cut = join(root, 'truncated.sh');
    for (const fraction of [0.3, 0.6, 0.95]) {
      writeFileSync(cut, text.slice(0, Math.floor(text.length * fraction)));
      const r = run({}, cut);
      expect(existsSync(join(r.dir, 'taria'))).toBe(false);
      expect(r.out).not.toContain('Downloading');
    }
  });
});
