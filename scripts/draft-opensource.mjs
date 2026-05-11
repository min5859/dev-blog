import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { enrichCandidatesWithReadme } from './lib/github-readme.mjs';

const root = process.cwd();
const topic = 'opensource';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-trending`;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) return Infinity;
  return (Date.now() - ts) / (24 * 3600 * 1000);
}

function ageDescriptor(record) {
  const age = daysSince(record.metadata?.createdAt);
  if (age < 7) return '신규 (1주 이내)';
  if (age < 30) return '최근 (1개월 이내)';
  if (age < 180) return '6개월 이내';
  if (age < 365) return '1년 이내';
  return '오래된 프로젝트';
}

function scoreRecord(record) {
  let score = 0;
  const reasons = [];
  const stars = record.metadata?.stars || 0;
  const forks = record.metadata?.forks || 0;

  // HN frontpage signal is the strongest "trending right now" cue.
  if (record.metadata?.hn) {
    score += 80;
    reasons.push('HN frontpage');
    score += Math.min(40, Math.floor((record.metadata.hn.points || 0) / 5));
    if (record.metadata.hn.numComments > 100) {
      score += 15;
      reasons.push('HN 100+ 댓글');
    }
  }

  if (stars >= 100000) { score += 20; reasons.push('100k+ stars'); }
  else if (stars >= 10000) { score += 15; reasons.push('10k+ stars'); }
  else if (stars >= 1000) { score += 8; reasons.push('1k+ stars'); }

  // Recently created repos are inherently more "trending" than legacy giants.
  const ageDays = daysSince(record.metadata?.createdAt);
  if (ageDays < 30) { score += 25; reasons.push('30일 내 신규'); }
  else if (ageDays < 90) { score += 12; reasons.push('90일 내 신규'); }

  // Recent activity (push) keeps the project alive.
  const pushAge = daysSince(record.metadata?.pushedAt);
  if (pushAge < 3) { score += 8; reasons.push('3일 내 활동'); }
  else if (pushAge < 14) { score += 4; reasons.push('2주 내 활동'); }

  if (forks >= 1000) { score += 4; }

  return { ...record, score, scoreReasons: reasons };
}

function pickCandidates(records) {
  const scored = records.map(scoreRecord);
  scored.sort((a, b) => b.score - a.score || (b.metadata?.stars || 0) - (a.metadata?.stars || 0));
  // Keep up to 12 candidates: prioritize HN-tagged ones first, then top-scored.
  const hnTagged = scored.filter((r) => r.metadata?.hn);
  const remaining = scored.filter((r) => !r.metadata?.hn).slice(0, 10);
  const byId = new Map([...hnTagged, ...remaining].map((r) => [r.id, r]));
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function priorityFor(record) {
  if (record.metadata?.hn?.points >= 200) return '상';
  if (record.metadata?.hn) return '상';
  if (record.score >= 60) return '중';
  return '하';
}

function actionFor(record) {
  if (record.metadata?.hn) {
    return `HN 토론(${record.metadata.hn.points}pts)에서 뭐가 화제인지 먼저 보고 자기 스택과 겹치면 README를 훑으세요.`;
  }
  const ageDays = daysSince(record.metadata?.createdAt);
  if (ageDays < 30) return '신규 프로젝트라 변동이 큽니다 — 별 추세와 first issue 흐름을 1~2주 더 보고 도입을 결정하세요.';
  if (record.metadata?.pushedAt && daysSince(record.metadata.pushedAt) < 7) return '최근 push 활동이 활발합니다. release notes를 훑어 변경 내용을 점검하세요.';
  return 'README를 훑어 자기 환경에 맞는지 빠르게 평가하세요.';
}

function highlightOf(record) {
  return {
    title: record.metadata?.fullName || record.title,
    priority: priorityFor(record),
    verifyLink: record.url || '없음',
    action: actionFor(record),
  };
}

function languageBucket(records) {
  const buckets = new Map();
  for (const record of records) {
    const lang = record.metadata?.language || '기타';
    if (!buckets.has(lang)) buckets.set(lang, []);
    buckets.get(lang).push(record);
  }
  return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko'));
}

function impactRecord(record, options = {}) {
  const stars = record.metadata?.stars ? `⭐ ${record.metadata.stars.toLocaleString()}` : '';
  const lang = options.withLanguage !== false && record.metadata?.language ? ` · ${record.metadata.language}` : '';
  const desc = record.metadata?.description ? ` — ${record.metadata.description.slice(0, 200)}` : '';
  const lines = [`- ${record.metadata?.fullName || record.title} (${stars}${lang} · ${ageDescriptor(record)})${desc}`];
  if (record.metadata?.hn) {
    lines.push(`  · HN: ${record.metadata.hn.points}pts, ${record.metadata.hn.numComments}댓글 (${record.metadata.hn.hnUrl})`);
  }
  lines.push(`  · 확인: ${record.url}`);
  return lines.join('\n');
}

function buildSection(records, fallback, formatter) {
  if (!records.length) return fallback;
  return records.map(formatter).join('\n\n');
}

function buildLanguageSection(records, fallback) {
  if (!records.length) return fallback;
  const buckets = languageBucket(records);
  return buckets
    .map(([lang, items]) => `[${lang}]\n${items.slice(0, 2).map((r) => impactRecord(r, { withLanguage: false })).join('\n\n')}`)
    .join('\n\n');
}

function toPostDraft(candidates, sourceData) {
  const hnHits = candidates.filter((r) => r.metadata?.hn);
  const newRepos = candidates.filter((r) => !r.metadata?.hn && daysSince(r.metadata?.createdAt) < 60);
  const activeGiants = candidates.filter((r) => !r.metadata?.hn && (r.metadata?.stars || 0) >= 5000 && daysSince(r.metadata?.createdAt) >= 60);
  const top = candidates.slice(0, 4);

  return {
    id: postId,
    topic,
    title: `${runDate} 오픈소스 트렌드 (초안)`,
    date: runDate,
    summary: `오늘 GitHub 트렌딩 시그널: HN frontpage ${hnHits.length}건, 60일 내 신규 인기 ${newRepos.length}건, 별 5k 이상 활발 ${activeGiants.length}건.`,
    tags: ['opensource', 'github', 'trending', '초안'],
    highlights: top.length ? top.map(highlightOf) : [],
    sections: [
      {
        heading: '지금 화제 (HN frontpage)',
        body: buildSection(hnHits.slice(0, 5), 'Hacker News frontpage에 GitHub URL 신호가 없습니다.', impactRecord),
      },
      {
        heading: '최근 떠오른 신규 프로젝트',
        body: buildLanguageSection(newRepos.slice(0, 6), '60일 내 만들어진 인기 신규 프로젝트가 잡히지 않았습니다.'),
      },
      {
        heading: '활발히 갱신 중인 인기 프로젝트',
        body: buildLanguageSection(activeGiants.slice(0, 6), '별 5k 이상 활발 프로젝트가 잡히지 않았습니다.'),
      },
      {
        heading: '기타',
        body: '검색 API의 별 수 정렬은 long-tail에 치우쳐 있어 진짜 trending은 HN/신규 섹션을 우선 참고하세요.',
      },
    ],
    confidence: {
      level: '초안',
      note: 'GitHub Search API와 HN frontpage 메타데이터를 기반으로 자동 선별했습니다. README나 프로젝트 활동성은 별도로 검토해야 합니다.',
    },
    sources: candidates.slice(0, 10).map((record) => ({
      title: record.metadata?.fullName || record.title,
      url: record.url,
      note: `${record.source} · ${record.kind}${record.metadata?.stars ? ` · ⭐ ${record.metadata.stars.toLocaleString()}` : ''}`,
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-opensource.mjs',
      candidateIds: candidates.map((record) => record.id),
      bucketCounts: {
        hnHits: hnHits.length,
        newRepos: newRepos.length,
        activeGiants: activeGiants.length,
      },
    },
    candidateBodies: candidates.map((record) => ({
      id: record.id,
      title: record.metadata?.fullName || record.title,
      url: record.url,
      kind: record.kind,
      stars: record.metadata?.stars,
      language: record.metadata?.language,
      description: record.metadata?.description,
      topics: record.metadata?.topics,
      ageDays: Math.round(daysSince(record.metadata?.createdAt)),
      pushAgeDays: Math.round(daysSince(record.metadata?.pushedAt)),
      hn: record.metadata?.hn || null,
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
  await enrichCandidatesWithReadme(draft.candidateBodies, { concurrency: 3, limit: 10 });

  await mkdir(generatedDir, { recursive: true });
  const candidatePayload = { topic, generatedAt, sourceRecordCount: sourceData.recordCount, candidateCount: candidates.length, candidates };
  await writeFile(path.join(generatedDir, `candidates-${runDate}.json`), JSON.stringify(candidatePayload, null, 2));
  await writeFile(path.join(generatedDir, 'candidates-latest.json'), JSON.stringify(candidatePayload, null, 2));
  await writeFile(path.join(generatedDir, `${postId}.json`), JSON.stringify(draft, null, 2));
  await writeFile(path.join(generatedDir, 'draft-latest.json'), JSON.stringify(draft, null, 2));

  console.log(`Selected ${candidates.length} opensource candidate(s) from ${sourceData.recordCount} source record(s); wrote data/generated/${topic}/${postId}.json`);
}

const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { scoreRecord, pickCandidates, daysSince, ageDescriptor, languageBucket };
