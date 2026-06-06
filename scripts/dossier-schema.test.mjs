import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_VALUES,
  EVIDENCE_KIND_VALUES,
  isEvidenceUrl,
  validateEvidence,
  validateDossierEntry,
  validateDossier,
} from './lib/dossier-schema.mjs';

const evidence = { claim: 'netfilter UAF 수정', url: 'https://lore.kernel.org/x', kind: 'commit', quote: 'Fixes: deadbeef12345678' };
const entry = {
  candidateId: 'lore-lkml:abc',
  title: 'nft 세션 해제 회귀 수정',
  whatChanged: 'nft_ 경로의 use-after-free 를 닫습니다.',
  whyItMatters: 'netfilter 를 쓰는 모든 배포 라인에 영향이 갑니다.',
  affectedAudience: '네트워크 드라이버 담당자',
  impactType: 'regression',
  confidence: 'high',
  evidence: [evidence],
  openQuestions: ['stable 백포트 여부 미확인'],
};
const dossier = { topic: 'linux', date: '2026-06-06', generatedAt: '2026-06-06T00:00:00Z', adapter: 'template', entries: [entry] };

test('CONFIDENCE_VALUES / EVIDENCE_KIND_VALUES 고정', () => {
  assert.deepEqual([...CONFIDENCE_VALUES].sort(), ['high', 'low', 'medium']);
  assert.deepEqual([...EVIDENCE_KIND_VALUES].sort(), ['article', 'changelog', 'commit', 'cve', 'thread']);
});

test('isEvidenceUrl 은 http(s) 만 허용', () => {
  assert.equal(isEvidenceUrl('https://x'), true);
  assert.equal(isEvidenceUrl('http://x'), true);
  assert.equal(isEvidenceUrl('없음'), false);
  assert.equal(isEvidenceUrl(''), false);
  assert.equal(isEvidenceUrl(null), false);
});

test('정상 dossier 는 통과', () => {
  assert.doesNotThrow(() => validateDossier(dossier));
});

test('evidence URL 이 없는 claim 은 거부 (핵심 불변식)', () => {
  const noUrl = { claim: '근거 없는 주장', url: '없음', kind: 'commit' };
  assert.throws(() => validateEvidence(noUrl, 0, 'entries[0]'), /must be a real http\(s\) URL/);
});

test('entry 에 evidence 가 비면 거부', () => {
  const bad = { ...entry, evidence: [] };
  assert.throws(() => validateDossierEntry(bad, 0), /non-empty array/);
});

test('evidence.kind 가 허용 목록 밖이면 거부', () => {
  const bad = { ...evidence, kind: 'tweet' };
  assert.throws(() => validateEvidence(bad, 0, 'entries[0]'), /kind must be one of/);
});

test('quote 가 200자를 넘으면 거부', () => {
  const bad = { ...evidence, quote: 'x'.repeat(201) };
  assert.throws(() => validateEvidence(bad, 0, 'entries[0]'), /<= 200 chars/);
});

test('confidence 가 high/medium/low 외면 거부', () => {
  const bad = { ...entry, confidence: 'sure' };
  assert.throws(() => validateDossierEntry(bad, 0), /confidence must be high\/medium\/low/);
});

test('impactType 은 highlight-schema 값을 재사용', () => {
  const bad = { ...entry, impactType: 'misc' };
  assert.throws(() => validateDossierEntry(bad, 0), /impactType must be one of/);
  assert.doesNotThrow(() => validateDossierEntry({ ...entry, impactType: 'backport' }, 0));
});

test('필수 문자열 필드 누락은 키 이름까지 알려준다', () => {
  const bad = { ...entry, whatChanged: '' };
  assert.throws(() => validateDossierEntry(bad, 0), /whatChanged required/);
});

test('ctx 가 주어지면 에러 메시지에 prefix 가 붙는다', () => {
  assert.throws(() => validateDossierEntry({}, 1, 'research-linux'), /research-linux: entries\[1\]/);
});

test('entries 가 배열이 아니면 거부, 빈 배열은 허용', () => {
  assert.throws(() => validateDossier({ topic: 'linux', date: '2026-06-06', entries: 'no' }), /entries must be an array/);
  assert.doesNotThrow(() => validateDossier({ topic: 'linux', date: '2026-06-06', entries: [] }));
});

test('top-level topic/date 누락은 거부', () => {
  assert.throws(() => validateDossier({ date: '2026-06-06', entries: [] }), /topic required/);
  assert.throws(() => validateDossier({ topic: 'linux', entries: [] }), /date required/);
});

test('openQuestions 가 문자열 배열이 아니면 거부', () => {
  const bad = { ...entry, openQuestions: [42] };
  assert.throws(() => validateDossierEntry(bad, 0), /openQuestions must be an array of strings/);
});
