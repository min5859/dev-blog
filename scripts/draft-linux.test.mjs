import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRecord,
  stripPatchPrefix,
  patchVersion,
  mergePatchSeries,
  isStaleReply,
  isRegressionSignal,
  isBroadImpact,
  extractCommitMessage,
  summarizeChangelog,
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

test('isRegressionSignal does not flag generic Fix patches', () => {
  assert.equal(isRegressionSignal(lkml({ title: '[PATCH] usb: serial: Fix typo in device list' })), false);
  assert.equal(isRegressionSignal(lkml({ title: '[PATCH v2] iio: adc: ad4691: Fix vref handling' })), false);
});

test('scoreRecord recognizes the 전력 관리 subsystem', () => {
  const scored = scoreRecord(lkml({ title: '[PATCH] cpufreq: tune intel_pstate response' }));
  assert.ok(scored.matchedSubsystems.includes('전력 관리'),
    `expected 전력 관리 in ${JSON.stringify(scored.matchedSubsystems)}`);
});

test('isBroadImpact keeps releases, regressions, and broad-subsystem LKML records', () => {
  const release = { sourceId: 'kernel-org-releases', title: 'Linux 7.1-rc2 mainline', tags: [], metadata: { moniker: 'mainline' }, matchedSubsystems: [] };
  assert.equal(isBroadImpact(release), true);

  const regression = scoreRecord(lkml({ title: '[PATCH] mm: regression in folio_alloc' }));
  assert.equal(isBroadImpact(regression), true);

  const sched = scoreRecord(lkml({ title: '[PATCH] sched: rebalance fix' }));
  assert.equal(isBroadImpact(sched), true);
});

test('isBroadImpact filters out localized-only LKML records', () => {
  const driverOnly = scoreRecord(lkml({ title: '[PATCH] drivers/usb: serial: tweak mxuport' }));
  assert.equal(isBroadImpact(driverOnly), false);

  const archOnly = scoreRecord(lkml({ title: '[PATCH] arm64: dts: apple: add t8122' }));
  assert.equal(isBroadImpact(archOnly), false);

  const unmatched = scoreRecord(lkml({ title: '[PATCH] coresight: refactor helper' }));
  assert.equal(isBroadImpact(unmatched), false);
});

test('isStaleReply drops "Re:" mails older than 24 hours', () => {
  const now = Date.parse('2026-05-08T00:00:00Z');
  const stale = lkml({ kind: 'mail-reply', title: 'Re: [PATCH] foo', observedDate: '2026-05-05' });
  const fresh = lkml({ kind: 'mail-reply', title: 'Re: [PATCH] foo', observedDate: '2026-05-07' });
  assert.equal(isStaleReply(stale, now), true);
  assert.equal(isStaleReply(fresh, now - ONE_DAY_MS / 2), false);
});

test('extractCommitMessage strips mail headers, diffs, and trailing tags', () => {
  const sample = [
    'From: Dev <dev@example.com>',
    'Subject: [PATCH] mm: tighten folio_alloc validation',
    'Date: Fri, 09 May 2026 12:00:00 +0000',
    '',
    'When folio_alloc is called with order > MAX_PAGE_ORDER it silently',
    'returns NULL. Reject the call and warn so callers notice.',
    '',
    'Signed-off-by: Dev <dev@example.com>',
    'Reviewed-by: Reviewer <r@example.com>',
    '---',
    ' mm/page_alloc.c | 5 +++++',
    ' 1 file changed, 5 insertions(+)',
    '',
    'diff --git a/mm/page_alloc.c b/mm/page_alloc.c',
    '+++ a/mm/page_alloc.c',
  ].join('\n');
  const out = extractCommitMessage(sample);
  assert.match(out, /folio_alloc/);
  assert.match(out, /MAX_PAGE_ORDER/);
  assert.doesNotMatch(out, /Signed-off-by/);
  assert.doesNotMatch(out, /diff --git/);
  assert.doesNotMatch(out, /mm\/page_alloc\.c \| 5/);
});

test('extractCommitMessage handles missing header section gracefully', () => {
  const out = extractCommitMessage('plain body without headers');
  assert.equal(out, 'plain body without headers');
});

test('extractCommitMessage caps output length', () => {
  const big = 'h: subject\n\n' + 'a'.repeat(5000);
  const out = extractCommitMessage(big);
  assert.ok(out.length <= 2400);
});

test('summarizeChangelog extracts subjects and skips Linux X.Y.Z header', () => {
  const sample = [
    'commit aaaaaaa',
    'Author: Greg KH <greg@example>',
    'Date:   Mon May 1 12:00:00 2026',
    '',
    '    Linux 7.0.5',
    '',
    'commit bbbbbbb',
    'Author: Some Dev <s@x>',
    'Date:   Mon May 1 11:00:00 2026',
    '',
    '    netfilter: fix double-free in nf_tables',
    '',
    '    [Backport upstream commit ...]',
    '',
    'commit ccccccc',
    'Author: Other Dev <o@x>',
    'Date:   Mon May 1 10:00:00 2026',
    '',
    '    cifs: prevent UAF on session disconnect',
    '',
  ].join('\n');
  const out = summarizeChangelog(sample);
  assert.match(out, /netfilter: fix double-free/);
  assert.match(out, /cifs: prevent UAF/);
  assert.doesNotMatch(out, /^- Linux 7\.0\.5/m);
  assert.match(out, /총 2건/);
});

test('summarizeChangelog returns empty string for non-changelog input', () => {
  assert.equal(summarizeChangelog(''), '');
  assert.equal(summarizeChangelog('not a git log'), '');
});

test('isStaleReply ignores non-LKML records and non-replies', () => {
  const release = { sourceId: 'kernel-org-releases', title: 'Linux 7.1-rc2 mainline', kind: 'kernel-release', observedDate: '2026-05-03' };
  assert.equal(isStaleReply(release), false);
  const patch = lkml({ kind: 'patch-discussion', title: '[PATCH v2] foo' });
  assert.equal(isStaleReply(patch), false);
});
