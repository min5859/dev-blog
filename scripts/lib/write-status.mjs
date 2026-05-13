/**
 * `logs/daily/{topic}-latest-status.json` 을 갱신한다. 정상 흐름(run-daily-*.mjs)
 * 에서는 그쪽이 status 전체를 다시 쓰지만, *수동으로 publish 만 호출한 복구 흐름*
 * 에서는 status 가 갱신되지 않아 사이트 카드가 옛 실패 상태로 동결된다 — 이를 막기
 * 위한 작은 in-place 갱신 헬퍼.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function tryReadJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.runDate YYYY-MM-DD
 * @param {string} args.logDir 절대 경로 (보통 `<root>/logs/daily`)
 * @param {string} [args.publishedPath] 게시 결과 파일 상대경로 — 기록만, 검증은 안 함
 * @returns {Promise<{file: string, created: boolean, replaced: boolean}>}
 */
export async function markPublishOk({ topic, runDate, logDir, publishedPath = null }) {
  if (!topic || !runDate || !logDir) {
    throw new Error('markPublishOk: topic/runDate/logDir required');
  }
  await mkdir(logDir, { recursive: true });
  const file = path.join(logDir, `${topic}-latest-status.json`);
  const existing = await tryReadJson(file);
  const finishedAt = new Date().toISOString();

  let next;
  let replaced = false;
  let created = false;

  if (existing && existing.runDate === runDate) {
    // 같은 날짜 — publish step만 ok로 마크하고 ok/finishedAt 갱신
    const steps = (existing.steps || []).map((s) => (s.name === 'publish' ? { ...s, ok: true, code: 0 } : s));
    next = {
      ...existing,
      ok: true,
      finishedAt,
      manualRepublishedAt: finishedAt,
      steps,
    };
    if (publishedPath) {
      next.outputs = { ...(existing.outputs || {}), post: publishedPath };
    }
  } else {
    // 다른 날짜이거나 파일 없음 — 새 status 생성
    if (existing) replaced = true;
    else created = true;
    next = {
      topic,
      runDate,
      startedAt: finishedAt,
      finishedAt,
      ok: true,
      manualRepublishedAt: finishedAt,
      steps: [],
    };
    if (publishedPath) {
      next.outputs = { post: publishedPath };
    }
  }

  await writeFile(file, JSON.stringify(next, null, 2));
  return { file, created, replaced };
}
