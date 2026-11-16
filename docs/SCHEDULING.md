# Scheduling

## GitHub API 토큰

오픈소스 토픽(`collect-opensource.mjs`)과 오픈소스 큐레이션(`discover`·`fetch`)은 GitHub API를
부른다. 토큰이 없으면 서버 IP 기준 시간당 60회(검색 분당 10회)라 같은 실행의 다른 단계와 한도를
나눠 쓰다 403을 받는다(2026-11-12 큐레이션 README 0개 실패). `daily-deploy.sh`는
`GITHUB_TOKEN`이 없을 때 `~/.config/dev-blog/github-token`(실행 계정 소유, 600)을 읽는다.

- 토큰은 권한 없는 fine-grained 토큰(Public repositories read-only)만 쓴다. 서버에서 AI 단계가
  같은 계정으로 돌기 때문에 쓰기·관리 권한이 있는 토큰은 두지 않는다.
- 파일이 없으면 토큰 없이 실행한다. 큐레이션 `fetch`는 404가 아닌 실패를 `HTTP <status>`로 남긴다.

## 커널 버전별 드라이버 영향 노트

`daily-deploy.sh`는 일일 토픽 뒤에 `scripts/run-driver-impact.mjs`를 실행합니다.
OCI의 커널 전체 이력 bare 저장소 `/srv/linux-kernel/linux.git`(wiki-publisher 소유,
약 6GB, GitHub `torvalds/linux` 미러)의 태그를 fetch해, 글이 아직 없는 새 `-rc1`이나
정식 태그가 있으면 하나만 처리합니다. 비교 기준은 그 태그 직전의 정식 릴리스입니다
(`v7.4-rc1`과 `v7.4` 모두 `v7.3`부터).

- 처리: collect(git만 사용, 웹·lore 없음) → draft(Cursor ask 모드 1회) → build.
  게시는 다른 토픽과 같이 `daily-deploy.sh`의 commit/push가 합니다.
- 상태: 태그를 처리한 날만 `logs/daily/linux-driver-impact-latest-status.json`을 씁니다.
  새 태그가 없는 날은 fetch만 하고 상태를 바꾸지 않습니다.
- 실패: 재시도하지 않고 다음 날 다시 시도합니다. 수집 결과
  (`data/raw/driver-impact/<from>..<to>.json`)가 있으면 수집은 건너뜁니다.
- 저장소가 없는 환경(Mac)에서는 아무것도 하지 않습니다. 첫 글이 없으면 가장 최근 태그 하나만
  만들고 과거를 소급하지 않습니다.
- LTS: 새 태그가 없는 날 kernel.org `releases.json`(버전 목록만)에서 가장 최근 두 longterm을 보고,
  그 LTS → 다음 LTS 노트가 없으면 만듭니다(예: 2026년 LTS가 지정되면 `v6.18..<새 LTS>`). LTS 글은
  `draftMetadata.kind: "lts"`로 구분해 일반 태그 추적에 넣지 않습니다. 목록을 못 읽으면
  `[driver-impact] LTS list unavailable`을 남기고 다음 날 다시 봅니다.
- `사용` 수: 이름은 그 단어가 나온 파일 수, 구조체 멤버는 `struct <이름>`이 나오고 `->멤버`·`.멤버`로
  접근하는 파일 수입니다. 이름만 맞추면 흔한 멤버가 부풀었습니다(v7.3 `module.args` 811, 실제 0 → 6).
- 시그니처 변경에서 호출부가 그대로 빌드되는 것은 뺍니다: 가변 인자 매크로와 고정 인자 사이
  (v7.2 `kmalloc(...)` → `kmalloc(size, flags)`), 한쪽에만 붙거나 빠진 `__` 속성(`__jiffy_arch_data`, `__iomem`).
  export 네임스페이스는 따옴표를 떼고 비교합니다(6.13의 `NS(CXL)` → `NS("CXL")` 표기 전환이 1,300여 건으로 잡혔습니다).
- 수동 실행: `node scripts/collect-driver-impact.mjs --repo <linux.git> --from v7.3 --to v7.4-rc1`,
  `node scripts/draft-driver-impact.mjs --from v7.3 --to v7.4-rc1` (LTS 노트는 `--lts`를 붙입니다).
- 글의 구조: 본문은 모듈마다 표 하나(영향 | 기존 | 변경 | 주요 설명)이고 설명문을 두지 않습니다. 모듈은 헤더·소스 경로로 가르며
  (`MODULES`: V4L2, videobuf2, DMA·dma-buf, 메모리, GPIO, clk, 타이머, 스케줄러 …) 바뀐 것이 있는 모듈만 나옵니다.
  - 영향은 코드가 시그니처만 보고 가릅니다(`impactOf`). 삭제·인자 수나 타입 변경·콜백 멤버의 타입 변경은 **빌드 실패**,
    반환형만 `void` → 값·`int` → `bool`로 바뀌었거나 인자에 바깥 `const`만 붙었거나 숫자형 인자가 다른 숫자형이 된 것은 그대로 빌드,
    콜백이 아닌 멤버의 타입·export의 라이선스 변경처럼 가를 수 없는 것은 확인 필요입니다. AI는 이 판정에 끼지 않습니다.
  - 기존·변경 칸은 바뀐 부분만 굵게 쓰고, 긴 시그니처는 그대로인 인자를 `…`로 줄입니다. 같은 커밋의 같은 차이(같은 인자 추가 등)는 한 행으로 묶습니다.
  - 주요 설명은 AI가 그 커밋의 제목·본문에서 "왜 바뀌었고 무엇을 하면 되는지"를 한두 문장으로 씁니다. 가드에 걸리면 커밋 제목 링크로 대신합니다.
  - 표 아래 "고친 예"는 그 변화를 넣은 커밋이 트리 안 드라이버의 호출부를 고친 줄입니다(수집기가 뽑습니다). 콜백 멤버는 이름이 호출부에
    나오지 않아 예가 없습니다. 호출부 예가 모두 같은 이름으로 바꿨으면 변경 칸에 새 이름을 씁니다(같은 커밋이 더한 이름만으로는 대체라고 하지 않습니다).
  - 변화가 30건을 넘는 글(LTS)은 그대로 빌드되는 행을 모듈마다 접고, 행이 12개 이상이면 맨 위에 모듈별 건수 색인을 둡니다.
  - 독자와 먼 변화, Kconfig, 메인테이너 요약, 점검 명령은 맨 아래 "참고"에 접습니다. 무엇을 기준으로 골랐는지는 글 끝의 신뢰도 안내에만 적습니다.
- 독자 프로필: `config/driver-impact.json`의 `profile`이 "누구의 드라이버 관점에서 읽는가"를 정합니다(지금은 카메라·Exynos).
  독자의 드라이버는 트리 밖(사내)에 있어 직접 보지 못합니다. 메인라인에 있는 같은 종류의 드라이버(미디어 드라이버 전체와
  Samsung SoC 플랫폼 드라이버)가 그 이름을 썼는지로 가늠하고, 정확한 대조는 글의 점검 명령을 사내 소스에서 돌려서 합니다.
  `groups[].paths`는 트리 안 드라이버 경로 정규식이고, 수집기는 바뀌거나 사라진 이름마다 이전 버전에서 그 이름을 쓴 드라이버
  파일(`users`)을 남깁니다. 표에는 프로필 경로의 드라이버가 쓰던 것(`primaryAreas` 영역은 사용처와 관계없이 전부)과 드라이버 서브시스템
  `genericSubsystems`곳 이상이 쓰던 것만 올리고 나머지는 접습니다. `arch`에 없는 `arch/*`나 `foreignSources`(ACPI 등)가 정의한 것도 접습니다.
  키워드가 아닌 경로로 가르는 이유는 `samsung` 같은 키워드가 패널·노트북 드라이버까지 잡기 때문입니다.
  `proxy: true`인 그룹은 "같은 종류의 드라이버"를 대신하는 넓은 경로라, 벤더가 정의하고 한 벤더의 드라이버만 쓰던 것은 세지 않습니다.
- 프로필의 `extraAreas`는 헤더를 비교할 영역을 더합니다(수집 단계에서 쓰이므로 바꾸면 다시 수집합니다). `groups`·`pulls`만
  바꾼 경우는 다시 수집하지 않고 `draft`만 다시 돌리면 됩니다.
- 수집 결과에는 `schema`가 있고(`RAW_SCHEMA`), 옛 형식이면 `run-driver-impact.mjs`가 다시 수집합니다.
- 다시 만들기: `--reuse-notes`는 게시된 글의 `draftMetadata.aiNotes`(AI 원본)를 다시 써서 AI 호출 없이 표현·구조만 바꿉니다.
  `--out <dir>`는 글을 `content/` 밖에 써서 게시 전에 확인합니다(`daily-deploy.sh`는 `content/`를 통째로 게시합니다).
  미리보기 사이트는 `content/topics/linux-driver-impact/`만 복사한 디렉터리에서 `node <repo>/scripts/build-site.mjs`로 만듭니다.
- 변화가 많은 범위(LTS)는 AI 호출을 이름 40개 안팎씩 나눕니다(`splitAiInput`). pull 요약은 첫 호출에만 묻습니다.
- 점검 명령은 줄이지 않습니다. 표는 상한이 있어도 명령에는 드라이버가 쓰던 이름이 모두 들어갑니다
  (예전에는 상위 150개만 넣어 v6.12 → v6.18 글에서 745개가 빠졌습니다).
- 구조체 멤버는 명령에 구조체 이름만 들어가므로, 어느 멤버가 바뀌거나 사라졌는지는 "구조체별로 바뀌거나 사라진 멤버"에 모두 적습니다.
- Samsung SoC 헤더(`samsung-soc`)도 `primaryAreas`라서 사용처와 관계없이 표에 올립니다.
- 설명 칸은 일일 파이프라인과 달리 `config/ai-provider.json`의 `adapters.cursor.driverImpactModel`(지금 `claude-sonnet-5-5-medium`)로 씁니다.
  릴리스마다 한두 번만 부르고 검토 없이 게시되기 때문입니다. 한 번만 다른 모델로 돌리려면 `CURSOR_MODEL`을 줍니다.
- AI 문장 가드(`cleanNotes`): 입력에 없는 이름, 헤더 비교와 어긋나는 멤버, 입력에 없는 영향·할 일("영향을 줄 수 있다", "점검한다"),
  이름 변경 후보(`renamedTo`)만 근거로 한 "대체한다", 그대로 빌드되는 변화를 고치라고 쓴 문장, 입력을 가리키는 말("메시지에 적힌 대로")은
  버립니다. 대체 이름만 준 답은 "대신 쓸 것: `이름`"으로 바꿉니다.
- 수집 오탐 메모: 여러 줄 `#define` 본문의 `EXPORT_SYMBOL_FOR_MODULES(symbol, ...)`은 export가 아닙니다(v7.1·v7.2 `sym`, v7.3 `symbol`).
  멤버를 감싼 매크로(`__SYSFS_FUNCTION_ALTERNATIVE(...)`, `struct_group(...)`)는 안쪽 선언을 멤버로 봅니다
  (v7.3 `kobj_attribute.show`는 기존 타입도 그대로 받는데 타입 변경으로 잡혔습니다). `unsigned`와 `unsigned int`는 같은 타입입니다
  (v7.1 `parse_args`). 사라진 매크로와 같은 이름을 스스로 `#define`한 드라이버의 사용은 세지 않습니다(v7.1 `PRIV`, `to_dev_attr`).
  사라진 구조체는 `struct 이름`으로 쓴 파일만 셉니다(v7.3 `partition_table`).

## 후보가 없는 Linux lens 토픽

6개 Linux lens는 수집과 draft가 성공했지만 `candidates-latest.json`의 후보가
0개이면 research/rewrite/publish를 실행하지 않습니다. 빈 게시물은 만들지 않고
기존 콘텐츠를 유지하며, build는 계속 실행합니다.

성공 상태에 `publicationSkipped: true`, `skipReason: "no_candidates"`를 기록하고
해당 단계에도 `skipped: true`를 남깁니다. 정상 종료(exit 0)이므로 `daily-deploy.sh`의
재시도 대상이 아닙니다. 홈페이지 상태 카드에는 게시 생략 토픽을 별도로 표시합니다.

HTTP/네트워크 실패, HTML 차단 응답, 불완전한 Atom feed, 잘못된 후보 파일은 오류로
유지합니다. 단순히 수집 건수가 0이라고 네트워크 오류를 성공으로 바꾸지 않습니다.
다른 일반 토픽 파이프라인의 동작은 변경하지 않습니다.

2026-10-04 검증: 빈 후보/정상 후보/수집 실패/입력 오류/빌드 실패/상태 표시 회귀
테스트 포함 전체 148개 통과.

OCI에서도 테스트 148개를 통과했고 `PUBLISH_DAILY=0`으로 GPU lens를 검증했습니다.
새벽 실행에서는 후보 0개였지만 재수집 때 후보 2개가 생겨 기존 정상 경로도 성공했습니다.
이 수동 검증은 게시하지 않았고, 추적 status 파일을 복구해 새벽 실행 기록을 보존했습니다.

Dev Blog can run the Linux newsletter pipeline as one daily command.

## Daily pipeline command

```bash
npm run daily:linux
```

This runs, in order:

1. `npm run collect:linux`
2. `npm run draft:linux`
3. `npm run research:linux` (configured AI adapter, tool-capable mode)
4. `npm run rewrite:linux` (same adapter, closed rewrite mode)
5. `npm run build`

Research and rewrite use the adapter selected by `defaultAdapter` in
`config/ai-provider.json`. Provider model defaults are configured in the same
file; provider-specific environment variables remain available as one-off
overrides. The adapter layer owns provider-specific commands, permissions, and
timeouts; the daily pipeline and scheduler are shared.
Supported values are `claude`, `codex`, `cursor`, and `template`.

For a one-off full daily run, override the configured value with
`DAILY_REWRITE_ADAPTER=claude|codex|cursor|template`. Research and rewrite
receive the same selected adapter. For one research/rewrite command, use
`AI_ADAPTER=claude|codex|cursor|template`.

By default this command does **not** publish generated drafts into `content/`. Generated artifacts remain under `data/generated/linux/` for review.

Publish explicitly after review:

```bash
npm run publish:linux
```

Or run and publish in one step only when trusted:

```bash
npm run daily:linux:publish
```

The command stops at the first failing step and exits non-zero.

## Logs

Runtime logs are written under `logs/daily/` and ignored by git:

- `logs/daily/YYYY-MM-DD-linux.log`
- `logs/daily/linux-latest.log`
- `logs/daily/linux-latest-status.json`

The status JSON is intended for monitoring or notification hooks.

## macOS — use launchd, not cron

On macOS, use one user LaunchAgent for every AI provider. It runs in the same
login session as the selected CLI's authentication cache. Before enabling
publication, verify the configured provider manually from the project directory.
The LaunchAgent only needs a `PATH` containing the selected CLI:

```bash
npm run rewrite:linux
env -i HOME="$HOME" PATH="<plist PATH>" npm run rewrite:linux
```

A ready-to-use template lives at
`docs/launchd/com.user.dev-blog.daily.plist.template`. Paths inside
it match the developer's machine; copy and edit before installing.

```bash
# 1. Copy the template into your LaunchAgents directory
cp docs/launchd/com.user.dev-blog.daily.plist.template \
   ~/Library/LaunchAgents/com.user.dev-blog.daily.plist

# 2. Edit paths in the copied plist if your layout differs
#    (npm path, project path, AI CLI directories, log path).

# 3. Load it. The job will fire daily at the StartCalendarInterval time.
launchctl load ~/Library/LaunchAgents/com.user.dev-blog.daily.plist

# 4. (Optional) Trigger immediately to verify
launchctl start com.user.dev-blog.daily
tail -f logs/daily/launchd.log
```

To unload (e.g., before editing):

```bash
launchctl unload ~/Library/LaunchAgents/com.user.dev-blog.daily.plist
```

If you previously had a `cron` line for this project, remove it
(`crontab -e`) — running both will publish twice.

### Why the template publishes by default

The template runs `npm run daily:linux:publish`, so the day's
briefing is written into `content/` automatically. The earlier
`docs/DEPLOYMENT.md` flow assumes this so the post can then be
committed and pushed to GitHub.

### Falling back to the template adapter

Set `DAILY_REWRITE_ADAPTER=template` in `EnvironmentVariables` of the
plist if the configured AI CLI authentication ever breaks. The pipeline will produce a
deterministic, AI-free briefing for the day instead of failing.

## Linux cron (no Keychain involved)

If running on Linux (or any environment without macOS Keychain), cron
works directly. Example:

```cron
PATH=/home/wooki/.local/bin:/home/wooki/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin
0 7 * * * cd /home/wooki/project/git/wk/dev-blog && /home/wooki/.nvm/versions/node/v24.18.0/bin/npm run daily:linux:publish >> logs/daily/cron.log 2>&1
```

`PATH` must include the directory holding the CLI selected in
`config/ai-provider.json`. Authenticate that same user before enabling the job.
Runtime data (`data/raw/`, `data/normalized/`, `data/generated/`,
`logs/daily/`) is reproducible and gitignored.

## 오픈소스 큐레이션 (`opensource-curation`)

In-repo pipeline (별도 프로젝트 체크아웃 불필요):

1. `npm run opensource-curation:discover` — GitHub Search + Trending → `data/opensource-curation/repos.json`
2. `npm run opensource-curation:fetch` — README + metadata
3. `npm run opensource-curation:analyze` — `data/opensource-curation/analysis/*.md` (`AI_ADAPTER` / `OPENSOURCE_CURATION_ANALYZE_ADAPTER`, `prompts/opensource-curation-analyze-ko.md`)

Then `npm run daily:opensource-curation` runs those three steps, then collect → draft → rewrite → build. Only blog steps:
`OPENSOURCE_CURATION_SKIP_UPSTREAM=1 npm run daily:opensource-curation`.

Configuration: `content/topics/opensource-curation/opensource-curation.config.json`. Optional: `OPENSOURCE_CURATION_ROOT` for `collect:opensource-curation` if data lives outside the default tree.

## OpenClaw cron option

A future OpenClaw cron job can run an isolated agent turn that executes:

```bash
cd /Users/wooki/project/git/wk/dev-blog && npm run daily:linux
```

Recommended behavior for that job:

- run once per day after expected upstream source updates
- report success/failure summary back to the coding topic
- include `logs/daily/linux-latest-status.json` if failure analysis is needed

Actual OpenClaw cron registration is intentionally not committed into this repository. Register it from the OpenClaw runtime when you want the daily job to become active.

## Manual recovery

If a run fails:

1. Inspect `logs/daily/linux-latest.log`.
2. Fix the failing collector, draft, rewrite, or build step.
3. Re-run `npm run daily:linux`.
4. If the generated draft is acceptable, run `npm run publish:linux`.
5. Run `npm run build`.
6. Commit generated content only if the resulting post should be versioned.
