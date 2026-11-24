// `taria doctor merge`: bring conversations over from parley's data folder
// when the move could not happen because taria's folder already had files.
// Only files that do not exist in taria's folder are copied. Nothing in
// either folder is overwritten, changed or removed.

import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { holderAlive } from '../core/store.js';

export interface MergePlan {
  oldDir: string;
  newDir: string;
  /** Conversation ids that exist only in the old folder. */
  onlyOld: string[];
  /** Ids in both folders whose files differ: both are kept as they are. */
  differ: string[];
  /** Ids only in the old folder that are in taria's trash: left there. */
  inTrash: string[];
  /** Attachment files (named by content hash) only in the old folder. */
  attachments: string[];
}

const list = (dir: string, re: RegExp): string[] => {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).sort();
  } catch {
    return [];
  }
};

const same = (a: string, b: string): boolean => {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** What a merge would do, or undefined when the old path is not a separate
 * folder (missing, or a link to taria's folder). Reads only. */
export function planMerge(oldDir: string, newDir: string): MergePlan | undefined {
  try {
    if (!lstatSync(oldDir).isDirectory() && !statSync(oldDir).isDirectory()) return undefined;
    if (existsSync(newDir) && realpathSync(oldDir) === realpathSync(newDir)) return undefined;
  } catch {
    return undefined;
  }
  const plan: MergePlan = { oldDir, newDir, onlyOld: [], differ: [], inTrash: [], attachments: [] };
  for (const f of list(join(oldDir, 'conversations'), /\.jsonl$/)) {
    const id = f.slice(0, -'.jsonl'.length);
    const target = join(newDir, 'conversations', f);
    if (existsSync(target)) {
      if (!same(join(oldDir, 'conversations', f), target)) plan.differ.push(id);
    } else if (existsSync(join(newDir, 'trash', f))) plan.inTrash.push(id);
    else plan.onlyOld.push(id);
  }
  plan.attachments = list(join(oldDir, 'attachments'), /./).filter((f) => !existsSync(join(newDir, 'attachments', f)));
  return plan;
}

/** Copy one file without ever replacing an existing one; keeps its time. */
function copyNew(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, 0o600);
  const st = statSync(from);
  utimesSync(to, st.atime, st.mtime);
}

export interface MergeResult {
  copied: string[];
  skipped: Array<{ id: string; why: string }>;
  attachments: number;
}

export function runMerge(plan: MergePlan): MergeResult {
  const out: MergeResult = { copied: [], skipped: [], attachments: 0 };
  mkdirSync(join(plan.newDir, 'conversations'), { recursive: true, mode: 0o700 });
  for (const id of plan.onlyOld) {
    const from = join(plan.oldDir, 'conversations', `${id}.jsonl`);
    try {
      // A parley that has it open is still writing to it.
      const lock = JSON.parse(readFileSync(`${from}.lock`, 'utf8')) as { pid: number; started?: number };
      if (typeof lock.pid === 'number' && holderAlive(lock)) {
        out.skipped.push({ id, why: `open in parley (pid ${lock.pid}); close it and run this again` });
        continue;
      }
    } catch {
      /* no lock, or not readable as one */
    }
    try {
      copyNew(from, join(plan.newDir, 'conversations', `${id}.jsonl`));
      out.copied.push(id);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      out.skipped.push({ id, why: code === 'EEXIST' ? "it now exists in taria's folder; left as it is" : (e as Error).message });
    }
  }
  if (plan.attachments.length) mkdirSync(join(plan.newDir, 'attachments'), { recursive: true, mode: 0o700 });
  for (const f of plan.attachments) {
    try {
      copyNew(join(plan.oldDir, 'attachments', f), join(plan.newDir, 'attachments', f));
      out.attachments++;
    } catch {
      /* exists by now, or unreadable: the conversation still opens without it */
    }
  }
  return out;
}
