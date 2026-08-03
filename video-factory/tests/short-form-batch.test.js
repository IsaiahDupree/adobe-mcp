const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const baseConfig = require("../lib/config");
const { JobStore } = require("../lib/store");
const {
    ShortFormBatchStore,
    ShortFormBatchRunner,
    candidateRanges,
    captionCues,
    condensedHeadline,
    coverTransform,
    createHeadlineGraphic,
    createWordHighlightCaptions,
    loudnessCorrection,
    styleById,
    styleRegistry,
    trimCaptions,
    validateSelections,
} = require("../lib/short-form-batch");
const { run } = require("../lib/util");

function testConfig(root) {
    return {
        ...baseConfig,
        FACTORY_HOME: root,
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        BOARDS_DIR: path.join(root, "boards"),
        COMPOSITIONS_DIR: path.join(root, "compositions"),
        SHORT_FORM_DIR: path.join(root, "short-form"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport"),
    };
}

async function sourceFixture(root, id, color = "0x176B87") {
    const directory = path.join(root, id);
    fs.mkdirSync(directory, { recursive: true });
    const projectPath = path.join(directory, `${id}.prproj`);
    const renderPath = path.join(directory, `${id}.mp4`);
    const editManifestPath = path.join(directory, "retention-edit-manifest.json");
    const captionsPath = path.join(directory, "captions.srt");
    fs.writeFileSync(projectPath, `Premiere project fixture: ${id}`, "utf8");
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=70`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        renderPath,
    ], { timeout: 30000 });
    const scenes = [
        { sceneId: "opening-result", start: 0, end: 18, duration: 18 },
        { sceneId: "proof-system", start: 18, end: 40, duration: 22 },
        { sceneId: "workflow-steps", start: 40, end: 66, duration: 26 },
    ];
    fs.writeFileSync(editManifestPath, `${JSON.stringify({ scenes }, null, 2)}\n`, "utf8");
    fs.writeFileSync(captionsPath, [
        "1\n00:00:00,000 --> 00:00:08,000\nHere is the result before the explanation.",
        "2\n00:00:08,000 --> 00:00:17,500\nThe opening proves why this matters.",
        "3\n00:00:18,000 --> 00:00:29,000\nThe project preserves evidence and quality checks.",
        "4\n00:00:29,000 --> 00:00:39,500\nEvery decision remains editable in Premiere.",
        "5\n00:00:40,000 --> 00:00:53,000\nFirst research the idea, then create the edit.",
        "6\n00:00:53,000 --> 00:01:05,500\nFinally test the workflow and keep the winner.",
    ].join("\n\n") + "\n", "utf8");
    return {
        id,
        title: `Source ${id}`,
        project_path: projectPath,
        render_path: renderPath,
        edit_manifest_path: editManifestPath,
        captions_path: captionsPath,
        scenes: [
            { id: "opening-result", title: "Lead with the result", script: "Show the result and proof first." },
            { id: "proof-system", title: "Preserve the evidence", script: "The project keeps proof and quality checks." },
            { id: "workflow-steps", title: "Explain the workflow", script: "First research, then create, and finally test the edit." },
        ],
    };
}

test("short-form style registry contains distinct, bounded editing contracts", () => {
    assert.deepEqual(styleRegistry.styles.map((style) => style.id), [
        "kinetic-proof",
        "clean-authority",
        "rapid-explainer",
        "semantic-focus",
    ]);
    assert.ok(new Set(styleRegistry.styles.map((style) => style.editing.visualChangeIntervalSeconds)).size >= 3);
    assert.equal(new Set(styleRegistry.styles.map((style) => style.editing.dialogueGainDb)).size, 1);
    assert.ok(styleRegistry.styles.every((style) =>
        style.duration.minimumSeconds >= 15 &&
        style.duration.maximumSeconds <= 60 &&
        style.captions.mode === "word-highlight" &&
        style.layout.platformUiReserveBottomRatio >= 0.18 &&
        style.layout.faceZoomMultiplier >= 1.1 &&
        style.editing.audioPriority === "dialogue-first" &&
        style.editing.dialogueGainDb >= -6 &&
        style.editing.dialogueGainDb <= 6
    ));
    assert.throws(() => styleById("unknown-style"), /Unknown short-form style/);
});

test("short-form loudness recovery targets dialogue while preserving true-peak headroom", () => {
    const correction = loudnessCorrection({
        shortForm: { enabled: true, editing: { dialogueGainDb: -0.5 } },
    }, {
        provider: "ffmpeg-ebur128-read-only",
        integratedLufs: -19.7,
        truePeakDb: -4.2,
        targetIntegratedLufs: -16,
        maximumTruePeakDb: -1,
    });
    assert.equal(correction.dialogueGainDb, 2.5);
    assert.equal(correction.appliedDeltaDb, 3);
    assert.equal(correction.target.safetyMarginDb, 0.2);
});

test("safe-fill transform covers a vertical frame and clamps off-center focus", () => {
    const centered = coverTransform(
        { width: 1280, height: 720, durationSeconds: 60 },
        { width: 1080, height: 1920 }
    );
    assert.ok(Math.abs(centered.scalePercent - 266.6667) < 0.001);
    assert.deepEqual(centered.position, { x: 540, y: 960 });
    assert.equal(centered.exposedCanvas, false);

    const focused = coverTransform(
        { width: 1280, height: 720, durationSeconds: 60 },
        { width: 1080, height: 1920 },
        { x: 0.9, y: 0.5 }
    );
    assert.ok(focused.position.x < 540);
    assert.ok(focused.position.x >= -626.667);
    assert.equal(focused.exposedCanvas, false);

    const faceAnchored = coverTransform(
        { width: 1280, height: 720, durationSeconds: 60 },
        { width: 1080, height: 1920 },
        { x: 0.534, y: 0.438, anchorX: 0.5, anchorY: 0.35, zoomMultiplier: 1.16 }
    );
    assert.ok(Math.abs(faceAnchored.scalePercent - 309.3334) < 0.001);
    assert.ok(faceAnchored.position.y < 960);
    assert.equal(faceAnchored.exposedCanvas, false);
});

test("caption trimming rebases intersecting cues and clips them to the selected range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-captions-"));
    const source = path.join(root, "source.srt");
    const output = path.join(root, "trimmed.srt");
    fs.writeFileSync(source, [
        "1\n00:00:08,000 --> 00:00:12,000\nOpening overlap",
        "2\n00:00:14,000 --> 00:00:18,000\nInside range",
        "3\n00:00:21,000 --> 00:00:26,000\nClosing overlap",
    ].join("\n\n") + "\n", "utf8");
    const cues = trimCaptions(source, output, { start: 10, end: 23, duration: 13 });

    assert.deepEqual(cues, [
        { start: 0, end: 2, text: "Opening overlap" },
        { start: 4, end: 8, text: "Inside range" },
        { start: 11, end: 13, text: "Closing overlap" },
    ]);
    assert.deepEqual(captionCues(output), cues);
});

test("semantic layout creates a top headline and timed word-highlight captions without a bottom bar", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-layout-"));
    const headline = createHeadlineGraphic(
        path.join(root, "headline.png"),
        condensedHeadline("Premiere keeps every creative decision editable", 6),
        { headlineYRatio: 0.12 },
        { magickBin: baseConfig.IMAGEMAGICK_BIN, font: baseConfig.CAPTION_FONT }
    );
    const captions = createWordHighlightCaptions(
        path.join(root, "captions"),
        [{ start: 0, end: 2, text: "Premiere keeps the project editable" }],
        { anchorYRatio: 0.67, wordsPerChunk: 5 },
        { magickBin: baseConfig.IMAGEMAGICK_BIN }
    );
    assert.ok(fs.statSync(headline).size > 1000);
    assert.equal(captions.length, 5);
    assert.equal(captions[0].activeWord, "Premiere");
    assert.ok(captions.every((caption) => fs.statSync(caption.path).size > 1000));
    assert.ok(captions.every((caption) => caption.start >= 0 && caption.end <= 2));
});

test("one completed project compiles three independent vertical styles with real media", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-single-"));
    const config = testConfig(root);
    const source = await sourceFixture(root, "master-project");
    const jobStore = new JobStore(config);
    const batchStore = new ShortFormBatchStore(config, jobStore);
    const batch = batchStore.submit({
        short_form_id: "single-master-shorts",
        campaign_id: "short-tests",
        sources: [source],
        clips_per_source: 3,
        minimum_seconds: 15,
        maximum_seconds: 30,
        styles: ["kinetic-proof", "clean-authority", "rapid-explainer"],
        variant_mode: "rotate",
        archive: { enabled: false },
    });

    assert.equal(batch.sourceCount, 1);
    assert.equal(batch.selectionCount, 3);
    assert.equal(batch.childJobs.length, 3);
    assert.equal(new Set(batch.childJobs.map((child) => child.styleId)).size, 3);
    assert.equal(jobStore.dueJobs().length, 0);
    for (const childRecord of batch.childJobs) {
        const child = jobStore.get(childRecord.jobId);
        const timeline = child.production.editPlan.timeline[0];
        assert.equal(child.status, "SHORT_FORM_HELD");
        assert.equal(child.generation.enabled, false);
        assert.equal(child.shortForm.enabled, true);
        assert.equal(child.shortForm.target.format, "9:16");
        assert.equal(child.shortForm.target.width, 1080);
        assert.equal(child.shortForm.target.height, 1920);
        assert.equal(child.shortForm.captions.mode, "word-highlight");
        assert.equal(child.shortForm.captions.sourceEmbedded, false);
        assert.ok(child.shortForm.captions.graphics.length > 0);
        assert.equal(child.shortForm.layout.platformUiReserveBottomRatio, 0.18);
        assert.equal(child.production.sourceAssets.some((asset) => asset.role === "caption-remask"), false);
        assert.equal(child.production.existingProjectPath, source.project_path);
        assert.equal(timeline.source_start_seconds, child.shortForm.sourceRange.start);
        assert.equal(timeline.duration_seconds, child.shortForm.sourceRange.duration);
        assert.ok(child.shortForm.transform.scalePercent > 1000);
        assert.ok(fs.existsSync(child.outputPaths.combinedCaptions));
        assert.ok(captionCues(child.outputPaths.combinedCaptions).every((cue) =>
            cue.start >= 0 && cue.end <= child.shortForm.sourceRange.duration
        ));
    }
});

test("all-styles mode creates controlled style variants from the same source range", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-variants-"));
    const config = testConfig(root);
    const source = await sourceFixture(root, "variant-master", "0x355E3B");
    const jobStore = new JobStore(config);
    const batch = new ShortFormBatchStore(config, jobStore).submit({
        short_form_id: "style-variants",
        sources: [source],
        clips_per_source: 1,
        styles: ["kinetic-proof", "clean-authority", "rapid-explainer"],
        variant_mode: "all-styles",
        archive: { enabled: false },
    });

    assert.equal(batch.childJobs.length, 3);
    assert.equal(new Set(batch.childJobs.map((child) => `${child.sourceRange.start}:${child.sourceRange.end}`)).size, 1);
    assert.equal(new Set(batch.childJobs.map((child) => child.styleId)).size, 3);
    assert.equal(new Set(batch.childJobs.map((child) =>
        jobStore.get(child.jobId).shortForm.motion.introScaleMultiplier
    )).size, 3);
});

test("resumed batches invalidate Premiere stages when a style contract changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-style-sync-"));
    const config = testConfig(root);
    const source = await sourceFixture(root, "style-sync-master");
    const jobStore = new JobStore(config);
    const batchStore = new ShortFormBatchStore(config, jobStore);
    const batch = batchStore.submit({
        short_form_id: "style-sync",
        sources: [source],
        styles: ["clean-authority"],
        archive: { enabled: false },
    });
    const child = jobStore.get(batch.childJobs[0].jobId);
    child.status = "APPROVAL_REQUIRED";
    child.shortForm.editing.dialogueGainDb = 0.5;
    child.checkpoints["short-form-edit"] = { status: "COMPLETE" };
    child.checkpoints.project = { status: "COMPLETE" };
    child.checkpoints.render = { status: "COMPLETE" };
    child.result = { render: { outputFile: child.outputPaths.render } };
    jobStore.save(child);

    const runner = new ShortFormBatchRunner(batchStore, jobStore, null);
    assert.equal(runner.syncStyleContract(jobStore.get(child.id)), true);
    const updated = jobStore.get(child.id);
    assert.equal(updated.shortForm.editing.dialogueGainDb, 1);
    assert.equal(updated.status, "FAILED_RECOVERABLE");
    assert.equal(updated.checkpoints["short-form-edit"], undefined);
    assert.equal(updated.checkpoints.project, undefined);
    assert.equal(updated.checkpoints.render, undefined);
    assert.equal(updated.result, null);
    assert.equal(updated.shortForm.presetSyncHistory[0].previousDialogueGainDb, 0.5);
    assert.ok(updated.shortForm.presetSyncHistory[0].invalidatedStages.includes("project"));
});

test("a project collection expands every completed source with preserved lineage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-collection-"));
    const config = testConfig(root);
    const fixtures = await Promise.all([
        sourceFixture(root, "project-alpha", "0x176B87"),
        sourceFixture(root, "project-beta", "0x7A3E65"),
    ]);
    const jobStore = new JobStore(config);
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
        const sourceJob = jobStore.submit({
            job_id: fixture.id,
            request: { topic: fixture.title },
            production: { render: {} },
        });
        sourceJob.status = "APPROVAL_REQUIRED";
        sourceJob.result = {
            projectPath: fixture.project_path,
            render: { outputFile: fixture.render_path },
        };
        sourceJob.outputPaths.editManifest = fixture.edit_manifest_path;
        sourceJob.outputPaths.combinedCaptions = fixture.captions_path;
        sourceJob.generation.scenes = fixture.scenes;
        if (fixtureIndex === 0) {
            sourceJob.checkpoints["retention-edit"] = {
                status: "COMPLETE",
                result: { nativeCaptionTrack: { success: true } },
            };
        }
        jobStore.save(sourceJob);
    }
    const batch = new ShortFormBatchStore(config, jobStore).submit({
        short_form_id: "project-of-projects",
        source_job_ids: fixtures.map((fixture) => fixture.id),
        clips_per_source: 1,
        styles: ["clean-authority"],
        archive: { enabled: false },
    });

    assert.equal(batch.sourceCount, 2);
    assert.equal(batch.childJobs.length, 2);
    assert.deepEqual(new Set(batch.childJobs.map((child) => child.sourceId)), new Set(fixtures.map((fixture) => fixture.id)));
    for (const child of batch.childJobs) {
        const job = jobStore.get(child.jobId);
        assert.equal(job.shortForm.sourceJobId, child.sourceId);
        assert.equal(job.parentShortFormBatchId, batch.id);
        assert.equal(
            job.shortForm.captions.mode,
            child.sourceId === fixtures[0].id ? "source-embedded" : "word-highlight"
        );
        if (child.sourceId === fixtures[0].id) {
            assert.equal(job.shortForm.captions.remaskPath, undefined);
            assert.equal(job.production.sourceAssets.some((asset) => asset.role === "caption-remask"), false);
        }
    }
});

test("short-form compiler rejects missing captions before creating partial child jobs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-transaction-"));
    const config = testConfig(root);
    const source = await sourceFixture(root, "no-caption-master");
    fs.unlinkSync(source.captions_path);
    const jobStore = new JobStore(config);
    const batchStore = new ShortFormBatchStore(config, jobStore);

    assert.throws(() => batchStore.submit({
        short_form_id: "must-be-atomic",
        sources: [source],
        clips_per_source: 1,
        styles: ["kinetic-proof"],
        archive: { enabled: false },
    }), /requires captions/);
    assert.equal(jobStore.list().length, 0);
    assert.equal(batchStore.list().length, 0);
});

test("selection validation rejects duplicates, overlong ranges, and source overflow", () => {
    const sources = [{ id: "source", media: { durationSeconds: 50 } }];
    const valid = { id: "a", sourceId: "source", styleId: "clean-authority", start: 5, end: 25, duration: 20 };
    assert.throws(() => validateSelections([valid, { ...valid, id: "b" }], sources), /Duplicate/);
    assert.throws(() => validateSelections([
        { ...valid, end: 70, duration: 65 },
    ], sources), /outside its source duration/);
    assert.throws(() => validateSelections([
        { ...valid, sourceId: "missing" },
    ], sources), /source does not exist/);
});

test("candidate selection combines short adjacent scenes without exceeding its limit", () => {
    const source = {
        title: "Short scenes",
        media: { durationSeconds: 30 },
        editManifest: { scenes: [
            { sceneId: "a", start: 0, end: 6 },
            { sceneId: "b", start: 6, end: 13 },
            { sceneId: "c", start: 13, end: 28 },
        ] },
    };
    const ranges = candidateRanges(source, 12, 20);
    assert.deepEqual(ranges.map((range) => [range.start, range.end, range.duration]), [
        [0, 13, 13],
        [6, 26, 20],
        [13, 28, 15],
    ]);
});

test("compiled child state persists the same short-form contract after reload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-persistence-"));
    const config = testConfig(root);
    const source = await sourceFixture(root, "persistent-master");
    const jobStore = new JobStore(config);
    const batchStore = new ShortFormBatchStore(config, jobStore);
    const batch = batchStore.submit({
        short_form_id: "persistent-shorts",
        sources: [source],
        clips_per_source: 1,
        styles: ["clean-authority"],
        archive: { enabled: false },
    });
    const reloadedBatch = new ShortFormBatchStore(config, new JobStore(config)).get(batch.id);
    const child = new JobStore(config).get(batch.childJobs[0].jobId);

    assert.deepEqual(reloadedBatch.childJobs, batch.childJobs);
    assert.equal(fs.existsSync(child.outputPaths.shortFormManifest), false);
    assert.equal(child.shortForm.styleId, "clean-authority");
    assert.equal(child.shortForm.sourceRange.duration, batch.childJobs[0].sourceRange.duration);
});
