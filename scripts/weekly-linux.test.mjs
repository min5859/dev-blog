import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoWeek,
  templateWeekly,
  validateWeekly,
  normalizeSubject,
  looselyMatches,
  collectTrackedSubjects,
  findMergedSeries,
} from './weekly-linux.mjs';

test('isoWeek returns ISO 8601 year and week for a Monday', () => {
  // 2026-05-04 is Monday of week 19
  const out = isoWeek('2026-05-04');
  assert.equal(out.year, 2026);
  assert.equal(out.week, 19);
});

test('isoWeek matches across days within the same week', () => {
  const monday = isoWeek('2026-05-04');
  const sunday = isoWeek('2026-05-10');
  assert.deepEqual(monday, sunday);
});

test('isoWeek wraps year-end edge case (2026-01-04 is W1)', () => {
  const out = isoWeek('2026-01-04');
  assert.equal(out.year, 2026);
  assert.equal(out.week, 1);
});

test('templateWeekly produces a schema-valid post even with sparse highlights', () => {
  const dailies = [
    { date: '2026-05-04', summary: 'mainline 7.1-rc2', highlights: [{ title: 'x', priority: '상', verifyLink: 'https://x', action: 'check' }], sources: [{ title: 's', url: 'https://s', note: 'kernel.org · kernel-release' }] },
    { date: '2026-05-05', summary: 'stable 7.0.5', highlights: [{ title: 'y', priority: '중', verifyLink: 'https://y', action: 'check' }], sources: [] },
    { date: '2026-05-06', summary: 'tun/tap series', highlights: [], sources: [] },
  ];
  const meta = { id: '2026-W19-linux-weekly', date: '2026-05-11', year: 2026, week: 19 };
  const post = templateWeekly(dailies, meta);
  validateWeekly(post, meta);
  assert.equal(post.draftMetadata.year, 2026);
  assert.equal(post.draftMetadata.week, 19);
  assert.deepEqual(post.draftMetadata.coveredDates, ['2026-05-04', '2026-05-05', '2026-05-06']);
});

test('normalizeSubject strips Re: and bracket prefixes', () => {
  assert.equal(normalizeSubject('Re: [PATCH v3 1/5] sched/rt: Fix RT_PUSH_IPI soft lockup'),
    'sched/rt: fix rt_push_ipi soft lockup');
});

test('looselyMatches catches identical colon-prefixed subjects despite [PATCH] noise', () => {
  assert.equal(looselyMatches(
    '[PATCH v3 1/5] sched/rt: Fix RT_PUSH_IPI soft lockup loop',
    'sched/rt: Fix RT_PUSH_IPI soft lockup loop',
  ), true);
});

test('looselyMatches refuses very short subjects to avoid false positives', () => {
  assert.equal(looselyMatches('mm: foo', 'mm: bar'), false);
});

test('findMergedSeries returns one entry per tracked subject', () => {
  const tracked = ['sched/rt: Fix RT_PUSH_IPI soft lockup', 'mm: introduce something specific'];
  const commits = [
    { title: 'sched/rt: Fix RT_PUSH_IPI soft lockup loop', url: 'https://x/a', updated: '2026-05-08T12:00:00Z' },
    { title: 'unrelated cleanup', url: 'https://x/b', updated: '2026-05-08T13:00:00Z' },
    { title: 'sched/rt: Fix RT_PUSH_IPI soft lockup loop', url: 'https://x/c', updated: '2026-05-09T08:00:00Z' },
  ];
  const merges = findMergedSeries(tracked, commits);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].trackedSubject, 'sched/rt: Fix RT_PUSH_IPI soft lockup');
});

test('collectTrackedSubjects pulls from highlights and lore sources', () => {
  const dailies = [
    {
      highlights: [{ title: 'foo: bar' }],
      sources: [
        { title: 'foo: bar', url: 'https://lore.kernel.org/lkml/1', note: 'lore.kernel.org/lkml · patch-discussion' },
        { title: 'Linux 7.0.5 stable', url: 'https://kernel.org/x', note: 'kernel.org · kernel-release' },
      ],
    },
  ];
  const subs = collectTrackedSubjects(dailies);
  assert.ok(subs.includes('foo: bar'));
  assert.ok(!subs.includes('Linux 7.0.5 stable'));
});

test('validateWeekly rejects mismatching id', () => {
  const meta = { id: '2026-W19-linux-weekly', date: '2026-05-11', year: 2026, week: 19 };
  const dailies = [
    { date: '2026-05-04', summary: 's', highlights: [{ title: 'x', priority: '상', verifyLink: 'https://x', action: 'check' }], sources: [] },
    { date: '2026-05-05', summary: 's', highlights: [{ title: 'y', priority: '중', verifyLink: 'https://y', action: 'check' }], sources: [] },
    { date: '2026-05-06', summary: 's', highlights: [{ title: 'z', priority: '하', verifyLink: 'https://z', action: 'check' }], sources: [] },
  ];
  const post = templateWeekly(dailies, meta);
  post.id = 'bogus-id';
  assert.throws(() => validateWeekly(post, meta), /id.*does not match/);
});
