import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeek, templateWeekly, validateWeekly } from './weekly-linux.mjs';

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
