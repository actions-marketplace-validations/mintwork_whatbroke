#!/usr/bin/env node
// Benchmark: real failed GitHub Actions jobs, each with the last passing run of the same job and
// a hand-written regex for the line that explains the failure (written before any diff ran).
//
//   npm run bench [-- <dir>]      default dir: ../whatbroke-experiment (logs/, truth.json)
//
// For every job: is the explaining line among the lines whatbroke shows? Compared with reading
// the last N lines, which is what people and agents usually do.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, isNoise, parseLog } from '../dist/index.js';

const dir = process.argv[2] ?? join(import.meta.dirname, '..', 'bench', 'tuning');
const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
const MAX = 40;

const rows = [];
let tokensFull = 0;
let tokensShown = 0;
const started = performance.now();
for (const [id, [kind, pattern]] of Object.entries(truth)) {
  const rx = new RegExp(pattern);
  const failed = parseLog(readFileSync(join(dir, 'logs', `${id}-bad.log`), 'utf8'));
  const passing = parseLog(readFileSync(join(dir, 'logs', `${id}-good.log`), 'utf8'));
  const a = analyze(failed, passing, { maxLines: MAX });
  const shown = a.blocks.flatMap((b) => b.lines.map((l) => l.text));
  const tail = failed
    .filter((l) => !isNoise(l))
    .slice(-MAX)
    .map((l) => l.text);
  tokensFull += failed.reduce((n, l) => n + l.text.length + 1, 0);
  tokensShown += shown.reduce((n, t) => n + t.length + 1, 0);
  rows.push({
    id,
    kind,
    total: a.totalLines,
    fresh: a.newLines,
    shown: a.shownLines,
    hit: shown.some((t) => rx.test(t)),
    tail: tail.some((t) => rx.test(t)),
    annot: failed.some((l) => l.text.startsWith('##[error]') && rx.test(l.text)),
    infra: a.infra?.kind ?? '',
  });
}
const ms = performance.now() - started;

const yes = (b) => (b ? 'yes' : ' NO');
console.log('id  kind   lines    new  shown  found  tail   infra');
for (const r of rows)
  console.log(
    `${r.id}  ${r.kind.padEnd(5)} ${String(r.total).padStart(6)} ${String(r.fresh).padStart(6)} ${String(r.shown).padStart(6)}   ${yes(r.hit)}   ${yes(r.tail)}   ${r.infra}`,
  );
const sum = (sel, label) => {
  const hit = sel.filter((r) => r.hit).length;
  const tail = sel.filter((r) => r.tail).length;
  const annot = sel.filter((r) => r.annot).length;
  console.log(
    `${label.padEnd(14)} ${hit}/${sel.length} found in whatbroke's ${MAX} lines, ${tail}/${sel.length} in the last ${MAX} lines, ${annot}/${sel.length} in ##[error]`,
  );
};
console.log();
sum(rows, 'all');
sum(
  rows.filter((r) => r.kind === 'code'),
  'code failures',
);
sum(
  rows.filter((r) => r.kind !== 'code'),
  'infra + flaky',
);
const infraRows = rows.filter((r) => r.kind === 'infra');
const flagged = infraRows.filter((r) => r.infra).length;
const falseFlags = rows.filter((r) => r.kind === 'code' && r.infra).length;
console.log(
  `infra flagged  ${flagged}/${infraRows.length} infrastructure failures; ${falseFlags} code failures wrongly flagged`,
);
console.log(
  `tokens         ${Math.round(tokensShown / 4).toLocaleString()} shown vs ${Math.round(tokensFull / 4).toLocaleString()} in the full logs (${((100 * tokensShown) / tokensFull).toFixed(1)}%)`,
);
console.log(`time           ${Math.round(ms)} ms for ${rows.length} jobs`);
