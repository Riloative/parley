import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.js';
import { configTemplate } from '../../src/config/presets.js';
import { redact } from '../../src/config/credentials.js';

describe('config validation', () => {
  it('parses a full config', () => {
    const { config, issues } = parseConfig(`
default_model: local/qwen3
title_model: anthropic/haiku
theme: light
bell: false
providers:
  anthropic:
    type: anthropic
  local:
    type: openai-compatible
    base_url: http://localhost:8080/v1/
    context_window: 32768
    headers: { X-Team: research }
    sampling: { temperature: 0.7, max_tokens: 2048 }
    models:
      qwen3:
        sampling: { temperature: 0.2 }
        images: false
personas:
  terse: Be terse.
  reviewer: { prompt: Review carefully., model: anthropic/opus }
prices:
  local/*: { input: 0, output: 0 }
`);
    expect(issues).toEqual([]);
    expect(config.theme).toBe('light');
    expect(config.providers.local!.baseUrl).toBe('http://localhost:8080/v1');
    expect(config.providers.local!.sampling).toEqual({ temperature: 0.7, maxTokens: 2048 });
    expect(config.providers.local!.models.qwen3!.sampling).toEqual({ temperature: 0.2 });
    expect(config.personas.reviewer).toEqual({ name: 'reviewer', prompt: 'Review carefully.', model: 'anthropic/opus' });
  });

  it('reports mistakes with line numbers and plain explanations', () => {
    const { issues, config } = parseConfig(`default_model: nope
theme: blue
providers:
  local:
    type: openai-compatable
  remote:
    type: openai-compatible
  ok:
    type: anthropic
    temprature: 1
    sampling:
      temperature: 5
`);
    const text = issues.map((i) => `${i.line}: ${i.message}`);
    expect(text).toContainEqual(expect.stringMatching(/^1: default_model should look like "provider\/model-id"/));
    expect(text).toContainEqual(expect.stringMatching(/^2: theme must be one of/));
    expect(text).toContainEqual(expect.stringMatching(/^5: .*type must be one of .*Did you mean "openai-compatible"/));
    expect(text).toContainEqual(expect.stringMatching(/^6: .*needs a base_url/));
    expect(text).toContainEqual(expect.stringMatching(/^10: .*unknown setting "temprature"/));
    expect(text).toContainEqual(expect.stringMatching(/^12: temperature must be between 0 and 2/));
    expect(config.providers.ok).toBeDefined();
    expect(config.providers.local).toBeUndefined();
  });

  it('refuses keys in the config file', () => {
    const { issues } = parseConfig(`providers:
  anthropic:
    type: anthropic
    api_key: sk-ant-abc
    headers:
      Authorization: Bearer abc
`);
    expect(issues.map((i) => i.line)).toEqual([4, 6]);
    expect(issues[0]!.message).toMatch(/Keys never go in the config file/);
  });

  it('reports YAML syntax errors with a line', () => {
    const { issues } = parseConfig('providers:\n  a: [1, 2\n');
    expect(issues[0]!.message).toMatch(/not valid YAML/);
    expect(issues[0]!.line).toBeGreaterThan(0);
  });

  it('flags a default model that names an unknown provider', () => {
    const { issues } = parseConfig('default_model: lcoal/x\nproviders:\n  local:\n    type: mock\n');
    expect(issues[0]).toMatchObject({ line: 1 });
    expect(issues[0]!.message).toMatch(/Did you mean "local"/);
  });

  it('the generated template is valid', () => {
    const { issues, config } = parseConfig(configTemplate([{ name: 'local', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }], 'local/m'));
    expect(issues).toEqual([]);
    expect(config.defaultModel).toBe('local/m');
  });
});

describe('redaction', () => {
  it('removes known secrets and key-shaped strings', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnop and mine', ['mine-secret-123'])).not.toContain('abcdefghijklmnop');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuv')).toContain('[redacted]');
    expect(redact('the value mine-secret-123 here', ['mine-secret-123'])).toBe('the value [redacted] here');
  });
});
