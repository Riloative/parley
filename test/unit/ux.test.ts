// Drafts on disk, notification sequences, focus reports.
import { mkdtempSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Drafts from '../../src/core/drafts.js';
import { KeyDecoder } from '../../src/term/keys.js';
import { notificationSequence, notifyProtocol } from '../../src/term/caps.js';
import { defaultConfig, parseConfig } from '../../src/config/config.js';
import { notifier } from '../../src/ui/notify.js';

describe('drafts', () => {
  const saved = process.env.XDG_DATA_HOME;
  let data: string;
  let mod: typeof Drafts;
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'taria-drafts-'));
    process.env.XDG_DATA_HOME = data;
    mod = await import('../../src/core/drafts.js');
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  });
  const dir = () => join(data, 'taria', 'drafts');
  const draft = (text: string) => ({ text, pastes: { '1': 'pasted\nlines' }, attachments: { '[Image #1]': { type: 'image' as const, hash: 'abc', mediaType: 'image/png' } }, counters: { paste: 1, image: 1, file: 0 } });

  it('round-trips text, pastes and attachments; an empty draft removes the file', () => {
    mod.scheduleDraft('conv-1', draft('hello [Pasted text #1 +2 lines] [Image #1]'));
    expect(mod.loadDraft('conv-1')).toBeNull(); // debounced: not written yet
    mod.flushDrafts();
    expect(mod.loadDraft('conv-1')).toEqual(draft('hello [Pasted text #1 +2 lines] [Image #1]'));
    expect(mod.loadDraft('other')).toBeNull();
    mod.scheduleDraft('conv-1', null);
    mod.flushDrafts();
    expect(mod.loadDraft('conv-1')).toBeNull();
    expect(readdirSync(dir())).toEqual([]);
  });

  it('switching conversations writes the previous draft before the next', () => {
    mod.scheduleDraft('a', draft('for a'));
    mod.scheduleDraft('b', draft('for b'));
    mod.flushDrafts();
    expect(mod.loadDraft('a')!.text).toBe('for a');
    expect(mod.loadDraft('b')!.text).toBe('for b');
  });

  it('ignores damaged files and unknown shapes, and keeps keys inside the drafts directory', () => {
    for (const junk of ['', 'null', '{"v":1', '{"v":2,"text":"x"}', '{"v":1,"text":5}', '{"v":1,"text":"   "}']) {
      writeFileSync(join(dir(), 'junk.json'), junk);
      expect(mod.loadDraft('junk')).toBeNull();
    }
    writeFileSync(join(dir(), 'odd.json'), JSON.stringify({ v: 1, text: 't', pastes: { 1: 5 }, attachments: { x: { type: 'reasoning' }, y: { type: 'file', name: 'n', text: 'c' } }, counters: { paste: -1, image: 'x' } }));
    expect(mod.loadDraft('odd')).toEqual({ text: 't', pastes: {}, attachments: { y: { type: 'file', name: 'n', text: 'c' } }, counters: { paste: 0, image: 0, file: 0 } });
    mod.scheduleDraft('../../escape', draft('x'));
    mod.flushDrafts();
    expect(readdirSync(dir())).toContain('.._.._escape.json');
  });

  it('drops attachments rather than the text when a draft is huge, and prunes old drafts', () => {
    mod.scheduleDraft('big', { ...draft('keep me'), pastes: { '1': 'x'.repeat(3 * 1024 * 1024) } });
    mod.flushDrafts();
    expect(mod.loadDraft('big')).toMatchObject({ text: 'keep me', pastes: {} });
    mkdirSync(dir(), { recursive: true });
    const old = join(dir(), 'old.json');
    writeFileSync(old, JSON.stringify({ v: 1, text: 'stale' }));
    const then = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    utimesSync(old, then, then);
    mod.pruneDrafts();
    expect(mod.loadDraft('old')).toBeNull();
    expect(mod.loadDraft('big')).not.toBeNull();
  });
});

describe('notifications', () => {
  it('picks one protocol per known terminal, and none in tmux or unknown terminals', () => {
    expect(notifyProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('osc9');
    expect(notifyProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('osc9');
    expect(notifyProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('osc9');
    expect(notifyProtocol({ TERM: 'xterm-kitty' })).toBe('osc99');
    expect(notifyProtocol({ TERM: 'foot' })).toBe('osc777');
    expect(notifyProtocol({ TERM: 'rxvt-unicode-256color' })).toBe('osc777');
    expect(notifyProtocol({ TERM: 'xterm-256color' })).toBeUndefined();
    expect(notifyProtocol({ TERM_PROGRAM: 'Apple_Terminal' })).toBeUndefined();
    expect(notifyProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/x' })).toBeUndefined();
  });

  it('follows the config: off, auto, or a forced protocol', () => {
    const c = defaultConfig();
    expect(notifier(c, { TERM: 'xterm-256color' })).toBeUndefined();
    expect(notifier(c, { TERM_PROGRAM: 'iTerm.app' })).toBe('osc9');
    expect(notifier({ ...c, notifications: 'off' }, { TERM_PROGRAM: 'iTerm.app' })).toBeUndefined();
    expect(notifier({ ...c, notifications: 'osc777' }, { TERM: 'xterm-256color' })).toBe('osc777');
    expect(parseConfig('notifications: osc99\n').config.notifications).toBe('osc99');
    const bad = parseConfig('notifications: loud\n');
    expect(bad.config.notifications).toBe('auto');
    expect(bad.issues[0]!.message).toMatch(/notifications must be one of/);
  });

  it('never lets the text end the sequence or start another', () => {
    const evil = 'title\x07\x1b]0;pwned\x1b\\ \x9c;x';
    for (const p of ['osc9', 'osc777', 'osc99'] as const) {
      const seq = notificationSequence(p, 'taria', evil);
      const body = seq.replace(/^\x1b\]\d+;/, '').replace(/(\x07|\x1b\\)$/, '');
      // One ESC only where the protocol itself puts one (kitty's second chunk).
      expect(body.replace(/\x1b\\\x1b\]99;i=taria:d=1:p=body;/, '')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    }
    expect(notificationSequence('osc777', 'a;b', 'c;d')).toBe('\x1b]777;notify;a,b;c,d\x07');
    expect(notificationSequence('osc9', '4', 'x')).toBe('\x1b]9;4: x\x07');
  });
});

describe('focus reports', () => {
  it('decode to focus events, never to keys, even split across chunks or mixed with typing', () => {
    const d = new KeyDecoder();
    const events = [...d.feed('a\x1b[Ob\x1b'), ...d.feed('[Ic')];
    expect(events.map((e) => (e.type === 'key' ? e.key.text : e.type === 'focus' ? `focus:${e.focused}` : e.type))).toEqual(['a', 'focus:false', 'b', 'focus:true', 'c']);
  });
});
