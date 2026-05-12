import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseNewsletterJsonFromAiOutput, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';

const root = process.cwd();
const topic = 'opensource';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-trending`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'opensource-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter('cursor');
const generatedAt = new Date().toISOString();

const PRIORITY_VALUES = new Set(['상', '중', '하']);

async function readText(file) { return readFile(file, 'utf8'); }

async function readJsonWithFallback(primary, fallback) {
  try { return JSON.parse(await readText(primary)); }
  catch (primaryError) {
    try { return JSON.parse(await readText(fallback)); }
    catch { throw primaryError; }
  }
}

function buildPrompt(template, draft) { return template.replace('{{DRAFT_JSON}}', JSON.stringify(draft, null, 2)); }

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((s) => [s.heading, s.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} 오픈소스 트렌드`,
    summary: `오늘 GitHub 트렌딩: HN frontpage ${buckets.hnHits ?? 0}건, 60일 내 신규 ${buckets.newRepos ?? 0}건, 별 5k+ 활발 ${buckets.activeGiants ?? 0}건.`,
    highlights: draft.highlights,
    sections: [
      { heading: '지금 화제 (HN frontpage)', body: sectionByHeading.get('지금 화제 (HN frontpage)') || 'Hacker News frontpage에 GitHub URL 신호가 없습니다.' },
      { heading: '최근 떠오른 신규 프로젝트', body: sectionByHeading.get('최근 떠오른 신규 프로젝트') || '60일 내 만들어진 인기 신규 프로젝트가 잡히지 않았습니다.' },
      { heading: '활발히 갱신 중인 인기 프로젝트', body: sectionByHeading.get('활발히 갱신 중인 인기 프로젝트') || '별 5k 이상 활발 프로젝트가 잡히지 않았습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '검색 API의 별 수 정렬은 long-tail 거대 프로젝트로 치우치므로 신규/HN 섹션을 우선 참고하세요.' },
    ],
    confidence: { level: adapter === 'template' ? '템플릿 초안' : 'AI 초안', note: 'GitHub Search API + HN frontpage 기반 자동 선별입니다.' },
    draftMetadata: { ...draft.draftMetadata },
  };
}

function withAuditMetadata(post) {
  return {
    ...post,
    draftMetadata: {
      ...post.draftMetadata,
      rewrittenAt: generatedAt,
      rewriteAdapter: adapter,
      promptTemplate: path.relative(root, promptTemplatePath),
    },
  };
}

function validatePost(post) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    if (!post[key]) throw new Error(`rewritten post missing ${key}`);
  }
  if (!Array.isArray(post.sections) || post.sections.length < 2) throw new Error('rewritten post requires at least two sections');
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error('rewritten post requires sources');
  if (!Array.isArray(post.highlights) || post.highlights.length === 0) throw new Error('rewritten post requires highlights');
  for (const [i, h] of post.highlights.entries()) {
    if (!h || typeof h !== 'object') throw new Error(`highlights[${i}] must be an object`);
    for (const k of ['title', 'priority', 'verifyLink', 'action']) {
      if (typeof h[k] !== 'string' || !h[k]) throw new Error(`highlights[${i}].${k} required`);
    }
    if (!PRIORITY_VALUES.has(h.priority)) throw new Error(`highlights[${i}].priority must be 상/중/하`);
  }
}

async function main() {
  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  const template = await readText(promptTemplatePath);
  const prompt = buildPrompt(template, draft);

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `rewrite-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'rewrite-prompt-latest.md'), prompt);

  const aiText = await runAiAdapterPrompt(prompt, { defaultAdapter: 'cursor' });
  const rewritten = withAuditMetadata(aiText ? parseNewsletterJsonFromAiOutput(aiText) : templateRewrite(draft));
  validatePost(rewritten);
  auditPostQuality(rewritten);

  await writeFile(path.join(generatedDir, `rewritten-${postId}.json`), JSON.stringify(rewritten, null, 2));
  await writeFile(path.join(generatedDir, 'rewritten-latest.json'), JSON.stringify(rewritten, null, 2));
  console.log(`Rewrote opensource trending with ${adapter} adapter; wrote data/generated/${topic}/rewritten-${postId}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
