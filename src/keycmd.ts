// `parley key set|remove|status <provider>`

import { loadConfig } from './config/config.js';
import { deleteKey, detectKeychain, keychainLabel, resolveKey, storeKey, defaultKeyEnv } from './config/credentials.js';

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
  if (!action || !provider || !['set', 'remove', 'status'].includes(action)) {
    process.stderr.write('Usage: parley key set|remove|status <provider>\n');
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
  const kind = await detectKeychain();
  const r = pc ? await resolveKey(pc) : { source: 'none' as const };
  const env = pc ? (pc.apiKeyEnv ?? defaultKeyEnv(pc)) : undefined;
  process.stdout.write(
    `Provider: ${provider}\nKeychain: ${keychainLabel(kind)}\nKey source: ${r.source === 'none' ? `none found${env ? ` (checked $${env}, keychain, credentials file)` : ''}` : `${r.source}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`}\n`,
  );
  return 0;
}
