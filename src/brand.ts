// The program's name, and the name it had until 0.2.0. Everything that still
// has to understand the old name (data directories, keychain entries, the
// `parley` command, PARLEY_* variables) gets it from here.

export const APP = 'taria';
export const OLD_APP = 'parley';
/** The release after which the old names stop working. */
export const OLD_NAMES_REMOVED_IN = '0.4.0';

const adopted: string[] = [];

/** Lines for the user from the rename (moved files, old variable names),
 * collected before anything is drawn: the interactive interface shows them
 * in the welcome box, other modes write them to stderr. */
export const renameNotices: string[] = [];

/**
 * Every PARLEY_* variable also works as TARIA_* (the new name wins when both
 * are set). Called once, first thing in the CLI, so the rest of the program
 * only reads TARIA_* names.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('PARLEY_') || v === undefined) continue;
    const next = `TARIA_${k.slice('PARLEY_'.length)}`;
    if (env[next] === undefined) env[next] = v;
    if (!adopted.includes(k)) adopted.push(k);
  }
  return adopted;
}

/** One line about old variable names, or undefined when none were used. */
export function legacyEnvNotice(): string | undefined {
  if (!adopted.length) return undefined;
  const names = adopted.map((k) => `${k} → TARIA_${k.slice('PARLEY_'.length)}`).join(', ');
  return `Renamed environment variable${adopted.length === 1 ? '' : 's'}: ${names}. The old name${adopted.length === 1 ? ' still works' : 's still work'} until ${APP} ${OLD_NAMES_REMOVED_IN}.`;
}
