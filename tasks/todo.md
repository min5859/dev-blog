# Todo

## 2026-08-09 — Cursor Composer 2.5 첫 자동 실행 확인

대상: 2026-08-09 03:00 KST에 실행되는 `com.user.dev-blog.daily` LaunchAgent.
목적: 공통 AI provider config와 `composer-2.5` 모델로 변경한 뒤 첫 무인 실행이
수집 → research → rewrite → publish → 자동 커밋/푸시까지 정상 완료되는지 확인.

### 실행 및 환경

- [ ] 03:00 이후 LaunchAgent가 실행됐고 종료 코드가 0인지 확인:
  `launchctl print gui/$(id -u)/com.user.dev-blog.daily`
- [ ] 로드된 `PATH`가 Node v24.18.0 및 `~/.local/bin`을 포함하고, provider 전용
  환경 변수(`CLAUDE_BIN`, `CODEX_BIN`, `CURSOR_AGENT_BIN`)가 없는지 확인.
- [ ] LaunchAgent 환경에서 Cursor 로그인이 유지되는지 확인:
  `env -i HOME="$HOME" PATH="<LaunchAgent PATH>" agent status`
- [ ] `config/ai-provider.json`의 provider가 `cursor`, research/rewrite 모델이 모두
  `composer-2.5`인지 확인.

### 파이프라인 결과

- [ ] `logs/daily/launchd.log`에서 인증 실패, 모델 미지원, timeout, JSON 파싱 실패,
  source collection 실패가 없는지 확인.
- [ ] 11개 파이프라인(Linux, Android, Open Source, Open Source Curation,
  AI Coding Agents, Linux lens 6종)의 `*-latest-status.json`이 2026-08-09 실행을
  가리키고 필요한 단계가 성공했는지 확인.
- [ ] `content/topics/*/posts/`에 2026-08-09 콘텐츠가 생성됐고, 제목·요약·본문이
  비어 있지 않으며 한국어 품질과 기술적 정확성이 기존 콘텐츠보다 저하되지 않았는지 표본 확인.
- [ ] `logs/ai-rewrite-failures/`에 새 Composer 2.5 실패 덤프가 생기지 않았는지 확인.

### 게시 및 사용량

- [ ] `daily: 2026-08-09 briefing` 자동 커밋이 생성되어 `origin/main`에 푸시됐는지 확인.
- [ ] GitHub Pages workflow가 성공했고 새 콘텐츠가 웹에서 열리는지 확인.
- [ ] Cursor dashboard에서 11개 파이프라인의 사용량을 확인해 기존 고성능 모델 대비
  일일 사용량이 운영 가능한 수준인지 기록.

### 문제 발생 시

- [ ] 전체 파이프라인을 바로 재실행하지 말고 실패한 topic과 단계부터 특정해 재실행.
- [ ] 인증 실패면 LaunchAgent 환경의 `agent status`를 먼저 확인.
- [ ] 모델 오류면 `agent models | rg '^composer-2\.5'`로 모델 제공 여부 확인.
- [ ] JSON 오류면 최신 failure dump의 adapter/model/raw 응답을 확인하고 prompt/parser
  문제인지 모델 품질 문제인지 구분.
- [ ] 당일 게시가 반드시 필요하고 Cursor 장애가 지속되면
  `DAILY_REWRITE_ADAPTER=template`을 일회성 fallback으로 사용.
- [ ] 수정이 필요하면 원인, 영향받은 topic, 재실행 범위, 검증 결과를 이 문서와
  `CHANGELOG.md`에 기록.

### 완료 조건

- [ ] 11개 파이프라인 결과, 자동 커밋·푸시, Pages 배포, Composer 2.5 콘텐츠 품질과
  사용량을 모두 확인하고 이 섹션을 완료 처리.

---

## 완료 — ai-rewrite JSON 파싱 실패 대응 (2026-07-22)

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
