// Bundles src/ into dist/ with esbuild. The entry (cli.js) stays tiny so that
// --help/--version and cold start stay fast; the interface, providers and the
// syntax highlighter are split into chunks that are loaded on demand.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: { cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  minify: false,
  legalComments: 'none',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    __PARLEY_VERSION__: JSON.stringify(pkg.version),
  },
  // react-devtools-core is an optional Ink peer used only for debugging.
  external: ['react-devtools-core'],
  banner: {
    js: "import { createRequire as __parleyCreateRequire } from 'node:module'; const require = __parleyCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
