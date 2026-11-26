// The words on the spinner line while taria waits and writes. Each turn
// starts on a fresh word, and the word changes every WORD_SECONDS, walking
// the list with a step that is coprime with its length: never the same word
// twice in a row, and every word before any repeats. Written for taria; it
// only converses, so no word suggests that it runs or looks things up.

export const WORDS: readonly string[] = [
  'Pondering', 'Mulling', 'Musing', 'Contemplating', 'Ruminating', 'Reflecting', 'Considering',
  'Weighing', 'Deliberating', 'Reasoning', 'Drafting', 'Composing', 'Wording', 'Phrasing',
  'Wordsmithing', 'Scribbling', 'Penciling', 'Inking', 'Polishing', 'Rephrasing', 'Outlining',
  'Sketching', 'Jotting', 'Annotating', 'Parleying', 'Conversing', 'Murmuring', 'Humming',
  'Listening closely', 'Daydreaming', 'Stargazing', 'Wondering', 'Woolgathering', 'Brainstorming',
  'Imagining', 'Doodling', 'Tinkering', 'Puzzling', 'Untangling', 'Unknotting',
  'Piecing it together', 'Connecting the dots', 'Sifting', 'Sorting thoughts',
  'Gathering thoughts', 'Lining up words', 'Finding the words', 'Choosing words carefully',
  'Chewing on it', 'Thinking aloud', 'Turning it over', 'Steeping', 'Weaving', 'Knitting',
  'Stitching', 'Embroidering', 'Folding paper', 'Whittling', 'Foraging', 'Nesting', 'Fluttering',
  'Burrowing', 'Rummaging', 'Leafing through', 'Underlining', 'Dog-earing', 'Margin-noting',
  'Rewinding', 'Re-reading', 'Squinting', 'Tidying', 'Untwisting', 'Lacing up', 'Kindling',
  'Mapping it out', 'Settling in', 'Warming up', 'Getting there', 'Almost there', 'Hmm-ing',
];

/** Seconds between words. */
export const WORD_SECONDS = 8;

/** Coprime with WORDS.length (checked below), so the walk visits every word. */
const STRIDE = 37;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
if (gcd(STRIDE, WORDS.length) !== 1) throw new Error('words.ts: STRIDE must be coprime with the number of words');

let turn: { startedAt: number; start: number } | undefined;
let lastShown = -1;

/** The word for a turn that started at `startedAt`, `secs` seconds in. */
export function turnWord(startedAt: number, secs: number, random: () => number = Math.random): string {
  if (!turn || turn.startedAt !== startedAt) {
    let start = Math.floor(random() * WORDS.length) % WORDS.length;
    if (start === lastShown) start = (start + 1) % WORDS.length;
    turn = { startedAt, start };
  }
  const step = Math.floor(Math.max(0, secs) / WORD_SECONDS);
  const i = (turn.start + step * STRIDE) % WORDS.length;
  lastShown = i;
  return WORDS[i]!;
}
