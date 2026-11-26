// Known provider presets (addresses only — never model names), local server
// probing for first-run setup, and the commented config file template.

import { getFetch } from '../providers/http.js';
import type { ProviderType } from '../providers/types.js';

export interface Preset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl?: string;
  keyEnv?: string;
  local?: boolean;
}

export const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', type: 'openai', keyEnv: 'OPENAI_API_KEY' },
  { id: 'mistral', label: 'Mistral', type: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  { id: 'llamacpp', label: 'llama.cpp server', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', local: true },
  { id: 'ollama', label: 'Ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM Studio', type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', local: true },
];

export interface ProviderSpec {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  comment?: string;
}

/** Ports to probe for local servers. llama-server's default moved from 8080
 * to 9931 in newer builds, so both are tried. */
const LOCAL_PROBES: Array<{ preset: string; url: string; probe: string }> = [
  { preset: 'llamacpp', url: 'http://localhost:8080/v1', probe: 'http://localhost:8080/v1/models' },
  { preset: 'llamacpp', url: 'http://localhost:9931/v1', probe: 'http://localhost:9931/v1/models' },
  { preset: 'ollama', url: 'http://localhost:11434/v1', probe: 'http://localhost:11434/api/tags' },
  { preset: 'lmstudio', url: 'http://localhost:1234/v1', probe: 'http://localhost:1234/v1/models' },
];

export interface Detected {
  preset: Preset;
  baseUrl?: string;
  how: string;
}

async function probe(url: string, ms = 700): Promise<boolean> {
  const f = await getFetch();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await f(url, { signal: ac.signal });
    return r.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function detectProviders(env = process.env): Promise<Detected[]> {
  const out: Detected[] = [];
  for (const p of PRESETS) if (p.keyEnv && env[p.keyEnv]) out.push({ preset: p, how: `${p.keyEnv} is set` });
  const results = await Promise.all(LOCAL_PROBES.map(async (l) => ({ l, ok: await probe(l.probe) })));
  const seen = new Set<string>();
  for (const { l, ok } of results) {
    if (!ok || seen.has(l.preset)) continue;
    seen.add(l.preset);
    out.push({ preset: PRESETS.find((p) => p.id === l.preset)!, baseUrl: l.url, how: `running at ${l.url.replace(/\/v1$/, '')}` });
  }
  return out;
}

function yamlStr(s: string): string {
  return /^[\w./:@-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) ? s : JSON.stringify(s);
}

export function configTemplate(providers: ProviderSpec[], defaultModel?: string): string {
  const prov = providers.length
    ? providers
        .map((p) => {
          const lines = [`  ${p.name}:`];
          if (p.comment) lines.unshift(`  # ${p.comment}`);
          lines.push(`    type: ${p.type}`);
          if (p.baseUrl) lines.push(`    base_url: ${yamlStr(p.baseUrl)}`);
          if (p.apiKeyEnv) lines.push(`    api_key_env: ${p.apiKeyEnv}`);
          return lines.join('\n');
        })
        .join('\n\n')
    : '  {}';
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/Riloative/taria/main/schema/config.schema.json
# taria configuration
#
# Models are addressed as provider/model-id, where "provider" is one of the
# names under "providers" below. Run /model inside taria to browse them.
# API keys never go in this file: taria reads them from environment
# variables, the OS keychain, or the private credentials file next to this one
# ("taria key set <provider>" stores one).

${defaultModel ? `default_model: ${yamlStr(defaultModel)}` : '# default_model: provider/model-id'}

# A cheap model for generating conversation titles (optional; without it the
# first line of your first message is used).
# title_model: provider/model-id

# Model used by /compact (defaults to the current model).
# compact_model: provider/model-id

theme: auto              # auto | dark | light | ansi
bell: true               # ring the bell when a long response finishes
bell_after_seconds: 10
terminal_title: true     # show the conversation title in the terminal title
# name: Sam              # "Welcome back, Sam!" on the start screen
# welcome_recent: false  # hide your latest conversations on the start screen
# system_prompt: "You are a helpful assistant."
# reasoning_effort: medium

providers:
${prov}

  # Examples (uncomment and adjust):
  #
  # local:                      # a llama.cpp server
  #   type: openai-compatible
  #   base_url: http://localhost:8080/v1
  #   context_window: 32768     # used if the server doesn't report it
  #
  # mistral:
  #   type: openai-compatible
  #   base_url: https://api.mistral.ai/v1
  #   api_key_env: MISTRAL_API_KEY
  #
  # Per-provider and per-model sampling (only sent when set):
  #   sampling:
  #     temperature: 0.7
  #     max_tokens: 4096
  #   models:
  #     some-model-id:
  #       sampling: { temperature: 0.2 }
  #       images: true          # override detected capabilities
  #       reasoning: true

# Saved system prompts, chosen with /persona.
personas:
  concise: "Answer as briefly as possible. Prefer bullet points."

# Optional prices for /cost, in US dollars per million tokens.
# prices:
#   anthropic/some-model: { input: 3, output: 15, cache_read: 0.3 }
#   local/*: { input: 0, output: 0 }
`;
}
