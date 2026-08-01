const http = require("http");
const { URL } = require("url");

function sendJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Request body exceeds 2 MB.");
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createFactoryServer({ store, runner, appManager, config }) {
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

            if (request.method === "POST" && url.pathname === "/api/node/ensure") {
                sendJson(response, 200, await appManager.ensureReady());
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

            sendJson(response, 404, { error: "Not found." });
        } catch (error) {
            const status = /not found/i.test(error.message) ? 404 : 400;
            sendJson(response, status, {
                error: error.message,
                code: error.code || "REQUEST_FAILED",
            });
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

module.exports = { createFactoryServer };
