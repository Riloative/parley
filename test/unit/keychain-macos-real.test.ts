// The real macOS `security` tool, in a throwaway keychain (never the user's).
// Runs only on a Mac; on CI that is the macOS runner. It checks what fakes
// cannot: that `security -i` stores awkward keys exactly, and that the key
// is on no command line.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/config/config.js';
import { _setKeychainFile, _setKeychainRunner, deleteKey, removeOldKeychainEntry, resolveKey, storeKey } from '../../src/config/credentials.js';

const REAL = '/usr/bin/security';
const AWKWARD = 'sk-test FAKE "quoted" \\back $dollar \'single\' -dash';
const provider = (name: string): ProviderConfig => ({ name, type: 'openai-compatible', headers: {}, models: {}, apiKeyEnv: 'TARIA_TEST_UNSET_KEY_VAR' });

describe.runIf(process.platform === 'darwin')('the real macOS keychain tool, in a throwaway keychain', () => {
  let dir = '';
  let kc = '';
  let log = '';
  const saved = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const stored = (service: string, account: string): string | undefined => {
    try {
      return execFileSync(REAL, ['find-generic-password', '-s', service, '-a', account, '-w', kc], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    } catch {
      return undefined;
    }
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'taria-kc-real-'));
    kc = join(dir, 'throwaway.keychain-db');
    log = join(dir, 'argv.log');
    execFileSync(REAL, ['create-keychain', '-p', 'throwaway', kc]);
    execFileSync(REAL, ['unlock-keychain', '-p', 'throwaway', kc]);
    // A `security` first on PATH that records its arguments, then runs the real one.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'security'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec ${REAL} "$@"\n`);
    chmodSync(join(dir, 'bin', 'security'), 0o755);
    process.env.PATH = `${join(dir, 'bin')}:${saved.PATH}`;
    process.env.XDG_CONFIG_HOME = join(dir, 'config');
    _setKeychainRunner(undefined, 'macos');
    _setKeychainFile(kc);
  });
  afterAll(() => {
    _setKeychainFile(undefined);
    _setKeychainRunner(undefined);
    process.env.PATH = saved.PATH;
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    try {
      execFileSync(REAL, ['delete-keychain', kc]);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores a plain key and an awkward one exactly, in the keychain, with the key on no command line', async () => {
    for (const [name, key] of [['plain', 'sk-test-FAKE-0123456789abcdef'], ['awkward', AWKWARD]] as const) {
      const r = await storeKey(name, key);
      expect(r.store).toBe('keychain');
      expect(stored('taria', name)).toBe(key);
      expect((await resolveKey(provider(name))).key).toBe(key);
    }
    expect(existsSync(join(dir, 'config', 'taria', 'credentials'))).toBe(false);
    const argv = readFileSync(log, 'utf8');
    expect(argv).toMatch(/^-i$/m);
    expect(argv).not.toContain('FAKE');
  });

  it('updates an existing entry', async () => {
    await storeKey('plain', 'sk-test-FAKE-second-value-000');
    expect(stored('taria', 'plain')).toBe('sk-test-FAKE-second-value-000');
  });

  it('copies a key stored by parley to taria\'s name the same way, and remove-old then removes only parley\'s', async () => {
    // As parley 0.2.0 stored it (this is the test's own setup, not taria's code).
    execFileSync(REAL, ['add-generic-password', '-U', '-s', 'parley', '-a', 'old', '-w', AWKWARD, kc]);
    writeFileSync(log, '');
    const r = await resolveKey(provider('old'));
    expect(r.key).toBe(AWKWARD);
    expect(r.detail).toMatch(/copied from the parley entry/);
    expect(stored('taria', 'old')).toBe(AWKWARD);
    expect(readFileSync(log, 'utf8')).not.toContain('FAKE');
    expect(await removeOldKeychainEntry('old')).toBe('removed');
    expect(stored('parley', 'old')).toBeUndefined();
    expect(stored('taria', 'old')).toBe(AWKWARD);
  });

  it('removes a key', async () => {
    await deleteKey('plain');
    expect(stored('taria', 'plain')).toBeUndefined();
  });
});
