// Rendering of transcript items to ANSI strings. Every item is rendered once
// for a given width and written to the terminal's scrollback via <Static>.

import type { StoredMessage } from '../core/conversation.js';
import type { TurnStats, Tone } from '../core/session.js';
import { formatTokens } from '../core/usage.js';
import { renderMarkdown } from '../render/markdown.js';
import { lineToAnsi, type Line, type Span, type Style } from '../render/style.js';
import { padEnd, textWidth, truncate, wrapSpans } from '../render/width.js';
import { unicodeOk } from '../term/caps.js';

export const GLYPH = unicodeOk() ? '◆' : '*';
export const BULLET = unicodeOk() ? '●' : '*';
export const ELBOW = unicodeOk() ? '⎿' : '`-';
export const APP_NAME = 'parley';

const DIM: Style = { fg: 'dim' };

export type Item =
  | { kind: 'welcome'; key: string; model: string; hint: string; notes: Array<{ text: string; tone: Tone }> }
  | { kind: 'user'; key: string; message: StoredMessage }
  | { kind: 'chunk'; key: string; lines: Line[]; first: boolean }
  | { kind: 'assistant'; key: string; message: StoredMessage; showThinking: boolean }
  | { kind: 'thought'; key: string; ms: number; text?: string }
  | { kind: 'stats'; key: string; stats: TurnStats }
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

export function welcomeBox(cols: number, model: string, hint: string): string {
  const inner = Math.max(20, Math.min(cols, 72) - 2);
  const b: Style = { fg: 'accent' };
  const row = (spans: Span[]): string => {
    const w = spans.reduce((a, s) => a + textWidth(s.text), 0);
    const pad = Math.max(0, inner - 2 - w);
    return lineToAnsi([{ text: '│ ', style: b }, ...spans, { text: ' '.repeat(pad) + ' │', style: b }]);
  };
  const fit = (s: string, extra = 0) => truncate(s, inner - 2 - extra);
  return [
    lineToAnsi([{ text: `╭${'─'.repeat(inner)}╮`, style: b }]),
    row([{ text: `${GLYPH} `, style: { fg: 'accent' } }, { text: 'Welcome to ', style: {} }, { text: APP_NAME, style: { bold: true } }]),
    row([]),
    row([{ text: fit(`  model: ${model}`), style: DIM }]),
    row([{ text: fit(`  ${hint}`), style: DIM }]),
    lineToAnsi([{ text: `╰${'─'.repeat(inner)}╯`, style: b }]),
  ].join('\n');
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
  return lineToAnsi([{ text: parts.join(' · '), style: DIM }]).replace(/^/, '  ');
}

function assistantBody(m: StoredMessage, cols: number): string {
  const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  if (!text.trim()) return '';
  const lines = renderMarkdown(text, { width: contentWidth(cols), numberCode: true });
  return prefixLines(lines, [{ text: `${BULLET} ` }]);
}

export function renderItem(item: Item, cols: number): string {
  switch (item.kind) {
    case 'welcome': {
      const box = welcomeBox(cols, item.model, item.hint);
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
      if (item.message.interrupted) out.push(outcomeLine('Interrupted', 'error'));
      else if (item.message.error) out.push(outcomeLine(item.message.error, 'error', cols));
      return out.join('\n');
    }
    case 'thought':
      return '\n' + thoughtLine(item.ms, item.text, cols);
    case 'stats':
      return statsLine(item.stats);
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
