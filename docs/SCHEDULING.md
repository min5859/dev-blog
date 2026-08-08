# Scheduling

Dev Blog can run the Linux newsletter pipeline as one daily command.

## Daily pipeline command

```bash
npm run daily:linux
```

This runs, in order:

1. `npm run collect:linux`
2. `npm run draft:linux`
3. `npm run research:linux` (default — Codex CLI with web search)
4. `npm run rewrite:linux` (default — Codex CLI, closed rewrite)
5. `npm run build`

Research and rewrite use the **Codex** adapter by default (`DEFAULT_AI_ADAPTER` in `scripts/lib/ai-rewrite-adapter.mjs`). Both run non-interactively through `codex exec --ephemeral --sandbox read-only`; research uses `codex --search exec`, while rewrite stays a closed transform. The CLI reuses the local ChatGPT subscription login shown by `codex login status`, so no metered API key is required. Set `CODEX_BIN`, `CODEX_MODEL`, `CODEX_RESEARCH_MODEL`, or `CODEX_TIMEOUT_MS` (default 15 minutes, `0` disables the timeout) to override execution.

Override the whole daily AI path with `DAILY_REWRITE_ADAPTER=template` for the offline deterministic path, `DAILY_REWRITE_ADAPTER=claude` for Claude CLI, or `DAILY_REWRITE_ADAPTER=cursor` for Cursor Agent CLI. Research and rewrite receive the same selected adapter. `DAILY_REWRITE_ADAPTER=cursor-agent` is treated the same as `cursor`. For a single research/rewrite command, use `AI_ADAPTER=claude|cursor|codex|template`.

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

On macOS, use a user LaunchAgent so the scheduled process runs in the same
login session as the Codex CLI authentication cache. Confirm the exact
LaunchAgent environment before enabling publication:

```bash
codex login status
env -i HOME="$HOME" PATH="<plist PATH>" codex login status
```

A ready-to-use template lives at
`docs/launchd/com.user.dev-blog.daily.plist.template`. Paths inside
it match the developer's machine; copy and edit before installing.

```bash
# 1. Copy the template into your LaunchAgents directory
cp docs/launchd/com.user.dev-blog.daily.plist.template \
   ~/Library/LaunchAgents/com.user.dev-blog.daily.plist

# 2. Edit paths in the copied plist if your layout differs
#    (npm path, project path, Codex path, log path).

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
plist if Codex CLI auth ever breaks. The pipeline will produce a
deterministic, AI-free briefing for the day instead of failing.

## Linux cron (no Keychain involved)

If running on Linux (or any environment without macOS Keychain), cron
works directly. Example:

```cron
PATH=/home/wooki/.local/bin:/home/wooki/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin
CODEX_BIN=/home/wooki/.nvm/versions/node/v24.18.0/bin/codex
0 7 * * * cd /home/wooki/project/git/wk/dev-blog && /home/wooki/.nvm/versions/node/v24.18.0/bin/npm run daily:linux:publish >> logs/daily/cron.log 2>&1
```

`PATH` must include the directory holding `codex`, or `CODEX_BIN` must point
to it. Authenticate that same user with `codex login` before enabling the
job. Runtime data (`data/raw/`, `data/normalized/`, `data/generated/`,
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
