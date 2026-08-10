const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("node:events");
const { createFactoryServer } = require("../lib/server");
const { PremierePipelineService } = require("../lib/premiere-pipeline-service");

function baseDependencies() {
    return {
        store: {
            list: () => [],
            dueJobs: () => [],
            submit: () => ({ id: "j", status: "REQUESTED" }),
            get: () => { throw new Error("not found"); },
            cancel: (id) => ({ id }),
            approve: (id) => ({ id }),
        },
        runner: { activeJobId: null, tick: async () => ({ ran: false }) },
        appManager: {
            adapter: { inspectProject: async () => ({ project: null }) },
            health: async () => ({ status: "healthy" }),
            ensureReady: async () => ({ status: "ready" }),
            proxyStatus: async () => ({ status: "running", clients: { premiere: 1 } }),
        },
        config: {},
    };
}

function fakeChild({ code = 0, stdout = "" } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 999;
    child.kill = () => {};
    setImmediate(() => {
        if (stdout) child.stdout.emit("data", stdout);
        child.emit("close", code);
    });
    return child;
}

async function startFactory(premierePipeline) {
    const { server } = createFactoryServer({ ...baseDependencies(), premierePipeline });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}

test("pipeline routes 503 with a typed code when the bridge is not configured", async () => {
    const factory = await startFactory(null);
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/styles`);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.error.code, "PREMIERE_PIPELINE_NOT_CONFIGURED");
    } finally {
        await factory.close();
    }
});

test("compile-request, evidence, styles, and assets routes round-trip", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-api-"));
    const foundry = path.join(root, "foundry");
    fs.mkdirSync(path.join(foundry, "work", "ops-console"), { recursive: true });
    const plan = path.join(foundry, "plan.json");
    const asset = path.join(foundry, "aroll.mp4");
    fs.writeFileSync(asset, "media");
    fs.writeFileSync(plan, JSON.stringify({
        edit_plan_id: "plan-api-001",
        source_assets: [{
            asset_id: "aroll", role: "primary", path: asset,
            provenance: { rights_basis: "owned", rights_confirmed: true },
        }],
    }));
    fs.writeFileSync(
        path.join(foundry, "work", "ops-console", "creator-style-bank.json"),
        JSON.stringify({ style_profiles: [{ id: "kinetic-proof" }], premiere_style_recipes: [] })
    );
    const outputDir = path.join(foundry, "packets");
    const pipeline = new PremierePipelineService({
        foundryRoot: foundry,
        videoFactoryRoot: path.join(root, "vf"),
        spawnImpl: () => {
            fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(path.join(outputDir, "p1.json"), "{}");
            return fakeChild({ code: 0, stdout: "{}" });
        },
    });
    const factory = await startFactory(pipeline);
    try {
        const compile = await fetch(`${factory.baseUrl}/api/premiere/compile-request`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan_path: plan, output_dir: outputDir }),
        });
        assert.equal(compile.status, 200);
        const compiled = await compile.json();
        assert.equal(compiled.status, "compiled");
        assert.equal(compiled.packets.length, 1);

        const styles = await fetch(`${factory.baseUrl}/api/premiere/styles`);
        assert.equal(styles.status, 200);
        assert.equal((await styles.json()).style_profiles[0].id, "kinetic-proof");

        const assets = await fetch(
            `${factory.baseUrl}/api/premiere/assets?edit_plan=${encodeURIComponent(plan)}`
        );
        assert.equal(assets.status, 200);
        const assetBody = await assets.json();
        assert.equal(assetBody.counts.direct_use_eligible, 1);

        const evidenceDir = path.join(foundry, "ev");
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, "run-summary.json"), JSON.stringify({
            status: "COMPLETED", counts: { total: 0, success: 0, failed: 0, skipped: 0 },
        }));
        const evidence = await fetch(
            `${factory.baseUrl}/api/premiere/evidence?dir=${encodeURIComponent(evidenceDir)}`
        );
        assert.equal(evidence.status, 200);
        assert.equal((await evidence.json()).run_summary.status, "COMPLETED");

        const outside = await fetch(
            `${factory.baseUrl}/api/premiere/assets?edit_plan=${encodeURIComponent("/etc/passwd")}`
        );
        assert.equal(outside.status, 400);
        assert.equal((await outside.json()).error.code, "PREMIERE_PATH_OUTSIDE_ALLOWED_ROOTS");
    } finally {
        await factory.close();
    }
});

test("run-packet starts a tracked run reachable via /api/premiere/evidence/:run_id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-api-run-"));
    const foundry = path.join(root, "foundry");
    fs.mkdirSync(foundry, { recursive: true });
    const packet = path.join(foundry, "packet.json");
    fs.writeFileSync(packet, "{}");
    const evidenceDir = path.join(foundry, "evidence-run");

    const pipeline = new PremierePipelineService({
        foundryRoot: foundry,
        videoFactoryRoot: path.join(root, "vf"),
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.pid = 31337;
            child.kill = () => {};
            return child; // stays "running"
        },
    });
    const factory = await startFactory(pipeline);
    try {
        const start = await fetch(`${factory.baseUrl}/api/premiere/run-packet`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                packet_path: packet,
                evidence_dir: evidenceDir,
                args: ["--preflight-only"],
            }),
        });
        assert.equal(start.status, 202);
        const started = await start.json();
        assert.equal(started.status, "running");

        const runs = await fetch(`${factory.baseUrl}/api/premiere/runs`);
        assert.equal((await runs.json()).runs.length, 1);

        const live = await fetch(
            `${factory.baseUrl}/api/premiere/evidence/${encodeURIComponent(started.run_id)}`
        );
        assert.equal(live.status, 200);
        const liveBody = await live.json();
        assert.equal(liveBody.run.status, "running");
        assert.equal(liveBody.run_summary, null);

        const missing = await fetch(`${factory.baseUrl}/api/premiere/evidence/run-9999-x`);
        assert.equal(missing.status, 400); // treated as path -> outside roots
    } finally {
        await factory.close();
    }
});

test("the control-surface UI is served at /ui", async () => {
    const factory = await startFactory(null);
    try {
        const response = await fetch(`${factory.baseUrl}/ui`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/html/);
        const html = await response.text();
        assert.match(html, /Premiere Video Factory/);
        assert.match(html, /Control Surface/i);
        assert.match(html, /api\/premiere\/run-packet/);
    } finally {
        await factory.close();
    }
});
