# Gap Analysis — topic-dossier-first-rollout (PDCA #3)

- SSOT: docs/01-plan/features/topic-dossier-first-rollout.plan.md §3, docs/RESEARCH-WRITE-SPLIT.md
- Date: 2026-06-07
- **Match Rate: 94%** (Structural 100×0.2 + Functional 95×0.4 + Contract 90×0.4)

## SC 결과
| SC | Verdict | 근거 |
|----|:------:|------|
| SC-1 write-runner + linux/opensource 전환 | ✅ Met | write-runner.mjs runWrite, ai-rewrite-linux/opensource 호출 |
| SC-2 android | ✅ Met | research+프롬프트2+ai-rewrite(runWrite)+run-daily+scripts |
| SC-3 ai-coding-agents | ✅ Met | 동일 + research-runner 견고화(배열/객체, body) |
| SC-4 opensource-curation | ⚠️→✅(Act) | 배선 완비. dossier 경로 섹션이 큐레이션 정체성 상실 → Act 로 sectionPlan 파라미터화 |
| SC-5 lore-lens | ✅ Met | research-lore-lens <topic>, 렌즈 공용 프롬프트, pipeline 보존 |
| SC-0 회귀 | ✅ Met | npm test 115 pass |

## Critical (Act 대상)
- SC-4: opensource-curation 의 dossier write 가 linux 4섹션(릴리스/회귀/핵심변경/기타)으로 렌더돼 "이번 주 선정(큐레이션)" 정체성 상실. PICK_HEADING 은 draft fallback 에만 보존됨.
- 수정: dossierToPost 에 sectionOrder/sectionByImpact 파라미터화 + opensource-curation 이 큐레이션 섹션 주입 + from-dossier 프롬프트 섹션 교체.

## Act 후 상태
- dossierToPost sectionPlan 파라미터화로 토픽별 섹션 주입 가능. opensource-curation 큐레이션 섹션 복구.
