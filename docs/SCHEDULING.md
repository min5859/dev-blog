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

## Local cron example

Run at 07:00 every day in the machine's local timezone, generating only (no auto-publish):

```cron
PATH=/Users/wooki/.local/bin:/Users/wooki/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin
CLAUDE_BIN=/Users/wooki/.local/bin/claude
0 7 * * * cd /Users/wooki/project/git/wk/dev-blog && /Users/wooki/.nvm/versions/node/v24.14.0/bin/npm run daily:linux >> logs/daily/cron.log 2>&1
```

To also publish the generated briefing into `content/` (skips the human review step):

```cron
0 7 * * * cd /Users/wooki/project/git/wk/dev-blog && /Users/wooki/.nvm/versions/node/v24.14.0/bin/npm run daily:linux:publish >> logs/daily/cron.log 2>&1
```

Notes:

- Cron has a minimal environment, so the absolute `npm` path is required and `PATH` must include the directory holding `claude` (here `~/.local/bin`).
- `CLAUDE_BIN` is read by `scripts/ai-rewrite-linux.mjs` when the `claude` adapter runs; setting it explicitly avoids PATH surprises.
- Set `DAILY_REWRITE_ADAPTER=template` on the cron line if Claude CLI is unavailable; the pipeline will fall back to the deterministic template adapter.
- Runtime data in `data/raw/`, `data/normalized/`, `data/generated/`, and `logs/daily/` is reproducible and ignored by git.

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
