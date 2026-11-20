// `parley doctor`: check the environment and explain how to fix problems.

import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { boot } from './bootstrap.js';
import { paths } from './config/paths.js';
import { colorLevel, inTmux, likelySupportsSyncOutput, overSsh, terminalName, unicodeOk } from './term/caps.js';
import { detectClipboardHelper } from './term/clipboard.js';
import { detectKeychain, keychainLabel, resolveKey, isLocalUrl, defaultKeyEnv } from './config/credentials.js';
import { KeyDecoder } from './term/keys.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

const useColor = () => colorLevel() > 0;
const mark = (l: Level) => {
  const sym = { ok: '✓', warn: '!', fail: '✗', info: '·' }[l];
  if (!useColor()) return sym;
  const c = { ok: '32', warn: '33', fail: '31', info: '90' }[l];
  return `\x1b[${c}m${sym}\x1b[0m`;
};

let failures = 0;
function line(level: Level, label: string, detail: string, fix?: string): void {
  if (level === 'fail') failures++;
  process.stdout.write(`  ${mark(level)} ${label.padEnd(22)} ${detail}\n`);
  if (fix) process.stdout.write(`    ${useColor() ? '\x1b[90m' : ''}→ ${fix}${useColor() ? '\x1b[0m' : ''}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${useColor() ? '\x1b[1m' : ''}${title}${useColor() ? '\x1b[0m' : ''}\n`);
}

/** Ask the terminal whether it speaks the kitty keyboard protocol. */
function probeKitty(): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const dec = new KeyDecoder();
    let done = false;
    const finish = (v: boolean | undefined) => {
      if (done) return;
      done = true;
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(v);
    };
    const onData = (d: string) => {
      for (const e of dec.feed(d)) {
        if (e.type === 'kitty-flags') finish(true);
        if (e.type === 'device-attributes') setTimeout(() => finish(false), 20);
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.resume();
    process.stdout.write('\x1b[?u\x1b[c');
    setTimeout(() => finish(undefined), 500);
  });
}

export async function runDoctor(): Promise<number> {
  failures = 0;
  process.stdout.write('parley doctor\n');

  section('System');
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 22 ? 'ok' : 'fail', 'Node.js', process.version, major >= 22 ? undefined : 'Install Node.js 22 or newer (the current LTS).');
  line('info', 'Platform', `${process.platform} ${process.arch}`);

  section('Terminal');
  const isTty = !!process.stdout.isTTY;
  line(isTty ? 'ok' : 'warn', 'Interactive TTY', isTty ? `${process.stdout.columns}x${process.stdout.rows}` : 'stdout is not a terminal', isTty ? undefined : 'Run doctor directly in your terminal to check terminal features.');
  line('info', 'Terminal', `${terminalName()} (TERM=${process.env.TERM ?? 'unset'})`);
  const lvl = colorLevel();
  line(lvl >= 2 ? 'ok' : lvl === 1 ? 'warn' : 'info', 'Colour', ['none (NO_COLOR or not a TTY)', '16 colours', '256 colours', 'truecolour'][lvl]!, lvl === 1 ? 'Set COLORTERM=truecolor if your terminal supports it, or use theme: ansi.' : undefined);
  line(unicodeOk() ? 'ok' : 'warn', 'Unicode', unicodeOk() ? 'UTF-8 locale' : 'non-UTF-8 locale', unicodeOk() ? undefined : 'Set LANG to a UTF-8 locale, e.g. export LANG=en_US.UTF-8');
  line(likelySupportsSyncOutput() ? 'ok' : 'info', 'Synchronized output', likelySupportsSyncOutput() ? 'supported' : 'unknown (harmless if unsupported)');
  const kitty = await probeKitty();
  if (kitty === true) line('ok', 'Shift+Enter', 'kitty keyboard protocol available');
  else if (kitty === false) {
    const tn = terminalName();
    const fix =
      tn === 'VS Code'
        ? 'Add a VS Code keybinding: { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" } — or use \\ then Enter, or Ctrl+J.'
        : tn === 'Terminal.app'
          ? 'Enable "Use Option as Meta key" (Settings → Profiles → Keyboard) for Option+Enter, or use \\ then Enter, or Ctrl+J.'
          : inTmux()
            ? 'In tmux, add "set -g extended-keys on" and "set -as terminal-features \'xterm*:extkeys\'" to ~/.tmux.conf. Ctrl+J and \\ then Enter always work.'
            : 'Use Alt+Enter, Ctrl+J, or \\ then Enter for a new line.';
    line('warn', 'Shift+Enter', 'kitty keyboard protocol not available', fix);
  } else line('info', 'Shift+Enter', 'not checked (no terminal)');
  if (inTmux()) {
    const r = spawnSync('tmux', ['show', '-gv', 'extended-keys'], { encoding: 'utf8' });
    const v = r.stdout?.trim();
    line(v === 'on' || v === 'always' ? 'ok' : 'warn', 'tmux extended-keys', v || 'unknown', v === 'on' || v === 'always' ? undefined : 'set -g extended-keys on   (in ~/.tmux.conf) so Shift+Enter reaches parley');
  }
  if (overSsh()) line('info', 'SSH session', 'copying uses OSC 52; image paste is not available over SSH');

  section('Clipboard');
  const clip = detectClipboardHelper();
  line(clip.ok ? 'ok' : 'warn', 'Clipboard helper', clip.detail);

  section('Storage');
  const kc = await detectKeychain();
  line(kc !== 'none' ? 'ok' : 'warn', 'Keychain', keychainLabel(kc), kc === 'none' ? (process.platform === 'linux' ? 'Install libsecret-tools (sudo apt install libsecret-tools) in a desktop session; otherwise keys go to the credentials file.' : undefined) : undefined);
  if (existsSync(paths.credentialsFile)) {
    const mode = statSync(paths.credentialsFile).mode & 0o777;
    line(mode & 0o077 ? 'fail' : 'ok', 'Credentials file', `${paths.credentialsFile} (mode ${mode.toString(8)})`, mode & 0o077 ? `chmod 600 ${paths.credentialsFile}` : undefined);
  }
  for (const [label, dir] of [
    ['Config directory', paths.configDir],
    ['Data directory', paths.dataDir],
  ] as const) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      accessSync(dir, constants.W_OK);
      line('ok', label, dir);
    } catch (e) {
      line('fail', label, `${dir}: ${(e as Error).message}`, `Make sure ${dir} is writable.`);
    }
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  line(editor ? 'ok' : 'info', 'External editor', editor ?? 'not set (Ctrl+G falls back to vi)', editor ? undefined : 'export EDITOR=nano  (or vim, code --wait, …)');

  section('Configuration');
  const b = boot();
  line(b.configExists ? 'ok' : 'warn', 'Config file', b.configFile, b.configExists ? undefined : 'Run parley once to create it with the setup flow.');
  for (const i of b.issues) line('fail', 'Config error', i);
  if (b.config.defaultModel) line('ok', 'Default model', b.config.defaultModel);
  else line('warn', 'Default model', 'not set', 'Set default_model in the config file, or choose one with /model.');

  section('Providers');
  const providers = Object.values(b.config.providers);
  if (!providers.length) line('warn', 'Providers', 'none configured', 'Run /providers inside parley, or edit the config file.');
  await Promise.all(
    providers.map(async (p) => {
      const k = await resolveKey(p);
      const needsKey = !(p.noKey || isLocalUrl(p.baseUrl) || p.type === 'mock');
      const keyInfo = k.source === 'none' ? (needsKey ? 'no key' : 'no key needed') : `key from ${k.source}${k.detail ? ` (${k.detail})` : ''}`;
      const started = Date.now();
      try {
        const prov = await b.registry.get(p.name);
        const models = await prov.listModels(AbortSignal.timeout(8000));
        return () => line('ok', p.name, `${p.type} · reachable in ${Date.now() - started}ms · ${models.length} models · ${keyInfo}`);
      } catch (e) {
        const msg = (e as Error).message;
        const fix =
          k.source === 'none' && needsKey
            ? `Set ${p.apiKeyEnv ?? defaultKeyEnv(p)} or run: parley key set ${p.name}`
            : /Nothing is listening/.test(msg)
              ? 'Start the server, or fix base_url in the config file.'
              : undefined;
        return () => line('fail', p.name, `${p.type} · ${msg} · ${keyInfo}`, fix);
      }
    }),
  ).then((printers) => printers.forEach((p) => p()));

  process.stdout.write(`\n${failures ? `${failures} problem${failures === 1 ? '' : 's'} found.` : 'Everything looks good.'}\n`);
  return failures ? 1 : 0;
}
