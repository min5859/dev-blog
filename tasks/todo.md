# Todo — content-quality-enhancements (PDCA #2)

Plan: docs/01-plan/features/content-quality-enhancements.plan.md
구현 순서: B → A → D → C → E. 각 단계 독립 커밋.

## B. research/write 모델 분리
- [ ] CLAUDE_RESEARCH_MODEL (+ CODEX/CURSOR) 추가, write 는 기존 모델 유지
- [ ] 문서화, 커밋

## A. 원문 인용 노출
- [ ] dossierToPost 가 evidence.quote 를 blockquote 로, write 프롬프트도 인용 지시
- [ ] build-site blockquote 렌더 확인
- [ ] 커밋

## D. 어제 대비 변화만
- [ ] research-runner 가 어제 dossier 로드 → 동일 candidateId 에 seenBefore 표시
- [ ] write 가 변화 중심 강조
- [ ] 커밋

## C. dossier 교차검증
- [ ] research-runner verify: evidence.url 재fetch → quote 부분일치 확인, 실패 시 confidence 강등 + openQuestions
- [ ] 커밋

## E. 주간 롤업
- [ ] 최근 7일 dossier 모아 핵심만 재작성 (weekly write)
- [ ] 커밋

---
## 이전 사이클 (research-write-split, 완료·archived)
1~4 ✅ + claude/codex/cursor 웹검색 검증 + extractJsonObject 버그수정
