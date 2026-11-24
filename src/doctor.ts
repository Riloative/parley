// `taria doctor`: check the environment and explain how to fix problems.

import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { APP, OLD_APP, OLD_NAMES_REMOVED_IN, legacyEnvNotice } from './brand.js';
import { DIR_KINDS } from './config/paths.js';
import { spawnSync } from 'node:child_process';
import { boot } from './bootstrap.js';
import { Store, scanForRepairs } from './core/store.js';
import { paths } from './config/paths.js';
import { colorLevel, inTmux, likelySupportsSyncOutput, overSsh, terminalName, unicodeOk } from './term/caps.js';
import { copyText, currentContext, detectClipboardHelper, readBackText } from './term/clipboard.js';
import { loadConfig } from './config/config.js';
import { detectKeychain, keychainLabel, resolveKey, setKeychainReadOnly, isLocalUrl, defaultKeyEnv } from './config/credentials.js';
import { KeyDecoder } from './term/keys.js';
import { BUILD_KIND, VERSION } from './version.js';

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

/** `taria doctor clipboard`: copy a test line the way /copy does, and read
 * it back where a paste tool exists. */
async function clipboardTest(): Promise<number> {
  failures = 0;
  const cfg = loadConfig(paths.configFile).config;
  const ctx = currentContext();
  const info = detectClipboardHelper({ mode: cfg.clipboard, command: cfg.clipboardCommand }, ctx);
  process.stdout.write('taria doctor clipboard\n');
  section('Clipboard');
  line(info.ok ? 'info' : 'warn', 'Method', info.detail);
  for (const s of info.plan.skipped) line('info', 'Not used', s);
  const sample = `taria clipboard test ${new Date().toTimeString().slice(0, 8)}`;
  const r = await copyText(sample, { mode: cfg.clipboard, command: cfg.clipboardCommand, ctx });
  if (r.status === 'off') line('info', 'Test copy', 'not run: clipboard: off');
  else if (r.status === 'failed') line('fail', 'Test copy', `nothing was copied: ${r.tried.join('; ')}`, r.hint);
  else if (r.status === 'copied') {
    const back = readBackText(ctx);
    if (back === undefined) line('ok', 'Test copy', `${r.via} accepted "${sample}" (no paste tool to read it back)`, 'Paste somewhere to check.');
    else if (back === sample) line('ok', 'Test copy', `copied with ${r.via} and read back`);
    else line('fail', 'Test copy', `${r.via} exited successfully, but the clipboard holds something else`, 'Another program may own the clipboard; try clipboard_command in the config.');
  } else {
    line('warn', 'Test copy', `sent "${sample}" via ${r.via === 'tmux' ? 'tmux (load-buffer -w)' : 'OSC 52'}; the terminal does not confirm it`, `Paste now (Ctrl+Shift+V, or Ctrl+V in Notepad): you should see "${sample}". If nothing appears, the terminal ignores OSC 52${r.via === 'tmux' ? ' or tmux has set-clipboard off' : ''}; install a clipboard tool or set clipboard_command.`);
  }
  return failures ? 1 : 0;
}

/** parley, before the rename: report what is left, change nothing. */
function oldInstallReport(): void {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const f = dir && join(dir, OLD_APP);
    if (!f || !existsSync(f)) continue;
    let head = '';
    try {
      head = readFileSync(f).subarray(0, 4096).toString('latin1');
    } catch {
      /* unreadable */
    }
    if (/parley is now taria/.test(head)) line('info', 'parley command', `${f} is the alias that runs taria (until ${APP} ${OLD_NAMES_REMOVED_IN})`);
    else {
      const npm = /node_modules/.test(realpathSafe(f));
      line('warn', 'Old parley binary', `${f} is parley from before the rename${npm ? ' (npm)' : ''}`, npm ? 'Remove it once you have switched: npm uninstall -g parley' : `Delete ${f} once you have switched to taria.`);
    }
    break;
  }
  for (const kind of DIR_KINDS) {
    const old = paths.legacyDir(kind);
    const current = paths[`${kind}Dir` as 'dataDir'];
    let st: Stats | undefined;
    try {
      st = lstatSync(old);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) line('info', `Old ${kind} folder`, `${old} → ${current} (a link, for an old parley)`);
    else if (existsSync(current) && current !== old) line('warn', `Old ${kind} folder`, `${old} still exists next to ${current}; taria uses ${current}`, `Compare them, and delete ${old} when you no longer need it.`);
    else line('info', `Old ${kind} folder`, `${old}: moves to ${current} the next time taria starts (doctor changes nothing)`);
  }
}

function realpathSafe(f: string): string {
  try {
    return realpathSync(f);
  } catch {
    return f;
  }
}

/** `taria doctor repair`: list the conversations the 0.0.1–0.2.0 crash bug
 * hid messages in, and record the lost replies after the user agrees. */
async function repairConversations(): Promise<number> {
  const store = new Store(paths.dataDir);
  const hit = scanForRepairs(store);
  process.stdout.write('taria doctor repair\n\n');
  if (!hit.length) {
    process.stdout.write('No conversation needs repair.\n');
    return 0;
  }
  for (const h of hit) process.stdout.write(`  ${h.title ?? h.id} (${h.id}): ${h.lost} cut-off repl${h.lost === 1 ? 'y' : 'ies'}, ${h.hidden} earlier message${h.hidden === 1 ? '' : 's'} hidden\n`);
  process.stdout.write('\nRepair records each cut-off reply as a message (marked as interrupted) at the end of its file.\nNothing already in the files is changed or deleted.\n');
  if (!process.stdin.isTTY) {
    process.stdout.write('Run this in a terminal to confirm. (Opening a conversation in taria also repairs it.)\n');
    return 1;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Repair ${hit.length} conversation${hit.length === 1 ? '' : 's'}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    process.stdout.write('Nothing changed.\n');
    return 0;
  }
  let failed = 0;
  for (const h of hit) {
    try {
      const f = store.open(h.id);
      f.releaseLock();
      process.stdout.write(`  repaired ${h.title ?? h.id}: ${f.repaired} repl${f.repaired === 1 ? 'y' : 'ies'} recorded\n`);
    } catch (e) {
      failed++;
      process.stdout.write(`  skipped ${h.title ?? h.id}: ${(e as Error).message}\n`);
    }
  }
  return failed ? 1 : 0;
}

export async function runDoctor(rest: string[] = []): Promise<number> {
  if (rest[0] === 'clipboard') return clipboardTest();
  if (rest[0] === 'repair') return repairConversations();
  failures = 0;
  setKeychainReadOnly();
  process.stdout.write('taria doctor\n');

  section('Installation');
  const where = BUILD_KIND === 'binary' ? process.execPath : (process.argv[1] ?? '');
  let real = where;
  try {
    real = realpathSync(where);
  } catch {
    /* keep */
  }
  const method = BUILD_KIND === 'binary' ? 'standalone binary' : /[\\/]lib[\\/]node_modules[\\/]|[\\/]node_modules[\\/]taria[\\/]/.test(where) ? 'npm (global)' : 'from a source checkout';
  line('info', 'Version', `taria ${VERSION}`);
  line('info', 'Install method', method);
  line('info', 'Location', real === where ? where : `${where} → ${real}`);
  oldInstallReport();
  const envNote = legacyEnvNotice();
  if (envNote) line('warn', 'Old variables', envNote);

  section('System');
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 22 ? 'ok' : 'fail', 'Node.js', `${process.version}${BUILD_KIND === 'binary' ? ' (embedded in the binary)' : ''}`, major >= 22 ? undefined : 'Install Node.js 22 or newer (the current LTS).');
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
    line(v === 'on' || v === 'always' ? 'ok' : 'warn', 'tmux extended-keys', v || 'unknown', v === 'on' || v === 'always' ? undefined : 'set -g extended-keys on   (in ~/.tmux.conf) so Shift+Enter reaches taria');
  }
  if (overSsh()) line('info', 'SSH session', 'copying uses OSC 52; image paste is not available over SSH');

  section('Clipboard');
  const clipCfg = loadConfig(paths.configFile).config;
  const clip = detectClipboardHelper({ mode: clipCfg.clipboard, command: clipCfg.clipboardCommand });
  line(clip.ok ? 'ok' : 'warn', '/copy uses', clip.detail, clip.ok ? undefined : clip.plan.hint);
  for (const s of clip.plan.skipped) line('info', 'Not used', s);
  if (process.env.TMUX) {
    const v = spawnSync('tmux', ['show', '-sv', 'set-clipboard'], { encoding: 'utf8' }).stdout?.trim();
    line(v === 'off' ? 'warn' : 'ok', 'tmux set-clipboard', v || 'unknown', v === 'off' ? 'set -s set-clipboard external   (in ~/.tmux.conf) so tmux passes copies on to the terminal' : undefined);
  }
  line('info', 'Test it', 'taria doctor clipboard   (copies a test line and reads it back)');

  section('Conversations');
  const hit = scanForRepairs(new Store(paths.dataDir));
  if (!hit.length) line('ok', 'Crash damage', 'none (no conversation is missing earlier messages)');
  else {
    for (const h of hit.slice(0, 10)) line('warn', 'Needs repair', `${h.title ?? h.id}: ${h.hidden} earlier message${h.hidden === 1 ? '' : 's'} hidden by a reply cut off in parley before 0.2.0`);
    if (hit.length > 10) line('warn', 'Needs repair', `… and ${hit.length - 10} more`);
    line('info', 'Repair', `taria doctor repair   (asks first; only adds lines, never changes or deletes any). Opening a conversation also repairs it.`);
  }

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
      // Check without creating anything: doctor changes nothing (a folder it
      // created would also stop parley's files from being moved there).
      let probe = dir;
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      accessSync(probe, constants.W_OK);
      line('ok', label, probe === dir ? dir : `${dir} (created on first use)`);
    } catch (e) {
      line('fail', label, `${dir}: ${(e as Error).message}`, `Make sure ${dir} is writable.`);
    }
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  line(editor ? 'ok' : 'info', 'External editor', editor ?? 'not set (Ctrl+G falls back to vi)', editor ? undefined : 'export EDITOR=nano  (or vim, code --wait, …)');

  section('Configuration');
  const b = boot();
  line(b.configExists ? 'ok' : 'warn', 'Config file', b.configFile, b.configExists ? undefined : 'Run taria once to create it with the setup flow.');
  for (const i of b.issues) line('fail', 'Config error', i);
  if (b.config.defaultModel) line('ok', 'Default model', b.config.defaultModel);
  else line('warn', 'Default model', 'not set', 'Set default_model in the config file, or choose one with /model.');

  section('Providers');
  const providers = Object.values(b.config.providers);
  if (!providers.length) line('warn', 'Providers', 'none configured', 'Run /providers inside taria, or edit the config file.');
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
            ? `Set ${p.apiKeyEnv ?? defaultKeyEnv(p)} or run: taria key set ${p.name}`
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
