#!/bin/sh
# Daily LaunchAgent entrypoint:
#   1. Run the Linux pipeline with auto-publish
#   2. If content/ changed, commit and push so GitHub Pages rebuilds
# Designed to run from launchd; relies on PATH and CLAUDE_BIN injected by the plist.

set -eu

PROJECT_DIR="${PROJECT_DIR:-/Users/wooki/project/git/wk/dev-blog}"
NPM_BIN="${NPM_BIN:-/Users/wooki/.nvm/versions/node/v24.14.0/bin/npm}"

cd "${PROJECT_DIR}"

# launchd.log 가 1MB 넘으면 .prev 로 회전. 매일 추가되니 두 달이면 충분히 큼.
LAUNCHD_LOG="${PROJECT_DIR}/logs/daily/launchd.log"
if [ -f "${LAUNCHD_LOG}" ] && [ "$(wc -c < "${LAUNCHD_LOG}")" -gt 1048576 ]; then
  mv "${LAUNCHD_LOG}" "${LAUNCHD_LOG}.prev"
fi

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

if ! "${NPM_BIN}" run daily:ai-coding-agents:publish; then
  echo "ai-coding-agents daily run failed; continuing"
fi

# 6 Linux lens topics. Iterate per-topic so one bad lens doesn't sink the rest;
# run-all-kernel-lenses bails on the first failure, which is why we don't use it here.
for LENS in linux-kernel-security linux-toolchain linux-distro-stable linux-perf-rt linux-arch-platform linux-gpu-ai; do
  if ! PUBLISH_DAILY=1 node scripts/run-daily-lore-lens.mjs "${LENS}"; then
    echo "${LENS} daily run failed; continuing"
  fi
done

# Mondays (KST) get an additional weekly digest covering the past 7 days.
if [ "$(TZ=Asia/Seoul date +%u)" = "1" ]; then
  if ! "${NPM_BIN}" run weekly:linux:claude; then
    echo "weekly run failed; continuing with daily-only push"
  fi
  # dossier 기반 전 토픽 weekly-rollup 생성+발행(best-effort, 일부 토픽 실패해도 계속).
  if ! PUBLISH_WEEKLY=1 node scripts/run-weekly-all.mjs; then
    echo "weekly-rollup-all failed; continuing"
  fi
fi

# content/ 와 함께 logs/daily/*-latest-status.json 도 add — 모든 토픽이 실패해 content 변경이
# 없어도 사이트 빌드를 트리거해 "자동 파이프라인 상태" 카드가 갱신되도록 한다.
git add content/ logs/daily/*-latest-status.json 2>/dev/null || git add content/
if git diff --cached --quiet; then
  echo "no content/ or status changes — nothing to push"
  exit 0
fi

DATE_KST="$(TZ=Asia/Seoul date +%Y-%m-%d)"
if git diff --cached --name-only | grep -q '^content/'; then
  if [ "$(TZ=Asia/Seoul date +%u)" = "1" ]; then
    MSG="daily + weekly briefing: ${DATE_KST}"
  else
    MSG="daily: ${DATE_KST} briefing"
  fi
else
  MSG="ops: ${DATE_KST} pipeline status update (no new content)"
fi
git commit -m "${MSG}"
git push origin main
