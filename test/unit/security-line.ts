// What `security -i` does with a line on its standard input, for the fake
// keychains in the tests: words are split on spaces, double quotes group a
// word, and a backslash inside them makes the next character literal.
export function securityWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let open = false;
  let quoted = false;
  const s = line.replace(/\n$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') {
      quoted = true;
      open = true;
    } else if (c === ' ') {
      if (open || cur) words.push(cur);
      cur = '';
      open = false;
    } else cur += c;
  }
  if (open || cur) words.push(cur);
  return words;
}
