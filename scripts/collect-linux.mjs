import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const sourceConfigPath = path.join(root, 'content', 'topics', topic, 'sources.json');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

function requiredUrl(config, sourceId) {
  const source = config.sources.find((entry) => entry.id === sourceId && entry.enabled !== false);
  if (!source?.url) throw new Error(`Enabled source not found: ${sourceId}`);
  return source.url;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'dev-blog-collector/0.1 (+https://kernel.org metadata collector)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function releaseTitle(release) {
  const lifecycle = release.iseol ? ' · EOL' : '';
  return `Linux ${release.version} ${release.moniker}${lifecycle}`;
}

function releaseSummary(release) {
  const date = release.released?.isodate || 'unknown date';
  const eol = release.iseol ? ' 이 버전 라인은 EOL로 표시되어 후속 추적 시 주의가 필요합니다.' : '';
  return `kernel.org 기준 ${date}에 공개된 ${release.moniker} 릴리스입니다.${eol}`;
}

function normalizeKernelOrgRelease(release) {
  const primaryUrl = release.gitweb || release.changelog || release.source || 'https://www.kernel.org/';
  const links = [
    ['source', release.source],
    ['pgp', release.pgp],
    ['patch.full', release.patch?.full],
    ['patch.incremental', release.patch?.incremental],
    ['changelog', release.changelog],
    ['gitweb', release.gitweb],
    ['diffview', release.diffview],
  ]
    .filter(([, url]) => Boolean(url))
    .map(([kind, url]) => ({ kind, url }));

  return {
    id: `kernel-org:${release.moniker}:${release.version}`,
    topic,
    source: 'kernel.org',
    sourceId: 'kernel-org-releases',
    kind: 'kernel-release',
    observedDate: release.released?.isodate || null,
    collectedAt,
    title: releaseTitle(release),
    summary: releaseSummary(release),
    url: primaryUrl,
    links,
    tags: ['linux', 'kernel', release.moniker, release.iseol ? 'eol' : 'active'].filter(Boolean),
    metadata: {
      moniker: release.moniker,
      version: release.version,
      isEol: Boolean(release.iseol),
      releasedTimestamp: release.released?.timestamp || null,
    },
  };
}

async function main() {
  const config = await readJson(sourceConfigPath);
  const releasesUrl = requiredUrl(config, 'kernel-org-releases');
  const raw = await fetchJson(releasesUrl);

  if (!Array.isArray(raw.releases)) {
    throw new Error('kernel.org releases payload did not include releases[]');
  }

  const records = raw.releases
    .map(normalizeKernelOrgRelease)
    .sort((a, b) => String(b.observedDate).localeCompare(String(a.observedDate)) || a.id.localeCompare(b.id));

  const normalized = {
    topic,
    schemaVersion: 1,
    collectedAt,
    sourceCount: 1,
    recordCount: records.length,
    records,
  };

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const rawSnapshot = path.join(rawDir, `kernel-org-releases-${runId}.json`);
  const rawLatest = path.join(rawDir, 'kernel-org-releases-latest.json');
  const normalizedSnapshot = path.join(normalizedDir, `source-records-${runId}.json`);
  const normalizedLatest = path.join(normalizedDir, 'source-records-latest.json');

  await writeFile(rawSnapshot, JSON.stringify({ collectedAt, url: releasesUrl, payload: raw }, null, 2));
  await writeFile(rawLatest, JSON.stringify({ collectedAt, url: releasesUrl, payload: raw }, null, 2));
  await writeFile(normalizedSnapshot, JSON.stringify(normalized, null, 2));
  await writeFile(normalizedLatest, JSON.stringify(normalized, null, 2));

  const latestStable = raw.latest_stable?.version ? ` latest stable ${raw.latest_stable.version};` : '';
  console.log(`Collected ${records.length} kernel.org release record(s);${latestStable} wrote ${path.relative(root, normalizedLatest)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
