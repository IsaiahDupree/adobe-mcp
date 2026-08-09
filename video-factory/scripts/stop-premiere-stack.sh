#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FACTORY_HOME="${VIDEO_FACTORY_HOME:-/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory}"
LOG_DIR="$FACTORY_HOME/logs"
FORCE=0
KEEP_ADOBE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --keep-adobe) KEEP_ADOBE=1 ;;
    --help|-h)
      cat <<'USAGE'
Usage:
  scripts/stop-premiere-stack.sh [--force] [--keep-adobe]

Stops the local Premiere Video Factory service, proxy process, and, unless
--keep-adobe is passed, asks Premiere, Media Encoder, and UXP Developer Tools
to quit. --force follows the graceful quit with pkill cleanup.
USAGE
      exit 0
      ;;
  esac
done

mkdir -p "$LOG_DIR"

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  "$@" &
  local pid="$!"
  for _ in $(seq 1 "$timeout_seconds"); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
  return 124
}

echo "stopping Premiere video factory service if installed"
/usr/bin/env node "$ROOT/cli.js" stop-service >/tmp/premiere-factory-stop.json 2>/tmp/premiere-factory-stop.err || true
cat /tmp/premiere-factory-stop.json 2>/dev/null || true

echo "stopping ad-hoc factory and proxy processes"
/usr/bin/pkill -f "$ROOT/cli.js serve" >/dev/null 2>&1 || true
/usr/bin/pkill -f "/adobe-mcp/proxy-server/proxy.js" >/dev/null 2>&1 || true

if [[ "$KEEP_ADOBE" == "1" ]]; then
  echo "leaving Adobe apps open because --keep-adobe was passed"
  exit 0
fi

quit_app() {
  local app_name="$1"
  if /usr/bin/osascript -e "tell application \"System Events\" to exists process \"$app_name\"" | /usr/bin/grep -q true; then
    echo "asking $app_name to quit"
    run_with_timeout 8 /usr/bin/osascript -e "tell application \"$app_name\" to quit" >/dev/null 2>&1 || true
  fi
}

quit_app "Adobe Media Encoder 2026"
quit_app "Adobe Premiere Pro 2026"
quit_app "Adobe UXP Developer Tools"

if [[ "$FORCE" == "1" ]]; then
  echo "force cleanup requested"
  for pattern in \
    "$ROOT/cli.js serve" \
    "/adobe-mcp/proxy-server/proxy.js" \
    "Adobe Media Encoder 2026.app/Contents/MacOS/Adobe Media Encoder 2026" \
    "Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026" \
    "Adobe UXP Developer Tools.app/Contents/MacOS/Adobe UXP Developer Tools" \
    "dynamiclinkmanager" \
    "TeamProjectsLocalHub"
  do
    /usr/bin/pkill -f "$pattern" >/dev/null 2>&1 || true
  done
  for process_name in \
    "Adobe Media Encoder 2026" \
    "Adobe Premiere Pro 2026" \
    "Adobe UXP Developer Tools"
  do
    /usr/bin/pkill -x "$process_name" >/dev/null 2>&1 || true
  done
  sleep 2
  for pattern in \
    "$ROOT/cli.js serve" \
    "/adobe-mcp/proxy-server/proxy.js" \
    "Adobe Media Encoder 2026.app/Contents/MacOS/Adobe Media Encoder 2026" \
    "Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026" \
    "Adobe UXP Developer Tools.app/Contents/MacOS/Adobe UXP Developer Tools"
  do
    /usr/bin/pkill -9 -f "$pattern" >/dev/null 2>&1 || true
  done
fi

echo "Premiere stack stop requested"
