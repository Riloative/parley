// The keychain and the credentials file: a keychain that does not answer is
// not an empty keychain, and the file never takes a key that would change
// its other lines.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setKeychainRunner, deleteKey, keyProblem, removeOldKeychainEntry, resolveKey, storeKey } from '../../src/config/credentials.js';
import type { ProviderConfig } from '../../src/config/config.js';

type KeychainRunner = NonNullable<Parameters<typeof _setKeychainRunner>[0]>;
type Result = Awaited<ReturnType<KeychainRunner>>;

const OLD = 'sk-test-FAKE-OLD-0123456789abcdef';
const NEW = 'sk-test-FAKE-NEW-fedcba9876543210';
const provider: ProviderConfig = { name: 'acme', type: 'openai-compatible', baseUrl: 'https://api.acme.invalid/v1', headers: {}, models: {}, apiKeyEnv: 'TARIA_TEST_UNSET_KEY_VAR' };

let configHome = '';
let savedConfigHome: string | undefined;
beforeEach(() => {
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), 'taria-cred-'));
  process.env.XDG_CONFIG_HOME = configHome;
});
afterEach(() => {
  _setKeychainRunner(undefined);
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
});
const credentialsFile = () => join(configHome, 'taria', 'credentials');

/** An in-memory `security` / `secret-tool` with the real tools' exit
 * statuses: "not found" is 44 for security, and 1 with no output for
 * secret-tool. `taria` decides what a lookup of taria's entry answers. */
function keychain(kind: 'macos' | 'libsecret', store: Record<string, string>, calls: string[], tariaLookup?: () => Result | undefined): KeychainRunner {
  return async (_cmd, args, input) => {
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    const service = kind === 'macos' ? at('-s') : at('service');
    const k = `${service}/${kind === 'macos' ? at('-a') : at('account')}`;
    const op = args[0]!;
    calls.push(`${op} ${service}`);
    if (op === 'find-generic-password' || op === 'lookup') {
      const forced = service === 'taria' ? tariaLookup?.() : undefined;
      if (forced) return forced;
      return store[k] ? { code: 0, stdout: `${store[k]}\n`, stderr: '' } : { code: kind === 'macos' ? 44 : 1, stdout: '', stderr: '' };
    }
    if (op === 'add-generic-password') store[k] = at('-w')!;
    if (op === 'store') store[k] = input!;
    if (op === 'delete-generic-password' || op === 'clear') delete store[k];
    return { code: 0, stdout: '', stderr: '' };
  };
}

const FAILURES: Array<[string, (kind: 'macos' | 'libsecret') => Result]> = [
  ['times out (a keyring waiting to be unlocked)', () => ({ code: 1, stdout: '', stderr: '', timedOut: true })],
  ['fails (a locked keyring, no D-Bus session)', (kind) => (kind === 'macos' ? { code: 51, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' } : { code: 1, stdout: '', stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' })],
];

describe('a keychain that does not answer', () => {
  for (const kind of ['macos', 'libsecret'] as const) {
    for (const [what, failure] of FAILURES) {
      it(`${kind}: when the lookup of taria's entry ${what}, parley's old key is not copied over taria's newer one`, async () => {
        const store: Record<string, string> = { 'parley/acme': OLD, 'taria/acme': NEW };
        const calls: string[] = [];
        let failing = true;
        _setKeychainRunner(keychain(kind, store, calls, () => (failing ? failure(kind) : undefined)), kind);
        const r = await resolveKey(provider);
        expect(store).toEqual({ 'parley/acme': OLD, 'taria/acme': NEW });
        expect(calls.filter((c) => /^(store|add-generic-password)/.test(c))).toEqual([]);
        // The stale key is not used either, and the answer says what happened.
        expect(r.key).toBeUndefined();
        expect(r.source).toBe('none');
        expect(r.keychainProblem).toMatch(what.startsWith('times out') ? /did not answer within/ : /exit status/);
        expect(JSON.stringify(r)).not.toMatch(/FAKE|D-Bus|interaction/);
        // Nothing of this is remembered: once the keychain answers, taria's key is used.
        failing = false;
        expect(await resolveKey(provider)).toMatchObject({ key: NEW, source: 'keychain' });
        expect(store).toEqual({ 'parley/acme': OLD, 'taria/acme': NEW });
      });

      it(`${kind}: remove-old removes nothing when the lookup of taria's entry ${what}`, async () => {
        const store: Record<string, string> = { 'parley/acme': OLD, 'taria/acme': NEW };
        const calls: string[] = [];
        _setKeychainRunner(keychain(kind, store, calls, () => failure(kind)), kind);
        expect(await removeOldKeychainEntry('acme')).toBe('no-answer');
        expect(store).toEqual({ 'parley/acme': OLD, 'taria/acme': NEW });
        expect(calls.every((c) => /^(lookup|find-generic-password)/.test(c))).toBe(true);
      });
    }

    it(`${kind}: with the real "not found" status, parley's key is still copied to taria's name`, async () => {
      const store: Record<string, string> = { 'parley/acme': OLD };
      _setKeychainRunner(keychain(kind, store, []), kind);
      expect(await resolveKey(provider)).toMatchObject({ key: OLD, source: 'keychain' });
      expect(store).toEqual({ 'parley/acme': OLD, 'taria/acme': OLD });
    });

    it(`${kind}: the credentials file is still read when the keychain does not answer, and the problem is reported with it`, async () => {
      _setKeychainRunner(async () => ({ code: 127, stdout: '', stderr: '' }), 'none');
      await storeKey('acme', NEW);
      _setKeychainRunner(keychain(kind, {}, [], () => ({ code: 1, stdout: '', stderr: '', timedOut: true })), kind);
      const r = await resolveKey(provider);
      expect(r).toMatchObject({ key: NEW, source: 'file' });
      expect(r.keychainProblem).toMatch(/did not answer within/);
    });
  }
});

describe('the credentials file', () => {
  beforeEach(() => _setKeychainRunner(async () => ({ code: 127, stdout: '', stderr: '' }), 'none'));

  it('refuses a key with a line break or a control character, and leaves the file as it was', async () => {
    await storeKey('acme', OLD);
    const before = readFileSync(credentialsFile(), 'utf8');
    for (const bad of [`${NEW}\nmock = injected-FAKE-value-000000`, `${NEW}\r\nx`, `a\0b-FAKE-0000`, `tab\tin-FAKE-key`, `esc\x1b[0m-FAKE`, '']) {
      expect(keyProblem(bad)).toBeTruthy();
      await expect(storeKey('acme', bad)).rejects.toThrow(/line break|control character|empty/);
      await expect(storeKey('acme', bad)).rejects.not.toThrow(/FAKE/);
    }
    expect(readFileSync(credentialsFile(), 'utf8')).toBe(before);
    expect(before).not.toMatch(/^mock\s*=/m);
    expect(keyProblem(NEW)).toBeUndefined();
    expect(keyProblem('pässword with spaces 🔑')).toBeUndefined();
  });

  it('refuses a provider name that the file could not hold on one line', async () => {
    for (const name of ['two words', 'a=b', 'x\nmock', '']) {
      await expect(storeKey(name, NEW)).rejects.toThrow(/provider name/i);
    }
    expect(existsSync(credentialsFile())).toBe(false);
  });

  it('is replaced atomically: mode 0600, the other entries kept, no temporary file left', async () => {
    await storeKey('acme', OLD);
    const first = statSync(credentialsFile()).ino;
    await storeKey('other.one', NEW);
    // A new file took its place (written in full, then renamed): the old one was never rewritten in place.
    expect(statSync(credentialsFile()).ino).not.toBe(first);
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(configHome, 'taria'))).toEqual(['credentials']);
    expect(readFileSync(credentialsFile(), 'utf8')).toMatch(new RegExp(`^acme = ${OLD}\\nother\\.one = ${NEW}\\n$`, 'm'));
    await deleteKey('acme');
    expect(readFileSync(credentialsFile(), 'utf8')).not.toContain(OLD);
    expect(readdirSync(join(configHome, 'taria'))).toEqual(['credentials']);
    expect((await resolveKey({ ...provider, name: 'other.one' })).key).toBe(NEW);
  });

  it('a temporary file left by an interrupted write is replaced, not used, and never has loose permissions', async () => {
    await storeKey('acme', OLD);
    const before = readFileSync(credentialsFile(), 'utf8');
    writeFileSync(`${credentialsFile()}.tmp`, 'half a li', { mode: 0o644 });
    await storeKey('beta', NEW);
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentialsFile(), 'utf8')).toBe(`${before}beta = ${NEW}\n`);
    expect(readdirSync(join(configHome, 'taria'))).toEqual(['credentials']);
  });
});
