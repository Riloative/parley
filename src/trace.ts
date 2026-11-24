// Start-up phase marks, written next to the first-frame time when
// TARIA_STARTUP_TRACE is set (see scripts/bench-startup.mjs).
const marks: Array<[string, number]> = [];

export function mark(name: string): void {
  if (process.env.TARIA_STARTUP_TRACE) marks.push([name, Math.round(performance.now() * 10) / 10]);
}

export function startupMarks(): Array<[string, number]> {
  return marks;
}
