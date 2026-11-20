// Shared start-up for interactive and print modes: configuration, theme,
// stores, provider registry and model selection.

import { formatIssues, loadConfig, type Config, type ConfigIssue } from './config/config.js';
import { paths } from './config/paths.js';
import { Registry } from './providers/registry.js';
import { Store } from './core/store.js';
import { setSoftLineBreaks } from './render/markdown.js';
import { setTheme, type ThemeName } from './render/theme.js';
import { colorLevel } from './term/caps.js';
import { loadState } from './core/state.js';
import { parseModelRef } from './providers/types.js';

export interface Boot {
  config: Config;
  configFile: string;
  configExists: boolean;
  issues: string[];
  rawIssues: ConfigIssue[];
  registry: Registry;
  store: Store;
}

/** `auto` follows the terminal: its answer to the OSC 11 background query
 * when there is one, then COLORFGBG, then dark. */
export function resolveTheme(t: Config['theme'] | string | undefined, env = process.env, background?: 'light' | 'dark'): ThemeName {
  if (colorLevel() <= 1 && t !== 'dark' && t !== 'light') return 'ansi';
  if (t === 'dark' || t === 'light' || t === 'ansi') return t;
  if (background) return background;
  // COLORFGBG="15;0" → light foreground on dark background.
  const fgbg = env.COLORFGBG?.split(';');
  const bg = fgbg ? Number(fgbg[fgbg.length - 1]) : NaN;
  if (Number.isFinite(bg)) return bg === 7 || bg === 15 || (bg >= 9 && bg <= 14 && bg !== 8) ? 'light' : 'dark';
  return 'dark';
}

export function boot(themeOverride?: string, background?: 'light' | 'dark'): Boot {
  const loaded = loadConfig();
  const registry = new Registry(loaded.config);
  const store = new Store(paths.dataDir);
  setTheme(resolveTheme(themeOverride ?? loaded.config.theme, process.env, background));
  setSoftLineBreaks(loaded.config.softLineBreaks);
  return {
    config: loaded.config,
    configFile: loaded.file,
    configExists: loaded.exists,
    issues: formatIssues(loaded.file, loaded.issues),
    rawIssues: loaded.issues,
    registry,
    store,
  };
}

/** Pick the model: explicit > config default > most recent usable > none. */
export function chooseModel(b: Boot, explicit?: string, conversationModel?: string): string {
  const usable = (ref: string | undefined) => !!ref && !!parseModelRef(ref) && b.registry.has(parseModelRef(ref)!.provider);
  if (explicit) return explicit;
  if (usable(conversationModel)) return conversationModel!;
  if (usable(b.config.defaultModel)) return b.config.defaultModel!;
  const recent = loadState().recentModels.find((m) => usable(m));
  if (recent) return recent;
  return '';
}
