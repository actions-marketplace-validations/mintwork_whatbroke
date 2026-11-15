#!/usr/bin/env node
// Generates docs/demo.gif from the real tool on real data: ruff's failed "Compute diagnostic diff"
// job from the benchmark (bench/tuning, job 06), compared with its last passing run.
//
//   node scripts/fetch-bench.mjs tuning   # once, for the logs
//   npm run demo:gif                      # needs Google Chrome and ffmpeg
//
// Scenes: the end of the raw log (what people usually read), whatbroke on the same job, and the
// PR comment the Action posts. Rendered in Chrome (playwright-core), encoded with ffmpeg.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { formatMarkdown, formatText } from '../dist/format.js';
import { analyze, isNoise, parseLog } from '../dist/index.js';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'demo.gif');
const LOGS = join(ROOT, 'bench', 'tuning', 'logs');
const JOB_URL = 'https://github.com/astral-sh/ruff/actions/runs/43729512428/job/132858629404';
const WIDTH = 1180;
const ROWS = 24;
const LINE_H = 20;

for (const f of ['06-bad.log', '06-good.log'])
  if (!existsSync(join(LOGS, f)))
    throw new Error(`missing bench/tuning/logs/${f}: run node scripts/fetch-bench.mjs tuning`);

const failedText = readFileSync(join(LOGS, '06-bad.log'), 'utf8');
const failed = parseLog(failedText);
const analysis = analyze(failedText, readFileSync(join(LOGS, '06-good.log'), 'utf8'), {
  maxLines: 14,
});
const report = {
  name: 'Compute diagnostic diff',
  url: JOB_URL,
  analysis,
  baseline: { url: JOB_URL, sha: '6d0e8a8', branch: 'charlie/ty-fastapi-typed-dict-get' },
};

// --- Text to HTML ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SGR = { 1: 'b', 2: 'dim', 31: 'red', 33: 'yellow', 36: 'cyan' };
function ansiToHtml(line) {
  let html = '';
  let open = [];
  let last = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  const re = /\u001b\[(\d+)m/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const text = esc(line.slice(last, m.index));
    html += open.length ? `<span class="${open.join(' ')}">${text}</span>` : text;
    last = re.lastIndex;
    open = m[1] === '0' ? [] : [...open, SGR[m[1]]].filter(Boolean);
  }
  const rest = esc(line.slice(last));
  return html + (open.length ? `<span class="${open.join(' ')}">${rest}</span>` : rest);
}

const PROMPT = '<span class="cyan">~/code/ruff</span> <span class="green">❯</span> ';
const tail = failed
  .filter((l) => !isNoise(l))
  .slice(-12)
  .map((l) => `<span class="dim">${esc(l.text.slice(0, 118))}</span>`);
const output = formatText([report], { color: true })
  .split('\n')
  .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
  .map((l) => ansiToHtml(l.length > 140 ? `${l.slice(0, 139)}…` : l));

// The PR comment, rendered roughly the way GitHub shows it.
function commentHtml() {
  const md = formatMarkdown([report], { runUrl: JOB_URL });
  const parts = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('<!--') || !l.trim()) continue;
    if (/^`{3,}/.test(l)) {
      const body = [];
      for (i++; i < lines.length && !/^`{3,}$/.test(lines[i]); i++) body.push(esc(lines[i]));
      parts.push(`<pre>${body.join('\n')}</pre>`);
    } else if (l.startsWith('### ')) parts.push(`<h3>${esc(l.slice(4))}</h3>`);
    else if (l.startsWith('#### '))
      parts.push(
        `<h4>${esc(
          l
            .slice(5)
            .replace(/^\[(.*)\]\(.*\)$/, '$1')
            .replace(/\\/g, ''),
        )}</h4>`,
      );
    else if (l.startsWith('<sub>'))
      parts.push(
        `<p class="sub">${esc(
          l
            .replace(/<\/?sub>/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\\/g, ''),
        )}</p>`,
      );
    else if (!l.startsWith('[Workflow run]'))
      parts.push(
        `<p>${esc(l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\\/g, '')).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`,
      );
  }
  return parts.join('\n');
}

// --- Timeline ---------------------------------------------------------------------------------

function timeline() {
  const states = [];
  let screen = [];
  const push = (ms, extra = {}) =>
    states.push({
      lines: screen.slice(),
      cursor: extra.cursor ?? null,
      overlay: extra.overlay ?? false,
      ms,
    });
  const hold = (ms, extra = {}) => {
    if (!extra.cursor) return push(ms, extra);
    for (let t = 0; t < ms; t += 500)
      push(Math.min(500, ms - t), { ...extra, cursor: (t / 500) % 2 ? 'off' : 'on' });
  };
  const type = (cmd) => {
    screen.push(PROMPT);
    const at = screen.length - 1;
    hold(400, { cursor: 'on' });
    for (let i = 1; i <= cmd.length; i++) {
      screen[at] = PROMPT + esc(cmd.slice(0, i));
      push(cmd[i - 1] === ' ' ? 60 : 28 + ((i * 37) % 25), { cursor: 'on' });
    }
    push(300, { cursor: 'on' });
  };
  const reveal = (lines, ms) => {
    for (const l of lines) {
      screen.push(l);
      push(ms);
    }
  };

  // 1. What people read: the end of the failed log. Post-job cleanup, not the error.
  type('gh run view 43729512428 --log-failed | tail -12');
  reveal(tail, 45);
  screen.push(PROMPT);
  hold(2600, { cursor: 'on' });

  // 2. whatbroke on the same job.
  screen = [];
  type(`npx -y @mintwork/whatbroke ${JOB_URL.replace('https://', '')}`);
  push(500);
  reveal(output, 110);
  screen.push(PROMPT);
  hold(3800, { cursor: 'on' });

  // 3. The PR comment the Action posts.
  hold(4200, { overlay: true });

  const merged = [];
  for (const s of states) {
    const prev = merged.at(-1);
    if (
      prev &&
      prev.cursor === s.cursor &&
      prev.overlay === s.overlay &&
      prev.lines.join('\n') === s.lines.join('\n')
    )
      prev.ms += s.ms;
    else merged.push({ ...s });
  }
  return merged;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
html, body { width: ${WIDTH}px; background: #0b0e14; }
body { padding: 26px 28px 28px; font-family: Menlo, 'SF Mono', ui-monospace, monospace; }
.win { background: #11151c; border: 1px solid #262c36; border-radius: 12px; overflow: hidden; position: relative; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
.bar { height: 38px; display: flex; align-items: center; padding: 0 14px; background: #181d26; border-bottom: 1px solid #232a35; }
.dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
.title { flex: 1; text-align: center; color: #7d8590; font: 13px -apple-system, 'Helvetica Neue', sans-serif; margin-right: 60px; }
.pad { padding: 14px 20px 16px; }
#term { color: #d6dbe2; font-size: 13px; line-height: ${LINE_H}px; height: ${ROWS * LINE_H}px; white-space: pre; overflow: hidden; }
.b { font-weight: 700; color: #f0f3f6; } .dim { color: #7d8590; } .red { color: #ff7b72; } .yellow { color: #e3b341; } .cyan { color: #56d4dd; } .green { color: #56d364; }
.cur { display: inline-block; width: .6em; height: 1.2em; background: #d6dbe2; vertical-align: -.25em; } .cur.off { visibility: hidden; }
#overlay { position: absolute; inset: 52px 60px auto; display: none; }
.card { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; font: 14px/1.5 -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif; color: #e6edf3; box-shadow: 0 16px 60px rgba(0,0,0,.7); }
.card .head { background: #161b22; border-bottom: 1px solid #30363d; padding: 9px 16px; color: #8d96a0; font-size: 13px; }
.card .head b { color: #e6edf3; }
.card .body { padding: 6px 18px 14px; max-height: 410px; overflow: hidden; }
.card h3 { font-size: 17px; margin: 10px 0 6px; } .card h4 { font-size: 15px; margin: 10px 0 4px; color: #4493f8; }
.card p { margin: 4px 0; } .card .sub { color: #8d96a0; font-size: 12px; margin-top: 8px; }
.card code { background: #262c36; border-radius: 4px; padding: 1px 5px; font: 12px Menlo, monospace; }
.card pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font: 12px/1.5 Menlo, monospace; color: #e6edf3; white-space: pre; overflow: hidden; margin: 6px 0; }
</style></head><body><div class="win">
<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">ruff — zsh</span></div>
<div class="pad"><div id="term"></div></div>
<div id="overlay"><div class="card"><div class="head"><b>github-actions</b> bot commented on the pull request</div><div class="body">${commentHtml()}</div></div></div>
</div></body></html>`;

function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
    throw new Error('ffmpeg not found; set FFMPEG=/path/to/ffmpeg');
  }
}

const states = timeline();
const base = mkdtempSync(join(tmpdir(), 'whatbroke-demo-'));
try {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 400 },
    deviceScaleFactor: 1,
  });
  await page.setContent(PAGE);
  const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  await page.setViewportSize({ width: WIDTH, height: height + (height % 2) });
  const list = [];
  for (const [i, s] of states.entries()) {
    await page.evaluate(({ lines, cursor, overlay }) => {
      const out = lines.slice();
      if (cursor)
        out[out.length - 1] += `<span class="cur${cursor === 'off' ? ' off' : ''}"></span>`;
      const term = document.getElementById('term');
      term.innerHTML = out.join('\n');
      term.scrollTop = term.scrollHeight;
      document.getElementById('overlay').style.display = overlay ? 'block' : 'none';
    }, s);
    const file = join(base, `f${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: file });
    list.push(`file '${file}'`, `duration ${(s.ms / 1000).toFixed(2)}`);
  }
  await browser.close();
  list.push(`file '${join(base, `f${String(states.length - 1).padStart(4, '0')}.png`)}'`);
  writeFileSync(join(base, 'list.txt'), `${list.join('\n')}\n`);
  mkdirSync(dirname(OUT), { recursive: true });
  execFileSync(
    ffmpegPath(),
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(base, 'list.txt'),
      '-vf',
      'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-fps_mode',
      'vfr',
      '-loop',
      '0',
      OUT,
    ],
    { stdio: 'inherit' },
  );
  const secs = states.reduce((n, s) => n + s.ms, 0) / 1000;
  console.log(
    `wrote ${OUT} (${WIDTH}x${height}, ${states.length} frames, ${secs.toFixed(1)}s, ${(statSync(OUT).size / 1024).toFixed(0)} KB)`,
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
