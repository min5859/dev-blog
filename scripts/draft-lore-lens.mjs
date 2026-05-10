import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  annotateWithHistory,
  broadSubsystemsOf,
  buildPatchSection,
  buildSection,
  enrichWithBodies,
  highlightOf,
  impactLkml,
  impactRelease,
  isLoreKernelMailRecord,
  isRegressionSignal,
  isStaleReply,
  loadRecentSeriesHistory,
  mergePatchSeries,
  scoreRecord,
  stripPatchPrefix,
} from './draft-linux.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/draft-lore-lens.mjs <topicId>');
  process.exit(1);
}

const pipelinePath = path.join(root, 'content', 'topics', topic, 'pipeline.json');
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function applyTemplate(template, variables) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? '');
}

function isBroadImpactLens(record) {
  if (record.sourceId === 'kernel-org-releases') return true;
  if (isRegressionSignal(record)) return true;
  if (isLoreKernelMailRecord(record) && (record.kind === 'patch-discussion' || record.kind === 'pull-request')) return true;
  if (broadSubsystemsOf(record).length > 0) return true;
  return false;
}

function pickCandidatesLens(records) {
  const nowMs = Date.now();
  const scored = records.map(scoreRecord);
  const merged = mergePatchSeries(scored);
  const fresh = merged.filter((record) => !isStaleReply(record, nowMs));
  const broad = fresh.filter(isBroadImpactLens);
  broad.sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));

  const official = broad.filter((record) => record.sourceId === 'kernel-org-releases').slice(0, 4);
  const regressions = broad.filter(isRegressionSignal).slice(0, 3);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = broad
    .filter((record) => isLoreKernelMailRecord(record) && record.kind === 'patch-discussion' && !regressionIds.has(record.id))
    .slice(0, 4);
  const signals = broad
    .filter((record) => isLoreKernelMailRecord(record) && record.score >= 28)
    .filter((record) => !regressionIds.has(record.id) && !patches.some((patch) => patch.id === record.id))
    .slice(0, 2);

  const byId = new Map([...official, ...regressions, ...patches, ...signals].map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));
}

function toPostDraftLens(candidates, sourceData, pipeline, candidateBodies = []) {
  const postId = `${runDate}-${pipeline.postIdSuffix}`;
  const releases = candidates.filter((record) => record.sourceId === 'kernel-org-releases');
  const regressions = candidates.filter(isRegressionSignal);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = candidates.filter((record) => isLoreKernelMailRecord(record)
    && record.kind === 'patch-discussion'
    && !regressionIds.has(record.id));
  const otherSignals = candidates.filter((record) => isLoreKernelMailRecord(record)
    && record.kind !== 'patch-discussion'
    && !regressionIds.has(record.id));
  const top = candidates.slice(0, 4);
  const tags = Array.isArray(pipeline.draftTags) && pipeline.draftTags.length ? pipeline.draftTags : ['리눅스', '커널', '초안'];

  return {
    id: postId,
    topic,
    title: applyTemplate(pipeline.draftTitleTemplate, { date: runDate }),
    date: runDate,
    summary: `오늘의 핵심: 릴리스 ${releases.length}건, 회귀·리스크 ${regressions.length}건, 패치 ${patches.length}건. ${pipeline.summaryNote || '본 토픽은 전문 메일링 리스트 렌즈입니다. 세부 드라이버·단일 보드 변경은 후보에서 제외했을 수 있습니다.'}`,
    tags,
    highlights: top.map(highlightOf),
    sections: [
      {
        heading: '릴리스/로드맵',
        body: buildSection(releases, pipeline.emptyReleaseNote || '이번 수집에서 신규 릴리스가 없습니다.', impactRelease),
      },
      {
        heading: '회귀·보안 신호',
        body: buildSection(regressions, '회귀·보안 신호로 분류된 항목이 없습니다.', (r) => impactLkml(r)),
      },
      {
        heading: '핵심 변경',
        body: buildPatchSection(patches, '이번 수집에서 우선 순위가 높은 패치가 분류되지 않았습니다.'),
      },
      {
        heading: '기타',
        body: otherSignals.length
          ? buildSection(otherSignals.slice(0, 2), '추가 신호가 없습니다.', (r) => impactLkml(r))
          : (pipeline.otherSectionNote || '리스트 범위 밖 토론은 제외했습니다. 필요 시 lore.kernel.org에서 키워드를 좁혀 검색하세요.'),
      },
    ],
    confidence: {
      level: '초안',
      note: '제목·메타데이터 기반 자동 선별입니다. 게시 전 원문 확인이 필요합니다.',
    },
    sources: candidates.slice(0, 8).map((record) => ({
      title: stripPatchPrefix(record.title),
      url: record.url,
      note: `${record.source} · ${record.kind}`,
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-lore-lens.mjs',
      candidateIds: candidates.map((record) => record.id),
      bucketCounts: {
        releases: releases.length,
        regressions: regressions.length,
        patches: patches.length,
        otherSignals: otherSignals.length,
      },
      subsystems: [...new Set(candidates.flatMap((c) => broadSubsystemsOf(c)))],
      lensPipeline: pipeline.pipelineName || topic,
    },
    candidateBodies,
  };
}

async function main() {
  const pipeline = await readJson(pipelinePath);
  if (pipeline.topic && pipeline.topic !== topic) {
    throw new Error(`${path.relative(root, pipelinePath)}: topic must match folder (${topic})`);
  }
  if (!pipeline.postIdSuffix || !pipeline.draftTitleTemplate) {
    throw new Error(`${path.relative(root, pipelinePath)}: postIdSuffix and draftTitleTemplate are required`);
  }

  const sourceData = await readJson(inputPath);
  if (!Array.isArray(sourceData.records)) {
    throw new Error(`${path.relative(root, inputPath)} does not contain records[]`);
  }

  const postId = `${runDate}-${pipeline.postIdSuffix}`;
  const rawCandidates = pickCandidatesLens(sourceData.records);
  const seriesHistory = await loadRecentSeriesHistory(generatedDir, runDate);
  const candidates = annotateWithHistory(rawCandidates, seriesHistory);
  const candidateBodies = await enrichWithBodies(candidates);
  const bodyById = new Map(candidateBodies.map((entry) => [entry.id, entry]));
  for (const candidate of candidates) {
    const body = bodyById.get(candidate.id);
    if (body?.commitMessage) candidate.commitMessage = body.commitMessage;
  }
  const bodyHits = candidateBodies.filter((entry) => entry.commitMessage).length;
  const trackedHits = candidateBodies.filter((entry) => entry.history).length;
  const draft = toPostDraftLens(candidates, sourceData, pipeline, candidateBodies);

  await mkdir(generatedDir, { recursive: true });

  const candidateOutput = path.join(generatedDir, `candidates-${runDate}.json`);
  const candidateLatest = path.join(generatedDir, 'candidates-latest.json');
  const draftOutput = path.join(generatedDir, `${postId}.json`);
  const draftLatest = path.join(generatedDir, 'draft-latest.json');

  const candidatePayload = { topic, generatedAt, sourceRecordCount: sourceData.recordCount, candidateCount: candidates.length, candidates };
  await writeFile(candidateOutput, JSON.stringify(candidatePayload, null, 2));
  await writeFile(candidateLatest, JSON.stringify(candidatePayload, null, 2));
  await writeFile(draftOutput, JSON.stringify(draft, null, 2));
  await writeFile(draftLatest, JSON.stringify(draft, null, 2));

  console.log(`[${topic}] Selected ${candidates.length} candidate(s); fetched ${bodyHits} bodies; ${trackedHits} history hit(s); wrote ${path.relative(root, draftOutput)}`);
}

const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { pickCandidatesLens, toPostDraftLens, applyTemplate };
