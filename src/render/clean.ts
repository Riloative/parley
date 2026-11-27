// Text that did not come from the user (a model, a web page, a file name)
// made safe for a single line of the terminal.

/** Invisible characters that reorder or hide text: bidirectional marks,
 * embeddings, overrides and isolates, zero-width space, word joiner,
 * invisible operators, soft hyphen, byte-order mark. The zero-width joiner
 * and non-joiner stay: emoji sequences and several scripts need them. */
const INVISIBLE = new RegExp('[\\u00ad\\u061c\\u180e\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\ufff9-\\ufffb]', 'g');
const BREAKS = new RegExp('[\\r\\n\\t\\u2028\\u2029]+', 'g');
const CONTROLS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'g');

/**
 * One line of plain text: line breaks and tabs become spaces; control
 * characters (so no escape sequence survives) and the invisible characters
 * above are removed.
 */
export function cleanText(s: string): string {
  return s.replace(BREAKS, ' ').replace(CONTROLS, '').replace(INVISIBLE, '').trim();
}
