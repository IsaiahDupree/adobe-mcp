const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LocalNarrationManager } = require("../lib/local-narration-manager");
const { JobStore } = require("../lib/store");
const { VideoJobRunner } = require("../lib/workflow");

test("later Premiere revisions reuse the first real generation assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-generation-reuse-"));
    const config = {
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport"),
        IMAGEMAGICK_BIN: "/opt/homebrew/bin/magick",
        CAPTION_FONT: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    };
    const store = new JobStore(config);
    const script = "A verified generation can support several editable Premiere revisions.";
    const source = store.submit({
        job_id: "generation-source-v1",
        campaign_id: "generation-reuse",
        request: { topic: "Generation reuse" },
        generation: {
            provider: "macos_say",
            aspect_ratio: "16:9",
            scenes: [{ id: "proof", script }],
        },
    });
    const generation = await new LocalNarrationManager(config).generate(source);
    source.checkpoints["heygen-generation"] = { status: "COMPLETE", result: generation };
    store.save(source);
    const target = store.submit({
        job_id: "generation-target-v2",
        campaign_id: "generation-reuse",
        request: { topic: "Generation reuse" },
        generation: {
            provider: "macos_say",
            aspect_ratio: "16:9",
            reuse_from_job_id: source.id,
            scenes: [{ id: "proof", script }],
        },
    });
    const reused = new VideoJobRunner(store, null, null).reuseGeneration(target);
    assert.equal(reused.reusedFromJobId, source.id);
    assert.notEqual(reused.scenes[0].localVideo, generation.scenes[0].localVideo);
    assert.ok(fs.statSync(reused.scenes[0].localVideo).size > 0);
    assert.ok(fs.statSync(reused.scenes[0].localAudio).size > 0);
    assert.ok(fs.statSync(reused.scenes[0].localSubtitle).size > 0);
});
