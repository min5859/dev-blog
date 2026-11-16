# Todo

## 2026-11-16 — 드라이버 영향 노트: 모듈별 표(영향 | 기존 | 변경 | 주요 설명)

배경: 접는 구조로 바꾼 뒤에도 "너저분하고 변경점이 한눈에 안 들어온다, 뉴비도 쉽게 파악하면 좋겠다"는 피드백.
실측: 릴리스 글 본문의 18~19%가 글마다 같은 설명문, 21~39%가 항목 머리줄의 부가정보(변화 종류·사용 수·영어 커밋 제목)였고,
"왜 바뀌었는지"가 적힌 항목은 10~30%뿐이었다.

- [x] 본문을 모듈마다 표 하나로. 설명문·"먼저 볼 것"·사용 파일 수는 본문에서 뺐다. 기준 설명은 글 끝 신뢰도 안내에만.
- [x] 영향 열: 코드가 시그니처로 가른다(빌드 실패 / 확인 필요 / 그대로 빌드). 빌드 실패가 위로 온다.
- [x] 기존·변경 칸에서 바뀐 부분만 굵게, 긴 시그니처는 그대로인 인자를 `…`로. 같은 커밋의 같은 차이는 한 행으로 묶는다.
- [x] 모든 행에 AI 설명(왜 바뀌었고 무엇을 하면 되는지). LTS는 이름 40개씩 나눠 묻는다.
- [x] 고친 예: 그 커밋이 트리 안 드라이버의 호출부를 고친 줄을 수집기가 뽑아 표 아래에 접어 둔다.
      호출부 예가 모두 같은 이름으로 바꿨으면 변경 칸에 새 이름(`del_timer_sync()` → `timer_delete_sync()`).
- [x] 용어 풀이(hover) 20개 추가: V4L2, videobuf2, subdev, dma-buf, GPIO, clk, pinctrl, regmap, I2C, fwnode, LTS 등.
- [x] 정확성: `unsigned`와 `unsigned int`를 같은 타입으로(v7.1 `parse_args`), 같은 이름을 스스로 `#define`한 드라이버의 사용은
      세지 않음(v7.1 `PRIV`·`to_dev_attr`), 벤더가 정의하고 한 벤더의 미디어 드라이버만 쓰던 것은 표에서 제외(v7.2 `tegra_powergate_*`),
      지워진 멤버가 옮겨 간 곳으로 그대로인 멤버를 든 AI 문장은 버리지 않음(v7.2 `device.offline` → `flags`).
- [x] 수집 형식 3(고친 예, 매크로 사용 수 수정)으로 여섯 범위 재수집. 수집은 세션과 분리해(setsid) 스냅숏 수집기로 돌렸다.
- [x] 글을 만들어 읽으며 고친 것: "여러 서브시스템이 쓴다"는 코어가 정의한 이름에만 적용(v7.1 `include/net/atmclip.h`의 `PRIV`),
      장치·벤더 전용 미디어 헤더는 사용처를 봄(v7.2 `LM3560_*`, `vsp1_du_setup_lif`), "받도록"만 보고 설명을 버리던 가드를 지시하는 말끝으로 좁힘,
      pull 요약의 id를 영역 id로 쓰던 것을 프롬프트에서 바로잡음(v7.4-rc1에서 API 밖의 변화가 통째로 빠졌다), 숫자형 인자끼리의 변경은 그대로 빌드.
- [x] 릴리스 글 네 편(v7.1, v7.2, v7.3, v7.4-rc1) 게시(`eddca8e6f`, 11/16). 표의 행 8·6·5·5개 모두에 설명이 붙었고,
      펼치기 전 본문은 2,377·2,107·1,904·2,049자(직전 구조는 4,500~5,800자).
- [x] LTS 글에서 설명이 다른 커밋의 것이던 행 발견(v6.18 `gpio_chip.set`, `clk_divider.flags`). 같은 줄을 여러 커밋이 건드릴 때
      "마지막으로 건드린 커밋" 대신 "새 타입의 토큰을 처음 들인 커밋"을 고르도록 수집기를 고치고(`changeCommit`) LTS 두 범위를 다시 수집.
- [x] LTS 두 편 게시(11/16). 6.6 → 6.12는 표 58행 중 55행, 6.12 → 6.18은 48행 중 43행에 설명. 펼치기 전 본문 9,921자·7,654자
      (직전 구조는 19,259자·16,364자). 재수집으로 `gpio_chip.set`은 콜백 이름을 되돌린 커밋, `clk_divider.flags`는 플래그를 더한 커밋에 붙었다.

## 2026-11-14 — 드라이버 영향 노트: 독자 프로필과 접는 구조

배경: 글이 37K~91K자라 사람이 읽기 어렵다는 피드백. 주 독자는 Exynos 카메라(V4L2) 드라이버 담당.
원칙: 독자의 드라이버가 쓰던 것만 펼치고 나머지는 접는다. 지우지는 않는다. 한 이름은 한 곳에만 나온다.

### 1단계: 정확성

- [x] 여러 줄 `#define` 본문의 `EXPORT_SYMBOL_FOR_MODULES(symbol, ...)`을 export로 읽던 오탐(v7.1·v7.2 `sym`, v7.3 `symbol`).
      C 소스는 `;`로 끝나는 줄만 export 문장으로 본다. 들여쓴 진짜 export(s390 ctcm)와 `.S`의 `;` 없는 export는 유지.
- [x] 멤버를 감싼 매크로(`__SYSFS_FUNCTION_ALTERNATIVE`, `struct_group`)의 안쪽 선언을 멤버로 파싱.
      v7.3 `kobj_attribute.show`·`store`는 기존 타입도 그대로 받는데 "멤버 타입 변경(사용 20)"으로 잡혀 "먼저 볼 것"에 올랐다.
- [x] 점검 명령 상한 제거. 상위 150개만 넣고 "나머지는 점검 명령에"라고 써서 v6.12 → v6.18 글 745개, v6.6 → v6.12 글 667개,
      v7.1 글 100개가 어디에도 없었다. 이름 목록은 `git grep -nwF -f - <<'EOF'` 형태로 모두 넣는다.
- [x] 문서 커밋 목록에서 오타·링크·담당자 변경 제외.
- [x] 사라진 구조체의 사용 수는 `struct 이름`으로 쓴 파일만 센다. 이름만 맞추면 v7.3 EFS 삭제의 `partition_table`이
      같은 이름의 무관한 변수 때문에 드라이버 3곳 "사용"으로 나왔다.

### 2단계: 수집기와 프로필

- [x] 수집기가 이름마다 사용 파일(`users`)을, 전환마다 건드린 디렉터리(`dirNames`)를 남긴다(`schema: 2`). 옛 형식은 자동 재수집.
- [x] `config/driver-impact.json` 프로필(카메라 + Exynos 플랫폼, arm64). 키워드가 아닌 드라이버 경로 정규식으로 가른다.
      실측(v7.3 → v7.4-rc1): 드라이버가 쓰던 삭제 API 127개 중 프로필 드라이버가 쓰던 것 2개, 5개 이상 서브시스템이 쓰는 것 1개.
      미디어 경로는 "같은 종류의 드라이버"를 대신하는 넓은 경로(`proxy`)라, 다른 벤더 드라이버가 정의하고 파일 하나만 쓰던 export
      (v6.18 `cmdq_pkt_finalize` 등)는 세지 않는다. ACPI·x86 플랫폼이 정의한 것(`foreignSources`)은 접는다.
- [x] 중점 영역 추가: I2C·SPI·I3C, IOMMU·IOVA, 전원 도메인·PM QoS·OPP·devfreq·interconnect, PHY, (프로필) Samsung SoC 헤더.
      `include/media`의 리모컨·CEC·DVB·튜너는 V4L2 영역에서 분리.

### 3단계: 글 구조

- [x] 먼저 볼 것(AI, 3~5줄) → 프로필 관점(펼침: 이름마다 이전·이후 시그니처와 할 일) → 여러 서브시스템이 쓰는 API(펼침)
      → 트리 전체 참고(접음) → 점검 명령(접음). 같은 구조체의 멤버는 한 덩어리, 같은 커밋이 셋 이상 지운 이름은 한 줄.
- [x] AI 출력에서 영역별 요점(`focusNotes`) 제거, 이름별 한 문장(`apiNotes`)으로 통일. 프로필과 가까운 것(`mine`)을 입력 앞에 둔다.
- [x] AI 가드 추가: 입력에 없는 영향·할 일("영향을 줄 수 있다", "점검한다"), 이름 변경 후보만 근거로 한 "대체한다"는 버린다.
      계기: v7.3 글의 "GPIOLIB_LEGACY 선택이 필요한 조합"(실제 `def_bool y`), v7.4-rc1 `fd_prepare_fd` → `__FD_PREPARE`(대체 아님).
- [x] 반환형만 바뀐 함수는 "반환형 변경"으로 따로 표시하고, `void` → 값·`int` → `bool`이면 "기존 호출은 그대로 빌드된다"를 붙인다.
      이런 변화를 고치라고 쓴 AI 문장은 버린다(v6.18 `v4l2_ctrl_handler_free()`가 "반환값을 받도록 고친다"로 헤드라인에 올랐다).
- [x] AI가 입력을 가리키는 말("메시지에 적힌 대로 …", v7.3 글에서 3건)은 버리고, 대체 이름만 준 답은 "대신 쓸 것: `이름`"으로 바꾼다
      (그 이름이 커밋 제목·본문에 있을 때만).
- [x] 전환(넓은 범위 변경·반복 패턴)은 프로필 디렉터리를 많이 건드린 순으로, 반복 패턴은 세 곳 이상에서 되풀이된 것만 위에 둔다.
- [x] 펼친 목록에서도 한 커밋이 셋 이상 지운 이름은 한 덩어리로 묶는다(v7.2: 헤더 하나를 지운 커밋의 `LM3560_*` 매크로 13개).
- [x] LTS 구간의 AI 입력 축소: pull은 프로필 pull + 드라이버 pull 20개 + 바뀐 영역마다 2개, 커밋 본문은 6만 자까지(넘으면 제목만).
      v6.12 → v6.18 입력 372KB → 162KB.
- [x] AI 원본을 글의 `draftMetadata.aiNotes`에 남겨 `--reuse-notes`로 AI 없이 다시 만들 수 있게 함. `--out`으로 게시 전 미리보기.
- [x] 사이트 CSS: `.md-content details` 테두리·커서, 접힌 표의 가로 스크롤(`scripts/build-site.mjs`).

### 4단계: 검증

- [x] `npm test` 173개 통과(드라이버 영향 25개).
- [x] v7.3 → v7.4-rc1 재수집(OCI 4분 19초, 최대 RSS 1.2GB) + AI 1회(약 40초) → 미리보기 빌드.
      렌더링된 본문 글자: 게시본 30,498자 → 펼치기 전 5,596자(접힌 블록 8개).
- [x] v6.12 → v6.18 LTS 재수집(15분 31초, 최대 RSS 2.1GB) + AI 1회(약 50초).
      게시본 74,619자 → 펼치기 전 16,268자(접힌 블록 9개). 프로필 관점 변경 33건, 여러 서브시스템이 쓰는 변경 32건, 점검 명령에 895개 이름 전부.
- [x] 사용자 확인(11/16) 후 게시된 글을 새 구조로 다시 만들어 덮어씀: v7.1, v7.2, v7.3, v7.4-rc1, LTS 6.12 → 6.18.
      v7.4-rc1과 LTS 6.12 → 6.18은 미리보기로 확인한 AI 문장 그대로, 나머지 셋은 AI 새로 실행 후 문장 검토.
      펼치기 전 본문: v7.1 5,800자, v7.2 5,732자, v7.3 4,487자, v7.4-rc1 5,596자, LTS 6.12 → 6.18 16,268자.
- [x] 글 도입부와 토픽 설명에 "트리 밖 드라이버를 본 것이 아니라 메인라인의 같은 종류 드라이버로 가늠한 것"임을 밝힘.
- [x] LTS 6.6 → 6.12 글 다시 만들기(수집이 길어 세션과 분리해 실행, 기록은 `logs/daily/driver-impact-regen.log`).

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
