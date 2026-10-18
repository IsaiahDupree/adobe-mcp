const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function op(n, action, options = {}, operationId = `${action}_${n}`) {
    return {
        index: n - 1,
        operation_id: operationId,
        action,
        command_packet: { action, options },
    };
}

function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function fixture(root, { publishAllowed = false } = {}) {
    const output = path.join(root, "exports", "reviewed.mp4");
    const qc = path.join(root, "qc");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(qc, { recursive: true });
    fs.writeFileSync(output, "render evidence");
    const frames = [0, 5, 10].map((second) => {
        const frame = path.join(qc, `frame-${second}.png`);
        fs.writeFileSync(frame, `frame ${second}`);
        return frame;
    });
    const packet = {
        edit_plan_id: "script-review-edit-plan",
        output_id: "script-review-output",
        style_profile_id: "ig_operator_no_caption_proof_v1",
        social_action_id: "script-review-social-action",
        content_project_id: "script-review-content-project",
        experiment_id: "script-review-exp",
        variant_id: "script-review-variant",
        not_published: !publishAllowed,
        execution_policy: {
            // Live-run receipt: the run summary below reports executed
            // operations, so the truthful flag is true (audit F-05).
            premiere_actions_executed: true,
            provider_write_apis_called: false,
            publish_actions_allowed: publishAllowed,
        },
        campaign_objective: {
            objective: "Use Premiere proof edits to generate audit demand.",
            audience: "Software founders",
            primary_metric: "qualified audit clicks",
            cta: "Book the audit.",
        },
        platform_format: {
            platform: "instagram_reels",
            aspect_ratio: "9:16",
            width: 1080,
            height: 1920,
            fps: 30,
        },
        source_assets: [{
            asset_id: "owned-script-review-primary",
            role: "primary",
            provenance: {
                source_type: "local",
                rights_basis: "owned",
                rights_confirmed: true,
            },
        }],
        captions: { enabled: false, style: "none" },
        cut_rules: { remove_silence: true, jump_cut_pauses: true },
        audio_mix: { voice_target_lufs: -16, duck_music_under_voice: true },
        operations: [
            op(1, "createProject", { path: root, name: "script-review" }, "create_project"),
            op(2, "addMediaToSequence", { itemName: "owned-primary.mov", startTimeSeconds: 0, videoTrackIndex: 0 }, "story_hook_cut"),
            op(3, "addMediaToSequence", { itemName: "broll-a.mov", startTimeSeconds: 3.1, videoTrackIndex: 1 }, "add_broll_1"),
            op(4, "addMediaToSequence", { itemName: "broll-b.mov", startTimeSeconds: 6.7, videoTrackIndex: 1 }, "add_broll_2"),
            op(5, "addMediaToSequence", { itemName: "broll-c.mov", startTimeSeconds: 10.2, videoTrackIndex: 1 }, "add_broll_3"),
            op(6, "addMarkerToSequence", { markerName: "story beat" }, "story_beat_marker"),
            op(7, "setAudioGain", { voiceDb: -16 }),
            op(8, "exportFrame", { filePath: frames[0] }),
            op(9, "exportFrame", { filePath: frames[1] }),
            op(10, "exportFrame", { filePath: frames[2] }),
            op(11, "exportSequence", { outputFile: output }),
            op(12, "saveProject"),
        ],
    };
    const runSummary = {
        status: "COMPLETED",
        counts: { total: 12, success: 12, failed: 0, skipped: 0 },
        project_handoff: { ok: true, status: "PROJECT_HANDOFF_NOT_REQUIRED" },
        executed: [
            { action: "createProject", status: "SUCCESS" },
            { action: "exportSequence", status: "SUCCESS", sent_options: { outputFile: output } },
            { action: "saveProject", status: "SUCCESS" },
        ],
    };
    const packetPath = path.join(root, "packet.json");
    const runSummaryPath = path.join(root, "run-summary.json");
    writeJson(packetPath, packet);
    writeJson(runSummaryPath, runSummary);
    return { output, packetPath, runSummaryPath };
}

function runScript(args) {
    return spawnSync(process.execPath, [
        path.join(__dirname, "..", "scripts", "review-premiere-edit.js"),
        ...args,
    ], {
        encoding: "utf8",
    });
}

test("review-premiere-edit writes an approved marketing review receipt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-script-pass-"));
    const receipt = path.join(root, "marketing-review.json");
    const { output, packetPath, runSummaryPath } = fixture(root);
    const result = runScript([
        "--packet", packetPath,
        "--run-summary", runSummaryPath,
        "--output", output,
        "--width", "1080",
        "--height", "1920",
        "--write", receipt,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const review = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(review.verdict, "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF");
    assert.equal(review.socialAnalyticsTrace.output_path, output);
    assert.equal(review.requiredFixes.length, 0);
});

test("review-premiere-edit exits with a revision code when safety fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-script-fail-"));
    const { output, packetPath, runSummaryPath } = fixture(root, { publishAllowed: true });
    const result = runScript([
        "--packet", packetPath,
        "--run-summary", runSummaryPath,
        "--output", output,
        "--width", "1080",
        "--height", "1920",
    ]);

    assert.equal(result.status, 10, result.stderr || result.stdout);
    const review = JSON.parse(result.stdout);
    assert.equal(review.verdict, "NEEDS_EDITING_REVISION");
    assert.ok(review.requiredFixes.some((fix) => fix.code === "no_publish_policy_preserved"));
});
