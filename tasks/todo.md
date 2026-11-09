# Todo

## 2026-11-08 — 커널 버전별 드라이버 영향 노트 (시험: v7.3 → v7.4-rc1)

목적: 드라이버 개발자가 새 버전에서 "내 드라이버가 깨지거나 고쳐야 할 것"을 한 페이지로 보게 한다.
원칙: 사실은 git에서 코드가 뽑고(웹·lore 접근 없음), AI는 뽑힌 커밋 문구만 한국어로 정리한다.

- [x] 커널 git 범위 수집: GitHub 미러 전체 이력(bare 5.6GB). `--shallow-exclude`는 범위를 15,388개로 잘못 계산해(실제 19,780개)
      경계 커밋 diff가 트리 전체로 나와 버려서 쓰지 않는다.
- [x] `scripts/collect-driver-impact.mjs` (Mac에서 약 11분): 커밋 18,591개·pull 258개 → 사라진 API 614개(드라이버 사용 127개),
      export 해제 24개(선언만 남음, 링크 실패), 헤더에 inline·매크로로 남은 export 18개는 제외, 드라이버 Kconfig 18개, 반복 전환 21건, 넓은 범위 7건
- [x] `scripts/draft-driver-impact.mjs` + `prompts/driver-impact-ko.md`: Cursor composer-2.5 ask 모드 1회(약 40초, 입력 101KB).
      AI 문장은 입력에 있는 id·이름만 인용해야 하고 백틱 이름이 입력에 없거나 글자가 깨지면 버린다. 최종 글은 `auditPostQuality` 통과.
- [x] 테스트: `scripts/driver-impact.test.mjs` 11개 포함 `npm test` 159개 통과
- [x] 로컬 build 미리보기: `content/topics/linux-driver-impact/posts/2026-11-02-linux-v7.4-rc1-driver-impact.json`
- [x] 사용자 확인(11/9): 공개 승인, OCI 자동 실행 승인, 중점 영역 = 메모리·V4L2·드라이버가 많이 쓰는 API(timer·workqueue·scheduler 등)

### 2단계 (11/9): 중점 API 영역 + OCI 자동 실행

- [x] 중점 영역 9개(메모리·DMA, V4L2·videobuf2·MC, 타이머, workqueue, 스케줄러·kthread·대기, IRQ, 락·RCU·cleanup,
      디바이스 모델·PM, clk·GPIO·regulator·regmap·reset·pinctrl): 범위 안에서 바뀐 영역 헤더를 두 태그에서 파싱해
      함수 시그니처 변경·삭제, 구조체 멤버 삭제·타입(콜백 시그니처) 변경, 매크로 인자 수 변경, 상수·extern 변수 삭제를 뽑는다.
      인자 이름만 바뀐 것·`#ifdef` stub·속성(`__must_check` 등)·영역 안 헤더 이동은 변화로 치지 않는다.
      개별 irqchip·clk 벤더 헤더는 잡음이라 뺐다. 새 이름은 함수·인자 있는 매크로·멤버만 남긴다.
- [x] 글에 "중점 API 영역" 섹션(영역별 AI 요점 + 변경 표 + 새 이름 + 관련 pull), 점검 명령·요약·AI 입력/검증(focusNotes)에 영역 추가
- [x] `scripts/run-driver-impact.mjs`: 커널 저장소 태그 fetch → 아직 글이 없는 새 `-rc1`·정식 태그 1개 처리(from = 직전 정식 릴리스)
      → status 기록. 저장소가 없으면 건너뜀. `daily-deploy.sh`의 lens 뒤에 실패 격리 단계로 추가. `docs/SCHEDULING.md`에 운영 설명
- [x] 테스트 4개 추가(헤더 파서, 헤더 비교, 새 태그 선택, 중점 영역 글) → `npm test` 163개 통과
- [x] 테스트·Mac 재수집(약 12분, 최대 RSS 1.0GB)·AI(Cursor ask 모드, 근거 검사 보강 후 최종본)·build 확인 → commit/push(공개)
- [x] OCI(11/9): `/srv/linux-kernel/linux.git` 전체 bare clone(wiki-publisher, GitHub 미러, 약 10분·6.5GB, 디스크 여유 71GB).
      `dev-blog.service`는 ProtectSystem이 없어 unit 수정 없이 쓸 수 있다. 서비스가 쉬는 동안 `pull --ff-only`로 `cd27e50` 반영.
      `run-driver-impact.mjs`는 태그 fetch 후 "no new -rc1 or release tag"로 1초에 끝났고 작업 트리는 그대로였다.
      OCI 수집기(v7.3..v7.4-rc1)는 4분 34초·최대 RSS 1.2GB, 결과 JSON sha256이 Mac과 같다.
- [x] 공개: GitHub Pages 배포(`cd27e50`) 성공, `posts/2026-11-02-linux-v7.4-rc1-driver-impact.html` 200 확인
- 다음 자동 실행: v7.4 정식 태그(비교 기준 v7.3), 그다음 v7.5-rc1(비교 기준 v7.4). 상태는 처리한 날만
  `logs/daily/linux-driver-impact-latest-status.json`에 남는다. OCI health check 스킬은 아직 이 토픽을 보지 않는다.

### 검토 (2단계)

- 헤더 비교 결과(v7.3 → v7.4-rc1): V4L2 `v4l2_subdev_pad_ops`의 `set_fmt`(v7.3 드라이버 214파일)·`get_selection`(84)·
  `set_selection`(47)에 `const struct v4l2_subdev_client_info *` 인자 추가, `device_show_string()` 인자 const화,
  `dma_opt_mapping_size()` → `dma_max_opt_mapping_size()`, `bus_type.need_parent_lock` 삭제 등 11개.
  timer·workqueue·sched·irq·locking·clk/GPIO 계열은 드라이버가 쓰던 API의 삭제·시그니처 변경이 없다.
- 메인테이너 pull 요약과 커밋 메시지가 `get_fmt`도 바뀌었다고 적었지만 실제 헤더에서 `get_fmt`는 그대로였다(커밋 diff로 확인).
  AI가 그 문구를 따라 틀린 문장을 써서, 바뀐 구조체의 그대로인 멤버(`unchangedMembers`)를 입력에 넣고
  그 멤버를 바뀐 멤버와 함께 언급한 AI 문장은 버리게 했다. 글에도 "요약과 표가 다르면 표가 맞다"를 적었다.
- AI가 새 이름 목록만 보고 `irqaction.thread_dtor`를 "드라이버 teardown 훅"으로 짐작해(실제는 genirq 내부 UAF 수정)
  새 이름 목록을 AI 입력에서 빼고 "용도는 근거 문구에 있을 때만" 규칙을 넣었다.
- 커밋 연결: 이름이 있는 줄은 그대로이고 인자 줄만 바뀐 콜백은 hunk 머리(구조체·함수)로 찾는다.

### 검토 (시험 결과)

- 첫 AI 결과에 "fl사/eject" 같은 깨진 토큰 2곳이 있어 검사를 추가했고, 재생성본은 AI 문장 102줄의 백틱 이름이 모두 입력에 있다.
- 사용 횟수는 v7.3 drivers/·sound/에서 그 이름이 나온 파일 수(정의 파일 제외)라 근사치다.
- 구조체 멤버 삭제나 함수 시그니처 변경은 직접 뽑지 않는다. 넓은 범위 커밋·반복 전환·pull 요약으로만 드러난다.

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
