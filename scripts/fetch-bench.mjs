#!/usr/bin/env node
// Downloads the benchmark logs listed in bench/<set>/jobs.json into bench/<set>/logs/.
//
//   npm run build && node scripts/fetch-bench.mjs [tuning|heldout ...]
//
// GitHub deletes job logs after 90 days (the default retention), so this works for a while
// after the benchmark was made (2026-11-15); after that, use the archived logs attached to the
// GitHub release.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHub, resolveToken } from '../dist/github.js';

const root = join(import.meta.dirname, '..', 'bench');
const gh = new GitHub(resolveToken());
for (const set of process.argv.slice(2).length ? process.argv.slice(2) : ['tuning', 'heldout']) {
  const jobs = JSON.parse(readFileSync(join(root, set, 'jobs.json'), 'utf8'));
  mkdirSync(join(root, set, 'logs'), { recursive: true });
  let fetched = 0;
  for (const job of jobs) {
    const [owner, name] = job.repo.split('/');
    for (const kind of ['bad', 'good']) {
      const file = join(root, set, 'logs', `${String(job.id).padStart(2, '0')}-${kind}.log`);
      if (existsSync(file)) continue;
      try {
        writeFileSync(file, await gh.jobLog({ owner, name }, job[`${kind}_job`]));
        fetched++;
      } catch (e) {
        console.error(`${set} ${job.id} ${kind}: ${e.message}`);
      }
    }
  }
  console.log(`${set}: fetched ${fetched} logs`);
}
