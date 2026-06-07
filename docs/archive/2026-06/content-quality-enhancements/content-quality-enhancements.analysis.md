# Gap Analysis — content-quality-enhancements (PDCA #2)

- SSOT: `docs/01-plan/features/content-quality-enhancements.plan.md` §3, `docs/RESEARCH-WRITE-SPLIT.md` §4
- Date: 2026-06-06
- **Match Rate: 98%** (Structural 100×0.2 + Functional 96×0.4 + Contract 100×0.4)
- Critical: 0

## SC 결과 (전부 Met)
| SC | Verdict | 근거 |
|----|:------:|------|
| SC-A 인용 노출 | Met | `dossier-to-post.mjs:55-66` firstQuote→`> quote`; render `build-site.mjs:76` marked + `:665` blockquote CSS; 프롬프트 2종 |
| SC-B 모델 분리 | Met | `ai-rewrite-adapter.mjs` CLAUDE/CURSOR/CODEX_RESEARCH_MODEL 우선, write 는 기존 모델 유지 |
| SC-C 교차검증 | Met | `research-runner.mjs` verifyDossier/urlContainsQuote, all-unverified→confidence 강등+openQuestions, best-effort, RESEARCH_VERIFY 게이트, deterministic skip |
| SC-D 변화중심 | Met | loadSeenCandidateIds(부재 graceful)+seenBefore 마킹, 신규우선 정렬, 라벨, 프롬프트 |
| SC-E 주간롤업 | Met | weekly-rollup.mjs collectWeeklyDossier 7일 dedup(최신)+선별, 빈 graceful, script+test+npm |
| SC-0 회귀 | Met | `npm test` 109 pass |

## Gaps (Important, Critical 0)
- 신규 동작 단위테스트 부재: A(`> quote` 렌더), C(downgrade), B(모델 precedence). → Act 에서 보강.
- 구현有/설계無(경미): dossier 부가 필드 `verified`/`*Count`/`rollup` 미문서화(telemetry, 무해).

## Act 완료
- 테스트 6개 추가로 Important gap 해소: dossier-to-post 에 quote 렌더(A)·seenBefore 라벨/신규우선(D) 2건, research-runner 에 verifyDossier 강등/유지/스킵/best-effort(C) 4건. `npm test` 115 pass.
