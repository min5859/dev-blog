import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gcCursorChats } from './lib/cursor-chat-gc.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 7, 22, 12);

async function addSession(root, workspace, id, {
  cwd,
  ageDays,
  bytes = 32,
  invalidMeta = false,
  noMeta = false,
}) {
  const dir = path.join(root, workspace, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'store.db'), Buffer.alloc(bytes));
  if (!noMeta) {
    const body = invalidMeta
      ? '{broken'
      : JSON.stringify({ cwd, createdAtMs: NOW_MS - ageDays * DAY_MS });
    await writeFile(path.join(dir, 'meta.json'), body);
  }
  const timestamp = new Date(NOW_MS - ageDays * DAY_MS);
  await utimes(path.join(dir, 'store.db'), timestamp, timestamp);
  if (!noMeta) await utimes(path.join(dir, 'meta.json'), timestamp, timestamp);
  await utimes(dir, timestamp, timestamp);
  return dir;
}

test('dry-run selects only expired sessions for the exact cwd', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-chat-gc-'));
  const target = '/work/dev-blog';
  try {
    const expired = await addSession(root, 'workspace-a', 'expired', {
      cwd: target, ageDays: 8, bytes: 64,
    });
    await addSession(root, 'workspace-a', 'recent', { cwd: target, ageDays: 2 });
    await addSession(root, 'workspace-b', 'other', { cwd: '/work/other', ageDays: 30 });
    await addSession(root, 'workspace-a', 'invalid', { ageDays: 30, invalidMeta: true });
    await addSession(root, 'workspace-a', 'orphan', { ageDays: 30, noMeta: true });

    const result = await gcCursorChats({
      cwd: target, retentionDays: 7, chatRoot: root, dryRun: true, nowMs: NOW_MS,
    });

    assert.equal(result.removedSessions, 1);
    assert.ok(result.reclaimedBytes >= 64);
    assert.equal(result.matchedSessions, 2);
    assert.equal(result.skippedInvalidMetadata, 2);
    assert.equal((await readFile(path.join(expired, 'store.db'))).length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GC removes expired matching sessions and preserves recent or unrelated sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-chat-gc-'));
  const target = '/work/dev-blog';
  try {
    const expired = await addSession(root, 'workspace-a', 'expired', {
      cwd: target, ageDays: 10,
    });
    const recent = await addSession(root, 'workspace-a', 'recent', {
      cwd: target, ageDays: 1,
    });
    const unrelated = await addSession(root, 'workspace-b', 'unrelated', {
      cwd: '/work/other', ageDays: 20,
    });

    const result = await gcCursorChats({
      cwd: target, retentionDays: 7, chatRoot: root, nowMs: NOW_MS,
    });

    assert.equal(result.removedSessions, 1);
    await assert.rejects(readFile(path.join(expired, 'store.db')), { code: 'ENOENT' });
    assert.ok((await readFile(path.join(recent, 'store.db'))).length > 0);
    assert.ok((await readFile(path.join(unrelated, 'store.db'))).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GC rejects negative retention periods', async () => {
  await assert.rejects(
    gcCursorChats({ cwd: '/work/dev-blog', retentionDays: -1 }),
    /non-negative/,
  );
});
