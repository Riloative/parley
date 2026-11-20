// Builds Provider instances from configuration. Adapter modules (and the
// Anthropic SDK) are imported lazily on first use so they never cost startup
// time.

import type { Config, ModelConfig, ProviderConfig } from '../config/config.js';
import { resolveKey, isLocalUrl, type ResolvedKey } from '../config/credentials.js';
import { MockProvider } from './mock.js';
import type { ModelCapabilities, Provider, ReasoningEffort, SamplingSettings } from './types.js';
import { ProviderError, parseModelRef } from './types.js';

export interface AdapterContext {
  config: ProviderConfig;
  key: ResolvedKey;
}

export class Registry {
  private instances = new Map<string, Promise<Provider>>();
  readonly mock = new MockProvider('mock');

  constructor(private config: Config) {}

  setConfig(config: Config): void {
    this.config = config;
    this.instances.clear();
  }

  providerConfigs(): ProviderConfig[] {
    return Object.values(this.config.providers);
  }

  providerConfig(name: string): ProviderConfig | undefined {
    return this.config.providers[name];
  }

  has(name: string): boolean {
    return name === 'mock' || !!this.config.providers[name];
  }

  get(name: string): Promise<Provider> {
    const existing = this.instances.get(name);
    if (existing) return existing;
    const p = this.build(name);
    this.instances.set(name, p);
    p.catch(() => this.instances.delete(name));
    return p;
  }

  private async build(name: string): Promise<Provider> {
    const pc = this.config.providers[name];
    if (!pc) {
      if (name === 'mock') return this.mock;
      throw new ProviderError('not_found', `There is no provider named "${name}". Add it under "providers" in the config file, or run /providers.`);
    }
    if (pc.type === 'mock') return new MockProvider(name);
    const key = await resolveKey(pc);
    if (!key.key && !pc.noKey && !isLocalUrl(pc.baseUrl) && pc.type !== 'openai-compatible') {
      throw new ProviderError(
        'auth',
        `No API key found for "${name}". Set ${pc.apiKeyEnv ?? (pc.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')}, or run "parley key set ${name}".`,
      );
    }
    const ctx: AdapterContext = { config: pc, key };
    switch (pc.type) {
      case 'anthropic': {
        const { AnthropicProvider } = await import('./anthropic.js');
        return new AnthropicProvider(ctx);
      }
      case 'openai': {
        const { OpenAIProvider } = await import('./openai.js');
        return new OpenAIProvider(ctx);
      }
      case 'openai-compatible': {
        const { CompatProvider } = await import('./compat.js');
        return new CompatProvider(ctx);
      }
    }
  }

  modelConfig(ref: string): ModelConfig | undefined {
    const r = parseModelRef(ref);
    if (!r) return undefined;
    return this.config.providers[r.provider]?.models[r.model];
  }

  /** Provider-level settings overlaid with model-level ones. Only keys the
   * user set are present, so nothing is sent unless configured. */
  sampling(ref: string): SamplingSettings {
    const r = parseModelRef(ref);
    if (!r) return {};
    const pc = this.config.providers[r.provider];
    const m = pc?.models[r.model];
    return { ...(pc?.sampling ?? {}), ...(m?.sampling ?? {}) };
  }

  /** Capabilities with config overrides applied. */
  async capabilities(ref: string): Promise<ModelCapabilities> {
    const r = parseModelRef(ref);
    if (!r) return { images: 'unknown', reasoning: 'unknown', reasoningEfforts: [] };
    let caps: ModelCapabilities = { images: 'unknown', reasoning: 'unknown', reasoningEfforts: [] };
    try {
      caps = await (await this.get(r.provider)).capabilities(r.model);
    } catch {
      /* fall back to unknown */
    }
    const pc = this.config.providers[r.provider];
    const mc = pc?.models[r.model];
    const out = { ...caps };
    if (mc?.images !== undefined) out.images = mc.images;
    if (mc?.reasoning !== undefined) {
      out.reasoning = mc.reasoning;
      if (mc.reasoning && !out.reasoningEfforts.length) out.reasoningEfforts = ['low', 'medium', 'high'] as ReasoningEffort[];
      if (!mc.reasoning) out.reasoningEfforts = [];
    }
    if (mc?.contextWindow) out.contextWindow = mc.contextWindow;
    else if (pc?.contextWindow && !out.contextWindow) out.contextWindow = pc.contextWindow;
    return out;
  }
}
