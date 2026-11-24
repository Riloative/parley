// Configuration: one commented YAML file. Validation reports each mistake with
// its line number and a plain explanation; invalid settings are ignored (with
// the error shown) rather than crashing.

import { existsSync, readFileSync } from 'node:fs';
import { LineCounter, parseDocument, isMap, isScalar, type Document, type Node } from 'yaml';
import { paths } from './paths.js';
import type { ProviderType, SamplingSettings } from '../providers/types.js';
import type { ThemeName } from '../render/theme.js';

export interface ModelConfig {
  sampling?: SamplingSettings;
  contextWindow?: number;
  images?: boolean;
  reasoning?: boolean;
}

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  /** Environment variable holding the key (overrides the default for the type). */
  apiKeyEnv?: string;
  /** No key is needed (local servers). */
  noKey?: boolean;
  headers: Record<string, string>;
  contextWindow?: number;
  sampling?: SamplingSettings;
  models: Record<string, ModelConfig>;
  timeoutMs?: number;
}

export interface Persona {
  name: string;
  prompt: string;
  model?: string;
}

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface Config {
  defaultModel?: string;
  titleModel?: string;
  compactModel?: string;
  theme: ThemeName | 'auto';
  bell: boolean;
  bellAfterSeconds: number;
  /** Desktop notification when a long reply finishes while the terminal
   * is not focused: auto-detect the terminal's protocol, force one, or off. */
  notifications: 'auto' | 'off' | 'osc9' | 'osc777' | 'osc99';
  terminalTitle: boolean;
  /** A single newline inside a Markdown paragraph: keep it as a line break
   * (default), or join the lines as CommonMark does. */
  softLineBreaks: 'keep' | 'join';
  systemPrompt?: string;
  reasoningEffort?: string;
  providers: Record<string, ProviderConfig>;
  personas: Record<string, Persona>;
  prices: Record<string, Price>;
}

export interface ConfigIssue {
  line?: number;
  message: string;
}

export interface LoadedConfig {
  config: Config;
  issues: ConfigIssue[];
  file: string;
  exists: boolean;
}

export const defaultConfig = (): Config => ({
  theme: 'auto',
  bell: true,
  bellAfterSeconds: 10,
  notifications: 'auto',
  terminalTitle: true,
  softLineBreaks: 'keep',
  providers: {},
  personas: {},
  prices: {},
});

const TOP_KEYS = [
  'default_model',
  'title_model',
  'compact_model',
  'theme',
  'bell',
  'bell_after_seconds',
  'notifications',
  'terminal_title',
  'soft_line_breaks',
  'system_prompt',
  'reasoning_effort',
  'providers',
  'personas',
  'prices',
] as const;

const PROVIDER_KEYS = ['type', 'base_url', 'api_key_env', 'no_key', 'headers', 'context_window', 'sampling', 'models', 'timeout_ms'];
const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'max_tokens', 'extra_body'];
const MODEL_KEYS = ['sampling', 'context_window', 'images', 'reasoning'];
const PROVIDER_TYPES: ProviderType[] = ['anthropic', 'openai', 'openai-compatible', 'mock'];
const SECRET_KEYS = /^(api_?key|key|token|secret|password|authorization)$/i;

function suggest(word: string, options: readonly string[]): string {
  let best = '';
  let bestD = Infinity;
  for (const o of options) {
    const d = editDistance(word, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= 3 ? ` Did you mean "${best}"?` : '';
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

class Validator {
  issues: ConfigIssue[] = [];
  constructor(
    private doc: Document,
    private lc: LineCounter,
  ) {}

  lineOf(node: Node | null | undefined): number | undefined {
    const r = node?.range;
    return r ? this.lc.linePos(r[0]).line : undefined;
  }

  err(node: Node | null | undefined, message: string): void {
    this.issues.push({ line: this.lineOf(node), message });
  }

  keyNode(path: Array<string | number>): Node | undefined {
    // The node for the key itself gives the most useful line number.
    const parent = path.length > 1 ? this.doc.getIn(path.slice(0, -1), true) : this.doc.contents;
    if (isMap(parent)) {
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === path[path.length - 1]);
      if (pair && isScalar(pair.key)) return pair.key as Node;
    }
    return this.doc.getIn(path, true) as Node | undefined;
  }

  checkKeys(path: Array<string | number>, value: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const k of Object.keys(value)) {
      if (allowed.includes(k)) continue;
      if (SECRET_KEYS.test(k)) {
        this.err(this.keyNode([...path, k]), `${where}: "${k}" looks like a secret. Keys never go in the config file — set an environment variable, or run "parley key set <provider>" to store it in the keychain.`);
      } else {
        this.err(this.keyNode([...path, k]), `${where}: unknown setting "${k}".${suggest(k, allowed)}`);
      }
    }
  }

  str(path: Array<string | number>, v: unknown, what: string): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v;
    this.err(this.keyNode(path), `${what} should be text, but it is ${describe(v)}.`);
    return undefined;
  }

  bool(path: Array<string | number>, v: unknown, what: string): boolean | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    this.err(this.keyNode(path), `${what} should be true or false, but it is ${describe(v)}.`);
    return undefined;
  }

  num(path: Array<string | number>, v: unknown, what: string, min?: number, max?: number): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(this.keyNode(path), `${what} should be a number, but it is ${describe(v)}.`);
      return undefined;
    }
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      this.err(this.keyNode(path), `${what} must be between ${min ?? '-∞'} and ${max ?? '∞'} (got ${v}).`);
      return undefined;
    }
    return v;
  }

  map(path: Array<string | number>, v: unknown, what: string): Record<string, unknown> | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    this.err(this.keyNode(path), `${what} should be a set of "key: value" entries, but it is ${describe(v)}.`);
    return undefined;
  }

  modelRef(path: Array<string | number>, v: unknown, what: string): string | undefined {
    const s = this.str(path, v, what);
    if (s === undefined) return undefined;
    if (!/^[^/\s]+\/\S+$/.test(s)) {
      this.err(this.keyNode(path), `${what} should look like "provider/model-id" (for example "anthropic/claude-opus-5-5"), but it is "${s}".`);
      return undefined;
    }
    return s;
  }

  sampling(path: Array<string | number>, v: unknown, where: string): SamplingSettings | undefined {
    const m = this.map(path, v, `${where} sampling`);
    if (!m) return undefined;
    this.checkKeys(path, m, SAMPLING_KEYS, `${where} sampling`);
    const s: SamplingSettings = {};
    const t = this.num([...path, 'temperature'], m.temperature, 'temperature', 0, 2);
    if (t !== undefined) s.temperature = t;
    const tp = this.num([...path, 'top_p'], m.top_p, 'top_p', 0, 1);
    if (tp !== undefined) s.topP = tp;
    const tk = this.num([...path, 'top_k'], m.top_k, 'top_k', 1);
    if (tk !== undefined) s.topK = tk;
    const mt = this.num([...path, 'max_tokens'], m.max_tokens, 'max_tokens', 1);
    if (mt !== undefined) s.maxTokens = Math.floor(mt);
    const eb = this.map([...path, 'extra_body'], m.extra_body, 'extra_body');
    if (eb) s.extraBody = eb;
    return s;
  }
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return 'a list';
  if (v === null) return 'empty';
  if (typeof v === 'object') return 'a set of entries';
  if (typeof v === 'string') return `the text "${v}"`;
  return String(v);
}

export function parseConfig(text: string): { config: Config; issues: ConfigIssue[] } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  const config = defaultConfig();
  const v = new Validator(doc, lc);
  for (const e of doc.errors) {
    v.issues.push({ line: e.linePos?.[0]?.line ?? lc.linePos(e.pos[0]).line, message: `The file is not valid YAML: ${e.message.split('\n')[0]}` });
  }
  if (doc.errors.length) return { config, issues: v.issues };
  const raw = doc.toJS() as unknown;
  if (raw === null || raw === undefined) return { config, issues: v.issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    v.issues.push({ line: 1, message: 'The config file should contain "key: value" settings at the top level.' });
    return { config, issues: v.issues };
  }
  const r = raw as Record<string, unknown>;
  v.checkKeys([], r, TOP_KEYS, 'config');

  config.defaultModel = v.modelRef(['default_model'], r.default_model, 'default_model');
  config.titleModel = v.modelRef(['title_model'], r.title_model, 'title_model');
  config.compactModel = v.modelRef(['compact_model'], r.compact_model, 'compact_model');
  const theme = v.str(['theme'], r.theme, 'theme');
  if (theme !== undefined) {
    if (['auto', 'dark', 'light', 'ansi'].includes(theme)) config.theme = theme as Config['theme'];
    else v.err(v.keyNode(['theme']), `theme must be one of auto, dark, light or ansi (got "${theme}").`);
  }
  config.bell = v.bool(['bell'], r.bell, 'bell') ?? config.bell;
  config.bellAfterSeconds = v.num(['bell_after_seconds'], r.bell_after_seconds, 'bell_after_seconds', 0) ?? config.bellAfterSeconds;
  const notif = v.str(['notifications'], r.notifications, 'notifications');
  if (notif !== undefined) {
    if (['auto', 'off', 'osc9', 'osc777', 'osc99'].includes(notif)) config.notifications = notif as Config['notifications'];
    else v.err(v.keyNode(['notifications']), `notifications must be one of auto, off, osc9, osc777 or osc99 (got "${notif}").`);
  }
  config.terminalTitle = v.bool(['terminal_title'], r.terminal_title, 'terminal_title') ?? config.terminalTitle;
  const slb = v.str(['soft_line_breaks'], r.soft_line_breaks, 'soft_line_breaks');
  if (slb !== undefined) {
    if (slb === 'keep' || slb === 'join') config.softLineBreaks = slb;
    else v.err(v.keyNode(['soft_line_breaks']), `soft_line_breaks must be keep or join (got "${slb}").`);
  }
  config.systemPrompt = v.str(['system_prompt'], r.system_prompt, 'system_prompt');
  const effort = v.str(['reasoning_effort'], r.reasoning_effort, 'reasoning_effort');
  if (effort !== undefined) {
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) config.reasoningEffort = effort;
    else v.err(v.keyNode(['reasoning_effort']), `reasoning_effort must be one of off, minimal, low, medium, high, xhigh, max (got "${effort}").`);
  }

  const providers = v.map(['providers'], r.providers, 'providers') ?? {};
  for (const [name, pv] of Object.entries(providers)) {
    const path = ['providers', name];
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      v.err(v.keyNode(path), `Provider name "${name}" may only contain letters, digits, ".", "_" and "-".`);
      continue;
    }
    const p = v.map(path, pv, `providers.${name}`);
    if (!p) continue;
    v.checkKeys(path, p, PROVIDER_KEYS, `providers.${name}`);
    const type = v.str([...path, 'type'], p.type, `providers.${name}.type`);
    if (!type) {
      v.err(v.keyNode(path), `providers.${name} needs a "type": one of ${PROVIDER_TYPES.join(', ')}.`);
      continue;
    }
    if (!PROVIDER_TYPES.includes(type as ProviderType)) {
      v.err(v.keyNode([...path, 'type']), `providers.${name}.type must be one of ${PROVIDER_TYPES.join(', ')} (got "${type}").${suggest(type, PROVIDER_TYPES)}`);
      continue;
    }
    const baseUrl = v.str([...path, 'base_url'], p.base_url, `providers.${name}.base_url`);
    if (baseUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      v.err(v.keyNode([...path, 'base_url']), `providers.${name}.base_url should be a URL starting with http:// or https:// (got "${baseUrl}").`);
      continue;
    }
    if (type === 'openai-compatible' && !baseUrl) {
      v.err(v.keyNode(path), `providers.${name} is an openai-compatible provider, so it needs a base_url (for example http://localhost:8080/v1).`);
      continue;
    }
    const headers: Record<string, string> = {};
    const hm = v.map([...path, 'headers'], p.headers, `providers.${name}.headers`);
    for (const [hk, hv] of Object.entries(hm ?? {})) {
      if (typeof hv !== 'string') v.err(v.keyNode([...path, 'headers', hk]), `Header "${hk}" should be text.`);
      else if (/^(authorization|x-api-key|api-key)$/i.test(hk) && !/^\$\{?[A-Z_][A-Z0-9_]*\}?$|^env:/.test(hv)) {
        v.err(v.keyNode([...path, 'headers', hk]), `Header "${hk}" carries a secret. Use "env:VARIABLE_NAME" to read it from the environment instead of writing it here.`);
      } else headers[hk] = hv;
    }
    const models: Record<string, ModelConfig> = {};
    const mm = v.map([...path, 'models'], p.models, `providers.${name}.models`);
    for (const [mid, mv] of Object.entries(mm ?? {})) {
      const mpath = [...path, 'models', mid];
      const m = v.map(mpath, mv ?? {}, `providers.${name}.models.${mid}`) ?? {};
      v.checkKeys(mpath, m, MODEL_KEYS, `providers.${name}.models.${mid}`);
      models[mid] = {
        sampling: v.sampling([...mpath, 'sampling'], m.sampling, `${name}/${mid}`),
        contextWindow: v.num([...mpath, 'context_window'], m.context_window, 'context_window', 256),
        images: v.bool([...mpath, 'images'], m.images, 'images'),
        reasoning: v.bool([...mpath, 'reasoning'], m.reasoning, 'reasoning'),
      };
    }
    const apiKeyEnv = v.str([...path, 'api_key_env'], p.api_key_env, `providers.${name}.api_key_env`);
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      v.err(v.keyNode([...path, 'api_key_env']), `api_key_env should be the NAME of an environment variable (like MY_API_KEY), not the key itself.`);
    }
    config.providers[name] = {
      name,
      type: type as ProviderType,
      baseUrl: baseUrl?.replace(/\/+$/, ''),
      apiKeyEnv: apiKeyEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv) ? apiKeyEnv : undefined,
      noKey: v.bool([...path, 'no_key'], p.no_key, `providers.${name}.no_key`),
      headers,
      contextWindow: v.num([...path, 'context_window'], p.context_window, 'context_window', 256),
      sampling: v.sampling([...path, 'sampling'], p.sampling, name),
      models,
      timeoutMs: v.num([...path, 'timeout_ms'], p.timeout_ms, 'timeout_ms', 1000),
    };
  }

  const personas = v.map(['personas'], r.personas, 'personas') ?? {};
  for (const [name, pv] of Object.entries(personas)) {
    if (typeof pv === 'string') config.personas[name] = { name, prompt: pv };
    else {
      const m = v.map(['personas', name], pv, `personas.${name}`);
      if (!m) continue;
      v.checkKeys(['personas', name], m, ['prompt', 'model'], `personas.${name}`);
      const prompt = v.str(['personas', name, 'prompt'], m.prompt, `personas.${name}.prompt`);
      if (!prompt) {
        v.err(v.keyNode(['personas', name]), `personas.${name} needs a "prompt".`);
        continue;
      }
      config.personas[name] = { name, prompt, model: v.modelRef(['personas', name, 'model'], m.model, `personas.${name}.model`) };
    }
  }

  const prices = v.map(['prices'], r.prices, 'prices') ?? {};
  for (const [ref, pv] of Object.entries(prices)) {
    const path = ['prices', ref];
    const m = v.map(path, pv, `prices["${ref}"]`);
    if (!m) continue;
    v.checkKeys(path, m, ['input', 'output', 'cache_read', 'cache_write'], `prices["${ref}"]`);
    const input = v.num([...path, 'input'], m.input, 'input price', 0);
    const output = v.num([...path, 'output'], m.output, 'output price', 0);
    if (input === undefined || output === undefined) {
      v.err(v.keyNode(path), `prices["${ref}"] needs both "input" and "output" (US dollars per million tokens).`);
      continue;
    }
    config.prices[ref] = {
      input,
      output,
      cacheRead: v.num([...path, 'cache_read'], m.cache_read, 'cache_read price', 0),
      cacheWrite: v.num([...path, 'cache_write'], m.cache_write, 'cache_write price', 0),
    };
  }

  for (const [key, ref] of [['default_model', config.defaultModel], ['title_model', config.titleModel], ['compact_model', config.compactModel]] as const) {
    if (!ref) continue;
    const prov = ref.split('/')[0]!;
    if (!config.providers[prov] && prov !== 'mock') {
      v.err(v.keyNode([key]), `${key} uses provider "${prov}", which is not defined under providers.${suggest(prov, Object.keys(config.providers))}`);
    }
  }
  return { config, issues: v.issues };
}

export function loadConfig(file = paths.configFile): LoadedConfig {
  if (!existsSync(file)) return { config: defaultConfig(), issues: [], file, exists: false };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { config: defaultConfig(), issues: [{ message: `Could not read ${file}: ${(e as Error).message}` }], file, exists: true };
  }
  const { config, issues } = parseConfig(text);
  return { config, issues, file, exists: true };
}

export function formatIssues(file: string, issues: ConfigIssue[]): string[] {
  return issues.map((i) => `${file}${i.line ? `:${i.line}` : ''}: ${i.message}`);
}
