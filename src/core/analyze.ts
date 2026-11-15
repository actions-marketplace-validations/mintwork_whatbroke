// What broke: the lines of a failed log that weren't in the last passing run, grouped into
// blocks, ranked, and cut to a budget small enough for a PR comment or an agent's context.
import { type InfraHint, infraHint } from './classify.js';
import { failingStep, isNoise, type LogLine, parseLog } from './log.js';
import { mask } from './mask.js';

export interface ShownLine extends LogLine {
  /** True for a line that's also in the passing run, shown only as context. */
  context: boolean;
}

export interface Block {
  step: string;
  lines: ShownLine[];
  /** Lines of this block left out to stay within the budget. */
  omitted: number;
  /** How many more times the same block appears further down (test runners repeat failures in a summary). */
  repeats: number;
  score: number;
}

export interface Analysis {
  /** Content lines in the failed log (blank lines and group markers not counted). */
  totalLines: number;
  /** Content lines that weren't in the passing run (or, without one, in the failing step). */
  newLines: number;
  /** Whether a passing run was compared against. */
  compared: boolean;
  failingStep?: string;
  /** The blocks to show, most relevant first. */
  blocks: Block[];
  /** Blocks of new lines that didn't fit the budget. */
  hiddenBlocks: number;
  shownLines: number;
  /** Set when the failure looks like infrastructure (network, quota, runner) rather than code. */
  infra?: InfraHint;
}

export interface AnalyzeOptions {
  /** Most lines to show in total. */
  maxLines?: number;
  /** Most lines to show from one block. */
  maxBlockLines?: number;
}

/** The line a test runner or compiler prints when something definitely failed. */
const HEADER =
  /^\s*(?:FAIL\b|[✖✕×✗]\s|\d+\) \S|● |_{3,} \S.* _{3,}$|not ok\b|---- \S+ stdout ----)|\b(?:AssertionError|panicked at|Traceback \(most recent call last\)|error(?:\[E\d+\])?:|error TS\d+|npm ERR!|CONFLICT \(|fatal:|XPASS|SyntaxError|TypeError|ReferenceError)/;
/** Error words in general. */
const STRONG = /\b(?:FAIL(?:ED|URE)?|Error|ERROR|Exception|panic)\b/;
/** "It failed, see above": a summary, not the cause. */
const SUMMARY =
  /See above for more details|Command failed with exit code|ELIFECYCLE|exited \(\d+\)|Process completed with exit code|test run failed|could not compile .* due to/i;
/** Monorepo runners (turbo, pnpm -r, nx) prefix every line with the package and task. */
const PREFIX = /^(?:@?[\w.-]+\/)*[\w.-]+(?::[\w-]+)+: ?|^[\w./-]+ [\w:-]+: /;
const strip = (text: string) => text.replace(PREFIX, '');
const WEAK =
  /\b(?:error|fail(?:ed|s|ure)?|cannot|can't|could not|unable|not found|timed out|timeout|denied|refused|expected|received|missing|invalid)\b/i;
const WARNING = /^\s*(?:warning|warn)\b/i;
const GENERIC_EXIT = /^##\[error\]Process completed with exit code \d+\.?$/;
/** A stack frame: JS/Java `at …`, Python `File "…", line N`, Rust/Go numbered frames. */
const FRAME = /^\s*(?:at\s|File ".+", line \d+|\d+: (?:0x[0-9a-f]+|[\w:<>]+)\b|[\w./-]+\.go:\d+)/;
/** Frames kept from each stack trace; the rest are counted as omitted. */
const FRAMES_KEPT = 2;
/** Merge runs of new lines separated by at most this many old lines. */
const GAP = 2;
/** Lines of context shown before a block (often the test or file name, unchanged since the passing run). */
const CONTEXT = 2;
/** A longer run of new lines is split into chunks scored on their own, so one noisy region can't bury the failure. */
const CHUNK = 24;

interface Raw {
  idx: number[];
  step: string;
}

function toLines(log: string | LogLine[]): LogLine[] {
  return typeof log === 'string' ? parseLog(log) : log;
}

export function analyze(
  failedLog: string | LogLine[],
  passingLog?: string | LogLine[],
  options: AnalyzeOptions = {},
): Analysis {
  const maxLines = options.maxLines ?? 40;
  const maxBlockLines = options.maxBlockLines ?? 14;
  const failed = toLines(failedLog);
  const content = failed.filter((l) => !isNoise(l));
  const step = failingStep(failed);

  // 1. Which lines are new.
  let isNew: (l: LogLine) => boolean;
  if (passingLog !== undefined) {
    const seen = new Set(
      toLines(passingLog)
        .filter((l) => !isNoise(l))
        .map((l) => mask(l.text)),
    );
    isNew = (l) => !seen.has(mask(l.text));
  } else {
    // Nothing to compare with: everything in the failing step counts.
    isNew = (l) => step === undefined || l.step === step;
  }
  const fresh = content.map(isNew);

  // 2. Blocks: runs of new lines, merged across small gaps, never across steps.
  const raws: Raw[] = [];
  let current: Raw | undefined;
  let gap = 0;
  for (let i = 0; i < content.length; i++) {
    const line = content[i];
    if (fresh[i]) {
      if (current && current.step === line.step && gap <= GAP) {
        for (let j = i - gap; j <= i; j++) current.idx.push(j);
      } else {
        current = { idx: [i], step: line.step };
        raws.push(current);
      }
      gap = 0;
    } else if (current) {
      gap++;
    }
  }

  // 3. Long runs become chunks; repeats (the same block after masking) count once.
  const chunks: Raw[] = raws.flatMap((r) => {
    if (r.idx.length <= CHUNK) return [r];
    const out: Raw[] = [];
    // Half-overlapping, so a failure that straddles a chunk boundary is whole in one of them.
    for (let i = 0; i < r.idx.length; i += CHUNK / 2) {
      out.push({ idx: r.idx.slice(i, i + CHUNK), step: r.step });
      if (i + CHUNK >= r.idx.length) break;
    }
    return out;
  });
  const byKey = new Map<string, Block>();
  const blocks: Block[] = [];
  for (const raw of chunks) {
    // GitHub's closing `##[error]` line doesn't make a repeated block different.
    const key = raw.idx
      .filter((i) => fresh[i] && !content[i].text.startsWith('##[error]'))
      .map((i) => mask(content[i].text))
      .join('\n');
    const prior = byKey.get(key);
    if (prior) {
      prior.repeats++;
      continue;
    }
    const lines: ShownLine[] = raw.idx.map((i) => ({ ...content[i], context: !fresh[i] }));
    // A little context before the block, from the same step.
    for (let j = 1; j <= CONTEXT; j++) {
      const before = content[raw.idx[0] - j];
      if (!before || before.step !== raw.step || fresh[raw.idx[0] - j]) break;
      lines.unshift({ ...before, context: true });
    }
    const block: Block = { step: raw.step, lines, omitted: 0, repeats: 0, score: 0 };
    byKey.set(key, block);
    blocks.push(block);
  }

  // 4. Score. Error-looking lines count most, in the failing step most of all, and close to where
  // it ended (where runners print their summary) a little more.
  const stepEnd = new Map<string, number>();
  for (const l of content) stepEnd.set(l.step, l.n);
  for (const b of blocks) {
    let headers = 0;
    let strong = 0;
    let weak = 0;
    let warnings = 0;
    let annotation = 0;
    for (const l of b.lines) {
      if (l.context) continue;
      const text = strip(l.text);
      if (l.text.startsWith('##[error]')) annotation = GENERIC_EXIT.test(l.text) ? 1 : 4;
      if (WARNING.test(text)) warnings++;
      else if (SUMMARY.test(text)) continue;
      else if (HEADER.test(text)) headers++;
      else if (STRONG.test(text)) strong++;
      else if (WEAK.test(text)) weak++;
    }
    const last = b.lines.at(-1)?.n ?? 0;
    const nearEnd = step !== undefined && b.step === step && (stepEnd.get(step) ?? 0) - last <= 40;
    b.score =
      Math.min(headers, 3) * 8 +
      Math.min(strong, 5) * 3 +
      Math.min(weak, 8) +
      annotation -
      Math.min(warnings, 6) +
      (b.step === step ? 12 : 0) +
      (nearEnd ? 2 : 0);
  }
  const ranked = blocks
    .filter((b) => b.score > 0 || blocks.length <= 3)
    .sort((a, b) => b.score - a.score || a.lines[0].n - b.lines[0].n);

  // 5. Fit the budget. A long block is cut to a window starting a few lines before its first
  // error-looking line (that's usually where the test or file name is).
  const isError = (l: ShownLine) =>
    !l.context && (HEADER.test(strip(l.text)) || STRONG.test(strip(l.text)));
  const shown: Block[] = [];
  const shownAt = new Set<number>();
  const shownText = new Set<string>();
  let budget = maxLines;
  for (const b of ranked) {
    if (budget < 3) break;
    // Overlapping chunks: skip one that's mostly shown already, trim the rest.
    const already = b.lines.filter((l) => shownAt.has(l.n)).length;
    if (already > b.lines.length / 2) continue;
    let lines = already ? b.lines.filter((l) => !shownAt.has(l.n)) : b.lines;
    // Long stack traces: the first frames say where; the rest only take room.
    let omitted = 0;
    let frames = 0;
    lines = lines.filter((l) => {
      frames = FRAME.test(strip(l.text)) ? frames + 1 : 0;
      if (frames <= FRAMES_KEPT) return true;
      omitted++;
      return false;
    });
    const room = Math.min(budget, maxBlockLines);
    if (lines.length > room) {
      // The window with the most error-looking lines (failure headers count triple), moved up to
      // two meaningful lines earlier when there's room: that's usually the test or file name.
      const weight = lines.map((l) =>
        l.context ? 0 : HEADER.test(strip(l.text)) ? 3 : STRONG.test(strip(l.text)) ? 1 : 0,
      );
      let best = 0;
      let bestScore = -1;
      for (let i = 0, sum = 0; i < lines.length; i++) {
        sum += weight[i] - (i >= room ? weight[i - room] : 0);
        const start = i - room + 1;
        if (start >= 0 && sum > bestScore) {
          bestScore = sum;
          best = start;
        }
      }
      const firstError = weight.findIndex((w, i) => i >= best && w > 0);
      let start = best;
      for (let back = 0; start > 0 && back < 2 && firstError - start < 2; ) {
        start--;
        if (/[A-Za-z0-9]/.test(lines[start].text)) back++;
      }
      omitted += lines.length - room;
      lines = lines.slice(start, start + room);
    }
    // A near-copy of something already shown (a runner's "summary of all failures") adds nothing:
    // most of its lines, and every error line in it, are on screen already.
    const own = lines.filter((l) => !l.context);
    const seen = own.filter((l) => shownText.has(mask(l.text))).length;
    if (
      own.length >= 3 &&
      seen >= own.length * 0.7 &&
      own.filter(isError).every((l) => shownText.has(mask(l.text)))
    ) {
      const original = shown.find((s) =>
        s.lines.some(
          (l) =>
            !l.context &&
            shownText.has(mask(l.text)) &&
            own.some((o) => mask(o.text) === mask(l.text)),
        ),
      );
      if (original) original.repeats++;
      continue;
    }
    b.lines = lines;
    b.omitted = omitted;
    budget -= lines.length;
    for (const l of lines) {
      shownAt.add(l.n);
      if (!l.context) shownText.add(mask(l.text));
    }
    shown.push(b);
  }

  // 6. Infrastructure? Only where the job died: GitHub's annotations, the top block, and the end
  // of the failing step. Test output elsewhere is full of 500s and broken pipes from the app
  // under test, which say nothing about the runner.
  const annotations = content.filter((l) => l.text.startsWith('##[error]'));
  const inStep = content.filter((l, i) => fresh[i] && (step === undefined || l.step === step));
  const top = shown[0]?.lines.filter((l) => !l.context) ?? [];
  const infra = infraHint([...annotations, ...top, ...inStep.slice(-15)].map((l) => l.text));

  return {
    totalLines: content.length,
    newLines: fresh.filter(Boolean).length,
    compared: passingLog !== undefined,
    failingStep: step,
    blocks: shown,
    hiddenBlocks: ranked.length - shown.length,
    shownLines: shown.reduce((n, b) => n + b.lines.length, 0),
    infra,
  };
}
