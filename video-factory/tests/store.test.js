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

test("job schema normalizes automatic My Passport archival", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-archive-schema-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport", "VideoFactory"),
    });
    const job = store.submit({
        request: { topic: "Archive job" },
        archive: { enabled: true, mode: "move", include_source_assets: true },
    });

    assert.equal(job.archive.enabled, true);
    assert.equal(job.archive.mode, "move");
    assert.equal(job.archive.includeSourceAssets, true);
    assert.equal(job.archive.destinationRoot, path.join(root, "passport", "VideoFactory"));
});

test("job schema normalizes a scene-based HeyGen retention job", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-heygen-schema-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        HEYGEN_AVATAR_ID: "avatar-real-id",
        HEYGEN_VOICE_ID: "voice-real-id",
    });
    const job = store.submit({
        request: { topic: "Retention test" },
        generation: {
            provider: "heygen",
            engine: "avatar_iv",
            scenes: ["Lead with the result.", "Change the frame on the next beat."],
        },
        retention: {
            preset: "social-dynamic",
            caption_mode: "native",
            hook_text: "STOP THE SCROLL",
        },
    });

    assert.equal(job.generation.enabled, true);
    assert.equal(job.generation.scenes.length, 2);
    assert.equal(job.generation.avatarId, "avatar-real-id");
    assert.equal(job.retention.hookText, "STOP THE SCROLL");
    assert.equal(job.retention.captionMode, "native");
    assert.equal(job.retention.preset, "social-dynamic");
    assert.match(job.outputPaths.combinedCaptions, /combined-captions\.srt$/);
});
