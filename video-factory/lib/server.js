const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { MarketingDepartmentRepresentative } = require("./marketing-review-judge");
const {
    evaluatePacketReadiness,
    inspectPremiereState,
} = require("./premiere-packet-readiness");
const uxpUiDriver = require("./uxp-ui-driver");

const API_ERROR_CODES = Object.freeze({
    API_NOT_FOUND: {
        status: 404,
        description: "No route matches the requested API path or method.",
    },
    API_RESOURCE_NOT_FOUND: {
        status: 404,
        description: "The requested job, board, campaign, composition, or loop does not exist.",
    },
    API_INVALID_JSON: {
        status: 400,
        description: "The request body could not be parsed as JSON.",
    },
    API_BODY_TOO_LARGE: {
        status: 413,
        description: "The JSON request body exceeded the 2 MB API limit.",
    },
    API_VALIDATION_FAILED: {
        status: 422,
        description: "The request was valid JSON but failed contract validation.",
    },
    API_CONFLICT: {
        status: 409,
        description: "The request conflicts with existing factory state.",
    },
    API_REQUEST_FAILED: {
        status: 400,
        description: "The request failed for a known but uncategorized client-side reason.",
    },
    APP_NOT_READY: {
        status: 503,
        description: "Premiere, UXP Developer Tools, the plugin bridge, or another local dependency is not ready.",
    },
    UXP_PLUGIN_MANIFEST_MISSING: {
        status: 503,
        description: "The Premiere MCP Agent manifest is missing from the configured UXP plugin directory.",
    },
    UXP_APP_OPEN_FAILED: {
        status: 503,
        description: "Adobe UXP Developer Tools could not be opened or activated.",
    },
    UXP_ACCESSIBILITY_DENIED: {
        status: 503,
        description: "macOS Accessibility permissions prevented AppleScript UI control.",
    },
    UXP_WINDOW_NOT_FOUND: {
        status: 503,
        description: "Adobe UXP Developer Tools did not expose a controllable window.",
    },
    UXP_SCREENSHOT_FAILED: {
        status: 503,
        description: "The UXP loader could not capture a diagnostic screenshot.",
    },
    UXP_LOAD_CLICK_FAILED: {
        status: 503,
        description: "The UXP loader could not click the plugin Load button.",
    },
    UXP_LOAD_CLICK_TIMED_OUT: {
        status: 503,
        description: "AppleScript click control timed out before the plugin Load button could be pressed.",
    },
    UXP_PLUGIN_LOAD_FAILED: {
        status: 503,
        description: "Adobe UXP Developer Tools displayed or logged Plugin Load Failed.",
    },
    UXP_HOST_APP_NOT_CONNECTED: {
        status: 503,
        description: "UXP Developer Tools reported that no Premiere host application is connected to the service.",
    },
    UXP_HOST_APP_UNAVAILABLE: {
        status: 503,
        description: "UXP Developer Tools reported that the target Premiere host application is unavailable.",
    },
    UXP_PLUGIN_LOAD_NOT_CONFIRMED: {
        status: 503,
        description: "The UXP loader clicked or inspected the plugin row, but bridge or UI loaded state was not confirmed.",
    },
    UXP_PLUGIN_DISPLAY_NOT_CONFIRMED: {
        status: 503,
        description: "Premiere bridge connected, but UXP Developer Tools did not visibly report the plugin as Loaded.",
    },
    UXP_LOAD_RETRY_EXHAUSTED: {
        status: 503,
        description: "All configured UXP plugin load attempts and recovery retries were exhausted.",
    },
    UXP_ROW_NOT_FOUND: {
        status: 503,
        description: "The UXP UI driver could not find the requested plugin row in the Developer Tools table.",
    },
    UXP_ACTION_NOT_AVAILABLE: {
        status: 409,
        description: "The requested action is not available for the plugin row's current state (e.g. load on an already-loaded plugin).",
    },
    UXP_STATE_VERIFY_TIMEOUT: {
        status: 503,
        description: "The UXP UI driver clicked the action but the row state did not change within the verify timeout.",
    },
    UXP_UI_DRIVER_FAILED: {
        status: 503,
        description: "The pixel-locator UXP UI driver failed before producing a parseable receipt.",
    },
    UXP_CAPTURE_FAILED: {
        status: 503,
        description: "The UXP UI driver could not capture a window screenshot.",
    },
    UXP_DRIVER_BUSY: {
        status: 429,
        description: "Another UXP UI driver invocation holds the single-flight lock.",
    },
    UXP_WINDOW_OBSCURED: {
        status: 503,
        description: "The UXP window capture failed the workspace sanity check (occluded, wrong tab, or wrong window).",
    },
    UXP_CLICK_FAILED: {
        status: 503,
        description: "The UXP UI driver's click backend failed to post the click event.",
    },
    PREMIERE_PROJECT_SAVE_REQUIRED: {
        status: 422,
        description: "A live packet creates or opens a Premiere project but does not include saveProject/saveProjectAs.",
    },
    PREMIERE_PROJECT_HANDOFF_FAILED: {
        status: 503,
        description: "The runner could not safely save, close, or verify the active Premiere project before switching.",
    },
    PREMIERE_PROJECT_CLOSE_VERIFY_FAILED: {
        status: 503,
        description: "Premiere still reported the previous project active after closeProject and verification.",
    },
    WORKFLOW_VALIDATION_FAILED: {
        status: 422,
        description: "A deterministic production or QC gate rejected the workflow result.",
    },
    WAITING_FOR_ASSETS: {
        status: 409,
        description: "The job cannot continue until required local source assets are available.",
    },
    RENDER_TIMEOUT: {
        status: 504,
        description: "Adobe export did not complete before the configured render timeout.",
    },
});

function requestId() {
    return `vf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
}

class ApiError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.details = details;
        this.status = API_ERROR_CODES[code]?.status || 400;
    }
}

function normalizeApiError(error) {
    if (error instanceof ApiError) return error;
    if (error && API_ERROR_CODES[error.code]) {
        const apiError = new ApiError(error.code, error.message || error.code, error.details);
        if (error.status) apiError.status = error.status;
        return apiError;
    }

    const message = error?.message || String(error || "Request failed.");
    if (/not found/i.test(message)) {
        return new ApiError("API_RESOURCE_NOT_FOUND", message, error?.details);
    }
    if (/already exists/i.test(message)) {
        return new ApiError("API_CONFLICT", message, error?.details);
    }
    if (/(requires?|required|must|invalid|not approval_required)/i.test(message)) {
        return new ApiError("API_VALIDATION_FAILED", message, error?.details);
    }
    return new ApiError("API_REQUEST_FAILED", message, error?.details);
}

function sendError(response, error) {
    const normalized = normalizeApiError(error);
    const id = requestId();
    const body = {
        error: {
            code: normalized.code,
            message: normalized.message,
            status: normalized.status,
            requestId: id,
            details: normalized.details || undefined,
        },
        code: normalized.code,
        message: normalized.message,
        requestId: id,
    };
    response.writeHead(normalized.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": id,
    });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
            throw new ApiError("API_BODY_TOO_LARGE", "Request body exceeds 2 MB.");
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
        throw new ApiError("API_INVALID_JSON", `Invalid JSON request body: ${error.message}`);
    }
}

function createFactoryServer({
    store,
    runner,
    appManager,
    config,
    boardStore = null,
    boardRunner = null,
    compositionStore = null,
    compositionRunner = null,
    framingTracker = null,
    reviseStore = null,
    reviseRunner = null,
    shortFormStore = null,
    shortFormRunner = null,
    shortFormCampaignStore = null,
    shortFormCampaignRunner = null,
}) {
    let schedulerTimer = null;

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        const segments = url.pathname.split("/").filter(Boolean);
        try {
            if (request.method === "GET" && url.pathname === "/api/health") {
                const [node, jobs] = await Promise.all([appManager.health(), store.list()]);
                sendJson(response, 200, {
                    status: "running",
                    node,
                    boards: boardStore ? {
                        total: boardStore.list().length,
                        activeBoardId: boardRunner.activeBoardId,
                    } : null,
                    compositions: compositionStore ? {
                        total: compositionStore.list().length,
                        activeBatchId: compositionRunner.activeBatchId,
                    } : null,
                    framing: framingTracker ? framingTracker.writeSummary() : null,
                    revise: reviseStore ? {
                        total: reviseStore.list().length,
                        activeId: reviseRunner.activeId,
                        validatedTemplates: reviseStore.templateLibrary().templates.length,
                        byStatus: reviseStore.list().reduce((out, item) => {
                            out[item.status] = (out[item.status] || 0) + 1;
                            return out;
                        }, {}),
                    } : null,
                    shortFormCampaigns: shortFormCampaignStore ? {
                        total: shortFormCampaignStore.list().length,
                        activeCampaignId: shortFormCampaignRunner.activeCampaignId,
                    } : null,
                    queue: {
                        total: jobs.length,
                        due: store.dueJobs().length,
                        activeJobId: runner.activeJobId,
                        byStatus: jobs.reduce((out, job) => {
                            out[job.status] = (out[job.status] || 0) + 1;
                            return out;
                        }, {}),
                    },
                });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/errors") {
                sendJson(response, 200, {
                    schemaVersion: 1,
                    errorCodes: API_ERROR_CODES,
                });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/marketing/review-edit") {
                const body = await readBody(request);
                const packet = body.packet || body.receipt || body.operation_packet;
                const runSummary = body.runSummary || body.run_summary;
                if (!packet || typeof packet !== "object" || !runSummary || typeof runSummary !== "object") {
                    throw new ApiError(
                        "API_VALIDATION_FAILED",
                        "marketing review requires packet and runSummary/run_summary objects.",
                        {
                            hasPacket: Boolean(packet && typeof packet === "object"),
                            hasRunSummary: Boolean(runSummary && typeof runSummary === "object"),
                        }
                    );
                }
                const reviewer = new MarketingDepartmentRepresentative(body.reviewer || {});
                sendJson(response, 200, reviewer.review({
                    packet,
                    runSummary,
                    outputMeasurement: body.outputMeasurement || body.output_measurement || {},
                    qcFrames: body.qcFrames || body.qc_frames || [],
                }));
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/premiere/state") {
                sendJson(response, 200, await inspectPremiereState(appManager));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/premiere/packet-readiness") {
                const body = await readBody(request);
                let packet = body.packet || body.receipt || body.operation_packet;
                if (!packet && body.packet_path) {
                    const packetPath = path.resolve(String(body.packet_path));
                    packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
                }
                if (!packet || typeof packet !== "object") {
                    throw new ApiError(
                        "API_VALIDATION_FAILED",
                        "packet-readiness requires packet, receipt, operation_packet, or packet_path.",
                        {
                            hasPacket: Boolean(packet && typeof packet === "object"),
                            packet_path: body.packet_path || null,
                        }
                    );
                }
                const state = await inspectPremiereState(appManager);
                sendJson(response, 200, evaluatePacketReadiness(packet, state, {
                    policy: body.policy || {},
                    selection: {
                        only: Array.isArray(body.only) ? new Set(body.only.map(Number)) : null,
                        skip: Array.isArray(body.skip) ? new Set(body.skip.map(Number)) : null,
                        from: body.from == null ? null : Number(body.from),
                        to: body.to == null ? null : Number(body.to),
                    },
                }));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/node/ensure") {
                sendJson(response, 200, await appManager.ensureReady());
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/premiere/open-project") {
                const body = await readBody(request);
                sendJson(response, 200, await appManager.openProject(body.project_path));
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/uxp/ui-state") {
                try {
                    sendJson(response, 200, await uxpUiDriver.inspectUi());
                } catch (error) {
                    throw new ApiError(error.code || "UXP_UI_DRIVER_FAILED", error.message, error.details);
                }
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/uxp/plugin-action") {
                const body = await readBody(request);
                const row = body.row == null ? null : Number(body.row);
                const pluginName = body.plugin_name ? String(body.plugin_name) : null;
                const action = String(body.action || "");
                const allowed = ["load", "unload", "load-watch", "watch", "reload", "debug"];
                if ((!pluginName && (!Number.isInteger(row) || row < 1)) || !allowed.includes(action)) {
                    throw new ApiError(
                        "API_VALIDATION_FAILED",
                        "plugin-action requires plugin_name or integer row >= 1, and action in " + allowed.join("|"),
                        { row: body.row, plugin_name: body.plugin_name, action: body.action }
                    );
                }
                try {
                    sendJson(response, 200, await uxpUiDriver.pluginAction({
                        row,
                        pluginName,
                        action,
                        verifyTimeoutMs: body.verify_timeout_ms,
                        pollIntervalMs: body.poll_interval_ms,
                        evidenceDir: body.evidence_dir,
                    }));
                } catch (error) {
                    throw new ApiError(error.code || "UXP_UI_DRIVER_FAILED", error.message, error.details);
                }
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/jobs") {
                sendJson(response, 200, {
                    jobs: store.list({ status: url.searchParams.get("status") || undefined }),
                });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/jobs") {
                const job = store.submit(await readBody(request));
                sendJson(response, 201, job);
                return;
            }

            if (boardStore && request.method === "GET" && url.pathname === "/api/boards") {
                sendJson(response, 200, {
                    boards: boardStore.list(),
                    activeBoardId: boardRunner.activeBoardId,
                });
                return;
            }

            if (boardStore && request.method === "POST" && url.pathname === "/api/boards") {
                sendJson(response, 201, boardStore.submit(await readBody(request)));
                return;
            }

            if (boardStore && segments[0] === "api" && segments[1] === "boards" && segments[2]) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, boardStore.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => boardRunner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, boardId: id });
                    return;
                }
            }

            if (compositionStore && request.method === "GET" && url.pathname === "/api/compositions") {
                sendJson(response, 200, {
                    compositions: compositionStore.list(),
                    activeBatchId: compositionRunner.activeBatchId,
                });
                return;
            }

            if (compositionStore && request.method === "POST" && url.pathname === "/api/compositions") {
                sendJson(response, 201, compositionStore.submit(await readBody(request)));
                return;
            }

            if (compositionStore && segments[0] === "api" && segments[1] === "compositions" && segments[2]) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, compositionStore.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => compositionRunner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, compositionId: id });
                    return;
                }
            }

            if (shortFormStore && request.method === "GET" && url.pathname === "/api/shorts") {
                sendJson(response, 200, {
                    shortFormBatches: shortFormStore.list(),
                    activeBatchId: shortFormRunner.activeBatchId,
                });
                return;
            }

            if (shortFormStore && request.method === "POST" && url.pathname === "/api/shorts") {
                sendJson(response, 201, shortFormStore.submit(await readBody(request)));
                return;
            }

            if (shortFormStore && segments[0] === "api" && segments[1] === "shorts" && segments[2]) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, shortFormStore.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => shortFormRunner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, shortFormBatchId: id });
                    return;
                }
            }

            if (shortFormCampaignStore && request.method === "GET" && url.pathname === "/api/short-campaigns") {
                sendJson(response, 200, {
                    campaigns: shortFormCampaignStore.list(),
                    activeCampaignId: shortFormCampaignRunner.activeCampaignId,
                });
                return;
            }

            if (shortFormCampaignStore && request.method === "POST" && url.pathname === "/api/short-campaigns") {
                sendJson(response, 201, shortFormCampaignStore.submit(await readBody(request)));
                return;
            }

            if (shortFormCampaignStore && request.method === "GET" && url.pathname === "/api/short-campaigns/presets") {
                sendJson(response, 200, {
                    configured: require("../config/short-form-campaign-presets.json"),
                    validated: shortFormCampaignStore.validatedPresets(),
                });
                return;
            }

            if (
                shortFormCampaignStore &&
                segments[0] === "api" && segments[1] === "short-campaigns" && segments[2]
            ) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, shortFormCampaignStore.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => shortFormCampaignRunner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, campaignId: id });
                    return;
                }
                if (request.method === "POST" && segments[3] === "metrics") {
                    const body = await readBody(request);
                    const rows = Array.isArray(body) ? body : [body];
                    sendJson(response, 201, rows.map((row) => shortFormCampaignStore.recordMetrics(id, row)));
                    return;
                }
                if (request.method === "POST" && segments[3] === "evaluate") {
                    sendJson(response, 200, shortFormCampaignStore.evaluate(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "approve") {
                    const body = await readBody(request);
                    sendJson(response, 200, shortFormCampaignStore.approve(
                        id,
                        body.cellIds || body.cell_ids || body.cellId || "all"
                    ));
                    return;
                }
            }

            if (framingTracker && request.method === "GET" && url.pathname === "/api/framing") {
                sendJson(response, 200, framingTracker.status());
                return;
            }

            if (framingTracker && request.method === "GET" && segments[0] === "api" && segments[1] === "framing" && segments[2]) {
                sendJson(response, 200, framingTracker.status(decodeURIComponent(segments[2])));
                return;
            }

            if (reviseStore && request.method === "GET" && url.pathname === "/api/revise") {
                sendJson(response, 200, { reviseLoops: reviseStore.list(), activeId: reviseRunner.activeId });
                return;
            }

            if (reviseStore && request.method === "POST" && url.pathname === "/api/revise") {
                sendJson(response, 201, reviseStore.submit(await readBody(request)));
                return;
            }

            if (reviseStore && request.method === "GET" && url.pathname === "/api/revise/templates") {
                sendJson(response, 200, reviseStore.templateLibrary());
                return;
            }

            if (reviseStore && segments[0] === "api" && segments[1] === "revise" && segments[2]) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, reviseStore.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "design") {
                    sendJson(response, 200, await reviseRunner.design(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => reviseRunner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, reviseId: id });
                    return;
                }
                if (request.method === "POST" && segments[3] === "metrics") {
                    sendJson(response, 201, reviseStore.recordMetrics(id, await readBody(request)));
                    return;
                }
                if (request.method === "POST" && segments[3] === "evaluate") {
                    const body = await readBody(request);
                    sendJson(response, 200, reviseRunner.evaluate(id, body.window || null));
                    return;
                }
            }

            if (segments[0] === "api" && segments[1] === "jobs" && segments[2]) {
                const id = decodeURIComponent(segments[2]);
                if (request.method === "GET" && segments.length === 3) {
                    sendJson(response, 200, store.get(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "run") {
                    setImmediate(() => runner.run(id).catch(() => {}));
                    sendJson(response, 202, { accepted: true, jobId: id });
                    return;
                }
                if (request.method === "POST" && segments[3] === "cancel") {
                    sendJson(response, 200, store.cancel(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "approve") {
                    sendJson(response, 200, store.approve(id));
                    return;
                }
                if (request.method === "POST" && segments[3] === "archive") {
                    const options = await readBody(request);
                    sendJson(response, 200, await runner.archive(id, options));
                    return;
                }
            }

            if (request.method === "POST" && url.pathname === "/api/worker/tick") {
                sendJson(response, 200, await runner.tick());
                return;
            }

            throw new ApiError(
                "API_NOT_FOUND",
                `No API route matches ${request.method} ${url.pathname}.`
            );
        } catch (error) {
            sendError(response, error);
        }
    });

    function startScheduler(intervalMs = 10000) {
        if (schedulerTimer) return;
        schedulerTimer = setInterval(() => runner.tick().catch(() => {}), intervalMs);
        schedulerTimer.unref();
        setImmediate(() => runner.tick().catch(() => {}));
    }

    function stopScheduler() {
        if (schedulerTimer) clearInterval(schedulerTimer);
        schedulerTimer = null;
    }

    server.on("close", stopScheduler);
    return { server, startScheduler, stopScheduler };
}

module.exports = { API_ERROR_CODES, ApiError, createFactoryServer, normalizeApiError };
