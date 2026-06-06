import { readFile } from 'node:fs/promises';
import path from 'node:path';

// E: 최근 N일 research dossier 를 모아 핵심만 추린 주간 dossier 를 만든다.
// 같은 candidateId 는 최신 일자 항목으로 dedup → confidence·severity 로 상위 선별.
// 근거(evidence)를 유지하므로 dossierToPost 가 그대로 주간 post(인용 포함)를 만든다.

const SEVERITY_RANK = { security: 0, regression: 0, release: 1, backport: 2, 'api-abi': 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

export function datesBack(endDate, days) {
  const out = [];
  const d = new Date(`${endDate}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/**
 * @param {string} generatedDir  data/generated/<topic>
 * @param {string} endDate  YYYY-MM-DD (이번 주 마지막 날)
 * @param {object} [opts]
 * @param {number} [opts.days=7]
 * @param {string} [opts.topic='linux']
 * @param {number} [opts.limit=8]
 * @param {(date:string)=>Promise<string>} [opts.readFileImpl] 테스트 주입용
 * @returns {Promise<object>} 주간 dossier
 */
export async function collectWeeklyDossier(generatedDir, endDate, opts = {}) {
  const { days = 7, topic = 'linux', limit = 8, readFileImpl } = opts;
  const read = readFileImpl || ((date) => readFile(path.join(generatedDir, `research-${date}.json`), 'utf8'));

  const merged = new Map();
  const daysSeen = [];
  for (const date of datesBack(endDate, days)) {
    let data;
    try {
      data = JSON.parse(await read(date));
    } catch {
      continue;
    }
    daysSeen.push(date);
    for (const entry of data.entries || []) {
      const existing = merged.get(entry.candidateId);
      if (!existing || date > existing._date) {
        merged.set(entry.candidateId, { ...entry, _date: date });
      }
    }
  }

  const entries = [...merged.values()]
    .sort((a, b) => (CONFIDENCE_RANK[a.confidence] ?? 3) - (CONFIDENCE_RANK[b.confidence] ?? 3)
      || (SEVERITY_RANK[a.impactType] ?? 3) - (SEVERITY_RANK[b.impactType] ?? 3))
    .slice(0, limit)
    .map(({ _date, seenBefore, ...rest }) => rest); // 주간 롤업에선 일자/seenBefore 메타 제거

  return {
    topic,
    date: endDate,
    generatedAt: new Date().toISOString(),
    adapter: 'weekly-rollup',
    entries,
    droppedCandidates: [],
    rollup: { days, daysCovered: daysSeen.length, candidatePool: merged.size },
  };
}
