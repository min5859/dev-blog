import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-linux-daily-briefing`;
const draftPath = process.env.DRAFT_PATH || path.join(root, 'data', 'generated', topic, 'draft-latest.json');
const fallbackDraftPath = path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`);
const promptTemplatePath = path.join(root, 'prompts', 'linux-newsletter-ko.md');
const generatedDir = path.join(root, 'data', 'generated', topic);
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

function templateRewrite(draft) {
  const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
  const buckets = draft.draftMetadata?.bucketCounts || {};

  return {
    ...draft,
    title: `${draft.date} 커널 개발 브리핑`,
    summary: `오늘의 핵심: 릴리스 ${buckets.releases ?? 0}건, 회귀·보안 ${buckets.regressions ?? 0}건, 시스템 영향 패치 ${buckets.patches ?? 0}건. 국부 드라이버/플랫폼 패치는 본문에서 제외했습니다.`,
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
        body: sectionByHeading.get('핵심 변경') || '이번 수집에서 시스템 전반에 영향을 줄 변경이 분류되지 않았습니다.',
      },
      {
        heading: '기타',
        body: sectionByHeading.get('기타') || '국부 드라이버/플랫폼 패치는 본문에서 제외했습니다.',
      },
    ],
    implications: draft.implications,
    nextActions: draft.nextActions,
    confidence: {
      level: adapter === 'template' ? '템플릿 초안' : 'AI 초안',
      note: '제목·메타데이터 기반 자동 선별입니다. 본문 의미를 검증한 상태가 아니므로 게시 전 원문 확인이 필요합니다.',
    },
    draftMetadata: {
      ...draft.draftMetadata,
    },
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

const PRIORITY_VALUES = new Set(['상', '중', '하']);

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

  const aiText = await runAiAdapter(prompt);
  const rewritten = withAuditMetadata(aiText ? parseJsonResponse(aiText) : templateRewrite(draft));
  validatePost(rewritten);

  const aiOutput = path.join(generatedDir, `rewritten-${postId}.json`);
  const aiLatest = path.join(generatedDir, 'rewritten-latest.json');
  await writeFile(aiOutput, JSON.stringify(rewritten, null, 2));
  await writeFile(aiLatest, JSON.stringify(rewritten, null, 2));

  console.log(`Rewrote Linux newsletter with ${adapter} adapter; wrote ${path.relative(root, aiOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
