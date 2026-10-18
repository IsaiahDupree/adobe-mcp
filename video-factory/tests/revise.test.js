const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExperimentIntegrity } = require("../lib/experiment-integrity");
const { LearningEvaluator } = require("../lib/learning-evaluator");
const { PerformanceMemory } = require("../lib/performance-memory");
const { PublicationPlanner } = require("../lib/publication-planner");
const { ReviseRunner } = require("../lib/revise-runner");
const { normalizeReviseSpec } = require("../lib/revise-schema");
const { ReviseStore } = require("../lib/revise-store");

function controlledSpec(id = "result-first-hook-live") {
    const now = Date.now();
    const board = (variant) => ({
        board_id: `${id}-${variant}`,
        topic: "Autonomous Premiere workflow",
        archive: { enabled: false },
        agents: { provider: "local" },
        base_job: {
            campaign_id: "revise-integration",
            request: { topic: "Autonomous Premiere workflow" },
            generation: {
                provider: "macos_say",
                aspect_ratio: "16:9",
                scenes: [
                    {
                        id: "hook",
                        script: variant === "control"
                            ? "Editing without a measured workflow creates avoidable mistakes."
                            : "Here is the finished measured workflow before the explanation.",
                    },
                    { id: "proof", script: "A measured production workflow keeps every edit traceable." },
                    { id: "cta", script: "Inspect the workflow before the next production." },
                ],
            },
            retention: {
                caption_mode: "native",
                hook_text: variant === "control" ? "THE PROBLEM" : "THE RESULT",
            },
        },
    });
    const shared = {
        body_script: "measured-proof-body-v1",
        body_edit: "safe-fill-proof-panel-v1",
        music: "none",
        captions: "native",
        cta: "inspect-the-workflow",
        duration: "same-source-duration",
    };
    return {
        revise_id: id,
        topic_id: "autonomous-premiere-workflow",
        content_family_id: "premiere-proof-family-a",
        research: {
            opportunity: "Measure whether opening with the finished result improves early retention.",
            uncertainty: "Whether result-first framing improves the three-second hold rate.",
            maximum_evidence_age_days: 30,
            evidence: [{
                source: "live-premiere-framing-audit",
                observed_at: new Date(now).toISOString(),
                signal: "Both current HeyGen format masters passed full-frame export QA.",
            }],
            overused_patterns: ["generic problem-first opening"],
        },
        experiment: {
            type: "controlled",
            hypothesis: "Result-first openings improve three-second retention.",
            primary_variable: "hook",
            locked_variables: Object.keys(shared),
            primary_metric: "three_second_hold",
            primary_metric_direction: "higher_is_better",
            practical_significance_ratio: 0.1,
            minimum_exposure: { metric: "views", value: 1000 },
            guardrails: [{ metric: "average_percentage_viewed", maximum_decline_ratio: 0.03 }],
            replication_target_families: 3,
        },
        variants: [
            {
                variant_id: "control-problem-first",
                role: "control",
                platform: "youtube",
                variables: { hook: "problem-first", ...shared },
                board: board("control"),
            },
            {
                variant_id: "treatment-result-first",
                role: "treatment",
                platform: "youtube",
                variables: { hook: "result-first", ...shared },
                board: board("treatment"),
            },
        ],
        schedule: { start_at: new Date(now + 7 * 86400000).toISOString() },
    };
}

test("controlled REVISE schema allows one changed variable and rejects contamination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-schema-"));
    const normalized = normalizeReviseSpec(controlledSpec(), root);
    assert.equal(normalized.experiment.type, "controlled");
    assert.equal(normalized.variants.length, 2);
    const contaminated = controlledSpec("contaminated-hook-live");
    contaminated.variants[1].variables.captions = "animated";
    assert.throws(() => normalizeReviseSpec(contaminated, root), /Locked variable captions/);
});

test("REVISE design writes research and experiment artifacts to durable state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-design-"));
    const store = new ReviseStore({ REVISE_DIR: path.join(root, "revise") });
    const state = store.submit(controlledSpec("durable-revise-design"));
    const runner = new ReviseRunner({ reviseStore: store });
    const designed = await runner.design(state.id);
    assert.equal(designed.status, "DESIGNED");
    assert.ok(fs.existsSync(designed.artifacts.researchPacket));
    assert.ok(fs.existsSync(designed.artifacts.experimentSpec));
});

test("inner-loop integrity blocks asymmetrical non-primary revisions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-integrity-"));
    const state = normalizeReviseSpec(controlledSpec("integrity-revise-live"), root);
    const change = {
        sceneId: "proof",
        recommendedModification: { operation: "add_broll", scene_id: "proof", query: "workflow proof" },
    };
    const board = (id, changes) => ({
        id,
        releaseDecision: { winner: { revision: 2 } },
        revisions: [
            { revision: 1, appliedChanges: [] },
            { revision: 2, appliedChanges: changes },
        ],
    });
    const produced = (variantId, value) => ({
        variantId,
        board: value,
        winnerJob: {
            retention: { captionMode: "native" },
            result: { render: { durationSeconds: 12 } },
        },
    });
    const integrity = new ExperimentIntegrity();
    const blocked = integrity.evaluate(state, [
        produced(state.variants[0].id, board("control-board", [change])),
        produced(state.variants[1].id, board("treatment-board", [])),
    ]);
    assert.equal(blocked.passed, false);
    const mirrored = integrity.evaluate(state, [
        produced(state.variants[0].id, board("control-board", [change])),
        produced(state.variants[1].id, board("treatment-board", [change])),
    ]);
    assert.equal(mirrored.passed, true);
});

test("publication planner separates controlled variants by a matched seven-day slot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-schedule-"));
    const state = normalizeReviseSpec(controlledSpec("scheduled-revise-live"), root);
    const manifest = {
        variants: state.variants.map((variant) => ({
            variantId: variant.id,
            renderPath: `/tmp/${variant.id}.mp4`,
            renderSha256: `sha256-${variant.id}`,
        })),
    };
    const plan = new PublicationPlanner().plan(state, manifest, []);
    assert.equal(plan.passed, true);
    assert.equal(plan.slots.length, 2);
    assert.equal(
        Date.parse(plan.slots[1].scheduledFor) - Date.parse(plan.slots[0].scheduledFor),
        7 * 86400000
    );
});

test("outer-loop evaluation uses comparable real snapshot contracts and returns Replicate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-evaluate-"));
    const store = new ReviseStore({ REVISE_DIR: path.join(root, "revise") });
    let state = store.submit(controlledSpec("evaluated-revise-live"));
    state.reviewBundle = { integrity: { passed: true } };
    store.save(state);
    const capturedAt = new Date().toISOString();
    store.recordMetrics(state.id, [
        {
            variant_id: "control-problem-first",
            platform_post_id: "youtube-control-post-integration",
            window: "24h",
            captured_at: capturedAt,
            metrics: { views: 2400, three_second_hold: 0.5, average_percentage_viewed: 0.42 },
        },
        {
            variant_id: "treatment-result-first",
            platform_post_id: "youtube-treatment-post-integration",
            window: "24h",
            captured_at: capturedAt,
            metrics: { views: 2300, three_second_hold: 0.57, average_percentage_viewed: 0.43 },
        },
    ]);
    state = store.get(state.id);
    const learning = new LearningEvaluator().evaluate(state, store.list(), "24h");
    assert.equal(learning.decision, "Replicate");
    assert.equal(learning.winnerVariantId, "treatment-result-first");
    assert.equal(learning.templatePromotionEligible, false);
});

test("validated Ship decisions become future production-board memory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-template-library-"));
    const reviseDir = path.join(root, "revise");
    const boardsDir = path.join(root, "boards");
    fs.mkdirSync(boardsDir, { recursive: true });
    const store = new ReviseStore({ REVISE_DIR: reviseDir });
    const state = store.submit(controlledSpec("validated-template-revise"));
    const template = store.promoteTemplate(state, {
        templatePromotionEligible: true,
        winnerVariantId: "treatment-result-first",
        learningId: "validated-template-learning-24h",
        replicationFamilies: ["family-a", "family-b", "family-c"],
    });
    assert.equal(template.status, "validated");
    const memory = new PerformanceMemory({ BOARDS_DIR: boardsDir, REVISE_DIR: reviseDir }).analyze({
        id: "next-board",
        topic: "Next production",
        historicalEvidence: [],
    });
    assert.equal(memory.validatedTemplates.length, 1);
    assert.ok(memory.lessons.some((lesson) => lesson.lesson.includes("validated production rule")));
});
