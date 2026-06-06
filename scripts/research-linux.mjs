import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveAiAdapter, runResearchAdapterPrompt, extractJsonObject } from './lib/ai-rewrite-adapter.mjs';
import { validateDossier } from './lib/dossier-schema.mjs';
import {
  stripPatchPrefix,
  affectedAudienceFor,
  impactTypeFor,
  broadSubsystemsOf,
} from './draft-linux.mjs';

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — research 단계는 draft 의 후보 선정 결과를
// 입력으로 받아, 도구 기반 조사(claude) 또는 deterministic fallback(template/codex)로 dossier 를 만든다.

const root = process.cwd();
const topic = 'linux';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const generatedDir = path.join(root, 'data', 'generated', topic);
const candidatesPath = process.env.CANDIDATES_PATH || path.join(generatedDir, 'candidates-latest.json');
const promptTemplatePath = path.join(root, 'prompts', 'linux-research-ko.md');
const adapter = resolveAiAdapter();
const generatedAt = new Date().toISOString();

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function isEvidenceUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

function slimCandidate(record) {
  return {
    candidateId: record.id,
    title: stripPatchPrefix(record.title),
    url: record.url,
    sourceId: record.sourceId,
    kind: record.kind,
    observedDate: record.observedDate,
    moniker: record.metadata?.moniker,
    matchedSubsystems: record.matchedSubsystems || [],
    commitMessage: record.commitMessage || '',
  };
}

function evidenceKindOf(record) {
  if (record.sourceId === 'kernel-org-releases') return 'changelog';
  return record.commitMessage ? 'commit' : 'thread';
}

// Plan SC: template/codex 어댑터에서도 파이프라인이 끝까지 돌도록, draft 결과만으로
// schema-valid 한 dossier 를 만든다(도구 조사 없이). 품질은 claude 경로가 끌어올린다.
function deterministicEntry(record) {
  const title = stripPatchPrefix(record.title);
  const subsystems = broadSubsystemsOf(record);
  const commit = String(record.commitMessage || '').trim();
  const firstPara = commit ? commit.split(/\n\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 280) : '';
  const whatChanged = firstPara
    || `${title} — 메타데이터 기준 후보입니다. 구체 변경은 원문에서 확인이 필요합니다.`;
  const whyItMatters = subsystems.length
    ? `${subsystems.join(', ')} 서브시스템에 영향이 갈 수 있습니다.`
    : record.sourceId === 'kernel-org-releases'
      ? `${record.metadata?.moniker || 'release'} 라인을 쓰는 환경에 영향이 갈 수 있습니다.`
      : '시스템 영향 범위는 원문 확인이 필요합니다.';
  const evidence = [{
    claim: whatChanged.slice(0, 120),
    url: record.url,
    kind: evidenceKindOf(record),
    ...(firstPara ? { quote: firstPara.slice(0, 200) } : {}),
  }];
  return {
    candidateId: record.id,
    title,
    whatChanged,
    whyItMatters,
    affectedAudience: affectedAudienceFor(record),
    impactType: impactTypeFor(record),
    confidence: firstPara ? 'medium' : 'low',
    evidence,
    openQuestions: firstPara ? [] : ['원문 본문 미확인 — write 단계에서 단정 표현 금지'],
  };
}

function buildDeterministicDossier(candidates) {
  const entries = [];
  const droppedCandidates = [];
  for (const record of candidates) {
    if (!isEvidenceUrl(record.url)) {
      droppedCandidates.push({ candidateId: record.id, reason: 'evidence 로 쓸 http(s) URL 이 없음' });
      continue;
    }
    entries.push(deterministicEntry(record));
  }
  return { topic, date: runDate, generatedAt, adapter, entries, droppedCandidates };
}

// 모델이 evidence.quote 를 200자보다 길게 줄 수 있다. validator 가 거부하기 전에 잘라 normalize.
function normalizeDossier(dossier) {
  for (const entry of dossier.entries || []) {
    for (const ev of entry.evidence || []) {
      if (typeof ev.quote === 'string' && ev.quote.length > 200) {
        ev.quote = ev.quote.slice(0, 200);
      }
    }
  }
  return dossier;
}

function buildPrompt(template, candidates) {
  return template
    .replaceAll('{{RUN_DATE}}', runDate)
    .replace('{{CANDIDATES_JSON}}', JSON.stringify(candidates.map(slimCandidate), null, 2));
}

async function main() {
  const candidatesData = await readJson(candidatesPath);
  const candidates = Array.isArray(candidatesData.candidates) ? candidatesData.candidates : [];
  if (!candidates.length) {
    throw new Error(`${path.relative(root, candidatesPath)} has no candidates[]`);
  }

  await mkdir(generatedDir, { recursive: true });

  const template = await readFile(promptTemplatePath, 'utf8');
  const prompt = buildPrompt(template, candidates);
  await writeFile(path.join(generatedDir, `research-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'research-prompt-latest.md'), prompt);

  let dossier;
  // RESEARCH_RAW_PATH 가 있으면 이전 어댑터 stdout 을 재파싱(재호출 없이 복구/디버깅).
  const raw = process.env.RESEARCH_RAW_PATH
    ? await readFile(process.env.RESEARCH_RAW_PATH, 'utf8')
    : await runResearchAdapterPrompt(prompt);
  if (raw) {
    await writeFile(path.join(generatedDir, `research-stdout-${runDate}.txt`), raw);
    await writeFile(path.join(generatedDir, 'research-stdout-latest.txt'), raw);
    const parsed = extractJsonObject(raw, (v) => v && Array.isArray(v.entries));
    if (!parsed) throw new Error('research adapter output did not contain a dossier JSON with entries[]');
    // 불변 필드는 입력 기준으로 고정 (모델이 바꿔도 무시) + 모델이 길게 준 quote 는 잘라 normalize
    dossier = normalizeDossier({ ...parsed, topic, date: runDate, generatedAt, adapter });
  } else {
    dossier = buildDeterministicDossier(candidates);
  }

  validateDossier(dossier, 'research-linux');

  const out = path.join(generatedDir, `research-${runDate}.json`);
  const latest = path.join(generatedDir, 'research-latest.json');
  await writeFile(out, JSON.stringify(dossier, null, 2));
  await writeFile(latest, JSON.stringify(dossier, null, 2));

  console.log(
    `Built Linux research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), `
    + `${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
