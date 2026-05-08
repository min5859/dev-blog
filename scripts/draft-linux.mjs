import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const topic = 'linux';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-linux-daily-briefing`;
const STALE_REPLY_MS = 24 * 60 * 60 * 1000;

const subsystemPatterns = new Map([
  ['가상화', [/\bkvm\b/, /\bxen\b/, /\bvirt\b/, /hypervisor/]],
  ['네트워크', [/\bnet:/, /\bnetdev\b/, /\bdsa\b/, /\btcp\b/, /\budp\b/, /ethernet/, /wifi/, /wireless/]],
  ['스토리지/파일시스템', [/\bfs:/, /\bblock\b/, /\bbtrfs\b/, /\bxfs\b/, /\bext4\b/, /\bnvme\b/, /\bscsi\b/, /\bubi\b/]],
  ['메모리 관리', [/\bmm:/, /memory/, /\bpage\b/, /\bfolio\b/, /\bslab\b/, /vmalloc/]],
  ['스케줄러/실시간', [/\bsched\b/, /preempt_rt/, /\bPREEMPT_RT\b/i]],
  ['보안', [/security/, /\bcve\b/, /selinux/, /apparmor/, /crypto/, /\biommu\b/]],
  ['전력 관리', [/\bpm:/, /\bpm_runtime\b/, /\bcpufreq\b/, /\bcpuidle\b/, /\bthermal\b/, /\bacpi\b/, /\bsuspend\b/]],
  ['드라이버', [/\bdriver\b/, /drivers\//, /\bgpu\b/, /\bdrm\b/, /\busb\b/, /\bpci\b/]],
  ['아키텍처', [/\barm64\b/, /\bx86\b/, /\briscv\b/, /\bpowerpc\b/, /\bloongarch\b/]],
]);

const broadSubsystems = new Set([
  '가상화', '네트워크', '스토리지/파일시스템', '메모리 관리', '스케줄러/실시간', '보안', '전력 관리',
]);

const regressionPattern = /(\bregression\b|\boops\b|\bpanic\b|\bcrash\b|cve|\bsecurity\b|\bvuln|lockup|deadlock)/i;
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

function extractCommitMessage(rawMbox) {
  if (!rawMbox) return '';
  const headersEnd = rawMbox.indexOf('\n\n');
  let body = headersEnd >= 0 ? rawMbox.slice(headersEnd + 2) : rawMbox;
  const dashSep = body.search(/(^|\n)---\s*\n/);
  if (dashSep >= 0) body = body.slice(0, dashSep);
  const diffStart = body.search(/(^|\n)diff --git /);
  if (diffStart >= 0) body = body.slice(0, diffStart);
  body = body.replace(/(^|\n)Signed-off-by:[^\n]*/gi, '');
  body = body.replace(/(^|\n)(Reviewed-by|Acked-by|Tested-by|Cc):[^\n]*/gi, '');
  return body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2400);
}

async function fetchLoreBody(record) {
  if (record.sourceId !== 'lore-lkml-new' || !record.url) return null;
  const url = record.url.endsWith('/') ? `${record.url}raw` : `${record.url}/raw`;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dev-blog-collector/0.1 (+lore body fetcher)', accept: 'text/plain' },
    });
    if (!response.ok) return null;
    return extractCommitMessage(await response.text());
  } catch {
    return null;
  }
}

function summarizeChangelog(rawText, maxItems = 30) {
  if (!rawText || !/^commit [a-f0-9]+\s*$/m.test(rawText)) return '';
  const commits = rawText.split(/^commit [a-f0-9]+\s*$/m);
  const subjects = [];
  for (const chunk of commits) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    while (i < lines.length && /^\s*[A-Z][a-zA-Z]+:/.test(lines[i])) i++;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length) subjects.push(lines[i].trim());
  }
  if (subjects[0] && /^Linux \d/.test(subjects[0])) subjects.shift();
  if (!subjects.length) return '';
  const limited = subjects.slice(0, maxItems);
  const more = subjects.length > maxItems ? `\n(전체 ${subjects.length}건 중 상위 ${maxItems}건)` : '';
  return `백포트된 커밋 제목 (총 ${subjects.length}건):\n${limited.map((s) => `- ${s}`).join('\n')}${more}`.slice(0, 2400);
}

async function fetchChangelog(record) {
  if (record.sourceId !== 'kernel-org-releases') return null;
  const url = record.links?.find((link) => link.kind === 'changelog')?.url;
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dev-blog-collector/0.1 (+changelog summarizer)', accept: 'text/plain' },
    });
    if (!response.ok) return null;
    return summarizeChangelog(await response.text());
  } catch {
    return null;
  }
}

function historyKeyFor(record) {
  const series = extractSeriesId(record);
  if (series) return series.key;
  return patchSeriesKey(record);
}

async function loadRecentSeriesHistory(generatedDir, runDate, daysBack = 3) {
  const history = new Map();
  const today = new Date(`${runDate}T00:00:00Z`);
  for (let offset = 1; offset <= daysBack; offset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateStr = date.toISOString().slice(0, 10);
    const file = path.join(generatedDir, `candidates-${dateStr}.json`);
    try {
      const text = await readFile(file, 'utf8');
      const data = JSON.parse(text);
      for (const candidate of data.candidates || []) {
        const key = historyKeyFor(candidate);
        if (!key) continue;
        const version = patchVersion(candidate);
        const existing = history.get(key);
        if (!existing || version > existing.version
          || (version === existing.version && dateStr > existing.lastSeen)) {
          history.set(key, { version, lastSeen: dateStr });
        }
      }
    } catch {
      // missing or unreadable file → skip silently
    }
  }
  return history;
}

function annotateWithHistory(records, history) {
  return records.map((record) => {
    const key = historyKeyFor(record);
    if (!key) return record;
    const previous = history.get(key);
    if (!previous) return record;
    const currentVersion = patchVersion(record);
    return {
      ...record,
      previouslySeenAt: previous.lastSeen,
      ...(currentVersion > previous.version ? { previousVersion: previous.version } : {}),
    };
  });
}

async function enrichWithBodies(candidates, { delayMs = 200 } = {}) {
  const enriched = [];
  for (const record of candidates) {
    let body = null;
    if (record.sourceId === 'lore-lkml-new') {
      body = await fetchLoreBody(record);
    } else if (record.sourceId === 'kernel-org-releases') {
      body = await fetchChangelog(record);
    }
    const history = record.previouslySeenAt
      ? { previouslySeenAt: record.previouslySeenAt, ...(record.previousVersion ? { previousVersion: record.previousVersion } : {}) }
      : null;
    enriched.push({
      id: record.id,
      title: stripPatchPrefix(record.title),
      url: record.url,
      sourceId: record.sourceId,
      kind: record.kind,
      commitMessage: body || '',
      ...(history ? { history } : {}),
    });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return enriched;
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

function extractSeriesId(record) {
  if (record.sourceId !== 'lore-lkml-new') return null;
  const partMatch = record.title.match(/\[PATCH\b[^\]]*?\b(\d+)\/(\d+)\]/i);
  if (!partMatch) return null;
  const numerator = Number(partMatch[1]);
  const denominator = Number(partMatch[2]);
  const versionMatch = record.title.match(/\bv(\d+)\b/i);
  const version = versionMatch ? Number(versionMatch[1]) : 1;
  const author = record.metadata?.author?.email || record.metadata?.author?.name || '';
  return { key: `${author}::v${version}::${denominator}`, numerator, denominator, version };
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
  const afterTitleMerge = [...passthrough, ...grouped.values()];

  const seriesGroups = new Map();
  const standalone = [];
  for (const record of afterTitleMerge) {
    const id = extractSeriesId(record);
    if (!id) {
      standalone.push(record);
      continue;
    }
    const existing = seriesGroups.get(id.key);
    if (!existing) {
      seriesGroups.set(id.key, { record, numerator: id.numerator, count: 1, denominator: id.denominator });
    } else {
      existing.count++;
      if (id.numerator < existing.numerator) {
        existing.record = record;
        existing.numerator = id.numerator;
      }
    }
  }
  const seriesEntries = [...seriesGroups.values()].map(({ record, count, denominator }) => ({
    ...record,
    seriesSize: count,
    seriesDenominator: denominator,
  }));
  return [...standalone, ...seriesEntries];
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

function broadSubsystemsOf(record) {
  return (record.matchedSubsystems || []).filter((s) => broadSubsystems.has(s));
}

function isBroadImpact(record) {
  if (record.sourceId === 'kernel-org-releases') return true;
  if (isRegressionSignal(record)) return true;
  return broadSubsystemsOf(record).length > 0;
}

function pickCandidates(records) {
  const nowMs = Date.now();
  const scored = records.map(scoreRecord);
  const merged = mergePatchSeries(scored);
  const fresh = merged.filter((record) => !isStaleReply(record, nowMs));
  const broad = fresh.filter(isBroadImpact);
  broad.sort((a, b) => b.score - a.score || String(b.observedDate).localeCompare(String(a.observedDate)));

  const official = broad.filter((record) => record.sourceId === 'kernel-org-releases').slice(0, 4);
  const regressions = broad.filter(isRegressionSignal).slice(0, 3);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = broad
    .filter((record) => record.sourceId === 'lore-lkml-new' && record.kind === 'patch-discussion' && !regressionIds.has(record.id))
    .slice(0, 4);
  const signals = broad
    .filter((record) => record.sourceId === 'lore-lkml-new' && record.score >= 28)
    .filter((record) => !regressionIds.has(record.id) && !patches.some((patch) => patch.id === record.id))
    .slice(0, 2);

  const byId = new Map([...official, ...regressions, ...patches, ...signals].map((record) => [record.id, record]));
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
    `  · 영향: ${impact} (공개일 ${date}${eol})`,
    `  · 확인: ${verifyLinkFor(record)}`,
  ].join('\n');
}

function impactLkml(record, options = {}) {
  const subsystems = broadSubsystemsOf(record).join(', ');
  const annotations = [];
  if (record.seriesDenominator) annotations.push(`${record.seriesDenominator}-패치 시리즈`);
  if (record.previousVersion) {
    annotations.push(`v${record.previousVersion}→v${patchVersion(record)} 갱신`);
  } else if (record.previouslySeenAt) {
    annotations.push(`${record.previouslySeenAt}부터 추적`);
  }
  const note = annotations.length ? ` (${annotations.join(' · ')})` : '';
  const lines = [`- ${stripPatchPrefix(record.title)}${note}`];
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
    .map(([label, items]) => `[${label}]\n${items.slice(0, 2).map((r) => impactLkml(r, { withSubsystem: false })).join('\n\n')}`)
    .join('\n\n');
}

function toPostDraft(candidates, sourceData, candidateBodies = []) {
  const releases = candidates.filter((record) => record.sourceId === 'kernel-org-releases');
  const regressions = candidates.filter(isRegressionSignal);
  const regressionIds = new Set(regressions.map((record) => record.id));
  const patches = candidates.filter((record) => record.sourceId === 'lore-lkml-new'
    && record.kind === 'patch-discussion'
    && !regressionIds.has(record.id));
  const otherSignals = candidates.filter((record) => record.sourceId === 'lore-lkml-new'
    && record.kind !== 'patch-discussion'
    && !regressionIds.has(record.id));
  const top = candidates.slice(0, 4);

  return {
    id: postId,
    topic,
    title: `${runDate} 커널 개발 브리핑 (초안)`,
    date: runDate,
    summary: `오늘의 핵심: 릴리스 ${releases.length}건, 회귀·보안 ${regressions.length}건, 시스템 영향 패치 ${patches.length}건. 국부 드라이버/플랫폼 패치는 본문에서 제외했습니다.`,
    tags: ['리눅스', '커널', '초안'],
    highlights: top.map(highlightOf),
    sections: [
      {
        heading: '릴리스/로드맵',
        body: buildSection(releases, '이번 수집에서 신규 릴리스가 없습니다.', impactRelease),
      },
      {
        heading: '회귀·보안 신호',
        body: buildSection(regressions, '회귀·보안 신호로 분류된 항목이 없습니다.', (r) => impactLkml(r)),
      },
      {
        heading: '핵심 변경',
        body: buildPatchSection(patches, '이번 수집에서 시스템 전반에 영향을 줄 변경이 분류되지 않았습니다.'),
      },
      {
        heading: '기타',
        body: otherSignals.length
          ? buildSection(otherSignals.slice(0, 2), '추가 신호가 없습니다.', (r) => impactLkml(r))
          : '국부 드라이버/플랫폼 패치는 본문에서 제외했습니다. 자기 영역 키워드로 lore.kernel.org에서 직접 검색하세요.',
      },
    ],
    confidence: {
      level: '초안',
      note: '제목·메타데이터 기반 자동 선별입니다. 본문 의미를 검증한 상태가 아니므로 게시 전 원문 확인이 필요합니다.',
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
      generator: 'scripts/draft-linux.mjs',
      candidateIds: candidates.map((record) => record.id),
      bucketCounts: {
        releases: releases.length,
        regressions: regressions.length,
        patches: patches.length,
        otherSignals: otherSignals.length,
      },
      subsystems: [...new Set(candidates.flatMap(broadSubsystemsOf))],
    },
    candidateBodies,
  };
}

async function main() {
  const sourceData = await readJson(inputPath);
  if (!Array.isArray(sourceData.records)) {
    throw new Error(`${path.relative(root, inputPath)} does not contain records[]`);
  }

  const rawCandidates = pickCandidates(sourceData.records);
  const seriesHistory = await loadRecentSeriesHistory(generatedDir, runDate);
  const candidates = annotateWithHistory(rawCandidates, seriesHistory);
  const candidateBodies = await enrichWithBodies(candidates);
  const bodyHits = candidateBodies.filter((entry) => entry.commitMessage).length;
  const trackedHits = candidateBodies.filter((entry) => entry.history).length;
  const draft = toPostDraft(candidates, sourceData, candidateBodies);

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

  console.log(`Selected ${candidates.length} newsletter candidate(s) from ${sourceData.recordCount} source record(s); fetched ${bodyHits} commit message(s); ${trackedHits} carried over from prior runs; wrote ${path.relative(root, draftOutput)}`);
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
  isBroadImpact,
  bucketBySubsystem,
  extractCommitMessage,
  summarizeChangelog,
  extractSeriesId,
  annotateWithHistory,
  historyKeyFor,
  pickCandidates,
  highlightOf,
  subsystemPatterns,
};
