import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  collectKernelOrgTopic,
  collectLoreAtomTopic,
  readJson,
  writeNormalizedBundle,
} from './lib/kernel-lore-shared.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/collect-lore-lens.mjs <topicId>');
  process.exit(1);
}

const sourceConfigPath = path.join(root, 'content', 'topics', topic, 'sources.json');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

async function main() {
  const config = await readJson(sourceConfigPath);
  if (config.topic !== topic) {
    throw new Error(`${path.relative(root, sourceConfigPath)}: topic field must be "${topic}"`);
  }

  await mkdir(rawDir, { recursive: true });

  const collectionResults = [];
  for (const source of config.sources) {
    if (source.enabled === false) continue;
    if (!source.id || !source.url) throw new Error(`sources.json: source requires id and url (${source.id})`);
    if (source.type === 'json' && source.id === 'kernel-org-releases') {
      collectionResults.push(await collectKernelOrgTopic({ config, topic, rawDir, collectedAt, runId }));
    } else if (source.type === 'atom') {
      collectionResults.push(await collectLoreAtomTopic({ source, topic, rawDir, collectedAt, runId }));
    } else {
      throw new Error(`Unsupported source type: ${source.type} (${source.id})`);
    }
  }

  if (!collectionResults.length) {
    throw new Error('No enabled sources in sources.json');
  }

  const { normalizedLatest, records } = await writeNormalizedBundle({
    normalizedDir,
    topic,
    collectedAt,
    collectionResults,
  });

  const counts = collectionResults.map((r) => `${r.sourceId}:${r.records.length}`).join(', ');
  const kernel = collectionResults.find((r) => r.sourceId === 'kernel-org-releases');
  const extra = kernel?.latestStable || '';
  console.log(`Collected ${records.length} record(s) for ${topic} [${counts}]${extra} wrote ${path.relative(root, normalizedLatest)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
