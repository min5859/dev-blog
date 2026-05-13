import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { markPublishOk } from './lib/write-status.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'write-status-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('파일이 없으면 ok=true 새로 만든다', async () => {
  await withTempDir(async (logDir) => {
    const r = await markPublishOk({ topic: 'linux', runDate: '2026-05-14', logDir });
    assert.equal(r.created, true);
    const data = JSON.parse(await readFile(r.file, 'utf8'));
    assert.equal(data.topic, 'linux');
    assert.equal(data.runDate, '2026-05-14');
    assert.equal(data.ok, true);
    assert.ok(data.manualRepublishedAt);
    assert.deepEqual(data.steps, []);
  });
});

test('같은 runDate면 ok로 in-place 갱신, publish step만 ok=true로 패치', async () => {
  await withTempDir(async (logDir) => {
    const file = path.join(logDir, 'linux-latest-status.json');
    await writeFile(file, JSON.stringify({
      topic: 'linux',
      runDate: '2026-05-14',
      startedAt: '2026-05-13T22:00:00Z',
      finishedAt: '2026-05-13T22:00:53Z',
      ok: false,
      steps: [
        { name: 'collect', ok: true, code: 0 },
        { name: 'draft', ok: true, code: 0 },
        { name: 'rewrite', ok: true, code: 0 },
        { name: 'publish', ok: false, code: 1, stderr: 'highlights[0].action required' },
      ],
    }, null, 2));

    const r = await markPublishOk({ topic: 'linux', runDate: '2026-05-14', logDir });
    assert.equal(r.created, false);
    assert.equal(r.replaced, false);
    const data = JSON.parse(await readFile(r.file, 'utf8'));
    assert.equal(data.ok, true);
    assert.equal(data.steps.length, 4);
    assert.equal(data.steps[3].name, 'publish');
    assert.equal(data.steps[3].ok, true);
    assert.equal(data.steps[3].code, 0);
    assert.equal(data.steps[0].ok, true); // 다른 step 손대지 않음
    assert.ok(data.manualRepublishedAt);
    assert.notEqual(data.finishedAt, '2026-05-13T22:00:53Z'); // 갱신됨
  });
});

test('다른 runDate면 새로 (replaced=true)', async () => {
  await withTempDir(async (logDir) => {
    const file = path.join(logDir, 'linux-latest-status.json');
    await writeFile(file, JSON.stringify({
      topic: 'linux',
      runDate: '2026-05-13',
      ok: false,
      steps: [{ name: 'publish', ok: false }],
    }, null, 2));

    const r = await markPublishOk({ topic: 'linux', runDate: '2026-05-14', logDir });
    assert.equal(r.replaced, true);
    const data = JSON.parse(await readFile(r.file, 'utf8'));
    assert.equal(data.runDate, '2026-05-14');
    assert.equal(data.ok, true);
    assert.deepEqual(data.steps, []);
  });
});

test('publishedPath를 주면 outputs.post에 기록', async () => {
  await withTempDir(async (logDir) => {
    const r = await markPublishOk({
      topic: 'android',
      runDate: '2026-05-14',
      logDir,
      publishedPath: 'content/topics/android/posts/2026-05-14-android-daily-briefing.json',
    });
    const data = JSON.parse(await readFile(r.file, 'utf8'));
    assert.equal(data.outputs.post, 'content/topics/android/posts/2026-05-14-android-daily-briefing.json');
  });
});

test('필수 인자 누락 시 throw', async () => {
  await assert.rejects(() => markPublishOk({}), /required/);
  await assert.rejects(() => markPublishOk({ topic: 'x' }), /required/);
  await assert.rejects(() => markPublishOk({ topic: 'x', runDate: '2026-05-14' }), /required/);
});
