#!/usr/bin/env node
// data/raw/driver-impact/<from>..<to>.json → content/topics/linux-driver-impact/posts/<date>-linux-<to>-driver-impact.json
// AI 는 ask 모드(도구·웹 없음)로 커밋·pull 문구만 요약하고, 표·명령·링크는 코드가 만든다.
// 독자 프로필(config/driver-impact.json)이 있으면 그 독자의 드라이버가 쓰던 것을 위에 두고 나머지는 접는다.
// AI_ADAPTER=template 이면 AI 없이 사실 부분만 쓴다.
//   node scripts/draft-driver-impact.mjs --from v7.3 --to v7.4-rc1
//   node scripts/draft-driver-impact.mjs --from v6.12 --to v6.18 --lts   (LTS → 다음 LTS 노트)
//   --reuse-notes   AI 를 다시 부르지 않고 지난 AI 원본(게시된 글의 draftMetadata.aiNotes)으로 글만 다시 만든다(표현·구조만 바꿀 때).
//   --out <dir>     글을 content/ 대신 다른 디렉터리에 쓴다(게시 전 미리보기). daily-deploy.sh 는 content/ 를 통째로 게시한다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonObject, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';
import { buildAiInput, buildPost, cleanNotes, RAW_SCHEMA } from './lib/driver-impact.mjs';
import { loadProfile } from './lib/driver-impact-profile.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const postsDir = path.join(root, 'content', 'topics', 'linux-driver-impact', 'posts');
const value = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : process.env[`DRIVER_IMPACT_${name.toUpperCase()}`];
};
const option = (name) => {
  const v = value(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

// overview 가 비어도 대체 API·pull 요약이 있으면 쓸 수 있다(독자와 가까운 변경이 없는 조용한 범위).
const usable = (notes) => notes.overview.length > 0 || notes.apiNotes.size > 0 || notes.subsystems.size > 0;

async function askAi(input) {
  if (resolveAiAdapter() === 'template') return undefined;
  const instructions = await readFile(path.join(root, 'prompts', 'driver-impact-ko.md'), 'utf8');
  const prompt = `${instructions}\n${JSON.stringify(input, null, 1)}\n`;
  const isNotes = (v) => Array.isArray(v?.overview) && Array.isArray(v?.subsystems);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const retry = attempt > 1 ? '\n\n[재시도] 직전 응답이 형식에 맞는 JSON이 아니었습니다. 도구 없이 JSON 객체 하나만 출력하세요.' : '';
    const raw = await runAiAdapterPrompt(prompt + retry);
    const parsed = extractJsonObject(raw, isNotes);
    if (!parsed) {
      console.warn(`[driver-impact] attempt ${attempt}: no notes JSON in AI output (${raw?.length || 0} bytes)`);
      continue;
    }
    const { notes, dropped } = cleanNotes(parsed, input);
    if (dropped) console.warn(`[driver-impact] dropped ${dropped} AI items that cited unknown ids or broke limits`);
    if (usable(notes)) return { raw: parsed, notes };
    console.warn(`[driver-impact] attempt ${attempt}: no usable notes`);
  }
  throw new Error('AI notes unusable after 2 attempts');
}

/** 지난 AI 원본: 같은 범위의 게시된 글(draftMetadata.aiNotes). 없으면 undefined. */
async function savedNotes(postFile, input) {
  const raw = (await readJson(postFile).catch(() => null))?.draftMetadata?.aiNotes;
  if (!raw) return undefined;
  const { notes, dropped } = cleanNotes(raw, input);
  console.log(`[driver-impact] reusing AI notes from ${path.relative(root, postFile)}${dropped ? ` (${dropped} items dropped by the guards)` : ''}`);
  return usable(notes) ? { raw, notes } : undefined;
}

async function main() {
  const range = `${option('from')}..${option('to')}`;
  const lts = process.argv.includes('--lts');
  const data = await readJson(path.join(root, 'data', 'raw', 'driver-impact', `${range}.json`));
  if (data.schema !== RAW_SCHEMA) throw new Error(`raw data for ${range} is from an older collector (schema ${data.schema ?? 1}, need ${RAW_SCHEMA}); run collect-driver-impact.mjs again`);
  const profile = await loadProfile(root);
  const input = buildAiInput(data, profile);
  console.log(`[driver-impact] profile ${profile.id}; AI input ${Buffer.byteLength(JSON.stringify(input))} bytes: ${input.pulls.length} pulls, `
    + `${input.apiRemovals.length} removals, ${input.conversions.length} conversions, `
    + `focus ${input.focus.filter((f) => f.changes.length).map((f) => `${f.id}:${f.changes.length}`).join(' ')}`);
  const outDir = value('out') ? path.resolve(value('out')) : postsDir;
  const file = `${buildPost(data, input, undefined, { lts, profile }).id}.json`;
  // --reuse-notes: 쓰려는 자리(미리보기 디렉터리)의 글을 먼저 보고, 없으면 게시된 글의 AI 원본을 쓴다.
  const reuse = process.argv.includes('--reuse-notes')
    ? await savedNotes(path.join(outDir, file), input) || await savedNotes(path.join(postsDir, file), input)
    : undefined;
  const ai = reuse || await askAi(input);
  const post = buildPost(data, input, ai?.notes, { lts, profile });
  if (ai) post.draftMetadata.aiNotes = ai.raw; // 감사·재생성용 AI 원본. 글과 함께 게시되어야 다음에 AI 없이 다시 만들 수 있다.
  auditPostQuality(post);
  const out = path.join(outDir, file);
  await mkdir(outDir, { recursive: true });
  await writeFile(out, `${JSON.stringify(post, null, 2)}\n`);
  const chars = post.sections.reduce((n, s) => n + s.body.length, 0);
  console.log(`[driver-impact] ${post.draftMetadata.ai ? 'AI' : 'template'} post → ${path.relative(root, out)} (${post.sections.length} sections, ${chars} chars)`);
}

main().catch((err) => {
  console.error(`[driver-impact] ${err.message}`);
  process.exitCode = 1;
});
