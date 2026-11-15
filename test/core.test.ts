import { describe, expect, it } from 'vitest';
import { analyze, infraHint, mask, parseLog } from '../src/index.js';

/** A GitHub Actions job log: timestamped lines, `##[group]Run` per step. */
function ghLog(
  steps: Record<string, string[]>,
  error = 'Process completed with exit code 1.',
): string {
  const out: string[] = [];
  let t = 0;
  const ts = () => `2026-11-15T10:00:${String(t++ % 60).padStart(2, '0')}.1234567Z `;
  for (const [step, lines] of Object.entries(steps)) {
    out.push(`${ts()}##[group]Run ${step}`, `${ts()}${step}`, `${ts()}##[endgroup]`);
    for (const l of lines) out.push(ts() + l);
  }
  if (error) out.push(`${ts()}##[error]${error}`);
  return out.join('\n');
}

describe('parseLog', () => {
  it('strips timestamps and colors, and tracks the step', () => {
    const lines = parseLog(
      '2026-11-15T10:00:00.1Z ##[group]Run npm test\n2026-11-15T10:00:01.1Z \u001b[31mFAIL\u001b[0m a.test.ts',
    );
    expect(lines[1]).toEqual({ n: 2, step: 'npm test', text: 'FAIL a.test.ts' });
  });

  it('reads plain logs as one step', () => {
    expect(parseLog('a\nb').map((l) => l.step)).toEqual(['log', 'log']);
  });
});

describe('mask', () => {
  it('makes the same line with different values equal', () => {
    expect(mask('Downloaded 12.4 MB in 812ms from /tmp/abc123/pkg (run 4f9c2e1a)')).toBe(
      mask('Downloaded 9.1 MB in 1200ms from /tmp/zz9/pkg (run 0b7d33aa)'),
    );
  });

  it('keeps the words that matter', () => {
    expect(mask('ruff format....................Passed')).not.toBe(
      mask('ruff format....................Failed'),
    );
  });
});

describe('analyze', () => {
  const passing = ghLog(
    {
      'npm ci': ['added 812 packages in 14s', 'npm warn deprecated glob@7.2.3'],
      'npm test': [
        '✓ src/a.test.ts (3 tests) 12ms',
        '✓ src/b.test.ts (5 tests) 30ms',
        'Tests 8 passed (8)',
      ],
    },
    '',
  );
  const failing = ghLog({
    'npm ci': ['added 812 packages in 19s', 'npm warn deprecated glob@7.2.3'],
    'npm test': [
      '✓ src/a.test.ts (3 tests) 15ms',
      'FAIL src/b.test.ts > applies coupon',
      'AssertionError: expected 100 to be 90',
      ' ❯ src/b.test.ts:41:18',
      'Tests 1 failed | 7 passed (8)',
    ],
  });

  it('shows only what is new since the passing run, and the step it failed in', () => {
    const a = analyze(failing, passing);
    const shown = a.blocks.flatMap((b) => b.lines.filter((l) => !l.context).map((l) => l.text));
    expect(a.failingStep).toBe('npm test');
    expect(shown).toContain('FAIL src/b.test.ts > applies coupon');
    expect(shown).toContain('AssertionError: expected 100 to be 90');
    // Same lines with different numbers aren't new.
    expect(shown.join('\n')).not.toMatch(/added \d+ packages|a\.test\.ts \(3 tests\)|deprecated/);
    expect(a.compared).toBe(true);
    expect(a.infra).toBeUndefined();
  });

  it('puts the failure first and stays within the budget', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `debug: cache entry ${i * 7919} miss`);
    const big = ghLog({ build: noise, 'npm test': ['FAIL x.test.ts', 'Error: boom'] });
    const a = analyze(big, ghLog({ build: [], 'npm test': [] }, ''), { maxLines: 10 });
    expect(a.shownLines).toBeLessThanOrEqual(10);
    expect(a.blocks[0].lines.map((l) => l.text)).toContain('FAIL x.test.ts');
  });

  it('counts a repeated block once', () => {
    const repeated = ghLog({
      'npm test': [
        'FAIL a.test.ts',
        'Error: nope',
        'ok 1',
        'ok 2',
        'ok 3',
        'Summary:',
        'FAIL a.test.ts',
        'Error: nope',
      ],
    });
    const a = analyze(repeated, ghLog({ 'npm test': ['ok 1', 'ok 2', 'ok 3', 'Summary:'] }, ''));
    expect(a.blocks.filter((b) => b.lines.some((l) => l.text === 'Error: nope'))).toHaveLength(1);
    expect(a.blocks[0].repeats).toBe(1);
  });

  it('without a passing run, falls back to the failing step', () => {
    const a = analyze(failing);
    expect(a.compared).toBe(false);
    expect(a.blocks.flatMap((b) => b.lines).every((l) => l.step === 'npm test')).toBe(true);
  });

  it('recognises infrastructure failures', () => {
    const net = ghLog({
      'npm ci': [
        'npm ERR! code ENOTFOUND',
        'npm ERR! request to https://registry.npmjs.org failed',
      ],
    });
    expect(analyze(net, ghLog({ 'npm ci': [] }, '')).infra?.kind).toBe('DNS lookup failed');
  });
});

describe('infraHint', () => {
  it('is quiet for code failures', () => {
    expect(
      infraHint(['AssertionError: expected 1 to be 2', 'Error: Cannot find module ./x']),
    ).toBeUndefined();
  });
  it.each([
    ['Unexpected HTTP response: 504', 'a server returned 5xx'],
    [
      '##[error]Unable to download artifact(s): Artifact not found for name: coverage',
      'an artifact was missing or could not be uploaded',
    ],
    ['Error: No space left on device', 'the runner ran out of disk'],
  ])('%s', (line, kind) => expect(infraHint([line])?.kind).toBe(kind));
});
