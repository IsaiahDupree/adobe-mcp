# Video Factory API Error Codes

The Video Factory API returns structured JSON errors with a stable code, HTTP status, message, request id, and optional diagnostic details.

```json
{
  "error": {
    "code": "UXP_LOAD_RETRY_EXHAUSTED",
    "message": "All configured UXP plugin load attempts were exhausted.",
    "status": 503,
    "requestId": "vf-example",
    "details": {
      "startupJournal": {
        "runDir": "/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/20260808T210000Z-12345",
        "startupConfig": "/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/20260808T210000Z-12345/startup-config.json",
        "startupRunLog": "/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/20260808T210000Z-12345/startup-run.ndjson",
        "startupSummary": "/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/20260808T210000Z-12345/startup-summary.json"
      },
      "receiptPath": "/tmp/uxp-loader/uxp-load-receipt.json",
      "evidenceDir": "/tmp/uxp-loader",
      "runLog": "/tmp/uxp-loader/uxp-load-run.ndjson",
      "attempts": []
    }
  },
  "code": "UXP_LOAD_RETRY_EXHAUSTED",
  "message": "All configured UXP plugin load attempts were exhausted.",
  "requestId": "vf-example"
}
```

The top-level `code`, `message`, and `requestId` are kept for simple clients. New integrations should read `error.code`, `error.status`, and `error.details`.

When `/api/node/ensure` starts or reconnects the local stack, readiness failures include `error.details.startupJournal`. That points to the software startup configuration, phase timing log, final summary, and colocated loader evidence for the same run.

## Error Catalog Endpoint

```bash
curl http://127.0.0.1:3032/api/errors
```

This endpoint returns the current error catalog used by the server.

## Premiere/UXP Load Errors

These are the important recovery codes for the Premiere Pro app, Adobe UXP Developer Tools app, and plugin Load button path.

| Code | HTTP | Meaning | Inspect | Recovery |
| --- | ---: | --- | --- | --- |
| `UXP_PLUGIN_MANIFEST_MISSING` | 503 | The configured `Premiere MCP Agent` plugin folder does not contain `manifest.json`. | `error.details.receiptPath`, `error.details.evidenceDir`, configured plugin path. | Reinstall or point `PREMIERE_UXP_PLUGIN_DIR` at the installed plugin, then retry `npm run stack:start`. |
| `UXP_APP_OPEN_FAILED` | 503 | Adobe UXP Developer Tools could not be opened or activated. | `uxp-load-run.ndjson`, macOS app installation path. | Confirm UXP Developer Tools is installed, then retry. |
| `UXP_ACCESSIBILITY_DENIED` | 503 | macOS blocked AppleScript/System Events UI control. | `uxp-load-run.ndjson`; no click screenshot may be present if permission failed early. | Enable Accessibility and Screen Recording for the Codex/terminal host in System Settings, then retry. |
| `UXP_WINDOW_NOT_FOUND` | 503 | UXP Developer Tools opened, but no controllable window was exposed. | Attempt screenshots if present, run log. | Bring UXP Developer Tools to the foreground or restart it with `npm run stack:start -- --recovery reopen-uxp`. |
| `UXP_SCREENSHOT_FAILED` | 503 | The loader could not capture screenshot evidence. | Run log and macOS Screen Recording permissions. | Enable Screen Recording for the host app, then retry. |
| `UXP_LOAD_CLICK_FAILED` | 503 | No available click backend could press the intended Load button coordinate. | `attempt-*-before-load.png`, `uxp-load-run.ndjson`, `clickBackendFailures`, click coordinates in the receipt. | Confirm Accessibility permission; tune `--x-from-right`, `--y-from-top`, or `--row-index`; retry with `--click-backend auto`. |
| `UXP_LOAD_CLICK_TIMED_OUT` | 503 | AppleScript click control timed out before the Load button could be pressed. | `clickBackendFailures`, run log. | Use `--click-backend auto` so the loader can fall back to `cliclick` or Quartz, or grant Accessibility permissions and retry. |
| `UXP_PLUGIN_LOAD_FAILED` | 503 | UXP Developer Tools displayed or logged `Plugin Load Failed`. | `diagnostic-logs.json`, `attempt-*-after-click.png`, `error.details.diagnosticLogs`. | Close and restart UXP/Premiere with `npm run stack:stop -- --force`, then `npm run stack:start -- --force-click --retries 2`. |
| `UXP_HOST_APP_NOT_CONNECTED` | 503 | UXP logged `No applications are connected to the service`, or Premiere did not appear in `uxp apps list` before the host wait timed out. | `hostConnection`, `host-not-connected.png`, `diagnostic-logs.json`, UXP Developer Tool app log, proxy `clients`. | Full restart: force-stop Adobe apps and local services, then start UXP and Premiere again before clicking Load. |
| `UXP_HOST_APP_UNAVAILABLE` | 503 | UXP logged that the host application is unavailable. Premiere may still be launching, disconnected, or not registered with UXP. | UXP Developer Tool app log, Premiere process status, `attempt-*-after-click.png`. | Wait for Premiere to finish launching, or run the full restart path if it remains unavailable. |
| `UXP_PLUGIN_LOAD_NOT_CONFIRMED` | 503 | A click or inspection ran, but neither the Premiere proxy nor required UI loaded state confirmed success before timeout. | `attempt-*-before-load.png`, `attempt-*-after-click.png`, `proxyAfter`, `uiStateAfter`, run log. | Retry with `npm run uxp:load-ui -- --force-click` only if the screenshot clearly shows Load, or run `npm run stack:start` to reopen UXP and retry. |
| `UXP_PLUGIN_DISPLAY_NOT_CONFIRMED` | 503 | The Premiere proxy connected, but UXP Developer Tools did not visibly report the plugin as Loaded. | `attempt-*-after-click.png`, `uiStateAfter`, `error.details.attempts`. | Inspect the screenshot. If it still shows Not loaded, retry with tuned coordinates or `--button load-watch`; if only Accessibility could not read the webview, rely on proxy confirmation for production and keep the screenshot in the receipt. |
| `UXP_LOAD_RETRY_EXHAUSTED` | 503 | Every configured attempt failed after retry/recovery. | `error.details.attempts`, `error.details.recovery`, `error.details.runLog`, all attempt screenshots. | Inspect final screenshot, tune coordinates, confirm Premiere is open, then retry with adjusted loader options. |

## Premiere Project Handoff Errors

These are emitted by live operation-packet runners and should be surfaced by API
adapters that execute Premiere packets.

| Code | HTTP | Meaning | Inspect | Recovery |
| --- | ---: | --- | --- | --- |
| `PREMIERE_PROJECT_SAVE_REQUIRED` | 422 | The selected packet creates or opens a Premiere project but does not include `saveProject` or `saveProjectAs`. | `run-summary.json`, `preflight.checks[]` with id `project_save_planned`. | Regenerate the packet with an explicit save operation before export/review. |
| `PREMIERE_PROJECT_HANDOFF_FAILED` | 503 | The runner could not safely save, close, or verify the active project before switching to the requested project. | `run-summary.json`, `project_handoff.failedStep`, per-step handoff receipts. | Do not switch packets. Inspect the failed step, restart the local stack if Premiere is unresponsive, then retry after `getProjectInfo` is sane. |
| `PREMIERE_PROJECT_CLOSE_VERIFY_FAILED` | 503 | `closeProject` returned, but verification still showed the previous project active. | `run-summary.json`, `project_handoff.failedStep`, `getProjectInfo` response. | Full restart of Premiere/UXP/local bridge, then retry the packet. |

## Marketing Review API

`POST /api/marketing/review-edit` returns a review receipt with either
`APPROVED_FOR_INTERNAL_MARKETING_HANDOFF` or `NEEDS_EDITING_REVISION`.
Revision verdicts are not transport errors; the response remains `200` and
includes `requiredFixes`. Malformed requests return `API_VALIDATION_FAILED`.

## General API Errors

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `API_NOT_FOUND` | 404 | No route matches the requested API path or method. |
| `API_RESOURCE_NOT_FOUND` | 404 | The requested job, board, campaign, composition, or loop does not exist. |
| `API_INVALID_JSON` | 400 | The request body could not be parsed as JSON. |
| `API_BODY_TOO_LARGE` | 413 | The request body exceeded 2 MB. |
| `API_VALIDATION_FAILED` | 422 | The request was valid JSON but failed contract validation. |
| `API_CONFLICT` | 409 | The request conflicts with existing factory state. |
| `API_REQUEST_FAILED` | 400 | The request failed for a known but uncategorized client-side reason. |
| `APP_NOT_READY` | 503 | Premiere, UXP, bridge, or another local dependency is not ready. |
| `PREMIERE_PROJECT_SAVE_REQUIRED` | 422 | The packet creates or opens a Premiere project without an explicit save operation. |
| `PREMIERE_PROJECT_HANDOFF_FAILED` | 503 | Premiere project save/close/verification failed before a packet switch. |
| `PREMIERE_PROJECT_CLOSE_VERIFY_FAILED` | 503 | Premiere still reported the previous project after close verification. |
| `WORKFLOW_VALIDATION_FAILED` | 422 | A deterministic production or QC gate rejected the workflow result. |
| `WAITING_FOR_ASSETS` | 409 | Required local source assets are missing. |
| `RENDER_TIMEOUT` | 504 | Adobe export did not finish before the render timeout. |

## Premiere Live Operation Packet Errors

These codes are emitted in operation-packet preflight receipts under
`preflight.checks[].detail.violations[]`. API adapters should surface them as a
422 validation failure before executing any Premiere command.

| Code | HTTP | Meaning | Recovery |
| --- | ---: | --- | --- |
| `PREMIERE_DECLARED_UNSAFE_OPERATION` | 422 | The packet selected an operation marked `safe_to_execute=false`. | Regenerate the packet or run it as a dry-run/planned operation only. |
| `PREMIERE_UNSTABLE_CLIP_PROPERTY_MUTATION` | 422 | The packet selected `setVideoClipProperties`, which has returned stale-script-object failures in live runs. | Keep motion/effect intent in the receipt until the UXP clip-property route passes isolated single-op tests. |
| `PREMIERE_CAPTION_OVERLAY_MEDIA_UNSAFE` | 422 | The packet selected caption PNG/JPEG media insertion on the timeline. Dense caption overlay insertion has hung Premiere/bridge runs. | Use caption markers/sidecars or a native caption route; do not insert caption stills in batch exports. |
| `PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_UNSAFE` | 422 | The packet selected still-image timeline media insertion without explicit opt-in. | Convert the visual to a verified native graphics/caption command or run a single-op canary before opting in. |
| `PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_BURST` | 422 | The packet selected more still-image timeline insertions than the live safety policy allows. | Split into canary runs or remove still-image overlays from the live packet. |
| `PREMIERE_CAPTION_OVERLAY_TRIM_UNSAFE` | 422 | The packet selected trim operations against caption overlay stills. | Do not trim caption overlay stills; use markers/sidecars until native caption rendering is stable. |
| `PREMIERE_AUDIO_MEDIA_PLACEMENT_REQUIRES_OPT_IN` | 422 | The packet selected WAV/MP3/AAC media placement without a verified audio-only route. | Keep SFX/music as mix instructions, or run a dedicated audio route canary and opt in explicitly. |
