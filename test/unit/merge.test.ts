// `taria doctor merge`: when parley's data folder and taria's both exist (the
// move could not happen), conversations that are only in the old folder are
// copied over. Nothing in either folder is overwritten or removed.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planMerge, runMerge } from '../../src/config/merge.js';

const conv = (id: string, text: string) => `{"type":"meta","v":1,"id":"${id}","createdAt":1,"app":"parley"}\n{"type":"message","id":"u1","parentId":null,"role":"user","content":[{"type":"text","text":"${text}"}],"ts":1}\n`;

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'taria-merge-'));
  const old = join(root, 'parley');
  const cur = join(root, 'taria');
  for (const d of [old, cur]) for (const s of ['conversations', 'attachments', 'trash']) mkdirSync(join(d, s), { recursive: true });
  return { root, old, cur };
}

describe('merging parley\'s data folder into taria\'s', () => {
  it('copies what is only in the old folder, keeps times, and overwrites nothing', () => {
    const { old, cur } = folders();
    writeFileSync(join(old, 'conversations', 'only-old.jsonl'), conv('only-old', 'only in parley'));
    utimesSync(join(old, 'conversations', 'only-old.jsonl'), 1_700_000_000, 1_700_000_000);
    writeFileSync(join(old, 'conversations', 'same.jsonl'), conv('same', 'same'));
    writeFileSync(join(cur, 'conversations', 'same.jsonl'), conv('same', 'same'));
    writeFileSync(join(old, 'conversations', 'both.jsonl'), conv('both', 'the old text'));
    writeFileSync(join(cur, 'conversations', 'both.jsonl'), conv('both', 'the new text'));
    writeFileSync(join(cur, 'conversations', 'only-new.jsonl'), conv('only-new', 'taria'));
    // Trashed in taria: it must not come back.
    writeFileSync(join(old, 'conversations', 'trashed.jsonl'), conv('trashed', 'x'));
    writeFileSync(join(cur, 'trash', 'trashed.jsonl'), conv('trashed', 'x'));
    // Open in a parley that is still running (this process stands in for it).
    writeFileSync(join(old, 'conversations', 'open.jsonl'), conv('open', 'x'));
    writeFileSync(join(old, 'conversations', 'open.jsonl.lock'), JSON.stringify({ pid: process.ppid }));
    writeFileSync(join(old, 'attachments', 'abc.png'), 'PNG');
    writeFileSync(join(old, 'attachments', 'have.png'), 'OLD');
    writeFileSync(join(cur, 'attachments', 'have.png'), 'NEW');

    const plan = planMerge(old, cur)!;
    expect(plan.onlyOld).toEqual(['only-old', 'open']);
    expect(plan.differ).toEqual(['both']);
    expect(plan.inTrash).toEqual(['trashed']);
    expect(plan.attachments).toEqual(['abc.png']);

    const before = readFileSync(join(cur, 'conversations', 'both.jsonl'), 'utf8');
    const r = runMerge(plan);
    expect(r.copied).toEqual(['only-old']);
    expect(r.skipped.map((s) => s.id)).toEqual(['open']);
    expect(readFileSync(join(cur, 'conversations', 'only-old.jsonl'), 'utf8')).toBe(conv('only-old', 'only in parley'));
    expect(Math.round(statSync(join(cur, 'conversations', 'only-old.jsonl')).mtimeMs / 1000)).toBe(1_700_000_000);
    expect(statSync(join(cur, 'conversations', 'only-old.jsonl')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cur, 'conversations', 'both.jsonl'), 'utf8')).toBe(before);
    expect(readFileSync(join(cur, 'attachments', 'have.png'), 'utf8')).toBe('NEW');
    expect(readFileSync(join(cur, 'attachments', 'abc.png'), 'utf8')).toBe('PNG');
    expect(readdirSync(join(cur, 'conversations')).sort()).toEqual(['both.jsonl', 'only-new.jsonl', 'only-old.jsonl', 'same.jsonl']);
    // The old folder is exactly as it was.
    expect(readdirSync(join(old, 'conversations')).sort()).toEqual(['both.jsonl', 'only-old.jsonl', 'open.jsonl', 'open.jsonl.lock', 'same.jsonl', 'trashed.jsonl']);
    // Running it again finds only what was skipped.
    expect(planMerge(old, cur)!.onlyOld).toEqual(['open']);
  });

  it('a file that appears at the target between the plan and the copy is not overwritten', () => {
    const { old, cur } = folders();
    writeFileSync(join(old, 'conversations', 'late.jsonl'), conv('late', 'old'));
    const plan = planMerge(old, cur)!;
    writeFileSync(join(cur, 'conversations', 'late.jsonl'), conv('late', 'written meanwhile'));
    const r = runMerge(plan);
    expect(r.copied).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(readFileSync(join(cur, 'conversations', 'late.jsonl'), 'utf8')).toBe(conv('late', 'written meanwhile'));
  });

  it('there is nothing to merge when the old path is missing, or is a link to taria\'s folder', () => {
    const { root, cur } = folders();
    expect(planMerge(join(root, 'nowhere'), cur)).toBeUndefined();
    symlinkSync(cur, join(root, 'link'));
    expect(planMerge(join(root, 'link'), cur)).toBeUndefined();
  });
});
