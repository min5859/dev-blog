import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyDossier } from './lib/research-runner.mjs';

function withFetch(text, ok = true) {
  return async () => ({ ok, text: async () => text });
}
const entry = (confidence, quote) => ({
  candidateId: 'a',
  confidence,
  evidence: [{ claim: 'c', url: 'https://x', kind: 'thread', quote }],
});

test('verifyDossier: 인용 미발견 시 confidence 강등 + openQuestions (C)', async () => {
  const orig = global.fetch;
  global.fetch = withFetch('완전히 무관한 본문');
  try {
    const d = { entries: [entry('high', 'this exact quote string')] };
    await verifyDossier(d, { perUrlTimeoutMs: 50 });
    assert.equal(d.entries[0].confidence, 'medium');
    assert.equal(d.entries[0].evidence[0].verified, false);
    assert.ok((d.entries[0].openQuestions || []).some((q) => /검증 실패/.test(q)));
    assert.equal(d.verifiedDowngradeCount, 1);
  } finally {
    global.fetch = orig;
  }
});

test('verifyDossier: 인용 발견 시 confidence 유지 (C)', async () => {
  const orig = global.fetch;
  global.fetch = withFetch('앞부분 ... this exact quote string appears here ... 뒷부분');
  try {
    const d = { entries: [entry('high', 'this exact quote string')] };
    await verifyDossier(d, { perUrlTimeoutMs: 50 });
    assert.equal(d.entries[0].confidence, 'high');
    assert.equal(d.entries[0].evidence[0].verified, true);
    assert.equal(d.verifiedDowngradeCount, 0);
  } finally {
    global.fetch = orig;
  }
});

test('verifyDossier: quote 없는 evidence 는 검증 스킵 (강등 안 함)', async () => {
  const orig = global.fetch;
  let called = 0;
  global.fetch = async () => { called += 1; return { ok: true, text: async () => '' }; };
  try {
    const d = { entries: [{ candidateId: 'a', confidence: 'high', evidence: [{ claim: 'c', url: 'https://x', kind: 'thread' }] }] };
    await verifyDossier(d, { perUrlTimeoutMs: 50 });
    assert.equal(d.entries[0].confidence, 'high');
    assert.equal(called, 0); // quote 없으면 fetch 안 함
  } finally {
    global.fetch = orig;
  }
});

test('verifyDossier: fetch 실패는 강등이지 throw 아님 (best-effort)', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('network'); };
  try {
    const d = { entries: [entry('medium', 'some quote text here')] };
    await assert.doesNotReject(verifyDossier(d, { perUrlTimeoutMs: 50 }));
    assert.equal(d.entries[0].confidence, 'low'); // medium → low
  } finally {
    global.fetch = orig;
  }
});
