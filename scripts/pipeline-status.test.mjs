import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPipelineStatus } from './build-site.mjs';

const base={runDate:'2026-10-04',isToday:true,isManual:false};
const render=topics=>renderPipelineStatus({todayKst:'2026-10-04',topics});

test('status card distinguishes no-candidate skip from publication success',()=>{
  const html=render([
    {...base,topic:'linux',ok:true},
    {...base,topic:'linux-gpu-ai',ok:true,publicationSkipped:true},
  ]);
  assert.match(html,/1개 토픽 정상 처리 \/ 1개 게시 생략/);
  assert.match(html,/linux-gpu-ai<\/code> — 후보 없음으로 게시 생략/);
  assert.doesNotMatch(html,/모든 토픽이 정상 게시/);
  assert.doesNotMatch(html,/단계에서 실패/);
});

test('real failure is still visible when another topic skipped normally',()=>{
  const html=render([
    {...base,topic:'linux',ok:false,failedStep:'collect'},
    {...base,topic:'linux-gpu-ai',ok:true,publicationSkipped:true},
  ]);
  assert.match(html,/1개 토픽 실패/);
  assert.match(html,/collect 단계에서 실패/);
  assert.match(html,/1개 게시 생략/);
  assert.doesNotMatch(html,/모든 토픽이 실패/);
});

test('previous-day skip remains distinguishable in historical status',()=>{
  const html=render([{...base,topic:'linux-gpu-ai',isToday:false,ok:true,publicationSkipped:true}]);
  assert.match(html,/게시 생략 \(후보 없음\)/);
});
