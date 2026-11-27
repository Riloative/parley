// The sources of a reply that used web search: which ones are listed and
// under which number, where their markers sit in the text, and the plain
// form sent to models that cannot take the provider's own data.
//
// Everything in a source comes from the web. These functions clean titles
// and snippets (render/clean.ts); URLs are returned as stored, and whoever
// prints one decides whether it may be a link (linkTarget()).

import { cleanText } from '../render/clean.js';
import type { ContentPart, SourcePart } from '../providers/types.js';

export interface ListedSource {
  n: number;
  url: string;
  title: string;
  snippet?: string;
}

/** Longest title, snippet and query kept from a provider. */
export const MAX_TITLE = 300;
export const MAX_SNIPPET = 500;
export const MAX_QUERY = 300;
/** Sources kept for one reply. */
export const MAX_SOURCES = 200;

const isSource = (p: ContentPart): p is SourcePart => p.type === 'source';

/**
 * The sources shown under a reply, numbered in the order the reply first
 * cites them. Only cited sources are listed; a reply that cites nothing
 * (a provider that only says what it found) lists everything found.
 */
export function listSources(parts: ContentPart[]): ListedSource[] {
  const all = parts.filter(isSource);
  const cited = all.filter((s) => s.cited || s.at !== undefined);
  const out: ListedSource[] = [];
  const byUrl = new Map<string, ListedSource>();
  for (const s of cited.length ? cited : all) {
    const known = byUrl.get(s.url);
    if (known) {
      if (!known.title && s.title) known.title = cleanText(s.title).slice(0, MAX_TITLE);
      if (!known.snippet && s.snippet) known.snippet = cleanText(s.snippet).slice(0, MAX_SNIPPET);
      continue;
    }
    const snippet = s.snippet ? cleanText(s.snippet).slice(0, MAX_SNIPPET) : '';
    const item: ListedSource = { n: out.length + 1, url: s.url, title: cleanText(s.title).slice(0, MAX_TITLE), ...(snippet ? { snippet } : {}) };
    byUrl.set(s.url, item);
    out.push(item);
  }
  return out;
}

/**
 * The reply's text with a marker such as " [1]" after each cited passage.
 * Markers are for display only: the stored text stays what the model wrote.
 *
 * While a reply streams, a new marker always sits at the end of the text
 * received so far (the session sets `at` that way), so this text only ever
 * grows at its end and the streaming renderer never has to change a line it
 * has already printed.
 */
export function displayText(text: string, parts: ContentPart[]): string {
  const marks = parts.filter((p): p is SourcePart => p.type === 'source' && p.at !== undefined);
  if (!marks.length) return text;
  const numbers = new Map(listSources(parts).map((s) => [s.url, s.n]));
  const at = new Map<number, number[]>();
  for (const m of marks) {
    const n = numbers.get(m.url);
    if (n === undefined) continue;
    const pos = Math.max(0, Math.min(text.length, Math.floor(m.at!)));
    const list = at.get(pos) ?? [];
    if (!list.includes(n)) list.push(n);
    at.set(pos, list);
  }
  let out = '';
  let from = 0;
  for (const pos of [...at.keys()].sort((a, b) => a - b)) {
    out += text.slice(from, pos) + ' ' + at.get(pos)!.map((n) => `[${n}]`).join('');
    from = pos;
  }
  return out + text.slice(from);
}

/**
 * Where a marker may go in text that is still streaming: at its end, unless
 * that would put the marker on a line of its own (the text ends with white
 * space) or inside a code block. `undefined`: list the source without a
 * marker.
 */
export function markerOffset(text: string): number | undefined {
  if (!text || /\s$/.test(text)) return undefined;
  const fences = text.match(/^ {0,3}(```|~~~)/gm);
  if (fences && fences.length % 2 === 1) return undefined;
  return text.length;
}

/** The site a URL really points to, for display next to a title a page
 * chose itself. Punycode stays as it is, so look-alike letters show. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sources as plain text, for a model that did not run the search itself
 * (another provider or model) and for `taria -p --sources`.
 */
export function plainSources(parts: ContentPart[], max = 10): string {
  const list = listSources(parts)
    .filter((s) => /^https?:\/\//i.test(s.url) && !/[\x00-\x20\x7f-\x9f]/.test(s.url))
    .slice(0, max);
  if (!list.length) return '';
  return ['Sources:', ...list.map((s) => `${s.n}. ${s.title ? `${s.title}: ` : ''}${s.url}`)].join('\n');
}
