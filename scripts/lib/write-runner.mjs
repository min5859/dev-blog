import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAiAdapterAndParse } from './ai-rewrite-adapter.mjs';
import { auditPostQuality } from './quality-guard.mjs';
import { validateHighlight } from './highlight-schema.mjs';
import { validateDossier } from './dossier-schema.mjs';
import { dossierToPost } from './dossier-to-post.mjs';

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — 토픽-범용 write 골격.
// dossier 우선 입력(없으면 draft 폴백), AI 호출/검증/감사/저장을 한곳에서 처리.
// 토픽 고유(draft fallback=templateRewrite, dossier 메타, 경로)는 cfg 로 주입.
// 이로써 write 개선을 한 번 고치면 전 토픽에 자동 반영된다(토픽별 복제 제거).

const root = process.cwd();

export function validatePost(post, ctx = 'write') {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    if (!post[key]) throw new Error(`${ctx}: rewritten post missing ${key}`);
  }
  if (!Array.isArray(post.sections) || post.sections.length < 2) throw new Error(`${ctx}: requires >=2 sections`);
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error(`${ctx}: requires sources`);
  if (!Array.isArray(post.highlights) || post.highlights.length === 0) throw new Error(`${ctx}: requires highlights`);
  post.highlights.forEach((h, i) => validateHighlight(h, i, ctx));
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

/**
 * @param {object} cfg
 * @param {string} cfg.topic
 * @param {string} cfg.postId
 * @param {string} cfg.runDate
 * @param {string} cfg.generatedDir
 * @param {string} cfg.dossierPath
 * @param {string} cfg.draftPath
 * @param {string} cfg.fallbackDraftPath
 * @param {string} cfg.draftPromptPath
 * @param {string} cfg.dossierPromptPath
 * @param {{titleSuffix?:string, tags?:string[]}} [cfg.dossierMeta]
 * @param {(draft:object)=>object} cfg.templateRewrite  토픽별 draft fallback
 * @param {string} cfg.adapter
 * @param {string} [cfg.logLabel]
 * @returns {Promise<{post:object, mode:string}>}
 */
export async function runWrite(cfg) {
  const {
    topic, postId, runDate, generatedDir,
    dossierPath, draftPath, fallbackDraftPath,
    draftPromptPath, dossierPromptPath,
    dossierMeta = {}, templateRewrite, adapter, logLabel = topic,
  } = cfg;
  const generatedAt = new Date().toISOString();

  // dossier 우선 입력
  let input;
  try {
    const dossier = JSON.parse(await readText(dossierPath));
    if (dossier && Array.isArray(dossier.entries) && dossier.entries.length) {
      validateDossier(dossier, `${logLabel}-write`);
      input = { mode: 'dossier', dossier, grounding: dossier, promptPath: dossierPromptPath };
    }
  } catch {
    // dossier 없음/손상 → draft 폴백
  }
  if (!input) {
    const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
    input = { mode: 'draft', draft, grounding: draft, promptPath: draftPromptPath };
  }

  const template = await readText(input.promptPath);
  const prompt = input.mode === 'dossier'
    ? template
      .replaceAll('{{RUN_DATE}}', runDate)
      .replaceAll('{{POST_ID}}', postId)
      .replace('{{DOSSIER_JSON}}', JSON.stringify(input.dossier, null, 2))
    : template.replace('{{DRAFT_JSON}}', JSON.stringify(input.draft, null, 2));

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `rewrite-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'rewrite-prompt-latest.md'), prompt);

  const grounding = input.grounding;
  const aiResult = await runAiAdapterAndParse(prompt, {
    logLabel,
    postValidator: (post) => {
      validatePost(post, `${logLabel}-write`);
      auditPostQuality(post, { draft: grounding });
    },
  });
  if (aiResult) {
    await writeFile(path.join(generatedDir, `rewrite-stdout-${runDate}.txt`), aiResult.raw);
    await writeFile(path.join(generatedDir, 'rewrite-stdout-latest.txt'), aiResult.raw);
  }

  const fallbackPost = input.mode === 'dossier'
    ? dossierToPost(input.dossier, { postId, date: runDate, topic, titleSuffix: dossierMeta.titleSuffix, tags: dossierMeta.tags })
    : templateRewrite(input.draft);
  const base = aiResult ? aiResult.post : fallbackPost;
  const post = {
    ...base,
    draftMetadata: {
      ...base.draftMetadata,
      rewrittenAt: generatedAt,
      rewriteAdapter: adapter,
      promptTemplate: path.relative(root, input.promptPath),
    },
  };
  validatePost(post, `${logLabel}-write`);
  auditPostQuality(post, { draft: grounding });

  await writeFile(path.join(generatedDir, `rewritten-${postId}.json`), JSON.stringify(post, null, 2));
  await writeFile(path.join(generatedDir, 'rewritten-latest.json'), JSON.stringify(post, null, 2));
  return { post, mode: input.mode };
}
