// The GitHub REST API calls whatbroke needs: a run and its jobs, the last passing run of the
// same job, job logs, and the PR comment. Uses fetch only; no dependencies.
import { execFileSync } from 'node:child_process';
import { mask } from './core/mask.js';

export interface Repo {
  owner: string;
  name: string;
}

export interface Run {
  id: number;
  name: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  created_at: string;
  conclusion: string | null;
  status: string;
  html_url: string;
  run_attempt?: number;
  event: string;
  pull_requests?: { number: number }[];
  head_repository?: { full_name: string; owner: { login: string } };
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  conclusion: string | null;
  html_url: string;
  steps?: { name: string; number: number; conclusion: string | null }[];
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** GitHub answers 403 (or 429) for rate limits too; those aren't permission problems. */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/** GITHUB_TOKEN, GH_TOKEN, or the GitHub CLI's login. */
export function resolveToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return (
      execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export class GitHub {
  constructor(
    private readonly token: string | undefined,
    private readonly api = process.env.GITHUB_API_URL || 'https://api.github.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mintwork-whatbroke',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string>),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const rateLimited =
        res.status === 429 ||
        res.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit/i.test(body);
      const hint =
        res.status === 401 || (res.status === 403 && !this.token)
          ? ' Set GITHUB_TOKEN, or log in with `gh auth login`.'
          : res.status === 410
            ? ' GitHub deletes logs after the retention period (90 days by default).'
            : '';
      throw new GitHubError(
        res.status,
        `GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${body}${hint}`,
        rateLimited,
      );
    }
    return res;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  run(repo: Repo, id: number): Promise<Run> {
    return this.json<Run>(`/repos/${repo.owner}/${repo.name}/actions/runs/${id}`);
  }

  /** The jobs of a run's latest attempt. */
  async jobs(repo: Repo, runId: number): Promise<Job[]> {
    const out: Job[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await this.json<{ jobs: Job[]; total_count: number }>(
        `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      );
      out.push(...res.jobs);
      if (out.length >= res.total_count || res.jobs.length === 0) break;
    }
    return out;
  }

  job(repo: Repo, id: number): Promise<Job> {
    return this.json<Job>(`/repos/${repo.owner}/${repo.name}/actions/jobs/${id}`);
  }

  /** A job's full log as text (the API redirects to a short-lived download URL). */
  async jobLog(repo: Repo, jobId: number): Promise<string> {
    return (
      await this.request(`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`)
    ).text();
  }

  async defaultBranch(repo: Repo): Promise<string> {
    return (await this.json<{ default_branch: string }>(`/repos/${repo.owner}/${repo.name}`))
      .default_branch;
  }

  /** The most recent failed run on a branch. */
  async latestFailedRun(repo: Repo, branch: string): Promise<Run | undefined> {
    const res = await this.json<{ workflow_runs: Run[] }>(
      `/repos/${repo.owner}/${repo.name}/actions/runs?branch=${encodeURIComponent(branch)}&status=failure&per_page=1`,
    );
    return res.workflow_runs[0];
  }

  /** Successful runs of a workflow on a branch, newest first. */
  async passingRuns(repo: Repo, workflowId: number, branch: string): Promise<Run[]> {
    const res = await this.json<{ workflow_runs: Run[] }>(
      `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/runs?status=success&branch=${encodeURIComponent(branch)}&per_page=15`,
    );
    return res.workflow_runs;
  }

  /** The PR a run belongs to, also for runs from forks (where the API leaves `pull_requests` empty). */
  async pullRequestFor(repo: Repo, run: Run): Promise<number | undefined> {
    if (run.pull_requests?.length) return run.pull_requests[0].number;
    const bySha = await this.json<{ number: number; state: string }[]>(
      `/repos/${repo.owner}/${repo.name}/commits/${run.head_sha}/pulls`,
    ).catch(() => []);
    const open = bySha.find((p) => p.state === 'open') ?? bySha[0];
    if (open) return open.number;
    const owner = run.head_repository?.owner.login;
    if (!owner) return undefined;
    const byHead = await this.json<{ number: number }[]>(
      `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}`,
    ).catch(() => []);
    return byHead[0]?.number;
  }

  /** Create the whatbroke comment on a PR, or update the one already there. */
  async upsertComment(
    repo: Repo,
    pr: number,
    marker: string,
    body: string,
  ): Promise<'created' | 'updated'> {
    const base = `/repos/${repo.owner}/${repo.name}/issues`;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.json<{ id: number; body?: string }[]>(
        `${base}/${pr}/comments?per_page=100&page=${page}`,
      );
      const mine = comments.find((c) => c.body?.includes(marker));
      if (mine) {
        await this.request(`${base}/comments/${mine.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body }),
        });
        return 'updated';
      }
      if (comments.length < 100) break;
    }
    await this.request(`${base}/${pr}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return 'created';
  }
}

export interface Baseline {
  run: Run;
  job: Job;
  log: string;
}

const lineCount = (log: string) => log.split('\n').length;

/**
 * The last passing run of the same job: on the same branch first, then the default branch.
 * A passing run whose log is much shorter than the failed one (a job that skipped its work)
 * makes a poor comparison, so it's passed over when a fuller one exists.
 */
export async function findBaseline(
  gh: GitHub,
  repo: Repo,
  run: Run,
  job: Job,
  failedLog: string,
): Promise<Baseline | undefined> {
  const sameName = (j: Job) => j.name === job.name;
  const similarName = (j: Job) => mask(j.name) === mask(job.name);
  const branches = [run.head_branch];
  const main = await gh.defaultBranch(repo).catch(() => undefined);
  if (main && main !== run.head_branch) branches.push(main);

  const failedLines = lineCount(failedLog);
  let fallback: Baseline | undefined;
  let downloads = 0;
  for (const branch of branches) {
    const runs = (await gh.passingRuns(repo, run.workflow_id, branch)).filter(
      (r) => r.id !== run.id && r.created_at <= run.created_at,
    );
    for (const candidate of runs.slice(0, 6)) {
      const jobs = await gh.jobs(repo, candidate.id);
      const match =
        jobs.find((j) => sameName(j) && j.conclusion === 'success') ??
        jobs.find((j) => similarName(j) && j.conclusion === 'success');
      if (!match) continue;
      const log = await gh.jobLog(repo, match.id).catch(() => undefined);
      downloads++;
      if (log === undefined) continue;
      const found = { run: candidate, job: match, log };
      if (failedLines < 200 || lineCount(log) >= failedLines * 0.25) return found;
      if (!fallback || lineCount(log) > lineCount(fallback.log)) fallback = found;
      if (downloads >= 3) return fallback;
    }
  }
  return fallback;
}

/** owner/name from a GitHub remote URL (https or ssh). */
export function parseRemote(url: string): Repo | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], name: m[2] } : undefined;
}

export interface Target {
  repo?: Repo;
  runId?: number;
  jobId?: number;
}

/** A run or job URL, `owner/name#run`, or a bare run ID. */
export function parseTarget(arg: string): Target | undefined {
  const url =
    /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/(?:job|attempts\/\d+\/job)\/(\d+))?/.exec(
      arg,
    );
  if (url) {
    return {
      repo: { owner: url[1], name: url[2] },
      runId: Number(url[3]),
      jobId: url[4] ? Number(url[4]) : undefined,
    };
  }
  if (/^\d+$/.test(arg)) return { runId: Number(arg) };
  return undefined;
}
