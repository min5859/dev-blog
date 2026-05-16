import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { applyTemplate } from './draft-lore-lens.mjs';
import { parseNewsletterJsonFromAiOutput, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';
import { validateHighlight } from './lib/highlight-schema.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/ai-rewrite-lore-lens.mjs <topicId>');
  process.exit(1);
}

const pipelinePath = path.join(root, 'content', 'topics', topic, 'pipeline.json');
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readText(file) {
  return readFile(file, 'utf8');
}

async function readJsonWithFallback(primary, fallback) {
  try {
    return JSON.parse(await readText(primary));
  } catch (primaryError) {
    try {
      return JSON.parse(await readText(fallback));
    } catch {
      throw primaryError;
    }
  }
}

function buildPrompt(template, draft) {
  return template.replace('{{DRAFT_JSON}}', JSON.stringify(draft, null, 2));
}

function templateRewrite(draft, pipeline) {
  const adapterName = resolveAiAdapter();
  const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  const titleTemplate = pipeline.rewriteTitleTemplate || '{{date}} 커널 렌즈 브리핑';

  return {
    ...draft,
    title: applyTemplate(titleTemplate, { date: draft.date }),
    summary: `오늘의 핵심: 릴리스 ${buckets.releases ?? 0}건, 회귀·보안 ${buckets.regressions ?? 0}건, 시스템 영향 패치 ${buckets.patches ?? 0}건.`,
    highlights: draft.highlights,
    sections: [
      {
        heading: '릴리스/로드맵',
        body: sectionByHeading.get('릴리스/로드맵') || '이번 수집에서 신규 릴리스가 없습니다.',
      },
      {
        heading: '회귀·보안 신호',
        body: sectionByHeading.get('회귀·보안 신호') || '회귀·보안 신호로 분류된 항목이 없습니다.',
      },
      {
        heading: '핵심 변경',
        body: sectionByHeading.get('핵심 변경') || '이번 수집에서 우선 순위가 높은 패치가 분류되지 않았습니다.',
      },
      {
        heading: '기타',
        body: sectionByHeading.get('기타') || '추가 신호가 없습니다.',
      },
    ],
    confidence: {
      level: adapterName === 'template' ? '템플릿 초안' : 'AI 초안',
      note: '제목·메타데이터 기반 자동 선별입니다. 게시 전 원문 확인이 필요합니다.',
    },
    draftMetadata: {
      ...draft.draftMetadata,
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
  post.highlights.forEach(validateHighlight);
}

function withAuditMetadata(post, pipeline, promptTemplatePath, generatedAt, adapterName) {
  return {
    ...post,
    draftMetadata: {
      ...post.draftMetadata,
      rewrittenAt: generatedAt,
      rewriteAdapter: adapterName,
      promptTemplate: path.relative(root, promptTemplatePath),
      lensPipeline: pipeline.pipelineName || topic,
    },
  };
}

async function main() {
  const adapter = resolveAiAdapter();
  const pipeline = await readJson(pipelinePath);
  if (!pipeline.postIdSuffix) {
    throw new Error(`${path.relative(root, pipelinePath)}: postIdSuffix required`);
  }

  const postId = `${runDate}-${pipeline.postIdSuffix}`;
  const generatedDir = path.join(root, 'data', 'generated', topic);
  const draftPath = process.env.DRAFT_PATH || path.join(generatedDir, 'draft-latest.json');
  const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
  const promptTemplatePath = path.join(root, 'prompts', 'linux-lens-newsletter-ko.md');
  const generatedAt = new Date().toISOString();

  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  const template = await readText(promptTemplatePath);
  const prompt = buildPrompt(template, draft);

  await mkdir(generatedDir, { recursive: true });

  const promptOutput = path.join(generatedDir, `rewrite-prompt-${runDate}.md`);
  const promptLatest = path.join(generatedDir, 'rewrite-prompt-latest.md');
  await writeFile(promptOutput, prompt);
  await writeFile(promptLatest, prompt);

  const aiText = await runAiAdapterPrompt(prompt);
  if (aiText) {
    await writeFile(path.join(generatedDir, `rewrite-stdout-${runDate}.txt`), aiText);
    await writeFile(path.join(generatedDir, 'rewrite-stdout-latest.txt'), aiText);
  }
  const rewritten = withAuditMetadata(
    aiText ? parseNewsletterJsonFromAiOutput(aiText) : templateRewrite(draft, pipeline),
    pipeline,
    promptTemplatePath,
    generatedAt,
    adapter,
  );
  validatePost(rewritten);
  auditPostQuality(rewritten);

  const aiOutput = path.join(generatedDir, `rewritten-${postId}.json`);
  const aiLatest = path.join(generatedDir, 'rewritten-latest.json');
  await writeFile(aiOutput, JSON.stringify(rewritten, null, 2));
  await writeFile(aiLatest, JSON.stringify(rewritten, null, 2));

  console.log(`[${topic}] Rewrote newsletter with ${adapter} adapter; wrote ${path.relative(root, aiOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
