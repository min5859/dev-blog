import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const contentDir = path.join(root, 'content', 'topics');
const publicDir = path.join(root, 'public');
const normalizedDir = path.join(root, 'data', 'normalized');
const siteTitle = 'Dev Blog';
const siteDescription = 'AI가 보조하는 엔지니어링 주제별 개발 뉴스레터입니다.';
const siteUrl = process.env.SITE_URL || 'http://localhost:4321';
const buildStartedAt = new Date();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll('&#39;', '&apos;');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(new Date(`${date}T00:00:00+09:00`));
}

function formatBuildStamp(date) {
  const fmt = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${fmt.format(date)} KST`;
}

function absoluteUrl(pathname) {
  return new URL(pathname, siteUrl).toString();
}

function slugify(value) {
  return encodeURIComponent(String(value).trim().toLowerCase().replaceAll(/\s+/g, '-'));
}

function estimateReadingMinutes(post) {
  const text = [post.title, post.summary, ...(post.sections || []).flatMap((section) => [section.heading, section.body])].join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 450));
}

const KERNEL_VERSION = /(?<![\w.\-/])v?\d+\.\d+(?:\.\d+)?(?:-rc\d+)?(?![\w.])/g;
const SUBSYSTEM_SLUG = /\b(?:mm|net|fs|sched|drivers|arch|crypto|block|kvm|iommu|perf|rcu|tracing|bpf)\/[\w.-]+/g;

function markupTechnical(escapedText) {
  return escapedText
    .replace(SUBSYSTEM_SLUG, (match) => `<code>${match}</code>`)
    .replace(KERNEL_VERSION, (match) => `<code>${match}</code>`);
}

const PRIORITY_VALUES = new Set(['상', '중', '하']);
const PRIORITY_ORDER = ['상', '중', '하'];

function topPriority(highlights) {
  if (!Array.isArray(highlights) || !highlights.length) return null;
  for (const level of PRIORITY_ORDER) {
    if (highlights.some((highlight) => highlight?.priority === level)) return level;
  }
  return null;
}

const SOURCE_KIND_LABELS = new Map([
  ['kernel-release', '릴리스'],
  ['patch-discussion', '패치'],
  ['pull-request', '풀 리퀘스트'],
  ['mail-discussion', '토론'],
  ['mail-reply', '응답'],
]);

function renderLayout({ title, description = siteDescription, body, buildStamp }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)}</title>
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteTitle)} RSS" href="/feed.xml">
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <div class="site-shell">
    <nav class="top-nav" aria-label="주요 메뉴">
      <a class="brand" href="/index.html">Dev Blog</a>
      <div class="nav-links">
        <a href="/archive.html">아카이브</a>
        <a href="/tags/index.html">태그</a>
        <a href="/search.html">검색</a>
        <a href="/feed.xml">RSS</a>
      </div>
    </nav>
${body}
    <footer class="site-footer">
      <div>Dev Blog 자동 생성 · 원문 링크를 함께 확인해 주세요.</div>
      <div class="build-meta">${escapeHtml(buildStamp)}</div>
    </footer>
  </div>
</body>
</html>
`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function tryReadJson(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

function assertTopic(topic, file) {
  for (const key of ['id', 'title', 'description', 'slug']) {
    if (!topic[key]) throw new Error(`${file}: missing required field ${key}`);
  }
}

function assertPost(post, file) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections']) {
    if (!post[key]) throw new Error(`${file}: missing required field ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) throw new Error(`${file}: date must be YYYY-MM-DD`);
  if (!Array.isArray(post.sections) || post.sections.length === 0) throw new Error(`${file}: sections must be a non-empty array`);
  for (const [index, section] of post.sections.entries()) {
    if (!section.heading || !section.body) throw new Error(`${file}: sections[${index}] requires heading and body`);
  }
  for (const [index, source] of (post.sources || []).entries()) {
    if (!source.title || !source.url) throw new Error(`${file}: sources[${index}] requires title and url`);
  }
  for (const [index, highlight] of (post.highlights || []).entries()) {
    if (!highlight || typeof highlight !== 'object') throw new Error(`${file}: highlights[${index}] must be an object`);
    for (const key of ['title', 'priority', 'verifyLink', 'action']) {
      if (typeof highlight[key] !== 'string' || !highlight[key]) throw new Error(`${file}: highlights[${index}].${key} required`);
    }
    if (!PRIORITY_VALUES.has(highlight.priority)) throw new Error(`${file}: highlights[${index}].priority must be 상/중/하`);
  }
}

async function loadTopics() {
  const topicIds = await readdir(contentDir);
  const topics = [];

  for (const topicId of topicIds) {
    const topicPath = path.join(contentDir, topicId);
    const topicFile = path.join(topicPath, 'topic.json');
    const topic = await readJson(topicFile);
    assertTopic(topic, topicFile);

    const postsDir = path.join(topicPath, 'posts');
    const postFiles = (await readdir(postsDir)).filter((file) => file.endsWith('.json'));
    const posts = [];

    for (const postFile of postFiles) {
      const fullPath = path.join(postsDir, postFile);
      const post = await readJson(fullPath);
      assertPost(post, fullPath);
      posts.push({ ...post, readingMinutes: post.readingMinutes || estimateReadingMinutes(post) });
    }

    posts.sort((a, b) => b.date.localeCompare(a.date));
    topics.push({ ...topic, posts });
  }

  topics.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return topics;
}

function flattenPosts(topics) {
  return topics.flatMap((topic) => topic.posts.map((post) => ({ ...post, topicTitle: topic.title, topicSlug: topic.slug })));
}

async function loadReleaseStatus() {
  const file = path.join(normalizedDir, 'linux', 'source-records-latest.json');
  const data = await tryReadJson(file);
  if (!data || !Array.isArray(data.records)) return null;

  const releases = data.records.filter((record) => record.sourceId === 'kernel-org-releases');
  const byMoniker = new Map();
  for (const record of releases) {
    const moniker = record.metadata?.moniker;
    if (!moniker) continue;
    const previous = byMoniker.get(moniker);
    if (!previous || (record.observedDate && record.observedDate > previous.observedDate)) {
      byMoniker.set(moniker, record);
    }
  }
  const eolCount = releases.filter((record) => record.metadata?.isEol).length;
  return { byMoniker, eolCount, collectedAt: data.collectedAt };
}

function renderReleaseStatus(status) {
  if (!status) return '';
  const order = ['mainline', 'stable', 'longterm', 'linux-next'];
  const rows = order
    .map((moniker) => [moniker, status.byMoniker.get(moniker)])
    .filter(([, record]) => record)
    .map(([moniker, record]) => {
      const version = escapeHtml(record.metadata?.version || '');
      const date = record.observedDate || '공개일 미상';
      const tag = record.metadata?.isEol ? '<span class="status-flag eol">EOL</span>' : '';
      const link = record.links?.find((entry) => entry.kind === 'changelog')?.url
        || record.links?.find((entry) => entry.kind === 'gitweb')?.url
        || record.url;
      return `<tr>
  <th scope="row"><span class="moniker moniker-${escapeHtml(moniker)}">${escapeHtml(moniker)}</span></th>
  <td><code>${version}</code> ${tag}</td>
  <td class="muted">${escapeHtml(date)}</td>
  <td class="link-cell">${link ? `<a href="${escapeHtml(link)}">변경 내역</a>` : ''}</td>
</tr>`;
    }).join('\n');
  if (!rows) return '';
  return `<section class="release-status">
  <header class="release-status-header">
    <h2>릴리스 상태</h2>
    <span class="muted">EOL 표시 ${status.eolCount}건 · 수집 ${status.collectedAt?.slice(0, 10) || '시간 미상'}</span>
  </header>
  <table>
    <thead><tr><th scope="col">라인</th><th scope="col">버전</th><th scope="col">공개일</th><th scope="col"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderPostCard(post) {
  const tags = (post.tags || []).slice(0, 4);
  return `<article class="card post-card">
  <div class="eyebrow">${escapeHtml(formatDate(post.date))} · ${escapeHtml(post.topicTitle || '')}</div>
  <h3><a href="/posts/${escapeHtml(post.id)}.html">${escapeHtml(post.title)}</a></h3>
  <p>${escapeHtml(post.summary)}</p>
  <p class="tags">${tags.map((tag) => `<a href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)}</a>`).join(' ')}</p>
</article>`;
}

function renderList(items = []) {
  if (!items.length) return '';
  return `<ul class="check-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}</ul>`;
}

function renderHighlights(highlights = []) {
  if (!highlights.length) return '';
  return `<ul class="highlight-list">${highlights.map((item) => {
    const verify = item.verifyLink && item.verifyLink !== '없음'
      ? ` <a class="highlight-verify" href="${escapeHtml(item.verifyLink)}">확인하기</a>`
      : ' <span class="highlight-verify-empty">확인 링크 없음</span>';
    return `<li class="highlight-item">
  <div class="highlight-head"><span class="priority priority-${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span><span class="highlight-title">${markupTechnical(escapeHtml(item.title))}</span></div>
  <p class="highlight-action">${escapeHtml(item.action)}${verify}</p>
</li>`;
  }).join('\n')}</ul>`;
}

function sourceKindLabel(note = '') {
  for (const [kind, label] of SOURCE_KIND_LABELS) {
    if (note.includes(kind)) return label;
  }
  return '출처';
}

function renderSources(sources = []) {
  if (!sources.length) return '';
  return `<section class="sources"><h2>출처</h2><ul>${sources.map((source) => {
    const kind = sourceKindLabel(source.note || '');
    return `<li><span class="source-kind">${escapeHtml(kind)}</span><a href="${escapeHtml(source.url)}">${markupTechnical(escapeHtml(source.title))}</a>${source.note ? ` <span class="meta">${escapeHtml(source.note)}</span>` : ''}</li>`;
  }).join('\n')}</ul></section>`;
}

function summarizeSourceKinds(sources = []) {
  const counts = new Map();
  for (const source of sources) {
    const kind = sourceKindLabel(source.note || '');
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()].map(([kind, n]) => `${kind} ${n}`).join(' · ');
}

function renderArticleMeta(post, topic) {
  const summary = summarizeSourceKinds(post.sources);
  return `<aside class="article-meta">
  <a class="article-back" href="/topics/${escapeHtml(topic.slug)}.html">← ${escapeHtml(topic.title)}</a>
  <dl>
    <dt>발행</dt><dd>${escapeHtml(formatDate(post.date))}</dd>
    <dt>주제</dt><dd>${escapeHtml(topic.title)}</dd>
    <dt>읽기</dt><dd>${escapeHtml(post.readingMinutes)}분</dd>
    ${summary ? `<dt>출처 구성</dt><dd>${escapeHtml(summary)}</dd>` : ''}
    ${post.confidence?.level ? `<dt>신뢰도</dt><dd>${escapeHtml(post.confidence.level)}</dd>` : ''}
  </dl>
</aside>`;
}

function renderPost(post, topic, buildStamp) {
  return renderLayout({
    title: `${post.title} - ${siteTitle}`,
    description: post.summary,
    buildStamp,
    body: `<div class="article-shell">
  ${renderArticleMeta(post, topic)}
  <article class="article">
    <header class="article-header">
      <div class="eyebrow">${escapeHtml(formatDate(post.date))} · ${escapeHtml(topic.title)} · ${escapeHtml(post.readingMinutes)}분 읽기</div>
      <h1>${markupTechnical(escapeHtml(post.title))}</h1>
      <p class="lead">${escapeHtml(post.summary)}</p>
      <p class="tags">${(post.tags || []).map((tag) => `<a href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)}</a>`).join(' ')}</p>
    </header>
    ${post.highlights?.length ? `<section class="panel"><h2>오늘의 핵심</h2>${renderHighlights(post.highlights)}</section>` : ''}
    ${post.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2><p>${markupTechnical(escapeHtml(section.body))}</p></section>`).join('\n')}
    ${post.implications?.length ? `<section class="panel"><h2>엔지니어링 관점</h2>${renderList(post.implications)}</section>` : ''}
    ${post.nextActions?.length ? `<section class="panel"><h2>다음에 확인할 것</h2>${renderList(post.nextActions)}</section>` : ''}
    ${post.confidence ? `<aside class="note"><strong>신뢰도</strong> ${escapeHtml(post.confidence.level || '미정')} — ${escapeHtml(post.confidence.note || '')}</aside>` : ''}
    ${renderSources(post.sources)}
  </article>
</div>`,
  });
}

async function writeStyles() {
  await mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await writeFile(path.join(publicDir, 'assets', 'styles.css'), `:root {
  color-scheme: light dark;
  --bg: #f5f7fb;
  --surface: #ffffff;
  --surface-alt: #f0f3f9;
  --text: #0f172a;
  --muted: #5b6678;
  --border: #d8dee8;
  --accent: #1f6feb;
  --accent-soft: #e8f0ff;
  --rail: #1f6feb;
  font-family: -apple-system, "SF Pro Text", "Inter", "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f17;
    --surface: #111827;
    --surface-alt: #0f1623;
    --text: #e6ecf5;
    --muted: #95a3ba;
    --border: #1f2a3a;
    --accent: #4f8cff;
    --accent-soft: #16243d;
    --rail: #4f8cff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.65; font-size: 16px; }
code { font-family: ui-monospace, "JetBrains Mono", "SF Mono", "Menlo", monospace; font-size: .92em; padding: 1px 6px; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 6px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.site-shell { max-width: 1080px; margin: 0 auto; padding: 24px 20px 56px; }
.top-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 36px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.brand { color: var(--text); font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; }
.nav-links { display: flex; gap: 18px; font-size: .95rem; color: var(--muted); }
.nav-links a { color: var(--muted); }
.nav-links a:hover { color: var(--accent); text-decoration: none; }
h1, h2, h3 { letter-spacing: -0.02em; line-height: 1.2; }
h1 { font-size: clamp(1.85rem, 4vw, 2.6rem); margin: 4px 0 14px; font-weight: 700; }
h2 { font-size: 1.3rem; margin: 32px 0 12px; font-weight: 700; }
h3 { font-size: 1.1rem; margin: 6px 0; font-weight: 600; }
p { margin: 8px 0; }
.lead { color: var(--muted); font-size: 1.1rem; max-width: 720px; }
.eyebrow, .meta, .muted { color: var(--muted); font-size: .9rem; }
.site-page-head { padding: 0 0 8px; border-left: 4px solid var(--rail); padding-left: 16px; margin-bottom: 28px; }
.site-page-head .eyebrow { letter-spacing: 0.08em; text-transform: uppercase; font-size: .78rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
.post-card h3 { margin-bottom: 8px; }
.post-card p { margin: 0 0 10px; color: var(--text); }
.post-card .tags { margin-top: 0; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
.tags a { color: var(--muted); font-size: .85rem; padding: 2px 10px; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 999px; }
.tags a:hover { color: var(--accent); text-decoration: none; border-color: var(--accent); }

.release-status { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 28px; }
.release-status-header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.release-status h2 { margin: 0; font-size: 1.1rem; }
.release-status table { width: 100%; border-collapse: collapse; font-size: .95rem; }
.release-status th, .release-status td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.release-status tr:last-child td, .release-status tr:last-child th { border-bottom: none; }
.release-status .link-cell { text-align: right; font-size: .85rem; }
.moniker { display: inline-flex; padding: 2px 9px; border-radius: 999px; font-size: .78rem; font-weight: 600; background: var(--surface-alt); border: 1px solid var(--border); color: var(--text); }
.moniker-mainline { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.moniker-stable { background: #e6f6e9; border-color: #2f9d5a; color: #1f6f3e; }
.moniker-longterm { background: #fff1c5; border-color: #cf9e16; color: #6b4f00; }
.moniker-linux-next { background: #ede2ff; border-color: #7c3aed; color: #4c1d95; }
@media (prefers-color-scheme: dark) {
  .moniker-stable { background: #163627; border-color: #2f9d5a; color: #6dd49a; }
  .moniker-longterm { background: #4a3b00; border-color: #cf9e16; color: #ffe7a3; }
  .moniker-linux-next { background: #2a1f4a; border-color: #7c3aed; color: #c5b3ff; }
}
.status-flag.eol { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 4px; font-size: .72rem; font-weight: 700; background: #fde2e2; color: #8a1f1f; }
@media (prefers-color-scheme: dark) {
  .status-flag.eol { background: #4b1f1f; color: #ffd6d6; }
}

.article-shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 36px; align-items: start; }
.article-meta { position: sticky; top: 24px; padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); font-size: .92rem; }
.article-meta dl { margin: 0; display: grid; grid-template-columns: 1fr; gap: 6px; }
.article-meta dt { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 8px; }
.article-meta dd { margin: 0; }
.article-back { display: inline-block; margin-bottom: 12px; color: var(--muted); font-size: .9rem; }
.article { max-width: 720px; }
.article-header { margin-bottom: 24px; padding-left: 16px; border-left: 4px solid var(--rail); }
.article section { margin-top: 28px; }
.article section p { white-space: pre-line; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-top: 28px; }
.panel h2 { margin-top: 0; }
.note { background: var(--surface-alt); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 12px 16px; margin-top: 24px; font-size: .95rem; }
.check-list { padding-left: 1.2rem; }
.check-list li { margin: 6px 0; }
.sources ul { padding-left: 0; list-style: none; }
.sources li { display: flex; align-items: baseline; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.source-kind { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 4px; font-size: .72rem; font-weight: 700; letter-spacing: 0.04em; background: var(--surface-alt); color: var(--muted); border: 1px solid var(--border); min-width: 56px; justify-content: center; }
.sources .meta { font-size: .8rem; }

.highlight-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.highlight-item { padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.highlight-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.highlight-title { font-weight: 600; }
.highlight-action { margin: 0; color: var(--muted); font-size: .92rem; }
.priority { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; padding: 2px 8px; border-radius: 999px; font-size: .78rem; font-weight: 700; letter-spacing: .02em; }
.priority-상 { background: #fde2e2; color: #8a1f1f; }
.priority-중 { background: #fff1c5; color: #6b4f00; }
.priority-하 { background: #e2eaf6; color: #2b3850; }
@media (prefers-color-scheme: dark) {
  .priority-상 { background: #4b1f1f; color: #ffd6d6; }
  .priority-중 { background: #4a3b00; color: #ffe7a3; }
  .priority-하 { background: #1f2a3a; color: #c8d3e6; }
}
.highlight-verify { margin-left: 8px; font-size: .85rem; }
.highlight-verify-empty { margin-left: 8px; font-size: .8rem; color: var(--muted); }

.search-shell { display: grid; gap: 16px; }
#search-input { width: 100%; padding: 14px 18px; font-size: 1.05rem; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; outline-offset: 2px; font-family: inherit; }
#search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-counter-row { font-size: .9rem; }
.search-subsystem { background: var(--surface-alt); padding: 1px 8px; border-radius: 4px; font-size: .8rem; color: var(--muted); border: 1px solid var(--border); margin-right: 4px; }
.search-divider { margin: 0 6px; color: var(--muted); }

.site-footer { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; border-top: 1px solid var(--border); margin-top: 56px; padding-top: 16px; color: var(--muted); font-size: .85rem; }
.build-meta { font-family: ui-monospace, "JetBrains Mono", "SF Mono", monospace; font-size: .8rem; }

@media (max-width: 820px) {
  .article-shell { grid-template-columns: 1fr; gap: 20px; }
  .article-meta { position: static; }
  .release-status table { font-size: .85rem; }
  .release-status .link-cell { display: none; }
}
`);
}

function renderSearchPage(buildStamp) {
  const script = `
    const data = await fetch('/search-index.json').then((r) => r.json());
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');
    const counter = document.getElementById('search-counter');
    const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => escMap[c]);

    function renderResults(matches) {
      counter.textContent = matches.length + '건';
      if (!matches.length) {
        results.innerHTML = '<p class="muted">일치하는 글이 없습니다. 키워드를 줄여 보세요.</p>';
        return;
      }
      results.innerHTML = matches.map((post) => {
        const tags = (post.tags || []).map((t) => '<span>#' + esc(t) + '</span>').join(' ');
        const subs = (post.subsystems || []).map((s) => '<span class="search-subsystem">' + esc(s) + '</span>').join(' ');
        const priority = post.priority ? '<span class="priority priority-' + esc(post.priority) + '">' + esc(post.priority) + '</span>' : '';
        return '<article class="card post-card">'
          + '<div class="eyebrow">' + esc(post.date) + ' · ' + esc(post.topic) + '</div>'
          + '<h3>' + priority + ' <a href="' + esc(post.url) + '">' + esc(post.title) + '</a></h3>'
          + '<p>' + esc(post.summary) + '</p>'
          + '<p class="tags">' + tags + (subs ? '<span class="search-divider">·</span>' + subs : '') + '</p>'
          + '</article>';
      }).join('');
    }

    function filter(query) {
      const q = query.trim().toLowerCase();
      if (!q) { renderResults(data); return; }
      const matches = data.filter((post) => {
        const haystack = [post.title, post.summary, post.topic, ...(post.tags || []), ...(post.subsystems || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      });
      renderResults(matches);
    }

    input.addEventListener('input', (event) => filter(event.target.value));
    const initial = new URL(window.location.href).searchParams.get('q') || '';
    if (initial) input.value = initial;
    filter(initial);
    input.focus();
  `;
  return renderLayout({
    title: `검색 - ${siteTitle}`,
    buildStamp,
    body: `<header class="site-page-head"><div class="eyebrow">search</div><h1>검색</h1><p class="lead">제목, 요약, 태그, 서브시스템을 한 번에 찾아봅니다.</p></header>
<section class="search-shell">
  <input id="search-input" type="search" autocomplete="off" placeholder="예: stable, sched/rt, 회귀, 7.1-rc2" aria-label="검색어">
  <div class="search-counter-row"><span id="search-counter" class="muted"></span></div>
  <div id="search-results" class="grid"></div>
</section>
<script type="module">
${script}
</script>`,
  });
}

function renderHomeHead() {
  return `<header class="site-page-head">
  <div class="eyebrow">Linux-first · topic-extensible · static publishing</div>
  <h1>${escapeHtml(siteTitle)}</h1>
  <p class="lead">${escapeHtml(siteDescription)}</p>
</header>`;
}

async function build() {
  const [topics, releaseStatus] = await Promise.all([loadTopics(), loadReleaseStatus()]);
  const posts = flattenPosts(topics).sort((a, b) => b.date.localeCompare(a.date));
  const buildStamp = `last build ${formatBuildStamp(buildStartedAt)} · posts ${posts.length}`;

  await rm(publicDir, { recursive: true, force: true });
  await mkdir(path.join(publicDir, 'topics'), { recursive: true });
  await mkdir(path.join(publicDir, 'posts'), { recursive: true });
  await mkdir(path.join(publicDir, 'tags'), { recursive: true });
  await writeStyles();

  const home = renderLayout({
    title: siteTitle,
    buildStamp,
    body: `${renderHomeHead()}
${renderReleaseStatus(releaseStatus)}
<section><h2>최근 글</h2><div class="grid">${posts.slice(0, 6).map(renderPostCard).join('\n')}</div></section>
<section><h2>주제</h2><div class="grid">${topics.map((topic) => `<article class="card"><h3><a href="/topics/${escapeHtml(topic.slug)}.html">${escapeHtml(topic.title)}</a></h3><p>${escapeHtml(topic.description)}</p><p class="meta">${topic.posts.length}개 글</p></article>`).join('\n')}</div></section>`,
  });
  await writeFile(path.join(publicDir, 'index.html'), home);

  const archive = renderLayout({
    title: `아카이브 - ${siteTitle}`,
    buildStamp,
    body: `<header class="site-page-head"><div class="eyebrow">archive</div><h1>아카이브</h1><p class="lead">날짜순으로 정리한 전체 개발 브리핑입니다.</p></header><section><div class="grid">${posts.map(renderPostCard).join('\n')}</div></section>`,
  });
  await writeFile(path.join(publicDir, 'archive.html'), archive);
  await writeFile(path.join(publicDir, 'search.html'), renderSearchPage(buildStamp));

  const tagMap = new Map();
  for (const post of posts) {
    for (const tag of post.tags || []) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(post);
    }
  }

  const tagIndex = renderLayout({
    title: `태그 - ${siteTitle}`,
    buildStamp,
    body: `<header class="site-page-head"><div class="eyebrow">tags</div><h1>태그</h1><p class="lead">관심 키워드별로 글을 찾아볼 수 있습니다.</p></header><section class="tags">${[...tagMap.keys()].sort((a, b) => a.localeCompare(b, 'ko')).map((tag) => `<a class="card" href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)} <span class="meta">${tagMap.get(tag).length}</span></a>`).join('\n')}</section>`,
  });
  await writeFile(path.join(publicDir, 'tags', 'index.html'), tagIndex);

  for (const [tag, taggedPosts] of tagMap) {
    const tagPage = renderLayout({
      title: `#${tag} - ${siteTitle}`,
      buildStamp,
      body: `<header class="site-page-head"><p><a href="/tags/index.html">← 태그</a></p><h1>#${escapeHtml(tag)}</h1><p class="lead">${taggedPosts.length}개 글</p></header><section><div class="grid">${taggedPosts.map(renderPostCard).join('\n')}</div></section>`,
    });
    await writeFile(path.join(publicDir, 'tags', `${slugify(tag)}.html`), tagPage);
  }

  for (const topic of topics) {
    const topicPosts = topic.posts.map((post) => ({ ...post, topicTitle: topic.title, topicSlug: topic.slug }));
    const topicHtml = renderLayout({
      title: `${topic.title} - ${siteTitle}`,
      description: topic.description,
      buildStamp,
      body: `<header class="site-page-head"><p><a href="/index.html">← Dev Blog</a></p><h1>${escapeHtml(topic.title)}</h1><p class="lead">${escapeHtml(topic.description)}</p></header>
<section><h2>글 목록</h2><div class="grid">${topicPosts.map(renderPostCard).join('\n')}</div></section>`,
    });
    await writeFile(path.join(publicDir, 'topics', `${topic.slug}.html`), topicHtml);

    for (const post of topic.posts) {
      await writeFile(path.join(publicDir, 'posts', `${post.id}.html`), renderPost(post, topic, buildStamp));
    }
  }

  const feedItems = posts.slice(0, 20).map((post) => `<item>
  <title>${escapeXml(post.title)}</title>
  <link>${escapeXml(absoluteUrl(`/posts/${post.id}.html`))}</link>
  <guid>${escapeXml(absoluteUrl(`/posts/${post.id}.html`))}</guid>
  <pubDate>${new Date(`${post.date}T00:00:00+09:00`).toUTCString()}</pubDate>
  <description>${escapeXml(post.summary)}</description>
</item>`).join('\n');
  await writeFile(path.join(publicDir, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeXml(siteTitle)}</title>
  <link>${escapeXml(siteUrl)}</link>
  <description>${escapeXml(siteDescription)}</description>
${feedItems}
</channel>
</rss>
`);

  await writeFile(path.join(publicDir, 'search-index.json'), JSON.stringify(posts.map((post) => ({
    id: post.id,
    title: post.title,
    date: post.date,
    topic: post.topicTitle,
    summary: post.summary,
    tags: post.tags || [],
    subsystems: post.draftMetadata?.subsystems || [],
    priority: topPriority(post.highlights),
    url: `/posts/${post.id}.html`,
  })), null, 2));

  const buildMeta = {
    lastBuildAt: buildStartedAt.toISOString(),
    lastBuildAtFormatted: formatBuildStamp(buildStartedAt),
    timezone: 'Asia/Seoul',
    postCount: posts.length,
    topicCount: topics.length,
    tagCount: tagMap.size,
  };
  await writeFile(path.join(publicDir, 'build-meta.json'), JSON.stringify(buildMeta, null, 2));

  console.log(`Built ${topics.length} topic(s), ${posts.length} post(s), ${tagMap.size} tag(s) into public/`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
