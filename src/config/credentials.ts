// API key resolution: environment variable → OS keychain → credentials file
// (0600, for headless/SSH machines without a keychain). Keys are never logged,
// written to the config, transcripts or error messages.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.js';
import type { ProviderConfig } from './config.js';

export type KeySource = 'env' | 'keychain' | 'file' | 'none';

export interface ResolvedKey {
  key?: string;
  source: KeySource;
  /** Where exactly, for display ("ANTHROPIC_API_KEY", "macOS Keychain"...). */
  detail?: string;
}

const SERVICE = 'parley';

export function defaultKeyEnv(p: Pick<ProviderConfig, 'type' | 'baseUrl' | 'name'>): string | undefined {
  if (p.type === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (p.type === 'openai') return 'OPENAI_API_KEY';
  const u = p.baseUrl ?? '';
  if (u.includes('api.mistral.ai')) return 'MISTRAL_API_KEY';
  if (u.includes('openrouter.ai')) return 'OPENROUTER_API_KEY';
  if (u.includes('api.groq.com')) return 'GROQ_API_KEY';
  if (u.includes('api.deepseek.com')) return 'DEEPSEEK_API_KEY';
  if (u.includes('api.together')) return 'TOGETHER_API_KEY';
  return `${p.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local') || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h);
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 4000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ code: err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : code, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export type KeychainKind = 'macos' | 'libsecret' | 'none';

let keychainKind: Promise<KeychainKind> | undefined;

export function detectKeychain(): Promise<KeychainKind> {
  keychainKind ??= (async () => {
    if (process.env.PARLEY_NO_KEYCHAIN) return 'none';
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'linux') {
      // secret-tool needs a running Secret Service (GNOME Keyring/KWallet),
      // which usually requires a D-Bus session.
      if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) return 'none';
      const r = await run('secret-tool', ['--version'], undefined, 2000);
      if (r.code === 127) return 'none';
      return 'libsecret';
    }
    return 'none';
  })();
  return keychainKind;
}

export function keychainLabel(kind: KeychainKind): string {
  return kind === 'macos' ? 'macOS Keychain' : kind === 'libsecret' ? 'Secret Service (libsecret)' : 'none';
}

async function keychainGet(provider: string): Promise<string | undefined> {
  const kind = await detectKeychain();
  if (kind === 'macos') {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', provider, '-w']);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') || undefined : undefined;
  }
  if (kind === 'libsecret') {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', provider]);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') || undefined : undefined;
  }
  return undefined;
}

async function keychainSet(provider: string, key: string): Promise<boolean> {
  const kind = await detectKeychain();
  if (kind === 'macos') {
    // -U updates an existing item. The key is passed as an argument, which is
    // briefly visible to the local user's own processes; `security` offers no
    // stdin option for -w without an interactive prompt.
    const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', provider, '-l', `parley: ${provider}`, '-w', key]);
    return r.code === 0;
  }
  if (kind === 'libsecret') {
    const r = await run('secret-tool', ['store', '--label', `parley: ${provider}`, 'service', SERVICE, 'account', provider], key);
    return r.code === 0;
  }
  return false;
}

async function keychainDelete(provider: string): Promise<boolean> {
  const kind = await detectKeychain();
  if (kind === 'macos') return (await run('security', ['delete-generic-password', '-s', SERVICE, '-a', provider])).code === 0;
  if (kind === 'libsecret') return (await run('secret-tool', ['clear', 'service', SERVICE, 'account', provider])).code === 0;
  return false;
}

// ------------------------------------------------------- credentials file

function readCredentialsFile(file = paths.credentialsFile): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    // Tighten permissions if someone loosened them.
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) chmodSync(file, 0o600);
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCredentialsFile(entries: Record<string, string>, file = paths.credentialsFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body =
    '# parley credentials — API keys for machines without a keychain.\n# Format: provider-name = key. This file must stay private (mode 0600).\n' +
    Object.entries(entries)
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n') +
    '\n';
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ------------------------------------------------------------- public API

const cache = new Map<string, ResolvedKey>();

export async function resolveKey(p: ProviderConfig): Promise<ResolvedKey> {
  const cached = cache.get(p.name);
  if (cached) return cached;
  const envName = p.apiKeyEnv ?? defaultKeyEnv(p);
  let res: ResolvedKey = { source: 'none' };
  const envVal = envName ? process.env[envName] : undefined;
  if (envVal) res = { key: envVal.trim(), source: 'env', detail: envName };
  else {
    const kc = await keychainGet(p.name).catch(() => undefined);
    if (kc) res = { key: kc, source: 'keychain', detail: keychainLabel(await detectKeychain()) };
    else {
      const f = readCredentialsFile()[p.name];
      if (f) res = { key: f, source: 'file', detail: paths.credentialsFile };
    }
  }
  if (res.key) cache.set(p.name, res);
  return res;
}

export async function storeKey(provider: string, key: string): Promise<{ store: KeySource; detail: string }> {
  cache.delete(provider);
  if (await keychainSet(provider, key)) {
    // Remove any stale copy from the file.
    const entries = readCredentialsFile();
    if (entries[provider]) {
      delete entries[provider];
      writeCredentialsFile(entries);
    }
    return { store: 'keychain', detail: keychainLabel(await detectKeychain()) };
  }
  const entries = readCredentialsFile();
  entries[provider] = key;
  writeCredentialsFile(entries);
  return { store: 'file', detail: paths.credentialsFile };
}

export async function deleteKey(provider: string): Promise<void> {
  cache.delete(provider);
  await keychainDelete(provider).catch(() => false);
  const entries = readCredentialsFile();
  if (entries[provider]) {
    delete entries[provider];
    writeCredentialsFile(entries);
  }
}

/** Remove anything that looks like a known secret from a string. */
export function redact(text: string, secrets: Array<string | undefined> = [...cache.values()].map((c) => c.key)): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/("?(?:x-api-key|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^",\s}]{8,}/gi, '$1[redacted]');
}

export function knownSecrets(): string[] {
  return [...cache.values()].map((c) => c.key).filter((k): k is string => !!k);
}
