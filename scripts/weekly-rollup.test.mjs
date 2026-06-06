import test from 'node:test';
import assert from 'node:assert/strict';

import { datesBack, collectWeeklyDossier } from './lib/weekly-rollup.mjs';
import { validateDossier } from './lib/dossier-schema.mjs';

test('datesBack 은 endDate 부터 역순 N일', () => {
  assert.deepEqual(datesBack('2026-06-06', 3), ['2026-06-06', '2026-06-05', '2026-06-04']);
});

const ev = (url) => ({ claim: 'c', url, kind: 'thread' });
const mkEntry = (id, conf, impact) => ({
  candidateId: id, title: id, whatChanged: 'w', whyItMatters: 'y',
  affectedAudience: 'a', impactType: impact, confidence: conf, evidence: [ev(`https://x/${id}`)],
});

// 가짜 일자별 dossier: 06-06 에 A(high), 06-05 에 A(low, 구버전)+B(medium), 06-04 없음
const fixtures = {
  '2026-06-06': JSON.stringify({ topic: 'linux', date: '2026-06-06', entries: [mkEntry('A', 'high', 'security')] }),
  '2026-06-05': JSON.stringify({ topic: 'linux', date: '2026-06-05', entries: [mkEntry('A', 'low', 'security'), mkEntry('B', 'medium', 'release')] }),
};
const readFileImpl = async (date) => {
  if (fixtures[date]) return fixtures[date];
  throw new Error('ENOENT');
};

test('같은 candidateId 는 최신 일자 항목으로 dedup', async () => {
  const d = await collectWeeklyDossier('/x', '2026-06-06', { days: 7, readFileImpl });
  const a = d.entries.find((e) => e.candidateId === 'A');
  assert.equal(a.confidence, 'high'); // 06-06(high)이 06-05(low)를 이김
  assert.equal(d.entries.length, 2); // A, B
});

test('confidence 순으로 정렬되고 schema-valid', async () => {
  const d = await collectWeeklyDossier('/x', '2026-06-06', { days: 7, readFileImpl });
  assert.equal(d.entries[0].candidateId, 'A'); // high 가 medium 보다 앞
  assert.equal(d.adapter, 'weekly-rollup');
  assert.doesNotThrow(() => validateDossier(d, 'weekly'));
});

test('limit 으로 상위만 추린다', async () => {
  const big = {};
  for (let i = 0; i < 12; i += 1) big[`2026-06-${String(6 - (i % 6)).padStart(2, '0')}`] = JSON.stringify({
    topic: 'linux', date: 'x', entries: [mkEntry(`E${i}`, 'medium', 'runtime')],
  });
  const d = await collectWeeklyDossier('/x', '2026-06-06', { days: 7, limit: 3, readFileImpl: async (dt) => big[dt] || (() => { throw new Error('no'); })() });
  assert.ok(d.entries.length <= 3);
});

test('dossier 가 하나도 없으면 빈 entries (graceful)', async () => {
  const d = await collectWeeklyDossier('/x', '2026-06-06', { days: 7, readFileImpl: async () => { throw new Error('ENOENT'); } });
  assert.equal(d.entries.length, 0);
  assert.equal(d.rollup.daysCovered, 0);
  assert.doesNotThrow(() => validateDossier(d, 'weekly-empty'));
});

test('seenBefore/_date 메타는 주간 dossier 에서 제거된다', async () => {
  const withMeta = async () => JSON.stringify({ topic: 'linux', date: '2026-06-06', entries: [{ ...mkEntry('A', 'high', 'security'), seenBefore: true }] });
  const d = await collectWeeklyDossier('/x', '2026-06-06', { days: 1, readFileImpl: withMeta });
  assert.equal(d.entries[0].seenBefore, undefined);
  assert.equal(d.entries[0]._date, undefined);
});
