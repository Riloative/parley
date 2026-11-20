// Token estimates, context-window accounting and cost tracking.

import type { Price } from '../config/config.js';
import type { ContentPart, Usage } from '../providers/types.js';

/** Rough token estimate (~4 characters per token, images ~1,500). */
export function estimateTokens(parts: ContentPart[] | string): number {
  if (typeof parts === 'string') return Math.ceil(parts.length / 4);
  let n = 0;
  for (const p of parts) {
    if (p.type === 'text') n += Math.ceil(p.text.length / 4);
    else if (p.type === 'file') n += Math.ceil((p.text.length + p.name.length + 30) / 4);
    else if (p.type === 'image') n += 1500;
    else if (p.type === 'reasoning') n += Math.ceil(p.text.length / 4);
  }
  return n + 4;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface ModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimated: boolean;
}

export class CostTracker {
  readonly byModel = new Map<string, ModelUsage>();

  add(model: string, u: Usage | undefined, estimatedOutput: number, estimatedInput: number): void {
    const cur = this.byModel.get(model) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false };
    cur.requests++;
    cur.inputTokens += u?.inputTokens ?? estimatedInput;
    cur.outputTokens += u?.outputTokens ?? estimatedOutput;
    cur.cacheReadTokens += u?.cacheReadTokens ?? 0;
    cur.cacheWriteTokens += u?.cacheWriteTokens ?? 0;
    if (u?.inputTokens === undefined || u?.outputTokens === undefined) cur.estimated = true;
    this.byModel.set(model, cur);
  }
}

export function priceFor(prices: Record<string, Price>, model: string): Price | undefined {
  if (prices[model]) return prices[model];
  const provider = model.split('/')[0];
  return prices[`${provider}/*`];
}

/** Cost in US dollars, or undefined when no price is configured. */
export function costOf(u: ModelUsage, price: Price | undefined): number | undefined {
  if (!price) return undefined;
  const M = 1_000_000;
  return (
    (u.inputTokens * price.input) / M +
    (u.outputTokens * price.output) / M +
    (u.cacheReadTokens * (price.cacheRead ?? price.input * 0.1)) / M +
    (u.cacheWriteTokens * (price.cacheWrite ?? price.input * 1.25)) / M
  );
}
