import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import type { StreamState } from '../core/session.js';
import { formatTokens } from '../core/usage.js';
import { themeHex } from '../render/theme.js';
import { unicodeOk } from '../term/caps.js';
import { truncate } from '../render/width.js';
import { turnWord } from './words.js';

const FRAMES_UNICODE = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
const FRAMES_ASCII = ['-', '\\', '|', '/'];
export const FRAMES = unicodeOk() ? FRAMES_UNICODE : FRAMES_ASCII;
/** The glyph shown when motion is reduced. */
export const STILL_FRAME = unicodeOk() ? '✻' : '*';

export interface SpinnerProps {
  stream: StreamState | null;
  busyLabel?: string;
  cols: number;
  /** Reduced motion: no animation, and the label does not rotate. The
   * elapsed time still counts, once a second. */
  still?: boolean;
}

/** The animated status line shown while waiting for or streaming a reply. */
export function Spinner({ stream, busyLabel, cols, still }: SpinnerProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  const active = !!stream || !!busyLabel;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      setNow(Date.now());
    }, still ? 1000 : 120);
    return () => clearInterval(t);
  }, [active, still]);
  if (!active) return null;
  const accent = themeHex('accent');
  const dim = themeHex('dim');
  const glyph = still ? STILL_FRAME : FRAMES[frame]!;
  if (!stream) {
    return (
      <Text>
        <Text color={accent}>{glyph} </Text>
        <Text color={accent}>{busyLabel}…</Text>
        <Text color={dim}> (esc to cancel)</Text>
      </Text>
    );
  }
  const secs = Math.floor((now - stream.startedAt) / 1000);
  let label: string;
  const detail: string[] = [`${secs}s`];
  switch (stream.status) {
    case 'connecting':
      label = 'Connecting';
      if (stream.endpoint) detail.push(stream.endpoint.replace(/^https?:\/\//, ''));
      break;
    case 'waiting':
      label = still ? 'Thinking' : turnWord(stream.startedAt, secs);
      // Long waits say so in the grey part; the word stays.
      if (secs >= 15) detail.push(/localhost|127\.0\.0\.1|\.local/.test(stream.endpoint) ? 'the model may still be loading' : 'waiting for the first token');
      break;
    case 'retrying': {
      const r = stream.retry;
      const left = r ? Math.max(0, Math.ceil((r.until - now) / 1000)) : 0;
      label = `Retrying in ${left}s`;
      if (r) detail.splice(0, 1, `attempt ${r.attempt}/${r.max}`, truncate(r.reason, 60));
      break;
    }
    default:
      label = stream.reasoning && !stream.text ? 'Thinking' : still ? 'Writing' : turnWord(stream.startedAt, secs);
  }
  if (stream.outputTokens > 0 && stream.status !== 'retrying') detail.push(`↓ ${formatTokens(stream.outputTokens)} tokens`);
  detail.push(stream.status === 'retrying' ? 'esc to cancel' : 'esc to interrupt');
  const text = `${label}… (${detail.join(' · ')})`;
  return (
    <Text wrap="truncate-end">
      <Text color={accent}>{glyph} </Text>
      <Text color={accent}>{label}…</Text>
      <Text color={dim}>{truncate(text.slice(label.length + 1), Math.max(0, cols - label.length - 4))}</Text>
    </Text>
  );
}
