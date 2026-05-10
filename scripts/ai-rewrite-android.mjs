import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseNewsletterJsonFromAiOutput, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';

const root = process.cwd();
const topic = 'android';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-android-daily-briefing`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'android-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter('template');
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
  const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} Android 커널 개발 브리핑`,
    summary: `Android Common Kernel 변경 정리: 회귀·보안 ${buckets.regressions ?? 0}건, ACK 전용 패치 ${buckets.ackPatches ?? 0}건. 단일 vendor 디바이스 패치는 본문에서 제외했습니다.`,
    highlights: draft.highlights,
    sections: [
      { heading: '회귀·보안 신호', body: sectionByHeading.get('회귀·보안 신호') || '회귀·보안 신호로 분류된 항목이 없습니다.' },
      { heading: 'ACK 전용 변경', body: sectionByHeading.get('ACK 전용 변경') || '이번 수집에서 ACK 전용 시스템 영향 패치가 분류되지 않았습니다.' },
      { heading: '추적 브랜치', body: sectionByHeading.get('추적 브랜치') || '추적 브랜치 정보를 확인하지 못했습니다.' },
      { heading: '기타', body: sectionByHeading.get('기타') || '단일 vendor 디바이스 패치는 본문에서 제외했습니다.' },
    ],
    confidence: { level: adapter === 'template' ? '템플릿 초안' : 'AI 초안', note: 'gitiles JSON과 commit message 일부를 기반으로 한 자동 선별입니다.' },
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

function validateHighlight(highlight, index) {
  if (!highlight || typeof highlight !== 'object') {
    throw new Error(`highlights[${index}] must be an object with title/priority/verifyLink/action`);
  }
  for (const key of ['title', 'priority', 'verifyLink', 'action']) {
    if (typeof highlight[key] !== 'string' || !highlight[key]) {
      throw new Error(`highlights[${index}].${key} is required`);
    }
  }
  if (!PRIORITY_VALUES.has(highlight.priority)) {
    throw new Error(`highlights[${index}].priority must be one of 상/중/하 (got ${highlight.priority})`);
  }
}

function validatePost(post) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    if (!post[key]) throw new Error(`rewritten post missing ${key}`);
  }
  if (!Array.isArray(post.sections) || post.sections.length < 2) throw new Error('rewritten post requires at least two sections');
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error('rewritten post requires sources');
  if (!Array.isArray(post.highlights) || post.highlights.length === 0) throw new Error('rewritten post requires highlights');
  post.highlights.forEach(validateHighlight);
}

async function main() {
  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  const template = await readText(promptTemplatePath);
  const prompt = buildPrompt(template, draft);

  await mkdir(generatedDir, { recursive: true });
  const promptOutput = path.join(generatedDir, `rewrite-prompt-${runDate}.md`);
  const promptLatest = path.join(generatedDir, 'rewrite-prompt-latest.md');
  await writeFile(promptOutput, prompt);
  await writeFile(promptLatest, prompt);

  const aiText = await runAiAdapterPrompt(prompt, { defaultAdapter: 'template' });
  const rewritten = withAuditMetadata(aiText ? parseNewsletterJsonFromAiOutput(aiText) : templateRewrite(draft));
  validatePost(rewritten);

  const aiOutput = path.join(generatedDir, `rewritten-${postId}.json`);
  const aiLatest = path.join(generatedDir, 'rewritten-latest.json');
  await writeFile(aiOutput, JSON.stringify(rewritten, null, 2));
  await writeFile(aiLatest, JSON.stringify(rewritten, null, 2));

  console.log(`Rewrote Android newsletter with ${adapter} adapter; wrote ${path.relative(root, aiOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
