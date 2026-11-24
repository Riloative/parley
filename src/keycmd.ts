// `taria key set|remove|status <provider>`

import { hasOldKeychainEntry, removeOldKeychainEntry } from './config/credentials.js';
import { loadConfig } from './config/config.js';
import { deleteKey, detectKeychain, keychainLabel, resolveKey, setKeychainReadOnly, storeKey, defaultKeyEnv } from './config/credentials.js';

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.trim()));
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          process.stderr.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\x03') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function runKeyCommand(rest: string[]): Promise<number> {
  const [action, provider] = rest;
  if (!action || !provider || !['set', 'remove', 'status', 'remove-old'].includes(action)) {
    process.stderr.write('Usage: taria key set|remove|status|remove-old <provider>\n');
    return 2;
  }
  const { config } = loadConfig();
  const pc = config.providers[provider];
  if (!pc) process.stderr.write(`Note: "${provider}" is not defined in the config file yet.\n`);
  if (action === 'set') {
    const key = await readSecret(`API key for ${provider} (input hidden): `);
    if (!key) {
      process.stderr.write('No key entered; nothing changed.\n');
      return 1;
    }
    const r = await storeKey(provider, key);
    process.stdout.write(`Stored the key for ${provider} in the ${r.store === 'keychain' ? r.detail : `credentials file ${r.detail} (no keychain available)`}.\n`);
    return 0;
  }
  if (action === 'remove') {
    await deleteKey(provider);
    process.stdout.write(`Removed any stored key for ${provider}.\n`);
    return 0;
  }
  if (action === 'remove-old') {
    const r = await removeOldKeychainEntry(provider);
    if (r === 'copy-failed' || r === 'remove-failed') {
      process.stderr.write(
        r === 'copy-failed'
          ? `The old parley keychain entry for ${provider} is the only copy of that key, and storing it under taria's name failed. Nothing was removed.\n`
          : `The keychain refused to remove the old parley entry for ${provider}. Nothing was removed.\n`,
      );
      return 1;
    }
    process.stdout.write(
      r === 'none'
        ? `There is no old parley keychain entry for ${provider}.\n`
        : r === 'copied-and-removed'
          ? `Stored the key for ${provider} under taria's name first (it was only under parley's), then removed the old parley entry.\n`
          : `Removed the old parley keychain entry for ${provider}. The taria entry is unchanged.\n`,
    );
    return 0;
  }
  const kind = await detectKeychain();
  setKeychainReadOnly();
  const r = pc ? await resolveKey(pc) : { source: 'none' as const };
  const env = pc ? (pc.apiKeyEnv ?? defaultKeyEnv(pc)) : undefined;
  process.stdout.write(
    `Provider: ${provider}\nKeychain: ${keychainLabel(kind)}\nKey source: ${r.source === 'none' ? `none found${env ? ` (checked $${env}, keychain, credentials file)` : ''}` : `${r.source}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`}\n`,
  );
  // An entry parley stored is never deleted without being asked.
  if (await hasOldKeychainEntry(provider)) process.stdout.write(`Old parley entry: still in the keychain (an old parley uses it). Remove it with: taria key remove-old ${provider}\n`);
  return 0;
}
