import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveAiAdapter, runAiAdapterAndParse } from './lib/ai-rewrite-adapter.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';
import { validateHighlight } from './lib/highlight-schema.mjs';
import { validateDossier } from './lib/dossier-schema.mjs';
import { dossierToPost } from './lib/dossier-to-post.mjs';

const root = process.cwd();
const topic = 'opensource';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-trending`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const dossierPath = process.env.DOSSIER_PATH || path.join(generatedDir, 'research-latest.json');
const draftPath = process.env.DRAFT_PATH || path.join(generatedDir, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const draftPromptTemplatePath = path.join(root, 'prompts', 'opensource-newsletter-ko.md');
const dossierPromptTemplatePath = path.join(root, 'prompts', 'opensource-newsletter-from-dossier-ko.md');
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

function buildDossierPrompt(template, dossier) {
  return template
    .replaceAll('{{RUN_DATE}}', runDate)
    .replaceAll('{{POST_ID}}', postId)
    .replace('{{DOSSIER_JSON}}', JSON.stringify(dossier, null, 2));
}

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — dossier 우선 입력, 없으면 draft 폴백.
async function loadWriteInput() {
  try {
    const dossier = JSON.parse(await readText(dossierPath));
    if (dossier && Array.isArray(dossier.entries) && dossier.entries.length) {
      validateDossier(dossier, 'ai-rewrite-opensource');
      return { mode: 'dossier', dossier, grounding: dossier, promptPath: dossierPromptTemplatePath };
    }
  } catch {
    // dossier 없음/손상 → draft 폴백
  }
  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  return { mode: 'draft', draft, grounding: draft, promptPath: draftPromptTemplatePath };
}

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
    confidence: { level: '자동 생성', note: 'AI가 원문 후보와 메타데이터를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.' },
    draftMetadata: { ...draft.draftMetadata },
  };
}

function withAuditMetadata(post, promptPath) {
  return {
    ...post,
    draftMetadata: {
      ...post.draftMetadata,
      rewrittenAt: generatedAt,
      rewriteAdapter: adapter,
      promptTemplate: path.relative(root, promptPath),
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
  const input = await loadWriteInput();
  const template = await readText(input.promptPath);
  const prompt = input.mode === 'dossier'
    ? buildDossierPrompt(template, input.dossier)
    : buildPrompt(template, input.draft);
  const grounding = input.grounding;

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `rewrite-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'rewrite-prompt-latest.md'), prompt);

  const aiResult = await runAiAdapterAndParse(prompt, {
    logLabel: 'opensource',
    postValidator: (post) => {
      validatePost(post);
      auditPostQuality(post, { draft: grounding });
    },
  });
  if (aiResult) {
    await writeFile(path.join(generatedDir, `rewrite-stdout-${runDate}.txt`), aiResult.raw);
    await writeFile(path.join(generatedDir, 'rewrite-stdout-latest.txt'), aiResult.raw);
  }
  const fallbackPost = input.mode === 'dossier'
    ? dossierToPost(input.dossier, { postId, date: runDate, topic, titleSuffix: '오픈소스 트렌드', tags: ['오픈소스', 'GitHub'] })
    : templateRewrite(input.draft);
  const rewritten = withAuditMetadata(aiResult ? aiResult.post : fallbackPost, input.promptPath);
  validatePost(rewritten);
  auditPostQuality(rewritten, { draft: grounding });

  await writeFile(path.join(generatedDir, `rewritten-${postId}.json`), JSON.stringify(rewritten, null, 2));
  await writeFile(path.join(generatedDir, 'rewritten-latest.json'), JSON.stringify(rewritten, null, 2));
  console.log(`Rewrote opensource trending with ${adapter} adapter; wrote data/generated/${topic}/rewritten-${postId}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
