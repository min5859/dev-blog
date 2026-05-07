import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const runDate = process.env.NEWSLETTER_DATE || new Date().toISOString().slice(0, 10);
const postId = `${runDate}-linux-daily-briefing`;
const generatedDir = path.join(root, 'data', 'generated', topic);
const contentPostsDir = path.join(root, 'content', 'topics', topic, 'posts');
const sourcePath = process.env.PUBLISH_SOURCE || path.join(generatedDir, 'rewritten-latest.json');
const fallbackSourcePath = path.join(generatedDir, 'draft-latest.json');
const outputPath = path.join(contentPostsDir, `${postId}.json`);

async function readJsonWithFallback(primary, fallback) {
  try {
    return JSON.parse(await readFile(primary, 'utf8'));
  } catch (primaryError) {
    try {
      return JSON.parse(await readFile(fallback, 'utf8'));
    } catch {
      throw primaryError;
    }
  }
}

function validatePost(post) {
  for (const key of ['id', 'topic', 'title', 'date', 'summary', 'sections', 'sources']) {
    if (!post[key]) throw new Error(`publish candidate missing ${key}`);
  }
  if (post.topic !== topic) throw new Error(`publish candidate topic must be ${topic}`);
  if (post.date !== runDate) throw new Error(`publish candidate date ${post.date} does not match NEWSLETTER_DATE ${runDate}`);
  if (!Array.isArray(post.sections) || post.sections.length === 0) throw new Error('publish candidate requires sections[]');
  if (!Array.isArray(post.sources) || post.sources.length === 0) throw new Error('publish candidate requires sources[]');
}

async function main() {
  const post = await readJsonWithFallback(sourcePath, fallbackSourcePath);
  validatePost(post);

  await mkdir(contentPostsDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(post, null, 2));

  // Keep an explicit copy of the exact generated artifact that was promoted.
  const publishedCopy = path.join(generatedDir, `published-${postId}.json`);
  await copyFile(outputPath, publishedCopy);

  console.log(`Published Linux newsletter: ${path.relative(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
