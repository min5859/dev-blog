import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const topic = 'opensource-curation';
const PICK_HEADING = '이번 주 선정 (큐레이션)';
const inputPath = path.join(root, 'data', 'normalized', topic, 'source-records-latest.json');
const generatedDir = path.join(root, 'data', 'generated', topic);
const generatedAt = new Date().toISOString();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const postId = `${runDate}-opensource-curation`;
const configPath = path.join(root, 'content', 'topics', 'opensource-curation', 'opensource-curation.config.json');

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
  return '장기 프로젝트';
}

function scoreRecord(record) {
  let score = 0;
  const reasons = [];
  const sr = record.metadata?.curationScore;
  if (typeof sr === 'number' && Number.isFinite(sr)) {
    score += sr * 80;
    reasons.push(`큐레이션 점수 ${sr.toFixed(3)}`);
  }
  const stars = record.metadata?.stars || 0;
  score += Math.min(35, Math.log10(stars + 1) * 12);
  if (stars >= 10000) reasons.push('10k+ stars');

  if (record.metadata?.hasAnalysis) {
    score += 20;
    reasons.push('심층 분석 있음');
  }

  const pushAge = daysSince(record.metadata?.pushedAt);
  if (pushAge < 7) {
    score += 10;
    reasons.push('7일 내 push');
  } else if (pushAge < 30) {
    score += 4;
    reasons.push('30일 내 push');
  }

  const ageDays = daysSince(record.metadata?.createdAt);
  if (ageDays < 90) {
    score += 12;
    reasons.push('90일 내 신규');
  }

  return { ...record, score, scoreReasons: reasons };
}

function pickCandidates(records) {
  const scored = records.map(scoreRecord);
  scored.sort((a, b) => b.score - a.score || (b.metadata?.stars || 0) - (a.metadata?.stars || 0));
  return scored.slice(0, 14);
}

function priorityFor(record) {
  if (record.metadata?.hasAnalysis && (record.metadata?.curationScore ?? 0) >= 0.65) return '상';
  if ((record.metadata?.curationScore ?? 0) >= 0.55 || (record.metadata?.stars || 0) >= 20000) return '상';
  if (record.score >= 40) return '중';
  return '하';
}

function actionFor(record) {
  if (record.metadata?.hasAnalysis) {
    return '저장된 심층 분석 초안을 훑고 공식 README·릴리스 노트와 교차 확인하세요.';
  }
  return 'README와 최근 이슈·릴리스를 훑어 도입 여부를 판단하세요.';
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

function impactRecord(record) {
  const stars = record.metadata?.stars ? `⭐ ${record.metadata.stars.toLocaleString()}` : '';
  const lang = record.metadata?.language ? ` · ${record.metadata.language}` : '';
  const sr = typeof record.metadata?.curationScore === 'number' ? ` · 점수 ${record.metadata.curationScore.toFixed(3)}` : '';
  const desc = record.metadata?.description ? ` — ${record.metadata.description.slice(0, 200)}` : '';
  const lines = [`- ${record.metadata?.fullName || record.title} (${stars}${lang}${sr} · ${ageDescriptor(record)})${desc}`];
  if (record.scoreReasons?.length) lines.push(`  · 신호: ${record.scoreReasons.join(', ')}`);
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
    .map(([lang, items]) => `[${lang}]\n${items.slice(0, 2).map((r) => impactRecord(r)).join('\n\n')}`)
    .join('\n\n');
}

function analysisHighlightBody(candidates) {
  const withA = candidates.filter((r) => r.metadata?.hasAnalysis && r.metadata?.analysisExcerpt);
  if (!withA.length) {
    return '이번 수집에서 `data/opensource-curation/analysis/` 분석 파일이 없습니다. `npm run opensource-curation:analyze` 를 실행해 주세요.';
  }
  return withA
    .slice(0, 8)
    .map((r) => {
      const ex = r.metadata.analysisExcerpt.trim();
      const short = ex.length > 500 ? `${ex.slice(0, 500)}…` : ex;
      return `### ${r.metadata.fullName}\n${short}`;
    })
    .join('\n\n');
}

function toPostDraft(candidates, sourceData, config) {
  const ranked = [...candidates].sort(
    (a, b) => (b.metadata?.curationScore ?? 0) - (a.metadata?.curationScore ?? 0) || b.score - a.score,
  );
  const fresh = candidates.filter((r) => daysSince(r.metadata?.createdAt) < 120);
  const top = ranked.slice(0, 4);
  const kwShort = Array.isArray(config.categories) && config.categories.length ? config.categories.join(', ') : '전체';
  const pickBody = buildSection(
    ranked.slice(0, 10),
    '선정 레포가 없습니다. `npm run opensource-curation:discover` 및 `opensource-curation:fetch` 로 `data/opensource-curation/repos.json` 을 채웠는지 확인하세요.',
    impactRecord,
  );

  return {
    id: postId,
    topic,
    title: `${runDate} 오픈소스 큐레이션 (초안)`,
    date: runDate,
    summary: `검색 토픽: ${kwShort}.`,
    tags: ['opensource-curation', 'github', 'opensource', '초안'],
    highlights: top.length ? top.map(highlightOf) : [],
    sections: [
      {
        heading: PICK_HEADING,
        body: pickBody,
      },
      {
        heading: '언어·규모 스냅샷',
        body: buildLanguageSection(candidates, '후보 레코드가 없습니다.'),
      },
      {
        heading: '심층 분석 하이라이트',
        body: analysisHighlightBody(candidates),
      },
      {
        heading: '기타',
        body: '데이터는 `data/opensource-curation/` 에 있습니다. 상류 갱신: `opensource-curation:discover` → `opensource-curation:fetch` → `opensource-curation:analyze` → `collect:opensource-curation`. 이미 데이터가 있으면 `OPENSOURCE_CURATION_SKIP_UPSTREAM=1 npm run daily:opensource-curation` 로 블로그 단계만 돌릴 수 있습니다.',
      },
    ],
    confidence: {
      level: '초안',
      note: 'repos.json·분석 마크다운을 기반으로 자동 구성했습니다. 오픈소스 트렌드 토픽과 달리 *선정·심층 요약*에 초점을 둡니다.',
    },
    sources: candidates.slice(0, 12).map((record) => ({
      title: record.metadata?.fullName || record.title,
      url: record.url,
      note: [
        record.metadata?.curationScore != null ? `점수 ${record.metadata.curationScore.toFixed(3)}` : '점수 —',
        record.metadata?.hasAnalysis ? '분석 있음' : '분석 없음',
        record.metadata?.stars ? `⭐ ${record.metadata.stars.toLocaleString()}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
    draftMetadata: {
      generatedAt,
      sourceRecordCount: sourceData.recordCount,
      candidateCount: candidates.length,
      generator: 'scripts/draft-opensource-curation.mjs',
      curationRoot: sourceData.curationRoot,
      searchProfile: {
        categories: config.categories || [],
        lookbackDays: config.repos?.lookback_days ?? 7,
        minStars: config.repos?.min_stars ?? 100,
        githubSearchEnabled: config.sources?.github_search?.enabled !== false,
        githubTrendingEnabled: config.sources?.github_trending?.enabled !== false,
      },
      bucketCounts: {
        withAnalysis: candidates.filter((r) => r.metadata?.hasAnalysis).length,
        freshUnder120d: fresh.length,
      },
      candidateIds: candidates.map((record) => record.id),
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
      curationScore: record.metadata?.curationScore,
      hasAnalysis: record.metadata?.hasAnalysis,
      analysisExcerpt: record.metadata?.analysisExcerpt || '',
    })),
  };
}

async function main() {
  const sourceData = await readJson(inputPath);
  const config = await readJson(configPath);
  if (!Array.isArray(sourceData.records)) {
    throw new Error(`${path.relative(root, inputPath)} does not contain records[]`);
  }
  const candidates = pickCandidates(sourceData.records);
  const draft = toPostDraft(candidates, sourceData, config);

  await mkdir(generatedDir, { recursive: true });
  const candidatePayload = { topic, generatedAt, sourceRecordCount: sourceData.recordCount, candidateCount: candidates.length, candidates };
  await writeFile(path.join(generatedDir, `candidates-${runDate}.json`), JSON.stringify(candidatePayload, null, 2));
  await writeFile(path.join(generatedDir, 'candidates-latest.json'), JSON.stringify(candidatePayload, null, 2));
  await writeFile(path.join(generatedDir, `${postId}.json`), JSON.stringify(draft, null, 2));
  await writeFile(path.join(generatedDir, 'draft-latest.json'), JSON.stringify(draft, null, 2));

  console.log(`Selected ${candidates.length} candidate(s) from ${sourceData.recordCount} source record(s); wrote data/generated/${topic}/${postId}.json`);
}

const isMainModule = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
