# content-quality-enhancements Planning Document

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | research/write 분리로 조사 깊이는 확보했으나, ① 모은 근거(quote)를 글에 안 쓰고 버리고 ② 매일 같은 릴리스가 반복되며 ③ 단일 모델로 조사·작문을 함께 처리한다. |
| **Solution** | dossier 자산을 끝까지 활용: 원문 인용 노출(A), 모델 분리(B), 교차검증(C), 변화 중심 글(D), 주간 롤업(E). |
| **Function/UX Effect** | 독자가 근거를 바로 확인(신뢰도↑), 매일 새 정보만(반복 제거), 조사 깊이↑·비용↓, 주간 요약 제공. |
| **Core Value** | "검증된, 매일 읽을 가치 있는" 뉴스레터. |

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | dossier 의 검증된 근거를 글 품질로 전환, 매일 반복 제거 |
| **WHO** | 커널/오픈소스 추적 엔지니어 (기존 독자) |
| **RISK** | 외부 fetch 비결정성/비용, 모델 분리 시 토큰 비용, 어제 dossier 부재 시 fallback |
| **SUCCESS** | 5개 항목 각 exit criteria 충족 + `npm test` 회귀 0 |
| **SCOPE** | A→B→C→D→E 순차, 각 단계 독립 커밋 |

## 1. Overview

### 1.1 Purpose
research/write 분리(PDCA #1) 후속으로, dossier 를 콘텐츠 품질로 전환하는 5개 개선.

### 1.2 Background
- 설계 SSOT: `docs/RESEARCH-WRITE-SPLIT.md`
- 현재 dossier: `evidence[].quote`(원문 200자), `confidence`, `evidence[].url` 보유.
- 현재 글: quote 미사용, 매일 전체 후보 재기술, 단일 `CLAUDE_MODEL`.

### 1.3 Related Documents
- `docs/RESEARCH-WRITE-SPLIT.md`, `docs/archive/2026-06/research-write-split/`

## 2. Scope

### 2.1 In Scope
- **A. 원문 인용 노출**: `dossierToPost`/write 프롬프트가 `evidence.quote` 를 본문 blockquote 로. build-site 렌더 확인.
- **B. 모델 분리**: `CLAUDE_RESEARCH_MODEL`(+codex/cursor) 추가. research=상위모델/write=경량 가능.
- **C. 교차검증**: research-runner 가 dossier 생성 후 각 `evidence.url` 재fetch → `quote` 실재(부분일치) 확인. 실패 시 `confidence` 강등 + `openQuestions` 기록.
- **D. 변화 중심**: research-runner 가 어제 dossier 로드 → 같은 candidateId 는 `seenBefore` 표시. write 가 신규/진척 강조.
- **E. 주간 롤업**: 최근 7일 dossier 를 모아 핵심만 재작성하는 weekly write 경로.

### 2.2 Out of Scope
- 신규 collect 소스 추가, 멀티토픽 일괄 적용(opensource는 기적용), UI 대개편.

## 3. Success Criteria

| # | Criteria | 검증 |
|---|---------|------|
| SC-A | 발행 글에 evidence quote 가 blockquote 로 노출 | build HTML 에 `<blockquote>` + 인용문 |
| SC-B | research/write 모델을 독립 env 로 지정 가능 | `CLAUDE_RESEARCH_MODEL` 설정 시 research 만 모델 변경 |
| SC-C | quote 미검증 항목은 confidence 강등 | 가짜 URL 주입 시 confidence=low + openQuestions |
| SC-D | 어제 dossier 의 동일 항목이 seenBefore 로 표시 | 어제/오늘 dossier 동일 candidate → 표시 |
| SC-E | 최근 7일 dossier 로 주간 글 생성 | weekly 산출물 schema-valid |
| SC-0 | 회귀 없음 | `npm test` pass |

## 4. Risks

| Risk | Mitigation |
|------|-----------|
| 교차검증 fetch 비용/실패 | 타임아웃 + 실패는 강등(차단 아님), best-effort |
| 어제 dossier 부재(첫날) | seenBefore 전부 false 로 graceful |
| 모델 분리 미설정 | 기본은 기존 단일 모델 동작(하위호환) |

## 5. Implementation Order (각 단계 독립 커밋)
1. B (모델 분리, 가장 작음) → 2. A (인용 노출) → 3. D (변화) → 4. C (교차검증) → 5. E (주간 롤업)
