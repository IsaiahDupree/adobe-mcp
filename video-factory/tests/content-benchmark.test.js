const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BriefArchitect } = require("../lib/brief-architect");
const { normalizeBoardSpec } = require("../lib/board-schema");
const { executionContract, overlapRatio, profileById, tripleHook } = require("../lib/content-benchmark");

test("benchmark profile creates a non-duplicative triple hook and goal-matched CTA", () => {
    const profile = profileById("authority-education-v1");
    const contract = executionContract(profile, {
        spoken: "Most AI content workflows fail after the generation step.",
        written: "TOOL VS. CONTENT SYSTEM",
        visual: "Split screen: a loose stack of apps becomes one traced production line.",
        formatFamily: "benchmark-comparison-ladder",
        ctaGoal: "lead-magnet",
    });
    assert.equal(contract.tripleHook.nonDuplicative, true);
    assert.ok(contract.tripleHook.semanticOverlapRatio < 0.72);
    assert.equal(contract.cta.mode, "keyword-comment");
    assert.equal(contract.editingRules.captionPolicy.includes("no gray lower bar"), true);
});

test("benchmark hook rejects captions copied into the written callout", () => {
    const profile = profileById("authority-education-v1");
    assert.throws(() => tripleHook(profile, {
        spoken: "This is the exact same spoken hook",
        written: "THE EXACT SAME SPOKEN HOOK",
        visual: "Presenter points to the text",
    }), /reframe the spoken hook/);
    assert.ok(overlapRatio("tool versus system", "system beats disconnected tools") > 0);
});

test("production brief carries benchmark research, script, edit, hook, and CTA constraints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-benchmark-brief-"));
    const board = normalizeBoardSpec({
        board_id: "isaiah-tool-vs-system",
        topic: "An AI tool is not an autonomous content system",
        base_job: {
            request: {
                topic: "An AI tool is not an autonomous content system",
                viewer_problem: "Creators connect tools but cannot trace what worked.",
                cta: "Comment SYSTEM for the production map.",
            },
            retention: { hook_text: "Most AI content workflows fail after generation." },
            generation: {
                scenes: [
                    { id: "hook", script: "Most AI content workflows fail after generation." },
                    { id: "contrast", script: "A tool makes one asset. A system tracks the entire decision chain." },
                    { id: "proof", script: "Research, generation, editing, publishing, and retention all share one receipt." },
                    { id: "cta", script: "Comment SYSTEM for the production map." }
                ]
            }
        },
        content_benchmark: {
            profile_id: "authority-education-v1",
            format_family: "benchmark-comparison-ladder",
            written_hook: "TOOL VS. CONTENT SYSTEM",
            visual_hook: "Disconnected apps collapse into one traced production line.",
            cta_goal: "lead-magnet"
        }
    }, path.join(root, "boards"), path.join(root, "passport"));
    const brief = new BriefArchitect().create(board, { candidates: [] }, { lessons: [] });
    assert.equal(brief.benchmarkExecution.profileId, "authority-education-v1");
    assert.equal(brief.benchmarkExecution.formatFamily.id, "benchmark-comparison-ladder");
    assert.equal(brief.benchmarkExecution.tripleHook.written, "TOOL VS. CONTENT SYSTEM");
    assert.equal(brief.cta.benchmarkRule.mode, "keyword-comment");
    assert.ok(brief.benchmarkExecution.researchRules.requiredEvidence.includes("one proof point or demonstration"));
});

test("benchmark profile exposes the three expanded short-form grammars", () => {
    const profile = profileById("authority-education-v1");
    const ids = profile.formatFamilies.map((family) => family.id);
    assert.deepEqual(ids.slice(-3), [
        "benchmark-contrarian-deconstruction",
        "benchmark-screen-proof-walkthrough",
        "benchmark-before-after-reveal",
    ]);
    assert.ok(profile.formatFamilies.every((family) => family.bestFor.length >= 3));
});
