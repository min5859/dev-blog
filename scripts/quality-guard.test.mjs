import test from 'node:test';
import assert from 'node:assert/strict';

import { auditPostQuality } from './lib/quality-guard.mjs';

const basePost = {
  id: 'p',
  topic: 'linux',
  title: '테스트',
  summary: '요약',
  highlights: [
    {
      title: '항목',
      priority: '상',
      impactType: 'runtime',
      affectedAudience: '커널 개발자',
      verifyLink: 'https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/',
      action: '원문을 확인하세요.',
    },
  ],
  sections: [
    { heading: '핵심 변경', body: '- 항목\n  · 확인: https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/' },
  ],
  sources: [
    { title: '항목', url: 'https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/', note: 'lore · patch-discussion' },
  ],
};

test('auditPostQuality accepts URLs that appear in the input draft evidence', () => {
  const draft = {
    candidateBodies: [{ title: '항목', url: 'https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/' }],
    sources: [{ title: '항목', url: 'https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/' }],
  };
  const result = auditPostQuality(basePost, { draft });
  assert.deepEqual(result.critical, []);
});

test('auditPostQuality rejects URLs invented by rewrite output', () => {
  const draft = {
    candidateBodies: [{ title: '항목', url: 'https://lore.kernel.org/lkml/20260523000000.example-1-dev@example.com/' }],
  };
  const post = {
    ...basePost,
    highlights: [{ ...basePost.highlights[0], verifyLink: 'https://example.com/invented' }],
  };
  assert.throws(() => auditPostQuality(post, { draft }), /ungrounded URL/);
});

test('auditPostQuality can report ungrounded URLs without throwing in non-strict mode', () => {
  const result = auditPostQuality(basePost, { draft: { sources: [] }, strict: false });
  assert.equal(result.critical.length > 0, true);
  assert.match(result.critical[0], /ungrounded URL/);
});
