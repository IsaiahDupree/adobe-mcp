const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const baseConfig = require("../lib/config");
const { JobStore } = require("../lib/store");
const { ShortFormBatchStore } = require("../lib/short-form-batch");
const {
    ShortFormCampaignStore,
    campaignPreset,
    campaignPresets,
} = require("../lib/short-form-campaign");
const { run } = require("../lib/util");

function configFor(root) {
    return {
        ...baseConfig,
        FACTORY_HOME: root,
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        BOARDS_DIR: path.join(root, "boards"),
        COMPOSITIONS_DIR: path.join(root, "compositions"),
        SHORT_FORM_DIR: path.join(root, "short-form"),
        SHORT_FORM_CAMPAIGNS_DIR: path.join(root, "short-form-campaigns"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport"),
    };
}

async function completedHeyGenSource(root, config, id = "heygen-master") {
    const directory = path.join(root, "fixtures", id);
    fs.mkdirSync(directory, { recursive: true });
    const project = path.join(directory, `${id}.prproj`);
    const render = path.join(directory, `${id}.mp4`);
    const captions = path.join(directory, "captions.srt");
    const editManifest = path.join(directory, "retention-edit-manifest.json");
    fs.writeFileSync(project, `Premiere fixture ${id}`, "utf8");
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x176B87:s=320x180:d=36",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=36",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", render,
    ], { timeout: 30000 });
    fs.writeFileSync(captions, [
        "1\n00:00:00,000 --> 00:00:09,000\nHere is the result and its proof.",
        "2\n00:00:09,000 --> 00:00:19,000\nThe same source tests every editing style.",
        "3\n00:00:19,000 --> 00:00:31,000\nViewer retention chooses the next preset.",
    ].join("\n\n") + "\n", "utf8");
    fs.writeFileSync(editManifest, `${JSON.stringify({
        scenes: [{ sceneId: "proof", start: 0, end: 31, duration: 31 }],
    }, null, 2)}\n`, "utf8");

    const store = new JobStore(config);
    const job = store.submit({
        job_id: id,
        campaign_id: "heygen-source-tests",
        request: { topic: "Reusable HeyGen source" },
        generation: {
            provider: "heygen",
            avatar_id: "real-test-avatar-id",
            voice_provider: "heygen",
            voice_id: "real-test-voice-id",
            scenes: [{ id: "proof", title: "Proof first", script: "Show the result and proof." }],
        },
        production: { render: {} },
    });
    job.status = "APPROVAL_REQUIRED";
    job.result = { projectPath: project, render: { outputFile: render } };
    job.outputPaths.editManifest = editManifest;
    job.outputPaths.combinedCaptions = captions;
    job.checkpoints["heygen-generation"] = {
        status: "COMPLETE",
        result: {
            provider: "heygen",
            reused: false,
            scenes: [{ sceneId: "proof", videoId: "real-provider-receipt-id", localVideo: render }],
        },
    };
    job.checkpoints["retention-edit"] = {
        status: "COMPLETE",
        result: { nativeCaptionTrack: { success: true } },
    };
    store.save(job);
    return { store, job: store.get(id) };
}

test("HeyGen style campaign preset keeps all three editing styles active", () => {
    const preset = campaignPreset();
    assert.deepEqual(preset.styles, ["kinetic-proof", "clean-authority", "rapid-explainer"]);
    assert.equal(preset.variantMode, "all-styles");
    assert.equal(preset.experiment.primaryVariable, "editing_style");
    assert.equal(new Set(campaignPresets.presets.map((item) => item.id)).size, campaignPresets.presets.length);
});

test("job schema accepts autonomous derivatives only for HeyGen generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-campaign-schema-"));
    const config = configFor(root);
    const store = new JobStore(config);
    const job = store.submit({
        job_id: "heygen-with-derivatives",
        request: { topic: "Generate and fan out" },
        generation: {
            provider: "heygen",
            avatar_id: "avatar-id",
            voice_provider: "heygen",
            voice_id: "voice-id",
            scenes: [{ id: "hook", script: "One source, three edits." }],
        },
        derivative_campaign: { enabled: true, preset: "heygen-style-matrix-v1" },
    });
    assert.equal(job.derivativeCampaign.enabled, true);
    assert.equal(job.derivativeCampaign.clipsPerSource, 1);
    assert.deepEqual(job.derivativeCampaign.styles, ["kinetic-proof", "clean-authority", "rapid-explainer"]);

    assert.throws(() => store.submit({
        job_id: "offline-with-derivatives",
        request: { topic: "Invalid derivative source" },
        generation: { provider: "macos_say", scenes: [{ id: "a", script: "Offline." }] },
        derivative_campaign: { enabled: true },
    }), /requires generation.provider heygen/);
});

test("completed HeyGen assets fan out without another generation job", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-campaign-reuse-"));
    const config = configFor(root);
    const { store: jobStore, job: source } = await completedHeyGenSource(root, config);
    const shortStore = new ShortFormBatchStore(config, jobStore);
    const campaignStore = new ShortFormCampaignStore(config, jobStore, shortStore);
    const campaign = campaignStore.submit({
        campaign_id: "reuse-style-matrix",
        source_job_ids: [source.id],
        preset: "heygen-style-matrix-v1",
        start_at: "2026-08-04T16:00:00.000Z",
        archive: { enabled: false },
    });
    const batch = shortStore.submit({
        short_form_id: "reuse-style-matrix-batch",
        campaign_id: campaign.id,
        source_job_ids: campaign.sourceJobIds,
        clips_per_source: campaign.clipsPerSource,
        styles: campaign.styles,
        variant_mode: "all-styles",
        minimum_seconds: campaign.minimumSeconds,
        maximum_seconds: campaign.maximumSeconds,
        archive: { enabled: false },
    });
    const children = batch.childJobs.map((child) => jobStore.get(child.jobId));

    assert.equal(children.length, 3);
    assert.equal(new Set(children.map((child) => child.shortForm.styleId)).size, 3);
    assert.equal(new Set(children.map((child) => child.shortForm.sourceRenderPath)).size, 1);
    assert.equal(new Set(children.map((child) =>
        `${child.shortForm.sourceRange.start}:${child.shortForm.sourceRange.end}`
    )).size, 1);
    assert.ok(children.every((child) => child.generation.enabled === false));
    assert.equal(jobStore.list().filter((job) => job.generation.enabled).length, 1);
});

test("publication matrix balances styles and emits approval-gated platform payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-campaign-matrix-"));
    const config = configFor(root);
    const { store: jobStore, job: source } = await completedHeyGenSource(root, config);
    const shortStore = new ShortFormBatchStore(config, jobStore);
    const campaignStore = new ShortFormCampaignStore(config, jobStore, shortStore);
    const campaign = campaignStore.submit({
        campaign_id: "balanced-style-matrix",
        source_job_ids: [source.id],
        start_at: "2026-08-04T16:00:00.000Z",
        archive: { enabled: false },
    });
    const batch = shortStore.submit({
        short_form_id: "balanced-style-matrix-batch",
        source_job_ids: [source.id],
        clips_per_source: 1,
        styles: campaign.styles,
        variant_mode: "all-styles",
        archive: { enabled: false },
    });
    const cells = campaignStore.planMatrix(campaign.id, batch);

    assert.equal(cells.length, 9);
    assert.equal(cells.filter((cell) => cell.styleId === "kinetic-proof").length, 3);
    assert.ok(cells.every((cell) => cell.status === "planned-approval-required"));
    assert.ok(cells.every((cell) => cell.publishPayload.approvalRequired));
    assert.ok(cells.every((cell) => cell.publishPayload.mediaPath.endsWith(".mp4")));
    const youtube = cells.filter((cell) => cell.platform === "youtube")
        .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    assert.deepEqual(youtube.map((cell) => cell.styleId), campaign.styles);
    assert.equal((Date.parse(youtube[1].scheduledFor) - Date.parse(youtube[0].scheduledFor)) / 3600000, 48);

    const approved = campaignStore.approve(campaign.id, youtube[0].cellId);
    assert.equal(approved.length, 1);
    assert.equal(approved[0].status, "approved-for-publisher");
    assert.equal(approved[0].publishPayload.approvalRequired, false);
    assert.equal(campaignStore.get(campaign.id).matrix.filter((cell) => cell.publishPayload.approvalRequired).length, 8);
    const replanned = campaignStore.planMatrix(campaign.id, batch);
    const preserved = replanned.find((cell) => cell.cellId === youtube[0].cellId);
    assert.equal(preserved.status, "approved-for-publisher");
    assert.equal(preserved.publishPayload.approvalRequired, false);
});

test("style evaluation waits for evidence then promotes a robust winner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-campaign-learning-"));
    const config = configFor(root);
    const { store: jobStore, job: source } = await completedHeyGenSource(root, config);
    const shortStore = new ShortFormBatchStore(config, jobStore);
    const campaignStore = new ShortFormCampaignStore(config, jobStore, shortStore);
    const campaign = campaignStore.submit({
        campaign_id: "learning-style-matrix",
        source_job_ids: [source.id],
        start_at: "2026-08-04T16:00:00.000Z",
        archive: { enabled: false },
    });
    const batch = shortStore.submit({
        short_form_id: "learning-style-matrix-batch",
        source_job_ids: [source.id],
        clips_per_source: 1,
        styles: campaign.styles,
        variant_mode: "all-styles",
        archive: { enabled: false },
    });
    const cells = campaignStore.planMatrix(campaign.id, batch);
    assert.equal(campaignStore.evaluate(campaign.id).status, "INSUFFICIENT_EVIDENCE");

    const performance = {
        "kinetic-proof": { average_percentage_viewed: 70, completion_rate: 0.62, three_second_view_rate: 0.84 },
        "clean-authority": { average_percentage_viewed: 55, completion_rate: 0.58, three_second_view_rate: 0.79 },
        "rapid-explainer": { average_percentage_viewed: 50, completion_rate: 0.54, three_second_view_rate: 0.76 },
    };
    for (const [index, cell] of cells.entries()) {
        campaignStore.recordMetrics(campaign.id, {
            cell_id: cell.cellId,
            platform_post_id: `real-post-${index + 1}`,
            window: "24h",
            metrics: {
                views: 200,
                ...performance[cell.styleId],
                engagement_rate: 0.08,
            },
        });
    }
    const evaluation = campaignStore.evaluate(campaign.id);
    assert.equal(evaluation.status, "WINNER_PROMOTED");
    assert.equal(evaluation.winnerStyleId, "kinetic-proof");
    assert.ok(evaluation.liftRatio > 0.08);
    assert.equal(campaignStore.validatedPresets().presets[0].preferredStyleId, "kinetic-proof");
    assert.throws(() => campaignStore.recordMetrics(campaign.id, {
        cell_id: cells[0].cellId,
        platform_post_id: "duplicate-post",
        window: "24h",
        metrics: { views: 1 },
    }), /already exist/);
});
