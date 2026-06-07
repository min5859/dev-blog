# weekly-rollup-automation Planning Document

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | weekly-rollup(dossier 기반 주간 요약)이 수동 실행만 가능하고 사이트 발행 경로가 없다. 어떤 스케줄에도 안 걸려 있다. |
| **Solution** | weekly-rollup 에 발행 경로(content/ 쓰기) 추가 + 전 토픽 일괄 스크립트 + daily-deploy.sh 월요일 블록 통합. |
| **Function/UX Effect** | 월요일마다 전 토픽 주간 요약이 자동 생성·발행돼 사이트에 노출. |
| **Core Value** | 손 안 대도 주간 뷰가 사이트에 갱신. |

## Context Anchor
| Key | Value |
|-----|-------|
| **WHY** | weekly-rollup 자동 트리거·발행 부재 |
| **WHO** | 전 토픽 독자(주간 요약) |
| **RISK** | weekly post 가 daily 와 posts/ 공유, publish 검증(draft 대조)은 weekly 부적합, claude 토큰/시간 |
| **SUCCESS** | weekly-rollup 발행 시 content/ 반영+build 렌더, 월요일 자동 트리거, `npm test` 회귀 0 |
| **SCOPE** | 발행 경로 → 일괄 스크립트+스케줄 통합 |

## 1. Overview
### 1.1 Purpose
weekly-rollup 자동 생성+발행 파이프라인.
### 1.2 Background
- `weekly-rollup.mjs <topic>` 는 generated 에만 저장. publish 경로 없음.
- `publish-linux.mjs` 는 daily 전용(assertImmutableAgainstDraft 가 draft-latest 대조) → weekly 부적합.
- build-site `assertPost`: id/topic/title/date/summary/sections/sources/highlights + date format + sections/sources 비어있지 않음. dossierToPost 산출이 충족.
- `daily-deploy.sh` 월요일(KST `date +%u`=1) 블록에 기존 `weekly:linux:claude` 존재.
### 1.3 Related
- docs/RESEARCH-WRITE-SPLIT.md

## 2. Scope
### 2.1 In Scope
- **발행 경로**: `weekly-rollup.mjs` 에 `PUBLISH_WEEKLY=1` 시 post 를 `content/topics/{topic}/posts/{postId}.json` 으로 발행(draft 대조 없이 assertPost 동급 검증). build-site 가 자동 렌더.
- **일괄 스크립트**: `scripts/run-weekly-all.mjs` — 전 토픽(linux/opensource/android/ai-coding-agents/opensource-curation + lens 토픽들) weekly-rollup 생성+발행. lens 는 토픽 목록 순회.
- **스케줄 통합**: `daily-deploy.sh` 월요일 블록에 `run-weekly-all` 추가(기존 weekly:linux 유지). 커밋 메시지/푸시 흐름 호환.
- npm script `weekly-rollup:all`.

### 2.2 Out of Scope
- 기존 weekly:linux(daily post 기반) 대체/제거 — 공존.
- weekly 전용 별도 cron(월요일 daily-deploy 에 합침).

## 3. Success Criteria
| # | Criteria | 검증 |
|---|---------|------|
| SC-1 | weekly-rollup 이 content/ 로 발행되고 build 가 렌더 | PUBLISH_WEEKLY 실행 후 content/posts 에 weekly post + build OK |
| SC-2 | 전 토픽 일괄 생성+발행 스크립트 | run-weekly-all 로 전 토픽 weekly post 발행 |
| SC-3 | 월요일 자동 트리거 통합 | daily-deploy.sh 월요일 블록에 run-weekly-all |
| SC-0 | 회귀 0 | `npm test` pass |

## 4. Risks
| Risk | Mitigation |
|------|-----------|
| weekly post 가 daily 와 혼동 | postId `{date}-{topic}-weekly-rollup` 로 구분 |
| publish 검증 부적합 | weekly 전용 발행(draft 대조 없이 assertPost 동급) |
| dossier 부재 토픽 | weekly graceful(빈 entries) → 발행 skip 또는 안내 |
| claude 토큰 | weekly 는 기존 dossier(research-latest) 재사용, claude 강제 안 함 |

## 5. Implementation Order (각 단계 커밋)
1. weekly-rollup 발행 경로(PUBLISH_WEEKLY) + 검증 + build 호환 확인
2. run-weekly-all 일괄 스크립트 + daily-deploy.sh 월요일 통합 + scripts
