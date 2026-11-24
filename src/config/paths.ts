// XDG base directories on both macOS and Linux (deliberately not
// ~/Library/Application Support: one layout everywhere is easier to manage).

import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP, OLD_APP } from '../brand.js';

function xdg(varName: string, fallback: string): string {
  const v = process.env[varName];
  return v && v.startsWith('/') ? v : join(homedir(), fallback);
}

export type DirKind = 'config' | 'data' | 'state' | 'cache';

const BASES: Record<DirKind, { xdg: string; fallback: string; env: string }> = {
  config: { xdg: 'XDG_CONFIG_HOME', fallback: '.config', env: 'TARIA_CONFIG_DIR' },
  data: { xdg: 'XDG_DATA_HOME', fallback: '.local/share', env: 'TARIA_DATA_DIR' },
  state: { xdg: 'XDG_STATE_HOME', fallback: '.local/state', env: 'TARIA_STATE_DIR' },
  cache: { xdg: 'XDG_CACHE_HOME', fallback: '.cache', env: 'TARIA_CACHE_DIR' },
};
export const DIR_KINDS = Object.keys(BASES) as DirKind[];

/** Directories this run uses instead of the usual ones (the migration from
 * parley sets one when it has to wait for a running parley). */
const overrides: Partial<Record<DirKind, string>> = {};

export function setDirOverride(kind: DirKind, dir: string | undefined): void {
  if (dir === undefined) delete overrides[kind];
  else overrides[kind] = dir;
}

/** Set explicitly with TARIA_*_DIR (or PARLEY_*_DIR): never migrated. */
export function dirIsExplicit(kind: DirKind): boolean {
  return !!process.env[BASES[kind].env];
}

/** Does any of parley's old directories exist? (A cheap check, made on every
 * start, before the migration code is loaded.) */
export function legacyDirsPresent(): boolean {
  return DIR_KINDS.some((k) => {
    if (dirIsExplicit(k)) return false;
    try {
      lstatSync(dirFor(k, OLD_APP));
      return true;
    } catch {
      return false;
    }
  });
}

export function dirFor(kind: DirKind, name: string): string {
  return join(xdg(BASES[kind].xdg, BASES[kind].fallback), name);
}

function dir(kind: DirKind): string {
  return overrides[kind] ?? process.env[BASES[kind].env] ?? dirFor(kind, APP);
}

export const paths = {
  get configDir(): string {
    return dir('config');
  },
  get dataDir(): string {
    return dir('data');
  },
  get cacheDir(): string {
    return dir('cache');
  },
  get stateDir(): string {
    return dir('state');
  },
  /** Where parley 0.2.0 and earlier kept each kind of file. */
  legacyDir(kind: DirKind): string {
    return dirFor(kind, OLD_APP);
  },
  get configFile(): string {
    return join(this.configDir, 'config.yaml');
  },
  get credentialsFile(): string {
    return join(this.configDir, 'credentials');
  },
  get commandsDir(): string {
    return join(this.configDir, 'commands');
  },
  get conversationsDir(): string {
    return join(this.dataDir, 'conversations');
  },
  get attachmentsDir(): string {
    return join(this.dataDir, 'attachments');
  },
  get trashDir(): string {
    return join(this.dataDir, 'trash');
  },
  get historyFile(): string {
    return join(this.dataDir, 'history.jsonl');
  },
  get logDir(): string {
    return join(this.stateDir, 'logs');
  },
};
