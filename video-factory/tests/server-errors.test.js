const assert = require("node:assert/strict");
const test = require("node:test");
const { API_ERROR_CODES, createFactoryServer } = require("../lib/server");

function baseDependencies(overrides = {}) {
    const store = {
        list: () => [],
        dueJobs: () => [],
        submit: () => ({ id: "accepted-job", status: "REQUESTED" }),
        get: (id) => {
            throw new Error(`Job ${id} was not found.`);
        },
        cancel: (id) => ({ id, status: "CANCELLED" }),
        approve: (id) => ({ id, status: "COMPLETE" }),
        ...(overrides.store || {}),
    };
    const runner = {
        activeJobId: null,
        tick: async () => ({ ran: false }),
        run: async () => ({ ran: true }),
        archive: async () => ({ archived: true }),
        ...(overrides.runner || {}),
    };
    const appManager = {
        health: async () => ({ status: "healthy" }),
        ensureReady: async () => ({ status: "ready" }),
        openProject: async () => ({ success: true }),
        ...(overrides.appManager || {}),
    };
    return {
        store,
        runner,
        appManager,
        config: {},
    };
}

async function startFactory(dependencies) {
    const { server } = createFactoryServer(dependencies);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

async function jsonResponse(response) {
    return {
        status: response.status,
        requestIdHeader: response.headers.get("x-request-id"),
        body: await response.json(),
    };
}

test("GET /api/errors exposes the stable API error catalog", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/errors`));
        assert.equal(response.status, 200);
        assert.equal(response.body.schemaVersion, 1);
        assert.equal(response.body.errorCodes.API_INVALID_JSON.status, 400);
        assert.equal(response.body.errorCodes.API_BODY_TOO_LARGE.status, 413);
        assert.equal(response.body.errorCodes.APP_NOT_READY.status, 503);
        assert.equal(response.body.errorCodes.UXP_LOAD_CLICK_FAILED.status, 503);
        assert.equal(response.body.errorCodes.UXP_LOAD_CLICK_TIMED_OUT.status, 503);
        assert.equal(response.body.errorCodes.UXP_PLUGIN_LOAD_FAILED.status, 503);
        assert.equal(response.body.errorCodes.UXP_HOST_APP_NOT_CONNECTED.status, 503);
        assert.equal(response.body.errorCodes.UXP_HOST_APP_UNAVAILABLE.status, 503);
        assert.equal(response.body.errorCodes.UXP_PLUGIN_LOAD_NOT_CONFIRMED.status, 503);
        assert.equal(response.body.errorCodes.UXP_PLUGIN_DISPLAY_NOT_CONFIRMED.status, 503);
        assert.equal(response.body.errorCodes.UXP_LOAD_RETRY_EXHAUSTED.status, 503);
        assert.equal(response.body.errorCodes.PREMIERE_PROJECT_SAVE_REQUIRED.status, 422);
        assert.equal(response.body.errorCodes.PREMIERE_PROJECT_HANDOFF_FAILED.status, 503);
        assert.equal(response.body.errorCodes.PREMIERE_PROJECT_CLOSE_VERIFY_FAILED.status, 503);
        assert.deepEqual(response.body.errorCodes, API_ERROR_CODES);
    } finally {
        await factory.close();
    }
});

test("unknown API routes return API_NOT_FOUND with request id", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/nope`));
        assert.equal(response.status, 404);
        assert.equal(response.body.code, "API_NOT_FOUND");
        assert.equal(response.body.message, "No API route matches GET /api/nope.");
        assert.equal(response.body.error.code, "API_NOT_FOUND");
        assert.equal(response.body.error.status, 404);
        assert.equal(response.body.error.requestId, response.body.requestId);
        assert.equal(response.requestIdHeader, response.body.requestId);
    } finally {
        await factory.close();
    }
});

test("invalid JSON request bodies return API_INVALID_JSON", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not-json",
        }));
        assert.equal(response.status, 400);
        assert.equal(response.body.code, "API_INVALID_JSON");
        assert.match(response.body.message, /Invalid JSON request body/);
        assert.equal(response.body.error.status, 400);
    } finally {
        await factory.close();
    }
});

test("oversized request bodies return API_BODY_TOO_LARGE", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
        }));
        assert.equal(response.status, 413);
        assert.equal(response.body.code, "API_BODY_TOO_LARGE");
        assert.equal(response.body.error.status, 413);
    } finally {
        await factory.close();
    }
});

test("local app readiness failures return APP_NOT_READY", async () => {
    const error = new Error("Premiere automation bridge is not connected.");
    error.code = "APP_NOT_READY";
    const factory = await startFactory(baseDependencies({
        appManager: {
            ensureReady: async () => {
                throw error;
            },
        },
    }));
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/node/ensure`, {
            method: "POST",
        }));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "APP_NOT_READY");
        assert.equal(response.body.message, "Premiere automation bridge is not connected.");
        assert.equal(response.body.error.status, 503);
    } finally {
        await factory.close();
    }
});

test("Premiere UXP load failures expose receipt and recovery details", async () => {
    const error = new Error("All configured UXP plugin load attempts were exhausted.");
    error.code = "UXP_LOAD_RETRY_EXHAUSTED";
    error.details = {
        receiptPath: "/tmp/uxp-loader/uxp-load-receipt.json",
        evidenceDir: "/tmp/uxp-loader",
        runLog: "/tmp/uxp-loader/uxp-load-run.ndjson",
        attempts: [{
            attempt: 1,
            status: "NOT_CONFIRMED",
            clicked: true,
            screenshots: {
                before: "/tmp/uxp-loader/attempt-1-before-load.png",
                afterClick: "/tmp/uxp-loader/attempt-1-after-click.png",
            },
            bridgeConnected: false,
            uiLoadedVisible: false,
        }],
        recovery: [{
            method: "reopen-uxp",
            status: "COMPLETE",
            beforeAttempt: 2,
        }],
    };
    const factory = await startFactory(baseDependencies({
        appManager: {
            ensureReady: async () => {
                throw error;
            },
        },
    }));
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/node/ensure`, {
            method: "POST",
        }));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "UXP_LOAD_RETRY_EXHAUSTED");
        assert.equal(response.body.error.code, "UXP_LOAD_RETRY_EXHAUSTED");
        assert.equal(response.body.error.details.receiptPath, "/tmp/uxp-loader/uxp-load-receipt.json");
        assert.equal(response.body.error.details.runLog, "/tmp/uxp-loader/uxp-load-run.ndjson");
        assert.equal(response.body.error.details.attempts[0].clicked, true);
        assert.equal(response.body.error.details.attempts[0].bridgeConnected, false);
        assert.equal(response.body.error.details.recovery[0].method, "reopen-uxp");
    } finally {
        await factory.close();
    }
});

test("Premiere UXP click failures keep a specific API error code", async () => {
    const error = new Error("macOS Accessibility permissions prevented AppleScript UI control.");
    error.code = "UXP_ACCESSIBILITY_DENIED";
    error.details = {
        evidenceDir: "/tmp/uxp-loader/accessibility-failure",
        runLog: "/tmp/uxp-loader/accessibility-failure/uxp-load-run.ndjson",
    };
    const factory = await startFactory(baseDependencies({
        appManager: {
            ensureReady: async () => {
                throw error;
            },
        },
    }));
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/node/ensure`, {
            method: "POST",
        }));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "UXP_ACCESSIBILITY_DENIED");
        assert.equal(response.body.error.details.evidenceDir, "/tmp/uxp-loader/accessibility-failure");
    } finally {
        await factory.close();
    }
});

test("Premiere UXP display confirmation failures are distinct from bridge failures", async () => {
    const error = new Error("Premiere bridge connected, but UXP Developer Tools did not visibly report the plugin as Loaded.");
    error.code = "UXP_PLUGIN_DISPLAY_NOT_CONFIRMED";
    error.details = {
        receiptPath: "/tmp/uxp-loader/display/uxp-load-receipt.json",
        evidenceDir: "/tmp/uxp-loader/display",
        attempts: [{
            attempt: 1,
            status: "NOT_CONFIRMED",
            bridgeConnected: true,
            uiLoadedVisible: false,
            uiStateAfter: {
                observable: false,
                loadedVisible: false,
                notLoadedVisible: false,
            },
        }],
    };
    const factory = await startFactory(baseDependencies({
        appManager: {
            ensureReady: async () => {
                throw error;
            },
        },
    }));
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/node/ensure`, {
            method: "POST",
        }));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "UXP_PLUGIN_DISPLAY_NOT_CONFIRMED");
        assert.equal(response.body.error.details.attempts[0].bridgeConnected, true);
        assert.equal(response.body.error.details.attempts[0].uiLoadedVisible, false);
    } finally {
        await factory.close();
    }
});

test("Premiere UXP Plugin Load Failed host connection reason is preserved", async () => {
    const error = new Error("UXP Developer Tools reported that no Premiere host application is connected to the service.");
    error.code = "UXP_HOST_APP_NOT_CONNECTED";
    error.details = {
        receiptPath: "/tmp/uxp-loader/host/uxp-load-receipt.json",
        evidenceDir: "/tmp/uxp-loader/host",
        runLog: "/tmp/uxp-loader/host/uxp-load-run.ndjson",
        diagnosticLogs: {
            outputPath: "/tmp/uxp-loader/host/diagnostic-logs.json",
            sources: [{
                sourcePath: "/Users/test/Library/Application Support/Adobe/Adobe UXP Developer Tool/Logs/appLogs-2026-08-08.log",
                matchedLines: [
                    "{\"level\":\"error\",\"message\":\"ui : Plugin Load Failed.\"}",
                    "{\"_code\":\"ERR3_LOADFAIL\",\"_details\":{\"_code\":8},\"_message\":\"Plugin Load Failed.\",\"level\":\"error\",\"message\":\"ui : No applications are connected to the service. Make sure the target application is running and connected to the service.\"}",
                ],
            }],
        },
        attempts: [{
            attempt: 1,
            clicked: true,
            clickBackend: "cliclick",
            bridgeConnected: false,
            screenshots: {
                before: "/tmp/uxp-loader/host/attempt-1-before-load.png",
                afterClick: "/tmp/uxp-loader/host/attempt-1-after-click.png",
            },
        }],
        recovery: [{
            method: "reopen-uxp",
            status: "COMPLETE",
        }],
    };
    const factory = await startFactory(baseDependencies({
        appManager: {
            ensureReady: async () => {
                throw error;
            },
        },
    }));
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/node/ensure`, {
            method: "POST",
        }));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "UXP_HOST_APP_NOT_CONNECTED");
        assert.equal(response.body.error.details.receiptPath, "/tmp/uxp-loader/host/uxp-load-receipt.json");
        assert.match(
            response.body.error.details.diagnosticLogs.sources[0].matchedLines.join("\n"),
            /Plugin Load Failed/
        );
        assert.match(
            response.body.error.details.diagnosticLogs.sources[0].matchedLines.join("\n"),
            /No applications are connected/
        );
    } finally {
        await factory.close();
    }
});

test("missing resources return API_RESOURCE_NOT_FOUND", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await jsonResponse(await fetch(`${factory.baseUrl}/api/jobs/missing-job`));
        assert.equal(response.status, 404);
        assert.equal(response.body.code, "API_RESOURCE_NOT_FOUND");
        assert.equal(response.body.error.code, "API_RESOURCE_NOT_FOUND");
        assert.match(response.body.message, /missing-job was not found/);
    } finally {
        await factory.close();
    }
});
