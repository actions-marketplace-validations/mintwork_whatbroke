// Reading CI logs. GitHub Actions job logs prefix every line with an ISO timestamp, use
// `##[group]Run <command>` / `##[endgroup]` around each step, and carry ANSI colors. Plain logs
// (any other CI, or a file on disk) work too: they're one step called "log".

export interface LogLine {
  /** 1-based line number in the original log. */
  n: number;
  /** The step the line belongs to: the command after the latest `##[group]Run `. */
  step: string;
  /** The line without its timestamp and ANSI escapes. */
  text: string;
}

const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const STEP = /^##\[group\]Run (.+)$/;
/** Lines that are structure, not content: group markers, debug output, blank lines. */
const NOISE = /^(?:##\[(?:group|endgroup|debug)\]|\s*$)/;

export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  let step = 'log';
  const raw = text.split(/\r?\n/);
  if (raw.at(-1) === '') raw.pop();
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(TIMESTAMP, '').replace(ANSI, '');
    const m = STEP.exec(line);
    if (m) step = m[1].trim().slice(0, 120);
    out.push({ n: i + 1, step, text: line });
  }
  return out;
}

export const isNoise = (line: LogLine) => NOISE.test(line.text);

/** The step that failed: the one holding the first `##[error]` annotation. */
export function failingStep(lines: LogLine[]): string | undefined {
  return lines.find((l) => l.text.startsWith('##[error]'))?.step;
}
