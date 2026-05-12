/**
 * Rewritten post 가 cursor/claude 어댑터의 출력 오염 패턴을 그대로 게시하지 않도록
 * 후처리 단계에서 한 번 더 거른다. critical 위반은 throw 해서 ai-rewrite 가 재시도되도록,
 * soft 위반은 console.warn 으로만 보고한다.
 */

// 한글 본문에 들어와서는 안 되는 CJK/가나 글자. 한자가 든 식별자(`__builtin_*` 등)는 영문자라
// 잡히지 않고, 한국어 단어의 옛 한자 혼용("사용자空間")만 잡힌다.
const FOREIGN_CJK = /[぀-ゟ゠-ヿ一-鿿]/;

// 한국어 콘텐츠에서 "Clang 23", "GCC 17" 같이 현실보다 명백히 앞선 버전을 인용하는 경우.
// 보수적으로 잡기 위해 임계값은 매년 손으로 조정한다.
const VERSION_CEILINGS = [
  { re: /\bClang\s+(\d{2,3})\b/g, max: 22, label: 'Clang' },
  { re: /\bGCC\s+(\d{2,3})\b/g, max: 17, label: 'GCC' },
  { re: /\bLinux\s+(\d+)\.(\d+)\b/g, max: [8, 0], label: 'Linux' },
];

// lore.kernel.org URL 의 message-id 가 너무 짧으면 잘렸을 가능성이 높다.
const SHORT_LORE_ID = /https?:\/\/lore\.kernel\.org\/[\w-]+\/([^/\s>"']{1,15})\/?(?=[\s"'<>)\]]|$)/g;

// 본문에 인용된 ⭐/별 수치. 천 단위 콤마·"만" 단위 모두 검출.
const STAR_COUNT_PATTERNS = [
  /⭐\s*[가-힣]*\s*([\d,]+)/g,
  /별\s*수\s*[≈약]?\s*([\d,]+)/g,
];

function gatherTextFields(post) {
  const parts = [];
  if (post.title) parts.push(['title', post.title]);
  if (post.headline) parts.push(['headline', post.headline]);
  if (post.summary) parts.push(['summary', post.summary]);
  for (const [i, section] of (post.sections || []).entries()) {
    if (section?.heading) parts.push([`sections[${i}].heading`, section.heading]);
    if (section?.body) parts.push([`sections[${i}].body`, section.body]);
  }
  for (const [i, h] of (post.highlights || []).entries()) {
    if (h?.title) parts.push([`highlights[${i}].title`, h.title]);
    if (h?.action) parts.push([`highlights[${i}].action`, h.action]);
    if (h?.if) parts.push([`highlights[${i}].if`, h.if]);
    if (h?.do) parts.push([`highlights[${i}].do`, h.do]);
    if (h?.verify) parts.push([`highlights[${i}].verify`, h.verify]);
  }
  return parts;
}

function findForeignCjk(fields) {
  const hits = [];
  for (const [where, text] of fields) {
    const m = text.match(FOREIGN_CJK);
    if (m) {
      const around = text.slice(Math.max(0, m.index - 8), m.index + 8);
      hits.push(`${where}: "${around}"`);
    }
  }
  return hits;
}

function findFutureVersions(fields) {
  const hits = [];
  for (const [where, text] of fields) {
    for (const { re, max, label } of VERSION_CEILINGS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (Array.isArray(max)) {
          const [maj, min] = max;
          const major = Number(m[1]);
          const minor = Number(m[2]);
          if (major > maj || (major === maj && minor > min)) {
            hits.push(`${where}: ${label} ${major}.${minor} (max ${maj}.${min})`);
          }
        } else {
          const n = Number(m[1]);
          if (n > max) hits.push(`${where}: ${label} ${n} (max ${max})`);
        }
      }
    }
  }
  return hits;
}

function findTruncatedLoreIds(fields) {
  const hits = [];
  for (const [where, text] of fields) {
    for (const re of [SHORT_LORE_ID]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        hits.push(`${where}: short lore id "${m[1]}"`);
      }
    }
  }
  return hits;
}

function findImplausibleStarCounts(fields) {
  const hits = [];
  for (const [where, text] of fields) {
    for (const re of STAR_COUNT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = Number(m[1].replaceAll(',', ''));
        if (Number.isFinite(n) && n > 300000) {
          hits.push(`${where}: implausible star count ${n.toLocaleString()}`);
        }
      }
    }
  }
  return hits;
}

/**
 * @param {object} post 검증할 rewritten post
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true] true 면 critical 위반시 throw, false 면 warnings 만 모은다.
 * @returns {{ critical: string[], warnings: string[] }}
 */
export function auditPostQuality(post, { strict = true } = {}) {
  const fields = gatherTextFields(post);
  const critical = [];
  const warnings = [];

  critical.push(...findForeignCjk(fields).map((h) => `non-Korean CJK chars in ${h}`));
  warnings.push(...findFutureVersions(fields).map((h) => `future-looking version: ${h}`));
  warnings.push(...findTruncatedLoreIds(fields).map((h) => `possibly truncated lore id: ${h}`));
  warnings.push(...findImplausibleStarCounts(fields).map((h) => `${h}`));

  if (warnings.length) {
    console.warn(`[quality-guard] ${warnings.length} warning(s):\n  - ${warnings.join('\n  - ')}`);
  }
  if (strict && critical.length) {
    throw new Error(`[quality-guard] ${critical.length} critical issue(s):\n  - ${critical.join('\n  - ')}`);
  }
  return { critical, warnings };
}
