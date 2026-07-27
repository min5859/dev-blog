import test from 'node:test';
import assert from 'node:assert/strict';

import { foreignCjkRatio } from './opensource-curation/discover.mjs';

test('foreignCjkRatio returns 0 for pure English text', () => {
  assert.equal(foreignCjkRatio('Dive into LLMs: a hands-on tutorial'), 0);
});

test('foreignCjkRatio returns 0 for pure Korean text', () => {
  assert.equal(foreignCjkRatio('리눅스 커널 개발'), 0);
});

test('foreignCjkRatio exceeds the 0.15 threshold for Chinese-heavy text', () => {
  const ratio = foreignCjkRatio('《动手学大模型》系列编程实践教程');
  assert.equal(ratio > 0.15, true);
});

test('foreignCjkRatio stays within threshold for Korean text with a sprinkle of Hanja', () => {
  // 실제 discover 필터 대상(레포 name + description)과 비슷한 길이의 문장에 한자 한 단어(空間)만
  // 섞은 경우. 아주 짧은 문구(예: "커널 明文 처리")는 분모가 작아 한자 2글자만으로도 비율이
  // 33%를 넘어 임계값을 초과하므로, 실제 사용 맥락에 맞는 문장 길이로 검증한다.
  const ratio = foreignCjkRatio('리눅스 커널 메모리 관리자의 성능 개선과 空間 복잡도 최적화를 위한 프로파일링 도구');
  assert.equal(ratio <= 0.15, true);
});

test('foreignCjkRatio returns 0 for empty or missing text', () => {
  assert.equal(foreignCjkRatio(''), 0);
  assert.equal(foreignCjkRatio(undefined), 0);
});
