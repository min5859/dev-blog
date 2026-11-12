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
- 수동 실행: `node scripts/collect-driver-impact.mjs --repo <linux.git> --from v7.3 --to v7.4-rc1`,
  `node scripts/draft-driver-impact.mjs --from v7.3 --to v7.4-rc1`.

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
