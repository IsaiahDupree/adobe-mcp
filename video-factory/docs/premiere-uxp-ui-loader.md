# Premiere UXP UI Loader

The Premiere Video Factory can load the `Premiere MCP Agent` plugin by controlling the visible Adobe UXP Developer Tools application. This keeps the recovery path inside local software: the script opens UXP Developer Tools, captures evidence screenshots, clicks the plugin row's Load button with AppleScript, waits for the Premiere proxy client to reconnect, and writes a JSON receipt plus an NDJSON run log.

This loader is intentionally local-only. It does not publish media, call provider write APIs, or use command-line plugin loading for the final load action.

## Managed Startup

```bash
npm run stack:start
```

`stack:start` does the following:

1. Starts the local Premiere command proxy when `http://127.0.0.1:3031/status` is down.
2. Starts the Video Factory HTTP service when `http://127.0.0.1:3032/api/errors` is down.
3. Opens Adobe UXP Developer Tools and Adobe Premiere Pro 2026.
4. Captures a software startup journal with sanitized configuration, phase timings, service probes, and paths for all evidence.
5. Runs `scripts/uxp-load-premiere-plugin.js` to operate the visible UXP Developer Tools UI.
6. Retries failed load attempts and reopens UXP Developer Tools between attempts by default.
7. Prints the final factory health response, falling back to `/api/errors` if `/api/health` is slow during app reconnect.

Pass loader options through the startup script:

```bash
npm run stack:start -- --dry-run
npm run stack:start -- --button load-watch
npm run stack:start -- --x-from-right 260 --y-from-top 203
npm run stack:start -- --retries 3 --recovery reopen-uxp
npm run stack:start -- --click-backend auto
npm run stack:start -- --host-timeout-ms 30000
npm run stack:start -- --timeout-ms 15000
```

The managed startup script supplies shorter defaults than the raw loader: `--host-timeout-ms 30000`, `--timeout-ms 15000`, `--retry-delay-ms 1000`, and `--retries 1` unless those options are passed explicitly.

## Managed Stop

```bash
npm run stack:stop
```

`stack:stop` stops the local factory service, stops the ad-hoc factory and proxy processes, and asks Adobe Media Encoder, Adobe Premiere Pro, and Adobe UXP Developer Tools to quit.

Useful stop variants:

```bash
npm run stack:stop -- --keep-adobe
npm run stack:stop -- --force
```

Use `--keep-adobe` when you only want to restart the local services. Use `--force` only after a graceful stop leaves stale local app processes behind.

## Loader Script

```bash
npm run uxp:load-ui
```

The direct script is:

```bash
node scripts/uxp-load-premiere-plugin.js
```

Options:

| Option | Purpose |
| --- | --- |
| `--dry-run` | Capture screenshots and receipt without clicking. |
| `--force-click` | Click even when the Premiere bridge is already connected. |
| `--require-ui-loaded` | Require accessible UXP UI text to explicitly report Loaded. |
| `--button load\|load-watch` | Select the row action. Default is `load`. |
| `--row-index <n>` | Select a plugin row when the target plugin is not first. Default is `1`. |
| `--x-from-right <points>` | Override the click X coordinate relative to the UXP window right edge. |
| `--y-from-top <points>` | Override the first-row click Y coordinate relative to the UXP window top edge. |
| `--evidence-dir <path>` | Store screenshots and receipt in a specific folder. |
| `--timeout-ms <n>` | Bridge verification timeout. Default is `30000`. |
| `--host-timeout-ms <n>` | Wait for Premiere to appear in `uxp apps list` before clicking Load. Default is `60000`. |
| `--skip-host-wait` | Skip the UXP host wait and click anyway, mostly for diagnostics. |
| `--retries <n>` | Retry count after the first attempt. Default is `2`. |
| `--retry-delay-ms <n>` | Delay before retry/recovery. Default is `3000`. |
| `--recovery none\|reopen-uxp` | Recovery method between retries. Default is `reopen-uxp`. |
| `--click-backend auto\|applescript\|cliclick\|quartz` | Click backend. `auto` tries AppleScript first, then `cliclick`, then Python Quartz. |

Environment tuning:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `UXP_LOAD_X_FROM_RIGHT` | `260` | Load button X offset. |
| `UXP_LOAD_WATCH_X_FROM_RIGHT` | `140` | Load & Watch button X offset. |
| `UXP_LOAD_Y_FROM_TOP` | `203` | First plugin row Y offset. |
| `UXP_LOAD_ROW_HEIGHT` | `33` | Row height for additional plugin rows. |

## Receipts And Evidence

By default, each run writes to:

```text
/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/uxp-loader/<timestamp>/
```

When the loader is invoked through `npm run stack:start`, its evidence is colocated under the startup journal:

```text
/Users/isaiahdupree/Documents/Software/premiere-autonomy/factory/startup/<timestamp>-<pid>/uxp-loader/
```

Each run includes:

- `attempt-1-before-load.png`
- `attempt-1-after-click.png`
- Additional `attempt-*-before-load.png` and `attempt-*-after-click.png` files for retries.
- `uxp-load-receipt.json`
- `uxp-load-run.ndjson`

The receipt records the UXP window bounds, click coordinates, installed plugin path, proxy status before and after, whether the bridge was already connected, whether a click was performed, retry/recovery actions, accessible UI state when macOS exposes it, and the final bridge result.

When `--click-backend auto` is used, each click backend failure is preserved on the attempt as `clickBackendFailures`. This lets the operator see whether AppleScript timed out, whether `cliclick` was unavailable, or whether Quartz was needed.

When the Premiere bridge is already connected, the loader captures evidence and skips the click by default. This prevents a healthy row from being accidentally unloaded. Use `--force-click` only when you are deliberately testing the visible button.

## Failure Receipts

When loading cannot be confirmed, the loader exits non-zero and writes `terminalError` in the receipt. The Video Factory API surfaces the same code from `/api/node/ensure` with the receipt path, evidence directory, attempts, recovery records, and run log path in `error.details`.

Important loader errors:

| Code | Meaning |
| --- | --- |
| `UXP_PLUGIN_MANIFEST_MISSING` | The configured plugin directory does not contain `manifest.json`. |
| `UXP_APP_OPEN_FAILED` | Adobe UXP Developer Tools could not be opened or activated. |
| `UXP_ACCESSIBILITY_DENIED` | macOS blocked AppleScript UI control. |
| `UXP_WINDOW_NOT_FOUND` | UXP Developer Tools did not expose a controllable window. |
| `UXP_SCREENSHOT_FAILED` | Screenshot evidence could not be captured. |
| `UXP_LOAD_CLICK_FAILED` | AppleScript could not click the Load button coordinate. |
| `UXP_LOAD_CLICK_TIMED_OUT` | AppleScript click control timed out before the Load button could be pressed. |
| `UXP_PLUGIN_LOAD_FAILED` | UXP Developer Tools displayed or logged `Plugin Load Failed`. |
| `UXP_HOST_APP_NOT_CONNECTED` | UXP Developer Tools logged that no Premiere host application is connected to its service. |
| `UXP_HOST_APP_UNAVAILABLE` | UXP Developer Tools logged that the Premiere host application is unavailable. |
| `UXP_PLUGIN_LOAD_NOT_CONFIRMED` | The click or inspection ran, but bridge/UI loaded state did not confirm success before timeout. |
| `UXP_PLUGIN_DISPLAY_NOT_CONFIRMED` | The Premiere proxy connected, but UXP Developer Tools did not visibly report the plugin as Loaded. |
| `UXP_LOAD_RETRY_EXHAUSTED` | All configured attempts failed after retry/recovery. |

See [api-error-codes.md](api-error-codes.md) for the API response shape and recovery table.
See [premiere-stack-startup-configuration.md](premiere-stack-startup-configuration.md) for the software-level startup journal, recovered known-good configuration signals, and timing policy.

## Plugin Load Failed Recovery

The loader records `UXP_PLUGIN_LOAD_FAILED` when the UXP app shows the red `Plugin Load Failed` toast or Adobe logs contain `ERR3_LOADFAIL`. The most common local reason is `UXP_HOST_APP_NOT_CONNECTED`: UXP Developer Tools is running, but Premiere Pro is not currently connected to the UXP developer service. In that state, clicking Load reaches the right button but UXP has no live Premiere host to attach to.

Before clicking Load, the loader now waits for `uxp apps list` to show Premiere connected. If Premiere never appears, it fails early with `UXP_HOST_APP_NOT_CONNECTED`, captures `host-not-connected.png`, and writes the UXP app/service probes into the receipt. Use `--skip-host-wait` only when you intentionally want to reproduce the red toast failure.

Use the full restart path when the receipt shows `UXP_HOST_APP_NOT_CONNECTED`, `UXP_HOST_APP_UNAVAILABLE`, repeated `UXP_PLUGIN_LOAD_FAILED`, or an unchanged UXP row after a successful click:

```bash
npm run stack:stop -- --force
npm run stack:start -- --force-click --retries 2 --recovery reopen-uxp
```

Why this works:

- It stops stale Video Factory and proxy processes that may hold old ports or sockets.
- It closes Adobe UXP Developer Tools so its developer service restarts cleanly.
- It closes Premiere Pro so it reconnects to the UXP service on launch.
- It opens UXP Developer Tools before pressing Load, then verifies the Premiere proxy connection.

If it still fails, inspect the evidence folder from the API error or loader output:

```text
uxp-load-receipt.json
uxp-load-run.ndjson
diagnostic-logs.json
attempt-*-before-load.png
attempt-*-after-click.png
```

`diagnostic-logs.json` includes filtered lines from Adobe UXP Developer Tool logs, Premiere plugin-loading logs, and Premiere UXP logs. The screenshot pair proves whether the button was visible, whether the click landed on the Load row action, and whether UXP showed an error toast.

## Accessibility Requirements

The loader uses AppleScript through System Events, so macOS must allow the terminal/Codex host application to control the computer:

1. Open System Settings.
2. Go to Privacy & Security.
3. Enable Accessibility for the terminal or Codex host process running the script.
4. Enable Screen Recording for the same host if screenshots are blocked.

If AppleScript can open UXP Developer Tools but cannot see the webview controls, the coordinate fallback still works because it clicks relative to the UXP window bounds and records screenshots for proof.

## Troubleshooting

Run a dry probe first:

```bash
npm run uxp:load-ui -- --dry-run --evidence-dir /tmp/premiere-uxp-loader-probe
```

Open `before-load.png` and check whether the `Premiere MCP Agent` row is first. If it is not first, pass `--row-index`. If the Load button moved, pass adjusted `--x-from-right` and `--y-from-top` values or set the `UXP_LOAD_*` environment variables.

Check the local services:

```bash
curl http://127.0.0.1:3031/status
curl http://127.0.0.1:3032/api/health
```

The healthy target is a Premiere proxy status with `clients.premiere > 0` and a factory health response that reports the UXP bridge as connected.
