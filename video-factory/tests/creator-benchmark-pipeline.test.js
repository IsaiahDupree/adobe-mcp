const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizeBoardSpec } = require("../lib/board-schema");
const { normalizeJobSpec } = require("../lib/job-schema");
const { profileById } = require("../lib/content-benchmark");

const factoryRoot = path.resolve(__dirname, "..");

test("public benchmark collector parses tokens, titles, and visible counts deterministically", () => {
    const script = [
        "import importlib.util, json",
        `spec=importlib.util.spec_from_file_location('collector', ${JSON.stringify(path.join(factoryRoot, "scripts", "collect_instagram_creator_benchmark.py"))})`,
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
        "print(json.dumps({'lsd':module.extract_lsd('\\\"LSD\\\",[],{\\\"token\\\":\\\"abc123\\\"}'),'title':module.first_caption_line('  First line \\nSecond line','fallback'),'millions':module.parse_visible_count('1.2M'),'thousands':module.parse_visible_count('4,321')}))",
    ].join(";");
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        lsd: "abc123",
        title: "First line",
        millions: 1200000,
        thousands: 4321,
    });
});

test("100-video benchmark profile points to the expanded source and measured short-form cadence", () => {
    const profile = profileById("authority-education-v1");
    assert.match(profile.sourceAttribution.analysisScope, /One hundred unique public reels/);
    assert.match(profile.sourceAttribution.sourceManifest, /top100-source\.json$/);
    assert.equal(profile.scriptRules.spokenWordsPerMinute.target, 220);
    assert.equal(profile.editingRules.visualChangeIntervalSeconds.target, 2.4);
});

test("100-video campaign spends one presenter generation and derives 21 approval-gated shorts", () => {
    const spec = JSON.parse(fs.readFileSync(path.join(factoryRoot, "examples", "isaiah-100-video-content-system-board.json")));
    const board = normalizeBoardSpec(spec, "/tmp/video-factory-boards", "/tmp/video-factory-archive");
    const job = normalizeJobSpec(board.baseJob, "/tmp/video-factory-campaigns", "/tmp/video-factory-archive", {
        avatarId: "default-avatar",
        voiceId: "default-voice",
        elevenLabsVoiceId: "default-elevenlabs",
    });
    assert.equal(job.generation.scenes.length, 1);
    assert.equal(job.generation.voiceProvider, "elevenlabs");
    assert.equal(job.generation.voiceVariantId, "elevenlabs-isaiah-v2");
    assert.equal(job.generation.concurrency, 1);
    assert.equal(job.derivativeCampaign.styles.length, 7);
    assert.equal(job.derivativeCampaign.clipsPerSource, 3);
    assert.equal(job.derivativeCampaign.schedule.approvalRequired, true);
    assert.equal(job.showcase.assetPolicy.mode, "provider-only");
    assert.equal(job.showcase.assetRequests.length, 16);
    assert.equal(job.showcase.explainerAssets.length, 8);
});

test("checked-in benchmark report contains the complete 100-video index and 80-idea backlog", () => {
    const report = fs.readFileSync(path.join(factoryRoot, "benchmarks", "personalbrandlaunch-top100-report.md"), "utf8");
    const videoRows = report.split("\n").filter((line) => /^\| \d+ \| \[[^\]]+\]\(https:\/\/www\.instagram\.com\/reel\//.test(line));
    const ideaRows = report.split("\n").filter((line) => /^\| idea-\d{3} \|/.test(line));
    assert.equal(videoRows.length, 100);
    assert.equal(ideaRows.length, 80);
    assert.match(report, /Public engagement is not private retention/);
});
