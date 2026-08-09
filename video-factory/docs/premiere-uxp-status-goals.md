# Premiere UXP Status And Goals

Last updated: 2026-08-09

This document is the restart point for the Premiere Pro / Adobe UXP control lane. It describes the current problems, how the software should answer them, what has already been built, and where the important files and evidence live.

## Scope

This lane is only about controlling Premiere Pro and Adobe UXP Developer Tools so existing owned or licensed media can be imported, edited, QC'd, and exported through Premiere automation.

Do not use this lane to publish media, call provider write APIs, generate AI video, or bypass rights/provenance checks. CLI plugin loading is allowed as a recovery path, but the managed product path should prefer visible UXP UI control with receipts.

## Current State

- Adobe UXP Developer Tools has two relevant plugin rows:
  - Row 1: `Premiere MCP Agent`
  - Row 2: `com.editstudio.premiere.executor` / `Edit Studio EDL Executor`
- The live pixel driver has successfully inspected the UXP table and reported both rows as `loaded`.
- The running server on `http://127.0.0.1:3032` may still need a restart before it exposes the new `/api/uxp/*` routes. If `GET /api/uxp/ui-state` returns `API_NOT_FOUND`, restart the Video Factory service after tests pass.
- Evidence and receipts from live UXP runs are under `/Users/isaiahdupree/Documents/Software/marketing-video-foundry/work/premiere-editing/`.
- Local driver/API error logs are under `/Users/isaiahdupree/Documents/Software/ppro-uxp-load/adobe-mcp/video-factory/work/uxp-ui-driver-errors.jsonl`.

## Current Problems

| Problem | Why it matters | Software answer | Done state |
| --- | --- | --- | --- |
| UXP button locations shift by window size, row order, and table state. | Hardcoded coordinates click the wrong thing, select rows, or miss buttons. | Detect rows and action labels from the live screenshot every run. Use right-anchored action zones, not left-anchored constants. | `scripts/uxp-ui-driver.py` exists. |
| AppleScript clicks can hang on the UXP Electron webview. | A failed click used to waste many seconds and gave weak diagnostics. | Millisecond click timeouts, fallback click backend, typed timeout code, evidence screenshots. | `scripts/uxp-load-premiere-plugin.js` timing knobs exist. |
| Selected UXP rows swallow button clicks. | A selected checkbox can make a click select the row instead of pressing Load/Unload. | Detect selected rows by dark or Adobe-blue checkbox fill, press Escape, recapture, then click. | Implemented in `scripts/uxp-ui-driver.py`. |
| Loaded vs Not loaded was misread from text width. | Width thresholds broke when state text changed or scaled. | Use the green state dot as the primary loaded signal. | Implemented in `scripts/uxp-ui-driver.py`. |
| OCR can fail on symlinked temp paths. | Plugin-name targeting becomes brittle if Tesseract cannot read row IDs. | Write OCR cells through `realpath`, then fall back to `/private/tmp`; fall back to row index if OCR is unavailable. | Implemented in `scripts/uxp-ui-driver.py`. |
| First click after unhide/focus can be swallowed. | Hidden or background UXP can consume the first click without changing state. | Reassert focus and retry click when no state delta or new toast appears inside the verify budget. | Implemented in `scripts/uxp-ui-driver.py`. |
| Multiple callers can click UXP at the same time. | Concurrent load/unload requests can race and leave the UI in an unknown state. | Single-flight driver lock; API maps busy to `UXP_DRIVER_BUSY` / HTTP 429. | Implemented in `scripts/uxp-ui-driver.py` and `lib/server.js`. |
| The API needs typed failures, not vague local automation errors. | The future software UI needs to show exact recovery steps and logs. | `/api/uxp/ui-state`, `/api/uxp/plugin-action`, stable error codes, JSONL failure log. | Implemented in `lib/server.js` and `lib/uxp-ui-driver.js`; live server restart may be needed. |
| Startup knowledge can disappear across sessions. | If memory is wiped, the next agent needs a concrete startup and verification map. | Keep this status doc, startup configuration docs, receipts, and tests current. | This document is the current index. |
| Premiere operation packets depend on real local assets. | Editing tests should not silently fake missing music, SFX, overlays, or media. | Preflight operation packets and report missing assets before live Premiere execution. | `scripts/run-premiere-operation-packets.js` exists; asset availability still needs final confirmation. |

## Software Interfaces

### Driver

`/Users/isaiahdupree/Documents/Software/ppro-uxp-load/adobe-mcp/video-factory/scripts/uxp-ui-driver.py`

Primary local commands:

```bash
scripts/uxp-ui-driver.py inspect --ocr
scripts/uxp-ui-driver.py state --plugin-name editstudio
scripts/uxp-ui-driver.py click --plugin-name editstudio --action unload
scripts/uxp-ui-driver.py click --plugin-name editstudio --action load
```

The driver writes receipts and screenshots to `--evidence-dir` when supplied. It should leave row 2 loaded after any E2E suite.

### API

Implemented in `/Users/isaiahdupree/Documents/Software/ppro-uxp-load/adobe-mcp/video-factory/lib/server.js` through `/Users/isaiahdupree/Documents/Software/ppro-uxp-load/adobe-mcp/video-factory/lib/uxp-ui-driver.js`.

Routes:

```text
GET  /api/uxp/ui-state
POST /api/uxp/plugin-action
```

Example body:

```json
{
  "plugin_name": "editstudio",
  "action": "unload",
  "verify_timeout_ms": 4000,
  "poll_interval_ms": 10
}
```

Important error codes:

| Code | Meaning |
| --- | --- |
| `UXP_ROW_NOT_FOUND` | Requested row or plugin name was not found. |
| `UXP_ACTION_NOT_AVAILABLE` | Action does not match current row state, such as `load` when already loaded. |
| `UXP_STATE_VERIFY_TIMEOUT` | Click occurred but state did not flip before timeout. |
| `UXP_WINDOW_OBSCURED` | Screenshot sanity check failed; do not click blind. |
| `UXP_DRIVER_BUSY` | Another driver invocation holds the single-flight lock. |
| `UXP_PLUGIN_LOAD_FAILED` | UXP displayed a failure toast after the click. |

## Tests

Focused checks:

```bash
python3 -m py_compile scripts/uxp-ui-driver.py
python3 scripts/uxp-ui-driver-e2e.py
python3 scripts/uxp-api-integration-test.py http://127.0.0.1:3033
node --test tests/server-errors.test.js tests/startup-journal.test.js
```

Plugin package checks:

```bash
cd /Users/isaiahdupree/Documents/Software/edit-studio/uxp-plugin
/opt/homebrew/bin/uxp plugin validate

cd /Users/isaiahdupree/Documents/Software/edit-studio
python3 -m pytest tests/test_uxp_plugin.py -q
```

## Problem Definition Template

Use this format before adding new automation:

```text
Problem:
What exact failure, delay, or manual step are we removing?

Observed evidence:
Receipt path, screenshot path, API response, or log line.

Success condition:
The measurable state that proves the problem is solved.

Constraints:
No publishing, no provider writes, no unlicensed footage, no fake production behavior.

Software interface:
CLI, API route, startup script, dashboard control, or Premiere operation packet.

Error model:
Typed codes and recovery instructions callers should receive.

Test plan:
Fast unit/integration test plus at least one live dry-run or evidence-producing check.

Recovery:
How the software should restore both plugins and Premiere bridge to a known good state.
```

## Goals

1. Make `/api/uxp/ui-state` the default read path for any future software UI.
2. Make `/api/uxp/plugin-action` the default button path for Load/Unload/Watch actions.
3. Keep UXP UI actions under a few hundred milliseconds for click attempts, with bounded verification polling.
4. Restart the live `3032` Video Factory server after route tests pass so the current API is exposed.
5. Add a simple control surface that shows plugin rows, state, actions, latest receipt, and recovery button.
6. Run Premiere operation packets only after plugin state, Premiere bridge, and local asset preflight are green.
7. Keep all footage provenance and rights checks upstream of any Premiere import/edit/export run.

## File Map

| File | Purpose |
| --- | --- |
| `scripts/uxp-ui-driver.py` | Deterministic screenshot-driven UXP row detector and action driver. |
| `lib/uxp-ui-driver.js` | Node adapter for API routes, including JSON parsing and failure logging. |
| `lib/server.js` | Video Factory HTTP API, including `/api/uxp/ui-state` and `/api/uxp/plugin-action`. |
| `scripts/uxp-ui-driver-e2e.py` | Live app E2E suite for move, resize, selection, hidden app, unknown plugin, lock busy, and final loaded state. |
| `scripts/uxp-api-integration-test.py` | API integration suite for UXP routes against a scratch server. |
| `scripts/uxp-load-premiere-plugin.js` | Older visible UI loader with millisecond timings and evidence receipts. |
| `scripts/start-premiere-stack.sh` | Managed startup journal and Premiere/UXP bring-up script. |
| `docs/premiere-uxp-ui-loader.md` | Loader usage, timing knobs, and observed UXP click behavior. |
| `docs/premiere-stack-startup-configuration.md` | Software startup configuration and timing policy. |
| `docs/api-error-codes.md` | API error shape and recovery table. |

## Next Runbook

1. Run `scripts/uxp-ui-driver.py inspect --ocr`.
2. If both rows are `loaded`, test API on a scratch server.
3. If scratch API tests pass, restart the live `3032` server.
4. Confirm `GET http://127.0.0.1:3032/api/uxp/ui-state` returns both rows.
5. Run one safe round trip on Edit Studio: unload then load, with evidence directory set.
6. Confirm Premiere bridge is still connected before running any edit operation packets.
