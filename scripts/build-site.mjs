import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const contentDir = path.join(root, 'content', 'topics');
const publicDir = path.join(root, 'public');
const siteTitle = 'Dev Blog';
const siteDescription = 'AI가 보조하는 엔지니어링 주제별 개발 뉴스레터입니다.';
const siteUrl = process.env.SITE_URL || 'http://localhost:4321';

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

function renderLayout({ title, description = siteDescription, body }) {
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
        <a href="/feed.xml">RSS</a>
      </div>
    </nav>
${body}
    <footer class="site-footer">Dev Blog가 생성했습니다. 원문 링크를 함께 확인해 주세요.</footer>
  </div>
</body>
</html>
`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
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

function renderPostCard(post) {
  return `<article class="card post-card">
  <div class="eyebrow">${escapeHtml(formatDate(post.date))} · ${escapeHtml(post.topicTitle || '')} · ${escapeHtml(post.readingMinutes)}분 읽기</div>
  <h3><a href="/posts/${escapeHtml(post.id)}.html">${escapeHtml(post.title)}</a></h3>
  <p>${escapeHtml(post.summary)}</p>
  <p class="tags">${(post.tags || []).map((tag) => `<a href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)}</a>`).join(' ')}</p>
</article>`;
}

function renderList(items = []) {
  if (!items.length) return '';
  return `<ul class="check-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}</ul>`;
}

function renderSources(sources = []) {
  if (!sources.length) return '';
  return `<section class="sources"><h2>출처</h2><ul>${sources.map((source) => `<li><a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a>${source.note ? ` <span class="meta">${escapeHtml(source.note)}</span>` : ''}</li>`).join('\n')}</ul></section>`;
}

function renderPost(post, topic) {
  const confidence = post.confidence ? `<aside class="note"><strong>신뢰도:</strong> ${escapeHtml(post.confidence.level || '미정')} — ${escapeHtml(post.confidence.note || '')}</aside>` : '';
  return renderLayout({
    title: `${post.title} - ${siteTitle}`,
    description: post.summary,
    body: `<article class="article">
  <p><a href="/topics/${escapeHtml(topic.slug)}.html">← ${escapeHtml(topic.title)}</a></p>
  <header class="article-header">
    <div class="eyebrow">${escapeHtml(formatDate(post.date))} · ${escapeHtml(topic.title)} · ${escapeHtml(post.readingMinutes)}분 읽기</div>
    <h1>${escapeHtml(post.title)}</h1>
    <p class="lead">${escapeHtml(post.summary)}</p>
    <p class="tags">${(post.tags || []).map((tag) => `<a href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)}</a>`).join(' ')}</p>
  </header>
  ${post.highlights?.length ? `<section class="panel"><h2>오늘의 핵심</h2>${renderList(post.highlights)}</section>` : ''}
  ${post.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p></section>`).join('\n')}
  ${post.implications?.length ? `<section class="panel"><h2>엔지니어링 관점</h2>${renderList(post.implications)}</section>` : ''}
  ${post.nextActions?.length ? `<section class="panel"><h2>다음에 확인할 것</h2>${renderList(post.nextActions)}</section>` : ''}
  ${confidence}
  ${renderSources(post.sources)}
</article>`
  });
}

async function writeStyles() {
  await mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await writeFile(path.join(publicDir, 'assets', 'styles.css'), `:root {
  color-scheme: light dark;
  --bg: #f8fafc;
  --surface: #ffffff;
  --text: #172033;
  --muted: #64748b;
  --border: #dbe3ef;
  --accent: #2563eb;
  --accent-soft: #eaf1ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f172a; --surface: #172033; --text: #e5edf7; --muted: #a8b3c7; --border: #2b3850; --accent: #7aa7ff; --accent-soft: #1d2d4f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.7; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.site-shell { max-width: 1040px; margin: 0 auto; padding: 28px 20px 48px; }
.top-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 44px; }
.brand { color: var(--text); font-weight: 800; font-size: 1.15rem; }
.nav-links { display: flex; gap: 16px; font-size: .95rem; }
.hero { padding: 36px; border: 1px solid var(--border); border-radius: 24px; background: linear-gradient(135deg, var(--surface), var(--accent-soft)); margin-bottom: 28px; }
h1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1.1; margin: 8px 0 16px; }
h2 { margin-top: 34px; }
h3 { margin: 8px 0; font-size: 1.25rem; }
.lead { color: var(--muted); font-size: 1.18rem; max-width: 760px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
.card, .panel, .note { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 22px; }
.post-card p { margin-bottom: 0; }
.eyebrow, .meta, .site-footer { color: var(--muted); font-size: .92rem; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; }
.tags a { color: var(--muted); }
.article { max-width: 820px; margin: 0 auto; }
.article-header { margin-bottom: 30px; }
.check-list { padding-left: 1.2rem; }
.check-list li { margin: 8px 0; }
.sources ul { padding-left: 1.2rem; }
.site-footer { border-top: 1px solid var(--border); margin-top: 48px; padding-top: 20px; }
`);
}

async function build() {
  const topics = await loadTopics();
  const posts = flattenPosts(topics).sort((a, b) => b.date.localeCompare(a.date));

  await rm(publicDir, { recursive: true, force: true });
  await mkdir(path.join(publicDir, 'topics'), { recursive: true });
  await mkdir(path.join(publicDir, 'posts'), { recursive: true });
  await mkdir(path.join(publicDir, 'tags'), { recursive: true });
  await writeStyles();

  const home = renderLayout({
    title: siteTitle,
    body: `<header class="hero"><div class="eyebrow">Linux-first · topic-extensible · static publishing</div><h1>개발 흐름을 놓치지 않는 기술 브리핑</h1><p class="lead">${escapeHtml(siteDescription)} 첫 주제는 리눅스 커널 개발이며, 이후 Android, AI, 보안, 툴체인으로 확장할 수 있게 구성했습니다.</p></header>
<section><h2>주제</h2><div class="grid">${topics.map((topic) => `<article class="card"><h3><a href="/topics/${escapeHtml(topic.slug)}.html">${escapeHtml(topic.title)}</a></h3><p>${escapeHtml(topic.description)}</p><p class="meta">${topic.posts.length}개 글</p></article>`).join('\n')}</div></section>
<section><h2>최근 글</h2><div class="grid">${posts.slice(0, 6).map(renderPostCard).join('\n')}</div></section>`
  });
  await writeFile(path.join(publicDir, 'index.html'), home);

  const archive = renderLayout({
    title: `아카이브 - ${siteTitle}`,
    body: `<header class="hero"><h1>아카이브</h1><p class="lead">날짜순으로 정리한 전체 개발 브리핑입니다.</p></header><section><div class="grid">${posts.map(renderPostCard).join('\n')}</div></section>`
  });
  await writeFile(path.join(publicDir, 'archive.html'), archive);

  const tagMap = new Map();
  for (const post of posts) {
    for (const tag of post.tags || []) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(post);
    }
  }

  const tagIndex = renderLayout({
    title: `태그 - ${siteTitle}`,
    body: `<header class="hero"><h1>태그</h1><p class="lead">관심 키워드별로 글을 찾아볼 수 있습니다.</p></header><section class="tags">${[...tagMap.keys()].sort((a, b) => a.localeCompare(b, 'ko')).map((tag) => `<a class="card" href="/tags/${slugify(tag)}.html">#${escapeHtml(tag)} <span class="meta">${tagMap.get(tag).length}</span></a>`).join('\n')}</section>`
  });
  await writeFile(path.join(publicDir, 'tags', 'index.html'), tagIndex);

  for (const [tag, taggedPosts] of tagMap) {
    const tagPage = renderLayout({
      title: `#${tag} - ${siteTitle}`,
      body: `<header class="hero"><p><a href="/tags/index.html">← 태그</a></p><h1>#${escapeHtml(tag)}</h1><p class="lead">${taggedPosts.length}개 글</p></header><section><div class="grid">${taggedPosts.map(renderPostCard).join('\n')}</div></section>`
    });
    await writeFile(path.join(publicDir, 'tags', `${slugify(tag)}.html`), tagPage);
  }

  for (const topic of topics) {
    const topicPosts = topic.posts.map((post) => ({ ...post, topicTitle: topic.title, topicSlug: topic.slug }));
    const topicHtml = renderLayout({
      title: `${topic.title} - ${siteTitle}`,
      description: topic.description,
      body: `<header class="hero"><p><a href="/index.html">← Dev Blog</a></p><h1>${escapeHtml(topic.title)}</h1><p class="lead">${escapeHtml(topic.description)}</p></header>
<section><h2>글 목록</h2><div class="grid">${topicPosts.map(renderPostCard).join('\n')}</div></section>`
    });
    await writeFile(path.join(publicDir, 'topics', `${topic.slug}.html`), topicHtml);

    for (const post of topic.posts) {
      await writeFile(path.join(publicDir, 'posts', `${post.id}.html`), renderPost(post, topic));
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
    url: `/posts/${post.id}.html`
  })), null, 2));

  console.log(`Built ${topics.length} topic(s), ${posts.length} post(s), ${tagMap.size} tag(s) into public/`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
