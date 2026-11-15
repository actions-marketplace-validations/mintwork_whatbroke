<div align="center">

# whatbroke

**Why did CI fail? See only the log lines that weren't in the last passing run.**

For PR comments, your terminal, and coding agents. No AI, no setup, a few seconds.

[![CI](https://github.com/mintwork/whatbroke/actions/workflows/ci.yml/badge.svg)](https://github.com/mintwork/whatbroke/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mintwork/whatbroke?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@mintwork/whatbroke) [![npm provenance](https://img.shields.io/badge/provenance-signed-7EE2B8?labelColor=0D1714&logo=sigstore&logoColor=white)](https://www.npmjs.com/package/@mintwork/whatbroke#provenance) [![zero dependencies](https://img.shields.io/badge/runtime%20deps-0-7EE2B8?labelColor=0D1714)](package.json) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

```
$ npx -y @mintwork/whatbroke https://github.com/astral-sh/ruff/actions/runs/43729512428/job/132858629404

✗ Compute diagnostic diff failed in "Compute diagnostic diff"
  2,206 log lines, 111 lines new since the last passing run (6d0e8a8 on charlie/ty-fastapi-typed-dict-get)

  # Build the executable for the old and new commit, line 2236
    2236     Compiling ty_python_core v0.0.22 (/home/runner/work/ruff/ruff/ruff/crates/ty_python_core)
    2237     Compiling ty_python_semantic v0.0.22 (/home/runner/work/ruff/ruff/ruff/crates/ty_python_semantic)
    2238  error[E0599]: no method named `declared_type` found for struct `TypeContext<'db>` in the current scope
    2239    --> crates/ty_python_semantic/src/types/infer/builder/typed_dict.rs:79:27
    2240     |
    2241  79 |         if result_context.declared_type().is_some() {
    2242     |                           ^^^^^^^^^^^^^ method not found in `TypeContext<'db>`
```

A failed CI job is thousands of lines, and most of them were also in the last run that passed:
the same deprecation warnings, download progress, cache misses, tests that passed. What broke is
almost always in the lines that are **new**. whatbroke takes the failed job's log and the log of
the last passing run of the same job, hides everything they share, and shows the rest, failure
first.

## Does it find the failure?

We tested it on **60 real failed GitHub Actions jobs** from 22 popular open-source repositories
(vite, pydantic, ruff, tokio, playwright, pnpm, prettier, svelte, vitest, hugo, nushell, bun and
others). For each one, the line that explains the failure was written down by hand, before
running anything. Then we checked whether that line is among the 40 lines each method shows:

|                                         | Tuning set (32 jobs) | **Held-out set (28 jobs)** |
| --------------------------------------- | -------------------: | -------------------------: |
| **whatbroke** (40 lines)                |                   31 |                     **27** |
| The last 40 lines of the log            |                   11 |                         10 |
| GitHub's `##[error]` annotation         |                    7 |                         11 |
| Code failures only: whatbroke / last 40 |              19 / 20 |      **16 / 16** vs 6 / 16 |

- The **held-out** jobs come from 10 repositories whatbroke had never been run on. How it picks
  and ranks lines wasn't changed after seeing their results.
- The 40 lines are about **2%** of the tokens of the full logs (19k vs 860k tokens on the held-out
  set), which is what a coding agent would otherwise read.
- **Infrastructure failures** (DNS, 5xx, a runner timeout, a rejected token, a used-up quota) are
  labelled, so you know to re-run rather than fix: 13 of 13, with no code failure mislabelled.
  Honestly: the first version of these rules caught 0 of the 5 held-out ones, so they were
  rewritten after seeing both sets. Expect misses on new kinds of trouble.
- **The misses:** an Astro test whose explanation sat in a 3,000-line block that differed from the
  passing run, and an AI-agent workflow that "could not complete the task".

How the test was run, and how to rerun it, is in [docs/benchmark.md](docs/benchmark.md).

## Use it

### In your terminal

```bash
npx -y @mintwork/whatbroke                     # the latest failed run on the current branch
npx -y @mintwork/whatbroke <run or job URL>    # any run you can see
npx -y @mintwork/whatbroke diff passing.log failed.log   # any two logs, any CI
```

It uses `GITHUB_TOKEN`, `GH_TOKEN` or your `gh` login, and needs Node.js 22 or newer.

### As a PR comment

Add `.github/workflows/whatbroke.yml`. When your `CI` workflow fails, whatbroke comments on the
pull request with what broke, and updates that comment on the next failure instead of adding
another:

```yaml
name: whatbroke
on:
  workflow_run:
    workflows: [CI] # the workflow(s) to explain
    types: [completed]
permissions:
  actions: read # read the job logs
  pull-requests: write # comment on the PR
jobs:
  explain:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-26.04
    steps:
      - uses: mintwork/whatbroke@v0
```

It runs as its own workflow, so it also works for pull requests from forks, and it never checks
out their code: it only reads the failed run's logs. Inputs: `lines` (default 40), `comment` and
`summary` (default `true`), `run-id`, `token`, `version`.

### For coding agents

`--agent` prints the result as plain text with line numbers, sized for a context window. Tell your
agent in `AGENTS.md` or `CLAUDE.md`:

```markdown
When a CI run fails, run `npx -y @mintwork/whatbroke --agent` and start from its output instead
of reading the full job log.
```

## Options

| Option              | What it does                                                     | Default                    |
| ------------------- | ---------------------------------------------------------------- | -------------------------- |
| `--repo owner/name` | which repository                                                 | the `origin` remote        |
| `--job <name>`      | only this job                                                    | every failed job (up to 5) |
| `--lines <n>`       | most lines to show per job                                       | 40                         |
| `--format <f>`      | `text`, `markdown` or `json`                                     | `text`                     |
| `--agent`           | compact plain text for coding agents                             |                            |
| `--comment`         | post or update the result as a comment on the run's pull request |                            |
| `--summary`         | append the result to the GitHub Actions job summary              |                            |

## How it works

1. **Get both logs.** The failed job's log, and the log of the most recent passing run of the same
   job: the same branch first, then the default branch. Matrix jobs match even when a version in
   their name changed. A passing run that skipped its work (a much shorter log) is passed over.
2. **Mask what varies.** Timestamps, durations, sizes, hashes, UUIDs, temp paths and other numbers
   become placeholders, so "the same line with different numbers" counts as the same line.
   Masking is pattern-based on purpose: fuzzy log templates (like Drain) also merge
   `ruff format....Failed` with the passing run's `ruff format....Passed`, and hide exactly the
   line that matters.
3. **Keep what's new**, as blocks with two lines of context, and remove repeats (test runners print
   every failure again in a summary).
4. **Rank and cut.** Blocks from the failing step come first, those with failure headers
   (`FAIL`, `✖`, `error[E…]`, `AssertionError`, `panicked at`, `Traceback`…) above summaries ("see
   above for details", "exit code 1"). Long stack traces keep their first frames. The result is
   cut to `--lines`.

Without a passing run to compare with (a new workflow, or logs older than GitHub's 90-day
retention), it falls back to ranking the failing step.

## Privacy

Everything runs on your machine or your runner; nothing is sent anywhere except the GitHub API.
There's no AI. The PR comment contains log lines, so it's visible to the same people who can read
the logs (GitHub replaces secrets with `***` in logs). Log text is always inside a code block, so
it can't add mentions, links or images to the comment.

## Limits

- **Automatic comparison is GitHub Actions only.** For other CI, `whatbroke diff` compares any two
  logs you give it.
- **It needs a passing run of the same job** for the best results; see the fallback above.
- **It shows where it failed, not why.** A new line is the symptom; finding the cause in the
  code is still up to you (or your agent, now with 2% of the reading).

## Development

```bash
npm install
npm run check    # typecheck, lint, tests
npm run build
npm run bench -- <dir>   # the benchmark; see docs/benchmark.md
```

[`AGENTS.md`](AGENTS.md) explains the layout.

## License

MIT
