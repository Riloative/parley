// Start-up phase marks, written next to the first-frame time when
// PARLEY_STARTUP_TRACE is set (see scripts/bench-startup.mjs).
const marks: Array<[string, number]> = [];

export function mark(name: string): void {
  if (process.env.PARLEY_STARTUP_TRACE) marks.push([name, Math.round(performance.now() * 10) / 10]);
}

export function startupMarks(): Array<[string, number]> {
  return marks;
}
