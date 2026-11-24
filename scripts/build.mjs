// Bundles src/ into dist/ with esbuild. dist/ is committed so that
// `npm install -g .` works from a fresh clone without a build step (npm packs
// a folder before installing any dependencies). Everything taria needs at
// runtime is bundled, so the installed package has no dependencies. The entry (cli.js) stays tiny so that
// --help/--version and cold start stay fast; the interface, providers and the
// syntax highlighter are split into chunks that are loaded on demand.
import { build } from 'esbuild';
import { sharedPlugins } from './esbuild-plugins.mjs';
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
  sourcemap: process.env.TARIA_SOURCEMAP ? 'linked' : false,
  minify: true,
  keepNames: false,
  legalComments: 'none',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    __TARIA_VERSION__: JSON.stringify(pkg.version),
    __TARIA_BUILD__: '"node"',
  },
  // react-devtools-core is an optional Ink peer used only for debugging.
  external: ['react-devtools-core'],
  banner: {
    js: "import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
  plugins: sharedPlugins,
});

// The man page, generated from the same description as --help.
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const page = execFileSync(process.execPath, [new URL('../bin/taria.js', import.meta.url).pathname, 'man'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  writeFileSync(new URL('../dist/taria.1', import.meta.url), page);
}
