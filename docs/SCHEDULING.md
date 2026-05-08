# Scheduling

Dev Blog can run the Linux newsletter pipeline as one daily command.

## Daily pipeline command

```bash
npm run daily:linux
```

This runs, in order:

1. `npm run collect:linux`
2. `npm run draft:linux`
3. `npm run rewrite:linux:claude` (default — calls the Claude CLI)
4. `npm run build`

The rewrite step uses the Claude adapter by default so the daily run produces an AI-rewritten briefing rather than the deterministic template output. Override with `DAILY_REWRITE_ADAPTER=template` if you want the offline template path (no Claude CLI calls).

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
