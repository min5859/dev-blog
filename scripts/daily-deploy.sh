#!/bin/sh
# Daily LaunchAgent entrypoint:
#   1. Run the Linux pipeline with auto-publish
#   2. If content/ changed, commit and push so GitHub Pages rebuilds
# Designed to run from launchd; relies on PATH and CLAUDE_BIN injected by the plist.

set -eu

PROJECT_DIR="${PROJECT_DIR:-/Users/wooki/project/git/wk/dev-blog}"
NPM_BIN="${NPM_BIN:-/Users/wooki/.nvm/versions/node/v24.14.0/bin/npm}"

cd "${PROJECT_DIR}"

# Failure-isolated for every topic so a single topic's adapter glitch does not
# block the rest of the day's content from being pushed.
if ! "${NPM_BIN}" run daily:linux:publish; then
  echo "linux daily run failed; continuing"
fi

if ! "${NPM_BIN}" run daily:android:publish; then
  echo "android daily run failed; continuing"
fi

if ! "${NPM_BIN}" run daily:opensource:publish; then
  echo "opensource daily run failed; continuing"
fi

if ! "${NPM_BIN}" run daily:opensource-curation:publish; then
  echo "opensource-curation daily run failed; continuing"
fi

# 8 Linux lens topics: kernel-security, toolchain, distro-stable, ebpf,
# perf-rt, arch-platform, rust, gpu-ai. run-all-kernel-lenses bails on the
# first failure, so iterate per-topic to keep one bad lens from sinking the rest.
for LENS in linux-kernel-security linux-toolchain linux-distro-stable linux-ebpf linux-perf-rt linux-arch-platform linux-rust linux-gpu-ai; do
  if ! PUBLISH_DAILY=1 node scripts/run-daily-lore-lens.mjs "${LENS}"; then
    echo "${LENS} daily run failed; continuing"
  fi
done

# Mondays (KST) get an additional weekly digest covering the past 7 days.
if [ "$(TZ=Asia/Seoul date +%u)" = "1" ]; then
  if ! "${NPM_BIN}" run weekly:linux:claude; then
    echo "weekly run failed; continuing with daily-only push"
  fi
fi

git add content/
if git diff --cached --quiet; then
  echo "no content/ changes — nothing to push"
  exit 0
fi

DATE_KST="$(TZ=Asia/Seoul date +%Y-%m-%d)"
if [ "$(TZ=Asia/Seoul date +%u)" = "1" ]; then
  MSG="daily + weekly briefing: ${DATE_KST}"
else
  MSG="daily: ${DATE_KST} Linux briefing"
fi
git commit -m "${MSG}"
git push origin main
