// Small gaps found in the 0.2.0 review, each fixed after this test failed.
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/core/store.js';
import { KeyDecoder } from '../../src/term/keys.js';
import { parseBackgroundReply } from '../../src/term/probe.js';
import { addShiftEnterBinding, stripJsonc } from '../../src/term/setup.js';

describe('summary cache', () => {
  it('notices a file rewritten with the same size and modification time', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'taria-cache-')));
    const f = store.create();
    f.append({ type: 'message', id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hello' }], ts: 1 });
    f.append({ type: 'title', title: 'aaaa' });
    f.releaseLock();
    const when = new Date('2026-01-01T00:00:00Z');
    utimesSync(f.file, when, when);
    expect(store.list()[0]!.title).toBe('aaaa');
    const st = statSync(f.file);
    writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('aaaa', 'bbbb'));
    utimesSync(f.file, when, when); // as a restore or sync tool would
    expect(statSync(f.file).size).toBe(st.size);
    expect(statSync(f.file).mtimeMs).toBe(st.mtimeMs);
    expect(store.list()[0]!.title).toBe('bbbb');
  });
});

describe('background colour answers', () => {
  it('reads rgb:, rgba: and #rrggbb (and #rgb, #rrrrggggbbbb) answers', () => {
    expect(parseBackgroundReply('rgb:ffff/ffff/ffff')).toBe('light');
    expect(parseBackgroundReply('rgba:ffff/ffff/fafa/ffff')).toBe('light');
    expect(parseBackgroundReply('rgba:1e1e/1e1e/2e2e/ffff')).toBe('dark');
    expect(parseBackgroundReply('#fdf6e3')).toBe('light');
    expect(parseBackgroundReply('#1e1e2e')).toBe('dark');
    expect(parseBackgroundReply('#fff')).toBe('light');
    expect(parseBackgroundReply('#ffffffffffff')).toBe('light');
    expect(parseBackgroundReply('#12345')).toBeUndefined();
    expect(parseBackgroundReply('rgb:zz/00/00')).toBeUndefined();
    expect(parseBackgroundReply('red')).toBeUndefined();
  });

  it('the key decoder reports them too (late answers), and never types them', () => {
    for (const [body, want] of [['rgba:ffff/ffff/ffff/ffff', 'light'], ['#000000', 'dark']] as const) {
      const d = new KeyDecoder();
      const evs = d.feed(`\x1b]11;${body}\x1b\\x`);
      expect(evs).toEqual([{ type: 'background', background: want }, expect.objectContaining({ type: 'key' })]);
    }
  });
});

describe('/terminal-setup and CRLF keybindings.json', () => {
  it('keeps Windows line endings in the lines it adds', () => {
    const text = '// my bindings\r\n[\r\n  { "key": "ctrl+k", "command": "a" }\r\n]\r\n';
    const r = addShiftEnterBinding(text);
    expect(r.ok && r.changed).toBe(true);
    const out = (r as { text: string }).text;
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.startsWith('// my bindings\r\n[\r\n  { "key": "ctrl+k", "command": "a" },')).toBe(true);
    expect(JSON.parse(stripJsonc(out))).toHaveLength(2);
    expect(addShiftEnterBinding(out)).toMatchObject({ ok: true, changed: false });
  });
});
