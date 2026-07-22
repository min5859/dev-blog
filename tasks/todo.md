# Todo — ai-rewrite JSON 파싱 실패 대응 (2026-07-22)

배경: logs/ai-rewrite-failures/ 128건 중 89건이 "AI response did not contain JSON".
원인: rewrite용 `claude -p`가 저장소 cwd에서 도구 제한 없이 실행되어, 기존 산출물을
발견하고 JSON 대신 자연어 보고를 반환. 7월 8일 급증은 저장소 변경 없이 발생 →
CLI 자동 업데이트/모델 별칭 드리프트가 유력.

## 1. 사전 검증 (runner) ✅
- [x] claude/codex/cursor CLI의 도구 제한·샌드박스 플래그 실지원 확인
- [x] .claude/settings*.json 권한 확인 (파일 쓰기 경위)
- [x] 테스트 환경 (package.json test, 기존 어댑터 테스트) 확인

## 2. 구현 (implementer 위임) ✅
- [x] runClaudeStdin: 격리 cwd(빈 임시 디렉터리) + 검증된 도구 차단 플래그 적용
- [x] runCodexExec: read-only 샌드박스 플래그 적용 (검증된 문법으로)
- [x] cursor: --mode=ask 유지, 필요 시 격리 보강 (변경 없음, 이미 읽기 전용)
- [x] runAiAdapterAndParse: attempt≥2에서 교정 지시("JSON 객체 하나만, 도구 사용 금지") 프롬프트에 추가
- [x] dumpFailedAiResponse: 헤더에 adapter/model/args 기록
- [x] CLAUDE_MODEL 기본값 별칭('sonnet') → 고정 모델 ID (rewrite 경로만)
- [x] 테스트: 교정 재시도 동작 단위 테스트 (options.runner 주입 활용)

## 3. 문서 ✅
- [x] SCHEDULING.md 기본 어댑터 표기 정정 (Cursor → claude)

## 4. 검증
- [x] 단위 테스트 통과 (`npm test` 117/117, ai-rewrite-adapter.test.mjs 14/14)
- [x] `--tools ""` + `claude-sonnet-5` 플래그 스모크 테스트 (에러 없이 JSON 반환 확인)
- [x] rewrite 단계 1회 실지 실행으로 JSON 파싱 성공 확인 (2026-07-22 rewrite:linux, attempt1 성공, 실패 덤프 증가 없음)

---
## 완료(아카이브): weekly-rollup-automation #1~#5
