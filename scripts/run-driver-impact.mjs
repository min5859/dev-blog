#!/usr/bin/env node
// 커널 저장소에 새 -rc1·정식 태그가 생기면 드라이버 영향 노트를 만든다. daily-deploy.sh 가 매일 부르고
// 게시(commit/push)는 daily-deploy.sh 가 한다. 한 번에 태그 하나만 처리하고, 실패하면 다음 날 다시 시도한다.
// 새 태그가 없는 날은 kernel.org 버전 목록(releases.json)으로 최근 두 LTS 를 보고, 그 LTS → 다음 LTS 노트가
// 없으면 만든다. 웹에서는 버전 목록만 읽고 내용은 git 에서만 뽑는다.
//   DRIVER_IMPACT_REPO=/srv/linux-kernel/linux.git node scripts/run-driver-impact.mjs
// 저장소가 없으면(예: Mac) 아무것도 하지 않는다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ltsPair, pendingTags, postedRanges } from './lib/driver-impact.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const exec = promisify(execFile);
const repo = process.env.DRIVER_IMPACT_REPO;
const postsDir = path.join('content', 'topics', 'linux-driver-impact', 'posts');
const RELEASES_URL = 'https://www.kernel.org/releases.json';

async function posts() {
  const files = (await readdir(postsDir).catch(() => [])).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(postsDir, f), 'utf8'))));
}

async function releases() {
  const res = await fetch(RELEASES_URL, { headers: { 'user-agent': 'dev-blog-driver-impact' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).releases;
}

function run({ from, to }, lts) {
  const range = ['--from', from, '--to', to];
  // 수집 결과는 다 만든 뒤 한 번에 쓰므로, 있으면 전날 실패의 재시도에서 다시 수집하지 않는다.
  const raw = path.join('data', 'raw', 'driver-impact', `${from}..${to}.json`);
  return runPipeline({
    topic: 'linux-driver-impact',
    logTitle: `Linux driver impact ${from}..${to}${lts ? ' (LTS)' : ''}`,
    runDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
    steps: [
      ...(existsSync(raw) ? [] : [['collect', 'node', ['scripts/collect-driver-impact.mjs', '--repo', repo, ...range]]]),
      ['draft', 'node', ['scripts/draft-driver-impact.mjs', ...range, ...(lts ? ['--lts'] : [])]],
      ['build', 'npm', ['run', 'build']],
    ],
    extraStatus: { range: `${from}..${to}`, ...(lts ? { kind: 'lts' } : {}), outputs: { raw } },
  });
}

async function main() {
  if (!repo || !existsSync(repo)) {
    console.log(`[driver-impact] no kernel repo (${repo || 'DRIVER_IMPACT_REPO unset'}); skipped`);
    return;
  }
  await exec('git', ['-C', repo, 'fetch', '--quiet', '--tags', 'origin'], { maxBuffer: 1 << 26 });
  const tags = (await exec('git', ['-C', repo, 'tag', '-l', 'v*'], { maxBuffer: 1 << 26 })).stdout.split('\n').filter(Boolean);
  const posted = postedRanges(await posts());
  const [next] = pendingTags(tags, posted.done);
  if (next) return run(next, false);
  console.log('[driver-impact] no new -rc1 or release tag');

  let pair;
  try {
    pair = ltsPair(await releases(), tags);
  } catch (err) {
    console.log(`[driver-impact] LTS list unavailable: ${err.message}`); // 다음 날 다시 본다
    return;
  }
  if (!pair || posted.lts.has(`${pair.from}..${pair.to}`)) {
    console.log('[driver-impact] no new LTS pair');
    return;
  }
  return run(pair, true);
}

main().catch((err) => {
  console.error(`[driver-impact] ${err.stack || err.message}`);
  process.exitCode = 1;
});
