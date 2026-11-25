// The program's name, and the name it had until 0.2.0. Everything that still
// has to understand the old name (data directories, keychain entries, files
// written by parley) gets it from here.

export const APP = 'taria';
export const OLD_APP = 'parley';
/** The release that removed the `parley` command and the PARLEY_* names. */
export const OLD_NAMES_REMOVED_IN = '0.4.0';

/** Lines for the user from the rename (moved files, old variable names),
 * collected before anything is drawn: the interactive interface shows them
 * in the welcome box, other modes write them to stderr. */
export const renameNotices: string[] = [];

/** PARLEY_* variables that are set. They were read as TARIA_* in 0.3.x and
 * are not read any more; nothing is copied. */
export function ignoredLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => k.startsWith('PARLEY_') && env[k] !== undefined);
}

/** One line about old variable names that are set, or undefined when none
 * are. Silence would be worse: PARLEY_DATA_DIR or PARLEY_NO_KEYCHAIN being
 * ignored changes where files and keys go. */
export function legacyEnvNotice(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = ignoredLegacyEnv(env);
  if (!names.length) return undefined;
  const list = names.map((k) => `${k} (use TARIA_${k.slice('PARLEY_'.length)})`).join(', ');
  return `${names.length === 1 ? 'This variable is' : 'These variables are'} no longer read since ${APP} ${OLD_NAMES_REMOVED_IN}: ${list}.`;
}
