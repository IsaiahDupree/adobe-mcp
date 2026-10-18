const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    MarketingDepartmentRepresentative,
    evaluateRights,
    extractBrollCadence,
} = require("../lib/marketing-review-judge");

function operation(n, action, options = {}, extra = {}) {
    return {
        index: n - 1,
        operation_id: extra.operation_id || `${action}_${n}`,
        action,
        command_packet: { action, options },
        metadata: extra.metadata || {},
    };
}

function evidenceFiles(root) {
    const output = path.join(root, "exports", "approved.mp4");
    const qcDir = path.join(root, "qc");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(qcDir, { recursive: true });
    fs.writeFileSync(output, "local rendered evidence");
    const frames = [0, 5, 10].map((second) => {
        const frame = path.join(qcDir, `frame-${second}.png`);
        fs.writeFileSync(frame, `frame ${second}`);
        return frame;
    });
    return { output, frames };
}

function approvedPacket(root, overrides = {}) {
    const { output, frames } = evidenceFiles(root);
    const packet = {
        edit_plan_id: "marketing-request-ai-automation-001",
        job_id: "premiere-job-001",
        output_id: "premiere-output-001",
        style_profile_id: "ig_operator_captioned_green_hook_v1",
        social_action_id: "social-action-ai-audit-launch",
        content_project_id: "content-project-personal-brand-launch",
        experiment_id: "exp-personal-brand-ig-001",
        variant_id: "variant-captioned-proof",
        not_published: true,
        execution_policy: {
            premiere_actions_executed: true,
            provider_write_apis_called: false,
            publish_actions_allowed: false,
        },
        campaign_objective: {
            objective: "Turn software founders into AI automation audit leads.",
            audience: "Software founders at 500K to 5M ARR.",
            primary_metric: "qualified audit clicks",
            cta: "Book the AI automation audit.",
            experiment_id: "exp-personal-brand-ig-001",
        },
        platform_format: {
            platform: "instagram_reels",
            aspect_ratio: "9:16",
            width: 1080,
            height: 1920,
            fps: 30,
            target_duration_seconds: 15,
        },
        source_assets: [
            {
                asset_id: "owned-primary-001",
                role: "primary",
                kind: "video",
                path: path.join(root, "owned-primary.mov"),
                provenance: {
                    source_type: "local",
                    rights_basis: "owned",
                    rights_confirmed: true,
                    owner: "Isaiah Dupree",
                },
            },
            {
                asset_id: "owned-youtube-reference-001",
                role: "style_reference",
                kind: "reference",
                provenance: {
                    source_type: "youtube",
                    rights_basis: "owned",
                    rights_confirmed: true,
                    usage_role: "benchmark_only",
                    owner: "Isaiah Dupree",
                },
            },
        ],
        captions: {
            enabled: true,
            style: "large_active_phrase",
        },
        cut_rules: {
            remove_silence: true,
            jump_cut_pauses: true,
        },
        b_roll_rules: {
            min_gap_seconds: 3,
            max_gap_seconds: 5,
        },
        audio_mix: {
            voice_target_lufs: -16,
            duck_music_under_voice: true,
            sfx_asset_ids: ["owned-sfx-click-001"],
        },
        outputs: {
            output_id: "premiere-output-001",
            export_path: output,
            qc_frames: frames,
            resolution: { width: 1080, height: 1920 },
            sha256: "sha256-local-test",
        },
        operations: [
            operation(1, "createProject", { path: root, name: "marketing-request-001" }, { operation_id: "create_project" }),
            operation(2, "addMediaToSequence", { itemName: "owned-primary.mov", startTimeSeconds: 0, videoTrackIndex: 0 }),
            operation(3, "addMediaToSequence", { itemName: "broll-proof-1.mov", startTimeSeconds: 3.2, videoTrackIndex: 1 }, { operation_id: "add_broll_1" }),
            operation(4, "addMediaToSequence", { itemName: "broll-proof-2.mov", startTimeSeconds: 6.9, videoTrackIndex: 1 }, { operation_id: "add_broll_2" }),
            operation(5, "addMediaToSequence", { itemName: "broll-proof-3.mov", startTimeSeconds: 10.8, videoTrackIndex: 1 }, { operation_id: "add_broll_3" }),
            operation(6, "createCaptionsFromMarkers", { style: "large_active_phrase" }, { operation_id: "caption_track" }),
            operation(7, "setAudioGain", { voiceDb: -16 }),
            operation(8, "exportSequence", { outputFile: output }),
            operation(9, "saveProject"),
        ],
    };
    return { packet: { ...packet, ...overrides }, output, frames };
}

function completedRunSummary(overrides = {}) {
    return {
        status: "COMPLETED",
        counts: { total: 9, success: 9, failed: 0, skipped: 0 },
        project_handoff: {
            ok: true,
            status: "PROJECT_HANDOFF_NOT_REQUIRED",
            plan: { mode: "NO_ACTIVE_PROJECT" },
            executed: [],
        },
        executed: [
            { n: 1, operation_id: "create_project", action: "createProject", status: "SUCCESS" },
            { n: 6, operation_id: "caption_track", action: "createCaptionsFromMarkers", status: "SUCCESS" },
            { n: 7, operation_id: "setAudioGain_7", action: "setAudioGain", status: "SUCCESS" },
            { n: 8, operation_id: "exportSequence_8", action: "exportSequence", status: "SUCCESS" },
            { n: 9, operation_id: "saveProject_9", action: "saveProject", status: "SUCCESS" },
        ],
        ...overrides,
    };
}

test("marketing representative approves an evidenced owned-media Premiere edit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-approve-"));
    const { packet, output, frames } = approvedPacket(root);
    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary(),
        outputMeasurement: { path: output, width: 1080, height: 1920, durationSeconds: 15 },
        qcFrames: frames,
    });

    assert.equal(review.verdict, "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF");
    assert.ok(review.overallScore >= 82);
    assert.equal(review.requiredFixes.length, 0);
    assert.equal(review.socialAnalyticsTrace.social_action_id, "social-action-ai-audit-launch");
});

test("marketing representative rejects a project switch that did not save cleanly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-project-fail-"));
    const { packet, output, frames } = approvedPacket(root);
    const runSummary = completedRunSummary({
        project_handoff: {
            ok: false,
            status: "PROJECT_HANDOFF_FAILED",
            failedStep: { action: "saveProject", status: "ERROR" },
        },
        executed: [
            { n: 1, operation_id: "create_project", action: "createProject", status: "SUCCESS" },
            { n: 8, operation_id: "exportSequence_8", action: "exportSequence", status: "SUCCESS" },
        ],
    });

    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary,
        outputMeasurement: { path: output, width: 1080, height: 1920 },
        qcFrames: frames,
    });

    assert.equal(review.verdict, "NEEDS_EDITING_REVISION");
    assert.ok(review.requiredFixes.some((fix) => fix.code === "premiere_project_handoff_safe"));
    assert.ok(review.requiredFixes.some((fix) => fix.code === "project_saved_after_create_or_open"));
});

test("marketing representative blocks direct-use external YouTube footage without rights", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-rights-fail-"));
    const { packet, output, frames } = approvedPacket(root, {
        source_assets: [{
            asset_id: "third-party-youtube-direct-use",
            role: "b_roll",
            kind: "video",
            provenance: {
                source_type: "youtube",
                rights_basis: "reference_only",
                rights_confirmed: false,
            },
        }],
    });

    const rights = evaluateRights(packet);
    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary(),
        outputMeasurement: { path: output, width: 1080, height: 1920 },
        qcFrames: frames,
    });

    assert.equal(rights.passed, false);
    assert.ok(rights.problems.some((problem) => problem.code === "MARKETING_REVIEW_EXTERNAL_YOUTUBE_DIRECT_USE_BLOCKED"));
    assert.equal(review.verdict, "NEEDS_EDITING_REVISION");
    assert.ok(review.requiredFixes.some((fix) => fix.code === "direct_use_assets_have_rights"));
});

test("no-caption narrative edits pass when story edit evidence replaces captions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-no-caption-"));
    const expectedOutput = path.join(root, "exports", "approved.mp4");
    const { packet, output, frames } = approvedPacket(root, {
        style_profile_id: "ig_operator_no_caption_proof_v1",
        captions: { enabled: false, style: "none" },
        operations: [
            operation(1, "createProject", { path: root, name: "no-caption-story" }, { operation_id: "create_project" }),
            operation(2, "addMediaToSequence", { itemName: "owned-primary.mov", startTimeSeconds: 0, videoTrackIndex: 0 }, { operation_id: "story_hook_cut_1" }),
            operation(3, "addMediaToSequence", { itemName: "broll-proof-1.mov", startTimeSeconds: 3.1, videoTrackIndex: 1 }, { operation_id: "add_broll_1" }),
            operation(4, "addMediaToSequence", { itemName: "broll-proof-2.mov", startTimeSeconds: 6.4, videoTrackIndex: 1 }, { operation_id: "add_broll_2" }),
            operation(5, "addMediaToSequence", { itemName: "broll-proof-3.mov", startTimeSeconds: 10.2, videoTrackIndex: 1 }, { operation_id: "add_broll_3" }),
            operation(6, "addMarkerToSequence", { markerName: "story beat: problem proof" }, { operation_id: "story_beat_marker" }),
            operation(7, "setAudioGain", { voiceDb: -16 }),
            operation(8, "exportSequence", { outputFile: expectedOutput }),
            operation(9, "saveProject"),
        ],
    });

    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary(),
        outputMeasurement: { path: output, width: 1080, height: 1920 },
        qcFrames: frames,
    });

    assert.equal(extractBrollCadence(packet).maxGap <= 5.25, true);
    assert.equal(review.verdict, "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF");
    assert.equal(
        review.checks.find((check) => check.id === "caption_or_narrative_clarity_present").pass,
        true
    );
});

test("marketing review understands Premiere ticks and nested retention plans", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-retention-plan-"));
    const { output, frames } = evidenceFiles(root);
    const ticks = (seconds) => String(Math.round(seconds * 254016000000));
    const packet = {
        edit_plan_id: "retention-plan-live-style-packet",
        output_id: "retention-plan-output",
        style_profile_id: "ig_operator_no_caption_proof_v1",
        social_action_id: "social-action-retention-plan",
        content_project_id: "content-project-retention-plan",
        experiment_id: "exp-retention-plan",
        variant_id: "variant-retention-plan",
        not_published: true,
        execution_policy: {
            provider_write_apis_called: false,
            publish_actions_allowed: false,
        },
        platform_format: {
            platform: "instagram_reels",
            aspect_ratio: "9:16",
            width: 1080,
            height: 1920,
            fps: 30,
        },
        rights_summary: [{
            asset_id: "owned-retention-plan-primary",
            source_type: "local",
            rights_basis: "owned",
            rights_confirmed: true,
            usage_role: "direct_use",
            will_import: true,
        }],
        captions: { enabled: false, style: "none" },
        outputs: {
            export_path: output,
            qc_frames: frames,
            resolution: { width: 1080, height: 1920 },
        },
        operations: [
            operation(1, "createProject", { path: root, name: "retention-plan-live-style" }, { operation_id: "create_project" }),
            operation(2, "applyRetentionPlan", {
                plan: {
                    styleProfile: {
                        visual_treatment: "caption-free narrative edit with proof-led cutaways and beat markers",
                    },
                    campaignObjective: {
                        objective: "Prove the Premiere edit workflow to software founders.",
                        audience: "Software founders",
                        primary_metric: "qualified audit clicks",
                        cta: "Book the audit.",
                        experiment_id: "exp-retention-plan",
                    },
                    platformFormat: {
                        platform: "instagram_reels",
                        width: 1080,
                        height: 1920,
                    },
                    scenes: [{
                        sceneId: "hook",
                        cutRules: {
                            removeSilence: true,
                            jumpCutPauses: true,
                        },
                    }],
                    bRollRules: {
                        min_gap_seconds: 3,
                        max_gap_seconds: 5,
                    },
                    audioMix: {
                        voice_target_lufs: -16,
                        duck_music_under_voice: true,
                    },
                },
            }, { operation_id: "apply_retention_plan" }),
            operation(3, "addMediaToSequence", { itemName: "cutaway-one.mov", insertionTimeTicks: ticks(3.2), videoTrackIndex: 1 }, { operation_id: "place_broll_1" }),
            operation(4, "addMediaToSequence", { itemName: "cutaway-two.mov", insertionTimeTicks: ticks(6.8), videoTrackIndex: 1 }, { operation_id: "place_broll_2" }),
            operation(5, "addMediaToSequence", { itemName: "cutaway-three.mov", insertionTimeTicks: ticks(10.4), videoTrackIndex: 1 }, { operation_id: "place_broll_3" }),
            operation(6, "exportSequence", { outputFile: output }),
            operation(7, "saveProject"),
        ],
    };
    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary({
            counts: { total: 7, success: 7, failed: 0, skipped: 0 },
            executed: [
                { n: 1, operation_id: "create_project", action: "createProject", status: "SUCCESS" },
                { n: 6, operation_id: "exportSequence_6", action: "exportSequence", status: "SUCCESS" },
                { n: 7, operation_id: "saveProject_7", action: "saveProject", status: "SUCCESS" },
            ],
        }),
        outputMeasurement: { path: output, width: 1080, height: 1920 },
        qcFrames: frames,
    });

    assert.equal(extractBrollCadence(packet).starts.join(","), "3.2,6.8,10.4");
    assert.equal(review.verdict, "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF");
    assert.equal(review.socialAnalyticsTrace.campaign_objective, "Prove the Premiere edit workflow to software founders.");
});

test("stale dry-run execution flag on a live run is not rubber-stamped (audit F-05)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-stale-flag-"));
    const { packet, output, frames } = approvedPacket(root);
    packet.execution_policy = {
        premiere_actions_executed: false,
        provider_write_apis_called: false,
        publish_actions_allowed: false,
    };

    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary(),
        outputMeasurement: { path: output, width: 1080, height: 1920, durationSeconds: 15 },
        qcFrames: frames,
    });

    const check = review.checks.find(
        (item) => item.id === "execution_flag_consistent_with_live_run"
    );
    assert.ok(check, "consistency check must exist");
    assert.equal(check.pass, false);
    assert.ok(review.requiredFixes.some(
        (fix) => fix.code === "execution_flag_consistent_with_live_run"
    ));
});

test("empty exported file is not accepted as output evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-empty-out-"));
    const { packet, output, frames } = approvedPacket(root);
    fs.writeFileSync(output, "");

    const review = new MarketingDepartmentRepresentative().review({
        packet,
        runSummary: completedRunSummary(),
        outputMeasurement: { path: output, width: 1080, height: 1920, durationSeconds: 15 },
        qcFrames: frames,
    });

    const check = review.checks.find((item) => item.id === "output_file_evidence_exists");
    assert.equal(check.pass, false);
});
