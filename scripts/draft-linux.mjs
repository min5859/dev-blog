import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const runDate = process.env.NEWSLETTER_DATE || generatedAt.slice(0, 10);
const postId = `${runDate}-linux-daily-briefing`;

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
    if (/(regression|oops|panic|fix|bug|crash|security|cve)/i.test(record.title)) {
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

function pickCandidates(records) {
  const scored = records.map(scoreRecord).sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));
  const official = scored.filter((record) => record.sourceId === 'kernel-org-releases').slice(0, 5);
  const patches = scored.filter((record) => record.sourceId === 'lore-lkml-new' && record.kind === 'patch-discussion').slice(0, 8);
  const signals = scored.filter((record) => record.sourceId === 'lore-lkml-new' && record.score >= 28 && !patches.some((patch) => patch.id === record.id)).slice(0, 5);
  const byId = new Map([...official, ...patches, ...signals].map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));
}

function summarizeCandidate(record) {
  if (record.sourceId === 'kernel-org-releases') {
    const moniker = record.metadata?.moniker || 'release';
    return `${record.title}: ${record.summary} 후속 분석에서는 changelog/diffview를 확인해 실제 영향 범위를 분리해야 합니다.`;
  }
  const author = record.metadata?.author?.name || record.metadata?.author?.email || '작성자 미상';
  const subsystem = record.matchedSubsystems.length ? ` 관련 영역은 ${record.matchedSubsystems.join(', ')}입니다.` : '';
  return `${record.title}: ${author}의 LKML 항목입니다.${subsystem} 점수 사유는 ${record.scoreReasons.join(', ')}입니다.`;
}

function sectionBody(records, fallback) {
  if (!records.length) return fallback;
  return records.slice(0, 5).map((record) => `- ${summarizeCandidate(record)}`).join('\n');
}

function toPostDraft(candidates, sourceData) {
  const releases = candidates.filter((record) => record.sourceId === 'kernel-org-releases');
  const patches = candidates.filter((record) => record.sourceId === 'lore-lkml-new' && record.kind === 'patch-discussion');
  const signals = candidates.filter((record) => record.sourceId === 'lore-lkml-new' && record.kind !== 'patch-discussion');
  const top = candidates.slice(0, 5);
  const latestStable = sourceData.records.find((record) => record.sourceId === 'kernel-org-releases' && record.metadata?.moniker === 'stable');
  const mainline = sourceData.records.find((record) => record.sourceId === 'kernel-org-releases' && record.metadata?.moniker === 'mainline');

  return {
    id: postId,
    topic,
    title: `${runDate} 커널 개발 브리핑 (초안)`,
    date: runDate,
    summary: `kernel.org 릴리스 정보와 LKML 최신 토론 ${sourceData.recordCount}건을 수집해 뉴스레터 후보 ${candidates.length}건을 선별한 자동 생성 초안입니다.`,
    tags: ['리눅스', '커널', 'LKML', '릴리스', '초안'],
    highlights: top.map((record) => `${record.title} — 점수 ${record.score}`),
    sections: [
      {
        heading: '릴리스/로드맵 신호',
        body: sectionBody(releases, '이번 수집분에서 우선순위가 높은 공식 릴리스 신호가 없습니다.'),
      },
      {
        heading: '패치 동향',
        body: sectionBody(patches, '이번 수집분에서 우선순위가 높은 패치 토론이 없습니다.'),
      },
      {
        heading: '추가로 볼 LKML 신호',
        body: sectionBody(signals, '이번 수집분에서 추가로 볼 LKML 신호가 없습니다.'),
      },
    ],
    implications: [
      mainline ? `mainline 상태: ${mainline.title}. 다음 릴리스 후보 흐름과 merge-window 신호를 계속 추적해야 합니다.` : 'mainline 릴리스 정보를 확인하지 못했습니다.',
      latestStable ? `latest stable 후보: ${latestStable.title}. stable changelog 기반 영향도 분류가 다음 보강 지점입니다.` : 'stable 릴리스 정보를 확인하지 못했습니다.',
      'LKML 항목은 아직 제목/메타데이터 기반 선별이므로, 본문 기반 AI 요약 단계에서 실제 영향도와 중복 토론을 재평가해야 합니다.',
    ],
    nextActions: [
      'AI 요약 어댑터를 연결해 후보별 원문 의미를 문단 단위로 재작성합니다.',
      'LKML 중복 스레드 병합과 서브시스템별 중요도 가중치를 개선합니다.',
      '생성 초안을 사람이 검토한 뒤 게시용 글로 승격하는 흐름을 추가합니다.',
    ],
    confidence: {
      level: '초안',
      note: '현재 초안은 메타데이터/제목 기반 자동 선별 결과입니다. 게시 전 원문 검토 또는 AI 본문 요약이 필요합니다.',
    },
    sources: candidates.slice(0, 12).map((record) => ({
      title: record.title,
      url: record.url,
      note: `${record.source} · score ${record.score}`,
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-linux.mjs',
      candidateIds: candidates.map((record) => record.id),
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

  await writeFile(candidateOutput, JSON.stringify({ topic, generatedAt, sourceRecordCount: sourceData.recordCount, candidateCount: candidates.length, candidates }, null, 2));
  await writeFile(candidateLatest, JSON.stringify({ topic, generatedAt, sourceRecordCount: sourceData.recordCount, candidateCount: candidates.length, candidates }, null, 2));
  await writeFile(draftOutput, JSON.stringify(draft, null, 2));
  await writeFile(draftLatest, JSON.stringify(draft, null, 2));

  console.log(`Selected ${candidates.length} newsletter candidate(s) from ${sourceData.recordCount} source record(s); wrote ${path.relative(root, draftOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
