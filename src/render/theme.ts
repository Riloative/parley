// Themes. A deliberately small palette: one warm accent used sparingly, one
// dim grey, red/green for errors/confirmations, and a syntax palette for code.

export type ColorToken =
  | 'accent'
  | 'dim'
  | 'error'
  | 'success'
  | 'warning'
  | 'code'
  | 'link'
  | 'border'
  | 'suggestion'
  | 'syn.keyword'
  | 'syn.string'
  | 'syn.number'
  | 'syn.comment'
  | 'syn.function'
  | 'syn.type'
  | 'syn.variable'
  | 'syn.meta'
  | 'syn.punct'
  | 'syn.deleted'
  | 'syn.inserted';

export type ThemeName = 'dark' | 'light' | 'ansi';

export interface Theme {
  name: ThemeName;
  /** Hex colours, or fixed SGR codes (numbers) for the ANSI-16 theme. */
  colors: Record<ColorToken, string | number>;
}

const dark: Theme = {
  name: 'dark',
  colors: {
    accent: '#D97757',
    dim: '#8A8A8A',
    error: '#FF6B80',
    success: '#4EBA65',
    warning: '#FFC107',
    code: '#B1B9F9',
    link: '#7AB4E8',
    border: '#6B6B6B',
    suggestion: '#B1B9F9',
    'syn.keyword': '#C792EA',
    'syn.string': '#A5D6A7',
    'syn.number': '#F78C6C',
    'syn.comment': '#7A7F8C',
    'syn.function': '#82AAFF',
    'syn.type': '#FFCB6B',
    'syn.variable': '#F07178',
    'syn.meta': '#89DDFF',
    'syn.punct': '#BFC7D5',
    'syn.deleted': '#FF6B80',
    'syn.inserted': '#4EBA65',
  },
};

const light: Theme = {
  name: 'light',
  colors: {
    accent: '#C15F3C',
    dim: '#6F6F6F',
    error: '#C62828',
    success: '#2E7D32',
    warning: '#A66B00',
    code: '#4B5BD6',
    link: '#1A5FB4',
    border: '#9E9E9E',
    suggestion: '#4B5BD6',
    'syn.keyword': '#8E24AA',
    'syn.string': '#2E7D32',
    'syn.number': '#C2410C',
    'syn.comment': '#6A737D',
    'syn.function': '#1565C0',
    'syn.type': '#9A6700',
    'syn.variable': '#B3261E',
    'syn.meta': '#00838F',
    'syn.punct': '#424242',
    'syn.deleted': '#C62828',
    'syn.inserted': '#2E7D32',
  },
};

// ANSI-16: uses only the terminal's own palette so it matches any scheme.
const ansi: Theme = {
  name: 'ansi',
  colors: {
    accent: 33,
    dim: 90,
    error: 31,
    success: 32,
    warning: 33,
    code: 34,
    link: 36,
    border: 90,
    suggestion: 34,
    'syn.keyword': 35,
    'syn.string': 32,
    'syn.number': 33,
    'syn.comment': 90,
    'syn.function': 34,
    'syn.type': 33,
    'syn.variable': 31,
    'syn.meta': 36,
    'syn.punct': 39,
    'syn.deleted': 31,
    'syn.inserted': 32,
  },
};

export const THEMES: Record<ThemeName, Theme> = { dark, light, ansi };

let current: Theme = dark;

export function getTheme(): Theme {
  return current;
}

export function setTheme(name: ThemeName): void {
  current = THEMES[name];
}

const ANSI_NAMES: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'gray',
  91: 'redBright',
  92: 'greenBright',
  93: 'yellowBright',
  94: 'blueBright',
  95: 'magentaBright',
  96: 'cyanBright',
  97: 'whiteBright',
};

let colorsEnabled = () => true;

/** Lets the terminal layer switch colour off (NO_COLOR, non-TTY). */
export function setColorsEnabled(fn: () => boolean): void {
  colorsEnabled = fn;
}

/** Colour of a token for Ink's `color` props: a hex value, an ANSI colour
 * name for the 16-colour theme, or undefined when colour is disabled. */
export function themeHex(token: ColorToken): string | undefined {
  if (!colorsEnabled()) return undefined;
  const v = current.colors[token];
  if (typeof v === 'number') return ANSI_NAMES[v];
  return v;
}
