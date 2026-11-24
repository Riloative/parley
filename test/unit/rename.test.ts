// What still understands the name parley after the rename to taria.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptLegacyEnv, legacyEnvNotice } from '../../src/brand.js';
import { _setKeychainRunner, hasOldKeychainEntry, removeOldKeychainEntry, resolveKey } from '../../src/config/credentials.js';
import type { ProviderConfig } from '../../src/config/config.js';
import { Store, replay, SCHEMA_VERSION } from '../../src/core/store.js';
import { writeConfigFile } from '../../src/term/setup.js';

describe('conversation files', () => {
  it('files parley wrote (meta.app "parley") open; new ones say "taria"; the schema version stays 1', () => {
    const lines = [
      { type: 'meta', v: 1, id: 'c1', createdAt: 5, app: 'parley' },
      { type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'from parley' }], ts: 6 },
    ];
    const { conv } = replay('c1', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(conv.path().map((m) => m.id)).toEqual(['u1']);
    expect(conv.createdAt).toBe(5);
    expect(SCHEMA_VERSION).toBe(1);
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-meta-')));
    const f = store.create();
    expect(JSON.parse(readFileSync(f.file, 'utf8').split('\n')[0]!)).toMatchObject({ type: 'meta', v: 1, app: 'taria' });
    f.releaseLock();
  });
});

describe('environment variables', () => {
  it('PARLEY_* also sets TARIA_*, the new name wins, and the notice names each one once', () => {
    const env: NodeJS.ProcessEnv = { PARLEY_NO_KEYCHAIN: '1', PARLEY_DATA_DIR: '/old', TARIA_DATA_DIR: '/new', HOME: '/h' };
    adoptLegacyEnv(env);
    adoptLegacyEnv(env);
    expect(env.TARIA_NO_KEYCHAIN).toBe('1');
    expect(env.TARIA_DATA_DIR).toBe('/new');
    const n = legacyEnvNotice()!;
    expect(n).toContain('PARLEY_NO_KEYCHAIN → TARIA_NO_KEYCHAIN');
    expect(n).toContain('PARLEY_DATA_DIR → TARIA_DATA_DIR');
    expect(n.match(/PARLEY_NO_KEYCHAIN/g)).toHaveLength(1);
    expect(n).toMatch(/still work until taria 0\.4\.0/);
  });
});

type KeychainRunner = NonNullable<Parameters<typeof _setKeychainRunner>[0]>;

/** An in-memory `security` / `secret-tool`. */
function fakeKeychain(kind: 'macos' | 'libsecret', store: Record<string, string>, calls: string[][] = [], opts: { failWrites?: boolean; failDeletes?: boolean } = {}): KeychainRunner {
  return async (cmd, args, input) => {
    calls.push([cmd, ...args]);
    const service = kind === 'macos' ? args[args.indexOf('-s') + 1] : args[args.indexOf('service') + 1];
    const account = kind === 'macos' ? args[args.indexOf('-a') + 1] : args[args.indexOf('account') + 1];
    const k = `${service}/${account}`;
    const op = args[0];
    if (op === 'find-generic-password' || op === 'lookup') return store[k] ? { code: 0, stdout: `${store[k]}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' };
    if (op === 'add-generic-password' || op === 'store') {
      if (opts.failWrites) return { code: 1, stdout: '', stderr: 'locked' };
      store[k] = op === 'store' ? input! : args[args.indexOf('-w') + 1]!;
    }
    if (op === 'delete-generic-password' || op === 'clear') {
      if (opts.failDeletes) return { code: 1, stdout: '', stderr: 'locked' };
      delete store[k];
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('keychain', () => {
  const SECRET = 'sk-ant-api03-OLDPARLEYKEY0123456789abcdefghij';
  const provider: ProviderConfig = { name: 'anthropic', type: 'anthropic', headers: {}, models: {}, apiKeyEnv: 'TARIA_TEST_UNSET_KEY_VAR' };
  afterEach(() => _setKeychainRunner(undefined));

  for (const kind of ['macos', 'libsecret'] as const) {
    it(`${kind}: a key stored by parley is found, copied to a taria entry, and never printed; the old entry stays`, async () => {
      const store: Record<string, string> = { 'parley/anthropic': SECRET };
      const calls: string[][] = [];
      _setKeychainRunner(async (cmd, args, input) => {
        calls.push([cmd, ...args]);
        const service = kind === 'macos' ? args[args.indexOf('-s') + 1] : args[args.indexOf('service') + 1];
        const account = kind === 'macos' ? args[args.indexOf('-a') + 1] : args[args.indexOf('account') + 1];
        const k = `${service}/${account}`;
        const op = args[0];
        if (op === 'find-generic-password' || op === 'lookup') return store[k] ? { code: 0, stdout: `${store[k]}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' };
        if (op === 'add-generic-password') store[k] = args[args.indexOf('-w') + 1]!;
        if (op === 'store') store[k] = input!;
        return { code: 0, stdout: '', stderr: '' };
      }, kind);
      const r = await resolveKey(provider);
      expect(r.key).toBe(SECRET);
      expect(r.source).toBe('keychain');
      expect(r.detail).toMatch(/copied from the parley entry/);
      expect(r.detail).not.toContain(SECRET);
      expect(store['taria/anthropic']).toBe(SECRET);
      expect(store['parley/anthropic']).toBe(SECRET); // not deleted without asking
      // The taria entry was looked up first.
      expect(calls[0]).toContain('taria');
      expect(await hasOldKeychainEntry('anthropic')).toBe(true);
      // Next time the taria entry answers directly.
      _setKeychainRunner(async (_c, args) => {
        const service = kind === 'macos' ? args[args.indexOf('-s') + 1] : args[args.indexOf('service') + 1];
        return service === 'taria' ? { code: 0, stdout: SECRET, stderr: '' } : { code: 44, stdout: '', stderr: '' };
      }, kind);
      expect((await resolveKey(provider)).detail).not.toMatch(/copied/);
    });

    it(`${kind}: a read-only lookup (doctor, key status) finds parley's key and writes nothing`, async () => {
      const store: Record<string, string> = { 'parley/anthropic': SECRET };
      const calls: string[][] = [];
      _setKeychainRunner(fakeKeychain(kind, store, calls), kind);
      const r = await resolveKey(provider, { readOnly: true });
      expect(r.key).toBe(SECRET);
      expect(r.detail).toMatch(/the parley entry/);
      expect(r.detail).not.toMatch(/copied/);
      expect(store).toEqual({ 'parley/anthropic': SECRET });
      expect(calls.every((c) => ['find-generic-password', 'lookup'].includes(c[1]!))).toBe(true);
      // A later normal lookup in the same process still copies it.
      expect((await resolveKey(provider)).detail).toMatch(/copied from the parley entry/);
      expect(store['taria/anthropic']).toBe(SECRET);
    });

    it(`${kind}: remove-old never removes the only copy of a key`, async () => {
      // Only parley's entry exists: the key is copied to taria's name first.
      const store: Record<string, string> = { 'parley/anthropic': SECRET };
      _setKeychainRunner(fakeKeychain(kind, store), kind);
      expect(await removeOldKeychainEntry('anthropic')).toBe('copied-and-removed');
      expect(store).toEqual({ 'taria/anthropic': SECRET });
      expect(await removeOldKeychainEntry('anthropic')).toBe('none');

      // The copy cannot be stored: the old entry stays.
      const stuck: Record<string, string> = { 'parley/anthropic': SECRET };
      _setKeychainRunner(fakeKeychain(kind, stuck, [], { failWrites: true }), kind);
      expect(await removeOldKeychainEntry('anthropic')).toBe('copy-failed');
      expect(stuck).toEqual({ 'parley/anthropic': SECRET });

      // A different key is already under taria's name: it is kept, the old one goes.
      const both: Record<string, string> = { 'parley/anthropic': SECRET, 'taria/anthropic': 'sk-newer-key-000' };
      _setKeychainRunner(fakeKeychain(kind, both), kind);
      expect(await removeOldKeychainEntry('anthropic')).toBe('removed');
      expect(both).toEqual({ 'taria/anthropic': 'sk-newer-key-000' });

      // The keychain refuses the removal: say so, do not claim it was removed.
      const locked: Record<string, string> = { 'parley/anthropic': SECRET, 'taria/anthropic': SECRET };
      _setKeychainRunner(fakeKeychain(kind, locked, [], { failDeletes: true }), kind);
      expect(await removeOldKeychainEntry('anthropic')).toBe('remove-failed');
      expect(locked['parley/anthropic']).toBe(SECRET);
    });
  }
});

describe('/terminal-setup backups', () => {
  it('never overwrites a backup parley made (.parley-backup)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-backup-'));
    const f = join(dir, 'tmux.conf');
    writeFileSync(f, 'current\n');
    writeFileSync(`${f}.parley-backup`, 'what parley saved\n');
    const r = writeConfigFile(f, 'next\n');
    expect(r.backup).toBe(`${f}.taria-backup-2`);
    expect(readFileSync(`${f}.parley-backup`, 'utf8')).toBe('what parley saved\n');
    expect(existsSync(`${f}.taria-backup`)).toBe(false);
  });
});

describe('the update check after the repository rename', () => {
  it('follows GitHub\'s redirect from the old repository name, as a 0.2.0 install will', async () => {
    // GitHub answers requests for a renamed repository with 301 to the new
    // location; the fetch parley 0.2.0 uses follows it.
    const server = createServer((req, res) => {
      if (req.url === '/repos/Riloative/parley/releases/latest') {
        res.writeHead(301, { location: '/repositories/1/releases/latest' });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: 'v0.3.0' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(join(tmpdir(), 'taria-update-'));
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = home;
    try {
      const { newerVersion } = await import('../../src/core/update.js');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/Riloative/parley/releases/latest`;
      expect(await newerVersion({ enabled: true, current: '0.2.0', url })).toBe('0.3.0');
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
      server.close();
    }
  });
});
