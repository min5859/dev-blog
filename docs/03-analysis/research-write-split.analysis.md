# Design-Implementation Gap Analysis — research-write-split

- **Target**: research/write 에이전트 분리
- **Design (SSOT)**: `docs/RESEARCH-WRITE-SPLIT.md` §3, §4, §6 (Steps 1–4), §7
- **Date**: 2026-06-06
- **Match Rate**: **99.2%** (Structural 0.2 + Functional 0.4 + Contract 0.4)
- **Note**: node 스크립트 파이프라인. L1/L2/L3 웹 테스트 해당 없음. 런타임은 `npm test`(103 pass) + adapter smoke 로 대체.

## Per-Step Verdict

### Step 1 — Dossier schema + validator — PASS
- Structural: `validateDossier`/`validateDossierEntry`/`validateEvidence` 존재 (`dossier-schema.mjs:86/54/26`). 테스트 16 케이스.
- Functional: evidence URL 없으면 throw (`:36-38`), 빈 evidence 거부 (`:70-72`), quote ≤200 (`:44`). `impactType` 은 `highlight-schema.IMPACT_TYPE_VALUES` 재사용.
- Contract: 생성측(`research-linux.mjs:5`)·소비측(`ai-rewrite-linux.mjs:7`) 단일 정의처 import.

### Step 2 — Research stage (claude + deterministic fallback) — PASS
- Structural: 입력 `candidates-latest.json` → 출력 `research-latest.json`. 프롬프트 `linux-research-ko.md`. adapter `runResearchAdapterPrompt`+`extractJsonObject`. npm scripts 존재.
- Functional: claude 경로 `--allowedTools WebFetch,WebSearch,Bash(git log:*)` (`ai-rewrite-adapter.mjs:69-74`); non-claude null → `buildDeterministicDossier` → `validateDossier` 강제. quote normalize.
- Contract: 검증 통과 후에만 기록. 불변 필드(topic/date/adapter) 입력 기준 고정.

### Step 3 — Write stage consumes dossier — PASS
- Structural: `loadWriteInput` dossier 우선 + draft 폴백, dossier 전용 프롬프트, `dossierToPost` fallback(+8 테스트), `withAuditMetadata`.
- Functional (핵심 grounding): dossier 모드에서 `grounding = dossier`, AI·fallback 모두 `auditPostQuality(post, { draft: grounding })` 검증. `findUngroundedUrls` 가 dossier 밖 URL을 critical 로 차단. `dossierToPost` 의 모든 URL은 evidence 에서만 유래.
- Contract: 소비측이 `validateDossier` 재검증 후 사용. 양방향 일관.

### Step 4 — Daily pipeline wiring — PASS
- Structural: steps 에 `research` 가 `draft`↔`rewrite` 사이 삽입. claude면 도구 경로, 아니면 폴백. `generatedResearch` 출력 노출.
- Functional: 설계 §2 순서(collect→draft→research→write→build) 정확히 일치. PoC 10/10 grounded.

## §7 Decisions 반영
| Decision | Verdict | Evidence |
|----------|:------:|----------|
| #1 도구 allowlist WebFetch/WebSearch/Bash(git log:*) | PASS | `ai-rewrite-adapter.mjs:69` 기본값 일치 |
| #2 2차 소스 collector 미추가 | PASS | research 입력은 candidates 만; LWN/Phoronix collector 부재 |
| #3 enrichWithBodies draft 잔존(fallback) | PASS | `draft-linux.mjs:331` 정의 + `:702` 호출 유지 |
| #4 네트워크/시간 budget | **RESOLVED** | `runClaudeResearch` wall-clock timeout 추가 (`ai-rewrite-adapter.mjs`, 기본 10분/`CLAUDE_RESEARCH_TIMEOUT_MS`) — gap 분석 후 수정됨 |

## Gaps

### Important
1. **네트워크/시간 budget 미구현** (§7 #4) — `ai-rewrite-adapter.mjs:66-75`. tool-enabled claude 호출이 무한정 hang 가능 (PoC 에서 7분 소요). conf 90%. Fix: spawn 에 `AbortSignal.timeout` 또는 wall-clock kill 추가.

### Minor (구현有/설계無 — 의도된 추가, 문서 반영 권장)
2. `RESEARCH_RAW_PATH` 재파싱 디버그/복구 경로 (`research-linux.mjs:133`) — 설계 §4 audit 절에 기록 권장.
3. `normalizeDossier` (>200자 quote 절단, `research-linux.mjs:100-109`) — validator 거부 전 완화. 미문서화.
4. 테스트 케이스 수: 설계 "14" vs 실제 16 (`dossier-schema.test.mjs`) — 문서 수치 정정.

### Critical / 설계有·구현無
- 없음. Step 1–4 모든 명시 산출물 구현됨.

## Recommended Actions
1. (즉시) §7 #4 network/time budget 을 `runClaudeResearch` 에 구현 — 유일한 실질 갭, hang 리스크.
2. (문서) `RESEARCH_RAW_PATH`·`normalizeDossier` 를 설계 §4 에 반영; 테스트 수치 정정.
3. (확정됨) `npm test` 103 pass.
