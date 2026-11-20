// The build patches two dependencies for start-up speed (scripts/esbuild-plugins.mjs).
// These tests check that the patched code behaves exactly like the original.
import { build } from 'esbuild';
import stringWidth from 'string-width';
import type YogaType from 'yoga-layout';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without types
import { LAZY_RGI_EMOJI, stringWidthLazyEmoji, yogaNoFetch } from '../../scripts/esbuild-plugins.mjs';

async function bundle(source: string, plugins: unknown[]): Promise<string> {
  const r = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    plugins: plugins as never,
    logLevel: 'silent',
  });
  return r.outputFiles[0]!.text;
}

async function importText<T>(code: string): Promise<T> {
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as T;
}

// Emoji sequences of every kind, plus text that merely looks close.
const SEQUENCES = [
  '👍', '👍🏽', '❤️', '❤', '☺', '☺️', '#️⃣', '1️⃣', '1⃣', '🇫🇷', '🇫', '🏳️‍🌈', '👨‍👩‍👧‍👦', '👩🏽‍💻', '🧑‍🤝‍🧑', '🫶🏿',
  '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '©', '©️', '®️', '™️', '↔️', '⌚', '⏱️', '🀄', '🅰️', '🅰', '🈚', '👁️‍🗨️', '🐈‍⬛', '🧔‍♂️', '⛹🏻‍♀️',
  'é', 'é', 'ก็', '각', '각', 'ﾞ', 'ｶﾞ', '漢', '─', '◆', '●', '⎿', '·', 'a‍b', '​', '­', '‍',
];

describe('build patches', () => {
  it('the lazy RGI_Emoji test matches the original regex for every code point and sequence', () => {
    const original = new RegExp('^\\p{RGI_Emoji}$', 'v');
    const lazy = new Function(`${LAZY_RGI_EMOJI}\nreturn rgiEmojiRegex;`)() as RegExp;
    let mismatches = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = String.fromCodePoint(cp);
      if (lazy.test(s) !== original.test(s)) mismatches++;
      // With the emoji and text presentation selectors too.
      if (cp > 0x20 && cp < 0x30000 && (lazy.test(s + '️') !== original.test(s + '️'))) mismatches++;
    }
    for (const s of SEQUENCES) expect(lazy.test(s), s).toBe(original.test(s));
    expect(mismatches).toBe(0);
  });

  it('the bundled string-width gives the same widths as the original', async () => {
    const code = await bundle("export { default } from 'string-width';", [stringWidthLazyEmoji]);
    expect(code).not.toContain('/^\\p{RGI_Emoji}$/v');
    const patched = (await importText<{ default: typeof stringWidth }>(code)).default;
    const samples = [...SEQUENCES, SEQUENCES.join(''), 'plain ascii', '\x1b[31mred\x1b[0m 👍', 'mixed 漢字 and 👨‍👩‍👧 and ─◆─'];
    for (let cp = 0xa0; cp < 0x20000; cp += 7) {
      if (cp < 0xd800 || cp > 0xdfff) samples.push(String.fromCodePoint(cp));
    }
    for (const s of samples) expect(patched(s), JSON.stringify(s)).toBe(stringWidth(s));
  });

  it('the bundled yoga loads its WebAssembly without fetch and lays out', async () => {
    const code = await bundle("import Yoga from 'yoga-layout'; export default Yoga;", [yogaNoFetch]);
    expect(code).not.toMatch(/"function"\s*!=\s*typeof fetch/);
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      fetched++;
      return realFetch(...a);
    }) as typeof fetch;
    try {
      const Yoga = (await importText<{ default: typeof YogaType }>(code)).default;
      const root = Yoga.Node.create();
      root.setWidth(80);
      const child = Yoga.Node.create();
      child.setHeight(3);
      root.insertChild(child, 0);
      root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
      expect(child.getComputedWidth()).toBe(80);
      expect(root.getComputedHeight()).toBe(3);
      root.freeRecursive();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
  });
});
