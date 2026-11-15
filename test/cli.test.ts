import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

const failedLog = [
  '##[group]Run npm test',
  'FAIL a.test.ts',
  'AssertionError: expected 1 to be 2',
  '##[error]Process completed with exit code 1.',
].join('\n');

/** A fake GitHub for one failed run on a PR, where writing comments is forbidden (a Dependabot run). */
function stubGitHub(commentStatus: number, commentHeaders: Record<string, string> = {}) {
  const routes: Record<string, unknown> = {
    '/repos/acme/api/actions/runs/50/jobs': {
      jobs: [
        { id: 500, run_id: 50, name: 'test', conclusion: 'failure', html_url: 'https://x/job/500' },
      ],
      total_count: 1,
    },
    '/repos/acme/api/actions/runs/50': {
      id: 50,
      name: 'CI',
      workflow_id: 9,
      head_branch: 'deps',
      head_sha: 'abc1234def',
      created_at: '2026-11-15T10:00:00Z',
      conclusion: 'failure',
      status: 'completed',
      html_url: 'https://x/run/50',
      event: 'pull_request',
      pull_requests: [{ number: 7 }],
    },
    '/repos/acme/api/actions/jobs/500/logs': failedLog,
    '/repos/acme/api/actions/workflows/9/runs': { workflow_runs: [] },
    '/repos/acme/api/issues/7/comments?per_page=100&page=1': [],
    '/repos/acme/api': { default_branch: 'main' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '');
      if (init?.method === 'POST')
        return new Response(
          commentHeaders['x-ratelimit-remaining'] === '0'
            ? 'API rate limit exceeded'
            : 'Resource not accessible by integration',
          { status: commentStatus, headers: commentHeaders },
        );
      const key = Object.keys(routes).find(
        (k) => path === k || path.startsWith(`${k}?`) || (k.includes('?') && path.startsWith(k)),
      );
      if (!key) return new Response('not found', { status: 404 });
      const v = routes[key];
      return typeof v === 'string' ? new Response(v) : Response.json(v);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('--comment without permission', () => {
  it('still prints the result and exits 0 when the token is read-only', async () => {
    stubGitHub(403);
    process.env.GITHUB_TOKEN = 'test';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(main(['50', '--repo', 'acme/api', '--comment'])).resolves.toBe(0);
    expect(out.mock.calls.join('')).toContain('AssertionError: expected 1 to be 2');
    expect(err.mock.calls.join('')).toContain('not allowed to comment on #7 (403)');
  });

  it('still fails on other errors', async () => {
    stubGitHub(500);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(main(['50', '--repo', 'acme/api', '--comment'])).rejects.toThrow(/500/);
  });

  it('still fails on a rate limit, which GitHub also answers with 403', async () => {
    stubGitHub(403, { 'x-ratelimit-remaining': '0' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(main(['50', '--repo', 'acme/api', '--comment'])).rejects.toThrow(/rate limit/);
  });
});
