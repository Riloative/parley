// The generated command-line documents (help, completions, man page) and the
// config JSON Schema must agree with the code that reads the arguments and
// the config.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/args.js';
import { COMMANDS, OPTIONS, helpText } from '../../src/cliSpec.js';
import { completionScript } from '../../src/completions.js';
import { manPage } from '../../src/manpage.js';
import { MODEL_KEYS, PROVIDER_KEYS, PROVIDER_TYPES, SAMPLING_KEYS, TOP_KEYS, loadConfig } from '../../src/config/config.js';

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

describe('command-line description', () => {
  it('every documented option is accepted, under both names, and nothing undocumented is', () => {
    for (const o of OPTIONS) {
      const names = [`--${o.long}`, ...(o.short ? [`-${o.short}`] : [])];
      for (const n of names) {
        const args = o.arg && !o.optionalArg ? [n, o.values?.[0] ?? 'x/y'] : [n];
        expect(parseArgs(args), n).not.toHaveProperty('error');
      }
    }
    expect(parseArgs(['--no-such-thing'])).toHaveProperty('error');
  });

  it('every documented command is recognised', () => {
    for (const c of COMMANDS) {
      const words = c.usage.replace(/<bash\|zsh\|fish>/, 'bash').replace(/<provider>/, 'p').split(' ');
      const a = parseArgs(words);
      expect(a, c.usage).toMatchObject({ command: words[0] });
    }
  });

  it('--help lists every option and command, aligned', () => {
    const h = helpText();
    for (const o of OPTIONS) expect(h).toContain(`--${o.long}`);
    for (const c of COMMANDS) expect(h).toContain(`taria ${c.usage}`);
    const cols = h.split('\n').filter((l) => /^ {2}taria \S/.test(l) && /\s{2,}\S/.test(l.slice(8))).map((l) => l.search(/\S+\s*$/) && l.indexOf(l.trim().split(/\s{2,}/)[1]!));
    expect(new Set(cols).size).toBe(1);
  });

  it('the man page names every option and command', () => {
    const m = manPage('9.9.9', '');
    expect(m.startsWith('.TH TARIA 1 "" "taria 9.9.9"')).toBe(true);
    for (const o of OPTIONS) expect(m).toContain(`\\-\\-${o.long.replace(/-/g, '\\-')}`);
    for (const c of COMMANDS) expect(m).toContain(c.usage.split(' ')[0]!);
  });
});

describe('shell completions', () => {
  it('bash: completes commands, options and --theme values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-comp-'));
    writeFileSync(join(dir, 'c.bash'), completionScript('bash')!);
    const ask = (line: string) => {
      const words = line.split(' ');
      const script = `source ${join(dir, 'c.bash')}; COMP_WORDS=(${words.map((w) => `'${w}'`).join(' ')}); COMP_CWORD=${words.length - 1}; _taria; printf '%s\\n' "\${COMPREPLY[@]}"`;
      return spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    };
    expect(ask('taria do')).toEqual(['doctor']);
    expect(ask('taria --th')).toEqual(['--theme']);
    expect(ask('taria --theme l')).toEqual(['light']);
    expect(ask('taria doctor ')).toEqual(['clipboard', 'repair']);
    expect(ask('taria key re')).toEqual(['remove', 'remove-old']);
    expect(ask('taria completions ')).toEqual(['bash', 'zsh', 'fish']);
  });

  it.runIf(has('zsh'))('zsh: the script parses', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'taria-comp-')), '_taria');
    writeFileSync(f, completionScript('zsh')!);
    expect(spawnSync('zsh', ['-n', f]).status).toBe(0);
  });

  it.runIf(has('fish'))('fish: completes commands and --theme values', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'taria-comp-')), 'taria.fish');
    writeFileSync(f, completionScript('fish')!);
    const ask = (line: string) => spawnSync('fish', ['--no-config', '-c', `source ${f}; complete -C '${line}'`], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean);
    expect(ask('taria doc')).toContain('doctor');
    expect(ask('taria --theme ')).toEqual(expect.arrayContaining(['dark', 'light', 'ansi', 'auto']));
  });

  it('an unknown shell gets nothing', () => {
    expect(completionScript('tcsh')).toBeUndefined();
  });
});

describe('config JSON Schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/config.schema.json', import.meta.url), 'utf8')) as {
    properties: Record<string, { enum?: string[] }>;
    $defs: Record<string, { properties: Record<string, { enum?: string[] }> }>;
  };
  const keys = (o: object) => Object.keys(o).sort();

  it('has exactly the keys the config reader accepts, at every level', () => {
    expect(keys(schema.properties)).toEqual([...TOP_KEYS].sort());
    expect(keys(schema.$defs.provider!.properties)).toEqual([...PROVIDER_KEYS].sort());
    expect(keys(schema.$defs.sampling!.properties)).toEqual([...SAMPLING_KEYS].sort());
    expect(keys(schema.$defs.model!.properties)).toEqual([...MODEL_KEYS].sort());
    expect(schema.$defs.provider!.properties.type!.enum).toEqual(PROVIDER_TYPES);
  });

  it('its enums are the values the reader accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taria-schema-'));
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (!prop.enum) continue;
      for (const value of prop.enum) {
        writeFileSync(join(dir, 'c.yaml'), `${key}: ${value}\n`);
        expect(loadConfig(join(dir, 'c.yaml')).issues, `${key}: ${value}`).toEqual([]);
      }
      writeFileSync(join(dir, 'c.yaml'), `${key}: not-a-value\n`);
      expect(loadConfig(join(dir, 'c.yaml')).issues.length, `${key}: not-a-value`).toBe(1);
    }
  });
});
