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

// 한국어 본문 안전화: deterministic dossier 의 whatChanged/quote 는 원문(영어+한자/가나, 외부 url)을
// 담을 수 있다. 본문 삽입 전에 raw URL(정식 링크는 [원문 확인] 으로 별도)과 한자·가나를 제거한다
// → quality-guard 의 ungrounded-URL / non-Korean-CJK 가드를 통과한다.
function oneLine(text, max = 160) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[぀-ヿ㐀-䶿一-鿿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
// 인용문은 원문 발췌라 외국어가 섞일 수 있다. oneLine 으로 url·한자·가나를 제거한 뒤
// 너무 짧아지면(의미 손실) 인용을 생략한다.
function firstQuote(entry) {
  const raw = (entry.evidence || []).map((x) => x.quote).find((q) => typeof q === 'string' && q.trim());
  const cleaned = oneLine(raw, 200);
  return cleaned.length >= 10 ? cleaned : '';
}

function sectionBody(entries) {
  if (!entries.length) return '이번 수집에서 해당 항목이 없습니다.';
  return entries.map((e) => {
    const url = firstUrl(e);
    const quote = firstQuote(e);
    const tag = e.seenBefore ? ' _(이어 추적)_' : '';
    const parts = [`**${e.title}**${tag}`, '', oneLine(e.whatChanged), '', `영향: ${oneLine(e.whyItMatters)}`];
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
export function dossierToPost(dossier, {
  postId, date, topic = 'linux', titleSuffix = '커널 개발 브리핑', tags = ['리눅스', '커널'],
  sectionOrder = SECTION_ORDER, sectionByImpact = SECTION_BY_IMPACT,
  emptyOtherText = '국부 드라이버/플랫폼 패치는 본문에서 제외했습니다. 자기 영역 키워드로 lore.kernel.org에서 직접 검색하세요.',
}) {
  const entries = Array.isArray(dossier.entries) ? dossier.entries : [];
  const fallbackHeading = sectionOrder[sectionOrder.length - 1];

  const grouped = new Map(sectionOrder.map((h) => [h, []]));
  for (const entry of entries) {
    const heading = sectionByImpact[entry.impactType] || fallbackHeading;
    (grouped.get(heading) || grouped.get(fallbackHeading)).push(entry);
  }

  const sections = sectionOrder.map((heading) => {
    const bucket = grouped.get(heading);
    if (heading === fallbackHeading && bucket.length === 0) {
      return { heading, body: emptyOtherText };
    }
    return { heading, body: sectionBody(bucket) };
  });

  // D: 신규(seenBefore 아님) 우선, 그다음 severity 순.
  const highlights = [...entries]
    .sort((a, b) => ((a.seenBefore ? 1 : 0) - (b.seenBefore ? 1 : 0))
      || ((SEVERITY_RANK[a.impactType] ?? 3) - (SEVERITY_RANK[b.impactType] ?? 3)))
    .slice(0, 4)
    .map(entryToHighlight);

  const sources = entries
    .map((e) => ({ title: e.title, url: firstUrl(e), note: e.evidence?.[0]?.kind || 'source' }))
    .filter((s) => s.url !== '없음')
    .slice(0, 8);

  // sectionOrder 기반 generic 카운트(토픽별 섹션 이름 그대로 사용).
  const bucketCounts = Object.fromEntries(sectionOrder.map((h) => [h, (grouped.get(h) || []).length]));
  const summaryParts = sectionOrder.slice(0, 3).map((h) => `${h} ${(grouped.get(h) || []).length}건`);
  const top = highlights[0];
  const headline = top
    ? oneLine(`${top.affectedAudience} 주목: ${top.title}`, 80)
    : '오늘 수집된 항목이 없습니다.';

  return {
    id: postId,
    topic,
    title: `${date} ${titleSuffix}`,
    headline,
    date,
    summary: `오늘의 핵심: ${summaryParts.join(', ')}. 리서치 dossier 의 출처를 근거로 정리했습니다.`,
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
      bucketCounts,
      entryCount: entries.length,
    },
  };
}
