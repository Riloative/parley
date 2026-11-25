// `taria key set|remove|status <provider>`

import { hasOldKeychainEntry, removeOldKeychainEntry } from './config/credentials.js';
import { loadConfig } from './config/config.js';
import { CredentialError, deleteKey, detectKeychain, keyProblem, keychainLabel, resolveKey, setKeychainReadOnly, storeKey, defaultKeyEnv, type ResolvedKey } from './config/credentials.js';

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
    // Piped input of several lines is not a key: stored as it is, its second
    // line would become another provider's entry in the credentials file.
    const problem = keyProblem(key);
    if (problem) {
      process.stderr.write(`${problem} Nothing was stored.\n`);
      return 1;
    }
    let r: Awaited<ReturnType<typeof storeKey>>;
    try {
      r = await storeKey(provider, key);
    } catch (e) {
      if (!(e instanceof CredentialError)) throw e;
      process.stderr.write(`${e.message} Nothing was stored.\n`);
      return 1;
    }
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
    if (r === 'copy-failed' || r === 'remove-failed' || r === 'no-answer') {
      process.stderr.write(
        r === 'no-answer'
          ? `The keychain did not answer (it may be locked, or waiting for a password), so taria cannot tell whether the key for ${provider} is stored under its own name. Nothing was removed.\n`
          : r === 'copy-failed'
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
  const r: ResolvedKey = pc ? await resolveKey(pc) : { source: 'none' };
  const env = pc ? (pc.apiKeyEnv ?? defaultKeyEnv(pc)) : undefined;
  // A keychain that did not answer is not an empty one: say which it was.
  const source =
    r.source !== 'none'
      ? `${r.source}${r.detail ? ` (${r.detail})` : ''}${r.keychainProblem ? `; the keychain did not answer (${r.keychainProblem})` : ''}`
      : r.keychainProblem
        ? `unknown: the keychain did not answer (${r.keychainProblem}), so a key may be stored there. Not in ${env ? `$${env} or ` : ''}the credentials file. Unlock the keychain and try again.`
        : `none found${env ? ` (checked $${env}, keychain, credentials file)` : ''}`;
  process.stdout.write(`Provider: ${provider}\nKeychain: ${keychainLabel(kind)}\nKey source: ${source}\n`);
  // An entry parley stored is never deleted without being asked.
  if (!r.keychainProblem && (await hasOldKeychainEntry(provider))) process.stdout.write(`Old parley entry: still in the keychain (an old parley uses it). Remove it with: taria key remove-old ${provider}\n`);
  return 0;
}
