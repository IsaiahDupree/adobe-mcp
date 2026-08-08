#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const config = require("../lib/config");

const ERROR_CATALOG = Object.freeze({
    UXP_PLUGIN_MANIFEST_MISSING: "Premiere MCP Agent manifest is missing from the configured UXP plugin directory.",
    UXP_APP_OPEN_FAILED: "Adobe UXP Developer Tools could not be opened or activated.",
    UXP_ACCESSIBILITY_DENIED: "macOS Accessibility permissions prevented AppleScript UI control.",
    UXP_WINDOW_NOT_FOUND: "Adobe UXP Developer Tools did not expose a controllable window.",
    UXP_SCREENSHOT_FAILED: "The loader could not capture a diagnostic screenshot.",
    UXP_LOAD_CLICK_FAILED: "The loader could not click the plugin Load button.",
    UXP_LOAD_CLICK_TIMED_OUT: "AppleScript click control timed out before the plugin Load button could be pressed.",
    UXP_PLUGIN_LOAD_FAILED: "Adobe UXP Developer Tools displayed or logged Plugin Load Failed.",
    UXP_HOST_APP_NOT_CONNECTED: "UXP Developer Tools reported that no Premiere host application is connected to the service.",
    UXP_HOST_APP_UNAVAILABLE: "UXP Developer Tools reported that the target Premiere host application is unavailable.",
    UXP_PLUGIN_LOAD_NOT_CONFIRMED: "The loader clicked or inspected the UXP UI, but the plugin load was not confirmed.",
    UXP_PLUGIN_DISPLAY_NOT_CONFIRMED: "Premiere bridge connected, but UXP Developer Tools did not visibly report the plugin as Loaded.",
    UXP_LOAD_RETRY_EXHAUSTED: "All configured UXP load attempts were exhausted.",
});

function usage() {
    console.error(`Usage:
  node scripts/uxp-load-premiere-plugin.js [options]

Options:
  --dry-run                  Capture evidence and print the intended click only
  --force-click              Click even when the Premiere bridge is already connected
  --require-ui-loaded        Fail unless UXP UI text explicitly reports Loaded
  --button load|load-watch   Button target in the plugin row (default: load)
  --row-index <n>            1-based plugin row index (default: 1)
  --x-from-right <points>    Click X offset from UDT window right edge
  --y-from-top <points>      Click Y offset from UDT window top edge
  --evidence-dir <path>      Screenshot/receipt/log output directory
  --timeout-ms <n>           Bridge verification timeout per attempt (default: 30000)
  --host-timeout-ms <n>      Wait for Premiere to connect to UXP service before clicking (default: 60000)
  --skip-host-wait           Do not wait for Premiere host connection before clicking
  --retries <n>              Retries after the first attempt (default: 2)
  --retry-delay-ms <n>       Delay before a retry (default: 3000)
  --recovery none|reopen-uxp Recovery method between retries (default: reopen-uxp)
  --click-backend <backend>  auto|applescript|cliclick|quartz (default: auto)

Environment tuning:
  UXP_LOAD_X_FROM_RIGHT       Default Load-button X offset (default: 260)
  UXP_LOAD_WATCH_X_FROM_RIGHT Default Load & Watch X offset (default: 140)
  UXP_LOAD_Y_FROM_TOP         Default first-row Y offset (default: 203)
  UXP_LOAD_ROW_HEIGHT         Row height for --row-index > 1 (default: 33)`);
}

function optionValue(args, name, fallback = null) {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

async function run(command, args = [], options = {}) {
    return execFileAsync(command, args, {
        cwd: options.cwd || ROOT,
        timeout: options.timeout || 30000,
        maxBuffer: options.maxBuffer || 1024 * 1024,
        env: { ...process.env, ...(options.env || {}) },
    });
}

function appleScriptString(value) {
    return JSON.stringify(String(value));
}

function classifyAppleScriptError(error, fallbackCode, timeoutCode = fallbackCode) {
    const message = `${error?.message || ""}\n${error?.stderr || ""}`;
    if (/not authorized|assistive access|accessibility|System Events.*not allowed|not permitted/i.test(message)) {
        return "UXP_ACCESSIBILITY_DENIED";
    }
    if (error?.killed || error?.signal || /timed out|timeout|SIGTERM/i.test(message)) {
        return timeoutCode;
    }
    if (/Can't get window|Invalid index|window 1/i.test(message)) return "UXP_WINDOW_NOT_FOUND";
    return fallbackCode;
}

function errorDiagnostics(error) {
    return {
        message: error?.message || String(error || ""),
        code: error?.code,
        signal: error?.signal,
        killed: error?.killed,
        stdout: error?.stdout || undefined,
        stderr: error?.stderr || undefined,
    };
}

async function osascript(script, timeout = 30000) {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script], {
        timeout,
        maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
}

function logEvent(receipt, level, code, message, details = undefined) {
    const event = {
        at: new Date().toISOString(),
        level,
        code,
        message,
        details,
    };
    receipt.events.push(event);
    if (receipt.logs?.run) {
        fs.appendFileSync(receipt.logs.run, `${JSON.stringify(event)}\n`, "utf8");
    }
    return event;
}

function terminalError(code, message, details = undefined) {
    return {
        code,
        message: message || ERROR_CATALOG[code] || code,
        details,
    };
}

function todayLogDate() {
    return new Date().toISOString().slice(0, 10);
}

function tailLines(filePath, limit = 300) {
    try {
        return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-limit);
    } catch {
        return [];
    }
}

function newestFile(directory, pattern) {
    try {
        return fs
            .readdirSync(directory)
            .filter((name) => pattern.test(name))
            .map((name) => path.join(directory, name))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    } catch {
        return null;
    }
}

function diagnosticLogSources() {
    const home = process.env.HOME || "";
    const today = todayLogDate();
    const uxpToolLog = path.join(
        home,
        "Library/Application Support/Adobe/Adobe UXP Developer Tool/Logs",
        `appLogs-${today}.log`
    );
    const pluginLoadingLog = path.join(
        home,
        "Library/Application Support/Adobe/Premiere Pro/26.0/Plugin Loading.log"
    );
    const premiereUxpLog = newestFile(
        path.join(home, "Library/Logs/Adobe/Adobe Premiere Pro 2026"),
        /^UXPLogs_.*\.log$/
    );
    return [uxpToolLog, pluginLoadingLog, premiereUxpLog].filter(Boolean);
}

function collectDiagnosticLogs(receipt) {
    const interesting = /Premiere MCP Agent|Plugin Load Failed|ERR3_LOADFAIL|No applications are connected|Host Application specified is not available|premierepro\(.*\) connected|premierepro\(.*\) got disconnected|Connected to proxy|Registered with proxy|Disconnected from proxy/i;
    const sources = diagnosticLogSources().map((sourcePath) => ({
        sourcePath,
        matchedLines: tailLines(sourcePath)
            .filter((line) => interesting.test(line))
            .slice(-80),
    })).filter((source) => source.matchedLines.length > 0);
    const outputPath = path.join(receipt.evidenceDir, "diagnostic-logs.json");
    const diagnostics = {
        generatedAt: new Date().toISOString(),
        outputPath,
        sources,
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    return diagnostics;
}

function diagnoseFromLogs(diagnostics) {
    const text = diagnostics.sources
        .flatMap((source) => source.matchedLines)
        .join("\n");
    if (/No applications are connected/i.test(text)) return "UXP_HOST_APP_NOT_CONNECTED";
    if (/Host Application specified is not available/i.test(text)) return "UXP_HOST_APP_UNAVAILABLE";
    if (/Plugin Load Failed|ERR3_LOADFAIL/i.test(text)) return "UXP_PLUGIN_LOAD_FAILED";
    return null;
}

async function uxpAppsList() {
    try {
        const { stdout, stderr } = await run(config.UXP_CLI, ["apps", "list"], {
            timeout: 10000,
        });
        return {
            ok: true,
            output: `${stdout}${stderr}`.trim(),
        };
    } catch (error) {
        return {
            ok: false,
            output: `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`.trim(),
        };
    }
}

function premiereHostConnected(output) {
    return /premierepro|Premiere Pro/i.test(output || "");
}

async function waitForPremiereHost(timeoutMs) {
    const started = Date.now();
    const probes = [];
    do {
        const probe = await uxpAppsList();
        probe.at = new Date().toISOString();
        probe.connected = premiereHostConnected(probe.output);
        probes.push(probe);
        if (probe.connected) {
            return {
                connected: true,
                timeoutMs,
                probes,
                lastOutput: probe.output,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() - started < timeoutMs);
    return {
        connected: false,
        timeoutMs,
        probes,
        lastOutput: probes.at(-1)?.output || null,
    };
}

async function activateUdt() {
    try {
        await run("/usr/bin/open", ["-a", config.UDT_APP_NAME], { timeout: 15000 });
        await osascript(
            `tell application ${appleScriptString(config.UDT_APP_NAME)} to activate`
        );
    } catch (error) {
        const code = classifyAppleScriptError(error, "UXP_APP_OPEN_FAILED");
        const wrapped = new Error(ERROR_CATALOG[code] || error.message);
        wrapped.code = code;
        wrapped.cause = error.message;
        throw wrapped;
    }
}

async function quitUdt() {
    await osascript(`
tell application "System Events"
  if exists process ${appleScriptString(config.UDT_APP_NAME)} then
    tell application ${appleScriptString(config.UDT_APP_NAME)} to quit
  end if
end tell`, 10000).catch(() => {});
}

async function recover(receipt, method, attemptNumber, retryDelayMs) {
    const recovery = {
        at: new Date().toISOString(),
        method,
        beforeAttempt: attemptNumber + 1,
        status: "SKIPPED",
    };
    receipt.recovery.push(recovery);
    if (method === "none") {
        logEvent(receipt, "info", "UXP_RECOVERY_SKIPPED", "No recovery method configured.", recovery);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        return recovery;
    }

    recovery.status = "RUNNING";
    logEvent(receipt, "warn", "UXP_RECOVERY_REOPEN_UXP", "Reopening Adobe UXP Developer Tools before retry.", recovery);
    await quitUdt();
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, retryDelayMs)));
    await activateUdt();
    recovery.status = "COMPLETE";
    recovery.completedAt = new Date().toISOString();
    return recovery;
}

async function windowBounds() {
    let output;
    try {
        output = await osascript(`
tell application "System Events"
  tell process ${appleScriptString(config.UDT_APP_NAME)}
    set frontmost to true
    delay 0.4
    set p to position of window 1
    set s to size of window 1
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell`);
    } catch (error) {
        const code = classifyAppleScriptError(error, "UXP_WINDOW_NOT_FOUND");
        const wrapped = new Error(ERROR_CATALOG[code] || error.message);
        wrapped.code = code;
        wrapped.cause = error.message;
        throw wrapped;
    }
    const [x, y, width, height] = output.split(",").map((item) => Number(item.trim()));
    if (![x, y, width, height].every(Number.isFinite)) {
        const error = new Error(`Could not read UXP Developer Tools window bounds: ${output}`);
        error.code = "UXP_WINDOW_NOT_FOUND";
        throw error;
    }
    return { x, y, width, height, right: x + width, bottom: y + height };
}

async function screenshot(filePath) {
    ensureDir(path.dirname(filePath));
    try {
        await run("/usr/sbin/screencapture", ["-x", filePath], { timeout: 15000 });
        return filePath;
    } catch (error) {
        const wrapped = new Error(ERROR_CATALOG.UXP_SCREENSHOT_FAILED);
        wrapped.code = "UXP_SCREENSHOT_FAILED";
        wrapped.cause = error.message;
        throw wrapped;
    }
}

async function applescriptClickAt(x, y) {
    await osascript(`
tell application "System Events"
  tell process ${appleScriptString(config.UDT_APP_NAME)}
    set frontmost to true
  end tell
  click at {${Math.round(x)}, ${Math.round(y)}}
end tell`, 8000);
}

async function cliclickAt(x, y) {
    const binary = process.env.CLICKLICK_BIN || "/opt/homebrew/bin/cliclick";
    if (!fs.existsSync(binary)) {
        const error = new Error(`cliclick is not installed at ${binary}.`);
        error.code = "CLICK_BACKEND_UNAVAILABLE";
        throw error;
    }
    await run(binary, [`c:${Math.round(x)},${Math.round(y)}`], { timeout: 8000 });
}

async function quartzClickAt(x, y) {
    const script = `
import sys
import time
from Quartz import (
    CGEventCreateMouseEvent,
    CGEventPost,
    kCGHIDEventTap,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGMouseButtonLeft,
)

x = float(sys.argv[1])
y = float(sys.argv[2])
down = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft)
up = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, down)
time.sleep(0.08)
CGEventPost(kCGHIDEventTap, up)
`;
    await run(config.PYTHON_BIN || "/usr/bin/python3", ["-c", script, String(Math.round(x)), String(Math.round(y))], {
        timeout: 8000,
    });
}

async function clickAt(x, y, backend = "auto") {
    const failures = [];
    const backends = backend === "auto"
        ? ["applescript", "cliclick", "quartz"]
        : [backend];
    for (const item of backends) {
        try {
            if (item === "applescript") await applescriptClickAt(x, y);
            else if (item === "cliclick") await cliclickAt(x, y);
            else if (item === "quartz") await quartzClickAt(x, y);
            else throw new Error(`Unknown click backend: ${item}`);
            return { backend: item, failures };
        } catch (error) {
            const code = item === "applescript"
                ? classifyAppleScriptError(error, "UXP_LOAD_CLICK_FAILED", "UXP_LOAD_CLICK_TIMED_OUT")
                : "UXP_LOAD_CLICK_FAILED";
            failures.push({
                backend: item,
                code,
                diagnostics: errorDiagnostics(error),
            });
        }
    }

    const last = failures.at(-1);
    const code = backend === "applescript" && failures[0]?.code === "UXP_LOAD_CLICK_TIMED_OUT"
        ? "UXP_LOAD_CLICK_TIMED_OUT"
        : "UXP_LOAD_CLICK_FAILED";
    const wrapped = new Error(ERROR_CATALOG[code] || ERROR_CATALOG.UXP_LOAD_CLICK_FAILED);
    wrapped.code = code;
    wrapped.details = { failures, last };
    throw wrapped;
}

async function accessibleText() {
    try {
        const output = await osascript(`
on flattenValue(v)
  try
    return v as text
  on error
    return ""
  end try
end flattenValue

tell application "System Events"
  tell process ${appleScriptString(config.UDT_APP_NAME)}
    set collected to {}
    try
      set collected to collected & (name of every UI element of window 1)
    end try
    try
      set collected to collected & (value of every UI element of window 1)
    end try
    try
      set collected to collected & (description of every UI element of window 1)
    end try
    set outputText to ""
    repeat with itemValue in collected
      set outputText to outputText & " " & my flattenValue(itemValue)
    end repeat
    return outputText
  end tell
end tell`, 10000);
        return output.replace(/\s+/g, " ").trim();
    } catch (error) {
        return null;
    }
}

function pluginUiStateFromText(text) {
    if (!text) {
        return {
            observable: false,
            pluginNameVisible: null,
            loadedVisible: null,
            notLoadedVisible: null,
            textSample: null,
        };
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    const pluginNameVisible = /Premiere MCP Agent/i.test(normalized);
    const notLoadedVisible = /Not loaded/i.test(normalized);
    const loadedVisible = !notLoadedVisible && /\bLoaded\b/i.test(normalized);
    return {
        observable: pluginNameVisible || loadedVisible || notLoadedVisible,
        pluginNameVisible,
        loadedVisible,
        notLoadedVisible,
        textSample: normalized.slice(0, 500),
    };
}

async function pluginUiState() {
    return pluginUiStateFromText(await accessibleText());
}

function proxyStatus() {
    return new Promise((resolve) => {
        const request = http.get(`${config.PROXY_URL}/status`, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(null);
                }
            });
        });
        request.on("error", () => resolve(null));
        request.setTimeout(3000, () => {
            request.destroy();
            resolve(null);
        });
    });
}

async function waitForPremiereClient(timeoutMs, requireUiLoaded) {
    const started = Date.now();
    let lastStatus = null;
    let lastUiState = null;
    while (Date.now() - started < timeoutMs) {
        lastStatus = await proxyStatus();
        lastUiState = await pluginUiState();
        const bridgeConnected = Number(lastStatus?.clients?.premiere || 0) > 0;
        if (bridgeConnected && (!requireUiLoaded || lastUiState.loadedVisible === true)) {
            return { proxy: lastStatus, uiState: lastUiState };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { proxy: lastStatus, uiState: lastUiState };
}

async function performAttempt(receipt, options, attemptNumber) {
    const attempt = {
        attempt: attemptNumber,
        startedAt: new Date().toISOString(),
        button: options.button,
        status: "RUNNING",
        screenshots: {},
        warnings: [],
    };
    receipt.attempts.push(attempt);
    logEvent(receipt, "info", "UXP_LOAD_ATTEMPT_STARTED", `Starting UXP load attempt ${attemptNumber}.`, {
        attempt: attemptNumber,
    });

    await activateUdt();
    attempt.proxyBefore = await proxyStatus();
    attempt.uiStateBefore = await pluginUiState();
    attempt.window = await windowBounds();
    attempt.screenshots.before = await screenshot(path.join(receipt.evidenceDir, `attempt-${attemptNumber}-before-load.png`));

    const alreadyConnected = Number(attempt.proxyBefore?.clients?.premiere || 0) > 0;
    const click = {
        x: attempt.window.right - options.xFromRight,
        y: attempt.window.y + options.yFromTop + (options.rowIndex - 1) * options.rowHeight,
        xFromRight: options.xFromRight,
        yFromTop: options.yFromTop,
        rowHeight: options.rowHeight,
    };
    attempt.click = click;
    attempt.alreadyConnected = alreadyConnected;
    attempt.clicked = false;
    attempt.skipReason = null;

    if (!attempt.uiStateBefore.observable) {
        attempt.warnings.push({
            code: "UXP_UI_STATE_UNOBSERVABLE",
            message: "The UXP plugin table text was not visible through macOS Accessibility; screenshots remain the source of visual proof.",
        });
    }

    if (alreadyConnected && !options.forceClick) {
        attempt.skipReason = "Premiere bridge was already connected before the UI click.";
        logEvent(receipt, "info", "UXP_LOAD_CLICK_SKIPPED", attempt.skipReason, {
            attempt: attemptNumber,
            proxyBefore: attempt.proxyBefore,
        });
    } else if (options.dryRun) {
        attempt.skipReason = "Dry run requested; no click was performed.";
        logEvent(receipt, "info", "UXP_LOAD_DRY_RUN", attempt.skipReason, {
            attempt: attemptNumber,
            click,
        });
    } else {
        const clickResult = await clickAt(click.x, click.y, options.clickBackend);
        attempt.clicked = true;
        attempt.clickBackend = clickResult.backend;
        attempt.clickBackendFailures = clickResult.failures;
        logEvent(receipt, "info", "UXP_LOAD_BUTTON_CLICKED", "Clicked the UXP plugin row button.", {
            attempt: attemptNumber,
            click,
            backend: clickResult.backend,
            fallbackFailures: clickResult.failures,
        });
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    attempt.screenshots.afterClick = await screenshot(path.join(receipt.evidenceDir, `attempt-${attemptNumber}-after-click.png`));
    const verification = alreadyConnected && !options.forceClick
        ? { proxy: attempt.proxyBefore, uiState: await pluginUiState() }
        : await waitForPremiereClient(options.timeoutMs, options.requireUiLoaded);
    attempt.proxyAfter = verification.proxy;
    attempt.uiStateAfter = verification.uiState;
    attempt.bridgeConnected = Number(attempt.proxyAfter?.clients?.premiere || 0) > 0;
    attempt.uiLoadedVisible = attempt.uiStateAfter?.loadedVisible === true;
    attempt.completedAt = new Date().toISOString();
    attempt.status = attempt.bridgeConnected && (!options.requireUiLoaded || attempt.uiLoadedVisible)
        ? "CONFIRMED"
        : "NOT_CONFIRMED";

    if (attempt.status === "CONFIRMED") {
        logEvent(receipt, "info", "UXP_PLUGIN_LOAD_CONFIRMED", "Premiere UXP plugin load was confirmed.", {
            attempt: attemptNumber,
            bridgeConnected: attempt.bridgeConnected,
            uiLoadedVisible: attempt.uiLoadedVisible,
        });
    } else {
        logEvent(receipt, "warn", "UXP_PLUGIN_LOAD_NOT_CONFIRMED", ERROR_CATALOG.UXP_PLUGIN_LOAD_NOT_CONFIRMED, {
            attempt: attemptNumber,
            bridgeConnected: attempt.bridgeConnected,
            uiStateAfter: attempt.uiStateAfter,
            proxyAfter: attempt.proxyAfter,
        });
    }

    return attempt;
}

function writeReceipt(receipt, receiptPath) {
    receipt.completedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        usage();
        return;
    }

    const dryRun = args.includes("--dry-run");
    const forceClick = args.includes("--force-click");
    const requireUiLoaded = args.includes("--require-ui-loaded");
    const button = optionValue(args, "--button", "load");
    if (!["load", "load-watch"].includes(button)) {
        throw new Error("--button must be load or load-watch");
    }
    const recovery = optionValue(args, "--recovery", "reopen-uxp");
    if (!["none", "reopen-uxp"].includes(recovery)) {
        throw new Error("--recovery must be none or reopen-uxp");
    }
    const clickBackend = optionValue(args, "--click-backend", "auto");
    if (!["auto", "applescript", "cliclick", "quartz"].includes(clickBackend)) {
        throw new Error("--click-backend must be auto, applescript, cliclick, or quartz");
    }

    const rowIndex = Math.max(1, Number(optionValue(args, "--row-index", "1")));
    const xFromRight = Number(
        optionValue(
            args,
            "--x-from-right",
            button === "load-watch"
                ? process.env.UXP_LOAD_WATCH_X_FROM_RIGHT || "140"
                : process.env.UXP_LOAD_X_FROM_RIGHT || "260"
        )
    );
    const yFromTop = Number(
        optionValue(args, "--y-from-top", process.env.UXP_LOAD_Y_FROM_TOP || "203")
    );
    const rowHeight = Number(process.env.UXP_LOAD_ROW_HEIGHT || "33");
    const timeoutMs = Number(optionValue(args, "--timeout-ms", "30000"));
    const hostTimeoutMs = Number(optionValue(args, "--host-timeout-ms", dryRun ? "0" : "60000"));
    const skipHostWait = args.includes("--skip-host-wait") || hostTimeoutMs <= 0;
    const retries = Math.max(0, Number(optionValue(args, "--retries", dryRun ? "0" : "2")));
    const retryDelayMs = Math.max(0, Number(optionValue(args, "--retry-delay-ms", "3000")));
    const evidenceDir = path.resolve(
        optionValue(
            args,
            "--evidence-dir",
            path.join(config.FACTORY_HOME, "uxp-loader", nowStamp())
        )
    );
    ensureDir(evidenceDir);

    const receiptPath = path.join(evidenceDir, "uxp-load-receipt.json");
    const receipt = {
        schemaVersion: 2,
        tool: "uxp-load-premiere-plugin-ui",
        startedAt: new Date().toISOString(),
        dryRun,
        forceClick,
        requireUiLoaded,
        button,
        rowIndex,
        retries,
        retryDelayMs,
        recoveryMethod: recovery,
        clickBackend,
        hostTimeoutMs,
        skipHostWait,
        application: config.UDT_APP_NAME,
        plugin: {
            expectedName: "Premiere MCP Agent",
            installedPluginDir: config.INSTALLED_PLUGIN_DIR,
            manifestPath: path.join(config.INSTALLED_PLUGIN_DIR, "manifest.json"),
            manifestExists: fs.existsSync(path.join(config.INSTALLED_PLUGIN_DIR, "manifest.json")),
        },
        proxyUrl: config.PROXY_URL,
        evidenceDir,
        logs: {
            run: path.join(evidenceDir, "uxp-load-run.ndjson"),
        },
        attempts: [],
        recovery: [],
        events: [],
        status: "RUNNING",
        terminalError: null,
    };
    fs.writeFileSync(receipt.logs.run, "", "utf8");

    const options = {
        dryRun,
        forceClick,
        requireUiLoaded,
        button,
        rowIndex,
        xFromRight,
        yFromTop,
        rowHeight,
        timeoutMs,
        clickBackend,
    };

    try {
        if (!receipt.plugin.manifestExists) {
            throw Object.assign(new Error(ERROR_CATALOG.UXP_PLUGIN_MANIFEST_MISSING), {
                code: "UXP_PLUGIN_MANIFEST_MISSING",
                details: { manifestPath: receipt.plugin.manifestPath },
            });
        }
        logEvent(receipt, "info", "UXP_PLUGIN_MANIFEST_FOUND", "Found installed Premiere MCP Agent manifest.", {
            manifestPath: receipt.plugin.manifestPath,
        });

        if (!skipHostWait) {
            receipt.hostConnection = await waitForPremiereHost(hostTimeoutMs);
            if (receipt.hostConnection.connected) {
                logEvent(receipt, "info", "UXP_HOST_APP_CONNECTED", "Premiere is connected to the UXP Developer Tools service.", {
                    hostTimeoutMs,
                    lastOutput: receipt.hostConnection.lastOutput,
                });
            } else {
                await activateUdt();
                receipt.screenshots = {
                    hostNotConnected: await screenshot(path.join(receipt.evidenceDir, "host-not-connected.png")),
                };
                receipt.diagnosticLogs = collectDiagnosticLogs(receipt);
                receipt.status = "NEEDS_ATTENTION";
                receipt.terminalError = terminalError("UXP_HOST_APP_NOT_CONNECTED", ERROR_CATALOG.UXP_HOST_APP_NOT_CONNECTED, {
                    hostConnection: receipt.hostConnection,
                    screenshot: receipt.screenshots.hostNotConnected,
                    logPath: receipt.logs.run,
                    diagnosticLogs: receipt.diagnosticLogs,
                });
                logEvent(receipt, "error", "UXP_HOST_APP_NOT_CONNECTED", receipt.terminalError.message, receipt.terminalError.details);
                writeReceipt(receipt, receiptPath);
                process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
                process.exitCode = 2;
                return;
            }
        }

        for (let attemptNumber = 1; attemptNumber <= retries + 1; attemptNumber += 1) {
            let attempt;
            try {
                attempt = await performAttempt(receipt, options, attemptNumber);
            } catch (error) {
                const code = error.code || "UXP_PLUGIN_LOAD_NOT_CONFIRMED";
                logEvent(receipt, "error", code, error.message || ERROR_CATALOG[code] || code, {
                    attempt: attemptNumber,
                    cause: error.cause || undefined,
                    details: error.details || undefined,
                });
                const failedAttempt = {
                    attempt: attemptNumber,
                    status: "ERROR",
                    error: terminalError(code, error.message, {
                        cause: error.cause || undefined,
                        details: error.details || undefined,
                    }),
                    completedAt: new Date().toISOString(),
                };
                const openAttempt = receipt.attempts.find((item) => item.attempt === attemptNumber && item.status === "RUNNING");
                if (openAttempt) Object.assign(openAttempt, failedAttempt);
                else receipt.attempts.push(failedAttempt);
            }

            const confirmed = attempt?.status === "CONFIRMED" || (dryRun && attempt);
            if (confirmed) {
                receipt.status = "COMPLETE";
                receipt.result = {
                    confirmedBy: attempt?.bridgeConnected
                        ? ["premiere-proxy"]
                        : ["dry-run"],
                    bridgeConnected: Boolean(attempt?.bridgeConnected),
                    uiLoadedVisible: Boolean(attempt?.uiLoadedVisible),
                    receiptPath,
                };
                writeReceipt(receipt, receiptPath);
                process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
                return;
            }

            if (attemptNumber <= retries) {
                logEvent(receipt, "warn", "UXP_LOAD_RETRY_SCHEDULED", "Scheduling another UXP load attempt.", {
                    nextAttempt: attemptNumber + 1,
                    retryDelayMs,
                    recovery,
                });
                await recover(receipt, recovery, attemptNumber, retryDelayMs);
            }
        }

        receipt.status = "NEEDS_ATTENTION";
        receipt.diagnosticLogs = collectDiagnosticLogs(receipt);
        const logDiagnosis = diagnoseFromLogs(receipt.diagnosticLogs);
        const finalAttempt = receipt.attempts.at(-1) || null;
        const terminalCode = logDiagnosis || (options.requireUiLoaded && finalAttempt?.bridgeConnected
            ? "UXP_PLUGIN_DISPLAY_NOT_CONFIRMED"
            : "UXP_LOAD_RETRY_EXHAUSTED");
        receipt.terminalError = terminalError(terminalCode, ERROR_CATALOG[terminalCode], {
            attempts: receipt.attempts.length,
            finalAttempt,
            logPath: receipt.logs.run,
            diagnosticLogs: receipt.diagnosticLogs,
        });
        writeReceipt(receipt, receiptPath);
        process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
        process.exitCode = 2;
    } catch (error) {
        const code = error.code || "UXP_PLUGIN_LOAD_NOT_CONFIRMED";
        receipt.status = "NEEDS_ATTENTION";
        receipt.diagnosticLogs = collectDiagnosticLogs(receipt);
        receipt.terminalError = terminalError(code, error.message, {
            details: error.details || undefined,
            cause: error.cause || undefined,
            logPath: receipt.logs.run,
            diagnosticLogs: receipt.diagnosticLogs,
        });
        logEvent(receipt, "error", code, receipt.terminalError.message, receipt.terminalError.details);
        writeReceipt(receipt, receiptPath);
        process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
        process.exitCode = 2;
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
