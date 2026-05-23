import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const topic = 'android';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-android-daily-briefing`;

// Android-specific subsystems — patterns matched against commit subject + body.
const subsystemPatterns = new Map([
  ['Binder/IPC', [/\bbinder\b/i, /\bbinderfs\b/i, /\bvendor_hook(?:s)?\b/i]],
  ['메모리/dmabuf', [/\bdma[-_ ]buf\b/i, /\bdmabuf\b/i, /\bion\b/i, /\bgki\b.*\bmm\b/i, /\bmm:/i, /\bfolio\b/i]],
  ['스케줄러/EAS', [/\bsched\b/i, /\beas\b/i, /\bschedutil\b/i, /uclamp/i, /\bcpufreq\b/i, /\bcpuidle\b/i]],
  ['LMKD/메모리 압박', [/\blmkd?\b/i, /\bpsi\b/i, /\boom\b/i]],
  ['보안', [/\bselinux\b/i, /\bsecurity\b/i, /\bcve\b/i, /\bkasan\b/i, /\bkmsan\b/i, /\bsanitizer\b/i, /\bcfi\b/i, /\bcontrol[- ]flow\b/i]],
  ['전력/Thermal', [/\bthermal\b/i, /\bpm\b:/i, /pm_runtime/i, /\bsuspend\b/i, /\bhibernat/i]],
  ['파일시스템/스토리지', [/\bf2fs\b/i, /\bext4\b/i, /\berofs\b/i, /\bufs\b/i, /\bnvme\b/i, /\bblock\b/i, /\bfscrypt\b/i]],
  ['네트워크/이더넷', [/\bnet:/i, /\btcp\b/i, /\budp\b/i, /\bwifi\b/i, /\bwireless\b/i, /\bbpf\b/i]],
  ['GKI/모듈 ABI', [/\bgki\b/i, /\babi\b/i, /\bksu\b/i, /\bsymbol[- ]list\b/i, /\bbuild\.config\b/i]],
  ['HAL/드라이버', [/\bdrivers\//i, /\bhal\b/i, /\bremoteproc\b/i, /\bdrm\b/i, /\bgpu\b/i]],
]);

const broadSubsystems = new Set([
  'Binder/IPC', '메모리/dmabuf', '스케줄러/EAS', 'LMKD/메모리 압박', '보안', '전력/Thermal',
  '파일시스템/스토리지', '네트워크/이더넷', 'GKI/모듈 ABI',
]);

const regressionPattern = /(\bregression\b|\boops\b|\bpanic\b|\bcrash\b|cve|\bsecurity\b|\bvuln|lockup|deadlock)/i;
const bodyRegressionPattern = /^[\s>]*Fixes:\s*[0-9a-f]{8,}/im;

const KIND_BOOSTS = new Map([
  ['ack-android', 36],
  ['ack-fromgit', 28],
  ['ack-fromlist', 22],
  ['ack-backport', 30],
  ['ack-upstream', 18],
  ['ack-merge', 6],
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function matchSubsystems(text) {
  const matched = [];
  for (const [label, patterns] of subsystemPatterns) {
    if (patterns.some((pattern) => pattern.test(text))) matched.push(label);
  }
  return matched;
}

function broadSubsystemsOf(record) {
  return (record.matchedSubsystems || []).filter((s) => broadSubsystems.has(s));
}

function isRegressionSignal(record) {
  const haystack = `${record.title || ''}\n${record.metadata?.bodyExcerpt || ''}`;
  if (regressionPattern.test(haystack)) return true;
  if (record.metadata?.bodyExcerpt && bodyRegressionPattern.test(record.metadata.bodyExcerpt)) return true;
  return false;
}

function isBroadImpact(record) {
  if (isRegressionSignal(record)) return true;
  return broadSubsystemsOf(record).length > 0;
}

function scoreRecord(record) {
  let score = 0;
  const reasons = [];
  const text = `${record.title}\n${record.metadata?.bodyExcerpt || ''}`;

  const kindBoost = KIND_BOOSTS.get(record.kind) || 0;
  if (kindBoost) {
    score += kindBoost;
    reasons.push(`${record.kind} 가중`);
  }

  if (isRegressionSignal(record)) {
    score += 18;
    reasons.push('회귀/보안 키워드');
  }

  const matchedSubsystems = matchSubsystems(text);
  if (matchedSubsystems.length) {
    score += Math.min(20, matchedSubsystems.length * 7);
    reasons.push(`관련 영역: ${matchedSubsystems.join(', ')}`);
  }

  if (record.metadata?.branch === 'android-mainline') {
    score += 6;
    reasons.push('android-mainline 브랜치');
  }

  return { ...record, score, scoreReasons: reasons, matchedSubsystems };
}

const ANY_PREFIX = /^(ANDROID|FROMGIT|FROMLIST|BACKPORT|UPSTREAM):\s*/;

function stripPrefix(title) {
  return title.replace(ANY_PREFIX, '').trim();
}

function pickCandidates(records) {
  const scored = records.map(scoreRecord);
  const broad = scored.filter(isBroadImpact);
  broad.sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));

  const regressions = broad.filter(isRegressionSignal).slice(0, 3);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const ackPatches = broad
    .filter((record) => record.kind?.startsWith('ack-') && record.kind !== 'ack-merge' && !regressionIds.has(record.id))
    .slice(0, 6);
  const merges = broad
    .filter((record) => record.kind === 'ack-merge' && !regressionIds.has(record.id))
    .slice(0, 2);

  const byId = new Map([...regressions, ...ackPatches, ...merges].map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));
}

function bucketBySubsystem(records) {
  const buckets = new Map();
  for (const record of records) {
    const labels = broadSubsystemsOf(record);
    if (!labels.length) continue;
    for (const label of labels) {
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(record);
    }
  }
  return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko'));
}

function priorityFor(record) {
  if (isRegressionSignal(record)) return '상';
  if (record.kind === 'ack-android' && record.score >= 60) return '상';
  if (record.score >= 50) return '중';
  return '하';
}

function actionFor(record) {
  if (isRegressionSignal(record)) return '원문 commit 본문을 우선 확인해 자기 디바이스 베이스 ACK 라인에 영향 가는지 점검하세요.';
  if (record.kind === 'ack-android') return 'Android-specific 패치라 GKI/ABI 영향이 있는지 자기 vendor module 빌드에서 확인하세요.';
  if (record.kind === 'ack-backport') return 'Linux upstream의 백포트라 Android 라인에 들어온 시점·범위를 changelog에서 확인하세요.';
  if (record.kind === 'ack-fromlist') return 'LKML 리뷰 중인 패치를 ACK가 미리 가져온 항목입니다. mainline 머지 가능성과 함께 추적하세요.';
  return '자기 서브시스템 경로가 영향받는지 commit 본문에서 확인하세요.';
}

function impactTypeFor(record) {
  const text = `${record.title || ''}\n${record.summary || ''}\n${record.metadata?.bodyExcerpt || ''}`.toLowerCase();
  if (/\bcve\b|security|vuln|overflow|oob|use-after-free|\buaf\b/.test(text)) return 'security';
  if (isRegressionSignal(record)) return 'regression';
  if (record.kind === 'ack-backport') return 'backport';
  if (/\babi\b|\bapi\b|gki|interface|callback|symbol|uapi/.test(text)) return 'api-abi';
  if (/build|kbuild|clang|gcc|rust|compiler/.test(text)) return 'build';
  if (/performance|latency|throughput|slow|fast|optimi[sz]/.test(text)) return 'performance';
  return 'runtime';
}

function highlightOf(record) {
  return {
    title: stripPrefix(record.title),
    priority: priorityFor(record),
    impactType: impactTypeFor(record),
    verifyLink: record.url || '없음',
    action: actionFor(record),
  };
}

function impactRecord(record, options = {}) {
  const subsystems = broadSubsystemsOf(record).join(', ');
  const lines = [`- ${stripPrefix(record.title)}`];
  if (record.metadata?.shaShort) lines[0] += ` (${record.metadata.shaShort}${record.metadata.branch ? ` · ${record.metadata.branch}` : ''})`;
  if (options.withSubsystem !== false && subsystems) {
    lines.push(`  · 영향: ${subsystems}`);
  }
  lines.push(`  · 확인: ${record.url}`);
  return lines.join('\n');
}

function buildSection(records, fallback, formatter) {
  if (!records.length) return fallback;
  return records.map(formatter).join('\n\n');
}

function buildPatchSection(records, fallback) {
  if (!records.length) return fallback;
  const buckets = bucketBySubsystem(records);
  return buckets
    .map(([label, items]) => `[${label}]\n${items.slice(0, 2).map((r) => impactRecord(r, { withSubsystem: false })).join('\n\n')}`)
    .join('\n\n');
}

function toPostDraft(candidates, sourceData) {
  const regressions = candidates.filter(isRegressionSignal);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const ackPatches = candidates.filter((record) => record.kind?.startsWith('ack-') && record.kind !== 'ack-merge' && !regressionIds.has(record.id));
  const top = candidates.slice(0, 4);

  const branches = [...new Set(candidates.map((record) => record.metadata?.branch).filter(Boolean))];

  return {
    id: postId,
    topic,
    title: `${runDate} Android 커널 개발 브리핑`,
    date: runDate,
    summary: `오늘의 Android 커널 변경: 회귀·보안 ${regressions.length}건, ACK 전용 패치 ${ackPatches.length}건. 추적 브랜치: ${branches.join(', ') || '없음'}.`,
    tags: ['android', '커널', 'ack'],
    highlights: top.length ? top.map(highlightOf) : [],
    sections: [
      {
        heading: '회귀·보안 신호',
        body: buildSection(regressions, '회귀·보안 신호로 분류된 항목이 없습니다.', (r) => impactRecord(r)),
      },
      {
        heading: 'ACK 전용 변경',
        body: buildPatchSection(ackPatches, '이번 수집에서 ACK 전용 시스템 영향 패치가 분류되지 않았습니다.'),
      },
      {
        heading: '추적 브랜치',
        body: branches.length
          ? branches.map((branch) => `- ${branch}: 가장 최근 commit ${candidates.find((c) => c.metadata?.branch === branch)?.metadata?.shaShort || '미상'}`).join('\n')
          : '추적 브랜치 정보를 확인하지 못했습니다.',
      },
      {
        heading: '기타',
        body: '국부 vendor/hardware 패치는 본문에서 제외했습니다. 자기 디바이스 키워드로 ACK git log에서 직접 검색하세요.',
      },
    ],
    confidence: {
      level: '자동 생성',
      note: 'AI가 원문 후보와 메타데이터를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.',
    },
    sources: candidates.slice(0, 8).map((record) => ({
      title: stripPrefix(record.title),
      url: record.url,
      note: `${record.source} · ${record.kind || 'commit'}${record.metadata?.shaShort ? ` · ${record.metadata.shaShort}` : ''}`,
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-android.mjs',
      candidateIds: candidates.map((record) => record.id),
      bucketCounts: {
        regressions: regressions.length,
        ackPatches: ackPatches.length,
      },
      subsystems: [...new Set(candidates.flatMap(broadSubsystemsOf))],
      branches,
    },
    candidateBodies: candidates.map((record) => ({
      id: record.id,
      title: stripPrefix(record.title),
      url: record.url,
      kind: record.kind,
      branch: record.metadata?.branch,
      sha: record.metadata?.shaShort,
      commitMessage: record.metadata?.bodyExcerpt || '',
    })),
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

  console.log(`Selected ${candidates.length} Android candidate(s) from ${sourceData.recordCount} source record(s); wrote ${path.relative(root, draftOutput)}`);
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
  matchSubsystems,
  isRegressionSignal,
  isBroadImpact,
  pickCandidates,
  bucketBySubsystem,
  stripPrefix,
  highlightOf,
  impactTypeFor,
  subsystemPatterns,
  broadSubsystems,
};
