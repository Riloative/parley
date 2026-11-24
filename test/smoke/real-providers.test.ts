// Real API smoke tests. They run only when the matching key (or local server
// URL) is present in the environment, so CI without secrets skips them.
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, MISTRAL_API_KEY,
//   TARIA_SMOKE_LOCAL_URL=http://localhost:8080/v1 (llama.cpp/Ollama/LM Studio)
import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/providers/registry.js';
import { defaultConfig, type Config, type ProviderConfig } from '../../src/config/config.js';
import type { StreamEvent } from '../../src/providers/types.js';

const cases: Array<{ env: string; provider: Omit<ProviderConfig, 'headers' | 'models'> }> = [
  { env: 'ANTHROPIC_API_KEY', provider: { name: 'anthropic', type: 'anthropic' } },
  { env: 'OPENAI_API_KEY', provider: { name: 'openai', type: 'openai' } },
  { env: 'MISTRAL_API_KEY', provider: { name: 'mistral', type: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1' } },
  { env: 'TARIA_SMOKE_LOCAL_URL', provider: { name: 'local', type: 'openai-compatible', baseUrl: process.env.TARIA_SMOKE_LOCAL_URL } },
];

for (const c of cases) {
  describe.runIf(!!process.env[c.env])(`real ${c.provider.name}`, () => {
    it('lists models and streams a short reply', async () => {
      const config: Config = { ...defaultConfig(), providers: { [c.provider.name]: { ...c.provider, headers: {}, models: {} } } };
      const reg = new Registry(config);
      const p = await reg.get(c.provider.name);
      const models = await p.listModels();
      expect(models.length).toBeGreaterThan(0);
      const model = process.env[`TARIA_SMOKE_${c.provider.name.toUpperCase()}_MODEL`] ?? models[0]!.id;
      const events: StreamEvent[] = [];
      for await (const e of p.stream({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
        sampling: { maxTokens: 2000 },
        signal: AbortSignal.timeout(120_000),
      }))
        events.push(e);
      const text = events.map((e) => (e.type === 'text' ? e.text : '')).join('');
      expect(text.toLowerCase()).toContain('pong');
    }, 180_000);
  });
}
