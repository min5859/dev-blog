/**
 * highlights[] 항목의 단일 정의처. publisher / rewrite validator / weekly / build-site
 * 가 모두 여기서 import 한다. 새 필드를 추가하거나 허용 형태를 바꿀 때 한 곳만 손보면
 * 나머지는 자동 적용된다.
 */

export const PRIORITY_VALUES = new Set(['상', '중', '하']);

const STRUCTURED_KEYS = ['if', 'do', 'verify'];

export function hasStructuredAction(highlight) {
  return STRUCTURED_KEYS.every((k) => typeof highlight?.[k] === 'string' && highlight[k]);
}

export function hasFlatAction(highlight) {
  return typeof highlight?.action === 'string' && Boolean(highlight.action);
}

/**
 * @param {unknown} highlight
 * @param {number} index
 * @param {string} [ctx] e.g. 파일명 — 에러 메시지 prefix
 * @throws {Error} 검증 실패 시
 */
export function validateHighlight(highlight, index, ctx = '') {
  const where = ctx ? `${ctx}: highlights[${index}]` : `highlights[${index}]`;
  if (!highlight || typeof highlight !== 'object') {
    throw new Error(`${where} must be an object`);
  }
  for (const key of ['title', 'priority', 'verifyLink']) {
    if (typeof highlight[key] !== 'string' || !highlight[key]) {
      throw new Error(`${where}.${key} required`);
    }
  }
  if (!hasFlatAction(highlight) && !hasStructuredAction(highlight)) {
    throw new Error(`${where} requires either action or all of if/do/verify`);
  }
  if (!PRIORITY_VALUES.has(highlight.priority)) {
    throw new Error(`${where}.priority must be 상/중/하 (got ${highlight.priority})`);
  }
}

/**
 * @param {unknown} highlights
 * @param {string} [ctx]
 * @throws {Error}
 */
export function validateHighlights(highlights, ctx = '') {
  if (!Array.isArray(highlights) || highlights.length === 0) {
    const where = ctx ? `${ctx}: highlights` : 'highlights';
    throw new Error(`${where} must be a non-empty array`);
  }
  highlights.forEach((h, i) => validateHighlight(h, i, ctx));
}
