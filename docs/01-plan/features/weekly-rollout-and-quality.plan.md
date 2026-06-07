# weekly-rollout-and-quality Planning Document

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | ① weekly-rollup(주간 핵심 요약)이 linux 에만 있어 다른 토픽은 주간 뷰가 없다. ② 잔여 토픽 dossier-first 가 template 로만 검증돼, claude 실운영 품질이 숫자로 확인되지 않았다. |
| **Solution** | ① weekly-rollup 을 토픽 인자형으로 일반화(토픽 메타 주입) ② 전 토픽 claude research 실운영 후 before/after 정량 측정. |
| **Function/UX Effect** | 전 토픽 주간 롤업 제공 + dossier-first 품질 리프트를 토픽별 숫자(2차 소스·인용·정보밀도)로 입증. |
| **Core Value** | 일관된 주간 뷰 + 검증된 품질 근거. |

## Context Anchor
| Key | Value |
|-----|-------|
| **WHY** | weekly-rollup 단일토픽 한계 + 잔여 토픽 품질 미측정 |
| **WHO** | 전 토픽 독자 + 운영자(품질 근거) |
| **RISK** | 토픽별 candidates 부재, claude 실운영 토큰/시간, 토픽 메타 분산 |
| **SUCCESS** | 각 토픽 weekly post 생성 + 전 토픽 before/after 측정표, `npm test` 회귀 0 |
| **SCOPE** | weekly-rollup 일반화 → 정량화 측정 |

## 1. Overview
### 1.1 Purpose
weekly-rollup 멀티토픽 일반화 + 전 토픽 dossier-first 품질 정량화.
### 1.2 Background
- weekly-rollup-linux.mjs + collectWeeklyDossier(토픽 범용) 존재.
- 전 토픽 dossier-first 배선 완료(PDCA #3), template 검증만.
### 1.3 Related
- docs/RESEARCH-WRITE-SPLIT.md, docs/archive/2026-06/

## 2. Scope
### 2.1 In Scope
- **weekly-rollup 일반화**: `scripts/weekly-rollup.mjs <topic>` (토픽 인자) + 토픽 메타 레지스트리(titleSuffix/tags + 선택 sectionPlan). weekly-rollup-linux.mjs 는 호환 유지 또는 일반 스크립트로 위임. npm scripts `weekly-rollup:<topic>`.
- **정량화**: 전 토픽(linux/opensource/android/ai-coding-agents/opensource-curation/lore-lens 대표 1렌즈) `AI_ADAPTER=claude` research 실운영 → before(template/draft) 대비 2차 소스·인용·정보밀도 측정 → `docs/03-analysis/` 측정 리포트.
### 2.2 Out of Scope
- 측정 결과를 사이트에 publish(별도), weekly-rollup 의 사이트 빌드 통합.

## 3. Success Criteria
| # | Criteria | 검증 |
|---|---------|------|
| SC-1 | weekly-rollup 토픽 인자형으로 전 토픽 weekly post 생성 | 각 토픽 weekly-rollup 산출물 schema-valid |
| SC-2 | 전 토픽 claude 실운영 before/after 측정표 | docs/03-analysis 측정 리포트 + 토픽별 수치 |
| SC-0 | 회귀 0 | `npm test` pass |

## 4. Risks
| Risk | Mitigation |
|------|-----------|
| 토픽 candidates 부재 | weekly 는 dossier 없으면 graceful(빈 entries) |
| claude 실운영 토큰/시간 | 토픽당 1회, 측정 후 정리. lens 는 대표 1개만 |
| 토픽 메타 분산 | weekly-rollup 에 토픽 메타 맵 일원화 |

## 5. Implementation Order (각 단계 커밋)
1. weekly-rollup 토픽 인자형 일반화 + 토픽 메타 맵 + scripts
2. 전 토픽 claude 실운영 정량화 측정 리포트
