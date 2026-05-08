import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const postsDir = path.join(root, 'content', 'topics', topic, 'posts');
const generatedDir = path.join(root, 'data', 'generated', topic);
const promptTemplatePath = path.join(root, 'prompts', 'linux-newsletter-weekly-ko.md');
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const adapter = process.env.AI_ADAPTER || 'template';
const generatedAt = new Date().toISOString();

const PRIORITY_VALUES = new Set(['상', '중', '하']);

function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d - firstThursday) / 86400000 / 7);
  return { year: d.getUTCFullYear(), week };
}

function decodeXml(value = '') {
  return String(value)
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"').replaceAll('&apos;', "'").replaceAll('&#39;', "'")
    .replaceAll('&#38;', '&').replaceAll('&amp;', '&');
}

function firstMatch(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || null;
}

function parseAtomCommits(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((entry) => ({
    title: decodeXml(firstMatch(entry, /<title>([\s\S]*?)<\/title>/) || ''),
    updated: firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/),
    url: decodeXml(firstMatch(entry, /<link\b[^>]*href="([^"]+)"[^>]*\/>/) || ''),
  })).filter((entry) => entry.title);
}

function parseRssItems(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((item) => ({
    title: decodeXml(firstMatch(item, /<title>([\s\S]*?)<\/title>/) || ''),
    link: firstMatch(item, /<link>([\s\S]*?)<\/link>/),
    pubDate: firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/),
  })).filter((entry) => entry.title);
}

async function fetchRssHeadlines(url, source) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dev-blog-collector/0.1 (+external curated signals)', accept: 'application/rss+xml, application/xml' },
    });
    if (!response.ok) return [];
    const items = parseRssItems(await response.text());
    return items.map((item) => ({ source, ...item }));
  } catch {
    return [];
  }
}

function withinLastWeek(items, runDateStr) {
  const cutoff = new Date(`${runDateStr}T00:00:00Z`).getTime() - 7 * 24 * 3600 * 1000;
  return items.filter((item) => {
    const t = Date.parse(item.pubDate || '');
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function fetchExternalSignals(runDateStr) {
  const collected = [];
  collected.push(...await fetchRssHeadlines('https://lwn.net/headlines/rss', 'lwn.net'));
  collected.push(...await fetchRssHeadlines('https://www.phoronix.com/rss.php', 'phoronix.com'));
  return withinLastWeek(collected, runDateStr).slice(0, 50);
}

async function fetchMainlineCommits() {
  const url = 'https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/atom/?h=master';
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dev-blog-collector/0.1 (+mainline tracker)', accept: 'application/atom+xml' },
    });
    if (!response.ok) return [];
    return parseAtomCommits(await response.text());
  } catch {
    return [];
  }
}

function normalizeSubject(subject) {
  return subject
    .toLowerCase()
    .replace(/^re:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looselyMatches(seriesSubject, commitSubject) {
  if (!seriesSubject || !commitSubject) return false;
  const a = normalizeSubject(seriesSubject);
  const b = normalizeSubject(commitSubject);
  if (a.length < 12 || b.length < 12) return false;
  // commit subject is usually concise; series subject can be longer.
  // Match by colon-prefix shared prefix (e.g., "sched/rt: fix ...").
  const aColon = a.split(':').slice(0, 2).join(':').slice(0, 60);
  const bColon = b.split(':').slice(0, 2).join(':').slice(0, 60);
  if (aColon === bColon) return true;
  // Else fall back to one-direction substring (commit subject contained in series subject).
  if (b.length >= 20 && a.includes(b)) return true;
  if (a.length >= 20 && b.includes(a.slice(0, 40))) return true;
  return false;
}

function collectTrackedSubjects(dailies) {
  const subjects = new Set();
  for (const daily of dailies) {
    for (const highlight of daily.highlights || []) {
      if (highlight?.title) subjects.add(highlight.title);
    }
    for (const source of daily.sources || []) {
      if (source?.title && source.note?.includes('lore.kernel')) subjects.add(source.title);
    }
  }
  return [...subjects];
}

function findMergedSeries(trackedSubjects, mainlineCommits) {
  const merges = [];
  const seen = new Set();
  for (const commit of mainlineCommits) {
    const match = trackedSubjects.find((subject) => looselyMatches(subject, commit.title));
    if (!match || seen.has(match)) continue;
    seen.add(match);
    merges.push({ trackedSubject: match, commitTitle: commit.title, commitUrl: commit.url, mergedAt: commit.updated });
  }
  return merges;
}

async function loadRecentDailyPosts(daysBack = 7) {
  const collected = [];
  const today = new Date(`${runDate}T00:00:00Z`);
  for (let offset = 1; offset <= daysBack; offset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(postsDir, `${dateStr}-linux-daily-briefing.json`);
    try {
      const text = await readFile(file, 'utf8');
      collected.push(JSON.parse(text));
    } catch {
      // missing daily briefing for that day → skip
    }
  }
  return collected.reverse();
}

function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${command} exited with ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

async function runAiAdapter(prompt) {
  if (adapter === 'template') return null;
  if (adapter === 'claude') {
    const command = process.env.CLAUDE_BIN || 'claude';
    const args = (process.env.CLAUDE_ARGS || '-p').split(/\s+/).filter(Boolean);
    return runCommand(command, args, prompt);
  }
  throw new Error(`Unsupported AI_ADAPTER: ${adapter}`);
}

function parseJsonResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('AI response was empty');
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/({[\s\S]*})/);
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[1]);
  }
}

function templateWeekly(dailies, meta) {
  const sections = ['이번 주 릴리스', '이번 주 회귀·보안', '이번 주 핵심 흐름', '기타'];
  const allHighlights = dailies.flatMap((d) => (d.highlights || []).map((h) => ({ ...h, _date: d.date })));
  const top = allHighlights
    .filter((h) => PRIORITY_VALUES.has(h.priority))
    .sort((a, b) => ['상', '중', '하'].indexOf(a.priority) - ['상', '중', '하'].indexOf(b.priority))
    .slice(0, 4);
  const ensureHighlight = (h) => ({
    title: h.title,
    priority: PRIORITY_VALUES.has(h.priority) ? h.priority : '중',
    verifyLink: h.verifyLink || '없음',
    action: h.action || '본문에서 확인하세요.',
  });

  return {
    id: meta.id,
    topic,
    title: `${meta.date} 리눅스 커널 개발 주간 브리핑 (${meta.year} W${String(meta.week).padStart(2, '0')})`,
    date: meta.date,
    summary: `${dailies.length}일치 일일 브리핑을 모은 주간 다이제스트입니다. AI 어댑터 없이 template로 생성된 초안이라 흐름 묶음이 부족합니다.`,
    tags: ['리눅스', '커널', '주간'],
    highlights: top.length ? top.map(ensureHighlight) : [{
      title: '이번 주 highlights가 없습니다',
      priority: '하',
      verifyLink: '없음',
      action: '일일 브리핑 본문을 직접 확인하세요.',
    }],
    sections: sections.map((heading) => ({
      heading,
      body: dailies
        .map((d) => `- ${d.date}: ${d.summary || '(요약 없음)'}`)
        .join('\n') || '이번 주 데이터가 부족합니다.',
    })),
    confidence: {
      level: '템플릿 주간 초안',
      note: '일일 브리핑 메타데이터를 기계적으로 합친 초안입니다. AI_ADAPTER=claude로 다시 실행하면 흐름 묶음이 가능합니다.',
    },
    sources: dailies.flatMap((d) => (d.sources || []).slice(0, 2)).slice(0, 12),
    draftMetadata: {
      generatedAt,
      generator: 'scripts/weekly-linux.mjs',
      adapter,
      coveredDates: dailies.map((d) => d.date),
      year: meta.year,
      week: meta.week,
    },
  };
}

function validateWeekly(post, meta) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    if (!post[key]) throw new Error(`weekly post missing ${key}`);
  }
  if (post.id !== meta.id) throw new Error(`weekly post id ${post.id} does not match expected ${meta.id}`);
  if (post.topic !== topic) throw new Error(`weekly post topic must be ${topic}`);
  if (post.date !== meta.date) throw new Error(`weekly post date ${post.date} does not match ${meta.date}`);
  if (!Array.isArray(post.sections) || post.sections.length < 2) throw new Error('weekly post requires at least two sections');
  if (!Array.isArray(post.highlights) || post.highlights.length === 0) throw new Error('weekly post requires highlights');
  for (const [index, h] of post.highlights.entries()) {
    if (!h || typeof h !== 'object') throw new Error(`highlights[${index}] must be an object`);
    for (const key of ['title', 'priority', 'verifyLink', 'action']) {
      if (typeof h[key] !== 'string' || !h[key]) throw new Error(`highlights[${index}].${key} required`);
    }
    if (!PRIORITY_VALUES.has(h.priority)) throw new Error(`highlights[${index}].priority must be 상/중/하`);
  }
}

async function main() {
  const dailies = await loadRecentDailyPosts(7);
  if (dailies.length < 3) {
    console.log(`Weekly: only ${dailies.length} daily post(s) in last 7 days; skipping (need at least 3).`);
    return;
  }

  const { year, week } = isoWeek(runDate);
  const meta = {
    id: `${year}-W${String(week).padStart(2, '0')}-linux-weekly`,
    date: runDate,
    year,
    week,
  };

  const [mainlineCommits, externalSignals] = await Promise.all([
    fetchMainlineCommits(),
    fetchExternalSignals(meta.date),
  ]);
  const trackedSubjects = collectTrackedSubjects(dailies);
  const mainlineMerges = findMergedSeries(trackedSubjects, mainlineCommits);

  const promptTemplate = await readFile(promptTemplatePath, 'utf8');
  const inputPayload = { id: meta.id, topic, date: meta.date, dailies, mainlineMerges, externalSignals };
  const prompt = promptTemplate.replace('{{INPUT_JSON}}', JSON.stringify(inputPayload, null, 2));

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `weekly-prompt-${meta.id}.md`), prompt);
  await writeFile(path.join(generatedDir, 'weekly-prompt-latest.md'), prompt);

  const aiText = await runAiAdapter(prompt);
  const post = aiText ? parseJsonResponse(aiText) : templateWeekly(dailies, meta);

  if (post && (!post.id || !post.topic || !post.date)) {
    post.id = post.id || meta.id;
    post.topic = post.topic || topic;
    post.date = post.date || meta.date;
  }
  if (!post.confidence) post.confidence = { level: adapter === 'template' ? '템플릿 주간 초안' : 'AI 주간 초안', note: '주간 흐름 묶음 결과입니다.' };
  if (!post.tags) post.tags = ['리눅스', '커널', '주간'];
  post.draftMetadata = {
    ...(post.draftMetadata || {}),
    generatedAt,
    generator: 'scripts/weekly-linux.mjs',
    adapter,
    coveredDates: dailies.map((d) => d.date),
    year: meta.year,
    week: meta.week,
    mainlineMergeMatches: mainlineMerges.length,
    externalSignalCount: externalSignals.length,
  };

  validateWeekly(post, meta);

  await mkdir(postsDir, { recursive: true });
  const out = path.join(postsDir, `${meta.id}.json`);
  await writeFile(out, JSON.stringify(post, null, 2));

  console.log(`Wrote weekly briefing ${meta.id} (covering ${dailies.length} daily post(s); ${mainlineMerges.length} mainline merge match(es); ${externalSignals.length} external curated headlines)`);
}

const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  isoWeek,
  loadRecentDailyPosts,
  templateWeekly,
  validateWeekly,
  parseAtomCommits,
  parseRssItems,
  normalizeSubject,
  looselyMatches,
  collectTrackedSubjects,
  findMergedSeries,
  withinLastWeek,
};
