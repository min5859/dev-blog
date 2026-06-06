import test from 'node:test';
import assert from 'node:assert/strict';

import { dossierToPost } from './lib/dossier-to-post.mjs';
import { validateHighlights } from './lib/highlight-schema.mjs';

const ev = (url, kind = 'commit') => ({ claim: 'c', url, kind });
const dossier = {
  topic: 'linux',
  date: '2026-06-06',
  entries: [
    { candidateId: 'a', title: 'mainline RC', whatChanged: '새 RC', whyItMatters: '머지윈도우', affectedAudience: 'mainline 추적자', impactType: 'release', confidence: 'high', evidence: [ev('https://k/rc', 'changelog')] },
    { candidateId: 'b', title: 'netfilter UAF', whatChanged: 'UAF 수정', whyItMatters: '보안', affectedAudience: '네트워크 담당자', impactType: 'security', confidence: 'high', evidence: [ev('https://lore/b')] },
    { candidateId: 'c', title: 'mm folio', whatChanged: 'folio 정리', whyItMatters: 'MM', affectedAudience: 'MM 담당자', impactType: 'runtime', confidence: 'low', evidence: [ev('https://lore/c')] },
  ],
};

const post = dossierToPost(dossier, { postId: '2026-06-06-linux-daily-briefing', date: '2026-06-06' });

test('필수 post 필드를 모두 채운다', () => {
  for (const k of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    assert.ok(post[k], `missing ${k}`);
  }
  assert.equal(post.id, '2026-06-06-linux-daily-briefing');
  assert.equal(post.topic, 'linux');
});

test('sections 는 고정 4개 heading', () => {
  assert.deepEqual(post.sections.map((s) => s.heading), ['릴리스/로드맵', '회귀·보안 신호', '핵심 변경', '기타']);
});

test('highlights 는 highlight-schema 를 통과한다', () => {
  assert.doesNotThrow(() => validateHighlights(post.highlights, 'dossierToPost'));
});

test('security/regression entry 가 highlights 최상단으로 정렬된다', () => {
  assert.equal(post.highlights[0].impactType, 'security');
});

test('impactType 에 따라 섹션이 배치된다', () => {
  const rel = post.sections.find((s) => s.heading === '릴리스/로드맵').body;
  const sec = post.sections.find((s) => s.heading === '회귀·보안 신호').body;
  assert.match(rel, /mainline RC/);
  assert.match(sec, /netfilter UAF/);
});

test('모든 verifyLink/sources url 은 dossier evidence url 에서만 온다 (grounding)', () => {
  const evidenceUrls = new Set(dossier.entries.flatMap((e) => e.evidence.map((x) => x.url)));
  for (const h of post.highlights) {
    if (h.verifyLink !== '없음') assert.ok(evidenceUrls.has(h.verifyLink), `ungrounded ${h.verifyLink}`);
  }
  for (const s of post.sources) {
    assert.ok(evidenceUrls.has(s.url), `ungrounded source ${s.url}`);
  }
});

test('confidence=low entry 는 priority 가 상이 되지 않는다', () => {
  const low = post.highlights.find((h) => h.title === 'mm folio');
  assert.notEqual(low.priority, '상');
});

test('빈 분류 섹션은 안내 문구로 채운다', () => {
  const minimal = dossierToPost({ topic: 'linux', date: '2026-06-06', entries: [dossier.entries[1]] }, { postId: 'x', date: '2026-06-06' });
  assert.match(minimal.sections.find((s) => s.heading === '릴리스/로드맵').body, /해당 항목이 없습니다/);
  assert.match(minimal.sections.find((s) => s.heading === '기타').body, /제외했습니다/);
});
