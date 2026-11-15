// whatbroke: why did CI fail? Shows the log lines that weren't in the last passing run.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { analyze } from './core/analyze.js';
import {
  COMMENT_MARKER,
  formatAgent,
  formatJson,
  formatMarkdown,
  formatText,
  groupSameFailures,
  type JobReport,
} from './format.js';
import {
  findBaseline,
  GitHub,
  GitHubError,
  type Job,
  parseRemote,
  parseTarget,
  type Repo,
  type Run,
  resolveToken,
} from './github.js';

const VERSION = readVersion();

/** package.json ships with every npm package, next to dist/. */
function readVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `whatbroke ${VERSION}: why did CI fail? Shows the log lines that weren't in the last passing run.

Usage
  whatbroke                         the latest failed run on the current branch
  whatbroke <run or job URL>        e.g. https://github.com/owner/repo/actions/runs/123/job/456
  whatbroke <run id> --repo o/r
  whatbroke diff <passing.log> <failed.log>    any two logs, no GitHub needed

Options
  --repo <owner/name>   repository (default: the origin remote of the current directory)
  --job <name>          only this job (default: every failed job, up to 8)
  --lines <n>           lines to show per job (default: 40)
  --format <f>          text (default), markdown or json
  --agent               compact plain text for coding agents
  --comment             post (or update) the result as a comment on the run's pull request
  --summary             append the result to the GitHub Actions job summary
  -h, --help            this help
  -v, --version         the version

Auth: GITHUB_TOKEN, GH_TOKEN, or your \`gh\` login. Reading logs needs the actions: read permission.
`;

class UsageError extends Error {}
/** Not an error: a run with nothing to explain (it passed, or failed before any job ran). */
class NothingToExplain extends Error {}

/** Failed jobs analyzed per run (each costs a log download and a search for its passing run). */
const MAX_JOBS = 8;

function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function parseRepo(s: string): Repo {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) throw new UsageError(`--repo must look like owner/name, not "${s}"`);
  return { owner: m[1], name: m[2] };
}

interface Options {
  lines: number;
  format: 'text' | 'markdown' | 'json' | 'agent';
  color: boolean;
}

function render(reports: JobReport[], opts: Options, run?: Run): string {
  switch (opts.format) {
    case 'markdown':
      return formatMarkdown(reports, { runUrl: run?.html_url });
    case 'json':
      return formatJson(
        reports,
        run
          ? { run: { id: run.id, url: run.html_url, sha: run.head_sha, branch: run.head_branch } }
          : {},
      );
    case 'agent':
      return formatAgent(reports);
    default:
      return formatText(reports, { color: opts.color });
  }
}

async function analyzeRun(
  gh: GitHub,
  repo: Repo,
  run: Run,
  opts: Options,
  only?: { id?: number; name?: string },
): Promise<JobReport[]> {
  let jobs: Job[] = (await gh.jobs(repo, run.id)).filter((j) => j.conclusion === 'failure');
  if (only?.id) jobs = jobs.filter((j) => j.id === only.id);
  if (only?.name)
    jobs = jobs.filter((j) => j.name === only.name || j.name.includes(only.name as string));
  if (jobs.length === 0) {
    if (only?.id || only?.name)
      throw new UsageError(`No failed job matching that in run ${run.id}.`);
    throw new NothingToExplain(
      run.conclusion === 'failure' || run.status !== 'completed'
        ? `Run ${run.id} has no failed jobs to explain${run.status === 'completed' ? ' (it failed before any job ran)' : ' yet'}.`
        : `Run ${run.id} didn't fail (${run.conclusion ?? run.status}); nothing to explain.`,
    );
  }
  const reports: JobReport[] = [];
  for (const job of jobs.slice(0, MAX_JOBS)) {
    const log = await gh.jobLog(repo, job.id);
    const base = await findBaseline(gh, repo, run, job, log).catch(() => undefined);
    const analysis = analyze(log, base?.log, { maxLines: opts.lines });
    // The log only has the first line of a multi-line script; the API has the step's real name.
    const failedStep = job.steps?.find((s) => s.conclusion === 'failure')?.name;
    if (failedStep) analysis.failingStep = failedStep;
    reports.push({
      name: job.name,
      url: job.html_url,
      analysis,
      baseline: base
        ? { url: base.job.html_url, sha: base.run.head_sha, branch: base.run.head_branch }
        : undefined,
    });
  }
  if (jobs.length > MAX_JOBS)
    process.stderr.write(`whatbroke: ${jobs.length - MAX_JOBS} more failed jobs not analyzed\n`);
  return groupSameFailures(reports);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      job: { type: 'string' },
      lines: { type: 'string', default: '40' },
      format: { type: 'string', default: 'text' },
      agent: { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${VERSION}\n`);
    return 0;
  }

  const lines = Number(values.lines);
  if (!Number.isInteger(lines) || lines < 5 || lines > 2000)
    throw new UsageError('--lines must be a whole number from 5 to 2000');
  const format = values.agent ? 'agent' : (values.format as Options['format']);
  if (!['text', 'markdown', 'json', 'agent'].includes(format))
    throw new UsageError('--format must be text, markdown or json');
  const opts: Options = {
    lines,
    format,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };

  // Two local files: no GitHub involved.
  if (positionals[0] === 'diff') {
    const [, passing, failed] = positionals;
    if (!passing || !failed)
      throw new UsageError('Usage: whatbroke diff <passing.log> <failed.log>');
    const report: JobReport = {
      name: failed,
      analysis: analyze(readFileSync(failed, 'utf8'), readFileSync(passing, 'utf8'), {
        maxLines: lines,
      }),
    };
    process.stdout.write(render([report], opts));
    return 0;
  }

  const target = positionals[0] ? parseTarget(positionals[0]) : {};
  if (!target) throw new UsageError(`Not a run or job URL, or a run ID: "${positionals[0]}"`);
  const repo =
    (values.repo ? parseRepo(values.repo) : undefined) ??
    target.repo ??
    (process.env.GITHUB_REPOSITORY ? parseRepo(process.env.GITHUB_REPOSITORY) : undefined) ??
    parseRemote(git('remote', 'get-url', 'origin') ?? '');
  if (!repo)
    throw new UsageError('Which repository? Run this inside a clone, or pass --repo owner/name.');

  const gh = new GitHub(resolveToken());
  let run: Run | undefined;
  if (target.runId) run = await gh.run(repo, target.runId);
  else {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (!branch || branch === 'HEAD')
      throw new UsageError('Not on a branch. Pass a run URL instead.');
    run = await gh.latestFailedRun(repo, branch);
    if (!run) throw new UsageError(`No failed runs on ${branch} in ${repo.owner}/${repo.name}.`);
  }

  const reports = await analyzeRun(gh, repo, run, opts, { id: target.jobId, name: values.job });
  process.stdout.write(render(reports, opts, run));

  if (values.summary || values.comment) {
    const md = formatMarkdown(reports, { runUrl: run.html_url });
    if (values.summary && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    if (values.comment) {
      const pr = await gh.pullRequestFor(repo, run);
      if (pr) {
        try {
          const done = await gh.upsertComment(repo, pr, COMMENT_MARKER, md);
          process.stderr.write(`whatbroke: ${done} the comment on #${pr}\n`);
        } catch (e) {
          // Runs triggered by Dependabot (and some fork setups) get a read-only token. The result
          // is still in the output and the job summary; that's no reason to fail the job.
          // A rate limit (also a 403) is not a permission problem: let it fail visibly.
          if (
            !(e instanceof GitHubError) ||
            e.rateLimited ||
            (e.status !== 403 && e.status !== 404)
          )
            throw e;
          process.stderr.write(
            `whatbroke: not allowed to comment on #${pr} (${e.status}); the token needs pull-requests: write. Runs started by Dependabot only get a read-only token, so see the job summary instead.\n`,
          );
        }
      } else process.stderr.write('whatbroke: no pull request for this run, so no comment\n');
    }
  }
  return 0;
}

export async function run(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (e) {
    if (e instanceof NothingToExplain) {
      process.stderr.write(`whatbroke: ${e.message}\n`);
      process.exitCode = 0;
    } else if (
      e instanceof UsageError ||
      (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`whatbroke: ${(e as Error).message}\n`);
      process.exitCode = 2;
    } else if (e instanceof GitHubError) {
      process.stderr.write(`whatbroke: ${e.message}\n`);
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}
