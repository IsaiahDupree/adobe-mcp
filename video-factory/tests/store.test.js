const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobStore } = require("../lib/store");

test("job store persists a scheduled production job and workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-store-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });
    const job = store.submit({
        campaign_id: "integration",
        request: { topic: "Durable job" },
        schedule: { production_start: "2099-01-01T00:00:00Z" },
        production: { source_assets: [] },
    });

    assert.equal(job.status, "SCHEDULED");
    assert.equal(store.get(job.id).request.topic, "Durable job");
    assert.ok(fs.existsSync(path.join(job.workspace, "request", "job-request.json")));
    assert.ok(fs.existsSync(path.join(job.workspace, "premiere")));
    assert.equal(store.dueJobs().length, 0);
});

test("job schema rejects non-absolute asset paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-schema-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });

    assert.throws(
        () =>
            store.submit({
                request: { topic: "Invalid asset" },
                production: { source_assets: ["relative.mp4"] },
            }),
        /absolute path/
    );
});
