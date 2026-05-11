import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'opensource-curation';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-curation`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const contentPostsDir = path.join(root, 'content', 'topics', topic, 'posts');
const sourcePath = process.env.PUBLISH_SOURCE || path.join(generatedDir, 'rewritten-latest.json');
const fallbackSourcePath = path.join(generatedDir, 'draft-latest.json');
const draftReferencePath = path.join(generatedDir, 'draft-latest.json');
const outputPath = path.join(contentPostsDir, `${postId}.json`);

const PRIORITY_VALUES = new Set(['상', '중', '하']);

async function readJsonWithFallback(primary, fallback) {
  try {
    return JSON.parse(await readFile(primary, 'utf8'));
  } catch (e) {
    try {
      return JSON.parse(await readFile(fallback, 'utf8'));
    } catch {
      throw e;
    }
  }
}

async function tryReadJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function assertImmutableAgainstDraft(post, draft) {
  if (!draft) return;
  for (const key of ['id', 'topic', 'date']) {
    if (post[key] !== draft[key]) {
      throw new Error(`publish candidate ${key} (${post[key]}) does not match source draft ${key} (${draft[key]})`);
    }
  }
}

function validatePost(post) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources', 'highlights']) {
    if (!post[key]) throw new Error(`publish candidate missing ${key}`);
  }
  if (post.topic !== topic) throw new Error(`publish candidate topic must be ${topic}`);
  if (post.date !== runDate) throw new Error(`publish candidate date ${post.date} does not match NEWSLETTER_DATE ${runDate}`);
  if (!Array.isArray(post.sections) || post.sections.length === 0) throw new Error('publish candidate requires sections[]');
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error('publish candidate requires sources[]');
  if (!Array.isArray(post.highlights) || post.highlights.length === 0) throw new Error('publish candidate requires highlights[]');
  for (const [i, h] of post.highlights.entries()) {
    if (!h || typeof h !== 'object') throw new Error(`highlights[${i}] must be an object`);
    for (const k of ['title', 'priority', 'verifyLink', 'action']) {
      if (typeof h[k] !== 'string' || !h[k]) throw new Error(`highlights[${i}].${k} required`);
    }
    if (!PRIORITY_VALUES.has(h.priority)) throw new Error(`highlights[${i}].priority must be 상/중/하`);
  }
}

const REQUIRED_DISCLAIMER = '본 브리핑의 설명은 큐레이션 점수·짧은 분석 발췌·README 발췌에서 추출되었습니다. 구체 옵션·설정 키·플래그 이름은 도입 전 반드시 원문으로 확인하세요.';

function ensureDisclaimer(post) {
  const existing = post.confidence && typeof post.confidence === 'object' ? post.confidence : {};
  const note = typeof existing.note === 'string' ? existing.note : '';
  if (note.includes(REQUIRED_DISCLAIMER)) return post;
  const merged = note ? `${note} ${REQUIRED_DISCLAIMER}` : REQUIRED_DISCLAIMER;
  return {
    ...post,
    confidence: { level: existing.level || 'AI 초안', note: merged },
  };
}

async function main() {
  let post = await readJsonWithFallback(sourcePath, fallbackSourcePath);
  validatePost(post);
  assertImmutableAgainstDraft(post, await tryReadJson(draftReferencePath));
  post = ensureDisclaimer(post);

  await mkdir(contentPostsDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(post, null, 2));
  await copyFile(outputPath, path.join(generatedDir, `published-${postId}.json`));
  console.log(`Published opensource-curation: ${path.relative(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
