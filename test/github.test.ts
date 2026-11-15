import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analyze.js';
import { COMMENT_MARKER, formatAgent, formatMarkdown, groupSameFailures } from '../src/format.js';
import {
  findBaseline,
  GitHub,
  type Job,
  parseRemote,
  parseTarget,
  type Run,
} from '../src/github.js';

const repo = { owner: 'acme', name: 'api' };

describe('parsing', () => {
  it.each([
    ['https://github.com/acme/api/actions/runs/123', { repo, runId: 123, jobId: undefined }],
    ['https://github.com/acme/api/actions/runs/123/job/456', { repo, runId: 123, jobId: 456 }],
    [
      'https://github.com/acme/api/actions/runs/123/attempts/2/job/456?pr=7',
      { repo, runId: 123, jobId: 456 },
    ],
    ['987', { runId: 987 }],
  ])('%s', (arg, want) => expect(parseTarget(arg)).toEqual(want));

  it('rejects anything else', () => expect(parseTarget('main')).toBeUndefined());

  it.each([
    'https://github.com/acme/api.git',
    'git@github.com:acme/api.git',
    'https://github.com/acme/api',
  ])('remote %s', (url) => expect(parseRemote(url)).toEqual(repo));
});

/** A fake GitHub API: routes by path, records writes. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.test', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) =>
      (k.startsWith(`${method} `) ? `${method} ${path}` : path).startsWith(k),
    );
    if (!key) return new Response('not found', { status: 404 });
    const v = routes[key];
    return typeof v === 'string' ? new Response(v) : Response.json(v);
  }) as typeof fetch;
  return { gh: new GitHub('t0ken', 'https://api.test', fetchImpl), calls };
}

const run = (id: number, extra: Partial<Run> = {}): Run => ({
  id,
  name: 'CI',
  workflow_id: 9,
  head_branch: 'feature',
  head_sha: `sha${id}aaaaaaa`,
  created_at: `2026-11-15T10:${String(id).padStart(2, '0')}:00Z`,
  conclusion: 'success',
  status: 'completed',
  html_url: `https://github.com/acme/api/actions/runs/${id}`,
  event: 'pull_request',
  ...extra,
});
const job = (id: number, name: string, conclusion = 'success'): Job => ({
  id,
  run_id: 0,
  name,
  conclusion,
  html_url: `https://github.com/acme/api/actions/runs/0/job/${id}`,
});

describe('findBaseline', () => {
  const failedRun = run(50, { conclusion: 'failure' });
  const failedJob = job(500, 'test (node 22.23.4)', 'failure');
  const failedLog = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');

  it('takes the last passing run of the same job on the same branch', async () => {
    const { gh } = fakeApi({
      '/repos/acme/api/actions/workflows/9/runs?status=success&branch=feature': {
        workflow_runs: [run(40), run(30)],
      },
      '/repos/acme/api/actions/runs/40/jobs': {
        jobs: [job(400, 'lint'), job(401, 'test (node 22.23.4)')],
        total_count: 2,
      },
      '/repos/acme/api/actions/jobs/401/logs': failedLog,
      '/repos/acme/api': { default_branch: 'main' },
    });
    const base = await findBaseline(gh, repo, failedRun, failedJob, failedLog);
    expect(base?.job.id).toBe(401);
  });

  it('matches a job whose matrix version changed, and falls back to the default branch', async () => {
    const { gh } = fakeApi({
      '/repos/acme/api/actions/workflows/9/runs?status=success&branch=feature': {
        workflow_runs: [],
      },
      '/repos/acme/api/actions/workflows/9/runs?status=success&branch=main': {
        workflow_runs: [run(20, { head_branch: 'main' })],
      },
      '/repos/acme/api/actions/runs/20/jobs': {
        jobs: [job(201, 'test (node 22.24.0)')],
        total_count: 1,
      },
      '/repos/acme/api/actions/jobs/201/logs': failedLog,
      '/repos/acme/api': { default_branch: 'main' },
    });
    const base = await findBaseline(gh, repo, failedRun, failedJob, failedLog);
    expect(base?.job.id).toBe(201);
    expect(base?.run.head_branch).toBe('main');
  });

  it('passes over a passing run that skipped its work', async () => {
    const { gh } = fakeApi({
      '/repos/acme/api/actions/workflows/9/runs?status=success&branch=feature': {
        workflow_runs: [run(40), run(30)],
      },
      '/repos/acme/api/actions/runs/40/jobs': { jobs: [job(401, failedJob.name)], total_count: 1 },
      '/repos/acme/api/actions/runs/30/jobs': { jobs: [job(301, failedJob.name)], total_count: 1 },
      '/repos/acme/api/actions/jobs/401/logs': 'nothing to do',
      '/repos/acme/api/actions/jobs/301/logs': failedLog,
      '/repos/acme/api': { default_branch: 'main' },
    });
    expect((await findBaseline(gh, repo, failedRun, failedJob, failedLog))?.job.id).toBe(301);
  });
});

describe('PR comment', () => {
  it('updates the existing whatbroke comment instead of adding another', async () => {
    const { gh, calls } = fakeApi({
      '/repos/acme/api/issues/7/comments?per_page=100&page=1': [
        { id: 1, body: 'hi' },
        { id: 2, body: `${COMMENT_MARKER}\nold` },
      ],
      'PATCH /repos/acme/api/issues/comments/2': {},
    });
    expect(await gh.upsertComment(repo, 7, COMMENT_MARKER, 'new')).toBe('updated');
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/repos/acme/api/issues/comments/2',
    });
  });

  it('finds the PR of a run from a fork', async () => {
    const { gh } = fakeApi({
      '/repos/acme/api/commits/sha50aaaaaaa/pulls': [{ number: 12, state: 'open' }],
    });
    expect(await gh.pullRequestFor(repo, run(50, { pull_requests: [] }))).toBe(12);
  });
});

describe('formats', () => {
  const hostile = [
    '##[group]Run npm test',
    'FAIL x.test.ts',
    'Error: @octocat see ```` and <img src=x onerror=alert(1)> [click](https://evil.test)',
    '##[error]Process completed with exit code 1.',
  ].join('\n');
  const reports = [{ name: 'test @everyone', analysis: analyze(hostile, '##[group]Run npm test') }];

  it('keeps log text inside a code fence it cannot close', () => {
    const md = formatMarkdown(reports);
    const fenceLine = md.split('\n').find((l) => /^`{3,}text$/.test(l)) ?? '';
    expect(fenceLine.length - 4).toBeGreaterThan(4); // longer than the ```` in the log
    expect(md).toContain('test \\@everyone'); // the job name is escaped outside the fence
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('gives agents plain lines with line numbers', () => {
    const text = formatAgent(reports);
    expect(text).toMatch(/^whatbroke: job "test @everyone" failed in step "npm test"/);
    expect(text).toContain('2: FAIL x.test.ts');
  });
});

describe('groupSameFailures', () => {
  const log = (node: string) =>
    [
      '##[group]Run npm test',
      `node ${node}`,
      'FAIL a.test.ts',
      'AssertionError: expected 1 to be 2',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
  const passing = '##[group]Run npm test';

  it('shows a matrix failing the same way once', () => {
    const reports = ['22', '24', '26'].map((n) => ({
      name: `test (node ${n})`,
      analysis: analyze(log(n), passing),
    }));
    const grouped = groupSameFailures(reports);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].sameAs?.map((j) => j.name)).toEqual(['test (node 24)', 'test (node 26)']);
    expect(formatMarkdown(grouped)).toContain('### whatbroke: 3 jobs failed');
    expect(formatMarkdown(grouped)).toContain('Same failure in 2 more jobs');
  });

  it('keeps different failures apart', () => {
    const other =
      '##[group]Run npm test\nFAIL b.test.ts\nTypeError: x is undefined\n##[error]Process completed with exit code 1.';
    const grouped = groupSameFailures([
      { name: 'a', analysis: analyze(log('22'), passing) },
      { name: 'b', analysis: analyze(other, passing) },
    ]);
    expect(grouped).toHaveLength(2);
  });
});
