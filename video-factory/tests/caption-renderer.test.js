const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { CaptionRenderer } = require("../lib/caption-renderer");

test("caption renderer creates a real transparent vertical overlay", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-caption-render-"));
    const renderer = new CaptionRenderer({
        IMAGEMAGICK_BIN: "/opt/homebrew/bin/magick",
        CAPTION_FONT: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    });
    const assets = await renderer.render(
        { workspace, generation: { width: 720, height: 1280 } },
        { captions: [{ text: "Lead with the result", start: 0.2, end: 1.4 }] }
    );

    assert.equal(assets.length, 1);
    assert.ok(fs.statSync(assets[0].path).size > 0);
    assert.equal(
        execFileSync("/opt/homebrew/bin/magick", ["identify", "-format", "%wx%h", assets[0].path], {
            encoding: "utf8",
        }),
        "720x1280"
    );
});
