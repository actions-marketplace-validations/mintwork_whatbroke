// Turning an analysis into text: for a terminal, a PR comment (Markdown), JSON, or a coding agent.
import type { Analysis, Block } from './core/analyze.js';

export interface JobReport {
  name: string;
  url?: string;
  analysis: Analysis;
  /** The passing run compared against, if any. */
  baseline?: { url: string; sha: string; branch: string };
}

export const COMMENT_MARKER = '<!-- whatbroke -->';

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function summaryLine(r: JobReport): string {
  const a = r.analysis;
  const lines = plural(a.totalLines, 'log line');
  if (!a.compared) return `${lines}; no passing run to compare with, so showing the failing step`;
  return `${lines}, ${plural(a.newLines, 'line')} new since the last passing run`;
}

function blockTitle(b: Block): string {
  const first = b.lines[0]?.n;
  const extra = [
    b.repeats ? `repeated ${plural(b.repeats, 'more time')}` : '',
    b.omitted ? `${b.omitted} more lines` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${b.step}, line ${first}${extra ? ` (${extra})` : ''}`;
}

// --- Terminal --------------------------------------------------------------------------------

const color = (on: boolean) => {
  const paint = (code: string) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
  return {
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    yellow: paint('33'),
    cyan: paint('36'),
  };
};

export function formatText(reports: JobReport[], opts: { color?: boolean } = {}): string {
  const c = color(opts.color ?? false);
  const out: string[] = [];
  for (const r of reports) {
    const a = r.analysis;
    out.push(
      '',
      `${c.red('✗')} ${c.bold(r.name)} ${c.dim(`failed${a.failingStep ? ` in "${a.failingStep}"` : ''}`)}`,
    );
    out.push(
      `  ${c.dim(summaryLine(r))}${r.baseline ? c.dim(` (${r.baseline.sha.slice(0, 7)} on ${r.baseline.branch})`) : ''}`,
    );
    if (a.infra) {
      out.push(`  ${c.yellow('!')} Looks like infrastructure: ${a.infra.kind}. ${a.infra.advice}`);
    }
    for (const b of a.blocks) {
      out.push('', `  ${c.cyan(blockTitle(b))}`);
      for (const l of b.lines)
        out.push(`  ${c.dim(String(l.n).padStart(6))}  ${l.context ? c.dim(l.text) : l.text}`);
    }
    if (a.hiddenBlocks)
      out.push(
        '',
        `  ${c.dim(`… ${plural(a.hiddenBlocks, 'more block')} of new lines not shown (raise --lines to see them)`)}`,
      );
    if (r.url) out.push('', `  ${c.dim(r.url)}`);
  }
  return `${out.join('\n')}\n`;
}

// --- Markdown (PR comment, job summary) --------------------------------------------------------

/** A code fence longer than any run of backticks inside, so log text can't break out of it. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
}

/** Inline code: mentions and markdown are inert inside it; only backticks need replacing. */
const code = (s: string, max = 80) =>
  `\`${s.replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, max)}\``;

/** Text outside a code block: no markdown, mentions or HTML from the log. */
const inline = (s: string) => s.replace(/[\\`*_[\]<>#|@!~]/g, (ch) => `\\${ch}`);

export function formatMarkdown(reports: JobReport[], opts: { runUrl?: string } = {}): string {
  const failed = reports.length;
  const out = [COMMENT_MARKER, `### whatbroke: ${plural(failed, 'job')} failed`];
  if (opts.runUrl) out.push('', `[Workflow run](${opts.runUrl})`);
  for (const r of reports) {
    const a = r.analysis;
    out.push('', `#### ${r.url ? `[${inline(r.name)}](${r.url})` : inline(r.name)}`);
    const base = r.baseline
      ? ` (compared with [${r.baseline.sha.slice(0, 7)}](${r.baseline.url}) on ${code(r.baseline.branch)})`
      : '';
    out.push(
      `Failed${a.failingStep ? ` in ${code(a.failingStep)}` : ''}. ${inline(summaryLine(r))}${base}.`,
    );
    if (a.infra)
      out.push('', `> **Looks like infrastructure:** ${inline(a.infra.kind)}. ${a.infra.advice}`);
    for (const b of a.blocks) {
      out.push(
        '',
        `<sub>${inline(blockTitle(b))}</sub>`,
        '',
        fence(b.lines.map((l) => l.text).join('\n')),
      );
    }
    if (a.hiddenBlocks)
      out.push('', `<sub>${plural(a.hiddenBlocks, 'more block')} of new lines not shown.</sub>`);
  }
  out.push(
    '',
    '<sub>Lines that were already in the last passing run are left out. [whatbroke](https://github.com/mintwork/whatbroke)</sub>',
  );
  return `${out.join('\n')}\n`;
}

// --- Coding agents -------------------------------------------------------------------------

/** Plain and compact: what failed, where, and the new lines, with line numbers. */
export function formatAgent(reports: JobReport[]): string {
  const out: string[] = [];
  for (const r of reports) {
    const a = r.analysis;
    const base = r.baseline
      ? ` (compared with ${r.baseline.sha.slice(0, 7)} on ${r.baseline.branch})`
      : '';
    out.push(
      `whatbroke: job "${r.name}" failed${a.failingStep ? ` in step "${a.failingStep}"` : ''}. ${summaryLine(r)}${base}.`,
    );
    if (a.infra)
      out.push(`Likely infrastructure (${a.infra.kind}), not the code. ${a.infra.advice}`);
    for (const b of a.blocks) {
      out.push(`--- ${blockTitle(b)}`);
      for (const l of b.lines) out.push(`${l.n}: ${l.text}`);
    }
    if (a.hiddenBlocks)
      out.push(`(${plural(a.hiddenBlocks, 'more block')} of new lines not shown)`);
    out.push('');
  }
  return out.join('\n');
}

export function formatJson(reports: JobReport[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...extra, jobs: reports }, null, 2)}\n`;
}
