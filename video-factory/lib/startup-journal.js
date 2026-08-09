const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SENSITIVE_KEY = /(secret|token|api[_-]?key|authorization|password|credential|cookie|session)/i;
const SENSITIVE_VALUE = /(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})/i;

const SAFE_ENV_KEYS = Object.freeze([
    "VIDEO_FACTORY_HOME",
    "VIDEO_FACTORY_PORT",
    "PROXY_URL",
    "PREMIERE_STARTUP_LOG_DIR",
    "PREMIERE_STARTUP_POLL_SECONDS",
    "PREMIERE_PROXY_READY_ATTEMPTS",
    "VIDEO_FACTORY_READY_ATTEMPTS",
    "PREMIERE_APP_READY_ATTEMPTS",
    "PREMIERE_UXP_HOST_TIMEOUT_MS",
    "PREMIERE_UXP_LOAD_TIMEOUT_MS",
    "PREMIERE_UXP_LOADER_COMMAND_TIMEOUT_MS",
    "PREMIERE_UXP_RETRY_DELAY_MS",
    "PREMIERE_UXP_RETRIES",
    "PREMIERE_UXP_CLICK_TIMEOUT_MS",
    "PREMIERE_UXP_WINDOW_BOUNDS_TIMEOUT_MS",
    "PREMIERE_UXP_POST_CLICK_DELAY_MS",
    "PREMIERE_UXP_POLL_INTERVAL_MS",
    "PREMIERE_UXP_UI_STATE_TIMEOUT_MS",
    "PREMIERE_UXP_PROXY_TIMEOUT_MS",
    "PREMIERE_START_MEDIA_ENCODER",
    "PREMIERE_APP_NAME",
    "PREMIERE_APP_PATH",
    "MEDIA_ENCODER_APP_NAME",
    "MEDIA_ENCODER_APP_PATH",
    "PREMIERE_UXP_PLUGIN_DIR",
    "UXP_CLI",
    "UXP_LOAD_X_FROM_RIGHT",
    "UXP_LOAD_WATCH_X_FROM_RIGHT",
    "UXP_UNLOAD_X_FROM_RIGHT",
    "UXP_LOAD_Y_FROM_TOP",
    "UXP_LOAD_ROW_HEIGHT",
]);

function nowStamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function shouldRedact(key, value) {
    return SENSITIVE_KEY.test(String(key || "")) || SENSITIVE_VALUE.test(String(value || ""));
}

function sanitize(value, key = "") {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return shouldRedact(key, value) ? "[REDACTED]" : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map((item, index) => sanitize(item, `${key}.${index}`));
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, childValue]) => [
                childKey,
                shouldRedact(childKey, childValue)
                    ? "[REDACTED]"
                    : sanitize(childValue, childKey),
            ])
        );
    }
    return String(value);
}

function parseDetailValue(value) {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
}

function detailsFromPairs(pairs = []) {
    const details = {};
    for (const pair of pairs) {
        const equals = pair.indexOf("=");
        if (equals < 0) {
            details[pair] = true;
            continue;
        }
        const key = pair.slice(0, equals);
        const value = pair.slice(equals + 1);
        details[key] = parseDetailValue(value);
    }
    return sanitize(details);
}

function optionValue(args, name, fallback = null) {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasOption(args, name) {
    return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function safeEnvironment(env = process.env) {
    const result = {};
    for (const key of SAFE_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(env, key)) {
            result[key] = sanitize(env[key], key);
        }
    }
    return result;
}

function fileExists(filePath) {
    return Boolean(filePath) && fs.existsSync(filePath);
}

function gitValue(repoRoot, args) {
    try {
        return execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2000,
        }).trim() || null;
    } catch {
        return null;
    }
}

function buildTimingPolicy(env = process.env, loaderArgs = []) {
    return {
        pollSeconds: Number(env.PREMIERE_STARTUP_POLL_SECONDS || 0.5),
        proxyReadyAttempts: Number(env.PREMIERE_PROXY_READY_ATTEMPTS || 20),
        factoryReadyAttempts: Number(env.VIDEO_FACTORY_READY_ATTEMPTS || 20),
        appReadyAttempts: Number(env.PREMIERE_APP_READY_ATTEMPTS || 30),
        loaderHostTimeoutMs: Number(
            optionValue(loaderArgs, "--host-timeout-ms", env.PREMIERE_UXP_HOST_TIMEOUT_MS || 3000)
        ),
        loaderAttemptTimeoutMs: Number(
            optionValue(loaderArgs, "--timeout-ms", env.PREMIERE_UXP_LOAD_TIMEOUT_MS || 3000)
        ),
        loaderRetryDelayMs: Number(
            optionValue(loaderArgs, "--retry-delay-ms", env.PREMIERE_UXP_RETRY_DELAY_MS || 250)
        ),
        loaderRetries: Number(optionValue(loaderArgs, "--retries", env.PREMIERE_UXP_RETRIES || 1)),
        loaderClickTimeoutMs: Number(
            optionValue(loaderArgs, "--click-timeout-ms", env.PREMIERE_UXP_CLICK_TIMEOUT_MS || 500)
        ),
        loaderWindowBoundsTimeoutMs: Number(
            optionValue(loaderArgs, "--window-bounds-timeout-ms", env.PREMIERE_UXP_WINDOW_BOUNDS_TIMEOUT_MS || 750)
        ),
        loaderPostClickDelayMs: Number(
            optionValue(loaderArgs, "--post-click-delay-ms", env.PREMIERE_UXP_POST_CLICK_DELAY_MS || 100)
        ),
        loaderPollIntervalMs: Number(
            optionValue(loaderArgs, "--poll-interval-ms", env.PREMIERE_UXP_POLL_INTERVAL_MS || 100)
        ),
        loaderUiStateTimeoutMs: Number(
            optionValue(loaderArgs, "--ui-state-timeout-ms", env.PREMIERE_UXP_UI_STATE_TIMEOUT_MS || 300)
        ),
        loaderProxyTimeoutMs: Number(
            optionValue(loaderArgs, "--proxy-timeout-ms", env.PREMIERE_UXP_PROXY_TIMEOUT_MS || 300)
        ),
    };
}

function buildStartupConfig(options = {}) {
    const env = options.env || process.env;
    const startedAt = options.startedAt || new Date().toISOString();
    const runId = options.runId || `${nowStamp(new Date(startedAt))}-${process.pid}`;
    const root = path.resolve(options.root || process.cwd());
    const adobeMcpRoot = path.resolve(options.adobeMcpRoot || path.join(root, ".."));
    const factoryHome = path.resolve(
        options.factoryHome || env.VIDEO_FACTORY_HOME || path.join(adobeMcpRoot, "../../premiere-autonomy/factory")
    );
    const logDir = path.resolve(options.logDir || path.join(factoryHome, "logs"));
    const startupLogRoot = path.resolve(
        options.startupLogRoot || env.PREMIERE_STARTUP_LOG_DIR || path.join(factoryHome, "startup")
    );
    const runDir = path.resolve(options.runDir || path.join(startupLogRoot, runId));
    const loaderEvidenceDir = path.resolve(options.loaderEvidenceDir || path.join(runDir, "uxp-loader"));
    let loaderArgs = Array.isArray(options.loaderArgs) ? options.loaderArgs : [];
    if (!hasOption(loaderArgs, "--evidence-dir")) {
        loaderArgs = [...loaderArgs, "--evidence-dir", loaderEvidenceDir];
    }
    const premiereAppPath =
        options.premiereAppPath ||
        env.PREMIERE_APP_PATH ||
        "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app";
    const mediaEncoderAppPath =
        options.mediaEncoderAppPath ||
        env.MEDIA_ENCODER_APP_PATH ||
        "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app";
    const udtAppPath =
        options.udtAppPath ||
        "/Applications/Adobe UXP Developer Tools/Adobe UXP Developer Tools.app";
    const uxpCli = options.uxpCli || env.UXP_CLI || "/opt/homebrew/bin/uxp";
    const pluginDir =
        options.pluginDir ||
        env.PREMIERE_UXP_PLUGIN_DIR ||
        path.join(os.homedir(), "Library/Application Support/Adobe/UXP/Plugins/External/Premiere-MCP-Agent_0.85.3");

    const paths = {
        startupConfig: path.join(runDir, "startup-config.json"),
        startupRunLog: path.join(runDir, "startup-run.ndjson"),
        startupSummary: path.join(runDir, "startup-summary.json"),
        loaderEvidenceDir,
        proxyStdout: path.join(logDir, "proxy.log"),
        proxyStderr: path.join(logDir, "proxy.err.log"),
        factoryStdout: path.join(logDir, "factory.log"),
        factoryStderr: path.join(logDir, "factory.err.log"),
        uxpAppsList: path.join(runDir, "uxp-apps-list.txt"),
    };

    return sanitize({
        schemaVersion: 1,
        tool: "premiere-stack-startup",
        runId,
        startedAt,
        software: {
            package: "premiere-video-factory",
            root,
            adobeMcpRoot,
            git: {
                branch: options.gitBranch || gitValue(adobeMcpRoot, ["branch", "--show-current"]),
                revision: options.gitRevision || gitValue(adobeMcpRoot, ["rev-parse", "--short", "HEAD"]),
            },
            node: {
                executable: process.execPath,
                version: process.version,
                hostname: os.hostname(),
                platform: process.platform,
                arch: process.arch,
            },
        },
        services: {
            proxy: {
                url: options.proxyUrl || env.PROXY_URL || "http://127.0.0.1:3031",
                statusPath: "/status",
            },
            factory: {
                url: options.factoryUrl || `http://127.0.0.1:${env.VIDEO_FACTORY_PORT || 3032}`,
                readyPath: options.factoryReadyPath || "/api/errors",
                readyUrl:
                    options.factoryReadyUrl ||
                    `${options.factoryUrl || `http://127.0.0.1:${env.VIDEO_FACTORY_PORT || 3032}`}/api/errors`,
            },
        },
        applications: {
            premiere: {
                name: options.premiereAppName || env.PREMIERE_APP_NAME || "Adobe Premiere Pro 2026",
                path: premiereAppPath,
                installed: fileExists(premiereAppPath),
            },
            mediaEncoder: {
                name: options.mediaEncoderAppName || env.MEDIA_ENCODER_APP_NAME || "Adobe Media Encoder 2026",
                path: mediaEncoderAppPath,
                installed: fileExists(mediaEncoderAppPath),
                requested: env.PREMIERE_START_MEDIA_ENCODER === "1",
            },
            uxpDeveloperTools: {
                name: options.udtAppName || "Adobe UXP Developer Tools",
                path: udtAppPath,
                installed: fileExists(udtAppPath),
            },
        },
        uxp: {
            cli: uxpCli,
            cliInstalled: fileExists(uxpCli),
            pluginDir,
            manifestPath: path.join(pluginDir, "manifest.json"),
            manifestExists: fileExists(path.join(pluginDir, "manifest.json")),
        },
        timingPolicy: buildTimingPolicy(env, loaderArgs),
        logs: {
            root: startupLogRoot,
            runDir,
            ...paths,
        },
        loader: {
            script: path.join(root, "scripts/uxp-load-premiere-plugin.js"),
            evidenceDir: loaderEvidenceDir,
            args: loaderArgs,
        },
        environment: safeEnvironment(env),
    });
}

function configPathFor(runDir) {
    return path.join(runDir, "startup-config.json");
}

function runLogPathFor(runDir) {
    return path.join(runDir, "startup-run.ndjson");
}

function summaryPathFor(runDir) {
    return path.join(runDir, "startup-summary.json");
}

function readConfig(runDir) {
    return JSON.parse(fs.readFileSync(configPathFor(runDir), "utf8"));
}

function appendStartupEvent({ runDir, phase, status, message, durationMs = null, details = {}, at = null }) {
    const config = readConfig(runDir);
    const event = sanitize({
        schemaVersion: 1,
        at: at || new Date().toISOString(),
        runId: config.runId,
        phase,
        status,
        message,
        durationMs,
        details,
    });
    fs.appendFileSync(runLogPathFor(runDir), `${JSON.stringify(event)}\n`, "utf8");
    return event;
}

function readStartupEvents(runDir) {
    try {
        return fs
            .readFileSync(runLogPathFor(runDir), "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch {
        return [];
    }
}

function writeStartupSummary({ runDir, status, details = {}, completedAt = null }) {
    const config = readConfig(runDir);
    const finishedAt = completedAt || new Date().toISOString();
    const events = readStartupEvents(runDir);
    const startedMs = Date.parse(config.startedAt);
    const finishedMs = Date.parse(finishedAt);
    const phaseTimings = events
        .filter((event) => event.durationMs !== null && event.durationMs !== undefined)
        .map((event) => ({
            phase: event.phase,
            status: event.status,
            durationMs: event.durationMs,
            message: event.message,
        }));
    const summary = sanitize({
        schemaVersion: 1,
        runId: config.runId,
        status,
        startedAt: config.startedAt,
        completedAt: finishedAt,
        durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs)
            ? Math.max(0, finishedMs - startedMs)
            : null,
        phaseTimings,
        failedPhases: phaseTimings.filter((event) => event.status === "failed"),
        details,
        logs: config.logs,
        services: config.services,
        loader: config.loader,
    });
    fs.writeFileSync(summaryPathFor(runDir), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
}

function initStartupJournal(options = {}) {
    const config = buildStartupConfig(options);
    ensureDir(config.logs.runDir);
    ensureDir(config.logs.loaderEvidenceDir);
    fs.writeFileSync(config.logs.startupConfig, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.writeFileSync(config.logs.startupRunLog, "", "utf8");
    appendStartupEvent({
        runDir: config.logs.runDir,
        phase: "startup.config",
        status: "complete",
        message: "Recorded sanitized software startup configuration.",
        details: {
            startupConfig: config.logs.startupConfig,
            startupRunLog: config.logs.startupRunLog,
            startupSummary: config.logs.startupSummary,
            loaderEvidenceDir: config.logs.loaderEvidenceDir,
        },
    });
    return config;
}

module.exports = {
    SAFE_ENV_KEYS,
    appendStartupEvent,
    buildStartupConfig,
    detailsFromPairs,
    initStartupJournal,
    nowStamp,
    readStartupEvents,
    sanitize,
    writeStartupSummary,
};
