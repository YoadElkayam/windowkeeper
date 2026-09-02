/**
 * Identifier extraction for re-surfacing.
 *
 * Deterministic, no model. Pulls the tokens a person uses when they refer back
 * to something concrete: file paths, symbols, error codes, issue refs, quoted
 * phrases. Prefer missing a match over a false positive; every false re-surface
 * costs tokens on every call.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // src/auth/session.ts, ./lib/x, packages/core/src
  { name: 'path', re: /(?:\.{0,2}\/)?(?:[\w@-]+\/)+[\w.-]+/g },
  // session.ts, config.yaml, main.py (no directory)
  {
    name: 'file',
    re: /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|json|ya?ml|toml|md|css|scss|html|sql|sh|env|lock|txt|csv)\b/g,
  },
  // `anything in backticks`
  { name: 'code', re: /`([^`\n]{3,120})`/g },
  // "quoted phrase" of 3+ words
  { name: 'quote', re: /"([^"\n]{12,160})"/g },
  // ECONNRESET, ENOENT, RESOURCE_EXHAUSTED, TS2322, E0308, HTTP_429
  { name: 'errcode', re: /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|E[A-Z]{4,}|[A-Z]{1,4}\d{3,5})\b/g },
  // #1234, GH-123, PROJ-456
  { name: 'ref', re: /(?:#\d{2,6}\b|\b[A-Z]{2,8}-\d{1,6}\b)/g },
  // camelCase and PascalCase with at least two humps
  { name: 'symbol', re: /\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b|\b(?:[A-Z][a-z0-9]+){2,}\b/g },
  // snake_case with at least one underscore
  { name: 'symbol', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  // uuids and long hex ids
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{12,40}\b/g },
];

const STOP = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'README',
  'TODO',
  'FIXME',
  'NOTE',
  'true',
  'false',
  'null',
]);

export interface Identifier {
  kind: string;
  value: string;
}

/** Extract identifiers from free text, de-duplicated, in order of appearance. */
export function extractIdentifiers(text: string): Identifier[] {
  const seen = new Set<string>();
  const out: Identifier[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = (m[1] ?? m[0]).trim();
      if (value.length < 4 || STOP.has(value)) continue;
      // Paths need a separator or a dot to count; bare words matched by the path
      // pattern (rare) are dropped here.
      if (name === 'path' && !value.includes('/')) continue;
      const key = normalize(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: name, value });
    }
  }
  return out;
}

/** Lowercase, strip leading ./ so `./src/x.ts` and `src/x.ts` index the same. */
export function normalize(value: string): string {
  return value.replace(/^\.\//, '').toLowerCase();
}
