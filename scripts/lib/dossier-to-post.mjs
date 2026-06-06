/**
 * Deterministic write fallback: research dossier → newsletter post.
 * template/codex 어댑터(또는 AI 미사용)에서 dossier 만으로 schema-valid 한 post 를 만든다.
 * AI write 경로(claude)는 prompts/linux-newsletter-from-dossier-ko.md 를 쓰고 이 함수는 쓰지 않는다.
 *
 * 설계: docs/RESEARCH-WRITE-SPLIT.md §2, §3
 */

const SECTION_ORDER = ['릴리스/로드맵', '회귀·보안 신호', '핵심 변경', '기타'];
const SECTION_BY_IMPACT = {
  release: '릴리스/로드맵',
  security: '회귀·보안 신호',
  regression: '회귀·보안 신호',
  backport: '핵심 변경',
  'api-abi': '핵심 변경',
  runtime: '핵심 변경',
  build: '핵심 변경',
  performance: '핵심 변경',
  project: '기타',
};
const SEVERITY_RANK = { security: 0, regression: 0, release: 1, backport: 2, 'api-abi': 2 };

function oneLine(text, max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstUrl(entry) {
  const ev = (entry.evidence || []).find((e) => e && typeof e.url === 'string' && e.url);
  return ev ? ev.url : '없음';
}

function priorityFromEntry(entry) {
  const t = entry.impactType;
  if (t === 'security' || t === 'regression') return entry.confidence === 'low' ? '중' : '상';
  if (t === 'release' || t === 'backport' || t === 'api-abi') return '중';
  return entry.confidence === 'high' ? '중' : '하';
}

function entryToHighlight(entry) {
  const url = firstUrl(entry);
  return {
    title: entry.title,
    priority: priorityFromEntry(entry),
    impactType: entry.impactType,
    affectedAudience: entry.affectedAudience,
    verifyLink: url,
    if: `${entry.affectedAudience}라면`,
    do: oneLine(entry.whatChanged, 80),
    verify: url !== '없음' ? `출처를 열어 본문과 대조해 확인하세요: ${url}` : '원문 스레드를 열어 영향 범위를 확인하세요',
  };
}

// A: dossier 의 evidence.quote(원문 발췌)를 blockquote 로 노출 → 독자가 근거를 바로 확인.
// build-site 가 body 를 marked 로 렌더하고 blockquote CSS 가 있으므로 markdown `>` 면 충분.
function firstQuote(entry) {
  return (entry.evidence || []).map((x) => x.quote).find((q) => typeof q === 'string' && q.trim());
}

function sectionBody(entries) {
  if (!entries.length) return '이번 수집에서 해당 항목이 없습니다.';
  return entries.map((e) => {
    const url = firstUrl(e);
    const quote = firstQuote(e);
    const parts = [`**${e.title}**`, '', oneLine(e.whatChanged), '', `영향: ${oneLine(e.whyItMatters)}`];
    if (quote) parts.push('', `> ${oneLine(quote, 200)}`);
    if (url !== '없음') parts.push('', `[원문 확인](${url})`);
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * @param {object} dossier  validateDossier 를 통과한 dossier
 * @param {object} opts
 * @param {string} opts.postId
 * @param {string} opts.date
 * @param {string} [opts.topic='linux']
 * @param {string} [opts.titleSuffix='커널 개발 브리핑'] title 끝에 붙는 토픽 라벨
 * @param {string[]} [opts.tags=['리눅스','커널']]
 * @returns {object} newsletter post
 */
export function dossierToPost(dossier, { postId, date, topic = 'linux', titleSuffix = '커널 개발 브리핑', tags = ['리눅스', '커널'] }) {
  const entries = Array.isArray(dossier.entries) ? dossier.entries : [];

  const grouped = new Map(SECTION_ORDER.map((h) => [h, []]));
  for (const entry of entries) {
    const heading = SECTION_BY_IMPACT[entry.impactType] || '기타';
    grouped.get(heading).push(entry);
  }

  const sections = SECTION_ORDER.map((heading) => {
    const bucket = grouped.get(heading);
    if (heading === '기타' && bucket.length === 0) {
      return { heading, body: '국부 드라이버/플랫폼 패치는 본문에서 제외했습니다. 자기 영역 키워드로 lore.kernel.org에서 직접 검색하세요.' };
    }
    return { heading, body: sectionBody(bucket) };
  });

  const highlights = [...entries]
    .sort((a, b) => (SEVERITY_RANK[a.impactType] ?? 3) - (SEVERITY_RANK[b.impactType] ?? 3))
    .slice(0, 4)
    .map(entryToHighlight);

  const sources = entries
    .map((e) => ({ title: e.title, url: firstUrl(e), note: e.evidence?.[0]?.kind || 'source' }))
    .filter((s) => s.url !== '없음')
    .slice(0, 8);

  const counts = {
    releases: grouped.get('릴리스/로드맵').length,
    regressions: grouped.get('회귀·보안 신호').length,
    patches: grouped.get('핵심 변경').length,
  };
  const top = highlights[0];
  const headline = top
    ? oneLine(`${top.affectedAudience} 주목: ${top.title}`, 80)
    : '오늘 수집된 시스템 영향 항목이 없습니다.';

  return {
    id: postId,
    topic,
    title: `${date} ${titleSuffix}`,
    headline,
    date,
    summary: `오늘의 핵심: 릴리스 ${counts.releases}건, 회귀·보안 ${counts.regressions}건, 핵심 변경 ${counts.patches}건. 리서치 dossier 의 출처를 근거로 정리했습니다.`,
    tags,
    highlights,
    sections,
    confidence: {
      level: '자동 생성',
      note: '리서치 dossier 의 출처를 근거로 작성했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.',
    },
    sources,
    draftMetadata: {
      source: 'research-dossier',
      bucketCounts: counts,
      entryCount: entries.length,
    },
  };
}
