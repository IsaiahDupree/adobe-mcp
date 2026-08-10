const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
    PremierePipelineService,
} = require("../lib/premiere-pipeline-service");

function tempRoot(prefix = "pipeline-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
    setImmediate(() => {
        if (stdout) child.stdout.emit("data", stdout);
        if (stderr) child.stderr.emit("data", stderr);
        child.emit("close", code);
    });
    return child;
}

function service(root, spawnImpl) {
    return new PremierePipelineService({
        foundryRoot: path.join(root, "foundry"),
        videoFactoryRoot: path.join(root, "video-factory"),
        spawnImpl,
    });
}

test("paths outside the allowed roots are rejected", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "foundry"), { recursive: true });
    const svc = service(root, () => fakeChild());
    assert.throws(
        () => svc.resolveInsideAllowedRoots("/etc/passwd", "planPath"),
        (error) => error.code === "PREMIERE_PATH_OUTSIDE_ALLOWED_ROOTS"
    );
});

test("compileRequest invokes the compiler CLI and lists produced packets", async () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    fs.mkdirSync(path.join(foundry, "scripts"), { recursive: true });
    const plan = path.join(foundry, "plan.edit-plan.json");
    fs.writeFileSync(plan, "{}");
    const outputDir = path.join(foundry, "packets");
    const calls = [];
    const svc = service(root, (command, args) => {
        calls.push({ command, args });
        // simulate the compiler writing a packet file
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, "packet-001.json"), "{}");
        return fakeChild({ code: 0, stdout: '{"status":"compiled"}' });
    });

    const result = await svc.compileRequest({ planPath: plan, outputDir });
    assert.equal(result.status, "compiled");
    assert.equal(result.packets.length, 1);
    assert.equal(result.packets[0].name, "packet-001.json");
    const args = calls[0].args;
    assert.ok(args[0].endsWith("compile-premiere-edit-plans.py"));
    assert.ok(args.includes("--live-safe-only"));
    assert.ok(args.includes("--legacy-normalize"));
    assert.ok(args.includes("--require-importable-files"));
});

test("compileRequest surfaces compiler failure with stderr tail", async () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    fs.mkdirSync(foundry, { recursive: true });
    const plan = path.join(foundry, "plan.json");
    fs.writeFileSync(plan, "{}");
    const svc = service(root, () => fakeChild({ code: 2, stderr: "ValueError: bad rights basis" }));

    await assert.rejects(
        svc.compileRequest({ planPath: plan, outputDir: path.join(foundry, "out") }),
        (error) => error.code === "PREMIERE_COMPILE_FAILED"
            && error.details.stderr_tail.includes("bad rights basis")
    );
});

test("startPacketRun tracks the run and readEvidence reads live progress", async () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    const packet = path.join(foundry, "packet.json");
    fs.mkdirSync(foundry, { recursive: true });
    fs.writeFileSync(packet, "{}");
    const evidence = path.join(foundry, "evidence-001");

    let closeChild;
    const svc = service(root, () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 777;
        child.kill = () => {};
        closeChild = (code) => child.emit("close", code);
        return child;
    });

    const started = svc.startPacketRun({ packetPath: packet, evidenceDir: evidence });
    assert.match(started.run_id, /^run-0001-/);
    assert.equal(started.status, "running");

    // the runner writes evidence while running
    fs.writeFileSync(path.join(evidence, "op-01-create_project.json"), JSON.stringify({
        operation: { operation_id: "create_project", action: "createProject" },
        result: { operation_id: "create_project", action: "createProject", status: "SUCCESS" },
    }));
    fs.writeFileSync(path.join(evidence, "run-summary.json"), JSON.stringify({
        status: "COMPLETED",
        counts: { total: 1, success: 1, failed: 0, skipped: 0 },
        edit_plan_id: "plan-001",
        packet_sha256: "abc123",
        started_at: "2026-08-09T00:00:00Z",
        preflight: { passed: true },
    }));

    const live = svc.readEvidence(started.run_id);
    assert.equal(live.run.status, "running");
    assert.equal(live.run_summary.status, "COMPLETED");
    assert.equal(live.operations.length, 1);
    assert.equal(live.operations[0].status, "SUCCESS");

    closeChild(0);
    await new Promise((resolve) => setImmediate(resolve));
    const finished = svc.getRun(started.run_id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.exit_code, 0);
});

test("startPacketRun rejects non-allowlisted runner flags", () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    const packet = path.join(foundry, "packet.json");
    fs.mkdirSync(foundry, { recursive: true });
    fs.writeFileSync(packet, "{}");
    const svc = service(root, () => fakeChild());

    assert.throws(
        () => svc.startPacketRun({
            packetPath: packet,
            evidenceDir: path.join(foundry, "ev"),
            extraArgs: ["--allow-declared-unsafe"],
        }),
        (error) => error.code === "API_VALIDATION_FAILED"
    );
    // quarantine opt-ins ARE allowed but must be explicit
    const started = svc.startPacketRun({
        packetPath: packet,
        evidenceDir: path.join(foundry, "ev2"),
        extraArgs: ["--preflight-only"],
    });
    assert.equal(started.status, "running");
});

test("readEvidence on an unknown run id fails typed", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "foundry"), { recursive: true });
    const svc = service(root, () => fakeChild());
    assert.throws(
        () => svc.getRun("run-9999-nope"),
        (error) => error.code === "PREMIERE_RUN_NOT_FOUND"
    );
});

test("writeReceipt invokes the live-receipt CLI and parses its summary", async () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    const render = path.join(foundry, "render-dir");
    fs.mkdirSync(render, { recursive: true });
    const svc = service(root, (command, args) => {
        assert.ok(args[0].endsWith("premiere-live-receipt.py"));
        assert.ok(args.includes("--render-dir"));
        return fakeChild({
            code: 0,
            stdout: JSON.stringify({ status: "written", receipt_path: "/x/receipt.json" }),
        });
    });
    const result = await svc.writeReceipt({ renderDir: render });
    assert.equal(result.status, "written");
    assert.equal(result.summary.receipt_path, "/x/receipt.json");
});

test("getStyles reads the style bank and summarizes profiles", () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    const bankDir = path.join(foundry, "work", "ops-console");
    fs.mkdirSync(bankDir, { recursive: true });
    fs.writeFileSync(path.join(bankDir, "creator-style-bank.json"), JSON.stringify({
        style_profiles: [
            { id: "kinetic-proof", name: "Kinetic Proof", pacing: "high_retention", caption_style: "bold" },
            { id: "clean-authority", name: "Clean Authority", pacing: "steady" },
        ],
        premiere_style_recipes: [
            { id: "recipe-1", style_profile_id: "kinetic-proof", name: "KP recipe" },
        ],
    }));
    const svc = service(root, () => fakeChild());
    const styles = svc.getStyles();
    assert.equal(styles.present, true);
    assert.equal(styles.style_profiles.length, 2);
    assert.equal(styles.style_profiles[0].id, "kinetic-proof");
    assert.equal(styles.recipes.length, 1);
});

test("getAssets reports rights, existence, and missing files from an edit plan", () => {
    const root = tempRoot();
    const foundry = path.join(root, "foundry");
    fs.mkdirSync(foundry, { recursive: true });
    const realAsset = path.join(foundry, "aroll.mp4");
    fs.writeFileSync(realAsset, "x".repeat(64));
    const plan = path.join(foundry, "plan.json");
    fs.writeFileSync(plan, JSON.stringify({
        edit_plan_id: "plan-assets-001",
        source_assets: [
            {
                asset_id: "aroll", role: "primary", kind: "video", path: realAsset,
                provenance: { rights_basis: "owned", rights_confirmed: true, usage_role: "production_source" },
            },
            {
                asset_id: "missing-broll", role: "b_roll", kind: "video",
                path: path.join(foundry, "not-there.mp4"),
                provenance: { rights_basis: "owned", rights_confirmed: true },
            },
            {
                asset_id: "style-ref", role: "reference", kind: "video", path: realAsset,
                provenance: { rights_basis: "external_reference", rights_confirmed: false, usage_role: "style_reference" },
            },
        ],
    }));
    const svc = service(root, () => fakeChild());
    const assets = svc.getAssets({ editPlanPath: plan });
    assert.equal(assets.counts.total, 3);
    assert.equal(assets.counts.missing_files, 1);
    assert.equal(assets.counts.direct_use_eligible, 2);
    const styleRef = assets.assets.find((a) => a.asset_id === "style-ref");
    assert.equal(styleRef.direct_use_eligible, false);
});
