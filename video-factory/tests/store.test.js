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
        ELEVENLABS_VOICE_ID: "elevenlabs-real-id",
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
        showcase: {
            enabled: true,
            minimum_duration_seconds: 300,
            maximum_duration_seconds: 480,
            broll_sources: [],
            sfx_sources: [],
        },
    });

    assert.equal(job.generation.enabled, true);
    assert.equal(job.generation.scenes.length, 2);
    assert.equal(job.generation.avatarId, "avatar-real-id");
    assert.equal(job.generation.voiceProvider, "elevenlabs");
    assert.equal(job.generation.elevenLabsVoiceId, "elevenlabs-real-id");
    assert.equal(job.retention.hookText, "STOP THE SCROLL");
    assert.equal(job.retention.captionMode, "native");
    assert.equal(job.retention.preset, "social-dynamic");
    assert.equal(job.showcase.enabled, true);
    assert.equal(job.showcase.minimumDurationSeconds, 300);
    assert.match(job.outputPaths.combinedCaptions, /combined-captions\.srt$/);
});

test("job schema accepts offline narration without HeyGen credentials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-local-schema-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });
    const job = store.submit({
        request: { topic: "Offline benchmark" },
        generation: {
            provider: "macos_say",
            voice_name: "Samantha",
            words_per_minute: 165,
            scenes: [{ id: "intro", script: "A real offline narration scene." }],
        },
    });

    assert.equal(job.generation.provider, "macos_say");
    assert.equal(job.generation.voiceName, "Samantha");
    assert.equal(job.generation.wordsPerMinute, 165);
});

test("job schema normalizes provider-only semantic asset requests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-broker-schema-"));
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });
    const job = store.submit({
        request: { topic: "Provider sourced benchmark" },
        showcase: {
            enabled: true,
            asset_policy: { mode: "provider-only" },
            asset_requests: [{
                id: "editor-proof",
                scene_id: "camera-motion",
                query: "professional video editor",
                providers: ["pexels", "pixabay"],
                orientation: "landscape",
                timeline_offset_seconds: 11,
            }],
            explainer_assets: [{
                id: "workflow-proof",
                scene_id: "camera-motion",
                title: "A useful visual explanation",
                points: ["Research", "Premiere", "QA"],
                timeline_offset_seconds: 16,
            }],
        },
    });

    assert.equal(job.showcase.assetPolicy.mode, "provider-only");
    assert.equal(job.showcase.assetRequests[0].sceneId, "camera-motion");
    assert.deepEqual(job.showcase.assetRequests[0].providers, ["pexels", "pixabay"]);
    assert.equal(job.showcase.assetRequests[0].timelineOffsetSeconds, 11);
    assert.equal(job.showcase.explainerAssets[0].timelineOffsetSeconds, 16);
    assert.deepEqual(job.showcase.explainerAssets[0].points, ["Research", "Premiere", "QA"]);
    assert.match(job.outputPaths.assetRegistry, /source-assets\/asset-registry\.json$/);
});

test("job schema preserves timecoded Premiere SFX gain instructions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-sfx-schema-"));
    const sfxPath = path.join(root, "receipt.mp3");
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });
    const job = store.submit({
        request: { topic: "Measured sound design" },
        showcase: {
            enabled: true,
            asset_policy: { mode: "local-allowed" },
            sfx_sources: [{
                id: "receipt-confirmation",
                path: sfxPath,
                timeline_seconds: 2.2,
                duration_seconds: 2,
                track_index: 3,
                gain_db: -12,
                provider: "elevenlabs",
            }],
        },
    });

    assert.deepEqual(job.showcase.sfxSources[0], {
        id: "receipt-confirmation",
        path: sfxPath,
        timelineSeconds: 2.2,
        durationSeconds: 2,
        trackIndex: 3,
        gainDb: -12,
        purpose: "chapter-transition-sfx",
        provider: "elevenlabs",
        license: "owner-supplied",
    });
});

test("provider-only jobs reject pre-existing local creative assets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-factory-provider-policy-"));
    const localClip = path.join(root, "old-broll.mp4");
    fs.writeFileSync(localClip, "old media");
    const store = new JobStore({
        JOBS_DIR: path.join(root, "jobs"),
        CAMPAIGNS_DIR: path.join(root, "campaigns"),
    });

    assert.throws(() => store.submit({
        request: { topic: "Disallowed local media" },
        showcase: {
            enabled: true,
            asset_policy: { mode: "provider-only" },
            asset_requests: [{ query: "editor", provider: "pexels" }],
            broll_sources: [localClip],
        },
    }), /cannot include pre-existing local B-roll or SFX/);
});
