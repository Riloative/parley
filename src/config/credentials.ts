// API key resolution: environment variable → OS keychain → credentials file
// (0600, for headless/SSH machines without a keychain). Keys are never logged,
// written to the config, transcripts or error messages.

import { execFile } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './paths.js';
import { APP, OLD_APP } from '../brand.js';
import type { ProviderConfig } from './config.js';

export type KeySource = 'env' | 'keychain' | 'file' | 'none';

export interface ResolvedKey {
  key?: string;
  source: KeySource;
  /** Where exactly, for display ("ANTHROPIC_API_KEY", "macOS Keychain"...). */
  detail?: string;
  /** The keychain was asked and did not answer (it timed out, is locked, or
   * its tool failed): a key may be stored there all the same. */
  keychainProblem?: string;
}

const SERVICE = APP;
/** Keys stored by parley 0.2.0 and earlier: read when there is no taria entry. */
const OLD_SERVICE = OLD_APP;

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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was stopped because it did not finish in time. */
  timedOut?: boolean;
}
type Runner = (cmd: string, args: string[], input?: string, timeoutMs?: number) => Promise<RunResult>;

let runner: Runner = execRun;
/** Tests replace the keychain commands; nothing else should. */
export function _setKeychainRunner(r: Runner | undefined, kind?: KeychainKind): void {
  runner = r ?? execRun;
  keychainKind = kind === undefined ? undefined : Promise.resolve(kind);
  cache.clear();
}

const RUN_TIMEOUT_MS = 4000;

function run(cmd: string, args: string[], input?: string, timeoutMs = RUN_TIMEOUT_MS): Promise<RunResult> {
  return runner(cmd, args, input, timeoutMs);
}

function execRun(cmd: string, args: string[], input?: string, timeoutMs = RUN_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      // execFile's timeout kills the child: `killed` is then set, and there is
      // a signal instead of an exit status.
      const timedOut = !!err && ((err as { killed?: boolean }).killed === true || !!(err as { signal?: string | null }).signal);
      resolve({ code: err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
    // A tool that exits without reading its input must not crash taria (EPIPE).
    child.stdin?.on('error', () => {});
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export type KeychainKind = 'macos' | 'libsecret' | 'none';

let keychainKind: Promise<KeychainKind> | undefined;

export function detectKeychain(): Promise<KeychainKind> {
  keychainKind ??= (async () => {
    if (process.env.TARIA_NO_KEYCHAIN) return 'none';
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

/** What a keychain lookup said. "missing" is the tool's positive answer that
 * there is no such entry; "error" is everything else (a timeout, a locked
 * keyring, no D-Bus session): then the entry may well exist. */
type Lookup = { status: 'found'; key: string } | { status: 'missing' } | { status: 'error'; reason: string };

/** Why a keychain command did not answer. The tool's own output is never
 * quoted: it can repeat its arguments. */
function runFailure(tool: string, r: RunResult, timeoutMs = RUN_TIMEOUT_MS): string {
  return r.timedOut ? `${tool} did not answer within ${timeoutMs / 1000} s` : `${tool} failed (exit status ${r.code})`;
}

async function keychainLookup(service: string, provider: string): Promise<Lookup> {
  const kind = await detectKeychain();
  if (kind === 'none') return { status: 'missing' };
  const tool = kind === 'macos' ? 'security' : 'secret-tool';
  const r = kind === 'macos' ? await run(tool, ['find-generic-password', '-s', service, '-a', provider, '-w']) : await run(tool, ['lookup', 'service', service, 'account', provider]);
  if (r.timedOut) return { status: 'error', reason: runFailure(tool, r) };
  if (r.code === 0) {
    const key = r.stdout.replace(/\n$/, '');
    return key ? { status: 'found', key } : { status: 'missing' };
  }
  // "No such item": `security` exits with 44 (errSecItemNotFound);
  // `secret-tool lookup` exits with 1 and prints nothing at all.
  const notFound = kind === 'macos' ? r.code === 44 : r.code === 1 && !r.stdout.trim() && !r.stderr.trim();
  return notFound ? { status: 'missing' } : { status: 'error', reason: runFailure(tool, r) };
}

/** The keychain was asked and did not answer. */
class KeychainError extends Error {}

/** The key under taria's name, else under parley's. A key found only under
 * parley's name is also stored under taria's (the old entry is left, so an
 * old parley keeps working; `taria key status` mentions it). */
let lookOnly = false;
/** `taria doctor` and `taria key status` must change nothing: after this, no
 * lookup in this process copies parley's keychain entry to taria's name. */
export function setKeychainReadOnly(): void {
  lookOnly = true;
}

async function keychainGet(provider: string, readOnly = false): Promise<{ key: string; from: 'taria' | 'old'; copied: boolean } | undefined> {
  const current = await keychainLookup(SERVICE, provider);
  if (current.status === 'found') return { key: current.key, from: 'taria', copied: false };
  // Only a positive "there is no taria entry" lets parley's old key be used
  // and copied: after a timeout or an error, taria's entry may hold a newer
  // key, which the old one must never replace.
  if (current.status === 'error') throw new KeychainError(current.reason);
  const old = await keychainLookup(OLD_SERVICE, provider);
  if (old.status === 'error') throw new KeychainError(old.reason);
  if (old.status === 'missing') return undefined;
  // `taria doctor` and `taria key status` only look: they must change nothing.
  const copied = readOnly || lookOnly ? false : await keychainSet(provider, old.key).catch(() => false);
  return { key: old.key, from: 'old', copied };
}

/** `taria key remove-old`: removes the key under parley's name, but never
 * the only copy. If taria's name has no key yet, the old one is stored there
 * first and read back; if that fails, nothing is removed. */
export async function removeOldKeychainEntry(provider: string): Promise<'none' | 'removed' | 'copied-and-removed' | 'copy-failed' | 'remove-failed' | 'no-answer'> {
  const failed: Lookup = { status: 'error', reason: 'failed' };
  const old = await keychainLookup(OLD_SERVICE, provider).catch(() => failed);
  if (old.status === 'error') return 'no-answer';
  if (old.status === 'missing') return 'none';
  let copied = false;
  const current = await keychainLookup(SERVICE, provider).catch(() => failed);
  // A keychain that did not answer may hold a newer key under taria's name:
  // nothing is copied over it, and so nothing is removed.
  if (current.status === 'error') return 'no-answer';
  if (current.status === 'missing') {
    const stored = await keychainSet(provider, old.key).catch(() => false);
    const back = stored ? await keychainLookup(SERVICE, provider).catch(() => failed) : failed;
    if (back.status !== 'found' || back.key !== old.key) return 'copy-failed';
    copied = true;
  }
  if (!(await deleteOldKeychainEntry(provider).catch(() => false))) return 'remove-failed';
  cache.delete(provider);
  return copied ? 'copied-and-removed' : 'removed';
}

async function deleteOldKeychainEntry(provider: string): Promise<boolean> {
  const kind = await detectKeychain();
  if (kind === 'macos') return (await run('security', ['delete-generic-password', '-s', OLD_SERVICE, '-a', provider])).code === 0;
  if (kind === 'libsecret') return (await run('secret-tool', ['clear', 'service', OLD_SERVICE, 'account', provider])).code === 0;
  return false;
}

/** Is there still a key under parley's name? (For `key status` and doctor.) */
export async function hasOldKeychainEntry(provider: string): Promise<boolean> {
  return (await keychainLookup(OLD_SERVICE, provider).catch(() => undefined))?.status === 'found';
}

async function keychainSet(provider: string, key: string): Promise<boolean> {
  const kind = await detectKeychain();
  if (kind === 'macos') {
    // -U updates an existing item. The key is passed as an argument, which is
    // briefly visible to the local user's own processes; `security` offers no
    // stdin option for -w without an interactive prompt.
    const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', provider, '-l', `taria: ${provider}`, '-w', key]);
    return r.code === 0;
  }
  if (kind === 'libsecret') {
    const r = await run('secret-tool', ['store', '--label', `taria: ${provider}`, 'service', SERVICE, 'account', provider], key);
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

/** A key or provider name that cannot be stored; the message never quotes it. */
export class CredentialError extends Error {}

/** Why this text cannot be an API key, or undefined when it can. A key is
 * one line of printable text: a line break would start another entry in the
 * credentials file, and no provider issues keys with control characters. */
export function keyProblem(key: string): string | undefined {
  if (!key) return 'The key is empty.';
  if (/[\r\n]/.test(key)) return 'The key contains a line break. A key is a single line: enter or pipe only the key itself.';
  if (/[\x00-\x1f\x7f]/.test(key)) return 'The key contains a control character (a tab or an escape sequence, perhaps from a paste). Enter only the key itself.';
  return undefined;
}

/** The names `readCredentialsFile` reads back (and the config file allows). */
function providerNameProblem(name: string): string | undefined {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? undefined : 'The provider name may only contain letters, digits, ".", "_" and "-".';
}

function writeCredentialsFile(entries: Record<string, string>, file = paths.credentialsFile): void {
  for (const [k, v] of Object.entries(entries)) {
    const problem = providerNameProblem(k) ?? keyProblem(v) ?? (v !== v.trim() ? 'The key starts or ends with a space.' : undefined);
    if (problem) throw new CredentialError(`${problem} Nothing was written to the credentials file.`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body =
    '# taria credentials — API keys for machines without a keychain.\n# Format: provider-name = key. This file must stay private (mode 0600).\n' +
    Object.entries(entries)
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n') +
    '\n';
  // Written in full to a private temporary file, then renamed over the old
  // one: a crash or a full disk leaves the stored keys as they were, and the
  // keys are never in a file that others can read. (A link is followed, so
  // the file it points to is the one replaced.)
  const target = existsSync(file) ? realpathSync(file) : file;
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ------------------------------------------------------------- public API

const cache = new Map<string, ResolvedKey>();

export async function resolveKey(p: ProviderConfig, opts: { readOnly?: boolean } = {}): Promise<ResolvedKey> {
  const cached = cache.get(p.name);
  if (cached) return cached;
  const envName = p.apiKeyEnv ?? defaultKeyEnv(p);
  let res: ResolvedKey = { source: 'none' };
  const envVal = envName ? process.env[envName] : undefined;
  if (envVal) res = { key: envVal.trim(), source: 'env', detail: envName };
  else {
    let keychainProblem: string | undefined;
    const kc = await keychainGet(p.name, opts.readOnly).catch((e: unknown) => {
      keychainProblem = e instanceof KeychainError ? e.message : 'the keychain could not be read';
      return undefined;
    });
    if (kc) res = { key: kc.key, source: 'keychain', detail: `${keychainLabel(await detectKeychain())}${kc.copied ? ` (copied from the ${OLD_APP} entry)` : kc.from === 'old' ? ` (the ${OLD_APP} entry)` : ''}` };
    else {
      const f = readCredentialsFile()[p.name];
      if (f) res = { key: f, source: 'file', detail: paths.credentialsFile };
      else {
        // parley's credentials file, when its config folder was not moved
        // (both folders existed).
        const oldFile = join(paths.legacyDir('config'), 'credentials');
        const o = oldFile !== paths.credentialsFile ? readCredentialsFile(oldFile)[p.name] : undefined;
        if (o) res = { key: o, source: 'file', detail: oldFile };
      }
    }
    // Not remembered: the next lookup asks the keychain again.
    if (keychainProblem) return { ...res, keychainProblem };
  }
  // A look that copied nothing is not remembered: the next normal lookup in
  // this process still stores the key under taria's name.
  if (res.key && !(opts.readOnly && !lookOnly && res.source === 'keychain')) cache.set(p.name, res);
  return res;
}

/** Store a key. Throws a CredentialError (a plain sentence, without the key)
 * for a key or provider name that cannot be stored. */
export async function storeKey(provider: string, key: string): Promise<{ store: KeySource; detail: string }> {
  const problem = (providerNameProblem(provider) && `Cannot store a key for this provider name. ${providerNameProblem(provider)}`) || keyProblem(key);
  if (problem) throw new CredentialError(problem);
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

/** The shortest secret that is redacted. Local gateways take short tokens
 * (7 characters was seen), so the limit is low: at 4, a key like "test"
 * also blanks that word wherever it appears in a message, which costs some
 * readability and leaks nothing. Below 4 a "secret" is a fragment of ordinary
 * words: redacting it would garble every message, and hide nothing that
 * cannot be guessed. */
export const MIN_SECRET_LENGTH = 4;

/** Secrets that are not API keys: header values read from the environment. */
const otherSecrets = new Set<string>();

/** Make `redact()` remove this value from now on. */
export function registerSecret(value: string | undefined): void {
  const v = value?.trim();
  if (v && v.length >= MIN_SECRET_LENGTH) otherSecrets.add(v);
}

/** A secret as it is, and as it looks inside JSON text (a server's error
 * body) and inside JSON that quotes that text (the debug log): a quote or a
 * backslash in a key is escaped once per level. */
function secretForms(secret: string): string[] {
  const forms = [secret];
  for (let i = 0; i < 3; i++) {
    const next = JSON.stringify(forms[i]).slice(1, -1);
    if (next === forms[i]) break;
    forms.push(next);
  }
  return forms;
}

/** Remove anything that looks like a known secret from a string. */
export function redact(text: string, secrets: Array<string | undefined> = knownSecrets()): string {
  const forms = new Set<string>();
  for (const s of secrets) if (s && s.length >= MIN_SECRET_LENGTH) for (const f of secretForms(s)) forms.add(f);
  let out = text;
  // The longest first, so that a secret contained in another leaves no remainder.
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('[redacted]');
  return out
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/("?(?:x-api-key|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^",\s}]{8,}/gi, '$1[redacted]');
}

export function knownSecrets(): string[] {
  return [...[...cache.values()].map((c) => c.key).filter((k): k is string => !!k), ...otherSecrets];
}
