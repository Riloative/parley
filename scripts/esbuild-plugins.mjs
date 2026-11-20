// esbuild plugins shared by the npm build (scripts/build.mjs) and the
// standalone binary (scripts/build-binary.mjs).
import { readFile } from 'node:fs/promises';

/**
 * Ink's layout engine, yoga-layout, ships its WebAssembly as a base64 data:
 * URL inside an Emscripten loader. When `fetch` exists, that loader decodes
 * the data: URL with `fetch()`, which makes Node load its whole internal HTTP
 * stack (undici, web streams) on every start: about 25 ms before the first
 * frame, for a request that never touches the network. Treat `fetch` as
 * absent there, so the loader takes its own synchronous base64 path.
 * The build fails if the pattern is not found, so a yoga upgrade that changes
 * the loader cannot silently undo this.
 */
export const yogaNoFetch = {
  name: 'yoga-no-fetch',
  setup(b) {
    b.onLoad({ filter: /yoga-layout[\\/]dist[\\/]binaries[\\/]yoga-wasm-base64-esm\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const pattern = /"function"!=typeof fetch/g;
      const n = src.match(pattern)?.length ?? 0;
      if (n !== 2) throw new Error(`yoga-no-fetch: expected 2 fetch checks in ${args.path}, found ${n}; update scripts/esbuild-plugins.mjs`);
      return { contents: src.replace(pattern, '!0'), loader: 'js' };
    });
  },
};

/**
 * string-width builds `/^\p{RGI_Emoji}$/v` when it is loaded. V8 expands
 * that property of strings into a large set at construction time: about
 * 17 ms, on every start, before the first frame. Build it on first use
 * instead, and skip it for a single code point without the
 * Emoji_Presentation property, which can never be an RGI emoji on its own
 * (digits have the Emoji property, for keycaps). Box drawing, CJK and most
 * other text never reach it; the app warms it up after the first frame. Equivalence with the
 * original regex is tested over every code point (test/unit/build-plugins.test.ts).
 */
export const LAZY_RGI_EMOJI = `const rgiEmojiRegex = (() => {
  const emojiCodePoint = /\\p{Emoji_Presentation}/u;
  let compiled;
  return {
    test(segment) {
      if ((segment.length === 1 || (segment.length === 2 && segment.codePointAt(0) > 0xffff)) && !emojiCodePoint.test(segment)) return false;
      compiled ??= new RegExp('^\\\\p{RGI_Emoji}$', 'v');
      return compiled.test(segment);
    },
  };
})();`;

export const stringWidthLazyEmoji = {
  name: 'string-width-lazy-emoji',
  setup(b) {
    b.onLoad({ filter: /[\\/]node_modules[\\/]string-width[\\/]index\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const original = 'const rgiEmojiRegex = /^\\p{RGI_Emoji}$/v;';
      const n = src.split(original).length - 1;
      if (n !== 1) throw new Error(`string-width-lazy-emoji: expected the RGI_Emoji regex once in ${args.path}, found ${n}; update scripts/esbuild-plugins.mjs`);
      return { contents: src.replace(original, () => LAZY_RGI_EMOJI), loader: 'js' };
    });
  },
};

export const sharedPlugins = [yogaNoFetch, stringWidthLazyEmoji];
