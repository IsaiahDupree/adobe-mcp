const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobStore } = require("../lib/store");
const { RetentionPlanner } = require("../lib/retention-planner");
const {
    ShowcaseRenderer,
    isCaptionEcho,
    validateShowcaseTimeline,
} = require("../lib/showcase-renderer");
const { VideoJobRunner } = require("../lib/workflow");
const { readJson, run } = require("../lib/util");

const MAGICK = "/opt/homebrew/bin/magick";
const FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

async function createMediaFixture(output, color, frequency) {
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=8`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=8`,
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        output,
    ], { timeout: 30000 });
}

test("editing stages compile real media into a collision-free semantic manifest", async (t) => {
    if (!fs.existsSync(MAGICK)) return t.skip("ImageMagick is not installed at the configured path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-edit-system-"));
    const config = {
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    };
    const fixtureDir = path.join(root, "fixtures");
    fs.mkdirSync(fixtureDir);
    const sceneSpecs = [
        {
            id: "signal",
            title: "Research the live signal",
            callout_text: "RESEARCH BEFORE GENERATION",
            script: "The system starts from a live signal and checks the evidence.",
            color: "0x176B87",
            frequency: 330,
        },
        {
            id: "proof",
            title: "Keep an editable receipt",
            callout_text: "EDITABLE. COHERENT. ACCOUNTABLE.",
            script: "Then it creates an editable project and preserves the receipt.",
            color: "0x355E3B",
            frequency: 440,
        },
        {
            id: "release",
            title: "Quality before release",
            callout_text: "EXPORT SUCCESS IS NOT APPROVAL",
            script: "Technical and editorial checks decide whether the result can ship.",
            color: "0x7A3E65",
            frequency: 550,
        },
    ];
    const generatedScenes = [];
    for (const scene of sceneSpecs) {
        const localVideo = path.join(fixtureDir, `${scene.id}.mp4`);
        const localSubtitle = path.join(fixtureDir, `${scene.id}.srt`);
        await createMediaFixture(localVideo, scene.color, scene.frequency);
        fs.writeFileSync(
            localSubtitle,
            `1\n00:00:00,000 --> 00:00:03,500\n${scene.script}\n\n` +
            `2\n00:00:03,500 --> 00:00:07,500\nA second caption validates timing coverage.\n`,
            "utf8"
        );
        generatedScenes.push({
            sceneId: scene.id,
            localVideo,
            localSubtitle,
            durationSeconds: 8,
        });
    }

    const store = new JobStore(config);
    const job = store.submit({
        job_id: "editing-system-test",
        campaign_id: "editing-tests",
        request: { topic: "End-to-end editing robustness" },
        production: { sequence_name: "MASTER" },
        generation: {
            provider: "macos_say",
            aspect_ratio: "16:9",
            scenes: sceneSpecs.map(({ color, frequency, ...scene }) => scene),
        },
        retention: {
            preset: "youtube-explainer",
            caption_mode: "native",
            punch_in_scale: 1.06,
        },
        showcase: {
            enabled: true,
            minimum_duration_seconds: 1,
            maximum_duration_seconds: 30,
            asset_policy: { mode: "local-allowed" },
            broll_sources: [{ path: generatedScenes[0].localVideo, scene_id: "proof" }],
            explainer_assets: [{
                id: "release-gate",
                scene_id: "release",
                title: "Proof before publish",
                points: ["Frames", "Audio", "Captions", "Approval"],
                timeline_offset_seconds: 1.9,
                placement_duration_seconds: 4,
            }],
        },
    });

    const plan = new RetentionPlanner().plan(job, { scenes: generatedScenes });
    const manifest = await new ShowcaseRenderer({ IMAGEMAGICK_BIN: MAGICK, CAPTION_FONT: FONT })
        .render(job, plan);

    assert.equal(plan.scenes.length, 3);
    assert.equal(plan.captions.length, 6);
    assert.equal(manifest.graphics.length, 7);
    assert.equal(manifest.videos.length, 1);
    assert.equal(validateShowcaseTimeline(manifest), manifest);
    assert.ok(manifest.graphics.every((event) => event.start >= 0 && event.end > event.start));
    assert.ok(manifest.graphics.every((asset) => fs.statSync(asset.path).size > 1000));
    assert.ok(manifest.graphics
        .filter((asset) => asset.purpose === "retention-callout")
        .every((asset, index) => !isCaptionEcho(asset.text, sceneSpecs[index].script)));
    assert.equal(manifest.graphics.find((asset) => asset.id === "release-gate").trackIndex, 3);
    assert.deepEqual(readJson(job.outputPaths.showcaseManifest), manifest);
});

test("editing checkpoints persist failures, recover on retry, and skip completed work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-edit-checkpoints-"));
    const config = {
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    };
    const store = new JobStore(config);
    const job = store.submit({
        job_id: "checkpoint-recovery-test",
        request: { topic: "Checkpoint recovery" },
    });
    const runner = new VideoJobRunner(store, null, null);
    let operations = 0;

    await assert.rejects(
        runner.executeStage(job.id, "editing-contract", "RETENTION_EDITING", async () => {
            operations += 1;
            throw new Error("simulated deterministic stage failure");
        }),
        /deterministic stage failure/
    );
    assert.equal(store.get(job.id).checkpoints["editing-contract"].status, "FAILED");

    const recovered = await runner.executeStage(
        job.id,
        "editing-contract",
        "RETENTION_EDITING",
        async () => {
            operations += 1;
            return { manifestVersion: 2 };
        }
    );
    assert.deepEqual(recovered, { manifestVersion: 2 });
    assert.equal(store.get(job.id).checkpoints["editing-contract"].attempts, 2);

    const reloadedStore = new JobStore(config);
    const reloadedRunner = new VideoJobRunner(reloadedStore, null, null);
    const skipped = await reloadedRunner.executeStage(
        job.id,
        "editing-contract",
        "RETENTION_EDITING",
        async () => {
            operations += 1;
            return { manifestVersion: 3 };
        }
    );
    assert.deepEqual(skipped, { manifestVersion: 2 });
    assert.equal(operations, 2);
    assert.ok(reloadedStore.get(job.id).events.some((event) => event.type === "STAGE_FAILED"));
    assert.ok(reloadedStore.get(job.id).events.some((event) => event.type === "STAGE_COMPLETED"));
});
