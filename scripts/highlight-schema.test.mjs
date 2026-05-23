import test from 'node:test';
import assert from 'node:assert/strict';

import { IMPACT_TYPE_VALUES, PRIORITY_VALUES, hasFlatAction, hasStructuredAction, validateHighlight, validateHighlights } from './lib/highlight-schema.mjs';

const baseFlat = { title: 'X', priority: '상', impactType: 'runtime', affectedAudience: '런타임 담당자', verifyLink: 'https://x', action: '본문 확인' };
const baseStructured = {
  title: 'Y',
  priority: '중',
  impactType: 'api-abi',
  affectedAudience: 'ABI 담당자',
  verifyLink: 'https://y',
  if: '독자가 …이라면',
  do: '…해 보세요',
  verify: '…로 검증',
};

test('PRIORITY_VALUES에는 상·중·하만 포함된다', () => {
  assert.deepEqual([...PRIORITY_VALUES].sort(), ['상', '중', '하'].sort());
});

test('IMPACT_TYPE_VALUES는 개발자 영향 분류만 포함한다', () => {
  assert.deepEqual(
    [...IMPACT_TYPE_VALUES].sort(),
    ['api-abi', 'backport', 'build', 'performance', 'project', 'regression', 'release', 'runtime', 'security'].sort(),
  );
});

test('flat action 형식은 통과', () => {
  assert.doesNotThrow(() => validateHighlight(baseFlat, 0));
});

test('if/do/verify 형식은 통과', () => {
  assert.doesNotThrow(() => validateHighlight(baseStructured, 0));
});

test('action도 if/do/verify도 없으면 throw', () => {
  const broken = { title: 'Z', priority: '상', impactType: 'runtime', affectedAudience: '런타임 담당자', verifyLink: 'https://z' };
  assert.throws(() => validateHighlight(broken, 2), /requires either action or all of if\/do\/verify/);
});

test('priority가 상/중/하 외면 throw', () => {
  const bad = { ...baseFlat, priority: 'High' };
  assert.throws(() => validateHighlight(bad, 0), /priority must be 상\/중\/하/);
});

test('impactType이 허용 목록 밖이면 throw', () => {
  const bad = { ...baseFlat, impactType: 'misc' };
  assert.throws(() => validateHighlight(bad, 0), /impactType must be one of/);
});

test('필수 필드 누락은 키 이름까지 알려준다', () => {
  const noLink = { title: 'A', priority: '상', action: '확인' };
  assert.throws(() => validateHighlight(noLink, 0), /verifyLink required/);
});

test('객체가 아니면 명확한 에러', () => {
  assert.throws(() => validateHighlight(null, 1), /must be an object/);
  assert.throws(() => validateHighlight('str', 1), /must be an object/);
});

test('ctx가 주어지면 에러 메시지에 prefix가 붙는다', () => {
  assert.throws(
    () => validateHighlight({}, 0, 'publish-linux'),
    /publish-linux: highlights\[0\]/,
  );
});

test('if/do/verify 일부만 있으면 throw (셋 다 필요)', () => {
  const partial = { title: 'P', priority: '상', impactType: 'runtime', affectedAudience: '런타임 담당자', verifyLink: 'https://p', if: '…', do: '…' };
  assert.throws(() => validateHighlight(partial, 0), /requires either action or all of if\/do\/verify/);
});

test('hasStructuredAction / hasFlatAction 헬퍼가 의도대로 동작', () => {
  assert.equal(hasFlatAction(baseFlat), true);
  assert.equal(hasStructuredAction(baseFlat), false);
  assert.equal(hasFlatAction(baseStructured), false);
  assert.equal(hasStructuredAction(baseStructured), true);
  assert.equal(hasFlatAction(null), false);
  assert.equal(hasStructuredAction(undefined), false);
});

test('validateHighlights는 빈 배열을 거부', () => {
  assert.throws(() => validateHighlights([], 'X'), /non-empty/);
  assert.throws(() => validateHighlights('not array'), /non-empty/);
});

test('validateHighlights는 인덱스를 보존하며 순회', () => {
  const arr = [baseFlat, { ...baseFlat, priority: 'X' }];
  assert.throws(() => validateHighlights(arr, 'ctx'), /ctx: highlights\[1\]\.priority/);
});
