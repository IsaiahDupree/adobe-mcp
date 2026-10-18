const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFactoryServer } = require("../lib/server");

function baseDependencies() {
    return {
        store: {
            list: () => [],
            dueJobs: () => [],
            submit: () => ({ id: "accepted-job", status: "REQUESTED" }),
            get: () => {
                throw new Error("not found");
            },
            cancel: (id) => ({ id, status: "CANCELLED" }),
            approve: (id) => ({ id, status: "COMPLETE" }),
        },
        runner: {
            activeJobId: null,
            tick: async () => ({ ran: false }),
            run: async () => ({ ran: true }),
            archive: async () => ({ archived: true }),
        },
        appManager: {
            health: async () => ({ status: "healthy" }),
            ensureReady: async () => ({ status: "ready" }),
            openProject: async () => ({ success: true }),
        },
        config: {},
    };
}

async function startFactory() {
    const { server } = createFactoryServer(baseDependencies());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function op(n, action, options = {}, operationId = `${action}_${n}`) {
    return {
        index: n - 1,
        operation_id: operationId,
        action,
        command_packet: { action, options },
    };
}

function reviewPayload(root) {
    const output = path.join(root, "exports", "internal-review.mp4");
    const qcDir = path.join(root, "qc");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(qcDir, { recursive: true });
    fs.writeFileSync(output, "rendered output evidence");
    const qcFrames = [0, 5, 10].map((second) => {
        const frame = path.join(qcDir, `frame-${second}.png`);
        fs.writeFileSync(frame, `frame ${second}`);
        return frame;
    });
    return {
        packet: {
            edit_plan_id: "marketing-api-review-001",
            output_id: "marketing-api-output-001",
            style_profile_id: "ig_operator_no_caption_proof_v1",
            social_action_id: "social-action-api-review-001",
            content_project_id: "content-project-api-review",
            experiment_id: "exp-api-review",
            variant_id: "variant-api-review",
            not_published: true,
            execution_policy: {
                provider_write_apis_called: false,
                publish_actions_allowed: false,
            },
            campaign_objective: {
                objective: "Show the edit proof to software founders.",
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
                asset_id: "owned-primary-api",
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
            outputs: {
                export_path: output,
                qc_frames: qcFrames,
                resolution: { width: 1080, height: 1920 },
            },
            operations: [
                op(1, "createProject", { path: root, name: "api-review" }, "create_project"),
                op(2, "addMediaToSequence", { itemName: "owned-primary.mov", startTimeSeconds: 0, videoTrackIndex: 0 }, "story_hook_cut"),
                op(3, "addMediaToSequence", { itemName: "broll-proof-1.mov", startTimeSeconds: 3.2, videoTrackIndex: 1 }, "add_broll_1"),
                op(4, "addMediaToSequence", { itemName: "broll-proof-2.mov", startTimeSeconds: 6.8, videoTrackIndex: 1 }, "add_broll_2"),
                op(5, "addMediaToSequence", { itemName: "broll-proof-3.mov", startTimeSeconds: 10.1, videoTrackIndex: 1 }, "add_broll_3"),
                op(6, "addMarkerToSequence", { markerName: "story beat" }, "story_beat_marker"),
                op(7, "setAudioGain", { voiceDb: -16 }),
                op(8, "exportSequence", { outputFile: output }),
                op(9, "saveProject"),
            ],
        },
        runSummary: {
            status: "COMPLETED",
            counts: { total: 9, success: 9, failed: 0, skipped: 0 },
            project_handoff: { ok: true, status: "PROJECT_HANDOFF_NOT_REQUIRED" },
            executed: [
                { n: 1, action: "createProject", status: "SUCCESS" },
                { n: 8, action: "exportSequence", status: "SUCCESS", sent_options: { outputFile: output } },
                { n: 9, action: "saveProject", status: "SUCCESS" },
            ],
        },
        outputMeasurement: { path: output, width: 1080, height: 1920 },
        qcFrames,
    };
}

test("POST /api/marketing/review-edit returns a marketing verdict and trace IDs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-review-api-"));
    const factory = await startFactory();
    try {
        const response = await fetch(`${factory.baseUrl}/api/marketing/review-edit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(reviewPayload(root)),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.verdict, "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF");
        assert.equal(body.reviewer.department, "marketing");
        assert.equal(body.socialAnalyticsTrace.edit_plan_id, "marketing-api-review-001");
        assert.equal(body.socialAnalyticsTrace.social_action_id, "social-action-api-review-001");
    } finally {
        await factory.close();
    }
});

test("POST /api/marketing/review-edit validates packet and run summary presence", async () => {
    const factory = await startFactory();
    try {
        const response = await fetch(`${factory.baseUrl}/api/marketing/review-edit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packet: {} }),
        });
        const body = await response.json();
        assert.equal(response.status, 422);
        assert.equal(body.code, "API_VALIDATION_FAILED");
        assert.equal(body.error.details.hasPacket, true);
        assert.equal(body.error.details.hasRunSummary, false);
    } finally {
        await factory.close();
    }
});
