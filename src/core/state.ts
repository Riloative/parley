// Small persistent UI state (recently used models). Written atomically via
// rename so concurrent instances never see a half-written file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths.js';

export interface AppState {
  recentModels: string[];
  favouriteModels: string[];
  /** Opt-in update check: when it last ran and what it found. */
  updateCheck?: { at: number; latest?: string; notified?: string };
}

function file(): string {
  return join(paths.dataDir, 'state.json');
}

export function loadState(): AppState {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppState>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const uc = s.updateCheck;
    return {
      recentModels: strings(s.recentModels),
      favouriteModels: strings(s.favouriteModels),
      ...(uc && typeof uc === 'object' && typeof uc.at === 'number' ? { updateCheck: { at: uc.at, ...(typeof uc.latest === 'string' ? { latest: uc.latest } : {}), ...(typeof uc.notified === 'string' ? { notified: uc.notified } : {}) } } : {}),
    };
  } catch {
    return { recentModels: [], favouriteModels: [] };
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

/** Add or remove a favourite model; returns whether it is now a favourite. */
export function toggleFavouriteModel(model: string): boolean {
  let on = false;
  saveState((s) => {
    on = !s.favouriteModels.includes(model);
    return { ...s, favouriteModels: on ? [...s.favouriteModels, model] : s.favouriteModels.filter((m) => m !== model) };
  });
  return on;
}
