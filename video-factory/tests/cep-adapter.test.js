const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CepAdapter, premiereDbToLevel } = require("../lib/cep-adapter");
const { writeJsonAtomic } = require("../lib/util");

test("native caption receipt makes caption-track creation idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-caption-receipt-"));
    const srtPath = path.join(root, "captions.srt");
    const receiptPath = `${srtPath}.premiere-track.json`;
    fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:01,000\nNative caption\n", "utf8");
    writeJsonAtomic(receiptPath, {
        success: true,
        created: true,
        sequenceName: "MASTER",
        source: srtPath,
        receiptPath,
    });

    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    const result = await adapter.createNativeCaptionTrack({
        sequenceName: "MASTER",
        srtPath,
        requestedTrackName: "C1_ACCESSIBILITY_EN",
    });

    assert.equal(result.success, true);
    assert.equal(result.created, false);
    assert.equal(result.reused, true);
});

test("retention script falls back to an available SFX track and records the mapping", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-sfx-track-"));
    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    let capturedScript = "";
    adapter.executeScript = async (script) => {
        capturedScript = script;
        return { success: true };
    };

    await adapter.applyRetentionPlan({
        sequenceName: "MASTER",
        plan: { scenes: [], frame: { width: 1280, height: 720 } },
        showcaseAssets: {
            enabled: true,
            graphics: [],
            videos: [],
            audio: [{
                id: "impact",
                path: path.join(root, "impact.mp3"),
                start: 10,
                end: 12,
                trackIndex: 5,
                gainDb: -10,
            }],
        },
    });

    assert.match(capturedScript, /requestedAudioTrackNumber/);
    assert.match(capturedScript, /sequence\.audioTracks\.numTracks-1/);
    assert.match(capturedScript, /requestedTrackIndex:requestedAudioTrackNumber/);
});

test("retention script safely maps requested graphic tracks to an available overlay track", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-graphic-track-"));
    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    let capturedScript = "";
    adapter.executeScript = async (script) => {
        capturedScript = script;
        return { success: true };
    };

    await adapter.applyRetentionPlan({
        sequenceName: "MASTER",
        plan: { scenes: [], frame: { width: 1280, height: 720 } },
        showcaseAssets: {
            graphics: [{
                id: "semantic-explainer",
                path: path.join(root, "explainer.png"),
                start: 4,
                end: 7,
                trackIndex: 3,
            }],
            videos: [],
            audio: [],
        },
    });

    assert.match(capturedScript, /requestedTrackIndex/);
    assert.match(capturedScript, /sequence\.videoTracks\.numTracks-1/);
    assert.match(capturedScript, /requestedTrackIndex:requestedTrackIndex/);
    assert.match(capturedScript, /Mapped graphic overlap on track/);
});

test("CEP project close saves and closes only the requested active project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-cep-close-"));
    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    let capturedScript = "";
    adapter.executeScript = async (script) => {
        capturedScript = script;
        return { success: true, closed: true, bridge: "cep" };
    };

    const result = await adapter.closeProject("/tmp/requested.prproj");

    assert.equal(result.bridge, "cep");
    assert.match(capturedScript, /different-project/);
    assert.match(capturedScript, /closeDocument\(1,0\)/);
});

test("preset sequence assembly uses Premiere's non-modal preset API", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-preset-sequence-"));
    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    let capturedScript = "";
    adapter.executeScript = async (script) => {
        capturedScript = script;
        return { success: true };
    };

    await adapter.assembleRoughCut({
        sequenceName: "SHORT_9X16",
        presetPath: "/Applications/Adobe Premiere Pro 2026/portrait.sqpreset",
        clips: [{
            assetPath: "/tmp/master.mp4",
            sourceStartSeconds: 30,
            durationSeconds: 20,
            insertionTimeTicks: "0",
            videoTrackIndex: 0,
            audioTrackIndex: 0,
        }],
    });

    assert.match(capturedScript, /project\.newSequence\(sequenceName,presetPath\)/);
    assert.doesNotMatch(capturedScript, /project\.createNewSequence\(sequenceName,presetPath\)/);
    assert.match(capturedScript, /presetSourceStart/);
});

test("short-form Motion adapts pixel plans to Premiere's coordinate mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-short-position-"));
    const adapter = new CepAdapter({
        PREMIERE_CEP_TEMP_DIR: root,
        PREMIERE_CEP_TIMEOUT_MS: 100,
        PREMIERE_H264_PRESET: path.join(root, "unused.epr"),
    });
    let capturedScript = "";
    adapter.executeScript = async (script) => {
        capturedScript = script;
        return { success: true };
    };

    await adapter.applyShortFormPlan({
        sequenceName: "SHORT_9X16",
        shortForm: {
            target: { width: 1080, height: 1920 },
            transform: { scalePercent: 266.667, position: { x: 540, y: 960 } },
            motion: { introScaleMultiplier: 1.05, outroScaleMultiplier: 1.02, introSeconds: 0.7 },
            editing: { dialogueGainDb: 1 },
            sourceRange: { start: 30, end: 50, duration: 20 },
            styleId: "kinetic-proof",
        },
    });

    assert.match(capturedScript, /normalizedPosition/);
    assert.match(capturedScript, /coordinateProperty\.displayName==="Anchor Point"/);
    assert.match(capturedScript, /componentNormalized===null/);
    assert.match(capturedScript, /Number\(position\.x\)\/targetWidth/);
    assert.match(capturedScript, /coordinateMode:normalizedPosition\?"normalized":"pixels"/);
    assert.match(capturedScript, /audioProperty\.displayName==="Level"/);
    assert.match(capturedScript, /Math\.pow\(10,\(gainDb-15\)\/20\)/);
});

test("Premiere dB conversion accounts for the Level property's +15 dB ceiling", () => {
    assert.equal(premiereDbToLevel(15), 1);
    assert.ok(Math.abs(premiereDbToLevel(6.9) - 0.3935500755) < 1e-9);
    assert.ok(Math.abs(premiereDbToLevel(-12) - 0.0446683592) < 1e-9);
    assert.throws(() => premiereDbToLevel("not-a-level"), /finite dB value/);
});
