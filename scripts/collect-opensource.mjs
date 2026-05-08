import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'opensource';
const sourceConfigPath = path.join(root, 'content', 'topics', topic, 'sources.json');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

const USER_AGENT = 'dev-blog-collector/0.1 (+opensource trending)';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fetchJson(url, accept = 'application/json') {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isoDateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function buildGithubQuery(params) {
  const parts = [];
  if (params.starsMin) parts.push(`stars:>${params.starsMin}`);
  if (params.createdWithinDays) parts.push(`created:>${isoDateNDaysAgo(params.createdWithinDays)}`);
  if (params.pushedWithinDays) parts.push(`pushed:>${isoDateNDaysAgo(params.pushedWithinDays)}`);
  if (params.languageIn) parts.push(`language:${params.languageIn}`);
  return parts.join(' ');
}

function normalizeRepo(item, source) {
  return {
    id: `gh:${item.full_name}`,
    topic,
    source: 'github.com',
    sourceId: source.id,
    kind: 'repo',
    observedDate: collectedAt.slice(0, 10),
    collectedAt,
    title: item.full_name,
    summary: item.description || '',
    url: item.html_url,
    links: [
      { kind: 'repo', url: item.html_url },
      ...(item.homepage ? [{ kind: 'homepage', url: item.homepage }] : []),
    ],
    tags: ['github', source.id, item.language].filter(Boolean),
    metadata: {
      fullName: item.full_name,
      description: item.description || '',
      stars: item.stargazers_count,
      forks: item.forks_count,
      watchers: item.watchers_count,
      openIssues: item.open_issues_count,
      language: item.language,
      license: item.license?.spdx_id || null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      pushedAt: item.pushed_at,
      topics: item.topics || [],
      owner: item.owner?.login,
    },
  };
}

async function collectGithubSearch(source) {
  const q = buildGithubQuery(source.params || {});
  if (!q) throw new Error(`source ${source.id} requires search params`);
  const sort = source.params?.sort || 'stars';
  const order = source.params?.order || 'desc';
  const perPage = Math.min(Number(source.limit || 30), 100);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&per_page=${perPage}`;
  const raw = await fetchJson(url, 'application/vnd.github+json');
  if (!Array.isArray(raw.items)) throw new Error(`GitHub search payload missing items[] for ${source.id}`);
  await writeFile(path.join(rawDir, `${source.id}-${runId}.json`), JSON.stringify({ collectedAt, url, payload: raw }, null, 2));
  await writeFile(path.join(rawDir, `${source.id}-latest.json`), JSON.stringify({ collectedAt, url, payload: raw }, null, 2));
  return { sourceId: source.id, records: raw.items.map((item) => normalizeRepo(item, source)) };
}

function extractGithubRepoFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('github.com')) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/, '');
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    if (['orgs', 'sponsors', 'topics', 'collections', 'features', 'about'].includes(owner)) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

async function fetchRepoDetails(fullName) {
  try {
    return await fetchJson(`https://api.github.com/repos/${fullName}`, 'application/vnd.github+json');
  } catch {
    return null;
  }
}

async function collectHnFrontpage(source) {
  const url = source.url || 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50';
  const raw = await fetchJson(url);
  await writeFile(path.join(rawDir, `${source.id}-${runId}.json`), JSON.stringify({ collectedAt, url, payload: raw }, null, 2));
  await writeFile(path.join(rawDir, `${source.id}-latest.json`), JSON.stringify({ collectedAt, url, payload: raw }, null, 2));

  const seen = new Set();
  const records = [];
  for (const hit of (raw.hits || []).slice(0, source.limit || 30)) {
    const fullName = extractGithubRepoFromUrl(hit.url);
    if (!fullName || seen.has(fullName)) continue;
    seen.add(fullName);
    const details = await fetchRepoDetails(fullName);
    if (!details) continue;
    const record = normalizeRepo(details, source);
    record.metadata.hn = {
      points: hit.points,
      numComments: hit.num_comments,
      title: hit.title,
      hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      createdAt: hit.created_at,
    };
    record.kind = 'hn-trending';
    record.tags = [...new Set([...(record.tags || []), 'hn-frontpage', 'trending'])];
    records.push(record);
  }
  return { sourceId: source.id, records };
}

function dedupeByFullName(records) {
  const merged = new Map();
  for (const record of records) {
    const key = record.metadata?.fullName || record.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, record);
      continue;
    }
    const merged_record = { ...existing };
    if (record.metadata?.hn && !existing.metadata?.hn) {
      merged_record.metadata = { ...existing.metadata, hn: record.metadata.hn };
      merged_record.kind = 'hn-trending';
      merged_record.tags = [...new Set([...(existing.tags || []), ...(record.tags || []), 'hn-frontpage', 'trending'])];
      merged_record.sourceId = `${existing.sourceId}+${record.sourceId}`;
    }
    merged.set(key, merged_record);
  }
  return [...merged.values()];
}

async function main() {
  const config = await readJson(sourceConfigPath);
  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const collectionResults = [];
  for (const source of config.sources) {
    if (source.enabled === false) continue;
    if (source.type === 'github-search') {
      collectionResults.push(await collectGithubSearch(source));
    } else if (source.type === 'hn-algolia') {
      collectionResults.push(await collectHnFrontpage(source));
    } else {
      console.warn(`Skipping unsupported opensource source type ${source.type} (${source.id})`);
    }
  }

  const records = dedupeByFullName(collectionResults.flatMap((result) => result.records))
    .sort((a, b) => (b.metadata?.stars || 0) - (a.metadata?.stars || 0));

  const normalized = {
    topic,
    schemaVersion: 1,
    collectedAt,
    sourceCount: collectionResults.length,
    recordCount: records.length,
    records,
  };
  await writeFile(path.join(normalizedDir, `source-records-${runId}.json`), JSON.stringify(normalized, null, 2));
  await writeFile(path.join(normalizedDir, 'source-records-latest.json'), JSON.stringify(normalized, null, 2));

  const summary = collectionResults.map((r) => `${r.sourceId} ${r.records.length}`).join('; ');
  console.log(`Collected ${records.length} unique opensource record(s); ${summary}; wrote data/normalized/${topic}/source-records-latest.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
