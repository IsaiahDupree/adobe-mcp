const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFactoryServer } = require("../lib/server");

function baseDependencies(project = null) {
    const activeProject = project || {
        hasProject: true,
        name: "api-ready.prproj",
        path: "/tmp/api-ready/api-ready.prproj",
    };
    return {
        store: {
            list: () => [],
            dueJobs: () => [],
            submit: () => ({ id: "accepted-job", status: "REQUESTED" }),
            get: () => {
                throw new Error("not found");
            },
            cancel: (id) => ({ id, status: "CANCELLED" }),
            approve: (id) => ({ id, status: "COMPLETE" }),
        },
        runner: {
            activeJobId: null,
            tick: async () => ({ ran: false }),
            run: async () => ({ ran: true }),
            archive: async () => ({ archived: true }),
        },
        appManager: {
            adapter: {
                inspectProject: async () => ({
                    project: activeProject,
                    sequences: [],
                    projectItems: [],
                }),
            },
            health: async () => ({ status: "healthy" }),
            ensureReady: async () => ({ status: "ready" }),
            openProject: async () => ({ success: true }),
            proxyStatus: async () => ({
                status: "running",
                port: 3031,
                clients: { premiere: 1 },
            }),
        },
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

function op(n, action, options = {}, operationId = `${action}_${n}`) {
    return {
        index: n - 1,
        operation_id: operationId,
        action,
        safe_to_execute: true,
        command_packet: { action, options },
    };
}

function readyPacket(root) {
    const source = path.join(root, "source.mov");
    const frame = path.join(root, "qc", "first.png");
    const output = path.join(root, "exports", "out.mp4");
    fs.mkdirSync(path.dirname(frame), { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(source, "source media");
    return {
        edit_plan_id: "api-ready",
        not_published: true,
        operations: [
            op(1, "createProject", { path: root, name: "api-ready" }, "create_project"),
            op(2, "importMedia", { filePaths: [source] }, "import_direct_assets"),
            op(3, "createSequence", { sequenceName: "READY" }, "create_sequence"),
            op(4, "addMediaToSequence", { itemName: "source.mov", insertionTimeTicks: "0", videoTrackIndex: 0, audioTrackIndex: 0 }, "place_source"),
            op(5, "exportFrame", { filePath: frame, seconds: 0.5 }, "export_qc_frame_first"),
            op(6, "exportSequence", { outputFile: output }, "export_sequence"),
            op(7, "saveProject", {}, "save_project"),
        ],
    };
}

test("GET /api/premiere/state exposes current Premiere project state", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/state`);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.proxy.bridgeConnected, true);
        assert.equal(body.proxy.premiereClients, 1);
        assert.equal(body.premiere.responsive, true);
        assert.equal(body.premiere.project.path, "/tmp/api-ready/api-ready.prproj");
    } finally {
        await factory.close();
    }
});

test("POST /api/premiere/packet-readiness reports ready and planned project handoff", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-state-api-ready-"));
    const packet = readyPacket(root);
    const factory = await startFactory(baseDependencies({
        hasProject: true,
        name: "api-ready.prproj",
        path: path.join(root, "api-ready.prproj"),
    }));
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/packet-readiness`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packet }),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.status, "READY_TO_RENDER");
        assert.equal(body.readyToRender, true);
        assert.equal(body.projectHandoffPlan.mode, "REQUESTED_PROJECT_ALREADY_ACTIVE");
        assert.deepEqual(
            body.checks.map((item) => [item.id, item.pass]),
            [
                ["live_operation_safety", true],
                ["project_save_planned", true],
                ["bridge_connected", true],
                ["premiere_responsive", true],
                ["source_media_present", true],
                ["exports_local_only", true],
                ["output_directories_ready", true],
            ]
        );
    } finally {
        await factory.close();
    }
});

test("POST /api/premiere/packet-readiness accepts packet_path for integration handoffs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-state-api-path-"));
    const packet = readyPacket(root);
    const packetPath = path.join(root, "ready-packet.json");
    fs.writeFileSync(packetPath, JSON.stringify(packet), "utf8");
    const factory = await startFactory(baseDependencies({
        hasProject: true,
        name: "api-ready.prproj",
        path: path.join(root, "api-ready.prproj"),
    }));
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/packet-readiness`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packet_path: packetPath }),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.status, "READY_TO_RENDER");
        assert.equal(body.readyToRender, true);
        assert.equal(body.requestedProject.filePath, path.join(root, "api-ready.prproj"));
    } finally {
        await factory.close();
    }
});

test("POST /api/premiere/packet-readiness blocks when Premiere bridge state is disconnected", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-state-api-disconnected-"));
    const packet = readyPacket(root);
    const dependencies = baseDependencies();
    dependencies.appManager.proxyStatus = async () => ({
        status: "running",
        port: 3031,
        clients: { premiere: 0 },
    });
    const factory = await startFactory(dependencies);
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/packet-readiness`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packet }),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.status, "BLOCKED");
        assert.equal(body.readyToRender, false);
        const checks = Object.fromEntries(body.checks.map((item) => [item.id, item.pass]));
        assert.equal(checks.bridge_connected, false);
        assert.equal(checks.premiere_responsive, false);
        assert.equal(checks.source_media_present, true);
    } finally {
        await factory.close();
    }
});

test("POST /api/premiere/packet-readiness validates packet presence", async () => {
    const factory = await startFactory(baseDependencies());
    try {
        const response = await fetch(`${factory.baseUrl}/api/premiere/packet-readiness`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        const body = await response.json();
        assert.equal(response.status, 422);
        assert.equal(body.code, "API_VALIDATION_FAILED");
        assert.equal(body.error.details.hasPacket, false);
    } finally {
        await factory.close();
    }
});
