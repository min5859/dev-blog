# Todo — research/write 후속 4종

## 1. PDCA archive 후 커밋 ✅
- [ ] docs/archive/2026-06/research-write-split/ 에 analysis·report 이동 (설계 문서는 살아있는 스펙으로 docs/ 유지)
- [ ] _INDEX.md 작성, .bkit 상태 갱신
- [ ] 커밋

## 2. codex/cursor research 분기 후 커밋 ✅
- [ ] runResearchAdapterPrompt 에 codex/cursor 분기 추가 (claude 외에도 도구 조사 시도)
- [ ] template fallback 보존 확인, 테스트
- [ ] 커밋

## 3. 멀티토픽 확장 후 커밋 ✅
- [ ] research 를 토픽-범용 lib(research-runner.mjs)로 추출: claude 경로는 토픽 무관, deterministic 은 generic 빌더
- [ ] dossier-to-post 섹션 매핑 파라미터화
- [ ] 1개 추가 토픽(opensource)에 적용 + 테스트
- [ ] 커밋

## 4. 오늘 날짜 적용 + preview
- [ ] linux claude research+write 실제 운영 → publish → build
- [ ] 로컬 serve 로 사용자가 http://localhost:4321 에서 확인
