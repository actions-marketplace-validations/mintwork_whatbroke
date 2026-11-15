# Changelog

## 0.1.2

- No permission to comment (runs started by Dependabot get a read-only token) is no longer an
  error: whatbroke says so, keeps the result in the output and the job summary, and exits 0.

## 0.1.1

- A matrix failing the same way is shown once, with "Same failure in N more jobs" (found in a live
  test: six identical failures made six copies of the same block in the PR comment).
- Up to 8 failed jobs per run are analyzed (was 5).
- The PR comment stays within GitHub's size limit: very long lines (minified or base64) are cut,
  and jobs that don't fit are listed instead of making the comment fail.
- A run with nothing to explain (it passed, or failed before any job ran) exits cleanly instead
  of failing the whatbroke job.

## 0.1.0

First release.

- `whatbroke` shows the lines of a failed GitHub Actions job that weren't in the last passing run
  of the same job, failure first, cut to 40 lines. It finds the passing run itself: the same
  branch first, then the default branch.
- Works on the latest failed run of the current branch, on any run or job URL, or on any two log
  files (`whatbroke diff`).
- Output for terminals, PR comments (`--format markdown`, `--comment`, `--summary`), JSON, and
  coding agents (`--agent`).
- A GitHub Action (`mintwork/whatbroke@v0`) that comments on the pull request when CI fails, also
  for pull requests from forks.
- Labels infrastructure failures (DNS, network, 5xx, rate limits, rejected tokens, quotas, disk,
  artifacts, timeouts) with what to do about them.
- Benchmark: on 28 held-out real failures from 10 repositories, the explaining line is in the
  40 lines shown for 27 (the last 40 lines of the log: 10). See [docs/benchmark.md](docs/benchmark.md).
