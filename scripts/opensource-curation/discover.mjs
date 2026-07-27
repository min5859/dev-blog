import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  curationDataDir,
  historyJson,
  loadConfig,
  logsDir,
  reposJson,
} from './paths.mjs';

const GITHUB_API = 'https://api.github.com';

// GitHub 트렌딩이 종종 중국어권 레포를 잡아오는데, 그대로 rewrite 되면 quality-guard 의
// FOREIGN_CJK 검사(scripts/lib/quality-guard.mjs)에 걸려 topic 전체가 게시 누락된다.
// discover 단계에서 미리 걸러내기 위한 비한글 CJK 비율 임계값.
const FOREIGN_CJK_MAX_RATIO = 0.15;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(message);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, 'discover.log'), line).catch(() => {});
}

function githubHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dev-blog-opensource-curation/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchGithubSearch(lookbackDays, minStars, categories) {
  const since = isoDateDaysAgo(lookbackDays);
  const queries = categories.length
    ? categories.map((c) => `stars:>=${minStars} pushed:>=${since} topic:${c}`)
    : [`stars:>=${minStars} pushed:>=${since}`];

  const merged = new Map();
  for (const q of queries) {
    for (let page = 1; page <= 3; page += 1) {
      const url = new URL(`${GITHUB_API}/search/repositories`);
      url.searchParams.set('q', q);
      url.searchParams.set('sort', 'stars');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', '50');
      url.searchParams.set('page', String(page));
      try {
        const res = await fetch(url, { headers: githubHeaders() });
        if (!res.ok) {
          await logLine(`warning: GitHub Search failed ${res.status} q=${q} page=${page}`);
          break;
        }
        const data = await res.json();
        const items = data.items || [];
        if (!items.length) break;
        for (const item of items) {
          const fullName = item.full_name;
          if (merged.has(fullName)) continue;
          merged.set(fullName, {
            full_name: fullName,
            owner: item.owner.login,
            name: item.name,
            description: item.description || '',
            stars: item.stargazers_count,
            forks: item.forks_count,
            language: item.language || '',
            topics: item.topics || [],
            url: item.html_url,
            pushed_at: item.pushed_at || '',
            created_at: item.created_at || '',
            source: 'github_search',
          });
        }
        await sleep(1000);
      } catch (e) {
        await logLine(`warning: GitHub Search request error q=${q} page=${page}: ${e.message}`);
        break;
      }
    }
  }
  return [...merged.values()];
}

function parseTrendingStars(text) {
  const t = text.replace(/,/g, '').trim();
  if (!t) return 0;
  const km = t.match(/^([\d.]+)\s*k$/i);
  if (km) return Math.round(parseFloat(km[1]) * 1000);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

async function fetchGithubTrending() {
  const repos = [];
  try {
    const res = await fetch('https://github.com/trending', {
      headers: { 'User-Agent': 'dev-blog-opensource-curation/1.0' },
    });
    if (!res.ok) {
      await logLine(`warning: GitHub Trending HTTP ${res.status}`);
      return repos;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    $('article.Box-row').each((_, article) => {
      const h2a = $(article).find('h2 a').first();
      const href = h2a.attr('href');
      if (!href) return;
      const pathPart = href.replace(/^\//, '');
      const parts = pathPart.split('/');
      if (parts.length !== 2) return;
      const [owner, name] = parts;
      const descEl = $(article).find('p').first();
      const description = descEl.text().trim();
      const starEl = $(article).find("a[href$='/stargazers']").first();
      const stars = parseTrendingStars(starEl.text());
      const langEl = $(article).find("[itemprop='programmingLanguage']").first();
      const language = langEl.text().trim();
      repos.push({
        full_name: `${owner}/${name}`,
        owner,
        name,
        description,
        stars,
        forks: 0,
        language,
        topics: [],
        url: `https://github.com/${owner}/${name}`,
        pushed_at: '',
        created_at: '',
        source: 'github_trending',
      });
    });
  } catch (e) {
    await logLine(`warning: GitHub Trending scraping failed: ${e.message}`);
  }
  return repos;
}

async function loadHistory() {
  try {
    const raw = await readFile(historyJson, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveHistory(history) {
  await mkdir(curationDataDir, { recursive: true });
  await writeFile(historyJson, JSON.stringify([...history].sort(), null, 2));
}

// quality-guard.mjs 의 FOREIGN_CJK 와 동일한 문자클래스(히라가나+가타카나+한자).
// 한글(가-힣)은 분자에 들지 않으므로, 한자가 드문드문 섞인 한국어 제목/설명은 오탐하지 않는다.
const FOREIGN_CJK_RE = /[぀-ゟ゠-ヿ一-鿿]/g;

/**
 * 공백을 제외한 전체 글자 수 대비 비한글 CJK(가나+한자) 글자 수 비율(0~1).
 * @param {string} text
 * @returns {number}
 */
export function foreignCjkRatio(text) {
  const stripped = (text || '').replace(/\s/g, '');
  if (!stripped.length) return 0;
  const matches = stripped.match(FOREIGN_CJK_RE);
  return (matches ? matches.length : 0) / stripped.length;
}

async function scoreAndSelect(searchRepos, trendingRepos, count, history, searchWeight, trendingWeight) {
  const trendingNames = new Set(trendingRepos.map((r) => r.full_name));
  const merged = new Map();
  for (const r of searchRepos) merged.set(r.full_name, r);
  for (const r of trendingRepos) {
    if (!merged.has(r.full_name)) merged.set(r.full_name, r);
  }
  const historyFiltered = [...merged.values()].filter((r) => !history.has(r.full_name));

  const candidates = [];
  const filteredOut = [];
  for (const r of historyFiltered) {
    const ratio = foreignCjkRatio(`${r.name || r.full_name} ${r.description || ''}`);
    if (ratio > FOREIGN_CJK_MAX_RATIO) filteredOut.push(r);
    else candidates.push(r);
  }
  if (filteredOut.length) {
    await logLine(
      `Filtered ${filteredOut.length} repo(s) by foreign-CJK ratio: ${filteredOut.map((r) => r.full_name).join(', ')}`
    );
  }
  if (!candidates.length) return [];

  const maxStars = Math.max(1, ...candidates.map((r) => r.stars));
  const maxForks = Math.max(1, ...candidates.map((r) => r.forks));

  for (const r of candidates) {
    const starTotalNorm = r.stars / maxStars;
    const forkNorm = r.forks / maxForks;
    const starVelocity =
      r.source === 'github_search' ? starTotalNorm * searchWeight : starTotalNorm * trendingWeight;
    const base = starVelocity * 0.5 + starTotalNorm * 0.3 + forkNorm * 0.2;
    const bonus = trendingNames.has(r.full_name) ? 0.1 : 0;
    r.score = Math.round((base + bonus) * 10000) / 10000;
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, count);
}

async function main() {
  const config = await loadConfig();
  const cfgRepos = config.repos;
  const count = cfgRepos.count;
  const lookback = cfgRepos.lookback_days;
  const minStars = cfgRepos.min_stars;
  const categories = config.categories || [];
  const searchWeight = config.sources.github_search.weight;
  const trendingWeight = config.sources.github_trending.weight;

  await mkdir(curationDataDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const history = await loadHistory();
  await logLine(`Discovering (lookback=${lookback}d, count=${count}, min_stars=${minStars})`);

  let searchRepos = [];
  if (config.sources.github_search.enabled) {
    searchRepos = await fetchGithubSearch(lookback, minStars, categories);
    await logLine(`GitHub Search: ${searchRepos.length} repos`);
  }

  let trendingRepos = [];
  if (config.sources.github_trending.enabled) {
    trendingRepos = await fetchGithubTrending();
    await logLine(`GitHub Trending: ${trendingRepos.length} repos`);
  }

  if (!searchRepos.length && !trendingRepos.length) {
    await logLine('error: No repos from any source');
    process.exit(1);
  }

  const selected = await scoreAndSelect(searchRepos, trendingRepos, count, history, searchWeight, trendingWeight);
  if (!selected.length) {
    await logLine('error: No new repos (all in history or empty selection)');
    process.exit(1);
  }

  for (const r of selected) {
    await logLine(`  [${r.score.toFixed(4)}] ${r.full_name} — ${(r.description || '').slice(0, 60)}`);
  }

  await writeFile(reposJson, JSON.stringify(selected, null, 2));
  await logLine(`Saved ${selected.length} repo(s) → ${path.relative(process.cwd(), reposJson)}`);

  for (const r of selected) history.add(r.full_name);
  await saveHistory(history);
}

// discover.test.mjs 등에서 foreignCjkRatio 를 import 할 때 실제 GitHub 호출/파일쓰기가
// 함께 실행되지 않도록, 다른 draft-*.mjs 스크립트와 동일한 관례로 직접 실행 시에만 main 을 돌린다.
const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch(async (err) => {
    console.error(err);
    await mkdir(logsDir, { recursive: true });
    await appendFile(path.join(logsDir, 'discover.log'), `${new Date().toISOString()} FATAL ${err.stack || err.message}\n`).catch(() => {});
    process.exit(1);
  });
}
