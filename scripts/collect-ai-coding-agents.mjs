import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'ai-coding-agents';
const sourceConfigPath = path.join(root, 'content', 'topics', topic, 'sources.json');
const rawDir = path.join(root, 'data', 'raw', topic);
const normalizedDir = path.join(root, 'data', 'normalized', topic);
const collectedAt = new Date().toISOString();
const runId = collectedAt.slice(0, 10);

const USER_AGENT = 'dev-blog-collector/0.1 (+ai-coding-agents briefing)';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fetchResponse(url, accept) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response;
}

async function fetchText(url) {
  return fetchResponse(url, 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain').then((r) => r.text());
}

async function fetchJson(url) {
  return fetchResponse(url, 'application/json').then((r) => r.json());
}

function decodeXml(value = '') {
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

function stripTags(value = '') {
  return decodeXml(value.replaceAll(/<[^>]+>/g, ' ')).replaceAll(/\s+/g, ' ').trim();
}

function firstMatch(block, pattern) {
  return block.match(pattern)?.[1]?.trim() || null;
}

function parseDateToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseAtomEntries(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((entry) => {
    const content = firstMatch(entry, /<content\b[^>]*>([\s\S]*?)<\/content>/);
    const summary = firstMatch(entry, /<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    return {
      id: decodeXml(firstMatch(entry, /<id>([\s\S]*?)<\/id>/) || ''),
      title: decodeXml(firstMatch(entry, /<title\b[^>]*>([\s\S]*?)<\/title>/) || ''),
      updated: firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/),
      url: decodeXml(firstMatch(entry, /<link\b[^>]*href="([^"]+)"[^>]*\/>/) || firstMatch(entry, /<link>([\s\S]*?)<\/link>/) || ''),
      excerpt: stripTags(content || summary || '').slice(0, 700),
    };
  });
}

function parseRssItems(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((item) => {
    const cdataTitle = firstMatch(item, /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const plainTitle = firstMatch(item, /<title>([\s\S]*?)<\/title>/);
    const cdataDesc = firstMatch(item, /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const plainDesc = firstMatch(item, /<description>([\s\S]*?)<\/description>/);
    const cdataContent = firstMatch(item, /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
    const rawContent = cdataContent || cdataDesc || plainDesc || '';
    return {
      id: decodeXml(firstMatch(item, /<guid\b[^>]*>([\s\S]*?)<\/guid>/) || ''),
      title: decodeXml(cdataTitle || plainTitle || ''),
      pubDate: firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/),
      url: decodeXml(firstMatch(item, /<link>([\s\S]*?)<\/link>/) || ''),
      excerpt: stripTags(rawContent).slice(0, 700),
    };
  });
}

function normalizeAtomEntry(entry, source) {
  const observedDate = parseDateToIso(entry.updated) || runId;
  return {
    id: `${source.id}:${entry.id || entry.url}`,
    topic,
    source: source.id,
    sourceId: source.id,
    kind: source.kind || 'release',
    observedDate,
    collectedAt,
    title: entry.title,
    summary: entry.excerpt.slice(0, 200) || entry.title,
    url: entry.url,
    publishedAt: entry.updated || null,
    tags: [topic, ...(source.tags || [])],
    body: entry.excerpt,
  };
}

function normalizeRssItem(item, source) {
  const observedDate = parseDateToIso(item.pubDate) || runId;
  return {
    id: `${source.id}:${item.id || item.url}`,
    topic,
    source: source.id,
    sourceId: source.id,
    kind: source.kind || 'blog-post',
    observedDate,
    collectedAt,
    title: item.title,
    summary: item.excerpt.slice(0, 200) || item.title,
    url: item.url,
    publishedAt: item.pubDate || null,
    tags: [topic, ...(source.tags || [])],
    body: item.excerpt,
  };
}

async function collectAtom(source) {
  const xml = await fetchText(source.url);
  await writeFile(path.join(rawDir, `${source.id}-${runId}.xml`), xml);
  await writeFile(path.join(rawDir, `${source.id}-latest.xml`), xml);
  const entries = parseAtomEntries(xml).slice(0, source.limit || 10);
  const records = entries.map((e) => normalizeAtomEntry(e, source)).filter((r) => r.url);
  console.log(`  ${source.id}: ${records.length} atom entries`);
  return { sourceId: source.id, records };
}

async function collectRss(source) {
  const xml = await fetchText(source.url);
  await writeFile(path.join(rawDir, `${source.id}-${runId}.xml`), xml);
  await writeFile(path.join(rawDir, `${source.id}-latest.xml`), xml);
  let items = parseRssItems(xml);

  if (source.contentFilter && source.contentFilter.length > 0) {
    const filters = source.contentFilter.map((f) => f.toLowerCase());
    items = items.filter((item) => {
      const text = `${item.title} ${item.excerpt}`.toLowerCase();
      return filters.some((f) => text.includes(f));
    });
  }

  items = items.slice(0, source.limit || 15);
  const records = items.map((i) => normalizeRssItem(i, source)).filter((r) => r.url);
  console.log(`  ${source.id}: ${records.length} rss items`);
  return { sourceId: source.id, records };
}

async function collectHnAlgoliaSearch(source) {
  const queries = source.queries || [];
  const hitsPerQuery = source.hitsPerQuery || 8;
  const seen = new Set();
  const records = [];

  for (const query of queries) {
    const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${hitsPerQuery}&query=${encodeURIComponent(query)}`;
    let raw;
    try {
      raw = await fetchJson(url);
    } catch (e) {
      console.warn(`  hn-algolia-search: failed query "${query}": ${e.message}`);
      continue;
    }
    for (const hit of (raw.hits || [])) {
      if (seen.has(hit.objectID)) continue;
      seen.add(hit.objectID);
      const itemUrl = hit.url || hit.story_url;
      if (!itemUrl) continue;
      const observedDate = parseDateToIso(hit.created_at) || runId;
      records.push({
        id: `hn:${hit.objectID}`,
        topic,
        source: 'hn.algolia.com',
        sourceId: source.id,
        kind: 'hn-discussion',
        observedDate,
        collectedAt,
        title: hit.title || '(제목 없음)',
        summary: `HN: ${hit.points || 0}점, 댓글 ${hit.num_comments || 0}개`,
        url: itemUrl,
        publishedAt: hit.created_at || null,
        tags: [topic, 'hn', source.id],
        body: `HN 스토리: "${hit.title}". ${hit.points || 0}점, 댓글 ${hit.num_comments || 0}개. 검색 키워드: "${query}". URL: ${itemUrl}`,
        metadata: {
          points: hit.points || 0,
          numComments: hit.num_comments || 0,
          hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          author: hit.author || null,
          searchQuery: query,
        },
      });
    }
  }

  const limited = records.slice(0, source.limit || 20);
  const rawPayload = { collectedAt, queries, records: limited };
  await writeFile(path.join(rawDir, `${source.id}-${runId}.json`), JSON.stringify(rawPayload, null, 2));
  await writeFile(path.join(rawDir, `${source.id}-latest.json`), JSON.stringify(rawPayload, null, 2));
  console.log(`  ${source.id}: ${limited.length} hn stories (${queries.length} queries)`);
  return { sourceId: source.id, records: limited };
}

async function main() {
  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const config = await readJson(sourceConfigPath);
  const collectionResults = [];

  for (const source of config.sources.filter((s) => s.enabled !== false)) {
    console.log(`Collecting ${source.id} (${source.type})...`);
    try {
      if (source.type === 'atom') {
        collectionResults.push(await collectAtom(source));
      } else if (source.type === 'rss' || source.type === 'rss-filtered') {
        collectionResults.push(await collectRss(source));
      } else if (source.type === 'hn-algolia-search') {
        collectionResults.push(await collectHnAlgoliaSearch(source));
      } else {
        console.warn(`  Skipping unsupported source type: ${source.type}`);
      }
    } catch (e) {
      console.warn(`  ${source.id} failed: ${e.message}`);
      collectionResults.push({ sourceId: source.id, records: [], error: e.message });
    }
  }

  const deduped = new Map();
  for (const { records } of collectionResults) {
    for (const r of records) {
      if (!deduped.has(r.id)) deduped.set(r.id, r);
    }
  }
  const records = [...deduped.values()];

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
  console.log(`Collected ${records.length} records total (${summary})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
