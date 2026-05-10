import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { curationDataDir } from './opensource-curation/paths.mjs';

const root = process.cwd();
const topic = 'opensource-curation';
const curationRoot = process.env.OPENSOURCE_CURATION_ROOT || curationDataDir;
const reposPath = path.join(curationRoot, 'repos.json');
const analysisDirResolved = path.join(curationRoot, 'analysis');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

function analysisFileBase(fullName) {
  return fullName.replaceAll('/', '_');
}

async function tryReadAnalysisExcerpt(fullName) {
  const file = path.join(analysisDirResolved, `${analysisFileBase(fullName)}.md`);
  try {
    const text = await readFile(file, 'utf8');
    const trimmed = text.trim().slice(0, 1200);
    return { hasAnalysis: true, analysisPath: file, analysisExcerpt: trimmed };
  } catch {
    return { hasAnalysis: false, analysisPath: null, analysisExcerpt: '' };
  }
}

function normalizeRepoItem(item, analysisMeta) {
  const fullName = item.full_name;
  return {
    id: `gh:${fullName}`,
    topic,
    source: 'opensource-curation',
    sourceId: item.source || 'opensource-curation',
    kind: 'repo',
    observedDate: collectedAt.slice(0, 10),
    collectedAt,
    title: fullName,
    summary: item.description || '',
    url: item.url || `https://github.com/${fullName}`,
    links: [{ kind: 'repo', url: item.url || `https://github.com/${fullName}` }],
    tags: ['github', 'opensource-curation', item.language].filter(Boolean),
    metadata: {
      fullName,
      description: item.description || '',
      stars: item.stars ?? 0,
      forks: item.forks ?? 0,
      watchers: item.watchers ?? 0,
      openIssues: item.open_issues ?? null,
      language: item.language || null,
      license: item.license || null,
      createdAt: item.created_at || null,
      updatedAt: null,
      pushedAt: item.pushed_at || null,
      topics: item.topics || [],
      owner: item.owner,
      archived: item.archived === true,
      curationScore: typeof item.score === 'number' ? item.score : null,
      curationPickSource: item.source || null,
      hasAnalysis: analysisMeta.hasAnalysis,
      analysisPath: analysisMeta.analysisPath,
      analysisExcerpt: analysisMeta.analysisExcerpt,
    },
  };
}

async function main() {
  const payloadText = await readFile(reposPath, 'utf8');
  const repos = JSON.parse(payloadText);
  if (!Array.isArray(repos)) {
    throw new Error(`${reposPath} must be a JSON array of repos`);
  }

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const rawSnapshot = { collectedAt, curationRoot, reposPath, count: repos.length, repos };
  await writeFile(path.join(rawDir, `repos-${runId}.json`), JSON.stringify(rawSnapshot, null, 2));
  await writeFile(path.join(rawDir, 'repos-latest.json'), JSON.stringify(rawSnapshot, null, 2));

  const records = [];
  for (const item of repos) {
    if (!item?.full_name) continue;
    const analysisMeta = await tryReadAnalysisExcerpt(item.full_name);
    records.push(normalizeRepoItem(item, analysisMeta));
  }

  const normalized = {
    topic,
    schemaVersion: 1,
    collectedAt,
    curationRoot,
    recordCount: records.length,
    records,
  };
  await writeFile(path.join(normalizedDir, `source-records-${runId}.json`), JSON.stringify(normalized, null, 2));
  await writeFile(path.join(normalizedDir, 'source-records-latest.json'), JSON.stringify(normalized, null, 2));

  const withAnalysis = records.filter((r) => r.metadata?.hasAnalysis).length;
  console.log(`Collected ${records.length} opensource-curation repo(s) (${withAnalysis} with analysis) from ${curationRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
