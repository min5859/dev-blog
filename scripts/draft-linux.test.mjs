import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRecord,
  stripPatchPrefix,
  patchVersion,
  mergePatchSeries,
  isStaleReply,
  isRegressionSignal,
} from './draft-linux.mjs';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function lkml(overrides = {}) {
  return {
    id: overrides.id || `lore-lkml:${Math.random()}`,
    sourceId: 'lore-lkml-new',
    kind: 'patch-discussion',
    title: '[PATCH] foo: do something',
    tags: ['linux', 'kernel', 'lkml'],
    metadata: { author: { name: 'Author', email: 'author@example.com' } },
    observedDate: '2026-05-07',
    ...overrides,
  };
}

test('scoreRecord boosts a mainline kernel.org release above 60', () => {
  const record = {
    id: 'kernel-org:mainline:7.1-rc2',
    sourceId: 'kernel-org-releases',
    title: 'Linux 7.1-rc2 mainline',
    tags: ['linux', 'kernel', 'mainline', 'active'],
    metadata: { moniker: 'mainline', version: '7.1-rc2' },
    observedDate: '2026-05-03',
  };
  const scored = scoreRecord(record);
  assert.ok(scored.score >= 60, `expected mainline score >= 60, got ${scored.score}`);
  assert.deepEqual(scored.matchedSubsystems, []);
});

test('scoreRecord recognizes a kernel subsystem slug in the title', () => {
  const scored = scoreRecord(lkml({ title: '[PATCH] sched/rt: Fix RT_PUSH_IPI soft lockup loop' }));
  assert.ok(
    scored.matchedSubsystems.includes('스케줄러/실시간'),
    `expected 스케줄러/실시간 in ${JSON.stringify(scored.matchedSubsystems)}`,
  );
});

test('mergePatchSeries keeps only the highest [PATCH vN] of a series', () => {
  const author = { email: 'author@example.com' };
  const records = [
    lkml({ id: 'a', title: '[PATCH v2 1/3] foo: do bar', metadata: { author } }),
    lkml({ id: 'b', title: '[PATCH v3 1/3] foo: do bar', metadata: { author } }),
    lkml({ id: 'c', title: '[PATCH v1 1/3] foo: do bar', metadata: { author } }),
  ];
  const merged = mergePatchSeries(records);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'b');
});

test('mergePatchSeries keeps unrelated records untouched', () => {
  const records = [
    lkml({ id: 'x', title: '[PATCH] alpha' }),
    lkml({ id: 'y', title: '[PATCH] beta' }),
    { id: 'kernel-org:1', sourceId: 'kernel-org-releases', title: 'Linux 7.0.4 stable', tags: [], metadata: { moniker: 'stable' } },
  ];
  const merged = mergePatchSeries(records);
  assert.equal(merged.length, 3);
});

test('patchVersion returns N from [PATCH vN] and 1 otherwise', () => {
  assert.equal(patchVersion({ title: '[PATCH v5 2/3] foo' }), 5);
  assert.equal(patchVersion({ title: '[PATCH] foo' }), 1);
  assert.equal(patchVersion({ title: 'Re: [PATCH v12 1/2] foo' }), 12);
});

test('stripPatchPrefix handles common LKML prefix shapes', () => {
  assert.equal(stripPatchPrefix('[PATCH net-next 08/12] dt-bindings: net: foo'), 'dt-bindings: net: foo');
  assert.equal(stripPatchPrefix('Re: [PATCH v3] foo: bar'), 'foo: bar');
  assert.equal(stripPatchPrefix('[GIT PULL] update: bar'), 'update: bar');
  assert.equal(stripPatchPrefix('[RFC v2] proposal: baz'), 'proposal: baz');
});

test('isRegressionSignal flags titles with regression/oops/cve markers', () => {
  assert.equal(isRegressionSignal(lkml({ title: '[PATCH] sched/rt: Fix RT_PUSH_IPI soft lockup loop' })), true);
  assert.equal(isRegressionSignal(lkml({ title: '[PATCH] mm: regression in folio_alloc' })), true);
  assert.equal(isRegressionSignal(lkml({ title: '[PATCH] x86: introduce new helper' })), false);
});

test('isStaleReply drops "Re:" mails older than 24 hours', () => {
  const now = Date.parse('2026-05-08T00:00:00Z');
  const stale = lkml({ kind: 'mail-reply', title: 'Re: [PATCH] foo', observedDate: '2026-05-05' });
  const fresh = lkml({ kind: 'mail-reply', title: 'Re: [PATCH] foo', observedDate: '2026-05-07' });
  assert.equal(isStaleReply(stale, now), true);
  assert.equal(isStaleReply(fresh, now - ONE_DAY_MS / 2), false);
});

test('isStaleReply ignores non-LKML records and non-replies', () => {
  const release = { sourceId: 'kernel-org-releases', title: 'Linux 7.1-rc2 mainline', kind: 'kernel-release', observedDate: '2026-05-03' };
  assert.equal(isStaleReply(release), false);
  const patch = lkml({ kind: 'patch-discussion', title: '[PATCH v2] foo' });
  assert.equal(isStaleReply(patch), false);
});
