#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADOBE_MCP_ROOT="$(cd "$ROOT/.." && pwd)"
FACTORY_HOME="${VIDEO_FACTORY_HOME:-/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory}"
LOG_DIR="$FACTORY_HOME/logs"
STARTUP_LOG_ROOT="${PREMIERE_STARTUP_LOG_DIR:-$FACTORY_HOME/startup}"
STARTUP_RUN_ID="$(/bin/date -u +"%Y%m%dT%H%M%SZ")-$$"
STARTUP_RUN_DIR="${PREMIERE_STARTUP_RUN_DIR:-$STARTUP_LOG_ROOT/$STARTUP_RUN_ID}"
LOADER_EVIDENCE_DIR="$STARTUP_RUN_DIR/uxp-loader"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:3031}"
FACTORY_URL="http://127.0.0.1:${VIDEO_FACTORY_PORT:-3032}"
FACTORY_READY_URL="$FACTORY_URL/api/errors"
UXP_CLI="${UXP_CLI:-/opt/homebrew/bin/uxp}"
STARTUP_POLL_SECONDS="${PREMIERE_STARTUP_POLL_SECONDS:-0.5}"
PROXY_READY_ATTEMPTS="${PREMIERE_PROXY_READY_ATTEMPTS:-20}"
FACTORY_READY_ATTEMPTS="${VIDEO_FACTORY_READY_ATTEMPTS:-20}"
APP_READY_ATTEMPTS="${PREMIERE_APP_READY_ATTEMPTS:-30}"
STARTUP_JOURNAL_ACTIVE=0

LOADER_ARGS=("$@")

has_loader_arg() {
  local wanted="$1"
  for arg in "${LOADER_ARGS[@]}"; do
    if [[ "$arg" == "$wanted" || "$arg" == "$wanted="* ]]; then
      return 0
    fi
  done
  return 1
}

if ! has_loader_arg "--evidence-dir"; then
  LOADER_ARGS+=(--evidence-dir "$LOADER_EVIDENCE_DIR")
fi
if ! has_loader_arg "--host-timeout-ms" && ! has_loader_arg "--skip-host-wait"; then
  LOADER_ARGS+=(--host-timeout-ms "${PREMIERE_UXP_HOST_TIMEOUT_MS:-30000}")
fi
if ! has_loader_arg "--timeout-ms"; then
  LOADER_ARGS+=(--timeout-ms "${PREMIERE_UXP_LOAD_TIMEOUT_MS:-15000}")
fi
if ! has_loader_arg "--retry-delay-ms"; then
  LOADER_ARGS+=(--retry-delay-ms "${PREMIERE_UXP_RETRY_DELAY_MS:-1000}")
fi
if ! has_loader_arg "--retries"; then
  LOADER_ARGS+=(--retries "${PREMIERE_UXP_RETRIES:-1}")
fi

mkdir -p "$LOG_DIR" "$STARTUP_RUN_DIR" "$LOADER_EVIDENCE_DIR"

ms_now() {
  /usr/bin/env node -e 'process.stdout.write(String(Date.now()))'
}

loader_args_json() {
  /usr/bin/env node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "${LOADER_ARGS[@]}"
}

journal_event() {
  local phase="$1"
  local status="$2"
  local message="$3"
  local duration_ms="${4:-}"
  shift 4 || true
  local cmd=(/usr/bin/env node "$ROOT/scripts/startup-journal.js" event
    --run-dir "$STARTUP_RUN_DIR"
    --phase "$phase"
    --status "$status"
    --message "$message")
  if [[ -n "$duration_ms" ]]; then
    cmd+=(--duration-ms "$duration_ms")
  fi
  for detail in "$@"; do
    cmd+=(--detail "$detail")
  done
  "${cmd[@]}" >/dev/null 2>&1 || true
}

run_phase() {
  local phase="$1"
  local message="$2"
  shift 2
  local start_ms end_ms duration_ms rc
  start_ms="$(ms_now)"
  journal_event "$phase" "started" "$message" ""
  set +e
  "$@"
  rc=$?
  set -e
  end_ms="$(ms_now)"
  duration_ms=$((end_ms - start_ms))
  if [[ "$rc" == "0" ]]; then
    journal_event "$phase" "complete" "$message" "$duration_ms" "exitCode=0"
  else
    journal_event "$phase" "failed" "$message" "$duration_ms" "exitCode=$rc"
  fi
  return "$rc"
}

finish_journal() {
  local rc=$?
  if [[ "$STARTUP_JOURNAL_ACTIVE" == "1" ]]; then
    STARTUP_JOURNAL_ACTIVE=0
    local status="failed"
    if [[ "$rc" == "0" ]]; then
      status="complete"
    fi
    /usr/bin/env node "$ROOT/scripts/startup-journal.js" summary \
      --run-dir "$STARTUP_RUN_DIR" \
      --status "$status" \
      --detail "exitCode=$rc" >/dev/null 2>&1 || true
    echo "startup configuration summary: $STARTUP_RUN_DIR/startup-summary.json"
  fi
  exit "$rc"
}

trap finish_journal EXIT

GIT_BRANCH="$(/usr/bin/git -C "$ADOBE_MCP_ROOT" branch --show-current 2>/dev/null || true)"
GIT_REVISION="$(/usr/bin/git -C "$ADOBE_MCP_ROOT" rev-parse --short HEAD 2>/dev/null || true)"

/usr/bin/env node "$ROOT/scripts/startup-journal.js" init \
  --root "$ROOT" \
  --adobe-mcp-root "$ADOBE_MCP_ROOT" \
  --factory-home "$FACTORY_HOME" \
  --log-dir "$LOG_DIR" \
  --startup-log-root "$STARTUP_LOG_ROOT" \
  --run-dir "$STARTUP_RUN_DIR" \
  --proxy-url "$PROXY_URL" \
  --factory-url "$FACTORY_URL" \
  --factory-ready-url "$FACTORY_READY_URL" \
  --loader-evidence-dir "$LOADER_EVIDENCE_DIR" \
  --loader-args-json "$(loader_args_json)" \
  --git-branch "$GIT_BRANCH" \
  --git-revision "$GIT_REVISION" >/dev/null
STARTUP_JOURNAL_ACTIVE=1

echo "startup configuration run: $STARTUP_RUN_DIR"

is_up() {
  /usr/bin/curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

process_exists() {
  local app_name="$1"
  /usr/bin/osascript -e "tell application \"System Events\" to exists process \"$app_name\"" 2>/dev/null | /usr/bin/grep -q true
}

start_proxy() {
  if is_up "$PROXY_URL/status"; then
    echo "proxy already running: $PROXY_URL"
    journal_event "proxy.start" "observed" "Premiere proxy was already listening." "" \
      "action=already_running" "url=$PROXY_URL/status"
    return
  fi
  echo "starting Premiere proxy"
  nohup /usr/bin/env node "$ADOBE_MCP_ROOT/proxy-server/proxy.js" \
    >>"$LOG_DIR/proxy.log" 2>>"$LOG_DIR/proxy.err.log" &
  local proxy_pid=$!
  journal_event "proxy.start" "observed" "Launched Premiere proxy process." "" \
    "action=started" "pid=$proxy_pid" "stdout=$LOG_DIR/proxy.log" "stderr=$LOG_DIR/proxy.err.log"
  for attempt in $(seq 1 "$PROXY_READY_ATTEMPTS"); do
    if is_up "$PROXY_URL/status"; then
      echo "proxy ready"
      journal_event "proxy.ready" "observed" "Premiere proxy readiness check passed." "" \
        "attempts=$attempt" "url=$PROXY_URL/status"
      return
    fi
    sleep "$STARTUP_POLL_SECONDS"
  done
  journal_event "proxy.ready" "failed" "Premiere proxy did not become ready." "" \
    "attempts=$PROXY_READY_ATTEMPTS" "url=$PROXY_URL/status"
  echo "proxy did not become ready" >&2
  return 1
}

start_factory() {
  if is_up "$FACTORY_READY_URL"; then
    echo "factory already running: $FACTORY_URL"
    journal_event "factory.start" "observed" "Video Factory was already listening." "" \
      "action=already_running" "url=$FACTORY_READY_URL"
    return
  fi
  echo "starting Premiere video factory"
  nohup /usr/bin/env node "$ROOT/cli.js" serve \
    >>"$LOG_DIR/factory.log" 2>>"$LOG_DIR/factory.err.log" &
  local factory_pid=$!
  journal_event "factory.start" "observed" "Launched Video Factory service process." "" \
    "action=started" "pid=$factory_pid" "stdout=$LOG_DIR/factory.log" "stderr=$LOG_DIR/factory.err.log"
  for attempt in $(seq 1 "$FACTORY_READY_ATTEMPTS"); do
    if is_up "$FACTORY_READY_URL"; then
      echo "factory ready"
      journal_event "factory.ready" "observed" "Video Factory readiness check passed." "" \
        "attempts=$attempt" "url=$FACTORY_READY_URL"
      return
    fi
    sleep "$STARTUP_POLL_SECONDS"
  done
  journal_event "factory.ready" "failed" "Video Factory did not become ready." "" \
    "attempts=$FACTORY_READY_ATTEMPTS" "url=$FACTORY_READY_URL"
  echo "factory did not become ready" >&2
  return 1
}

open_app() {
  local app_name="$1"
  if process_exists "$app_name"; then
    echo "$app_name already running"
    journal_event "app.open" "observed" "$app_name was already running." "" \
      "app=$app_name" "action=already_running"
    return
  fi
  echo "opening $app_name"
  /usr/bin/open -a "$app_name"
  journal_event "app.open" "observed" "Requested macOS to open $app_name." "" \
    "app=$app_name" "action=open_requested"
  for attempt in $(seq 1 "$APP_READY_ATTEMPTS"); do
    if process_exists "$app_name"; then
      journal_event "app.open" "observed" "$app_name process became visible." "" \
        "app=$app_name" "attempts=$attempt"
      return
    fi
    sleep "$STARTUP_POLL_SECONDS"
  done
  journal_event "app.open" "failed" "$app_name process did not become visible." "" \
    "app=$app_name" "attempts=$APP_READY_ATTEMPTS"
  return 1
}

probe_uxp_service() {
  if [[ ! -x "$UXP_CLI" ]]; then
    journal_event "uxp.service" "failed" "Configured UXP CLI is not executable." "" \
      "uxpCli=$UXP_CLI"
    return 0
  fi
  set +e
  "$UXP_CLI" apps list >"$STARTUP_RUN_DIR/uxp-apps-list.txt" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" == "0" ]]; then
    journal_event "uxp.service" "observed" "Captured UXP apps list for software startup diagnostics." "" \
      "exitCode=0" "output=$STARTUP_RUN_DIR/uxp-apps-list.txt"
  else
    journal_event "uxp.service" "failed" "UXP apps list probe failed." "" \
      "exitCode=$rc" "output=$STARTUP_RUN_DIR/uxp-apps-list.txt"
  fi
  return 0
}

load_premiere_plugin() {
  /usr/bin/env node "$ROOT/scripts/uxp-load-premiere-plugin.js" "${LOADER_ARGS[@]}"
}

final_factory_health() {
  echo "final factory health"
  if /usr/bin/curl -fsS --max-time 10 "$FACTORY_URL/api/health" | /usr/bin/python3 -m json.tool; then
    journal_event "factory.final-health" "observed" "Factory /api/health completed." "" \
      "url=$FACTORY_URL/api/health"
    return 0
  fi
  echo "factory is listening, but /api/health did not complete; dumping lightweight API readiness"
  journal_event "factory.final-health" "observed" "Factory /api/health did not complete; using /api/errors readiness." "" \
    "healthUrl=$FACTORY_URL/api/health" "readyUrl=$FACTORY_READY_URL"
  /usr/bin/curl -fsS --max-time 5 "$FACTORY_READY_URL" | /usr/bin/python3 -m json.tool
}

run_phase "proxy.start" "Start or verify the local Premiere command proxy." start_proxy
run_phase "factory.start" "Start or verify the local Video Factory API." start_factory
run_phase "uxp.open" "Open Adobe UXP Developer Tools for the visible loader path." open_app "Adobe UXP Developer Tools"
run_phase "uxp.service-probe" "Capture our UXP CLI service configuration probe." probe_uxp_service
run_phase "premiere.open" "Open Adobe Premiere Pro for the automation bridge." open_app "Adobe Premiere Pro 2026"

if [[ "${PREMIERE_START_MEDIA_ENCODER:-0}" == "1" ]]; then
  run_phase "media-encoder.open" "Open Adobe Media Encoder for export support." open_app "Adobe Media Encoder 2026"
fi

echo "loading Premiere UXP plugin through the UXP Developer Tools UI"
run_phase "uxp.loader" "Load the Premiere MCP Agent through the UXP Developer Tools UI." load_premiere_plugin
run_phase "factory.final-health" "Record final Video Factory health/readiness." final_factory_health
