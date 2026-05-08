#!/bin/sh
# Daily LaunchAgent entrypoint:
#   1. Run the Linux pipeline with auto-publish
#   2. If content/ changed, commit and push so GitHub Pages rebuilds
# Designed to run from launchd; relies on PATH and CLAUDE_BIN injected by the plist.

set -eu

PROJECT_DIR="${PROJECT_DIR:-/Users/wooki/project/git/wk/dev-blog}"
NPM_BIN="${NPM_BIN:-/Users/wooki/.nvm/versions/node/v24.14.0/bin/npm}"

cd "${PROJECT_DIR}"

"${NPM_BIN}" run daily:linux:publish

git add content/
if git diff --cached --quiet; then
  echo "no content/ changes — nothing to push"
  exit 0
fi

DATE_KST="$(TZ=Asia/Seoul date +%Y-%m-%d)"
git commit -m "daily: ${DATE_KST} Linux briefing"
git push origin main
