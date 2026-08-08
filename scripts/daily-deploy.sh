#!/bin/sh
# Daily LaunchAgent entrypoint:
#   1. Run the Linux pipeline with auto-publish
#   2. If content/ changed, commit and push so GitHub Pages rebuilds
# Designed to run from launchd; relies on PATH (or CODEX_BIN) injected by the plist.

set -eu

PROJECT_DIR="${PROJECT_DIR:-/Users/wooki/project/git/wk/dev-blog}"
NPM_BIN="${NPM_BIN:-/Users/wooki/.nvm/versions/node/v24.18.0/bin/npm}"
export CODEX_BIN="${CODEX_BIN:-/Users/wooki/.nvm/versions/node/v24.18.0/bin/codex}"

# Codex research 가 느려져 스케줄 실행을 무기한 점유하지 않도록 15분 상한을 둔다.
export CODEX_TIMEOUT_MS="${CODEX_TIMEOUT_MS:-900000}"

cd "${PROJECT_DIR}"

# launchd.log 가 1MB 넘으면 .prev 로 회전. 매일 추가되니 두 달이면 충분히 큼.
LAUNCHD_LOG="${PROJECT_DIR}/logs/daily/launchd.log"
if [ -f "${LAUNCHD_LOG}" ] && [ "$(wc -c < "${LAUNCHD_LOG}")" -gt 1048576 ]; then
  mv "${LAUNCHD_LOG}" "${LAUNCHD_LOG}.prev"
fi

# research 타임아웃/Codex CLI exit 1/research non-JSON 같은 외부의존 transient 실패를 자동
# 회복하기 위해, 실패한 커맨드는 20초 대기 후 1회만 재시도한다. 재시도까지 실패하면 그
# 실패 상태를 그대로 돌려주므로 호출부의 기존 "continuing" 격리 로직은 그대로 동작한다.
retry_once() {
  if "$@"; then
    return 0
  fi
  echo "  -> retrying once after 20s: $*"
  sleep 20
  "$@"
}

# Failure-isolated for every topic so a single topic's adapter glitch does not
# block the rest of the day's content from being pushed.
if ! retry_once "${NPM_BIN}" run daily:linux:publish; then
  echo "linux daily run failed; continuing"
fi

if ! retry_once "${NPM_BIN}" run daily:android:publish; then
  echo "android daily run failed; continuing"
fi

if ! retry_once "${NPM_BIN}" run daily:opensource:publish; then
  echo "opensource daily run failed; continuing"
fi

if ! retry_once "${NPM_BIN}" run daily:opensource-curation:publish; then
  echo "opensource-curation daily run failed; continuing"
fi

if ! retry_once "${NPM_BIN}" run daily:ai-coding-agents:publish; then
  echo "ai-coding-agents daily run failed; continuing"
fi

# 6 Linux lens topics. Iterate per-topic so one bad lens doesn't sink the rest;
# run-all-kernel-lenses bails on the first failure, which is why we don't use it here.
for LENS in linux-kernel-security linux-toolchain linux-distro-stable linux-perf-rt linux-arch-platform linux-gpu-ai; do
  if ! retry_once env PUBLISH_DAILY=1 node scripts/run-daily-lore-lens.mjs "${LENS}"; then
    echo "${LENS} daily run failed; continuing"
  fi
done

# Mondays (KST) get an additional weekly digest covering the past 7 days.
if [ "$(TZ=Asia/Seoul date +%u)" = "1" ]; then
  if ! "${NPM_BIN}" run weekly:linux; then
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
