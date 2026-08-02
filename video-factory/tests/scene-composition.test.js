const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const baseConfig = require("../lib/config");
const { AnimationGrammarRenderer } = require("../lib/animation-grammar-renderer");
const { CompositionBatchStore } = require("../lib/composition-batch");
const { CompositionQa } = require("../lib/composition-qa");
const { FramingTracker } = require("../lib/framing-tracker");
const { HeyGenManager } = require("../lib/heygen-manager");
const { registry, selectHeyGenLook } = require("../lib/heygen-look-selector");
const { ResponsiveLayoutEngine, constrainSafeFill } = require("../lib/responsive-layout-engine");
const { RetentionPlanner } = require("../lib/retention-planner");
const { SceneDirector } = require("../lib/scene-director");
const { JobStore } = require("../lib/store");
const { SubjectAnalyzer } = require("../lib/subject-analyzer");
const { run } = require("../lib/util");
const { averageVideoLuma, requestedProjectIsOpen } = require("../lib/workflow");

function testConfig(root) {
    return {
        ...baseConfig,
        FACTORY_HOME: root,
        JOBS_DIR: path.join(root, "jobs"),
        COMPOSITIONS_DIR: path.join(root, "compositions"),
        FRAMING_DIR: path.join(root, "framing"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport"),
        HEYGEN_AVATAR_ID: "93a72551393b4a13a7e256a3fa3ca421",
        HEYGEN_VOICE_ID: "configured-voice",
    };
}

test("avatar registry contains every retrieved look and visually reviewed format defaults", () => {
    assert.equal(registry.looks.length, 20);
    assert.equal(selectHeyGenLook("16:9").id, "93a72551393b4a13a7e256a3fa3ca421");
    assert.equal(selectHeyGenLook("9:16").id, "3583ef262c2c4b779989de0a79ec14dd");
    assert.throws(() => selectHeyGenLook("16:9", "3583ef262c2c4b779989de0a79ec14dd"), /not landscape/);
});

test("HeyGen v3 request respects output format and engine capability limits", () => {
    const manager = new HeyGenManager({ HEYGEN_API_URL: "https://api.heygen.com", HEYGEN_API_KEY: "configured" });
    const job = {
        campaignId: "composition",
        generation: {
            avatarId: selectHeyGenLook("9:16").id,
            voiceId: "configured-voice",
            engine: "avatar_v",
            aspectRatio: "9:16",
            resolution: "720p",
            background: null,
            outputFormat: "webm",
            removeBackground: true,
            fit: "contain",
            motionPrompt: "Use confident gestures.",
            expressiveness: 0.8,
            voiceSettings: { speed: 1.04, locale: "en-US" },
        },
    };
    const body = manager.requestBody(job, { script: "A real request body.", id: "scene-001" });
    assert.equal(body.output_format, "webm");
    assert.equal(body.remove_background, true);
    assert.equal(body.background, undefined);
    assert.equal(body.motion_prompt, undefined);
    assert.equal(body.expressiveness, undefined);
});

test("scene composition pipeline produces analyzed, face-safe, rendered QA evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-scene-composition-"));
    const config = testConfig(root);
    const store = new JobStore(config);
    const job = store.submit({
        job_id: "scene-composition-integration",
        campaign_id: "composition-tests",
        request: { topic: "Autonomous video systems" },
        production: { sequence_name: "MASTER_16x9" },
        generation: {
            provider: "heygen",
            engine: "avatar_v",
            avatar_id: selectHeyGenLook("16:9").id,
            voice_id: "configured-voice",
            aspect_ratio: "16:9",
            scenes: [{ id: "process", script: "Three steps make autonomous video production faster and safer." }],
        },
        retention: { caption_mode: "native" },
        composition: {
            enabled: true,
            formats: ["16:9"],
            character: { avatar_group_id: registry.avatarGroupId },
        },
    });
    const source = path.join(root, "real-analysis-frame.png");
    const subtitle = path.join(root, "captions.srt");
    await run(config.IMAGEMAGICK_BIN, ["-size", "1280x720", "xc:#25313a", source]);
    fs.writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:04,000\nThree steps make autonomous video production faster.\n", "utf8");
    const generation = {
        scenes: [{
            sceneId: "process",
            localVideo: source,
            localSubtitle: subtitle,
            durationSeconds: 4,
        }],
    };
    const visualPlan = new SceneDirector().plan(job);
    const subjectTrack = await new SubjectAnalyzer(config).analyze(job, generation);
    const retention = new RetentionPlanner().plan(job, generation);
    const layout = new ResponsiveLayoutEngine().build(job, visualPlan, subjectTrack, retention);
    const assets = await new AnimationGrammarRenderer(config).render(job, layout);
    const qa = new CompositionQa().evaluate(job, visualPlan, subjectTrack, layout, assets);

    assert.equal(visualPlan.scenes[0].semantic_intent, "explain_process");
    assert.equal(subjectTrack.scenes[0].face_detection_rate, 0);
    assert.equal(layout.variants[0].scenes[0].camera.enabled, false);
    assert.equal(assets.graphics.length, 1);
    assert.ok(fs.statSync(assets.graphics[0].path).size > 0);
    assert.equal(qa.passed, true);
});

test("composition batch creates independent masters with the selected HeyGen looks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-composition-batch-"));
    const config = testConfig(root);
    const jobStore = new JobStore(config);
    const batchStore = new CompositionBatchStore(config, jobStore);
    const batch = batchStore.submit({
        composition_id: "two-format-master",
        formats: ["16:9", "9:16"],
        base_job: {
            campaign_id: "composition-tests",
            request: { topic: "Two format master" },
            production: {},
            generation: {
                voice_id: "configured-voice",
                engine: "avatar_v",
                scenes: [{ id: "hook", script: "Build once, compose correctly for every screen." }],
            },
        },
    });

    assert.equal(batch.childJobs.length, 2);
    assert.equal(jobStore.get("two-format-master-16x9").generation.avatarId, selectHeyGenLook("16:9").id);
    assert.equal(jobStore.get("two-format-master-9x16").generation.avatarId, selectHeyGenLook("9:16").id);
    assert.equal(jobStore.get("two-format-master-16x9").production.sequenceName, "MASTER_16x9");
    assert.equal(jobStore.get("two-format-master-9x16").production.sequenceName, "MASTER_9x16");
    assert.equal(jobStore.get("two-format-master-16x9").status, "COMPOSITION_HELD");
    assert.equal(jobStore.dueJobs().length, 0);
});

test("pixel QA distinguishes a visible render from a blank render", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-pixel-qa-"));
    const visible = path.join(root, "visible.mp4");
    const blank = path.join(root, "blank.mp4");
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=white:s=320x180:d=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", visible,
    ]);
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", blank,
    ]);
    assert.ok(await averageVideoLuma(visible) > 200);
    assert.ok(await averageVideoLuma(blank) < 20);
});

test("safe-fill camera math trades excess pan for enough zoom without exposed canvas", () => {
    const coverage = constrainSafeFill({ x: 0.12, y: -0.055 }, 1.04, 1.16, 0.005);
    assert.equal(coverage.scale, 1.16);
    assert.equal(coverage.translationClamped, true);
    assert.ok(Math.abs(coverage.translation.x) <= coverage.maximumSafeShift);
    assert.ok(Math.abs(coverage.translation.y) <= coverage.maximumSafeShift);
    assert.equal(coverage.predictedExposedCanvas, false);
});

test("project readiness requires the requested Premiere project, not any open project", () => {
    const requested = "/tmp/portrait-master.prproj";
    assert.equal(requestedProjectIsOpen({
        project: { hasProject: true, path: "/tmp/unrelated-project.prproj" },
    }, requested), false);
    assert.equal(requestedProjectIsOpen({
        project: { hasProject: true, path: requested },
    }, requested), true);
});

test("framing tracker records every HeyGen source and rejects bars added by editing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-framing-tracker-"));
    const config = testConfig(root);
    const source = path.join(root, "source.mp4");
    const barred = path.join(root, "barred.mp4");
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=white:s=320x180:d=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
    await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=white:s=288x180:d=4",
        "-vf", "pad=320:180:32:0:black",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", barred,
    ]);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "qc"), { recursive: true });
    const job = {
        id: "framing-job",
        campaignId: "framing-tests",
        parentCompositionId: "framing-batch",
        workspace,
        attempts: 1,
        generation: {
            enabled: true,
            provider: "heygen",
            avatarId: "avatar-real-id",
            voiceId: "voice-real-id",
            engine: "avatar_v",
            aspectRatio: "16:9",
        },
        composition: {
            enabled: true,
            layout: { framingMode: "safe-fill", maxZoom: 1.16 },
            framing: { maximumAddedBarAreaRatio: 0.003 },
        },
        outputPaths: {
            framingSourceAudit: path.join(workspace, "qc", "source-framing.json"),
            framingAudit: path.join(workspace, "qc", "final-framing.json"),
            responsiveLayout: path.join(workspace, "edit-plans", "layout.json"),
        },
    };
    const tracker = new FramingTracker(config);
    const sourceAudit = await tracker.auditSources(job, {
        scenes: [{ sceneId: "proof", videoId: "heygen-video-id", localVideo: source }],
    });
    assert.equal(sourceAudit.passed, true);
    await assert.rejects(
        () => tracker.auditFinal(job, { outputFile: barred }, sourceAudit),
        /persistent bars/
    );
    await assert.rejects(
        () => tracker.auditFinal(job, { outputFile: barred }, { maximumBarAreaRatio: 0.1 }),
        /persistent bars/
    );
    const event = tracker.status(job.id);
    assert.equal(event.sourceAudit.scenes[0].heygenVideoId, "heygen-video-id");
    assert.equal(event.finalAudit.passed, false);
    assert.equal(tracker.status().summary.generationsTracked, 1);
});
