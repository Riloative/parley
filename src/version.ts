// Version and build identification (no imports, safe to load anywhere).

declare const __TARIA_VERSION__: string;
declare const __TARIA_BUILD__: string;
export const VERSION = typeof __TARIA_VERSION__ === 'string' ? __TARIA_VERSION__ : '0.0.0-dev';
/** 'binary' for the standalone executable, 'node' for the npm package. */
export const BUILD_KIND: 'binary' | 'node' = typeof __TARIA_BUILD__ === 'string' && __TARIA_BUILD__ === 'binary' ? 'binary' : 'node';

/** One line: version, build kind, runtime and platform. */
export function versionLine(): string {
  const kind = BUILD_KIND === 'binary' ? 'standalone binary' : 'node package';
  return `taria ${VERSION} (${kind}, Node ${process.version}, ${process.platform}-${process.arch})`;
}
