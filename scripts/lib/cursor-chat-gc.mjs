import { readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MIB = 1024 * 1024;

function asTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function allocatedBytes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await allocatedBytes(item);
    } else if (entry.isFile()) {
      total += (await stat(item)).size;
    }
  }
  return total;
}

async function latestSessionTimestamp(sessionDir, meta) {
  let latest = Math.max(
    asTimestamp(meta.createdAtMs),
    asTimestamp(meta.updatedAtMs),
    (await stat(sessionDir)).mtimeMs,
  );
  for (const name of ['meta.json', 'store.db']) {
    try {
      latest = Math.max(latest, (await stat(path.join(sessionDir, name))).mtimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return latest;
}

export function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

export async function gcCursorChats({
  cwd,
  retentionDays = 7,
  chatRoot = path.join(os.homedir(), '.cursor', 'chats'),
  dryRun = false,
  nowMs = Date.now(),
} = {}) {
  if (!cwd) throw new Error('cwd is required');
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('retentionDays must be a non-negative number');
  }

  const targetCwd = path.resolve(cwd);
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const result = {
    scannedSessions: 0,
    matchedSessions: 0,
    removedSessions: 0,
    reclaimedBytes: 0,
    skippedInvalidMetadata: 0,
  };

  let workspaces;
  try {
    workspaces = await readdir(chatRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(chatRoot, workspace.name);
    const sessions = await readdir(workspaceDir, { withFileTypes: true });
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      result.scannedSessions += 1;
      const sessionDir = path.join(workspaceDir, session.name);
      let meta;
      try {
        meta = JSON.parse(await readFile(path.join(sessionDir, 'meta.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        result.skippedInvalidMetadata += 1;
        continue;
      }
      if (typeof meta.cwd !== 'string' || path.resolve(meta.cwd) !== targetCwd) continue;
      result.matchedSessions += 1;
      if (await latestSessionTimestamp(sessionDir, meta) >= cutoffMs) continue;

      const bytes = await allocatedBytes(sessionDir);
      if (!dryRun) await rm(sessionDir, { recursive: true, force: false });
      result.removedSessions += 1;
      result.reclaimedBytes += bytes;
    }
  }

  return result;
}
