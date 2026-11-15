# AGENTS.md

Guidance for AI coding agents working on **whatbroke**: shows the lines of a failed CI log that
weren't in the last passing run, for PR comments, terminals and coding agents.

## Commands

```bash
npm install
npm run check                     # typecheck, biome lint, vitest; run before finishing any task
npm run build                     # tsc -> dist/
node dist/bin.js --help
node scripts/fetch-bench.mjs      # download the benchmark logs (GitHub token needed)
npm run bench -- bench/tuning     # benchmark; also bench/heldout
```

## Layout

- `src/core/log.ts`: GitHub Actions log parsing (timestamps, ANSI, `##[group]Run` steps).
- `src/core/mask.ts`: replaces values that vary between runs. Pattern-based on purpose; see the comment.
- `src/core/analyze.ts`: the diff, blocks, repeats, ranking and line budget. Pure; everything is unit-tested.
- `src/core/classify.ts`: infrastructure-failure rules, each with advice.
- `src/github.ts`: the REST calls (fetch only), choosing the passing run to compare with, the PR comment.
- `src/format.ts`: text, Markdown, JSON and agent output.
- `src/cli.ts`: argument handling. `action.yml`: the composite Action, which runs the npm package.
- `bench/`: the benchmark's jobs and hand-written ground truth (logs are downloaded, not committed).

## Conventions and gotchas

- Zero runtime dependencies. Node 22+ built-ins only.
- **The benchmark is the regression test for ranking changes.** Run both sets before and after.
  Don't tune on `bench/heldout`, and never edit `truth.json` to make a result pass.
- Log text that ends up in a PR comment comes from untrusted pull requests: it must stay inside a
  code fence longer than any backtick run in it (`fence()` in `src/format.ts`), and text outside
  fences goes through `inline()`/`code()`.
- Infrastructure rules must not fire on test output (an app under test logging a 500 isn't
  infrastructure). They only look at annotations, the top block and the end of the failing step.
- CI workflows use Node 26, the latest action majors and `ubuntu-26.04`.
