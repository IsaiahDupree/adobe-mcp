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
    const job = {
        id: "benchmark-test",
        workspace,
        generation: {
            aspectRatio: "16:9",
            scenes: [{ id: "hook", title: "Hook systems", script: "Open with the result." }],
        },
        showcase: {
            enabled: true,
            minimumDurationSeconds: 300,
            maximumDurationSeconds: 480,
            brollSources: [],
            sfxSources: [],
        },
        outputPaths: { showcaseManifest: path.join(workspace, "showcase.json") },
    };
    const result = await renderer.render(job, {
        scenes: [{ sceneId: "hook", start: 0, end: 35, duration: 35 }],
    });

    assert.equal(result.frameSize.width, 1280);
    assert.equal(result.graphics.length, 2);
    assert.equal(result.coverage.length, 1);
    assert.ok(result.graphics.every((asset) => fs.statSync(asset.path).size > 1000));
    assert.ok(fs.existsSync(job.outputPaths.showcaseManifest));
});
