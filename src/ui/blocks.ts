// Rendering of transcript items to ANSI strings. Every item is rendered once
// for a given width and written to the terminal's scrollback via <Static>.

import type { StoredMessage } from '../core/conversation.js';
import type { TurnStats, Tone } from '../core/session.js';
import { formatTokens } from '../core/usage.js';
import { displayText, hostOf, listSources } from '../core/sources.js';
import { cleanText } from '../render/clean.js';
import type { ContentPart } from '../providers/types.js';
import { renderMarkdown } from '../render/markdown.js';
import { lineToAnsi, type Line, type Span, type Style } from '../render/style.js';
import { padEnd, textWidth, truncate, wrapSpans } from '../render/width.js';
import { hyperlinksEnabled, linkTarget, unicodeOk } from '../term/caps.js';
import { welcomeBox, type WelcomeInfo } from './welcome.js';

export const GLYPH = unicodeOk() ? '◆' : '*';
export const BULLET = unicodeOk() ? '●' : '*';
export const ELBOW = unicodeOk() ? '⎿' : '`-';
export const APP_NAME = 'taria';

const DIM: Style = { fg: 'dim' };

export type Item =
  | { kind: 'welcome'; key: string; info: WelcomeInfo; notes: Array<{ text: string; tone: Tone }> }
  | { kind: 'user'; key: string; message: StoredMessage }
  | { kind: 'chunk'; key: string; lines: Line[]; first: boolean }
  | { kind: 'assistant'; key: string; message: StoredMessage; showThinking: boolean }
  | { kind: 'thought'; key: string; ms: number; text?: string }
  | { kind: 'stats'; key: string; stats: TurnStats }
  /** The sources (and failed searches) of a reply that just streamed. */
  | { kind: 'sources'; key: string; parts: ContentPart[]; expanded: boolean }
  | { kind: 'outcome'; key: string; text: string; tone: Tone }
  | { kind: 'notice'; key: string; text: string; tone: Tone }
  | { kind: 'summary'; key: string; message: StoredMessage }
  | { kind: 'info'; key: string; markdown: string }
  | { kind: 'spacer'; key: string };

export const toneStyle = (t: Tone): Style =>
  t === 'error' ? { fg: 'error' } : t === 'success' ? { fg: 'success' } : t === 'warning' ? { fg: 'warning' } : DIM;

/** Width of message content (after the 2-cell bullet/indent). */
export const contentWidth = (cols: number): number => Math.max(10, cols - 2);

function prefixLines(lines: Line[], first: Span[] | null): string {
  return lines
    .map((l, i) => lineToAnsi([...(i === 0 && first ? first : [{ text: '  ' }]), ...l]))
    .join('\n');
}

export function userBlock(m: StoredMessage, cols: number): string {
  const text = m.display ?? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const lines = wrapSpans([{ text: text.replace(/\s+$/, ''), style: DIM }], cols, { firstPrefix: [{ text: '> ', style: DIM }], restPrefix: [{ text: '  ' }] });
  const att = m.content.filter((p) => p.type === 'image' || p.type === 'file');
  if (att.length && !/\[(Image|File) #\d+/.test(text)) {
    let i = 0;
    for (const p of att) {
      i++;
      const label = p.type === 'image' ? `[Image #${i}${p.name ? `: ${p.name}` : ''}]` : `[File: ${(p as { name: string }).name}]`;
      lines.push([{ text: `  ${ELBOW}  `, style: DIM }, { text: truncate(label, cols - 6), style: DIM }]);
    }
  }
  return lines.map(lineToAnsi).join('\n');
}

export function thoughtLine(ms: number, expandedText?: string, cols = 80): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  const head = lineToAnsi([
    { text: '✻ ', style: DIM },
    { text: `Thought for ${secs}s`, style: { fg: 'dim', italic: true } },
    ...(expandedText === undefined ? [{ text: ' (ctrl+o to expand)', style: DIM }] : []),
  ]);
  if (expandedText === undefined) return head;
  const body = wrapSpans([{ text: expandedText.trim(), style: { fg: 'dim', italic: true } }], contentWidth(cols));
  return [head, prefixLines(body, null)].join('\n');
}

export function statsLine(s: TurnStats): string {
  const secs = s.durationMs / 1000;
  const parts = [`${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`, `${formatTokens(s.outputTokens)} tokens`];
  if (s.tokensPerSecond !== undefined) parts.push(`${s.tokensPerSecond.toFixed(s.tokensPerSecond < 10 ? 1 : 0)} tok/s`);
  if (s.searches) parts.push(`${s.searches} search${s.searches === 1 ? '' : 'es'}`);
  return lineToAnsi([{ text: parts.join(' · '), style: DIM }]).replace(/^/, '  ');
}

function assistantBody(m: StoredMessage, cols: number): string {
  const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  if (!text.trim()) return '';
  const lines = renderMarkdown(displayText(text, m.content), { width: contentWidth(cols), numberCode: true });
  return prefixLines(lines, [{ text: `${BULLET} ` }]);
}

/** The end of a string that is too wide: the part of a host that says whose
 * site it is comes last. */
function truncateStart(s: string, width: number): string {
  if (textWidth(s) <= width) return s;
  let out = '';
  for (const ch of [...s].reverse()) {
    if (textWidth(ch + out) > width - 1) break;
    out = ch + out;
  }
  return `…${out}`;
}

/**
 * The sources of a reply that searched the web: a numbered list (the
 * numbers are the markers in the text), then any search that failed.
 *
 * Titles, URLs and snippets come from the web, so:
 * - each is cleaned to one line of plain text (no control, escape or
 *   direction-changing characters);
 * - every source shows the host its URL really has, whatever its title says;
 * - a URL becomes a link only if linkTarget() accepts it;
 * - every line is cut or wrapped to the width.
 *
 * `expanded` (Ctrl+O) adds the queries, full URLs and quoted text. Where the
 * terminal has no hyperlinks the URL is always shown, cut to one line.
 */
export function sourcesBlock(parts: ContentPart[], cols: number, expanded: boolean): string {
  const width = contentWidth(cols);
  const list = listSources(parts);
  const searches = parts.filter((p): p is Extract<ContentPart, { type: 'search' }> => p.type === 'search');
  const lines: Line[] = [];
  if (list.length) {
    lines.push([{ text: 'Sources', style: { bold: true } }]);
    const numWidth = String(list.length).length;
    const links = hyperlinksEnabled();
    for (const s of list) {
      const num = `${String(s.n).padStart(numWidth)}. `;
      const indent = ' '.repeat(textWidth(num) + 1);
      const room = Math.max(4, width - 1 - textWidth(num));
      const url = cleanText(s.url);
      const target = linkTarget(s.url);
      const host = hostOf(s.url);
      // What the address really is: its host, or (not a web address) the
      // address itself. A title never stands alone.
      const where = truncateStart(host ?? truncate(url, 40), Math.min(room, Math.max(12, Math.floor(room / 2))));
      const titleRoom = room - textWidth(where) - 3;
      const title = cleanText(s.title);
      const href = links && target ? { href: target } : {};
      const line: Span[] = [{ text: ` ${num}`, style: DIM }];
      if (title && titleRoom >= 6) line.push({ text: truncate(title, titleRoom), style: href }, { text: ' · ', style: DIM });
      line.push({ text: where, style: { fg: 'dim', ...href } });
      lines.push(line);
      if (expanded) {
        lines.push(...wrapSpans([{ text: url, style: DIM }], width, { firstPrefix: [{ text: indent }] }));
        if (s.snippet) lines.push(...wrapSpans([{ text: `“${s.snippet}”`, style: { fg: 'dim', italic: true } }], width, { firstPrefix: [{ text: indent }] }));
      } else if (!href.href) {
        lines.push([{ text: indent }, { text: truncate(url, Math.max(4, width - textWidth(indent))), style: DIM }]);
      }
    }
  }
  if (expanded) {
    for (const s of searches) {
      if (!s.query) continue;
      const what = s.status === 'done' ? 'Searched the web' : s.status === 'failed' ? 'Search failed' : 'Search interrupted';
      lines.push(...wrapSpans([{ text: `${what}: ${cleanText(s.query)}`, style: { fg: 'dim', italic: true } }], width));
    }
  }
  const out = lines.length ? [prefixLines(lines, null)] : [];
  for (const s of searches) {
    if (s.status === 'failed') out.push(outcomeLine(`Web search failed${s.error ? `: ${cleanText(s.error)}` : '.'}`, 'warning', cols));
  }
  return out.join('\n');
}

export function renderItem(item: Item, cols: number): string {
  switch (item.kind) {
    case 'welcome': {
      const box = welcomeBox(cols, item.info, unicodeOk());
      const notes = item.notes.map((n) => wrapSpans([{ text: n.text, style: toneStyle(n.tone) }], cols - 2).map((l) => '  ' + lineToAnsi(l)).join('\n'));
      return [box, ...notes].join('\n');
    }
    case 'user':
      return '\n' + userBlock(item.message, cols);
    case 'chunk':
      return (item.first ? '\n' : '') + prefixLines(item.lines, item.first ? [{ text: `${BULLET} ` }] : null);
    case 'assistant': {
      const out: string[] = [];
      const reasoning = item.message.content.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('');
      if (reasoning || item.message.reasoningMs) {
        out.push('\n' + thoughtLine(item.message.reasoningMs ?? 0, item.showThinking ? reasoning : undefined, cols));
      }
      const body = assistantBody(item.message, cols);
      if (body) out.push('\n' + body);
      const sources = sourcesBlock(item.message.content, cols, item.showThinking);
      if (sources) out.push('\n' + sources);
      if (item.message.interrupted) out.push(outcomeLine('Interrupted', 'error'));
      else if (item.message.error) out.push(outcomeLine(item.message.error, 'error', cols));
      return out.join('\n');
    }
    case 'thought':
      return '\n' + thoughtLine(item.ms, item.text, cols);
    case 'stats':
      return statsLine(item.stats);
    case 'sources': {
      const block = sourcesBlock(item.parts, cols, item.expanded);
      return block ? '\n' + block : '';
    }
    case 'outcome':
      return outcomeLine(item.text, item.tone, cols);
    case 'notice': {
      const lines = wrapSpans([{ text: item.text, style: toneStyle(item.tone) }], Math.max(10, cols - 2), { firstPrefix: [{ text: '  ' }] });
      return '\n' + lines.map(lineToAnsi).join('\n');
    }
    case 'summary': {
      const text = item.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const lines = renderMarkdown(text, { width: contentWidth(cols) - 2 });
      return '\n' + lineToAnsi([{ text: '✻ ', style: DIM }, { text: 'Conversation compacted. Summary sent to the model from here on:', style: DIM }]) + '\n' + prefixLines(lines.map((l) => [{ text: '  ' }, ...l]), null);
    }
    case 'info': {
      const lines = renderMarkdown(item.markdown, { width: contentWidth(cols) });
      return '\n' + prefixLines(lines, null);
    }
    case 'spacer':
      return '';
  }
}

export function outcomeLine(text: string, tone: Tone, cols = 80): string {
  const lines = wrapSpans([{ text, style: toneStyle(tone) }], Math.max(10, cols - 5), {
    firstPrefix: [{ text: `  ${ELBOW}  `, style: DIM }],
    restPrefix: [{ text: '     ' }],
  });
  return lines.map(lineToAnsi).join('\n');
}

export { padEnd };
