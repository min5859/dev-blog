import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readJson } from './lib/collect-utils.mjs';

const root = process.cwd();
const topic = 'android';
const sourceConfigPath = path.join(root, 'content', 'topics', topic, 'sources.json');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

const ANDROID_PREFIX_PATTERN = /^(ANDROID|FROMGIT|FROMLIST|BACKPORT|UPSTREAM):/;

function sourceById(config, sourceId) {
  const source = config.sources.find((entry) => entry.id === sourceId && entry.enabled !== false);
  if (!source?.url) throw new Error(`Enabled Android source not found: ${sourceId}`);
  return source;
}

async function fetchGitilesJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'dev-blog-collector/0.1 (+android-common-kernel)',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const stripped = text.startsWith(")]}'\n") ? text.slice(5) : text.replace(/^\)\]\}'\s*/, '');
  return JSON.parse(stripped);
}

function classifyAndroidPrefix(message) {
  const match = message.match(ANDROID_PREFIX_PATTERN);
  if (!match) return null;
  return match[1].toLowerCase();
}

function commitSubject(commit) {
  return (commit.message || '').split('\n')[0].trim();
}

function commitObservedDate(commit) {
  const ts = commit.committer?.time || commit.author?.time;
  if (!ts) return null;
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeAckCommit(commit, source) {
  const subject = commitSubject(commit);
  const kind = classifyAndroidPrefix(subject);
  const sha = commit.commit;
  return {
    id: `ack-${source.branch}:${sha}`,
    topic,
    source: 'android.googlesource.com',
    sourceId: source.id,
    kind: kind ? `ack-${kind}` : 'ack-merge',
    observedDate: commitObservedDate(commit),
    collectedAt,
    title: subject,
    summary: `${source.branch} 브랜치 커밋입니다. 본문 첫 줄과 commit body로 영향 범위를 판별합니다.`,
    url: `https://android.googlesource.com/kernel/common/+/${sha}`,
    links: [
      { kind: 'commit', url: `https://android.googlesource.com/kernel/common/+/${sha}` },
      { kind: 'tree', url: `https://android.googlesource.com/kernel/common/+/${sha}^!/` },
    ],
    tags: ['android', 'ack', source.branch, kind || 'merge'].filter(Boolean),
    metadata: {
      branch: source.branch,
      sha,
      shaShort: sha.slice(0, 12),
      author: commit.author ? { name: commit.author.name, email: commit.author.email } : null,
      committer: commit.committer ? { name: commit.committer.name, email: commit.committer.email } : null,
      subject,
      bodyExcerpt: (commit.message || '').split('\n').slice(1, 12).join('\n').trim().slice(0, 1200),
    },
  };
}

async function collectAckBranch(source) {
  const raw = await fetchGitilesJson(source.url);
  if (!Array.isArray(raw.log)) throw new Error(`gitiles payload missing log[] for ${source.id}`);
  const limit = Number(source.limit || raw.log.length);
  const commits = raw.log.slice(0, limit);
  const records = commits.map((commit) => normalizeAckCommit(commit, source));

  await writeFile(path.join(rawDir, `${source.id}-${runId}.json`), JSON.stringify({ collectedAt, url: source.url, payload: raw }, null, 2));
  await writeFile(path.join(rawDir, `${source.id}-latest.json`), JSON.stringify({ collectedAt, url: source.url, payload: raw }, null, 2));

  return { sourceId: source.id, branch: source.branch, records };
}

async function main() {
  const config = await readJson(sourceConfigPath);
  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const collectionResults = [];
  for (const source of config.sources) {
    if (source.enabled === false) continue;
    if (source.type !== 'gitiles-json') {
      console.warn(`Skipping unsupported Android source type ${source.type} (${source.id})`);
      continue;
    }
    collectionResults.push(await collectAckBranch(sourceById(config, source.id)));
  }

  const records = collectionResults
    .flatMap((result) => result.records)
    .sort((a, b) => String(b.observedDate).localeCompare(String(a.observedDate)) || a.id.localeCompare(b.id));

  const normalized = {
    topic,
    schemaVersion: 1,
    collectedAt,
    sourceCount: collectionResults.length,
    recordCount: records.length,
    records,
  };

  const normalizedSnapshot = path.join(normalizedDir, `source-records-${runId}.json`);
  const normalizedLatest = path.join(normalizedDir, 'source-records-latest.json');
  await writeFile(normalizedSnapshot, JSON.stringify(normalized, null, 2));
  await writeFile(normalizedLatest, JSON.stringify(normalized, null, 2));

  const summary = collectionResults
    .map((result) => `${result.sourceId} ${result.records.length}`)
    .join('; ');
  console.log(`Collected ${records.length} Android source record(s); ${summary}; wrote ${path.relative(root, normalizedLatest)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
