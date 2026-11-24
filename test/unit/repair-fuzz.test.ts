// Fuzz of the repair of conversations hit by the 0.0.1–0.2.0 crash bug.
//
// Each seed simulates what parley 0.1.0 and 0.2.0 sessions wrote (sends,
// crashes at every point of a turn, rewinds, retries, branch switches), using
// the REAL old readers (test/fixtures/old-readers) for every restart; then the
// current Store.open() repairs the file, and the invariants below are checked,
// among them that all three old readers open the repaired file exactly like
// the current one.
//
//   FUZZ_N=30000 npx vitest run test/unit/repair-fuzz.test.ts   more seeds
//   FUZZ_SEED=110 …                                             one seed, with its log and file
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, replay, scanForRepairs } from '../../src/core/store.js';
import { Store as Store010, replay as replay010 } from '../fixtures/old-readers/v010/store.js';
import { Store as Store020, replay as replay020 } from '../fixtures/old-readers/v020/store.js';
import { replay as replay001 } from '../fixtures/old-readers/v001/store.js';

const ID = '20250601-120000-fuzz';
const N = Number(process.env.FUZZ_N ?? 400);
const ONLY = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
/**
 * Whether sessions also crash between writing the user's message and the
 * reply's `partial` line. The seeds run once without and once with it:
 * parley 0.1.0 and 0.2.0 themselves disagree with every later reader about
 * such a file *before* any repair (if an earlier cut-off reply was the last
 * `partial` line, they open at that reply and hide the message the user just
 * sent), so with it the two comparisons against the old session's own view
 * are left out; everything about the repaired file is checked all the same.
 */
let crashBeforePartial = false;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Msg {
  id: string;
  parentId: string | null;
  role: string;
  content: unknown[];
  model?: string;
  ts: number;
}
/** What the test needs of a conversation, whichever version read it. */
interface AnyConv {
  headId: string | null;
  updatedAt: number;
  messages: Map<string, Msg>;
  path(): Msg[];
}
type Outcome = 'ok' | 'crash' | 'crash-nodelta' | 'empty' | 'crash-before-partial';

/** A session of an old version, at the level of what it wrote to the file. */
class OldSession {
  conv!: AnyConv;
  branchFrom: string | null | undefined;
  log: string[] = [];
  constructor(
    readonly root: string,
    readonly file: string,
    readonly version: '010' | '020',
    readonly r: () => number,
    readonly counter: { n: number },
  ) {
    this.reload();
  }
  w(ev: object) {
    appendFileSync(this.file, JSON.stringify(ev) + '\n');
  }
  id(p: string) {
    return `${p}${++this.counter.n}`;
  }
  /** Process restart + resume, with the real old Store.open(). */
  reload() {
    const f = this.version === '010' ? new Store010(this.root).open(ID) : new Store020(this.root).open(ID);
    f.releaseLock();
    this.conv = f.conv as unknown as AnyConv;
    this.branchFrom = undefined;
    this.log.push(`reload(${this.version}) head=${this.conv.headId}`);
  }
  turn(parentId: string | null, outcome: Outcome) {
    const a = this.id('a');
    this.w({ type: 'partial', id: a, parentId, model: 'mock/echo', ts: this.counter.n });
    if (outcome === 'crash-nodelta') return this.reload();
    if (outcome === 'empty') {
      this.w({ type: 'head', id: parentId, ts: this.counter.n });
      this.conv.headId = parentId;
      return;
    }
    this.w({ type: 'delta', id: a, text: `text of ${a} ` });
    if (outcome === 'crash') return this.reload();
    const m = { id: a, parentId, role: 'assistant', content: [{ type: 'text', text: `text of ${a} ` }], model: 'mock/echo', ts: this.counter.n };
    this.conv.messages.set(a, m);
    this.conv.headId = a;
    this.w({ type: 'message', ...m });
  }
  send(outcome: Outcome) {
    const parentId = this.branchFrom !== undefined ? this.branchFrom : this.conv.headId;
    this.branchFrom = undefined;
    const u = this.id('u');
    const m = { id: u, parentId, role: 'user', content: [{ type: 'text', text: `q ${u}` }], ts: this.counter.n };
    this.conv.messages.set(u, m);
    this.conv.headId = u;
    this.w({ type: 'message', ...m });
    this.log.push(`send ${u}<-${parentId} ${outcome}`);
    if (outcome === 'crash-before-partial') return this.reload();
    this.turn(u, outcome);
  }
  rewind() {
    const users = this.conv.path().filter((m) => m.role === 'user');
    const m = users[Math.floor(this.r() * users.length)];
    if (!m) return;
    this.branchFrom = m.parentId;
    this.conv.headId = m.parentId;
    this.w({ type: 'head', id: m.parentId, ts: this.counter.n });
    this.log.push(`rewind to before ${m.id} (head ${m.parentId})`);
  }
  retry(outcome: Outcome) {
    const user = this.conv.path().filter((m) => m.role === 'user').at(-1);
    if (!user) return;
    this.branchFrom = undefined;
    this.conv.headId = user.id;
    this.w({ type: 'head', id: user.id, ts: this.counter.n });
    this.log.push(`retry from ${user.id} ${outcome}`);
    this.turn(user.id, outcome);
  }
  switchBranch() {
    if (this.version !== '020') return;
    const parents = new Set<string>();
    for (const m of this.conv.messages.values()) if (m.parentId) parents.add(m.parentId);
    const leaves = [...this.conv.messages.values()].filter((m) => !parents.has(m.id) && m.id !== this.conv.headId);
    const leaf = leaves[Math.floor(this.r() * leaves.length)];
    if (!leaf) return;
    this.branchFrom = undefined;
    this.conv.headId = leaf.id;
    this.w({ type: 'head', id: leaf.id, ts: this.counter.n });
    this.log.push(`switch to ${leaf.id}`);
  }
  step() {
    const x = this.r();
    const outcome = (): Outcome => {
      const y = this.r();
      return y < 0.55 ? 'ok' : y < 0.85 ? 'crash' : y < 0.9 ? 'crash-nodelta' : y < 0.95 || !crashBeforePartial ? 'empty' : 'crash-before-partial';
    };
    if (x < 0.6) this.send(outcome());
    else if (x < 0.75) this.rewind();
    else if (x < 0.87) {
      const o = outcome();
      this.retry(o === 'crash-before-partial' ? 'ok' : o);
    } else if (x < 0.95) this.switchBranch();
    else this.reload();
  }
}

const ids = (c: AnyConv) => c.path().map((m) => m.id);
const read = (rp: (id: string, text: string) => { conv: unknown }, text: string) => rp(ID, text).conv as AnyConv;

function runSeed(seed: number) {
  const r = rng(seed);
  const root = mkdtempSync(join(tmpdir(), 'taria-fuzz-'));
  mkdirSync(join(root, 'conversations'), { recursive: true });
  const file = join(root, 'conversations', `${ID}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'meta', v: 1, id: ID, createdAt: 1, app: 'parley' }) + '\n');
  const counter = { n: 0 };
  const problems: string[] = [];
  const log: string[] = [];
  const phase = (version: '010' | '020', steps: number) => {
    const s = new OldSession(root, file, version, r, counter);
    for (let i = 0; i < steps; i++) s.step();
    s.reload(); // the user quits; what they would see on the next start
    log.push(...s.log);
    return s.conv;
  };
  const check = (label: string, oldConv: AnyConv) => {
    // The file was last written long ago.
    utimesSync(file, 1_000_000, 1_000_000 + seed);
    const before = readFileSync(file, 'utf8');
    const pre = replay(ID, before);
    const preConv = pre.conv as AnyConv;
    // (1) the new reader shows the old view's messages as the end of its path
    const oldPath = ids(oldConv);
    const newPath = ids(preConv);
    if (!crashBeforePartial) {
      if (preConv.headId !== oldConv.headId) problems.push(`${label}: head differs: old reader ${oldConv.headId}, new reader ${preConv.headId}`);
      else if (newPath.slice(newPath.length - oldPath.length).join() !== oldPath.join()) problems.push(`${label}: old path ${oldPath} is not the end of new path ${newPath}`);
    }
    const first = newPath[0] === undefined ? undefined : preConv.messages.get(newPath[0]);
    if (first && first.parentId !== null) problems.push(`${label}: path does not reach the root: ${newPath}`);
    const scan = scanForRepairs(new Store(root));
    // The scan's count of hidden messages is what the last old session did
    // not show (it had recorded its own last partial reply, if any).
    if (!crashBeforePartial && scan[0] && scan[0].hidden !== newPath.length - oldPath.length) problems.push(`${label}: scan says ${scan[0].hidden} hidden, the old reader hid ${newPath.length - oldPath.length}`);
    // (2) repair
    const f = new Store(root).open(ID);
    f.releaseLock();
    const after = readFileSync(file, 'utf8');
    if (!after.startsWith(before)) problems.push(`${label}: file was rewritten`);
    if ((scan[0]?.lost ?? 0) !== f.repaired) problems.push(`${label}: scan says ${scan[0]?.lost ?? 0}, repaired ${f.repaired}`);
    if (f.repaired !== pre.lost.length) problems.push(`${label}: repaired count`);
    const added = after.slice(before.length).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    if (!f.repaired && added.some((e) => e.type === 'head')) problems.push(`${label}: head appended without a repair`);
    const post = replay(ID, after);
    const postConv = post.conv as AnyConv;
    const opened = f.conv as AnyConv;
    if (postConv.headId !== opened.headId || ids(postConv).join() !== ids(opened).join()) problems.push(`${label}: replay after repair differs from the opened conversation: ${ids(postConv)} vs ${ids(opened)}`);
    if (post.lost.length) problems.push(`${label}: still lost after repair`);
    // what the user had before must not change, apart from the last partial becoming a message
    if (ids(postConv).join() !== newPath.join()) problems.push(`${label}: path changed by the repair: ${newPath} -> ${ids(postConv)}`);
    // the repair is not activity: neither time that orders the list moves
    if (postConv.updatedAt !== preConv.updatedAt) problems.push(`${label}: updatedAt moved from ${preConv.updatedAt} to ${postConv.updatedAt}`);
    if (statSync(file).mtimeMs !== (1_000_000 + seed) * 1000) problems.push(`${label}: mtime moved`);
    // (3) old readers of the repaired file
    for (const [name, rp] of [['0.0.1', replay001], ['0.1.0', replay010], ['0.2.0', replay020]] as const) {
      const o = read(rp, after);
      if (o.headId !== postConv.headId) problems.push(`${label}: ${name} reader head ${o.headId}, new reader ${postConv.headId}`);
      else if (ids(o).join() !== ids(postConv).join()) problems.push(`${label}: ${name} reader path ${ids(o)} vs ${ids(postConv)}`);
      if (o.updatedAt > preConv.updatedAt) problems.push(`${label}: ${name} reader updatedAt moved`);
    }
    // (4) idempotent
    const g = new Store(root).open(ID);
    g.releaseLock();
    if (g.repaired !== 0 || readFileSync(file, 'utf8') !== after) problems.push(`${label}: second open changed the file`);
    if (scanForRepairs(new Store(root)).length) problems.push(`${label}: scan still reports`);
  };
  const c1 = phase('010', 3 + Math.floor(r() * 12));
  if (r() < 0.5) {
    check('after 0.1.0', c1);
    const c2 = phase('020', 2 + Math.floor(r() * 8));
    check('after 0.1.0, 0.3.0, 0.2.0', c2);
  } else {
    const c2 = phase('020', 2 + Math.floor(r() * 8));
    check('after 0.1.0, 0.2.0', c2);
    const c3 = phase('020', 2 + Math.floor(r() * 8));
    check('after 0.1.0, 0.2.0, 0.3.0, 0.2.0', c3);
  }
  const text = readFileSync(file, 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { problems, log, text };
}

describe('fuzz: sessions of parley 0.1.0 and 0.2.0, then the repair', () => {
  it.each([
    ['crashes during a reply', false],
    ['also crashes before a reply starts', true],
  ])(
    `holds the invariants for ${ONLY === undefined ? `${N} seeds` : `seed ${ONLY}`}: %s`,
    (_name, cbp) => {
      crashBeforePartial = cbp;
      const bad: string[] = [];
      const kinds = new Map<string, number>();
      for (let seed = ONLY ?? 1; seed <= (ONLY ?? N); seed++) {
        const { problems, log, text } = runSeed(seed);
        if (!problems.length) continue;
        const kind = problems[0]!.replace(/[ua]\d+/g, 'X').replace(/X(,X)*/g, 'X').replace(/\d+/g, 'N');
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        if (bad.length < 3) bad.push(`seed ${seed}:\n  ${problems.join('\n  ')}\n  log: ${log.join(' | ')}\n${ONLY === undefined ? '' : text}`);
      }
      const report = [...kinds].map(([k, n]) => `${n} x ${k}`).join('\n') + '\n\n' + bad.join('\n\n');
      expect(kinds.size, report).toBe(0);
    },
    30_000 + N * 5,
  );
});
