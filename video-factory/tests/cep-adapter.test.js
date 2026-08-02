const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CepAdapter } = require("../lib/cep-adapter");
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
