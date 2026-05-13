import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateHighlight } from './lib/highlight-schema.mjs';

const root = process.cwd();
const topic = 'android';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-android-daily-briefing`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const contentPostsDir = path.join(root, 'content', 'topics', topic, 'posts');
const sourcePath = process.env.PUBLISH_SOURCE || path.join(generatedDir, 'rewritten-latest.json');
const fallbackSourcePath = path.join(generatedDir, 'draft-latest.json');
const draftReferencePath = path.join(generatedDir, 'draft-latest.json');
const outputPath = path.join(contentPostsDir, `${postId}.json`);

async function readJsonWithFallback(primary, fallback) {
  try { return JSON.parse(await readFile(primary, 'utf8')); }
  catch (primaryError) {
    try { return JSON.parse(await readFile(fallback, 'utf8')); }
    catch { throw primaryError; }
  }
}

async function tryReadJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
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
  post.highlights.forEach((h, i) => validateHighlight(h, i));
}

async function main() {
  const post = await readJsonWithFallback(sourcePath, fallbackSourcePath);
  const draftReference = await tryReadJson(draftReferencePath);
  validatePost(post);
  assertImmutableAgainstDraft(post, draftReference);

  await mkdir(contentPostsDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(post, null, 2));

  const publishedCopy = path.join(generatedDir, `published-${postId}.json`);
  await copyFile(outputPath, publishedCopy);

  console.log(`Published Android newsletter: ${path.relative(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
