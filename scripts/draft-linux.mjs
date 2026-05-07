import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const runDate = process.env.NEWSLETTER_DATE || generatedAt.slice(0, 10);
const postId = `${runDate}-linux-daily-briefing`;
const STALE_REPLY_MS = 24 * 60 * 60 * 1000;

const subsystemPatterns = new Map([
  ['가상화', [/\bkvm\b/, /\bxen\b/, /\bvirt\b/, /hypervisor/]],
  ['네트워크', [/\bnet:/, /\bnetdev\b/, /\bdsa\b/, /\btcp\b/, /\budp\b/, /ethernet/, /wifi/, /wireless/]],
  ['스토리지/파일시스템', [/\bfs:/, /\bblock\b/, /\bbtrfs\b/, /\bxfs\b/, /\bext4\b/, /\bnvme\b/, /\bscsi\b/, /\bubi\b/]],
  ['메모리 관리', [/\bmm:/, /memory/, /\bpage\b/, /\bfolio\b/, /\bslab\b/, /vmalloc/]],
  ['스케줄러/실시간', [/\bsched\b/, /preempt_rt/, /\bPREEMPT_RT\b/i]],
  ['보안', [/security/, /\bcve\b/, /selinux/, /apparmor/, /crypto/]],
  ['드라이버', [/\bdriver\b/, /drivers\//, /\bgpu\b/, /\bdrm\b/, /\busb\b/, /\bpci\b/, /\biommu\b/]],
  ['아키텍처', [/\barm64\b/, /\bx86\b/, /\briscv\b/, /\bpowerpc\b/, /\bloongarch\b/]],
]);

const regressionPattern = /(regression|oops|panic|crash|cve|\bbug\b|security|\bfix\b)/i;
const monikerImpact = new Map([
  ['mainline', '메인라인 추적 대상 환경'],
  ['stable', '안정 커널 사용 환경'],
  ['longterm', '장기 지원 커널 사용 환경'],
  ['linux-next', '머지 큐 추적 대상'],
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function scoreRecord(record) {
  let score = 0;
  const reasons = [];
  const title = record.title.toLowerCase();
  const tags = new Set(record.tags || []);

  if (record.sourceId === 'kernel-org-releases') {
    score += 40;
    reasons.push('공식 릴리스 메타데이터');
    if (record.metadata?.moniker === 'mainline') {
      score += 30;
      reasons.push('mainline 릴리스/RC');
    }
    if (record.metadata?.moniker === 'stable') {
      score += 24;
      reasons.push('stable 업데이트');
    }
    if (record.metadata?.moniker === 'linux-next') {
      score += 22;
      reasons.push('linux-next 스냅샷');
    }
    if (record.metadata?.isEol) {
      score += 12;
      reasons.push('EOL 표시');
    }
  }

  if (record.sourceId === 'lore-lkml-new') {
    score += 8;
    reasons.push('LKML 최신 토론');
    if (record.kind === 'patch-discussion') {
      score += 28;
      reasons.push('패치 토론');
    }
    if (record.kind === 'pull-request') {
      score += 38;
      reasons.push('pull request');
    }
    if (title.startsWith('re:') || tags.has('reply')) {
      score -= 8;
      reasons.push('응답 메일이라 우선순위 감점');
    }
    if (/\[patch v?\d*/i.test(record.title)) {
      score += 8;
      reasons.push('버전이 명시된 패치');
    }
    if (regressionPattern.test(record.title)) {
      score += 18;
      reasons.push('회귀/버그/보안 신호');
    }
  }

  const matchedSubsystems = [];
  for (const [label, patterns] of subsystemPatterns) {
    if (patterns.some((pattern) => pattern.test(record.title))) {
      matchedSubsystems.push(label);
    }
  }
  if (matchedSubsystems.length) {
    score += Math.min(18, matchedSubsystems.length * 6);
    reasons.push(`관련 영역: ${matchedSubsystems.join(', ')}`);
  }

  return {
    ...record,
    score,
    scoreReasons: reasons,
    matchedSubsystems,
  };
}

function stripPatchPrefix(title) {
  return title
    .replace(/^Re:\s*/i, '')
    .replace(/^\[PATCH\b[^\]]*\]\s*/i, '')
    .replace(/^\[GIT\s+PULL\b[^\]]*\]\s*/i, '')
    .replace(/^\[RFC\b[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function patchVersion(record) {
  const match = record.title.match(/\[PATCH\s+v(\d+)/i);
  return match ? Number(match[1]) : 1;
}

function patchSeriesKey(record) {
  if (record.sourceId !== 'lore-lkml-new') return null;
  const stripped = stripPatchPrefix(record.title).toLowerCase();
  if (!stripped) return null;
  const author = record.metadata?.author?.email || record.metadata?.author?.name || '';
  return `${stripped}::${author}`;
}

function mergePatchSeries(records) {
  const grouped = new Map();
  const passthrough = [];
  for (const record of records) {
    const key = patchSeriesKey(record);
    if (!key) {
      passthrough.push(record);
      continue;
    }
    const existing = grouped.get(key);
    if (!existing || patchVersion(record) > patchVersion(existing)) {
      grouped.set(key, record);
    }
  }
  return [...passthrough, ...grouped.values()];
}

function isStaleReply(record, nowMs = Date.now()) {
  if (record.sourceId !== 'lore-lkml-new') return false;
  const isReply = record.kind === 'mail-reply' || record.title.toLowerCase().startsWith('re:');
  if (!isReply) return false;
  if (!record.observedDate) return true;
  const observedMs = Date.parse(`${record.observedDate}T00:00:00Z`);
  if (!Number.isFinite(observedMs)) return true;
  return nowMs - observedMs > STALE_REPLY_MS;
}

function isRegressionSignal(record) {
  return record.sourceId === 'lore-lkml-new' && regressionPattern.test(record.title);
}

function pickCandidates(records) {
  const nowMs = Date.now();
  const scored = records.map(scoreRecord);
  const merged = mergePatchSeries(scored);
  const fresh = merged.filter((record) => !isStaleReply(record, nowMs));
  fresh.sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));

  const official = fresh.filter((record) => record.sourceId === 'kernel-org-releases').slice(0, 5);
  const regressions = fresh.filter(isRegressionSignal).slice(0, 5);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = fresh
    .filter((record) => record.sourceId === 'lore-lkml-new' && record.kind === 'patch-discussion' && !regressionIds.has(record.id))
    .slice(0, 8);
  const signals = fresh
    .filter((record) => record.sourceId === 'lore-lkml-new' && record.score >= 28)
    .filter((record) => !regressionIds.has(record.id) && !patches.some((patch) => patch.id === record.id))
    .slice(0, 5);

  const byId = new Map([...official, ...regressions, ...patches, ...signals].map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));
}

function bucketBySubsystem(records) {
  const buckets = new Map();
  for (const record of records) {
    const labels = record.matchedSubsystems?.length ? record.matchedSubsystems : ['미분류'];
    for (const label of labels) {
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(record);
    }
  }
  return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko'));
}

function verifyLinkFor(record) {
  if (record.sourceId === 'kernel-org-releases') {
    return record.links?.find((link) => link.kind === 'changelog')?.url
      || record.links?.find((link) => link.kind === 'gitweb')?.url
      || record.links?.find((link) => link.kind === 'patch.full')?.url
      || record.url
      || '없음';
  }
  return record.url || '없음';
}

function priorityFor(record) {
  if (isRegressionSignal(record)) return '상';
  if (record.sourceId === 'kernel-org-releases') {
    if (record.metadata?.moniker === 'mainline') return '상';
    if (record.metadata?.moniker === 'stable' || record.metadata?.moniker === 'longterm') return '중';
    return '하';
  }
  if (record.kind === 'pull-request') return '상';
  if (record.kind === 'patch-discussion' && record.score >= 50) return '중';
  return '하';
}

function actionFor(record) {
  if (record.sourceId === 'kernel-org-releases') {
    const moniker = record.metadata?.moniker || 'release';
    if (moniker === 'mainline') return 'merge-window 흐름과 RC 후보 변화를 다음 수집까지 계속 추적하세요.';
    if (moniker === 'stable') return 'changelog에서 자기 환경에 영향 가능한 백포트가 있는지 확인하세요.';
    if (moniker === 'longterm') return '장기 지원 라인 사용 환경이라면 changelog와 보안 패치 포함 여부를 확인하세요.';
    if (moniker === 'linux-next') return 'linux-next 스냅샷에서 자기 서브시스템의 새 패치가 들어왔는지 점검하세요.';
    return '릴리스 메타데이터를 원본에서 다시 확인하세요.';
  }
  if (isRegressionSignal(record)) return '원문 스레드를 우선 확인해 영향 범위와 백포트 필요성을 판단하세요.';
  if (record.kind === 'pull-request') return 'pull request 본문과 머지 대상을 확인해 영향 서브시스템을 좁히세요.';
  if (record.matchedSubsystems?.length) {
    return `자기 환경이 ${record.matchedSubsystems.join(', ')} 서브시스템에 의존한다면 스레드 흐름을 모니터링하세요.`;
  }
  return '스레드의 후속 응답을 모니터링해 실제 설계 논의인지 단순 응답인지 분류하세요.';
}

function highlightOf(record) {
  return {
    title: stripPatchPrefix(record.title),
    priority: priorityFor(record),
    verifyLink: verifyLinkFor(record),
    action: actionFor(record),
  };
}

function impactRelease(record) {
  const moniker = record.metadata?.moniker || 'release';
  const date = record.observedDate || '공개일 미상';
  const eol = record.metadata?.isEol ? ' · EOL 라인' : '';
  const impact = monikerImpact.get(moniker) || '대상 환경 확인 필요';
  return [
    `- ${stripPatchPrefix(record.title)}`,
    `  · 무엇: ${moniker} 라인 릴리스, 공개일 ${date}${eol}`,
    `  · 영향: ${impact}`,
    `  · 확인할 것: ${verifyLinkFor(record)}`,
  ].join('\n');
}

function impactLkml(record) {
  const author = record.metadata?.author?.name || record.metadata?.author?.email || '작성자 미상';
  const subsystems = record.matchedSubsystems?.length ? record.matchedSubsystems.join(', ') : '서브시스템 미분류';
  const kindLabel = record.kind === 'pull-request' ? 'pull request'
    : record.kind === 'patch-discussion' ? `패치 토론${patchVersion(record) > 1 ? ` (v${patchVersion(record)})` : ''}`
    : record.kind === 'mail-reply' ? '응답 메일'
    : 'LKML 토론';
  return [
    `- ${stripPatchPrefix(record.title)}`,
    `  · 무엇: ${author}이 보낸 ${kindLabel}`,
    `  · 영향: ${subsystems}`,
    `  · 확인할 것: ${record.url}`,
  ].join('\n');
}

function buildSection(records, fallback, formatter) {
  if (!records.length) return fallback;
  return records.map(formatter).join('\n\n');
}

function buildPatchSection(records, fallback) {
  if (!records.length) return fallback;
  const buckets = bucketBySubsystem(records);
  return buckets
    .map(([label, items]) => `[${label}]\n${items.slice(0, 3).map(impactLkml).join('\n\n')}`)
    .join('\n\n');
}

function toPostDraft(candidates, sourceData) {
  const releases = candidates.filter((record) => record.sourceId === 'kernel-org-releases');
  const regressions = candidates.filter(isRegressionSignal);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = candidates.filter((record) => record.sourceId === 'lore-lkml-new'
    && record.kind === 'patch-discussion'
    && !regressionIds.has(record.id));
  const otherSignals = candidates.filter((record) => record.sourceId === 'lore-lkml-new'
    && record.kind !== 'patch-discussion'
    && !regressionIds.has(record.id));
  const top = candidates.slice(0, 5);
  const mainline = sourceData.records.find((record) => record.sourceId === 'kernel-org-releases' && record.metadata?.moniker === 'mainline');
  const latestStable = sourceData.records.find((record) => record.sourceId === 'kernel-org-releases' && record.metadata?.moniker === 'stable');

  return {
    id: postId,
    topic,
    title: `${runDate} 커널 개발 브리핑 (초안)`,
    date: runDate,
    summary: `kernel.org 릴리스 ${releases.length}건, 회귀·보안 신호 ${regressions.length}건, 패치 토론 ${patches.length}건, 추가 LKML 신호 ${otherSignals.length}건을 후보로 정리한 자동 생성 초안입니다.`,
    tags: ['리눅스', '커널', 'LKML', '릴리스', '초안'],
    highlights: top.map(highlightOf),
    sections: [
      {
        heading: '릴리스/로드맵',
        body: buildSection(releases, '이번 수집분에서 우선순위가 높은 공식 릴리스 신호가 없습니다.', impactRelease),
      },
      {
        heading: '회귀·보안 신호',
        body: buildSection(regressions, '이번 수집분에서 회귀·보안으로 분류된 항목이 없습니다.', impactLkml),
      },
      {
        heading: '주요 패치/토론',
        body: buildPatchSection(patches, '이번 수집분에서 우선순위가 높은 패치 토론이 없습니다.'),
      },
      {
        heading: '추가 LKML 신호',
        body: buildSection(otherSignals.slice(0, 5), '이번 수집분에서 추가로 볼 LKML 신호가 없습니다.', impactLkml),
      },
    ],
    implications: [
      mainline ? `mainline 상태: ${mainline.title}. 다음 릴리스 후보 흐름과 merge-window 신호를 계속 추적해야 합니다.` : 'mainline 릴리스 정보를 확인하지 못했습니다.',
      latestStable ? `latest stable 후보: ${latestStable.title}. stable changelog 기반 영향도 분류가 다음 보강 지점입니다.` : 'stable 릴리스 정보를 확인하지 못했습니다.',
      regressions.length
        ? `회귀·보안 신호 ${regressions.length}건이 분류되었습니다. 게시 전 원문 스레드 확인이 필요합니다.`
        : '회귀·보안 신호가 비어 있다면 새로 들어온 패치 시리즈가 안정 단계임을 의미할 수 있습니다.',
    ],
    nextActions: [
      '상위 릴리스 후보의 changelog/diffview를 확인해 실제 변경 범위를 분류합니다.',
      '회귀·보안 섹션의 원문 스레드를 우선 확인해 영향 범위와 백포트 필요성을 판단합니다.',
      '서브시스템별 패치 그룹 중 자기 환경에 해당하는 항목만 추려 팀에 공유합니다.',
    ],
    confidence: {
      level: '초안',
      note: '메타데이터/제목 기반 자동 선별 결과입니다. 게시 전 원문 검토 또는 AI 본문 요약이 필요합니다.',
    },
    sources: candidates.slice(0, 12).map((record) => ({
      title: stripPatchPrefix(record.title),
      url: record.url,
      note: `${record.source} · ${record.kind}`,
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-linux.mjs',
      candidateIds: candidates.map((record) => record.id),
      bucketCounts: {
        releases: releases.length,
        regressions: regressions.length,
        patches: patches.length,
        otherSignals: otherSignals.length,
      },
      subsystems: [...new Set(candidates.flatMap((record) => record.matchedSubsystems || []))],
    },
  };
}

async function main() {
  const sourceData = await readJson(inputPath);
  if (!Array.isArray(sourceData.records)) {
    throw new Error(`${path.relative(root, inputPath)} does not contain records[]`);
  }

  const candidates = pickCandidates(sourceData.records);
  const draft = toPostDraft(candidates, sourceData);

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

  console.log(`Selected ${candidates.length} newsletter candidate(s) from ${sourceData.recordCount} source record(s); wrote ${path.relative(root, draftOutput)}`);
}

const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  scoreRecord,
  stripPatchPrefix,
  patchVersion,
  patchSeriesKey,
  mergePatchSeries,
  isStaleReply,
  isRegressionSignal,
  bucketBySubsystem,
  pickCandidates,
  highlightOf,
  subsystemPatterns,
};
