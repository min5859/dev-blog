# Todo — topic-dossier-first-rollout (PDCA #3)

Plan: docs/01-plan/features/topic-dossier-first-rollout.plan.md
순서: write-runner → linux/opensource 리팩터 → android → ai-coding-agents → opensource-curation → lore-lens. 각 단계 커밋.

## 1. write-runner 추출 + linux/opensource 리팩터
- [ ] scripts/lib/write-runner.mjs (dossier 우선 입력 + AI/fallback + validate + audit + 저장)
- [ ] ai-rewrite-linux/opensource 를 runner 사용으로 전환 (산출 동일)
- [ ] 테스트, 커밋

## 2. android dossier-first ✅
- [ ] research-android.mjs + 프롬프트 2 + ai-rewrite dossier + run-daily research + scripts
- [ ] 커밋

## 3. ai-coding-agents dossier-first
- [ ] 동일 레시피, 커밋

## 4. opensource-curation dossier-first
- [ ] 동일 레시피, 커밋

## 5. lore-lens dossier-first (topic 인자형)
- [ ] research-lore-lens.mjs <topic> + 렌즈 공용 프롬프트 2 + ai-rewrite/run-daily 배선
- [ ] 커밋

---
## 이전 사이클 (완료)
- research-write-split (PDCA #1, archived)
- content-quality-enhancements A~E (PDCA #2)
