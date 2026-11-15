// Masking: replace the parts of a line that change from run to run (times, durations, hashes,
// IDs, temp paths, counts), so "the same line with different values" compares equal.
//
// Deliberately pattern-based. Fuzzy log templates (Drain and friends) also merge lines that
// differ in one meaningful word, like `ruff format....Passed` and `ruff format....Failed`,
// which hides exactly the line that matters. In the benchmark that cost 3 of 32 failures.

const MASKS: [RegExp, string][] = [
  [/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/g, '<time>'],
  [/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{7,64}\b/gi, '<hex>'],
  [
    /(?:\/tmp|\/var\/folders|[A-Z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp)[\\/][^\s'"`)\]]+/g,
    '<tmp>',
  ],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|µs|us|ns|[KMGT]i?B|kB|B|%)(?![A-Za-z])/g, '<qty>'],
  [/\d+/g, '<n>'],
];

export function mask(text: string): string {
  let out = text;
  for (const [rx, rep] of MASKS) out = out.replace(rx, rep);
  return out.replace(/\s+/g, ' ').trim();
}
