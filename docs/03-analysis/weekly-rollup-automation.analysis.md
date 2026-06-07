# Analysis — weekly-rollup-automation (PDCA #5)

- Date: 2026-06-07
- 검증: 코드 스모크 + 빌드 + bash -n + npm test (실행 기반)

## SC 결과
| SC | Verdict | 근거 |
|----|:------:|------|
| SC-1 발행 경로 | ✅ Met | weekly-rollup.mjs PUBLISH_WEEKLY=1 → content/topics/linux/posts/2026-06-07-linux-weekly-rollup.json 발행, build 309 posts 렌더(feed 노출), validatePost 검증, entries 0 시 skip |
| SC-2 일괄 스크립트 | ✅ Met | run-weekly-all.mjs 전 토픽(표준5+lens6) 11/11 ok, npm weekly-rollup:all(:publish) |
| SC-3 월요일 스케줄 통합 | ✅ Met | daily-deploy.sh 월요일 블록에 PUBLISH_WEEKLY=1 run-weekly-all 추가(기존 weekly:linux 옆), bash -n OK |
| SC-0 회귀 | ✅ Met | npm test 115 pass |

## 동작 흐름 (월요일 KST)
daily 파이프라인(전 토픽) → weekly:linux:claude(기존) → **run-weekly-all(PUBLISH_WEEKLY=1, 전 토픽 dossier 주간 롤업 생성+발행)** → git add content/ → push → GitHub Pages 빌드.

## 견고성
- research 없는 토픽(lens 일부)은 weekly entries 0 → 발행 skip(graceful), 11/11 ok 유지.
- best-effort: 일부 토픽 실패해도 나머지 진행, 전부 실패 시에만 non-zero.

## 결론
weekly-rollup 이 수동 → 월요일 자동 생성+발행으로 통합. 전 토픽 주간 요약이 사이트에 자동 노출.
SC 4/4 Met, Critical 0.
