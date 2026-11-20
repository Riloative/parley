// Version and build identification (no imports, safe to load anywhere).

declare const __PARLEY_VERSION__: string;
declare const __PARLEY_BUILD__: string;
export const VERSION = typeof __PARLEY_VERSION__ === 'string' ? __PARLEY_VERSION__ : '0.0.0-dev';
/** 'binary' for the standalone executable, 'node' for the npm package. */
export const BUILD_KIND: 'binary' | 'node' = typeof __PARLEY_BUILD__ === 'string' && __PARLEY_BUILD__ === 'binary' ? 'binary' : 'node';

/** One line: version, build kind, runtime and platform. */
export function versionLine(): string {
  const kind = BUILD_KIND === 'binary' ? 'standalone binary' : 'node package';
  return `parley ${VERSION} (${kind}, Node ${process.version}, ${process.platform}-${process.arch})`;
}
