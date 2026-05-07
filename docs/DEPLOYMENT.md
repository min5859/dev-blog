# Deployment

The site can be deployed to GitHub Pages. The build is deliberately
zero-dependency, so the GitHub Actions workflow is short.

## How it works

`.github/workflows/pages.yml` runs on every push to `main` (and on
manual `workflow_dispatch`). It:

1. Checks out the repo.
2. Installs Node.js 20.
3. Runs `npm test`.
4. Calls `actions/configure-pages` to discover the site's public URL
   and base path. For a project repo named `dev-blog` owned by
   `wooki`, that resolves to:
   - `SITE_URL` = `https://wooki.github.io/dev-blog`
   - `BASE_PATH` = `/dev-blog`
5. Runs `npm run build` with those env vars. `scripts/build-site.mjs`
   prefixes every internal link with `BASE_PATH` and uses `SITE_URL`
   for absolute URLs in the RSS feed.
6. Uploads `public/` as a Pages artifact.
7. Deploys via `actions/deploy-pages`.

The build-time env-var design means the same code works for:

- local preview (`npm run dev` → `http://localhost:4321`, no base path)
- project page (`https://<user>.github.io/<repo>`, base path `/<repo>`)
- user/org page (`https://<user>.github.io`, no base path)

## One-time GitHub setup

After creating the repo and pushing for the first time:

1. Repo **Settings** → **Pages** → **Source**: select **GitHub Actions**.
2. The first push to `main` triggers the workflow. Subsequent pushes
   redeploy automatically.
3. Custom domain (optional): add a `CNAME` file under `public/` *via
   the build* — easiest is to commit it to the repo root and copy it
   into the build via a small extra step. Skip for now if not needed.

## Daily Claude rewrite + auto deploy

The Claude rewrite happens on the operator's local machine (the GitHub
Actions runner does not have your Claude Code subscription). The flow:

1. Local cron runs `npm run daily:linux:publish`. This collects,
   drafts, rewrites with Claude, publishes the new post under
   `content/topics/linux/posts/`, and rebuilds locally.
2. The cron line then commits the change under `content/` and pushes
   to `main`.
3. GitHub Actions sees the push, runs the same build, and deploys.

Example cron entry (replace paths):

```cron
PATH=/Users/wooki/.local/bin:/Users/wooki/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin
CLAUDE_BIN=/Users/wooki/.local/bin/claude
0 7 * * * cd /Users/wooki/project/git/wk/dev-blog && /Users/wooki/.nvm/versions/node/v24.14.0/bin/npm run daily:linux:publish >> logs/daily/cron.log 2>&1 && git add content/ && (git diff --cached --quiet || git commit -m "daily: $(date +\%Y-\%m-\%d) Linux briefing") && git push >> logs/daily/cron.log 2>&1
```

Notes:

- `git diff --cached --quiet` exits 1 when there is something staged,
  so the `||` branch only runs when there are real changes — no empty
  commits on quiet days.
- `git push` requires an SSH key (or a stored credential helper) that
  cron's environment can use. Verify by running the same command in a
  fresh shell first.

## Manual deploy

You can trigger a deploy without a content change from the GitHub UI:
**Actions** → **Deploy to GitHub Pages** → **Run workflow**.

## Local-only mode

Skip the workflow entirely by leaving the repo private without Pages
enabled. `npm run dev` keeps working locally regardless.
