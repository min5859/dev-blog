import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'ai-coding-agents';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-ai-coding-agents-daily`;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function daysSince(value) {
  if (!value) return Infinity;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return Infinity;
  return (Date.now() - ts) / (24 * 3600 * 1000);
}

function scoreRecord(record) {
  let score = 0;
  const reasons = [];

  // Recency of publication
  const ageDays = daysSince(record.publishedAt || record.observedDate);
  if (ageDays < 1) { score += 50; reasons.push('오늘 발행'); }
  else if (ageDays < 2) { score += 30; reasons.push('어제 발행'); }
  else if (ageDays < 7) { score += 15; reasons.push('이번 주 발행'); }

  // Source authority
  if (record.kind === 'release') { score += 30; reasons.push('공식 릴리스'); }
  else if (record.kind === 'changelog') { score += 25; reasons.push('공식 체인지로그'); }
  else if (record.kind === 'blog-post') { score += 20; reasons.push('공식 블로그'); }

  // HN signal
  if (record.kind === 'hn-discussion') {
    score += 10;
    const points = record.metadata?.points || 0;
    score += Math.min(40, Math.floor(points / 5));
    if ((record.metadata?.numComments || 0) > 100) { score += 15; reasons.push('HN 100+ 댓글'); }
    reasons.push(`HN ${points}점`);
  }

  // AI coding agent keywords in title
  const titleLower = (record.title || '').toLowerCase();
  if (titleLower.includes('claude')) { score += 10; reasons.push('claude'); }
  if (titleLower.includes('cursor')) { score += 10; reasons.push('cursor'); }
  if (titleLower.includes('copilot')) { score += 10; reasons.push('copilot'); }
  if (titleLower.includes('codex')) { score += 10; reasons.push('codex'); }
  if (titleLower.includes('gemini')) { score += 5; reasons.push('gemini'); }

  return { ...record, score, scoreReasons: reasons };
}

function pickCandidates(records) {
  const scored = records.map(scoreRecord);
  scored.sort((a, b) => b.score - a.score);
  const seen = new Map();
  for (const r of scored) {
    if (!seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()].slice(0, 12);
}

function renderItem(r) {
  const pub = r.observedDate ? ` (${r.observedDate})` : '';
  return `- ${r.title}${pub}\n  · 출처: ${r.source}\n  · 확인: ${r.url}`;
}

function renderHnItem(r) {
  const points = r.metadata?.points || 0;
  const comments = r.metadata?.numComments || 0;
  const hnUrl = r.metadata?.hnUrl || r.url;
  const pub = r.observedDate ? ` (${r.observedDate})` : '';
  return `- ${r.title}${pub} — ${points}점, 댓글 ${comments}개\n  · HN: ${hnUrl}\n  · 원문: ${r.url}`;
}

function toPostDraft(candidates, allRecords) {
  const releases = candidates.filter((r) => r.kind === 'release' || r.kind === 'changelog');
  const hnItems = candidates.filter((r) => r.kind === 'hn-discussion');
  const blogPosts = candidates.filter((r) => r.kind === 'blog-post');
  const others = candidates.filter((r) => !['release', 'changelog', 'hn-discussion', 'blog-post'].includes(r.kind));

  const bucketCounts = {
    releases: releases.length,
    hnDiscussions: hnItems.length,
    blogPosts: blogPosts.length,
    others: others.length,
  };

  const sections = [
    {
      heading: '신규 릴리스·기능',
      body: releases.length
        ? releases.map(renderItem).join('\n')
        : '오늘 새 릴리스·체인지로그 신호가 없습니다.',
    },
    {
      heading: '실전 활용·팁',
      body: hnItems.length
        ? hnItems.map(renderHnItem).join('\n')
        : 'HN에서 AI 코딩 에이전트 관련 화제 토론이 없습니다.',
    },
    {
      heading: '업계 동향',
      body: blogPosts.length
        ? blogPosts.map(renderItem).join('\n')
        : '오늘 주목할 만한 업계 블로그 포스트가 없습니다.',
    },
    {
      heading: '기타',
      body: others.length
        ? others.map(renderItem).join('\n')
        : '그 외 소소한 업데이트는 없습니다.',
    },
  ];

  const topHighlights = candidates.slice(0, 4).map((r) => ({
    title: r.title,
    priority: r.score >= 60 ? '상' : r.score >= 30 ? '중' : '하',
    impactType: r.kind === 'release' ? 'release' : r.kind === 'changelog' ? 'release' : 'project',
    affectedAudience: 'AI 코딩 에이전트 사용 개발자',
    verifyLink: r.url,
    if: 'AI 코딩 에이전트를 실무에 쓰는 개발자라면',
    do: '원문 링크에서 변경 내용을 확인하세요',
    verify: r.url,
  }));

  return {
    id: postId,
    topic,
    title: `${runDate} AI 코딩 에이전트 동향`,
    headline: `오늘 AI 코딩 에이전트 도구들의 최신 업데이트와 활용 팁을 정리합니다.`,
    date: runDate,
    summary: `릴리스·체인지로그 ${releases.length}건, HN 화제 ${hnItems.length}건, 블로그 포스트 ${blogPosts.length}건을 수집했습니다.`,
    tags: ['ai', 'coding-agent', 'claude-code', 'codex', 'cursor', 'copilot'],
    highlights: topHighlights,
    sections,
    sources: candidates.slice(0, 10).map((r) => ({ title: r.title, url: r.url, note: r.source })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: allRecords.length,
      candidateCount: candidates.length,
      generator: 'scripts/draft-ai-coding-agents.mjs',
      candidateIds: candidates.map((r) => r.id),
      bucketCounts,
    },
    candidateBodies: candidates.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      kind: r.kind,
      source: r.source,
      publishedAt: r.publishedAt,
      observedDate: r.observedDate,
      body: r.body,
      score: r.score,
      scoreReasons: r.scoreReasons,
      ...(r.metadata ? { hn: r.metadata } : {}),
    })),
  };
}

async function main() {
  const normalized = await readJson(inputPath);
  const { records } = normalized;

  if (!records || records.length === 0) {
    throw new Error('No source records found. Run collect first.');
  }

  const candidates = pickCandidates(records);
  const draft = toPostDraft(candidates, records);

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, 'candidates-latest.json'), JSON.stringify(candidates, null, 2));
  await writeFile(path.join(generatedDir, `${postId}.json`), JSON.stringify(draft, null, 2));
  await writeFile(path.join(generatedDir, 'draft-latest.json'), JSON.stringify(draft, null, 2));

  const { bucketCounts } = draft.draftMetadata;
  console.log(`Drafted ${postId}: 릴리스 ${bucketCounts.releases}, HN ${bucketCounts.hnDiscussions}, 블로그 ${bucketCounts.blogPosts}, 기타 ${bucketCounts.others}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
