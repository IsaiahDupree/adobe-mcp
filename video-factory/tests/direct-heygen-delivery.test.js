const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const test = require("node:test");
const { ApplicationManager } = require("../lib/app-manager");
const { DirectHeyGenDelivery } = require("../lib/direct-heygen-delivery");
const { FramingTracker } = require("../lib/framing-tracker");
const { JobStore } = require("../lib/store");
const { VideoJobRunner } = require("../lib/workflow");

function integrationConfig(root) {
    return {
        DEFAULT_DELIVERY_MODE: "direct_heygen",
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        FACTORY_HOME: root,
        FRAMING_DIR: path.join(root, "framing"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "archive"),
        FFPROBE_BIN: "ffprobe",
        FFMPEG_BIN: "ffmpeg",
        IMAGEMAGICK_BIN: "magick",
        MIN_DISK_FREE_GB: 0,
    };
}

function createVerticalVideo(filePath) {
    execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=s=360x640:d=2:r=25",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", filePath,
    ]);
}

test("direct HeyGen delivery packages and approves a real completed Video Agent file without Adobe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-heygen-delivery-"));
    const config = integrationConfig(root);
    const source = path.join(root, "completed-video-agent-output.mp4");
    createVerticalVideo(source);

    const store = new JobStore(config);
    const appManager = new ApplicationManager(config, null, null);
    const framingTracker = new FramingTracker(config);
    const directDelivery = new DirectHeyGenDelivery(config, framingTracker);
    const runner = new VideoJobRunner(
        store,
        appManager,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        framingTracker,
        directDelivery
    );
    const job = store.submit({
        job_id: "direct-heygen-real-video",
        campaign_id: "direct-heygen-integration",
        request: { topic: "A completed HeyGen Video Agent output" },
        autonomy: { mode: "guarded" },
        production: {
            project_name: "direct-heygen-real-video",
            direct_source: {
                local_path: source,
                provider: "heygen-video-agent",
                aspect_ratio: "9:16",
                consent_asserted: true,
            },
        },
    });

    assert.equal(job.production.deliveryMode, "direct_heygen");
    const completed = await runner.run(job.id);
    assert.equal(completed.status, "APPROVAL_REQUIRED");
    assert.equal(completed.result.deliveryMode, "direct_heygen");
    assert.equal(completed.result.projectPath, null);
    assert.equal(completed.result.render.durationSeconds, 2);
    assert.ok(fs.existsSync(completed.result.render.outputFile));
    assert.ok(fs.existsSync(completed.outputPaths.directDeliveryReceipt));
    assert.equal(completed.result.directDelivery.qc.passed, true);
    assert.equal(completed.result.directDelivery.qc.framing.barAreaRatio, 0);
    assert.deepEqual(completed.result.directDelivery.bypassedDependencies, [
        "adobe-premiere-pro",
        "adobe-media-encoder",
        "premiere-uxp-bridge",
    ]);
    assert.equal(completed.checkpoints.project, undefined);
    assert.equal(completed.checkpoints.render, undefined);
    assert.equal(completed.checkpoints["direct-readiness"].status, "COMPLETE");
    assert.equal(completed.checkpoints["direct-delivery-qc"].status, "COMPLETE");

    assert.equal(store.approve(job.id).status, "COMPLETE");
});

test("the direct default applies only to HeyGen jobs and explicit direct sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-heygen-default-"));
    const store = new JobStore(integrationConfig(root));
    const generated = store.submit({
        job_id: "simple-heygen-job",
        campaign_id: "delivery-mode-default",
        request: { topic: "A simple HeyGen presenter output" },
        production: {
            generation: {
                provider: "heygen",
                avatar_id: "owner-consented-avatar",
                elevenlabs_voice_id: "owner-consented-voice",
                script: "A direct presenter video that does not require downstream editing.",
            },
        },
    });
    const regular = store.submit({
        job_id: "regular-premiere-job",
        campaign_id: "delivery-mode-default",
        request: { topic: "A regular source-only edit" },
    });
    assert.equal(generated.production.deliveryMode, "direct_heygen");
    assert.equal(regular.production.deliveryMode, "premiere");
});

test("direct HeyGen delivery rejects Adobe render configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-heygen-reject-"));
    const source = path.join(root, "completed-video-agent-output.mp4");
    createVerticalVideo(source);
    const store = new JobStore(integrationConfig(root));
    assert.throws(() => store.submit({
        job_id: "invalid-direct-render",
        campaign_id: "direct-heygen-validation",
        request: { topic: "Invalid direct delivery" },
        production: {
            delivery_mode: "direct_heygen",
            render: {},
            direct_source: {
                local_path: source,
                provider: "heygen-video-agent",
                consent_asserted: true,
            },
        },
    }), /production\.render is not allowed/);
});
