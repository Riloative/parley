// theme: auto — the OSC 11 answer, COLORFGBG and the fallbacks.
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundFromRgb } from '../../src/term/probe.js';
import { resolveTheme } from '../../src/bootstrap.js';
import { setColorLevel } from '../../src/term/caps.js';

afterEach(() => setColorLevel(undefined));

describe('terminal background detection', () => {
  it('reads rgb: answers with 1 to 4 hex digits per channel', () => {
    expect(backgroundFromRgb('ffff', 'ffff', 'ffff')).toBe('light');
    expect(backgroundFromRgb('0000', '0000', '0000')).toBe('dark');
    expect(backgroundFromRgb('1e1e', '1e1e', '2e2e')).toBe('dark'); // a typical dark scheme
    expect(backgroundFromRgb('fd', 'f6', 'e3')).toBe('light'); // Solarized light, 2 digits
    expect(backgroundFromRgb('0', '2', '3')).toBe('dark'); // 1 digit
    expect(backgroundFromRgb('80', '80', '80')).toBe('dark'); // mid grey reads as dark
  });

  it('theme: auto prefers the terminal answer, then COLORFGBG, then dark; explicit themes win', () => {
    setColorLevel(3);
    expect(resolveTheme('auto', {}, 'light')).toBe('light');
    expect(resolveTheme('auto', { COLORFGBG: '15;0' }, 'light')).toBe('light');
    expect(resolveTheme('auto', { COLORFGBG: '0;15' })).toBe('light');
    expect(resolveTheme('auto', {})).toBe('dark');
    expect(resolveTheme('dark', {}, 'light')).toBe('dark');
    expect(resolveTheme('ansi', {}, 'light')).toBe('ansi');
    // Without true colour, auto stays on the terminal's own palette.
    setColorLevel(1);
    expect(resolveTheme('auto', {}, 'light')).toBe('ansi');
  });
});
