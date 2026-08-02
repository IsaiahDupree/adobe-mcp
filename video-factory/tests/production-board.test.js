const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { BoardStore } = require("../lib/board-store");
const { CaptionRenderer, captionLayout } = require("../lib/caption-renderer");
const { ProductionAssetBroker } = require("../lib/asset-broker");
const { ProductionBoardRunner } = require("../lib/board-runner");
const { rebasePremiereProject } = require("../lib/release-packager");
const { DeterministicEditorialJudge } = require("../lib/editorial-judge");
const { ReleaseArbiter } = require("../lib/release-arbiter");
const { Showrunner } = require("../lib/showrunner");

function boardSpec() {
    return {
        board_id: "board-test",
        topic: "Autonomous Premiere editing",
        max_revisions: 3,
        agents: { provider: "local" },
        base_job: {
            request: { topic: "Autonomous Premiere editing" },
            generation: {
                provider: "macos_say",
                aspect_ratio: "16:9",
                scenes: [
                    { id: "hook", script: "See the finished edit first." },
                    { id: "proof", script: "Now inspect the timeline proof." },
                    { id: "cta", script: "Use this workflow on the next video." },
                ],
            },
            showcase: {
                enabled: true,
                minimum_duration_seconds: 10,
                maximum_duration_seconds: 90,
                asset_policy: { mode: "provider-only" },
                asset_requests: [],
                broll_sources: [],
                sfx_sources: [],
            },
        },
    };
}

test("production board store persists a three-revision no-key workflow", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-store-"));
    const store = new BoardStore({
        BOARDS_DIR: path.join(root, "boards"),
        PASSPORT_ARCHIVE_ROOT: path.join(root, "passport"),
    });
    const board = store.submit(boardSpec());
    assert.equal(board.maxRevisions, 3);
    assert.equal(board.agents.provider, "local");
    assert.equal(board.status, "REQUESTED");
    assert.ok(fs.existsSync(path.join(board.workspace, "artifacts")));
});

test("animated captions render inside the configured safe area", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-caption-"));
    const layout = captionLayout(1280, 720);
    const renderer = new CaptionRenderer({
        IMAGEMAGICK_BIN: "/opt/homebrew/bin/magick",
        CAPTION_FONT: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    });
    const assets = await renderer.render({
        workspace: root,
        generation: { aspectRatio: "16:9", width: 1280, height: 720 },
    }, { captions: [{
        start: 0,
        end: 4,
        text: "Every production decision is structured and timecoded for an editable Premiere workflow",
    }] });
    assert.equal(assets.length, 1);
    assert.ok(assets[0].textBounds.width <= layout.safeWidth);
    assert.ok(assets[0].textBounds.height <= layout.safeHeight);
    assert.ok(fs.existsSync(assets[0].path));
});

test("asset broker retries a transient CDN download and publishes atomically", async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests += 1;
        if (requests < 3) {
            response.destroy();
            return;
        }
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.end("real-integration-payload");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-download-"));
        const destination = path.join(root, "asset.mp4");
        const broker = new ProductionAssetBroker({});
        await broker.download({
            provider: "pexels",
            providerAssetId: "integration-asset",
            url: `http://127.0.0.1:${server.address().port}/asset.mp4`,
        }, destination);
        assert.equal(requests, 3);
        assert.equal(fs.readFileSync(destination, "utf8"), "real-integration-payload");
        assert.equal(fs.readdirSync(root).some((name) => name.includes(".partial-")), false);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("Codex CLI judge failure falls back to the local judge", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-codex-fallback-"));
    const briefPath = path.join(root, "brief.json");
    const editPath = path.join(root, "edit.json");
    const showcasePath = path.join(root, "showcase.json");
    fs.writeFileSync(briefPath, JSON.stringify({ selectedHook: { text: "Show the proof" } }));
    fs.writeFileSync(editPath, JSON.stringify({ scenes: [{ sceneId: "hook", start: 0, end: 8 }] }));
    fs.writeFileSync(showcasePath, JSON.stringify({ graphics: [], videos: [] }));
    const qa = {
        passed: true,
        filters: { meanVolumeDb: -18 },
        gates: [
            { id: "native_caption_track", passed: true },
            { id: "audio_clipping", passed: true },
            { id: "excessive_silence", passed: true },
            { id: "asset_provenance", passed: true },
            { id: "cta_present", passed: true },
        ],
    };
    const runner = new ProductionBoardRunner({
        config: { FACTORY_PACKAGE_DIR: root, CODEX_JUDGE_TIMEOUT_MS: 1000 },
    });
    const cards = await runner.judgeRevision({
        agents: { provider: "codex_cli", judgeCount: 1, codexBin: "/usr/bin/false" },
    }, {
        id: "fallback-candidate",
        outputPaths: { editManifest: editPath, showcaseManifest: showcasePath },
        result: { render: { durationSeconds: 8 } },
    }, briefPath, path.join(root, "qa.json"), qa, {
        frames: [{ timeSeconds: 0 }],
        contactSheet: path.join(root, "contact-sheet.png"),
    }, root);
    assert.equal(cards[0].provider, "deterministic-local-fallback");
    assert.equal(cards[0].fallback.requestedProvider, "codex-cli-chatgpt-auth");
});

test("portable Premiere project rebases every packaged media path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-rebase-"));
    const project = path.join(root, "final.prproj");
    const oldRoot = "/tmp/original-job";
    const newRoot = "/Volumes/My Passport/VideoFactory/portable-board";
    const xml = `<PremiereData><FilePath>${oldRoot}/generated-assets/title.png</FilePath>` +
        `<ActualMediaFilePath>${oldRoot}/source-assets/clip.mp4</ActualMediaFilePath></PremiereData>`;
    fs.writeFileSync(project, zlib.gzipSync(Buffer.from(xml)));
    rebasePremiereProject(project, project, oldRoot, newRoot);
    const rebased = zlib.gunzipSync(fs.readFileSync(project)).toString("utf8");
    assert.equal(rebased.includes(oldRoot), false);
    assert.equal(rebased.match(new RegExp(newRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")).length, 2);
});

test("showrunner applies at most five cumulative structured changes", () => {
    const runner = new Showrunner();
    const board = {
        id: "revision-board",
        campaignId: "revision-board",
        topic: "Editing",
        baseJob: boardSpec().base_job,
    };
    const scorecards = [{ findings: Array.from({ length: 8 }, (_, index) => ({
        start: index,
        sceneId: `scene-${index}`,
        severity: "high",
        confidence: 0.9,
        expectedBenefit: 0.8,
        riskOfOverEditing: 0.1,
        conflictsWithBrief: false,
        recommendedModification: {
            operation: "add_broll",
            scene_id: `scene-${index}`,
            query: `proof ${index}`,
        },
    })) }];
    const directive = runner.selectChanges(2, scorecards);
    const spec = runner.applyDirectives(board.baseJob, board, 2, directive.selectedChanges);
    assert.equal(directive.selectedChanges.length, 5);
    assert.equal(spec.showcase.asset_requests.length, 5);
    assert.equal(spec.archive.enabled, false);
    assert.equal(spec.job_id, "revision-board-v2");
});

test("local editorial judge returns timecoded actionable evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-board-judge-"));
    const editPath = path.join(root, "edit.json");
    const showcasePath = path.join(root, "showcase.json");
    fs.writeFileSync(editPath, JSON.stringify({ scenes: [
        { sceneId: "hook", start: 0, end: 10 },
        { sceneId: "proof", start: 10, end: 20 },
        { sceneId: "cta", start: 20, end: 30 },
    ] }));
    fs.writeFileSync(showcasePath, JSON.stringify({ graphics: [], videos: [] }));
    const qa = {
        passed: true,
        filters: { meanVolumeDb: -18 },
        gates: [
            { id: "native_caption_track", passed: true },
            { id: "audio_clipping", passed: true },
            { id: "excessive_silence", passed: true },
            { id: "asset_provenance", passed: true },
            { id: "cta_present", passed: true },
        ],
    };
    const scorecard = new DeterministicEditorialJudge("retention").review({
        job: {
            id: "blind-candidate",
            outputPaths: { editManifest: editPath, showcaseManifest: showcasePath },
            result: { render: { durationSeconds: 30 } },
        },
        brief: { selectedHook: { text: "See the result" } },
        qa,
        media: { frames: [{ timeSeconds: 0 }] },
    });
    assert.ok(scorecard.overallScore > 0);
    assert.ok(scorecard.findings.length > 0);
    assert.ok(scorecard.findings.every((finding) => Number.isFinite(finding.start)));
    assert.ok(scorecard.findings.some((finding) => finding.recommendedModification.operation === "add_broll"));
});

test("release arbiter chooses the strongest playable version, not automatically V3", () => {
    const arbiter = new ReleaseArbiter();
    const categories = {
        hookAndImmediateClarity: 9,
        retentionPacing: 9,
        narrativeAndInformationFlow: 9,
        visualRelevanceAndVariety: 9,
        proofSpecificityAndCredibility: 9,
        captionsAndReadability: 9,
        audioAndSoundDesign: 9,
        brandAndCta: 9,
    };
    const card = (score) => ({ overallScore: score, confidence: 0.9, categories });
    const decision = arbiter.evaluate({
        topic: "Blind comparison",
        release: { minimumOverallScore: 82, minimumCategoryScore: 6, requiredJudgePasses: 2 },
        revisions: [
            { revision: 1, jobId: "one", renderPath: "one.mp4", qa: { passed: true }, scorecards: [card(84), card(85)] },
            { revision: 2, jobId: "two", renderPath: "two.mp4", qa: { passed: true }, scorecards: [card(91), card(90)] },
            { revision: 3, jobId: "three", renderPath: "three.mp4", qa: { passed: true }, scorecards: [card(86), card(87)] },
        ],
    });
    assert.equal(decision.winner.revision, 2);
    assert.equal(decision.status, "release_ready");
    assert.equal(decision.pairwiseComparisons.length, 3);
});
