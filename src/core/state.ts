// Small persistent UI state (recently used models). Written atomically via
// rename so concurrent instances never see a half-written file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths.js';

export interface AppState {
  recentModels: string[];
}

function file(): string {
  return join(paths.dataDir, 'state.json');
}

export function loadState(): AppState {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppState>;
    return { recentModels: Array.isArray(s.recentModels) ? s.recentModels.filter((x) => typeof x === 'string') : [] };
  } catch {
    return { recentModels: [] };
  }
}

export function saveState(update: (s: AppState) => AppState): void {
  try {
    const next = update(loadState());
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, file());
  } catch {
    /* best effort */
  }
}

export function rememberModel(model: string): void {
  saveState((s) => ({ ...s, recentModels: [model, ...s.recentModels.filter((m) => m !== model)].slice(0, 10) }));
}
