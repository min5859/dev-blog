# topic-dossier-first-rollout Planning Document

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | dossier-first(research+인용+검증+변화)가 linux·opensource 2개 토픽에만 배선돼 있어, android/ai-coding-agents/opensource-curation/lore-lens 글은 옛날 방식(draft→AI)으로 품질이 뒤처진다. 게다가 배선이 토픽별로 복제돼 N번 반복해야 한다. |
| **Solution** | ai-rewrite 의 dossier 분기를 공통 `write-runner` lib 로 추출(복제 제거) + research 단계를 잔여 토픽에 배선. |
| **Function/UX Effect** | 전 토픽이 2차 소스 조사·원문 인용·교차검증·변화추적을 받고, 이후 write 개선은 한 곳 수정으로 전 토픽 자동 반영. |
| **Core Value** | 토픽 무관 일관된 고품질 + 유지보수성. |

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 개선이 2토픽에만 적용·배선 복제 → 전 토픽 확장 + 공통화 |
| **WHO** | 안드로이드/AI코딩/오픈소스 큐레이션/커널 렌즈 독자 |
| **RISK** | 토픽별 draft 구조 상이, lens 의 topic-인자 구조, 리팩터 시 linux/opensource 회귀 |
| **SUCCESS** | 각 잔여 토픽 research:YES + dossier write 동작, `npm test` 회귀 0, linux/opensource 동작 보존 |
| **SCOPE** | write-runner 추출 → linux/opensource 리팩터 → android → ai-coding-agents → opensource-curation → lore-lens |

## 1. Overview
### 1.1 Purpose
dossier-first 를 전 토픽으로 확장하고 write 배선을 공통화.
### 1.2 Background
- 적용: linux, opensource. 미적용: android, ai-coding-agents, opensource-curation, lore-lens(렌즈 7개).
- 공통 엔진(research-runner/dossier-schema/dossier-to-post/ai-rewrite-adapter)은 이미 토픽 무관.
- 토픽별 `ai-rewrite-{topic}.mjs`·`run-daily-{topic}.mjs` 만 배선 필요.
### 1.3 Related
- `docs/RESEARCH-WRITE-SPLIT.md` (설계 SSOT)

## 2. Scope
### 2.1 In Scope
- **write-runner**: `scripts/lib/write-runner.mjs` — ai-rewrite 공통 골격(dossier 우선 입력, 프롬프트 빌드, AI 호출, dossierToPost/templateRewrite fallback, validatePost, auditPostQuality, 저장). 토픽 고유는 주입.
- **linux/opensource 리팩터**: write-runner 사용으로 전환(동작·산출 동일).
- **잔여 토픽 배선** (각): `research-{topic}.mjs`(research-runner 사용) + `{topic}-research-ko.md` + `{topic}-newsletter-from-dossier-ko.md` + `ai-rewrite-{topic}.mjs` dossier 전환 + `run-daily-{topic}.mjs` research 단계 + package.json scripts.
- **lore-lens**: topic 인자형 → `research-lore-lens.mjs <topic>` + 렌즈 공용 프롬프트 2종 + ai-rewrite/run-daily 배선.

### 2.2 Out of Scope
- 신규 collect 소스, weekly-rollup 의 잔여 토픽 적용(후속).

## 3. Success Criteria
| # | Criteria | 검증 |
|---|---------|------|
| SC-1 | write-runner 추출, linux/opensource 동일 산출 | 리팩터 후 template write 산출 동일 + 테스트 |
| SC-2 | android dossier-first 동작 | research:android → dossier write schema-valid |
| SC-3 | ai-coding-agents dossier-first 동작 | 동일 |
| SC-4 | opensource-curation dossier-first 동작 | 동일 |
| SC-5 | lore-lens(렌즈) dossier-first 동작 | research-lore-lens <lens> → dossier write |
| SC-0 | 회귀 0 | `npm test` pass |

## 4. Risks
| Risk | Mitigation |
|------|-----------|
| 리팩터 회귀 | write-runner 전환 후 template 산출 비교 + 테스트 |
| 토픽 draft 구조 상이 | templateRewrite 는 토픽별 주입(draft fallback 보존) |
| lens topic-인자 | research-runner 에 topic 주입(이미 파라미터) |
| candidates 부재 토픽 | research 입력 없으면 graceful(기존 draft fallback) |

## 5. Implementation Order (각 단계 커밋)
1. write-runner 추출 + linux/opensource 리팩터
2. android  3. ai-coding-agents  4. opensource-curation  5. lore-lens
