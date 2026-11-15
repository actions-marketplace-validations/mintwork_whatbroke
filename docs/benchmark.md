# Benchmark

**The question:** when a GitHub Actions job fails, is the line that explains why among the 40
lines whatbroke shows? And how does that compare with what people and coding agents usually read:
the end of the log, or GitHub's `##[error]` annotation?

## Data

60 real failed jobs from public repositories, collected on 2026-11-15. Each failed job is paired
with the most recent earlier successful run of the same job (same branch first, otherwise the
default branch). `bench/<set>/jobs.json` lists them.

| Set         | Jobs | Repositories                                                                                   | Kinds                                       |
| ----------- | ---: | ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **tuning**  |   32 | vite, pydantic, ruff, tokio, playwright, fastapi, biome, pnpm, requests, astro, deno, prettier | 20 code, 8 infrastructure, 4 flaky          |
| **heldout** |   28 | hono, svelte, vitest, tailwindcss, cli, hugo, nushell, poetry, react-router, bun               | 16 code, 5 infrastructure, 5 flaky, 2 other |

**Ground truth.** For every job, the line that explains the failure was written down by hand as a
regex in `bench/<set>/truth.json`, from the raw log and **before** any tool ran on it. A job counts
as found when a shown line matches. The labels are strict on purpose: showing the right failing
test without the exact line in the regex still counts as a miss (astro #27 below).

**Held-out.** whatbroke was developed against the tuning set only. The held-out set was collected,
labelled and run once afterwards. How it picks and ranks lines wasn't changed after that run. The
infrastructure rules were: their first version caught 0 of the 5 held-out infrastructure failures,
so they were rewritten using both sets.

## Results

|                                               | Tuning (32) |             Held-out (28) |
| --------------------------------------------- | ----------: | ------------------------: |
| **whatbroke, 40 lines**                       |      **31** |                    **27** |
| Last 40 lines of the log                      |          11 |                        10 |
| GitHub's `##[error]` annotation               |           7 |                        11 |
| Code failures: whatbroke                      |     19 / 20 |                   16 / 16 |
| Code failures: last 40 lines                  |      6 / 20 |                    6 / 16 |
| Infrastructure failures labelled              |       8 / 8 | 5 / 5 (after the rewrite) |
| Code failures wrongly labelled infrastructure |           0 |                         0 |
| Tokens shown, vs the full failed logs         |        1.8% |                      2.2% |
| Time for the whole set                        |       0.3 s |                     0.2 s |

Tokens are estimated as characters ÷ 4.

**Misses:**

- **astro #27 (tuning):** the explanation sits in a 3,000-line block that differed from the passing
  run (test order and cache hits). whatbroke shows the right test's summary, but not the line in
  the regex.
- **cli #19 (held-out):** an AI-agent workflow ending with "Agent reported that it could not
  complete the task".

**What didn't work:** Drain log templates (the usual way to group similar log lines) instead of
masking: 28/32 on the tuning set. Fuzzy templates merge `ruff format....Failed` with the passing
run's `ruff format....Passed`. Ranking the failing step without the diff: 26/32.

## Rerun it

```bash
npm run build
node scripts/fetch-bench.mjs        # downloads the logs (needs a GitHub token)
npm run bench -- bench/tuning
npm run bench -- bench/heldout
```

GitHub deletes job logs after 90 days, so `fetch-bench` stops working around mid-February 2027.
After that, use the archive of the logs attached to the GitHub release.
