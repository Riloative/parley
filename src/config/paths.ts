// XDG base directories on both macOS and Linux (deliberately not
// ~/Library/Application Support: one layout everywhere is easier to manage).

import { homedir } from 'node:os';
import { join } from 'node:path';

function xdg(varName: string, fallback: string): string {
  const v = process.env[varName];
  return v && v.startsWith('/') ? v : join(homedir(), fallback);
}

export const paths = {
  get configDir(): string {
    return process.env.PARLEY_CONFIG_DIR ?? join(xdg('XDG_CONFIG_HOME', '.config'), 'parley');
  },
  get dataDir(): string {
    return process.env.PARLEY_DATA_DIR ?? join(xdg('XDG_DATA_HOME', '.local/share'), 'parley');
  },
  get cacheDir(): string {
    return process.env.PARLEY_CACHE_DIR ?? join(xdg('XDG_CACHE_HOME', '.cache'), 'parley');
  },
  get stateDir(): string {
    return process.env.PARLEY_STATE_DIR ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'parley');
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
