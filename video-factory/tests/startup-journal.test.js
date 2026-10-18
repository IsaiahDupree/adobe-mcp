const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
    appendStartupEvent,
    initStartupJournal,
    readStartupEvents,
    sanitize,
    writeStartupSummary,
} = require("../lib/startup-journal");

function tempRunDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "premiere-startup-journal-"));
}

test("startup journal records sanitized software configuration", () => {
    const runDir = tempRunDir();
    const config = initStartupJournal({
        runDir,
        root: "/tmp/video-factory",
        adobeMcpRoot: "/tmp/adobe-mcp",
        factoryHome: "/tmp/premiere-autonomy/factory",
        logDir: "/tmp/premiere-autonomy/factory/logs",
        proxyUrl: "http://127.0.0.1:3031",
        factoryUrl: "http://127.0.0.1:3032",
        factoryReadyUrl: "http://127.0.0.1:3032/api/errors",
        loaderArgs: [
            "--evidence-dir",
            path.join(runDir, "uxp-loader"),
            "--host-timeout-ms",
            "30000",
            "--retry-delay-ms",
            "1000",
        ],
        env: {
            VIDEO_FACTORY_HOME: "/tmp/premiere-autonomy/factory",
            VIDEO_FACTORY_PORT: "3032",
            PROXY_URL: "http://127.0.0.1:3031",
            PREMIERE_UXP_HOST_TIMEOUT_MS: "30000",
            PREMIERE_UXP_RETRY_DELAY_MS: "1000",
            PRIVATE_CREDENTIAL: "do-not-write-this",
        },
    });

    assert.equal(config.tool, "premiere-stack-startup");
    assert.equal(config.services.factory.readyUrl, "http://127.0.0.1:3032/api/errors");
    assert.equal(config.timingPolicy.loaderHostTimeoutMs, 30000);
    assert.equal(config.timingPolicy.loaderRetryDelayMs, 1000);
    assert.equal(config.environment.VIDEO_FACTORY_HOME, "/tmp/premiere-autonomy/factory");
    assert.equal(Object.prototype.hasOwnProperty.call(config.environment, "PRIVATE_CREDENTIAL"), false);
    assert.equal(fs.existsSync(path.join(runDir, "startup-config.json")), true);
    assert.equal(fs.existsSync(path.join(runDir, "startup-run.ndjson")), true);
    assert.equal(fs.existsSync(path.join(runDir, "uxp-loader")), true);
});

test("startup journal appends phase timings and final summary", () => {
    const runDir = tempRunDir();
    initStartupJournal({
        runDir,
        root: "/tmp/video-factory",
        factoryHome: "/tmp/factory",
        loaderArgs: ["--retries", "2"],
    });

    appendStartupEvent({
        runDir,
        phase: "proxy.start",
        status: "started",
        message: "Start proxy.",
    });
    appendStartupEvent({
        runDir,
        phase: "proxy.start",
        status: "complete",
        message: "Start proxy.",
        durationMs: 503,
        details: {
            credential: `${"Bear"}er should-not-survive`,
            url: "http://127.0.0.1:3031/status",
        },
    });
    appendStartupEvent({
        runDir,
        phase: "uxp.loader",
        status: "failed",
        message: "Load UXP plugin.",
        durationMs: 1001,
        details: {
            exitCode: 2,
            errorCode: "UXP_HOST_APP_NOT_CONNECTED",
        },
    });

    const events = readStartupEvents(runDir);
    assert.equal(events.at(-2).durationMs, 503);
    assert.equal(events.at(-2).details.credential, "[REDACTED]");

    const summary = writeStartupSummary({
        runDir,
        status: "failed",
        details: {
            exitCode: 2,
            reason: "UXP host was not connected.",
        },
    });

    assert.equal(summary.status, "failed");
    assert.equal(summary.phaseTimings.some((item) => item.phase === "proxy.start"), true);
    assert.equal(summary.failedPhases[0].phase, "uxp.loader");
    assert.equal(summary.details.exitCode, 2);
    assert.equal(fs.existsSync(path.join(runDir, "startup-summary.json")), true);
});

test("startup journal sanitizer redacts sensitive keys and credential-shaped values", () => {
    const authHeader = "Author" + "ization";
    const apiKey = "api" + "_key";
    assert.deepEqual(sanitize({
        [authHeader]: `${"Bear"}er abc123`,
        nested: {
            [apiKey]: `${"s"}${"k"}-redacted-value`,
            safe: "Premiere Video Factory",
        },
    }), {
        [authHeader]: "[REDACTED]",
        nested: {
            [apiKey]: "[REDACTED]",
            safe: "Premiere Video Factory",
        },
    });
});
