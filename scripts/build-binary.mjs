// Builds a standalone taria executable with Node's single executable
// application (SEA) support. The embedded runtime is pinned in
// scripts/binary-runtime.json; the official Node.js build for this machine's
// platform is downloaded, verified against SHASUMS256.txt, and used both to
// generate the blob and as the executable it is injected into (the two must
// be the same version). Build on the target platform: the V8 code cache that
// makes start-up fast can only be loaded on the platform that produced it.
//
// Usage: node scripts/build-binary.mjs [--out build/bin]
//   TARIA_SEA_NODE=/path/to/node   use this Node binary instead of downloading
//                                   (must match the pinned version)
//
// Output: <out>/taria (ad-hoc signed on macOS) and <out>/taria-<os>-<arch>.tar.gz

import { build } from 'esbuild';
import { sharedPlugins } from './esbuild-plugins.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(join(root, 'scripts', 'binary-runtime.json'), 'utf8'));
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, 'build', 'bin'));

const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!os || !arch) throw new Error(`Unsupported build platform ${process.platform}-${process.arch}`);
const target = `${os}-${arch}`;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** The pinned official Node.js binary for this platform. */
async function pinnedNode() {
  if (process.env.TARIA_SEA_NODE) return process.env.TARIA_SEA_NODE;
  const v = runtime.node;
  const cache = join(process.env.TARIA_SEA_CACHE ?? join(tmpdir(), 'taria-sea-cache'), `node-v${v}-${target}`);
  const bin = join(cache, 'bin', 'node');
  if (existsSync(bin)) return bin;
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/v${v}`;
  const name = `node-v${v}-${target}.tar.gz`;
  const tgz = join(cache, name);
  const sums = join(cache, 'SHASUMS256.txt');
  console.log(`Downloading Node.js v${v} for ${target}…`);
  await download(`${base}/SHASUMS256.txt`, sums);
  await download(`${base}/${name}`, tgz);
  const line = readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.endsWith(`  ${name}`));
  if (!line) throw new Error(`${name} is not listed in SHASUMS256.txt`);
  const expected = line.split(/\s+/)[0];
  const actual = sha256(tgz);
  if (expected !== actual) throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  execFileSync('tar', ['xzf', tgz, '-C', cache, '--strip-components=1']);
  rmSync(tgz);
  return bin;
}

const node = await pinnedNode();
const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
if (nodeVersion !== `v${runtime.node}`) throw new Error(`Expected Node v${runtime.node} for the binary, got ${nodeVersion} from ${node}`);

const work = join(root, 'build', 'sea');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// One self-contained ES module: an executable can't load chunk files, so
// code splitting is off and esbuild inlines the dynamically imported modules
// (highlight.js, the Anthropic SDK, undici). ESM keeps yoga-layout's
// top-level await working.
const main = join(work, 'taria.mjs');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: main,
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'node',
  target: `node${runtime.node.split('.')[0]}`,
  minify: true,
  legalComments: 'none',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    __TARIA_VERSION__: JSON.stringify(pkg.version),
    __TARIA_BUILD__: '"binary"',
  },
  // Ink's optional DevTools hook would be linked eagerly in a single file.
  alias: { 'react-devtools-core': join(root, 'scripts', 'stubs', 'react-devtools-core.mjs') },
  plugins: sharedPlugins,
  banner: {
    js: "import { createRequire as __tariaCreateRequire } from 'node:module'; const require = __tariaCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

const exe = join(out, 'taria');
rmSync(exe, { force: true });
const config = join(work, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main,
      mainFormat: 'module',
      executable: node,
      output: exe,
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
      useSnapshot: false,
      // Keep the binary immune to NODE_OPTIONS and friends from the user's
      // environment: it should behave the same everywhere.
      execArgvExtension: 'none',
    },
    null,
    2,
  ),
);
execFileSync(node, ['--build-sea', config], { stdio: 'inherit' });
chmodSync(exe, 0o755);
if (os === 'darwin') {
  // Injection invalidates the original signature; arm64 macOS refuses to run
  // unsigned code, so sign ad hoc (no Developer ID / notarization).
  execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });
}

// Smoke-check the result before packaging it.
const reported = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (!reported.startsWith(`taria ${pkg.version}`)) throw new Error(`Built binary reports "${reported}"`);

const archive = join(out, `taria-${target}.tar.gz`);
const stage = join(work, 'stage');
mkdirSync(stage, { recursive: true });
copyFileSync(exe, join(stage, 'taria'));
execFileSync('tar', ['czf', archive, '-C', stage, 'taria']);
console.log(`Built ${exe} (${reported})`);
console.log(`Packaged ${archive}`);
