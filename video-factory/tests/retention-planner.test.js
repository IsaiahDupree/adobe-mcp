const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RetentionPlanner } = require("../lib/retention-planner");

test("retention planner offsets HeyGen captions across semantic scene cuts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-planner-"));
    const scenes = ["hook", "payoff"].map((id) => {
        const directory = path.join(root, id);
        fs.mkdirSync(directory, { recursive: true });
        const subtitle = path.join(directory, "captions.srt");
        fs.writeFileSync(subtitle, `1\n00:00:00,100 --> 00:00:01,200\n${id} caption\n`, "utf8");
        return { sceneId: id, durationSeconds: 1.5, localVideo: __filename, localSubtitle: subtitle };
    });
    const job = {
        id: "planner-test",
        generation: { enabled: true },
        retention: {
            enabled: true,
            hookText: "WHY VIEWERS LEAVE",
            patternInterruptText: "THE FIX",
            punchInScale: 1.08,
        },
        production: { sequenceName: "MASTER" },
        outputPaths: {
            generationManifest: path.join(root, "generation.json"),
            combinedCaptions: path.join(root, "transcripts", "combined.srt"),
            editManifest: path.join(root, "edit-plans", "retention.json"),
        },
    };
    const result = new RetentionPlanner().plan(job, { scenes });

    assert.equal(result.editor, "premiere-pro");
    assert.equal(result.scenes.length, 2);
    assert.equal(result.captions.length, 2);
    assert.equal(result.captions[1].start, 1.6);
    assert.equal(result.metrics.plannedPunchIns, 2);
    assert.match(fs.readFileSync(job.outputPaths.combinedCaptions, "utf8"), /00:00:01,600/);
});
