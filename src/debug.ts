// --debug logging: requests, responses and timings to a file, with secrets
// redacted. Disabled (a no-op) unless enabled at startup.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config/paths.js';
import { redact } from './config/credentials.js';

let file: string | undefined;

export function enableDebug(path?: string): string {
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  file = path ?? join(paths.logDir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  debug('debug log started', { pid: process.pid, argv: process.argv.slice(2), node: process.version, platform: process.platform });
  return file;
}

export function debugEnabled(): boolean {
  return file !== undefined;
}

export function debugFile(): string | undefined {
  return file;
}

/** Request headers whose values say nothing secret. Every other header is
 * logged by name only: a gateway's credential can be called anything
 * (X-Auth-Token, Ocp-Apim-Subscription-Key, CF-Access-Client-Secret...). */
const PLAIN_HEADERS = /^(accept|accept-encoding|accept-language|content-type|content-length|user-agent|anthropic-version|anthropic-beta|openai-beta)$/i;

export function headersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = PLAIN_HEADERS.test(k) ? v : '[redacted]';
  return out;
}

/** Shorten long strings (e.g. base64 images) in logged objects. */
function shrink(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…[${v.length - 2000} more chars]` : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => shrink(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = /^(x-api-key|(proxy-)?authorization|api[-_]?key|(set-)?cookie)$|(^|[-_])(token|secret|password)$/i.test(k) ? '[redacted]' : shrink(x, depth + 1);
  }
  return out;
}

export function debug(message: string, data?: unknown): void {
  if (!file) return;
  try {
    const line = `${new Date().toISOString()} ${message}${data === undefined ? '' : ' ' + JSON.stringify(shrink(data))}`;
    appendFileSync(file, redact(line) + '\n', { mode: 0o600 });
  } catch {
    /* never let logging break the app */
  }
}
