# Changelog

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
