# Changelog

이 파일은 Dev Blog의 운영 및 기능 변경 사항을 날짜별로 기록합니다.

## 2026-08-08

### AI provider 및 실행 구조

- 만료된 Claude 구독 경로 때문에 실패하던 AI research/rewrite를 복구하기 위해
  Codex CLI 어댑터를 보강하고 전체 일일 파이프라인을 재실행했습니다
  (`2843b78`, `1b13e6e`).
- 매일 실행 시 Codex 토큰 사용량이 큰 점을 고려해 최종 기본 provider를 Cursor
  Agent CLI로 변경했습니다.
- 매일 실행하는 Cursor research/rewrite 기본 모델을 비용 효율적인
  `composer-2.5`로 설정했습니다.
- Claude, Codex, Cursor, deterministic template 중 기본 provider를
  `config/ai-provider.json` 한 곳에서 선택하도록 통합했습니다. 환경 변수
  `AI_ADAPTER`와 `DAILY_REWRITE_ADAPTER`는 일회성 override로만 사용합니다.
- 특정 topic에 남아 있던 provider 고정을 제거해 모든 daily/research/rewrite
  경로가 동일한 기본 설정을 따르도록 정리했습니다.

### 스케줄링 및 문서

- LaunchAgent와 `scripts/daily-deploy.sh`를 provider 중립적으로 정리했습니다.
  하나의 공통 daily job이 설정된 provider를 사용하며, provider별 스케줄러는
  존재하지 않습니다.
- README와 운영 문서가 특정 provider를 기본값으로 반복 설명하지 않고
  `config/ai-provider.json`을 참조하도록 변경했습니다.
- LaunchAgent가 과거 Node v24.14.0의 Codex 0.141.0을 찾던 원인은 대화형 셸과
  별도로 고정된 `PATH`였습니다. 현재 운영 경로는 Node v24.18.0과 공통 AI CLI
  경로를 사용하도록 정리했습니다.

### 파이프라인 복구 및 검증

- 2026-08-08 기준 Linux, Android, Open Source, Open Source Curation,
  AI Coding Agents 및 Linux lens 6종 등 총 11개 일일 파이프라인을 재실행해
  콘텐츠와 상태 파일을 생성하고 GitHub에 게시했습니다.
- Cursor 로그인을 확인하고 비대화형 JSON 호출을 검증했습니다.
- 전체 테스트 128개와 정적 사이트 빌드를 통과했습니다.
