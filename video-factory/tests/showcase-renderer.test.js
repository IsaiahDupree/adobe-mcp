const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ShowcaseRenderer } = require("../lib/showcase-renderer");

test("showcase renderer creates chapter graphics and a coverage manifest", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-showcase-"));
    const renderer = new ShowcaseRenderer({
        IMAGEMAGICK_BIN: "/opt/homebrew/bin/magick",
        CAPTION_FONT: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    });
    const sfxPath = path.join(workspace, "confirmation.mp3");
    fs.writeFileSync(sfxPath, "test audio");
    const job = {
        id: "benchmark-test",
        workspace,
        generation: {
            aspectRatio: "16:9",
            scenes: [
                { id: "hook", title: "Hook systems", script: "Open with the result." },
                { id: "proof", title: "Show proof", script: "Show the production receipt." },
            ],
        },
        showcase: {
            enabled: true,
            minimumDurationSeconds: 300,
            maximumDurationSeconds: 480,
            brollSources: [],
            sfxSources: [{
                id: "receipt-confirmation",
                path: sfxPath,
                timelineSeconds: 2.2,
                durationSeconds: 2,
                trackIndex: 3,
                gainDb: -12,
                purpose: "receipt-cue",
                provider: "elevenlabs",
                license: "owner-generated",
            }],
        },
        outputPaths: { showcaseManifest: path.join(workspace, "showcase.json") },
    };
    const result = await renderer.render(job, {
        scenes: [
            { sceneId: "hook", start: 0, end: 35, duration: 35 },
            { sceneId: "proof", start: 35, end: 70, duration: 35 },
        ],
    });

    assert.equal(result.frameSize.width, 1280);
    assert.equal(result.graphics.length, 4);
    assert.equal(result.coverage.length, 2);
    assert.deepEqual(result.audio[0], {
        id: "receipt-confirmation",
        path: sfxPath,
        start: 2.2,
        end: 4.2,
        trackIndex: 3,
        gainDb: -12,
        purpose: "receipt-cue",
        provider: "elevenlabs",
        license: "owner-generated",
    });
    assert.ok(result.graphics.every((asset) => fs.statSync(asset.path).size > 1000));
    assert.ok(fs.existsSync(job.outputPaths.showcaseManifest));
});
