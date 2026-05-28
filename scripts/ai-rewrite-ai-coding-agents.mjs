import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveAiAdapter, runAiAdapterAndParse } from './lib/ai-rewrite-adapter.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';
import { validateHighlight } from './lib/highlight-schema.mjs';

const root = process.cwd();
const topic = 'ai-coding-agents';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-ai-coding-agents-daily`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'ai-coding-agents-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();
const generatedAt = new Date().toISOString();

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
    title: `${draft.date} AI 코딩 에이전트 동향`,
    summary: `오늘 릴리스·체인지로그 ${buckets.releases ?? 0}건, HN 화제 ${buckets.hnDiscussions ?? 0}건, 블로그 포스트 ${buckets.blogPosts ?? 0}건.`,
    highlights: draft.highlights,
    sections: [
      { heading: '신규 릴리스·기능', body: sectionByHeading.get('신규 릴리스·기능') || '오늘 새 릴리스·체인지로그 신호가 없습니다.' },
      { heading: '실전 활용·팁', body: sectionByHeading.get('실전 활용·팁') || 'HN에서 AI 코딩 에이전트 관련 화제 토론이 없습니다.' },
      { heading: '업계 동향', body: sectionByHeading.get('업계 동향') || '오늘 주목할 만한 업계 블로그 포스트가 없습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '그 외 소소한 업데이트는 없습니다.' },
    ],
    confidence: { level: '자동 생성', note: 'AI가 수집된 릴리스 노트·블로그·HN 신호를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.' },
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
  post.highlights.forEach((h, i) => validateHighlight(h, i));
}

async function main() {
  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  const template = await readText(promptTemplatePath);
  const prompt = buildPrompt(template, draft);

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `rewrite-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'rewrite-prompt-latest.md'), prompt);

  const aiResult = await runAiAdapterAndParse(prompt, {
    logLabel: 'ai-coding-agents',
    postValidator: (post) => {
      validatePost(post);
      auditPostQuality(post, { draft });
    },
  });
  if (aiResult) {
    await writeFile(path.join(generatedDir, `rewrite-stdout-${runDate}.txt`), aiResult.raw);
    await writeFile(path.join(generatedDir, 'rewrite-stdout-latest.txt'), aiResult.raw);
  }
  const rewritten = withAuditMetadata(aiResult ? aiResult.post : templateRewrite(draft));
  validatePost(rewritten);
  auditPostQuality(rewritten, { draft });

  await writeFile(path.join(generatedDir, `rewritten-${postId}.json`), JSON.stringify(rewritten, null, 2));
  await writeFile(path.join(generatedDir, 'rewritten-latest.json'), JSON.stringify(rewritten, null, 2));
  console.log(`Rewrote ai-coding-agents with ${adapter} adapter; wrote data/generated/${topic}/rewritten-${postId}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
