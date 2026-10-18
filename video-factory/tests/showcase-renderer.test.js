const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    ShowcaseRenderer,
    isCaptionEcho,
    semanticCallout,
    validateShowcaseTimeline,
} = require("../lib/showcase-renderer");

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
                {
                    id: "hook",
                    title: "Hook systems",
                    calloutText: "PROVE VALUE IMMEDIATELY",
                    script: "Open with the result.",
                },
                {
                    id: "proof",
                    title: "Show proof",
                    calloutText: "KEEP THE RECEIPT EDITABLE",
                    script: "Show the production receipt.",
                },
            ],
        },
        showcase: {
            enabled: true,
            minimumDurationSeconds: 300,
            maximumDurationSeconds: 480,
            brollSources: [],
            explainerAssets: [{
                id: "proof-flow",
                sceneId: "proof",
                title: "Evidence to editable master",
                eyebrow: "Visual explainer",
                points: ["Evidence", "Edit", "QA"],
                layout: "process",
                timelineOffsetSeconds: 8,
                placementDurationSeconds: 5,
            }],
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
    assert.equal(result.graphics.length, 5);
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
    assert.equal(result.graphics.find((asset) => asset.id === "proof-flow").start, 43);
    assert.equal(result.graphics.find((asset) => asset.id === "proof-flow").trackIndex, 3);
    assert.equal(result.graphics.find((asset) => asset.id === "callout-1").text, "PROVE VALUE IMMEDIATELY");
    assert.ok(result.graphics
        .filter((asset) => asset.purpose === "retention-callout")
        .every((asset) => !asset.text.includes("...") && !isCaptionEcho(
            asset.text,
            job.generation.scenes.find((scene) => asset.id === `callout-${job.generation.scenes.indexOf(scene) + 1}`).script
        )));
    assert.equal(validateShowcaseTimeline(result), result);
    assert.ok(fs.existsSync(job.outputPaths.showcaseManifest));
});

test("semantic callouts use takeaways and reject opening-caption duplication", () => {
    assert.equal(
        semanticCallout({ title: "Asset provenance", script: "Every asset needs a receipt." }),
        "TRACK EVERY ASSET"
    );
    assert.equal(
        semanticCallout({ title: "Research", script: "Protect the evidence before release." }),
        "THE KEY DECISION"
    );
    assert.equal(isCaptionEcho("Open with the result", "Open with the result and show proof."), true);
    assert.throws(
        () => semanticCallout({
            calloutText: "Open with the result",
            script: "Open with the result and show proof.",
        }),
        /repeats the opening caption/
    );
});

test("timeline validation rejects same-track collisions and invalid ranges", () => {
    assert.throws(
        () => validateShowcaseTimeline({
            graphics: [
                { id: "a", start: 1, end: 4, trackIndex: 2 },
                { id: "b", start: 3.5, end: 5, trackIndex: 2 },
            ],
        }),
        /overlaps: a and b/
    );
    assert.throws(
        () => validateShowcaseTimeline({ videos: [{ id: "bad", start: 4, end: 4, trackIndex: 1 }] }),
        /invalid timeline range/
    );
});
