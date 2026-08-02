/**
 * GitHub 후보(레포명/설명)에 비한글 CJK(중국어/일본어)가 섞이면 rewrite 후
 * quality-guard.mjs 의 FOREIGN_CJK 검사에 걸려 topic 전체가 게시 누락된다.
 * opensource-curation(discover.mjs)과 opensource(트렌딩, draft-opensource.mjs) 양쪽에서
 * 후보 선별 시점에 미리 걸러내기 위한 공유 유틸.
 */

// quality-guard.mjs 의 FOREIGN_CJK 와 동일한 문자클래스(히라가나+가타카나+한자).
// 한글(가-힣)은 분자에 들지 않으므로, 한자가 드문드문 섞인 한국어 제목/설명은 오탐하지 않는다.
const FOREIGN_CJK_RE = /[぀-ゟ゠-ヿ一-鿿]/g;

export const FOREIGN_CJK_MAX_RATIO = 0.15;

/**
 * 공백을 제외한 전체 글자 수 대비 비한글 CJK(가나+한자) 글자 수 비율(0~1).
 * @param {string} text
 * @returns {number}
 */
export function foreignCjkRatio(text) {
  const stripped = (text || '').replace(/\s/g, '');
  if (!stripped.length) return 0;
  const matches = stripped.match(FOREIGN_CJK_RE);
  return (matches ? matches.length : 0) / stripped.length;
}
