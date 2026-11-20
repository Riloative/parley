// Multi-step screens: first-run setup, /providers and /config.

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { dirname } from 'node:path';
import type { Document } from 'yaml';
import { Picker, Prompt, type PickerItem } from './overlays.js';
import { PRESETS, configTemplate, detectProviders, type Detected, type Preset, type ProviderSpec } from '../config/presets.js';
import { storeKey, resolveKey, deleteKey, isLocalUrl } from '../config/credentials.js';
import type { Config, ProviderConfig } from '../config/config.js';
import { loadConfig } from '../config/config.js';
import { Registry } from '../providers/registry.js';
import type { Session } from '../core/session.js';
import { themeHex } from '../render/theme.js';
import { truncate } from '../render/width.js';

type WriteConfig = (update: (doc: Document) => void) => boolean;

// ------------------------------------------------------------ provider wizard

interface WizardProps {
  cols: number;
  existing: string[];
  onDone: (spec: ProviderSpec | null, key?: string) => void;
}

/** Choose a preset → name → base URL → key. */
function AddProviderWizard({ cols, existing, onDone }: WizardProps): React.ReactElement {
  const [step, setStep] = useState<'preset' | 'name' | 'url' | 'key'>('preset');
  const [preset, setPreset] = useState<Preset | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  if (step === 'preset') {
    const items: Array<PickerItem<Preset | 'custom'>> = [
      ...PRESETS.map((p) => ({ value: p, label: p.label, detail: p.baseUrl ?? (p.type === 'anthropic' ? 'api.anthropic.com' : 'api.openai.com') })),
      { value: 'custom' as const, label: 'Other OpenAI-compatible server', detail: 'any base URL' },
    ];
    return (
      <Picker
        title="Add a provider"
        items={items}
        cols={cols}
        maxRows={10}
        onCancel={() => onDone(null)}
        onSelect={(it) => {
          const p: Preset = it.value === 'custom' ? { id: 'custom', label: 'Custom', type: 'openai-compatible' } : it.value;
          setPreset(p);
          let n = p.id === 'custom' ? 'custom' : p.id;
          for (let i = 2; existing.includes(n); i++) n = `${p.id}${i}`;
          setName(n);
          setUrl(p.baseUrl ?? '');
          setStep('name');
        }}
      />
    );
  }
  if (step === 'name') {
    return (
      <Prompt
        key="name"
        title="Provider name"
        description="Used in model references, e.g. name/model-id. Letters, digits, '-', '_' and '.' only."
        initial={name}
        cols={cols}
        onCancel={() => onDone(null)}
        onSubmit={(v) => {
          if (!/^[A-Za-z0-9_.-]+$/.test(v) || existing.includes(v)) return;
          setName(v);
          setStep(preset!.type === 'openai-compatible' ? 'url' : 'key');
        }}
      />
    );
  }
  if (step === 'url') {
    return (
      <Prompt
        key="url"
        title="Base URL"
        description="The OpenAI-compatible endpoint, usually ending in /v1."
        initial={url}
        placeholder="http://localhost:8080/v1"
        cols={cols}
        onCancel={() => onDone(null)}
        onSubmit={(v) => {
          if (!/^https?:\/\/\S+$/.test(v)) return;
          setUrl(v.replace(/\/+$/, ''));
          if (isLocalUrl(v)) onDone({ name, type: preset!.type, baseUrl: v.replace(/\/+$/, '') });
          else setStep('key');
        }}
      />
    );
  }
  const envName = preset?.keyEnv;
  return (
    <Prompt
      key="api-key"
      title={`API key for ${name}`}
      description={`${envName && process.env[envName] ? `${envName} is already set, so you can leave this empty. ` : ''}Stored in the OS keychain, or in a private credentials file when no keychain is available. Leave empty to skip.`}
      mask
      cols={cols}
      onCancel={() => onDone(null)}
      onSubmit={(v) => onDone({ name, type: preset!.type, baseUrl: url || undefined, apiKeyEnv: envName }, v || undefined)}
    />
  );
}

function addProviderToDoc(doc: Document, spec: ProviderSpec): void {
  const entry: Record<string, unknown> = { type: spec.type };
  if (spec.baseUrl) entry.base_url = spec.baseUrl;
  if (spec.apiKeyEnv) entry.api_key_env = spec.apiKeyEnv;
  if (!doc.has('providers') || doc.get('providers') === null) doc.set('providers', doc.createNode({}));
  doc.setIn(['providers', spec.name], doc.createNode(entry));
}

// ------------------------------------------------------------------ /providers

interface ProvidersProps {
  session: Session;
  config: Config;
  cols: number;
  maxRows: number;
  onClose: () => void;
  writeConfig: WriteConfig;
  notice: (t: string, tone?: 'dim' | 'error' | 'success' | 'warning') => void;
}

type Status = { state: 'checking' } | { state: 'ok'; models: number; ms: number } | { state: 'error'; message: string };

async function checkProvider(registry: Registry, p: ProviderConfig): Promise<Status> {
  const started = Date.now();
  try {
    const prov = await registry.get(p.name);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const models = await prov.listModels(ac.signal);
      return { state: 'ok', models: models.length, ms: Date.now() - started };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return { state: 'error', message: (e as Error).message };
  }
}

export function ProvidersScreen({ session, config, cols, maxRows, onClose, writeConfig, notice }: ProvidersProps): React.ReactElement {
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<{ t: 'list' } | { t: 'add' } | { t: 'actions'; name: string } | { t: 'key'; name: string } | { t: 'confirm-remove'; name: string }>({ t: 'list' });
  const [nonce, setNonce] = useState(0);
  const providers = Object.values(config.providers);

  useEffect(() => {
    let alive = true;
    for (const p of providers) {
      setStatus((s) => ({ ...s, [p.name]: { state: 'checking' } }));
      void checkProvider(session.registry, p).then((st) => alive && setStatus((s) => ({ ...s, [p.name]: st })));
      void resolveKey(p).then((k) => {
        if (!alive) return;
        const label = k.source === 'env' ? `key from $${k.detail}` : k.source === 'keychain' ? `key in ${k.detail}` : k.source === 'file' ? 'key in credentials file' : p.noKey || isLocalUrl(p.baseUrl) ? 'no key needed' : 'no key';
        setKeys((s) => ({ ...s, [p.name]: label }));
      });
    }
    return () => {
      alive = false;
    };
  }, [nonce, config]);

  if (mode.t === 'add') {
    return (
      <AddProviderWizard
        cols={cols}
        existing={providers.map((p) => p.name)}
        onDone={async (spec, key) => {
          if (!spec) return setMode({ t: 'list' });
          if (key) {
            const r = await storeKey(spec.name, key);
            notice(`Saved the key for ${spec.name} in the ${r.store === 'keychain' ? r.detail : `credentials file (${r.detail})`}.`, 'success');
          }
          if (writeConfig((doc) => addProviderToDoc(doc, spec))) notice(`Added provider "${spec.name}". Pick one of its models with /model.`, 'success');
          setMode({ t: 'list' });
          setNonce((n) => n + 1);
        }}
      />
    );
  }
  if (mode.t === 'key') {
    return (
      <Prompt
        title={`New API key for ${mode.name}`}
        description="Stored in the OS keychain (or the private credentials file). Leave empty to remove the stored key."
        mask
        cols={cols}
        onCancel={() => setMode({ t: 'list' })}
        onSubmit={async (v) => {
          if (v) {
            const r = await storeKey(mode.name, v);
            notice(`Saved the key for ${mode.name} in the ${r.store === 'keychain' ? r.detail : 'credentials file'}.`, 'success');
          } else {
            await deleteKey(mode.name);
            notice(`Removed the stored key for ${mode.name}.`, 'success');
          }
          session.registry.setConfig(session.config);
          setMode({ t: 'list' });
          setNonce((n) => n + 1);
        }}
      />
    );
  }
  if (mode.t === 'confirm-remove') {
    return (
      <Picker
        title={`Remove provider "${mode.name}" from the config file? Its stored key is removed too.`}
        items={[
          { value: false, label: 'No, keep it' },
          { value: true, label: 'Yes, remove it' },
        ]}
        searchable={false}
        cols={cols}
        maxRows={4}
        onCancel={() => setMode({ t: 'list' })}
        onSelect={async (it) => {
          if (it.value) {
            await deleteKey(mode.name);
            if (writeConfig((doc) => doc.deleteIn(['providers', mode.name]))) notice(`Removed provider "${mode.name}".`, 'success');
          }
          setMode({ t: 'list' });
        }}
      />
    );
  }
  if (mode.t === 'actions') {
    return (
      <Picker
        title={`Provider "${mode.name}"`}
        items={[
          { value: 'check', label: 'Check connection again' },
          { value: 'key', label: 'Set or replace the API key' },
          { value: 'remove', label: 'Remove this provider' },
        ]}
        searchable={false}
        cols={cols}
        maxRows={4}
        onCancel={() => setMode({ t: 'list' })}
        onSelect={(it) => {
          if (it.value === 'check') {
            setNonce((n) => n + 1);
            setMode({ t: 'list' });
          } else if (it.value === 'key') setMode({ t: 'key', name: mode.name });
          else setMode({ t: 'confirm-remove', name: mode.name });
        }}
      />
    );
  }
  const describe = (p: ProviderConfig): string => {
    const st = status[p.name];
    const s = !st || st.state === 'checking' ? 'checking…' : st.state === 'ok' ? `✓ reachable · ${st.models} models · ${st.ms}ms` : `✗ ${st.message}`;
    return `${p.type}${p.baseUrl ? ` · ${p.baseUrl}` : ''} · ${keys[p.name] ?? '…'} · ${s}`;
  };
  return (
    <Picker
      title="Providers"
      items={[
        ...providers.map((p) => ({ value: p.name, label: p.name, detail: describe(p) })),
        { value: '__add__', label: '+ Add a provider', detail: 'Anthropic, OpenAI, Mistral, OpenRouter, Groq, llama.cpp, Ollama, LM Studio…' },
      ]}
      searchable={false}
      cols={cols}
      maxRows={maxRows}
      onCancel={onClose}
      onSelect={(it) => (it.value === '__add__' ? setMode({ t: 'add' }) : setMode({ t: 'actions', name: it.value }))}
      footer="enter for actions · esc to close"
    />
  );
}

// --------------------------------------------------------------------- /config

interface ConfigProps {
  config: Config;
  session: Session;
  cols: number;
  maxRows: number;
  onClose: () => void;
  writeConfig: WriteConfig;
  applyTheme: (t: Config['theme']) => void;
  openModelPicker: (title: string, onPick: (model: string) => void) => void;
}

export function ConfigScreen({ config, cols, maxRows, onClose, writeConfig, applyTheme, openModelPicker }: ConfigProps): React.ReactElement {
  const [cfg, setCfg] = useState(config);
  const reload = () => setCfg(loadConfig().config);
  const themes: Array<Config['theme']> = ['auto', 'dark', 'light', 'ansi'];
  const efforts = ['(model default)', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const items: Array<PickerItem<string>> = [
    { value: 'theme', label: 'Theme', detail: cfg.theme },
    { value: 'default_model', label: 'Default model', detail: cfg.defaultModel ?? '(not set)' },
    { value: 'title_model', label: 'Title model', detail: cfg.titleModel ?? '(first line of the first message)' },
    { value: 'compact_model', label: 'Compact model', detail: cfg.compactModel ?? '(current model)' },
    { value: 'reasoning_effort', label: 'Default reasoning effort', detail: cfg.reasoningEffort ?? '(model default)' },
    { value: 'bell', label: 'Bell when a long reply finishes', detail: cfg.bell ? 'on' : 'off' },
    { value: 'bell_after_seconds', label: 'Bell threshold', detail: `${cfg.bellAfterSeconds}s` },
    { value: 'terminal_title', label: 'Set the terminal title', detail: cfg.terminalTitle ? 'on' : 'off' },
  ];
  const cycle = <T,>(list: T[], cur: T, dir = 1): T => list[(list.indexOf(cur) + dir + list.length) % list.length]!;
  const change = (key: string, dir: number) => {
    switch (key) {
      case 'theme': {
        const t = cycle(themes, cfg.theme, dir);
        writeConfig((d) => d.set('theme', t));
        applyTheme(t);
        break;
      }
      case 'bell':
        writeConfig((d) => d.set('bell', !cfg.bell));
        break;
      case 'terminal_title':
        writeConfig((d) => d.set('terminal_title', !cfg.terminalTitle));
        break;
      case 'bell_after_seconds': {
        const opts = [0, 5, 10, 20, 30, 60];
        writeConfig((d) => d.set('bell_after_seconds', cycle(opts, opts.includes(cfg.bellAfterSeconds) ? cfg.bellAfterSeconds : 10, dir)));
        break;
      }
      case 'reasoning_effort': {
        const e = cycle(efforts, cfg.reasoningEffort ?? '(model default)', dir);
        writeConfig((d) => (e === '(model default)' ? d.delete('reasoning_effort') : d.set('reasoning_effort', e)));
        break;
      }
      case 'default_model':
      case 'title_model':
      case 'compact_model':
        openModelPicker(`Choose the ${key.replace('_', ' ')}`, (m) => {
          writeConfig((d) => d.set(key, m));
        });
        return;
    }
    reload();
  };
  return (
    <Picker
      title="Settings"
      items={items}
      searchable={false}
      cols={cols}
      maxRows={maxRows}
      onCancel={onClose}
      onSelect={(it) => change(it.value, 1)}
      onKey={(key, it) => {
        if (!it) return false;
        if (key.name === 'right' || key.name === 'space' || (key.name === 'char' && key.text === ' ')) {
          change(it.value, 1);
          return true;
        }
        if (key.name === 'left') {
          change(it.value, -1);
          return true;
        }
        return false;
      }}
      footer={`enter/→ to change · ← to go back · esc to close · ${truncate(loadConfig().file, Math.max(10, cols - 60))}`}
    />
  );
}

// ---------------------------------------------------------------- first run

interface SetupProps {
  cols: number;
  maxRows: number;
  configFile: string;
  onDone: (model?: string) => void;
}

export function SetupScreen({ cols, maxRows, configFile, onDone }: SetupProps): React.ReactElement {
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [step, setStep] = useState<'choose' | 'wizard' | 'model'>('choose');
  const [models, setModels] = useState<{ provider: string; ids: string[]; error?: string } | null>(null);
  const dim = themeHex('dim');

  useEffect(() => {
    void detectProviders().then(setDetected);
  }, []);

  const write = (specs: ProviderSpec[], defaultModel?: string) => {
    mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
    if (!existsSync(configFile)) writeFileSync(configFile, configTemplate(specs, defaultModel), { mode: 0o600 });
  };

  const finishWith = async (spec: ProviderSpec) => {
    write([spec]);
    setStep('model');
    try {
      const { config } = loadConfig(configFile);
      const reg = new Registry(config);
      const list = await (await reg.get(spec.name)).listModels();
      setModels({ provider: spec.name, ids: list.map((m) => m.id) });
    } catch (e) {
      setModels({ provider: spec.name, ids: [], error: (e as Error).message });
    }
  };

  if (step === 'wizard') {
    return (
      <AddProviderWizard
        cols={cols}
        existing={[]}
        onDone={async (spec, key) => {
          if (!spec) return setStep('choose');
          if (key) await storeKey(spec.name, key);
          void finishWith(spec);
        }}
      />
    );
  }
  if (step === 'model') {
    if (!models) return <Text color={dim}>Fetching the model list…</Text>;
    const setDefault = (m?: string) => {
      if (m) {
        const doc = parseDocument(readFileSync(configFile, 'utf8'));
        doc.set('default_model', m);
        writeFileSync(configFile, String(doc), { mode: 0o600 });
      }
      onDone(m);
    };
    if (!models.ids.length) {
      return (
        <Prompt
          title="Default model"
          description={`${models.error ? `Could not list models (${models.error}). ` : 'The server listed no models. '}Type a model id to use with ${models.provider}, or leave empty to choose later with /model.`}
          cols={cols}
          onCancel={() => setDefault()}
          onSubmit={(v) => setDefault(v ? `${models.provider}/${v}` : undefined)}
        />
      );
    }
    return (
      <Picker
        title={`Choose the default model for ${models.provider}`}
        items={models.ids.map((id) => ({ value: `${models.provider}/${id}`, label: id }))}
        cols={cols}
        maxRows={maxRows}
        onCancel={() => setDefault()}
        onSelect={(it) => setDefault(it.value)}
      />
    );
  }
  const items: Array<PickerItem<string>> = [];
  for (const d of detected ?? []) items.push({ value: `detected:${d.preset.id}:${d.baseUrl ?? ''}`, label: `Use ${d.preset.label}`, detail: d.how });
  items.push({ value: 'wizard', label: 'Add a provider', detail: 'cloud API or local server' });
  items.push({ value: 'mock', label: 'Skip for now', detail: 'try parley with the built-in mock provider; run /providers later' });
  return (
    <Box flexDirection="column">
      <Picker
        title="Welcome! Let's connect parley to a model."
        items={items}
        searchable={false}
        cols={cols}
        maxRows={maxRows}
        loading={detected ? undefined : 'Looking for API keys and local servers (llama.cpp, Ollama, LM Studio)…'}
        onCancel={() => {
          write([]);
          onDone();
        }}
        onSelect={(it) => {
          if (it.value === 'wizard') return setStep('wizard');
          if (it.value === 'mock') {
            write([], 'mock/markdown');
            return onDone('mock/markdown');
          }
          const [, id, ...rest] = it.value.split(':');
          const url = rest.join(':');
          const preset = PRESETS.find((p) => p.id === id)!;
          void finishWith({ name: preset.id, type: preset.type, baseUrl: url || preset.baseUrl, apiKeyEnv: preset.keyEnv });
        }}
        footer={`Writes ${configFile} · esc to skip`}
      />
    </Box>
  );
}
