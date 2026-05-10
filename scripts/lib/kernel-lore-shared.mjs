import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function decodeXml(value = '') {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#38;', '&')
    .replaceAll('&amp;', '&');
}

export function stripTags(value = '') {
  return decodeXml(value.replaceAll(/<[^>]+>/g, ' ')).replaceAll(/\s+/g, ' ').trim();
}

export function firstMatch(block, pattern) {
  return block.match(pattern)?.[1]?.trim() || null;
}

export function parseAtomEntries(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
  return entries.map((entry) => {
    const authorBlock = firstMatch(entry, /<author>([\s\S]*?)<\/author>/);
    const content = firstMatch(entry, /<content\b[^>]*>([\s\S]*?)<\/content>/);
    return {
      id: decodeXml(firstMatch(entry, /<id>([\s\S]*?)<\/id>/) || ''),
      title: decodeXml(firstMatch(entry, /<title>([\s\S]*?)<\/title>/) || ''),
      updated: firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/),
      url: decodeXml(firstMatch(entry, /<link\b[^>]*href="([^"]+)"[^>]*\/>/) || ''),
      author: authorBlock
        ? {
            name: decodeXml(firstMatch(authorBlock, /<name>([\s\S]*?)<\/name>/) || ''),
            email: decodeXml(firstMatch(authorBlock, /<email>([\s\S]*?)<\/email>/) || ''),
          }
        : null,
      inReplyTo: decodeXml(firstMatch(entry, /<thr:in-reply-to\b[^>]*href="([^"]+)"[^>]*\/>/) || ''),
      excerpt: stripTags(content || '').slice(0, 700),
    };
  });
}

export function observedDateFromIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function loreListKeyFromUrl(url) {
  const match = String(url).match(/lore\.kernel\.org\/([^/]+)\//i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function classifyLoreEntry(entry) {
  const title = entry.title.toLowerCase();
  if (title.includes('[patch')) return 'patch-discussion';
  if (title.startsWith('re:')) return 'mail-reply';
  if (title.includes('[git pull')) return 'pull-request';
  return 'mail-discussion';
}

export function normalizeLoreEntry({ topic, sourceId, listKey }, entry, collectedAt) {
  const author = entry.author?.name || entry.author?.email || 'unknown author';
  const isReply = entry.title.toLowerCase().startsWith('re:');
  const sourceLabel = `lore.kernel.org/${listKey}`;
  return {
    id: `lore-${listKey}:${entry.id || entry.url}`,
    topic,
    source: sourceLabel,
    sourceId,
    kind: classifyLoreEntry(entry),
    observedDate: observedDateFromIso(entry.updated),
    collectedAt,
    title: entry.title,
    summary: `${author}의 ${listKey} 메일링 리스트 ${isReply ? '응답/토론' : '글'}입니다. 제목과 원문 링크를 기준으로 후속 요약 단계에서 영향도를 판별합니다.`,
    url: entry.url,
    links: [
      { kind: 'message', url: entry.url },
      entry.inReplyTo ? { kind: 'in-reply-to', url: entry.inReplyTo } : null,
    ].filter(Boolean),
    tags: [topic, 'kernel', listKey, isReply ? 'reply' : 'thread', classifyLoreEntry(entry)].filter(Boolean),
    metadata: {
      author: entry.author,
      updated: entry.updated,
      inReplyTo: entry.inReplyTo || null,
      excerpt: entry.excerpt,
      loreList: listKey,
    },
  };
}

export function releaseTitle(release) {
  const lifecycle = release.iseol ? ' · EOL' : '';
  return `Linux ${release.version} ${release.moniker}${lifecycle}`;
}

export function releaseSummary(release) {
  const date = release.released?.isodate || 'unknown date';
  const eol = release.iseol ? ' 이 버전 라인은 EOL로 표시되어 후속 추적 시 주의가 필요합니다.' : '';
  return `kernel.org 기준 ${date}에 공개된 ${release.moniker} 릴리스입니다.${eol}`;
}

export function normalizeKernelOrgRelease(topic, release, collectedAt) {
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
    tags: [topic, 'kernel', release.moniker, release.iseol ? 'eol' : 'active'].filter(Boolean),
    metadata: {
      moniker: release.moniker,
      version: release.version,
      isEol: Boolean(release.iseol),
      releasedTimestamp: release.released?.timestamp || null,
    },
  };
}

export function sourceById(config, sourceId) {
  const source = config.sources.find((entry) => entry.id === sourceId && entry.enabled !== false);
  if (!source?.url) throw new Error(`Enabled source not found: ${sourceId}`);
  return source;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function fetchResponse(url, accept) {
  const response = await fetch(url, {
    headers: {
      accept,
      'user-agent': 'dev-blog-collector/0.1 (+https://kernel.org and lore.kernel.org metadata collector)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function fetchJson(url) {
  return fetchResponse(url, 'application/json').then((response) => response.json());
}

export async function fetchText(url) {
  return fetchResponse(url, 'application/atom+xml, application/xml, text/xml, text/plain').then((response) => response.text());
}

export async function collectKernelOrgTopic({ config, topic, rawDir, collectedAt, runId }) {
  const source = sourceById(config, 'kernel-org-releases');
  const raw = await fetchJson(source.url);

  if (!Array.isArray(raw.releases)) {
    throw new Error('kernel.org releases payload did not include releases[]');
  }

  const records = raw.releases.map((release) => normalizeKernelOrgRelease(topic, release, collectedAt));
  await writeFile(path.join(rawDir, `kernel-org-releases-${runId}.json`), JSON.stringify({ collectedAt, url: source.url, payload: raw }, null, 2));
  await writeFile(path.join(rawDir, 'kernel-org-releases-latest.json'), JSON.stringify({ collectedAt, url: source.url, payload: raw }, null, 2));

  const latestStable = raw.latest_stable?.version ? ` latest stable ${raw.latest_stable.version};` : '';
  return { sourceId: source.id, latestStable, records };
}

export async function collectLoreAtomTopic({ source, topic, rawDir, collectedAt, runId }) {
  const raw = await fetchText(source.url);
  const listKey = loreListKeyFromUrl(source.url);
  const limit = Number(source.limit || 50);
  const entries = parseAtomEntries(raw).slice(0, limit);
  const records = entries.map((entry) => normalizeLoreEntry({ topic, sourceId: source.id, listKey }, entry, collectedAt));

  const safeSlug = String(source.id).replaceAll(/[^\w-]+/g, '_');
  await writeFile(path.join(rawDir, `${safeSlug}-${runId}.atom`), raw);
  await writeFile(path.join(rawDir, `${safeSlug}-latest.atom`), raw);

  return { sourceId: source.id, records };
}

export async function writeNormalizedBundle({ normalizedDir, topic, collectedAt, collectionResults }) {
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

  const runId = collectedAt.slice(0, 10);
  const normalizedSnapshot = path.join(normalizedDir, `source-records-${runId}.json`);
  const normalizedLatest = path.join(normalizedDir, 'source-records-latest.json');
  await mkdir(normalizedDir, { recursive: true });
  await writeFile(normalizedSnapshot, JSON.stringify(normalized, null, 2));
  await writeFile(normalizedLatest, JSON.stringify(normalized, null, 2));

  return { normalized, normalizedLatest, records, runId };
}
