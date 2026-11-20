// Syntax highlighting via highlight.js, loaded lazily (it is the single
// heaviest dependency). Until it has loaded, callers get `null` and render
// code unhighlighted; the streaming renderer holds code blocks back from the
// permanent transcript until the highlighter is ready, so finished output is
// never "stuck" without colour.

import type { ColorToken } from './theme.js';
import type { Line, Span } from './style.js';

interface Hljs {
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
  getLanguage(name: string): unknown;
}

let hljs: Hljs | undefined;
let loading: Promise<void> | undefined;

export function isHighlighterReady(): boolean {
  return hljs !== undefined;
}

export function loadHighlighter(): Promise<void> {
  loading ??= import('highlight.js/lib/common')
    .then((m) => {
      hljs = ((m as { default?: Hljs }).default ?? m) as Hljs;
    })
    .catch(() => {
      // Highlighting is optional; never fail rendering because of it.
      hljs = undefined;
    });
  return loading;
}

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  golang: 'go',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  jsonc: 'json',
  json5: 'json',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  tf: 'ini',
  toml: 'ini',
};

export function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const l = lang.trim().split(/[\s{]/)[0]!.toLowerCase();
  return ALIASES[l] ?? l;
}

function tokenFor(cls: string): ColorToken | undefined {
  const c = cls.replace(/^hljs-/, '').split(/\s+/)[0]!;
  switch (c) {
    case 'keyword':
    case 'selector-tag':
    case 'doctag':
    case 'literal':
      return 'syn.keyword';
    case 'string':
    case 'regexp':
    case 'char':
    case 'selector-attr':
    case 'template-tag':
      return 'syn.string';
    case 'number':
    case 'symbol':
    case 'bullet':
      return 'syn.number';
    case 'comment':
    case 'quote':
      return 'syn.comment';
    case 'title':
    case 'section':
    case 'selector-id':
      return 'syn.function';
    case 'type':
    case 'built_in':
    case 'class':
    case 'selector-class':
      return 'syn.type';
    case 'variable':
    case 'template-variable':
    case 'attr':
    case 'attribute':
    case 'property':
    case 'params':
    case 'name':
      return 'syn.variable';
    case 'meta':
    case 'tag':
    case 'link':
    case 'subst':
      return 'syn.meta';
    case 'punctuation':
    case 'operator':
      return 'syn.punct';
    case 'deletion':
      return 'syn.deleted';
    case 'addition':
      return 'syn.inserted';
    default:
      return undefined;
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** Convert highlight.js HTML output into styled lines. */
export function htmlToLines(html: string): Line[] {
  const lines: Line[] = [[]];
  const stack: Array<ColorToken | undefined> = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const t = tokenFor(m[1]);
      stack.push(t ?? stack[stack.length - 1]);
    } else if (m[0] === '</span>') {
      stack.pop();
    } else if (m[2] !== undefined) {
      const text = decode(m[2]);
      const fg = stack[stack.length - 1];
      const parts = text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) lines.push([]);
        if (p) lines[lines.length - 1]!.push(fg ? ({ text: p, style: { fg } } as Span) : { text: p });
      });
    }
  }
  return lines;
}

/**
 * Highlight code. Returns null when the highlighter is not loaded yet or the
 * language is unknown (callers render plain text). Uses the language named in
 * the fence; never guesses, so output is stable while streaming.
 */
export function highlight(code: string, lang: string | undefined): Line[] | null {
  if (!hljs) return null;
  const l = normalizeLang(lang);
  if (!l || !hljs.getLanguage(l)) return null;
  try {
    return htmlToLines(hljs.highlight(code, { language: l, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}
