# research-write-split Completion Report

> **Status**: Complete (PoC)
>
> **Project**: dev-blog
> **Version**: 0.1.0
> **Author**: Wooki Min
> **Completion Date**: 2026-06-06
> **PDCA Cycle**: #1

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | research/write 에이전트 분리 (research-write-split) |
| Start Date | 2026-06-06 |
| End Date | 2026-06-06 |
| Duration | 1 session |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Design Match Rate: 99.2%                    │
├─────────────────────────────────────────────┤
│  ✅ Complete:   Step 1–4 + Check + Act       │
│  ⏳ Deferred:   codex/cursor research, 멀티토픽 │
│  ❌ Cancelled:  0                            │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | 단일 AI rewrite 단계가 "조사+작문"을 한 번에 처리. 입력은 draft의 commit message + 700자 excerpt에 갇혀(품질 천장), 도구 없는 closed 변환이라 인사이트를 더할 재료가 없었다. |
| **Solution** | 조사(research)와 작문(write)을 분리. 둘 사이 계약으로 dossier(claim마다 evidence URL 강제)를 두고, research에만 read-only 도구(WebFetch/WebSearch/git log)를 부여. write는 dossier 밖 주장 금지. |
| **Function/UX Effect** | claude 도구 조사 실측: 후보 8개 중 국부 패치 2건 자율 제외, **LWN 5건·CVE 2건 포함 evidence 13건** 수집(기존 파이프라인 2차 소스 0건). 최종 글 출처에 LWN 2건·CVE 번호 반영. write URL **10/10 dossier grounding**. |
| **Core Value** | "누가 쓰냐"가 아니라 "조사를 도구로 깊게 하느냐"가 품질을 가른다는 가설이 실측으로 검증됨. 700자 천장 돌파. |

---

## 1.4 Success Criteria Final Status

> 설계 `docs/RESEARCH-WRITE-SPLIT.md` §6 각 Step의 exit criteria를 SC로 매핑.

| # | Criteria | Status | Evidence |
|---|---------|:------:|----------|
| SC-1 | dossier validator가 evidence URL 없는 claim을 거부 | ✅ Met | `dossier-schema.mjs:36-38`; `dossier-schema.test.mjs` 16 cases pass |
| SC-2 | research가 claude 도구 조사 / 비claude deterministic 양쪽 schema-valid dossier 산출 | ✅ Met | `research-linux.mjs`; template 8-entry, claude 4-entry/13-evidence 실행 확인 |
| SC-3 | write가 dossier 소비 + dossier 밖 URL 차단, draft fallback 유지 | ✅ Met | `ai-rewrite-linux.mjs:53-65,144`; grounding=dossier로 `findUngroundedUrls` 강제 |
| SC-4 | daily 파이프라인 collect→draft→research→write→build 동작 | ✅ Met | `run-daily-linux.mjs`; 전체 ok 로그 |
| SC-5 | 전체 테스트 통과 | ✅ Met | `npm test` 103/103 (신규 24 케이스 포함) |
| SC-6 | research 호출 time budget (hang 방지) | ✅ Met | `ai-rewrite-adapter.mjs` wall-clock timeout; 5ms 강제 시 fail 확인 |

**Success Rate**: 6/6 criteria met (100%)

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|--------|----------|:---------:|---------|
| [Design §7] | research 도구 = WebFetch/WebSearch/Bash(git log:*), read-only | ✅ | `ai-rewrite-adapter.mjs:69` 기본값 일치 |
| [Design §7] | 2차 소스(LWN/Phoronix) collector 미추가, 에이전트 추론으로 | ✅ | collector 0개; claude가 WebSearch로 LWN ad hoc 도달 |
| [Design §7] | enrichWithBodies는 draft에 잔존(offline fallback) | ✅ | `draft-linux.mjs:702` 호출 유지 |
| [Design §7] | network/time budget | ✅ | Check 후 Act에서 timeout 구현(99.2%→갭 해소) |
| [Design §2] | write는 dossier만 소비, dossier 밖 주장 금지 | ✅ | grounding=dossier, 10/10 URL grounded |

---

## 2. Related Documents

| Phase | Document | Status |
|-------|----------|--------|
| Design | [RESEARCH-WRITE-SPLIT.md](../RESEARCH-WRITE-SPLIT.md) | ✅ Finalized |
| Check | [research-write-split.analysis.md](../03-analysis/research-write-split.analysis.md) | ✅ Complete |
| Act | Current document | 🔄 Writing |

> 표준 PDCA Plan/Design 디렉토리 대신 단일 설계 문서(RESEARCH-WRITE-SPLIT.md)를 SSOT로 사용.

---

## 3. Completed Items

### 3.1 Functional Requirements

| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| Step 1 | dossier 스키마 + validator + 테스트 | ✅ Complete | `dossier-schema.mjs` |
| Step 2 | research 단계 (claude 도구 / deterministic fallback) | ✅ Complete | `research-linux.mjs`, `linux-research-ko.md` |
| Step 3 | write 단계 dossier 소비 + draft fallback | ✅ Complete | `ai-rewrite-linux.mjs`, `dossier-to-post.mjs` |
| Step 4 | daily 파이프라인 배선 | ✅ Complete | `run-daily-linux.mjs` |

### 3.2 Non-Functional Requirements

| Item | Target | Achieved | Status |
|------|--------|----------|--------|
| 테스트 | 회귀 0 | 103/103 pass (+24 신규) | ✅ |
| back-compat | draft 흐름 보존 | dossier 없으면 자동 폴백 | ✅ |
| adapter 경계 | 기존 export 시그니처 보존 | 변경 없음 | ✅ |
| hang 방지 | timeout 존재 | 10분 기본/env override | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| dossier 스키마 | scripts/lib/dossier-schema.mjs | ✅ |
| research 단계 | scripts/research-linux.mjs | ✅ |
| write fallback | scripts/lib/dossier-to-post.mjs | ✅ |
| 프롬프트 | prompts/linux-research-ko.md, prompts/linux-newsletter-from-dossier-ko.md | ✅ |
| 테스트 | scripts/dossier-schema.test.mjs, scripts/dossier-to-post.test.mjs | ✅ |
| 문서 | docs/RESEARCH-WRITE-SPLIT.md, docs/03-analysis/, docs/04-report/ | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over to Next Cycle

| Item | Reason | Priority | Estimated Effort |
|------|--------|----------|------------------|
| codex/cursor research 도구 분기 | PoC는 claude부터(§7) | Medium | 0.5 day |
| 멀티토픽 확장 (android/opensource/lens 등) | linux PoC 검증 후(§Out of scope) | Medium | 토픽당 0.5 day |
| claude 경로 실하루 before/after 품질 정량화 | 도구 권한 환경 필요 | High | 0.5 day |

### 4.2 Cancelled/On Hold Items

| Item | Reason | Alternative |
|------|--------|-------------|
| 2차 소스 standing collector | 설계 결정 #2로 보류 | 에이전트 WebSearch ad hoc |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final | Change |
|--------|--------|-------|--------|
| Design Match Rate | 90% | 99.2% | ✅ |
| Tests | 회귀 0 | 103 pass (+24) | ✅ |
| Critical Gaps | 0 | 0 | ✅ |
| 2차 소스 evidence (claude) | — | LWN 5 / CVE 2 | 기존 0 → 돌파 |
| write URL grounding | 100% | 10/10 | ✅ |

### 5.3 BEFORE/AFTER 정량 비교 (2026-06-06, write 엔진 고정)

> 같은 하루 candidates로 write 엔진(template)을 고정하고 입력만 바꿔 "조사 단계의 효과"를 격리.
> BEFORE = draft(700자 excerpt + commit) 입력 / AFTER = claude 도구 조사 dossier 입력.

| 지표 | BEFORE (draft) | AFTER (claude 조사) |
|------|:--------------:|:-------------------:|
| 본문 글자 수 | 1,343 | **2,866** (≈2.1배) |
| 2차 분석 소스 (LWN/Phoronix) | 0 | **2** |
| CVE 언급 | 0 | **4** |
| 출처 종류 | lore/kernel.org (1차) | **article(LWN)/changelog/thread** |
| 출처 수 | 7 | 4 (국부 패치 2건 자율 제외 + 압축) |

**해석**: AFTER의 출처 *수*는 오히려 적지만(질적 선별), 본문 정보 밀도는 2배, 2차 분석 소스·CVE가 0→다수로 등장.
동일 7.0.11 stable 항목 본문 대조:
- BEFORE: `안정 커널 사용 환경 (공개일 2026-06-01)` — 메타데이터 한 줄.
- AFTER: `462건 백포트, 501개 파일/6371줄 수정, security/keys RCU 픽스, tap_ioctl 정보 누수 차단, Greg KH "전 사용자 업그레이드 권고"` + LWN 출처.

조사 단계가 실제로 검증된 심층 정보를 본문에 추가한다는 가설이 정량으로 확인됨.

### 5.2 Resolved Issues

| Issue | Resolution | Result |
|-------|------------|--------|
| over-length quote가 dossier 거부 유발 | `normalizeDossier`로 200자 절단 | ✅ Resolved |
| tool-enabled claude 호출 무한 hang 가능 (Check 갭 #1) | wall-clock timeout (SIGTERM+fail-loud) | ✅ Resolved |
| 7분 조사 결과 validation 실패로 유실 | `RESEARCH_RAW_PATH` 재파싱 복구 | ✅ Resolved |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- 초기 진단을 코드로 검증하며 "700자 천장" 가설을 정정(draft가 이미 결정론적 fetch 수행)했고, 분리의 진짜 가치를 "도구 기반 조사 격상"으로 재정의한 것.
- dossier를 grounding 근거로 재사용해, 기존 `findUngroundedUrls`가 추가 코드 없이 "dossier 밖 URL 금지"를 강제하게 한 설계.
- Step별 커밋 + deterministic fallback 우선 검증으로 claude 토큰을 늦게 소비.

### 6.2 What Needs Improvement (Problem)

- validator의 quote 200자 제한을 사전에 normalize로 막지 않아 첫 claude 실행(7분)이 저장 직전 실패. 외부 모델 출력의 변동성을 검증 전 정규화하는 습관 필요.
- daily의 `rewrite:linux`가 `AI_ADAPTER` 미지정 시 기본 codex로 도는 기존 동작 때문에, "template 강제" 의도와 실제 어댑터가 어긋남(혼란 소지).

### 6.3 What to Try Next (Try)

- codex/cursor에도 research 도구 분기를 추가해 어댑터 간 동등성 확보.
- claude 경로로 실하루 운영하여 before/after 본문 품질을 정량 비교(출처 수, 구체 수치 밀도).

---

## 7. Process Improvement Suggestions

### 7.1 PDCA Process

| Phase | Current | Improvement Suggestion |
|-------|---------|------------------------|
| Design | 단일 문서 SSOT로 운영 | 소규모 기능엔 적합; 유지 |
| Check | gap-detector static + npm test | 외부 모델 출력 케이스도 픽스처로 회귀화 |

### 7.2 Tools/Environment

| Area | Improvement Suggestion | Expected Benefit |
|------|------------------------|------------------|
| research 어댑터 | timeout/budget env 문서화 | 운영 hang 방지 |
| 품질 측정 | dossier 출처 수 메트릭 로깅 | before/after 정량화 |

---

## 8. Next Steps

### 8.1 Immediate

- [ ] `research:linux:claude`로 실하루 운영 → before/after 품질 정량화
- [ ] codex/cursor research 도구 분기 추가 검토

### 8.2 Next PDCA Cycle

| Item | Priority | Expected Start |
|------|----------|----------------|
| 멀티토픽 확장 (research/write 분리 일반화) | Medium | linux 검증 후 |
| codex/cursor research 동등성 | Medium | — |

---

## 9. Changelog

### v0.1.0 — research-write-split (2026-06-06)

**Added:**
- research dossier 스키마 + validator (`dossier-schema.mjs`)
- research 단계 (`research-linux.mjs`) — claude 도구 조사 + deterministic fallback
- dossier 기반 write 경로 (`dossier-to-post.mjs`, `linux-newsletter-from-dossier-ko.md`)
- adapter `runResearchAdapterPrompt` / `extractJsonObject` / research timeout
- daily 파이프라인 research 단계

**Changed:**
- `ai-rewrite-linux.mjs` 입력을 dossier 우선으로 (draft fallback)

**Fixed:**
- over-length quote 정규화, research 호출 timeout, raw 재파싱 복구

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-06-06 | Completion report created | Wooki Min |
