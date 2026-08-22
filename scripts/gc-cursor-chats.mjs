#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBytes, gcCursorChats } from './lib/cursor-chat-gc.mjs';

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    retentionDays: 7,
    chatRoot: process.env.CURSOR_CHAT_ROOT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--cwd') {
      options.cwd = argv[++i];
    } else if (arg === '--retention-days') {
      options.retentionDays = Number(argv[++i]);
    } else if (arg === '--chat-root') {
      options.chatRoot = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await gcCursorChats(options);
  const action = options.dryRun ? 'would remove' : 'removed';
  console.log(
    `[cursor-chat-gc] ${action} ${result.removedSessions} session(s), `
    + `${formatBytes(result.reclaimedBytes)}; matched ${result.matchedSessions}, `
    + `scanned ${result.scannedSessions}, skipped invalid metadata ${result.skippedInvalidMetadata}`,
  );
  return result;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[cursor-chat-gc] ${error.message}`);
    process.exitCode = 1;
  });
}
