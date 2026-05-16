import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseNewsletterJsonFromAiOutput, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';
import { validateHighlight } from './lib/highlight-schema.mjs';

const root = process.cwd();
const topic = 'opensource-curation';
const PICK_HEADING = '이번 주 선정 (큐레이션)';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-curation`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'opensource-curation-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
const adapter = resolveAiAdapter();
const generatedAt = new Date().toISOString();

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

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((s) => [s.heading, s.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};
  return {
    ...draft,
    title: `${draft.date} 오픈소스 큐레이션`,
    summary:
      (draft.summary && String(draft.summary).replace(/\s*\(초안\)\s*$/, '').trim()) ||
      `선정 레포 ${draft.draftMetadata?.candidateCount ?? 0}건 — 심층 분석 ${buckets.withAnalysis ?? 0}건.`,
    tags: ['opensource-curation', 'github', 'opensource'],
    sections: [
      {
        heading: PICK_HEADING,
        body: sectionByHeading.get(PICK_HEADING) || '선정 레포 요약이 없습니다.',
      },
      {
        heading: '언어·규모 스냅샷',
        body: sectionByHeading.get('언어·규모 스냅샷') || '스냅샷이 비었습니다.',
      },
      {
        heading: '심층 분석 하이라이트',
        body: sectionByHeading.get('심층 분석 하이라이트') || '분석 발췌가 없습니다.',
      },
      {
        heading: '기타',
        body: sectionByHeading.get('기타') || '데이터를 주기적으로 갱신하세요.',
      },
    ],
    confidence: { level: adapter === 'template' ? '템플릿 초안' : 'AI 초안', note: '선정 repos·심층 분석 마크다운 기반입니다.' },
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

  const aiText = await runAiAdapterPrompt(prompt);
  if (aiText) {
    await writeFile(path.join(generatedDir, `rewrite-stdout-${runDate}.txt`), aiText);
    await writeFile(path.join(generatedDir, 'rewrite-stdout-latest.txt'), aiText);
  }
  const rewritten = withAuditMetadata(aiText ? parseNewsletterJsonFromAiOutput(aiText) : templateRewrite(draft));
  validatePost(rewritten);
  auditPostQuality(rewritten);

  await writeFile(path.join(generatedDir, `rewritten-${postId}.json`), JSON.stringify(rewritten, null, 2));
  await writeFile(path.join(generatedDir, 'rewritten-latest.json'), JSON.stringify(rewritten, null, 2));
  console.log(`Rewrote opensource-curation with ${adapter} adapter; wrote data/generated/${topic}/rewritten-${postId}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
