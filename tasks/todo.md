# Todo — weekly-rollup-automation (PDCA #5)

Plan: docs/01-plan/features/weekly-rollup-automation.plan.md

## 1. weekly-rollup 발행 경로 ✅
- [ ] weekly-rollup.mjs PUBLISH_WEEKLY=1 → content/topics/{topic}/posts/ 발행 + assertPost 동급 검증
- [ ] build 렌더 호환 확인, 커밋

## 2. 일괄 스크립트 + 스케줄 통합
- [ ] scripts/run-weekly-all.mjs (전 토픽 + lens) + npm weekly-rollup:all
- [ ] daily-deploy.sh 월요일 블록에 run-weekly-all 추가
- [ ] 커밋

---
## 완료: #1~#4 (archived/완료)
