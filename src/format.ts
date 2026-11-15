// Turning an analysis into text: for a terminal, a PR comment (Markdown), JSON, or a coding agent.
import type { Analysis, Block } from './core/analyze.js';
import { mask } from './core/mask.js';

export interface JobReport {
  name: string;
  url?: string;
  analysis: Analysis;
  /** The passing run compared against, if any. */
  baseline?: { url: string; sha: string; branch: string };
  /** Other jobs that failed the same way (a matrix), shown once under this one. */
  sameAs?: { name: string; url?: string }[];
}

/**
 * Matrix jobs often fail with the same error. Jobs whose top block reads the same (after masking)
 * are shown once, with the others listed under it.
 */
export function groupSameFailures(reports: JobReport[]): JobReport[] {
  const out: JobReport[] = [];
  const bySignature = new Map<string, JobReport>();
  for (const r of reports) {
    const top = r.analysis.blocks[0];
    const signature = top
      ? top.lines
          .filter((l) => !l.context)
          .slice(0, 8)
          .map((l) => mask(l.text))
          .join('\n')
      : '';
    const first = signature ? bySignature.get(signature) : undefined;
    if (first) {
      first.sameAs = [...(first.sameAs ?? []), { name: r.name, url: r.url }];
      continue;
    }
    if (signature) bySignature.set(signature, r);
    out.push(r);
  }
  return out;
}

const totalJobs = (reports: JobReport[]) =>
  reports.reduce((n, r) => n + 1 + (r.sameAs?.length ?? 0), 0);

export const COMMENT_MARKER = '<!-- whatbroke -->';

/** Longest log line shown, in characters: minified or base64 lines would drown everything else. */
const MAX_LINE = 400;
/** GitHub rejects comments over 65,536 characters; stay well under. */
const MAX_COMMENT = 60_000;

const clip = (text: string) =>
  text.length > MAX_LINE
    ? `${text.slice(0, MAX_LINE)}… (${(text.length - MAX_LINE).toLocaleString('en-US')} more characters)`
    : text;

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
    if (r.sameAs?.length) {
      out.push(
        `  ${c.dim(`Same failure in ${plural(r.sameAs.length, 'more job')}: ${r.sameAs.map((j) => j.name).join(', ')}`)}`,
      );
    }
    if (a.infra) {
      out.push(`  ${c.yellow('!')} Looks like infrastructure: ${a.infra.kind}. ${a.infra.advice}`);
    }
    for (const b of a.blocks) {
      out.push('', `  ${c.cyan(blockTitle(b))}`);
      for (const l of b.lines)
        out.push(
          `  ${c.dim(String(l.n).padStart(6))}  ${l.context ? c.dim(clip(l.text)) : clip(l.text)}`,
        );
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
  const failed = totalJobs(reports);
  const head = [COMMENT_MARKER, `### whatbroke: ${plural(failed, 'job')} failed`];
  if (opts.runUrl) head.push('', `[Workflow run](${opts.runUrl})`);
  const foot = [
    '',
    '<sub>Lines that were already in the last passing run are left out. [whatbroke](https://github.com/mintwork/whatbroke)</sub>',
  ];
  let size = head.join('\n').length + foot.join('\n').length + 400;
  const sections: string[] = [];
  const left: JobReport[] = [];
  for (const r of reports) {
    const section = markdownJob(r).join('\n');
    if (left.length || size + section.length > MAX_COMMENT) {
      left.push(r);
      continue;
    }
    sections.push(section);
    size += section.length;
  }
  if (left.length) {
    const names = left
      .map((r) => (r.url ? `[${inline(r.name)}](${r.url})` : inline(r.name)))
      .join(', ');
    sections.push(
      `\n<sub>Not shown, to keep this comment within GitHub's size limit: ${names}.</sub>`,
    );
  }
  return `${[...head, ...sections, ...foot].join('\n')}\n`;
}

function markdownJob(r: JobReport): string[] {
  const a = r.analysis;
  const out = ['', `#### ${r.url ? `[${inline(r.name)}](${r.url})` : inline(r.name)}`];
  const base = r.baseline
    ? ` (compared with [${r.baseline.sha.slice(0, 7)}](${r.baseline.url}) on ${code(r.baseline.branch)})`
    : '';
  out.push(
    `Failed${a.failingStep ? ` in ${code(a.failingStep)}` : ''}. ${inline(summaryLine(r))}${base}.`,
  );
  if (r.sameAs?.length) {
    const links = r.sameAs.map((j) => (j.url ? `[${inline(j.name)}](${j.url})` : inline(j.name)));
    out.push('', `Same failure in ${plural(r.sameAs.length, 'more job')}: ${links.join(', ')}.`);
  }
  if (a.infra)
    out.push('', `> **Looks like infrastructure:** ${inline(a.infra.kind)}. ${a.infra.advice}`);
  for (const b of a.blocks) {
    out.push(
      '',
      `<sub>${inline(blockTitle(b))}</sub>`,
      '',
      fence(b.lines.map((l) => clip(l.text)).join('\n')),
    );
  }
  if (a.hiddenBlocks)
    out.push('', `<sub>${plural(a.hiddenBlocks, 'more block')} of new lines not shown.</sub>`);
  return out;
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
    if (r.sameAs?.length)
      out.push(
        `Same failure in ${plural(r.sameAs.length, 'more job')}: ${r.sameAs.map((j) => j.name).join(', ')}.`,
      );
    if (a.infra)
      out.push(`Likely infrastructure (${a.infra.kind}), not the code. ${a.infra.advice}`);
    for (const b of a.blocks) {
      out.push(`--- ${blockTitle(b)}`);
      for (const l of b.lines) out.push(`${l.n}: ${clip(l.text)}`);
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
