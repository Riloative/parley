// Opt-in "a newer version exists" notice (`check_for_updates: true`). At most
// once a day parley asks GitHub for the latest release; it never downloads or
// installs anything. The request carries nothing about the user: a URL and a
// User-Agent with parley's own version. Any failure is silent.

import { getFetch } from '../providers/http.js';
import { debug } from '../debug.js';
import { VERSION } from '../version.js';
import { loadState, saveState } from './state.js';

const LATEST_URL = 'https://api.github.com/repos/Riloative/parley/releases/latest';
export const RELEASES_PAGE = 'https://github.com/Riloative/parley/releases';
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; anything else (pre-releases too) → undefined. */
export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export interface UpdateOptions {
  enabled: boolean;
  current?: string;
  url?: string;
  now?: number;
}

/** The newer version to tell the user about, or undefined: when the check is
 * off, nothing newer exists, the user was already told about this version,
 * or anything went wrong. */
export async function newerVersion(opts: UpdateOptions): Promise<string | undefined> {
  if (!opts.enabled) return undefined;
  const current = opts.current ?? VERSION;
  const now = opts.now ?? Date.now();
  const url = opts.url ?? process.env.PARLEY_UPDATE_URL ?? LATEST_URL;
  try {
    let check = loadState().updateCheck;
    if (!check || now - check.at >= DAY_MS || now < check.at) {
      const f = await getFetch();
      const res = await f(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `parley/${current}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      let latest: string | undefined;
      if (res.ok) {
        const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
        if (typeof tag === 'string' && parseVersion(tag)) latest = tag.replace(/^v/, '');
      } else debug('update check', { status: res.status });
      // A failed check also counts for the day: no retry storm on a bad network.
      const told = check?.notified;
      check = { at: now, ...(latest ? { latest } : {}), ...(told ? { notified: told } : {}) };
      const saved = check;
      saveState((s) => ({ ...s, updateCheck: saved }));
    }
    const latest = check.latest;
    if (!latest || !isNewer(latest, current) || check.notified === latest) return undefined;
    saveState((s) => ({ ...s, updateCheck: { ...(s.updateCheck ?? { at: now }), notified: latest } }));
    return latest;
  } catch (e) {
    debug('update check failed', { error: (e as Error).message });
    try {
      saveState((s) => ({ ...s, updateCheck: { ...(s.updateCheck ?? {}), at: now } }));
    } catch {
      /* best effort */
    }
    return undefined;
  }
}
