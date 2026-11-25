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
/** The alias script taria 0.3.x installed as `parley`. */
const ALIAS_SCRIPT = '#!/bin/sh\n# parley is now taria.\necho "parley is now taria: run taria instead (the parley command goes away in 0.4.0)." >&2\nexec "$(dirname "$0")/taria" "$@"\n';

function makeRelease(dir: string, version: string, opts: { badSum?: boolean; broken?: string; alias?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'taria-stage-'));
  writeFileSync(join(stage, 'taria'), opts.broken ? `#!/bin/sh\necho "${opts.broken}" >&2\nexit 127\n` : `#!/bin/sh\necho "taria ${version} (fake) $*"\nexit \${FAKE_EXIT:-0}\n`);
  chmodSync(join(stage, 'taria'), 0o755);
  const names = ['taria'];
  if (opts.alias) {
    // An archive as 0.3.x shipped it, with the alias script next to taria.
    writeFileSync(join(stage, 'parley'), ALIAS_SCRIPT);
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

  it('no longer installs a parley alias (0.4.0), even from an archive that still holds one', () => {
    const r = run({ TARIA_RELEASES_URL: `file://${root}/alias` });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/alias/);
    expect(spawnSync('ls', ['-A', r.dir], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual(['taria']);
  });

  it('removes the alias script taria 0.3 left in the install folder, and says so', () => {
    const home = mkdtempSync(join(root, 'leftover-'));
    const dir = join(home, 'bin');
    mkdirSync(dir);
    writeFileSync(join(dir, 'parley'), ALIAS_SCRIPT, { mode: 0o755 });
    const r = spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, TARIA_RELEASES_URL: `file://${root}/releases`, TARIA_INSTALL_DIR: dir, TARIA_OS: 'Linux', TARIA_ARCH: 'x86_64' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Removed ${dir}/parley: the parley command from taria 0.3 is gone in 0.4.0; run taria.`);
    expect(spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual(['taria']);
  });

  it('leaves a real old parley binary in the install folder alone, and says so', () => {
    const home = mkdtempSync(join(root, 'realold-'));
    const dir = join(home, 'bin');
    mkdirSync(dir);
    writeFileSync(join(dir, 'parley'), '#!/bin/sh\necho "parley 0.2.0"\n', { mode: 0o755 });
    const r = spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, TARIA_RELEASES_URL: `file://${root}/releases`, TARIA_INSTALL_DIR: dir, TARIA_OS: 'Linux', TARIA_ARCH: 'x86_64' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${dir}/parley is an old parley from before the rename. It was left alone; remove it when you no longer use it: rm ${dir}/parley`);
    expect(readFileSync(join(dir, 'parley'), 'utf8')).toContain('parley 0.2.0');
  });

  it('no longer reads the PARLEY_* variable names (0.4.0), and says which ones it ignored', () => {
    const home = mkdtempSync(join(root, 'oldvars-'));
    const r = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH!, HOME: home, TARIA_RELEASES_URL: `file://${root}/releases`, TARIA_OS: 'Linux', TARIA_ARCH: 'x86_64', PARLEY_INSTALL_DIR: join(home, 'old-bin'), PARLEY_VERSION: '0.0.7' },
    });
    expect(r.status).toBe(0);
    // Installed where TARIA_* (here: the default) says, the latest version.
    expect(r.stdout).toContain(`Installed ${join(home, '.local', 'bin')}/taria — taria 9.9.9 (fake)`);
    expect(r.stderr).toContain('taria install: PARLEY_INSTALL_DIR is no longer read; use TARIA_INSTALL_DIR.');
    expect(r.stderr).toContain('taria install: PARLEY_VERSION is no longer read; use TARIA_VERSION.');
    expect(spawnSync('ls', ['-A', home], { encoding: 'utf8' }).stdout).not.toContain('old-bin');
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

  it('says plainly when there is no binary for the platform, and points to the npm package', () => {
    for (const [os, arch, name] of [['Darwin', 'x86_64', 'darwin-x64'], ['Linux', 'aarch64', 'linux-arm64'], ['Linux', 'arm64', 'linux-arm64']] as const) {
      const r = run({ TARIA_OS: os, TARIA_ARCH: arch });
      expect(r.code, name).toBe(1);
      expect(r.err).toContain(`there is no taria binary for ${name} (binaries exist for Linux x64 and Apple Silicon Macs).`);
      expect(r.err).toContain('Install the npm package instead');
      expect(r.err).toContain('https://github.com/Riloative/taria#npm-nodejs-22-or-newer');
      // Nothing was downloaded or installed.
      expect(r.out).toBe('');
      expect(existsSync(join(r.dir, 'taria'))).toBe(false);
    }
    // The two published targets are accepted under their usual spellings.
    expect(run({ TARIA_OS: 'Linux', TARIA_ARCH: 'amd64' }).code).toBe(0);
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
