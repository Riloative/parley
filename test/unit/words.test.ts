// The words on the spinner line while taria waits and writes (0.5.0): a
// long list, a fresh word each turn, a new one every 8 seconds, never the
// same word twice in a row.
import { describe, expect, it } from 'vitest';
import { WORDS, WORD_SECONDS, turnWord } from '../../src/ui/words.js';

describe('the spinner words', () => {
  it('60 to 100 different words, each short enough for the spinner line', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(60);
    expect(WORDS.length).toBeLessThanOrEqual(100);
    expect(new Set(WORDS).size).toBe(WORDS.length);
    for (const w of WORDS) {
      expect(w.length).toBeLessThanOrEqual(24);
      expect(w).toMatch(/^[A-Z][a-z' -]+$/);
    }
  });

  it('changes every 8 seconds, never to the same word, and goes through every word before repeating one', () => {
    expect(WORD_SECONDS).toBe(8);
    const seen: string[] = [];
    for (let s = 0; s < WORD_SECONDS * WORDS.length; s++) {
      const w = turnWord(1000, s);
      if (s % WORD_SECONDS) expect(w).toBe(seen.at(-1));
      else {
        if (seen.length) expect(w).not.toBe(seen.at(-1));
        seen.push(w);
      }
    }
    expect(new Set(seen).size).toBe(WORDS.length);
  });

  it('each turn starts on a fresh word: never the one the last turn ended on', () => {
    for (let t = 0; t < 500; t++) {
      const prev = turnWord(10_000 + t * 2, 0);
      // A random source that would pick the same word again.
      const next = turnWord(10_000 + t * 2 + 1, 0, () => WORDS.indexOf(prev) / WORDS.length);
      expect(next).not.toBe(prev);
    }
  });
});
