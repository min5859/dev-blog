import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const runDate = process.env.NEWSLETTER_DATE || new Date().toISOString().slice(0, 10);
const postId = `${runDate}-linux-daily-briefing`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'linux-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
const contentPostsDir = path.join(root, 'content', 'topics', topic, 'posts');
const adapter = process.env.AI_ADAPTER || 'template';
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

function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(input);
  });
}

async function runAiAdapter(prompt) {
  if (adapter === 'template') return null;

  if (adapter === 'claude') {
    const command = process.env.CLAUDE_BIN || 'claude';
    const args = (process.env.CLAUDE_ARGS || '-p').split(/\s+/).filter(Boolean);
    return runCommand(command, args, prompt);
  }

  throw new Error(`Unsupported AI_ADAPTER: ${adapter}`);
}

function parseJsonResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('AI response was empty');

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/({[\s\S]*})/);
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[1]);
  }
}

function compactSourceTitle(title) {
  return title
    .replace(/^Re:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function templateRewrite(draft) {
  const releaseSection = draft.sections.find((section) => section.heading.includes('릴리스'));
  const patchSection = draft.sections.find((section) => section.heading.includes('패치'));
  const topSources = draft.sources.slice(0, 6);
  const releaseSources = topSources.filter((source) => source.note.includes('kernel.org'));
  const lkmlSources = topSources.filter((source) => source.note.includes('lore.kernel.org'));

  return {
    ...draft,
    title: `${draft.date} 리눅스 커널 개발 브리핑`,
    summary: `kernel.org 릴리스 흐름과 LKML 최신 토론을 바탕으로 선별한 한국어 일일 브리핑입니다. 오늘은 공식 릴리스 신호와 패치 토론 후보를 중심으로 후속 확인 지점을 정리했습니다.`,
    highlights: [
      releaseSources[0] ? `공식 릴리스 신호: ${compactSourceTitle(releaseSources[0].title)}` : '공식 릴리스 신호를 계속 추적해야 합니다.',
      releaseSources[1] ? `추가 릴리스 확인: ${compactSourceTitle(releaseSources[1].title)}` : 'stable/mainline changelog 확인이 필요합니다.',
      lkmlSources[0] ? `LKML 주요 후보: ${compactSourceTitle(lkmlSources[0].title)}` : 'LKML 후보는 본문 기반 재평가가 필요합니다.',
      `총 ${draft.draftMetadata?.sourceRecordCount ?? '여러'}개 source record 중 ${draft.draftMetadata?.candidateCount ?? draft.sources.length}개 후보를 선별했습니다.`,
    ],
    sections: [
      {
        heading: '릴리스/로드맵',
        body: releaseSection?.body || '공식 릴리스 정보가 충분하지 않습니다. kernel.org와 linux-next 흐름을 계속 확인해야 합니다.',
      },
      {
        heading: '주요 패치/토론',
        body: patchSection?.body || 'LKML 패치 토론 후보가 충분하지 않습니다. 다음 수집에서 다시 평가해야 합니다.',
      },
      {
        heading: '엔지니어링 시사점',
        body: draft.implications.join('\n'),
      },
    ],
    implications: [
      ...draft.implications,
      '현재 단계는 자동 선별 기반이므로, 실제 게시 전에는 changelog와 LKML 원문을 확인해 영향 범위를 좁히는 것이 좋습니다.',
    ],
    nextActions: [
      '상위 릴리스 후보의 changelog/diffview를 확인해 실제 변경 범위를 분류합니다.',
      '상위 LKML 후보의 원문 스레드를 확인해 단순 응답인지 실질적 설계 논의인지 구분합니다.',
      'AI 어댑터를 `AI_ADAPTER=claude`로 실행해 문장 품질을 더 높입니다.',
    ],
    confidence: {
      level: adapter === 'template' ? '템플릿 개선 초안' : 'AI 초안',
      note: '출처 링크와 제목/메타데이터 기반으로 생성한 초안입니다. 본문 전체 의미를 완전히 검증한 상태는 아니므로 게시 전 원문 확인이 필요합니다.',
    },
    draftMetadata: {
      ...draft.draftMetadata,
      rewrittenAt: generatedAt,
      rewriteAdapter: adapter,
      promptTemplate: path.relative(root, promptTemplatePath),
    },
  };
}

function validatePost(post) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources']) {
    if (!post[key]) throw new Error(`rewritten post missing ${key}`);
  }
  if (!Array.isArray(post.sections) || post.sections.length < 2) throw new Error('rewritten post requires at least two sections');
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error('rewritten post requires sources');
}

async function main() {
  const draft = await readJsonWithFallback(draftPath, fallbackDraftPath);
  const template = await readText(promptTemplatePath);
  const prompt = buildPrompt(template, draft);

  await mkdir(generatedDir, { recursive: true });
  await mkdir(contentPostsDir, { recursive: true });

  const promptOutput = path.join(generatedDir, `rewrite-prompt-${runDate}.md`);
  const promptLatest = path.join(generatedDir, 'rewrite-prompt-latest.md');
  await writeFile(promptOutput, prompt);
  await writeFile(promptLatest, prompt);

  const aiText = await runAiAdapter(prompt);
  const rewritten = aiText ? parseJsonResponse(aiText) : templateRewrite(draft);
  validatePost(rewritten);

  const aiOutput = path.join(generatedDir, `rewritten-${postId}.json`);
  const aiLatest = path.join(generatedDir, 'rewritten-latest.json');
  const contentOutput = path.join(contentPostsDir, `${postId}.json`);
  await writeFile(aiOutput, JSON.stringify(rewritten, null, 2));
  await writeFile(aiLatest, JSON.stringify(rewritten, null, 2));
  await writeFile(contentOutput, JSON.stringify(rewritten, null, 2));

  console.log(`Rewrote Linux newsletter with ${adapter} adapter; wrote ${path.relative(root, contentOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
