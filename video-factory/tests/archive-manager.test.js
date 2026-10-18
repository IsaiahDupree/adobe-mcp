const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ArchiveManager, sha256 } = require("../lib/archive-manager");

function createCompletedJob(root, id) {
    const workspace = path.join(root, "factory", "campaigns", "archive-test", id);
    const project = path.join(workspace, "premiere", `${id}.prproj`);
    const render = path.join(workspace, "renders", `${id}.mp4`);
    const qc = path.join(workspace, "qc", "qc-report.json");
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.mkdirSync(path.dirname(render), { recursive: true });
    fs.mkdirSync(path.dirname(qc), { recursive: true });
    fs.writeFileSync(project, `real-project-${id}`);
    fs.writeFileSync(render, Buffer.alloc(8192, 7));
    fs.writeFileSync(qc, JSON.stringify({ passed: true }));
    return {
        id,
        campaignId: "archive-test",
        workspace,
        outputPaths: { project, render, qc },
        production: { sourceAssets: [] },
        archive: {
            enabled: true,
            mode: "copy",
            destinationRoot: path.join(root, "passport", "VideoFactory"),
            includeSourceAssets: false,
        },
    };
}

test("archive copy verifies checksums and keeps local payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-archive-copy-"));
    const job = createCompletedJob(root, "copy-job");
    const brokerAsset = path.join(job.workspace, "source-assets", "broker", "pexels-123.mp4");
    fs.mkdirSync(path.dirname(brokerAsset), { recursive: true });
    fs.writeFileSync(brokerAsset, Buffer.alloc(4096, 9));
    job.archive.includeSourceAssets = true;
    const manager = new ArchiveManager(
        { PASSPORT_ARCHIVE_ROOT: job.archive.destinationRoot },
        null
    );
    const receipt = await manager.archiveJob(job);

    assert.equal(receipt.verified, true);
    assert.equal(receipt.mode, "copy");
    assert.ok(fs.existsSync(job.outputPaths.project));
    assert.ok(fs.existsSync(receipt.archivedProjectPath));
    assert.ok(fs.existsSync(path.join(receipt.archiveDirectory, "source-assets", "broker", "pexels-123.mp4")));
    assert.equal(
        await sha256(job.outputPaths.project),
        await sha256(receipt.archivedProjectPath)
    );
});

test("archive move deletes local payloads only after verification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-archive-move-"));
    const job = createCompletedJob(root, "move-job");
    job.archive.mode = "move";
    const manager = new ArchiveManager(
        { PASSPORT_ARCHIVE_ROOT: job.archive.destinationRoot },
        null
    );
    const receipt = await manager.archiveJob(job);

    assert.equal(receipt.verified, true);
    assert.equal(receipt.mode, "move");
    assert.equal(receipt.localFilesRemoved, 2);
    assert.equal(fs.existsSync(job.outputPaths.project), false);
    assert.equal(fs.existsSync(job.outputPaths.render), false);
    assert.ok(fs.existsSync(job.outputPaths.qc));
    assert.ok(fs.existsSync(receipt.archivedProjectPath));
    assert.ok(fs.existsSync(receipt.archivedRenderPath));
});

test("archive project close falls back to CEP when UXP is disconnected", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-archive-cep-close-"));
    const job = createCompletedJob(root, "cep-close-job");
    const uxpAdapter = {
        async inspectProject() {
            throw new Error("No premiere plugin is connected to the proxy.");
        },
    };
    const calls = [];
    const cepAdapter = {
        async closeProject(projectPath) {
            calls.push(projectPath);
            return { success: true, closed: true, bridge: "cep" };
        },
    };
    const manager = new ArchiveManager(
        { PASSPORT_ARCHIVE_ROOT: job.archive.destinationRoot },
        uxpAdapter,
        cepAdapter
    );

    const receipt = await manager.closeActiveArchivedProject(job);

    assert.equal(receipt.bridge, "cep");
    assert.deepEqual(calls, [job.outputPaths.project]);
});
