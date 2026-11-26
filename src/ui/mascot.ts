// taria's mascot, drawn as pixel art: every terminal cell holds two pixels,
// one above the other, with the half-block characters ▀ ▄ █. Pixels that are
// off are the terminal's own background (the eyes are holes), so it reads in
// any theme with a single colour.

/** A drawing: rows of '#' (on) and '.' (off), an even number of rows. */
export type Pixels = string[];

/** taria's owl: ear tufts, two round eyes, feet. */
export const OWL: Pixels = [
  '##........##',
  '############',
  '##..####..##',
  '##..####..##',
  '############',
  '.##########.',
  '..########..',
  '..##....##..',
];

/** The drawing as terminal lines: half blocks, or plain ASCII when the
 * terminal cannot show Unicode. All lines have the same width. */
export function mascotLines(pixels: Pixels, unicode = true): string[] {
  const out: string[] = [];
  for (let r = 0; r < pixels.length; r += 2) {
    const top = pixels[r]!;
    const bottom = pixels[r + 1] ?? '';
    let line = '';
    for (let c = 0; c < top.length; c++) {
      const t = top[c] === '#';
      const b = bottom[c] === '#';
      line += unicode ? (t && b ? '█' : t ? '▀' : b ? '▄' : ' ') : t && b ? '#' : t ? '"' : b ? ',' : ' ';
    }
    out.push(line);
  }
  return out;
}
