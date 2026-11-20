// Small fuzzy matcher: subsequence match with bonuses for contiguous runs,
// word starts and prefix matches. Returns null when there is no match.

export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 800 - idx - t.length / 10;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === prev + 1) score += 15;
    const before = found > 0 ? t[found - 1]! : ' ';
    if (/[\s/_\-.:]/.test(before)) score += 10;
    score -= Math.min(found - ti, 10);
    prev = found;
    ti = found + 1;
  }
  return score;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(query.trim(), text(item));
    if (s !== null) scored.push({ item, score: s, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.item);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}
