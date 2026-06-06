import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runResearchAdapterPrompt, extractJsonObject } from './ai-rewrite-adapter.mjs';
import { validateDossier } from './dossier-schema.mjs';
import { IMPACT_TYPE_VALUES } from './highlight-schema.mjs';

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — 토픽-범용 research 실행기.
// claude/codex/cursor 경로는 candidates 슬림 필드 + 토픽 프롬프트만 쓰므로 토픽 무관.
// deterministic fallback 은 generic entryBuilder(헬퍼 없이 candidate 필드만)로 동작하되,
// 토픽이 더 풍부한 메타를 가지면 entryBuilder 를 주입해 품질을 올린다(linux).

const root = process.cwd();

export function isEvidenceUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

export function stripCommonPrefix(title) {
  return String(title || '')
    .replace(/^Re:\s*/i, '')
    .replace(/^\[(PATCH|GIT\s+PULL|RFC|ANNOUNCE)\b[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 토픽 헬퍼 없이 title+commitMessage 키워드로 impactType 을 추론.
export function genericImpactType(record) {
  const text = `${record.title || ''}\n${record.commitMessage || ''}`.toLowerCase();
  if (/\bcve\b|security|vuln|overflow|oob|use-after-free|\buaf\b/.test(text)) return 'security';
  if (/regression|oops|panic|crash|lockup|deadlock/.test(text)) return 'regression';
  if (/\babi\b|\bapi\b|interface|syscall|ioctl|uapi|breaking change/.test(text)) return 'api-abi';
  if (/release|\bv\d+\.\d+|tag|stable|rc\d/.test(text)) return 'release';
  if (/kbuild|compiler|clang|gcc|rust|linker|\bbuild\b/.test(text)) return 'build';
  if (/performance|latency|throughput|fast path|optimi[sz]/.test(text)) return 'performance';
  return 'runtime';
}

function evidenceKindOf(record) {
  if (record.sourceId === 'kernel-org-releases' || /release|changelog/i.test(record.kind || '')) return 'changelog';
  return record.commitMessage ? 'commit' : 'thread';
}

// 토픽 무관 deterministic entry. 풍부한 토픽은 entryBuilder 주입으로 대체.
function genericEntry(record, { defaultAudience }) {
  const title = stripCommonPrefix(record.title);
  const commit = String(record.commitMessage || '').trim();
  const firstPara = commit ? commit.split(/\n\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 280) : '';
  const impactType = IMPACT_TYPE_VALUES.has(record.impactType) ? record.impactType : genericImpactType(record);
  const whatChanged = firstPara || `${title} — 메타데이터 기준 후보입니다. 구체 변경은 원문에서 확인이 필요합니다.`;
  return {
    candidateId: record.id,
    title,
    whatChanged,
    whyItMatters: '시스템/사용자 영향 범위는 원문 확인이 필요합니다.',
    affectedAudience: record.affectedAudience || defaultAudience || '관련 개발자',
    impactType,
    confidence: firstPara ? 'medium' : 'low',
    evidence: [{
      claim: whatChanged.slice(0, 120),
      url: record.url,
      kind: evidenceKindOf(record),
      ...(firstPara ? { quote: firstPara.slice(0, 200) } : {}),
    }],
    openQuestions: firstPara ? [] : ['원문 본문 미확인 — write 단계에서 단정 표현 금지'],
  };
}

function slimCandidate(record) {
  return {
    candidateId: record.id,
    title: stripCommonPrefix(record.title),
    url: record.url,
    sourceId: record.sourceId,
    kind: record.kind,
    observedDate: record.observedDate,
    matchedSubsystems: record.matchedSubsystems || [],
    commitMessage: record.commitMessage || '',
  };
}

export function normalizeDossier(dossier) {
  for (const entry of dossier.entries || []) {
    for (const ev of entry.evidence || []) {
      if (typeof ev.quote === 'string' && ev.quote.length > 200) ev.quote = ev.quote.slice(0, 200);
    }
  }
  return dossier;
}

/**
 * @param {object} cfg
 * @param {string} cfg.topic
 * @param {string} cfg.runDate
 * @param {string} cfg.generatedDir
 * @param {string} cfg.candidatesPath
 * @param {string} cfg.promptTemplatePath
 * @param {string} cfg.adapter
 * @param {string} cfg.generatedAt
 * @param {string} [cfg.defaultAudience]
 * @param {(record:object)=>object} [cfg.entryBuilder]  토픽 특화 deterministic entry 빌더
 * @returns {Promise<object>} dossier
 */
export async function runResearch(cfg) {
  const { topic, runDate, generatedDir, candidatesPath, promptTemplatePath, adapter, generatedAt, defaultAudience, entryBuilder } = cfg;

  const candidatesData = JSON.parse(await readFile(candidatesPath, 'utf8'));
  const candidates = Array.isArray(candidatesData.candidates) ? candidatesData.candidates : [];
  if (!candidates.length) throw new Error(`${path.relative(root, candidatesPath)} has no candidates[]`);

  await mkdir(generatedDir, { recursive: true });

  const template = await readFile(promptTemplatePath, 'utf8');
  const prompt = template
    .replaceAll('{{RUN_DATE}}', runDate)
    .replace('{{CANDIDATES_JSON}}', JSON.stringify(candidates.map(slimCandidate), null, 2));
  await writeFile(path.join(generatedDir, `research-prompt-${runDate}.md`), prompt);
  await writeFile(path.join(generatedDir, 'research-prompt-latest.md'), prompt);

  let dossier;
  const raw = process.env.RESEARCH_RAW_PATH
    ? await readFile(process.env.RESEARCH_RAW_PATH, 'utf8')
    : await runResearchAdapterPrompt(prompt);
  if (raw) {
    await writeFile(path.join(generatedDir, `research-stdout-${runDate}.txt`), raw);
    await writeFile(path.join(generatedDir, 'research-stdout-latest.txt'), raw);
    const parsed = extractJsonObject(raw, (v) => v && Array.isArray(v.entries));
    if (!parsed) throw new Error('research adapter output did not contain a dossier JSON with entries[]');
    dossier = normalizeDossier({ ...parsed, topic, date: runDate, generatedAt, adapter });
  } else {
    const build = entryBuilder || ((record) => genericEntry(record, { defaultAudience }));
    const entries = [];
    const droppedCandidates = [];
    for (const record of candidates) {
      if (!isEvidenceUrl(record.url)) {
        droppedCandidates.push({ candidateId: record.id, reason: 'evidence 로 쓸 http(s) URL 이 없음' });
        continue;
      }
      entries.push(build(record));
    }
    dossier = { topic, date: runDate, generatedAt, adapter, entries, droppedCandidates };
  }

  validateDossier(dossier, `research-${topic}`);

  const out = path.join(generatedDir, `research-${runDate}.json`);
  const latest = path.join(generatedDir, 'research-latest.json');
  await writeFile(out, JSON.stringify(dossier, null, 2));
  await writeFile(latest, JSON.stringify(dossier, null, 2));

  return { dossier, out };
}
