#!/usr/bin/env node
// data/raw/driver-impact/<from>..<to>.json → content/topics/linux-driver-impact/posts/<date>-linux-<to>-driver-impact.json
// AI 는 ask 모드(도구·웹 없음)로 커밋·pull 문구만 요약하고, 표·명령·링크는 코드가 만든다.
// AI_ADAPTER=template 이면 AI 없이 사실 부분만 쓴다.
//   node scripts/draft-driver-impact.mjs --from v7.3 --to v7.4-rc1
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonObject, resolveAiAdapter, runAiAdapterPrompt } from './lib/ai-rewrite-adapter.mjs';
import { buildAiInput, buildPost, cleanNotes } from './lib/driver-impact.mjs';
import { auditPostQuality } from './lib/quality-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at > 0 ? process.argv[at + 1] : process.env[`DRIVER_IMPACT_${name.toUpperCase()}`];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

async function writeNotes(input, notesFile) {
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
    await mkdir(path.dirname(notesFile), { recursive: true });
    await writeFile(notesFile, `${JSON.stringify(parsed, null, 2)}\n`); // 감사·재생성용 AI 원본
    const { notes, dropped } = cleanNotes(parsed, input);
    if (dropped) console.warn(`[driver-impact] dropped ${dropped} AI items that cited unknown ids or broke limits`);
    if (notes.overview.length) return notes;
    console.warn(`[driver-impact] attempt ${attempt}: no usable overview items`);
  }
  throw new Error('AI notes unusable after 2 attempts');
}

async function main() {
  const range = `${option('from')}..${option('to')}`;
  const data = JSON.parse(await readFile(path.join(root, 'data', 'raw', 'driver-impact', `${range}.json`), 'utf8'));
  const input = buildAiInput(data);
  console.log(`[driver-impact] AI input ${Buffer.byteLength(JSON.stringify(input))} bytes: ${input.pulls.length} pulls, `
    + `${input.apiRemovals.length} removals, ${input.conversions.length} conversions, `
    + `focus ${input.focus.map((f) => `${f.id}:${f.changes.length}`).join(' ')}`);
  const post = buildPost(data, input, await writeNotes(input, path.join(root, 'data', 'generated', 'driver-impact', `${range}.notes.json`)));
  auditPostQuality(post);
  const out = path.join(root, 'content', 'topics', post.topic, 'posts', `${post.id}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(post, null, 2)}\n`);
  console.log(`[driver-impact] ${post.draftMetadata.ai ? 'AI' : 'template'} post → ${path.relative(root, out)}`);
}

main().catch((err) => {
  console.error(`[driver-impact] ${err.message}`);
  process.exitCode = 1;
});
