# Scheduling

Dev Blog can run the Linux newsletter pipeline as one daily command.

## Daily pipeline command

```bash
npm run daily:linux
```

This runs, in order:

1. `npm run collect:linux`
2. `npm run draft:linux`
3. `npm run rewrite:linux` (default — Claude CLI, `claude -p`)
4. `npm run build`

The rewrite step uses the **Claude** adapter by default (`DEFAULT_AI_ADAPTER` in `scripts/lib/ai-rewrite-adapter.mjs`), invoked with all built-in tools disabled (`--tools ""`) and a cwd isolated to a temp directory, so it cannot see repo files/artifacts and can only return the rewritten JSON. Set `CLAUDE_BIN` / `CLAUDE_MODEL` to override the binary/model. Override the adapter with `DAILY_REWRITE_ADAPTER=template` for the offline template path, `DAILY_REWRITE_ADAPTER=cursor` for the Cursor Agent CLI (read-only `--mode=ask`; set `CURSOR_API_KEY` and optionally `CURSOR_AGENT_BIN` / `CURSOR_AGENT_EXTRA_ARGS`), or `DAILY_REWRITE_ADAPTER=codex` for the Codex CLI (read-only `--sandbox read-only`). `DAILY_REWRITE_ADAPTER=cursor-agent` is treated the same as `cursor`. Per-invocation override: `AI_ADAPTER=claude|cursor|codex|template` on `npm run rewrite:*` scripts.

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

On macOS, `cron` runs outside the user's GUI session and **cannot
unlock the login keychain**. The Claude Code CLI stores its OAuth
credential there, so a `cron` job ends up with `claude` exiting
1 with `Not logged in · Please run /login`. Use `launchd` instead —
LaunchAgents run inside the user session and have keychain access.

A ready-to-use template lives at
`docs/launchd/com.user.dev-blog.daily.plist.template`. Paths inside
it match the developer's machine; copy and edit before installing.

```bash
# 1. Copy the template into your LaunchAgents directory
cp docs/launchd/com.user.dev-blog.daily.plist.template \
   ~/Library/LaunchAgents/com.user.dev-blog.daily.plist

# 2. Edit paths in the copied plist if your layout differs
#    (npm path, project path, claude path, log path).

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
plist if Claude CLI auth ever breaks. The pipeline will produce a
deterministic, AI-free briefing for the day instead of failing.

## Linux cron (no Keychain involved)

If running on Linux (or any environment without macOS Keychain), cron
works directly. Example:

```cron
PATH=/home/wooki/.local/bin:/home/wooki/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin
CLAUDE_BIN=/home/wooki/.local/bin/claude
0 7 * * * cd /home/wooki/project/git/wk/dev-blog && /home/wooki/.nvm/versions/node/v24.14.0/bin/npm run daily:linux:publish >> logs/daily/cron.log 2>&1
```

`PATH` must include the directory holding `claude`; `CLAUDE_BIN` is
read by `scripts/ai-rewrite-linux.mjs` when the `claude` adapter
runs. Runtime data (`data/raw/`, `data/normalized/`, `data/generated/`,
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
