# Premiere Stack Startup Configuration

This document is about our software configuration, not Adobe's internal logs. Adobe UXP/Premiere logs are useful diagnostic attachments, but the source of truth for bring-up is the Video Factory startup journal and job receipts.

## What Previously Worked

Recovered software receipts show the working shape:

| Source | JSON path | Working signal |
| --- | --- | --- |
| `/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/jobs/premiere-autonomy-1785602015621-d243c5.json` | `checkpoints.app-readiness.result` | `status: healthy`, Premiere running and responsive, proxy running at `http://127.0.0.1:3031`, `clients.premiere: 1`, UXP Developer Tools running, plugin installed, and `uxp.bridgeConnected: true`. |
| `/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/jobs/premiere-autonomy-1785602015621-d243c5.json` | `events.3.result` | Same healthy bridge state after the job started using the `AutonomySmokeTest.prproj` project. |
| `/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/jobs/heygen-retention-1785607298179-8e660b.json` | `events.7.result`, `events.15.result`, `events.25.result`, `events.31.result` | Repeated healthy software snapshots with `clients.premiere: 1` and `uxp.bridgeConnected: true` while Premiere projects were opened and edited. |

The old flat service logs under `/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/logs/` only prove that the Video Factory HTTP service listened on `127.0.0.1:3032`. They do not preserve the exact bring-up sequence, timing policy, loader arguments, readiness URL, or recovery context. The startup journal added here fills that gap.

## Startup Journal Outputs

Every `npm run stack:start` run creates a dedicated folder:

```text
/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/<utc-timestamp>-<pid>/
```

Files in that folder:

| File | Purpose |
| --- | --- |
| `startup-config.json` | Sanitized software configuration: repo path, git branch/revision, proxy URL, factory URL, readiness endpoint, app paths, plugin path, UXP CLI path, timing policy, and selected safe environment variables. |
| `startup-run.ndjson` | One JSON event per startup phase, including phase status and duration in milliseconds. |
| `startup-summary.json` | Final run summary with total duration, phase timings, failed phases, service URLs, and loader evidence paths. |
| `uxp-apps-list.txt` | UXP CLI service probe captured during startup. |
| `uxp-loader/` | Loader screenshots, loader NDJSON log, and loader receipt for the visible UXP button press. |

The journal intentionally does not write API keys, bearer tokens, passwords, cookies, or complete environment dumps.

`POST /api/node/ensure` and `node cli.js health --ensure` also create startup journals. When those paths fail, the API error includes `error.details.startupJournal` so a caller or future UI can open the exact run folder.

## Current Bring-Up Sequence

`npm run stack:start` records and runs these phases:

1. `proxy.start`: verify or start `proxy-server/proxy.js`, then wait for `http://127.0.0.1:3031/status`.
2. `factory.start`: verify or start `node cli.js serve`, then wait for `http://127.0.0.1:3032/api/errors`.
3. `uxp.open`: open Adobe UXP Developer Tools so the visible-button loader has a UI to operate.
4. `uxp.service-probe`: capture `uxp apps list` output into the startup folder.
5. `premiere.open`: open Adobe Premiere Pro 2026.
6. `media-encoder.open`: only when `PREMIERE_START_MEDIA_ENCODER=1`.
7. `uxp.loader`: run `scripts/uxp-load-premiere-plugin.js` with the startup folder as its evidence directory.
8. `factory.final-health`: record final `/api/health`; if that is slow or blocked by app readiness, record lightweight `/api/errors`.

The readiness endpoint for starting the factory is `/api/errors`, not `/api/health`. `/api/errors` proves the HTTP server is listening without forcing a Premiere bridge probe during startup.

## Timing Policy

Startup uses short bounded timings by default:

| Setting | Default | Override |
| --- | ---: | --- |
| Poll interval | `0.5` seconds | `PREMIERE_STARTUP_POLL_SECONDS` |
| Proxy readiness attempts | `20` | `PREMIERE_PROXY_READY_ATTEMPTS` |
| Factory readiness attempts | `20` | `VIDEO_FACTORY_READY_ATTEMPTS` |
| App process visibility attempts | `30` | `PREMIERE_APP_READY_ATTEMPTS` |
| UXP host wait | `3000` ms | `PREMIERE_UXP_HOST_TIMEOUT_MS` or `--host-timeout-ms` |
| Loader confirmation timeout | `3000` ms | `PREMIERE_UXP_LOAD_TIMEOUT_MS` or `--timeout-ms` |
| Loader retry delay | `250` ms | `PREMIERE_UXP_RETRY_DELAY_MS` or `--retry-delay-ms` |
| Loader retries | `1` | `PREMIERE_UXP_RETRIES` or `--retries` |
| Loader click timeout | `500` ms | `PREMIERE_UXP_CLICK_TIMEOUT_MS` or `--click-timeout-ms` |
| UXP window-bounds timeout | `750` ms | `PREMIERE_UXP_WINDOW_BOUNDS_TIMEOUT_MS` or `--window-bounds-timeout-ms` |
| After-click settle delay | `100` ms | `PREMIERE_UXP_POST_CLICK_DELAY_MS` or `--post-click-delay-ms` |
| Loader poll interval | `100` ms | `PREMIERE_UXP_POLL_INTERVAL_MS` or `--poll-interval-ms` |
| UI text probe timeout | `300` ms | `PREMIERE_UXP_UI_STATE_TIMEOUT_MS` or `--ui-state-timeout-ms` |
| Proxy status timeout | `300` ms | `PREMIERE_UXP_PROXY_TIMEOUT_MS` or `--proxy-timeout-ms` |

The UI-control path intentionally uses sub-second timings. Use longer timings only when the machine is cold-starting Adobe apps after a reboot.

## Recreate A Known-Good Startup

Use this sequence when the software needs to reproduce the known-good state from the recovered job receipts:

```bash
npm run stack:stop -- --force
npm run stack:start -- --force-click
```

Then inspect the newest startup summary:

```bash
ls -td /Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/* | head -1
```

Healthy target:

- `startup-summary.json` has `status: complete`.
- `factory.final-health` completes or falls back to `/api/errors` while still proving the API is listening.
- The loader receipt under `uxp-loader/` has either a confirmed bridge or a precise terminal error code.
- `/api/health` reports proxy `clients.premiere > 0`, Premiere `responsive: true`, and `uxp.bridgeConnected: true` when the UXP bridge is the active path.

If the loader returns `UXP_HOST_APP_NOT_CONNECTED` or `UXP_PLUGIN_LOAD_FAILED`, the startup journal still remains the primary run record. Use the linked loader evidence for screenshots and Adobe-specific diagnostics, then rerun the force stop/start sequence after Premiere fully closes.
