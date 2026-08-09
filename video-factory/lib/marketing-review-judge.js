const fs = require("fs");

const DIRECT_USE_RIGHTS = new Set([
    "owned",
    "licensed",
    "direct_use",
    "public_domain",
    "generated_with_commercial_rights",
    "consented",
]);

const SUCCESS_STATUSES = new Set([
    "SUCCESS",
    "EXPORT_FILE_STABLE_AFTER_RESPONSE_TIMEOUT",
    "SKIPPED_PROJECT_ALREADY_ACTIVE",
]);

const CATEGORY_WEIGHTS = {
    businessObjectiveFit: 10,
    rightsAndProvenance: 15,
    premiereProjectDiscipline: 15,
    platformReadiness: 15,
    retentionPacing: 15,
    captionOrNarrativeClarity: 10,
    audioAndSoundDesign: 10,
    analyticsTraceability: 10,
};
const PREMIERE_TICKS_PER_SECOND = 254016000000;

function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

function opAction(operation) {
    return operation?.command_packet?.action
        || operation?.action
        || operation?.operation
        || null;
}

function opOptions(operation) {
    return operation?.command_packet?.options
        || operation?.options
        || operation?.sent_options
        || {};
}

function packetOperations(packet) {
    return safeArray(packet?.operations || packet?.premiere_operations);
}

function retentionPlans(packet) {
    return packetOperations(packet)
        .filter((operation) => opAction(operation) === "applyRetentionPlan")
        .map((operation) => opOptions(operation).plan)
        .filter((plan) => plan && typeof plan === "object");
}

function firstRetentionPlan(packet) {
    return retentionPlans(packet)[0] || null;
}

function statusSucceeded(status) {
    return SUCCESS_STATUSES.has(status) || String(status || "").startsWith("SUCCESS");
}

function hasSucceededAction(runSummary, action) {
    return safeArray(runSummary?.executed).some((record) =>
        (record.action === action || record.command === action) && statusSucceeded(record.status)
    );
}

function packetHasAction(packet, action) {
    return packetOperations(packet).some((operation) =>
        opAction(operation) === action
    );
}

function extractNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function timelineStart(operation) {
    const options = opOptions(operation);
    const seconds = extractNumber(
        options.startTimeSeconds,
        options.timeline_start_seconds,
        options.timelineStartSeconds,
        options.start_seconds,
        options.startSeconds,
        options.sequenceTime,
        options.timeSeconds,
        options.time
    );
    if (seconds != null) return seconds;
    const ticks = extractNumber(
        options.insertionTimeTicks,
        options.startTimeTicks,
        options.timelineStartTicks,
        options.ticks
    );
    if (ticks != null) return Number((ticks / PREMIERE_TICKS_PER_SECOND).toFixed(3));
    return null;
}

function isLikelyBroll(operation) {
    const action = opAction(operation);
    if (action !== "addMediaToSequence" && action !== "insertClip") return false;
    const id = String(operation?.operation_id || "").toLowerCase();
    const role = String(operation?.metadata?.role || operation?.role || "").toLowerCase();
    const options = opOptions(operation);
    const item = String(options.itemName || options.name || options.filePath || "").toLowerCase();
    if (role.includes("b_roll") || role.includes("b-roll") || role === "cutaway") return true;
    if (id.includes("broll") || id.includes("b_roll") || id.includes("cutaway")) return true;
    if (item.includes("broll") || item.includes("b-roll") || item.includes("cutaway")) return true;
    return Number(options.trackIndex) > 0 || Number(options.videoTrackIndex) > 0;
}

function extractBrollCadence(packet) {
    const starts = packetOperations(packet)
        .filter(isLikelyBroll)
        .map(timelineStart)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
    const gaps = [];
    for (let i = 1; i < starts.length; i++) {
        gaps.push(Number((starts[i] - starts[i - 1]).toFixed(3)));
    }
    const averageGap = gaps.length
        ? Number((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toFixed(3))
        : null;
    return {
        starts,
        gaps,
        averageGap,
        minGap: gaps.length ? Math.min(...gaps) : null,
        maxGap: gaps.length ? Math.max(...gaps) : null,
    };
}

function captionRequired(packet) {
    const captions = packet?.captions || packet?.premiere_contract?.captions || {};
    if (captions.enabled === false) return false;
    if (String(captions.mode || captions.style || "").toLowerCase() === "none") return false;
    return Boolean(packet?.captions || packet?.premiere_contract?.captions);
}

function hasCaptionEvidence(packet, runSummary) {
    const operations = packetOperations(packet);
    const hasPacketEvidence = operations.some((operation) => {
        const action = String(opAction(operation) || "").toLowerCase();
        const id = String(operation?.operation_id || "").toLowerCase();
        return action.includes("caption") || id.includes("caption") || id.includes("subtitle");
    });
    const hasRunEvidence = safeArray(runSummary?.executed).some((record) => {
        const action = String(record.action || "").toLowerCase();
        const id = String(record.operation_id || "").toLowerCase();
        return statusSucceeded(record.status) && (action.includes("caption") || id.includes("caption"));
    });
    return hasPacketEvidence || hasRunEvidence;
}

function hasNarrativeEvidence(packet) {
    const plan = firstRetentionPlan(packet);
    const cutRules = packet?.cut_rules || packet?.premiere_contract?.cut_rules || {};
    const style = packet?.style_profile || {};
    const operations = packetOperations(packet);
    return Boolean(
        cutRules.jump_cut_pauses
        || cutRules.remove_silence
        || safeArray(plan?.scenes).some((scene) => scene?.cutRules?.jumpCutPauses || scene?.cutRules?.removeSilence)
        || plan?.bRollRules
        || plan?.styleProfile?.visual_treatment
        || style.narrative_style
        || operations.some((operation) => {
            const id = String(operation?.operation_id || "").toLowerCase();
            return id.includes("marker")
                || id.includes("story")
                || id.includes("beat")
                || id.includes("cut")
                || id.includes("retention");
        })
    );
}

function extractRightsRows(packet) {
    const sourceAssets = safeArray(packet?.source_assets || packet?.sourceAssets);
    const rightsByAsset = new Map();
    for (const row of safeArray(packet?.rights_summary)) {
        if (row?.asset_id) rightsByAsset.set(row.asset_id, row);
    }
    if (!sourceAssets.length) return safeArray(packet?.rights_summary);
    return sourceAssets.map((asset) => {
        const rights = rightsByAsset.get(asset.asset_id) || {};
        return { ...asset, ...rights, provenance: { ...(asset.provenance || {}), ...(rights.provenance || {}) } };
    });
}

function rightsBasis(row) {
    return row?.rights_basis
        || row?.rightsBasis
        || row?.provenance?.rights_basis
        || row?.rights?.basis
        || null;
}

function rightsConfirmed(row) {
    if (row?.rights_confirmed === true || row?.provenance?.rights_confirmed === true) return true;
    if (row?.rights?.confirmed === true) return true;
    return DIRECT_USE_RIGHTS.has(String(rightsBasis(row) || ""));
}

function willImport(row) {
    if (row?.will_import === false) return false;
    if (row?.eligible_for_import === false) return false;
    const role = String(row?.role || row?.usage_role || row?.provenance?.usage_role || "").toLowerCase();
    return role !== "style_reference" && role !== "benchmark_only" && role !== "reference";
}

function externalYoutubeDirectUseProblem(row) {
    const sourceType = String(row?.source_type || row?.provenance?.source_type || row?.source || "").toLowerCase();
    if (!sourceType.includes("youtube")) return false;
    return willImport(row) && (!rightsConfirmed(row) || !DIRECT_USE_RIGHTS.has(String(rightsBasis(row) || "")));
}

function evaluateRights(packet) {
    const rows = extractRightsRows(packet);
    const directUseRows = rows.filter(willImport);
    const problems = [];
    if (!rows.length) {
        problems.push({
            code: "MARKETING_REVIEW_RIGHTS_EVIDENCE_MISSING",
            message: "The packet has no source_assets or rights_summary evidence.",
        });
    }
    for (const row of directUseRows) {
        const basis = String(rightsBasis(row) || "");
        if (!rightsConfirmed(row) || !DIRECT_USE_RIGHTS.has(basis)) {
            problems.push({
                code: "MARKETING_REVIEW_ASSET_RIGHTS_BLOCKED",
                asset_id: row.asset_id || null,
                rights_basis: basis || null,
                message: "A direct-use asset is missing owned/licensed/direct-use rights evidence.",
            });
        }
        if (externalYoutubeDirectUseProblem(row)) {
            problems.push({
                code: "MARKETING_REVIEW_EXTERNAL_YOUTUBE_DIRECT_USE_BLOCKED",
                asset_id: row.asset_id || null,
                message: "External YouTube footage is style-only unless direct rights are present.",
            });
        }
    }
    return {
        rows,
        directUseCount: directUseRows.length,
        styleOnlyCount: rows.length - directUseRows.length,
        problems,
        passed: problems.length === 0 && directUseRows.length > 0,
    };
}

function platformExpected(packet) {
    const plan = firstRetentionPlan(packet);
    const platform = packet?.platform_format || packet?.platformFormat || plan?.platformFormat || {};
    const exportSettings = packet?.export_settings || packet?.premiere_contract?.export_settings || {};
    return {
        platform: platform.platform || packet?.platform || null,
        aspectRatio: platform.aspect_ratio || platform.aspectRatio || null,
        width: extractNumber(exportSettings.width, platform.width),
        height: extractNumber(exportSettings.height, platform.height),
        fps: extractNumber(exportSettings.fps, platform.fps),
        durationSeconds: extractNumber(
            packet?.outputs?.duration_seconds,
            packet?.outputs?.measurement?.duration_seconds,
            platform.target_duration_seconds,
            platform.duration_seconds
        ),
    };
}

function outputPathFromEvidence(packet, runSummary, outputMeasurement) {
    if (outputMeasurement?.path) return outputMeasurement.path;
    if (outputMeasurement?.filePath) return outputMeasurement.filePath;
    if (packet?.outputs?.export_path) return packet.outputs.export_path;
    const exportRecord = safeArray(runSummary?.executed).find((record) => record.action === "exportSequence");
    return exportRecord?.sent_options?.outputFile || exportRecord?.response?.outputFile || null;
}

function makeCheck(id, pass, severity, message, detail = {}) {
    return { id, pass: Boolean(pass), severity, message, detail };
}

function categoryScore(checks, ids) {
    const selected = checks.filter((check) => ids.includes(check.id));
    if (!selected.length) return 0;
    const passed = selected.filter((check) => check.pass).length;
    return Number(((passed / selected.length) * 10).toFixed(2));
}

function overallScore(categories) {
    const weighted = Object.entries(CATEGORY_WEIGHTS).reduce((sum, [key, weight]) => {
        return sum + Number(categories[key] || 0) * weight;
    }, 0);
    return Number((weighted / 10).toFixed(2));
}

function buildTrace(packet, runSummary, outputMeasurement) {
    const plan = firstRetentionPlan(packet);
    const output = packet?.outputs || {};
    const campaign = packet?.campaign_objective || plan?.campaignObjective || {};
    const platform = packet?.platform_format || packet?.platformFormat || plan?.platformFormat || null;
    return {
        edit_plan_id: packet?.edit_plan_id || null,
        job_id: packet?.job_id || null,
        output_id: packet?.output_id || output.output_id || null,
        style_profile_id: packet?.style_profile_id || packet?.style_profile?.style_id || null,
        social_action_id: packet?.social_action_id || null,
        content_project_id: packet?.content_project_id || null,
        experiment_id: packet?.experiment_id || campaign.experiment_id || null,
        variant_id: packet?.variant_id || null,
        campaign_objective: campaign.objective || null,
        audience: campaign.audience || null,
        cta: campaign.cta || null,
        primary_metric: campaign.primary_metric || null,
        platform_format: platform,
        output_path: outputPathFromEvidence(packet, runSummary, outputMeasurement),
        output_sha256: output.sha256 || outputMeasurement?.sha256 || null,
        runner_status: runSummary?.status || null,
        run_summary_path: runSummary?.summaryPath || runSummary?.summary_path || null,
    };
}

class MarketingDepartmentRepresentative {
    constructor(options = {}) {
        this.department = options.department || "marketing";
        this.role = options.role || "go-to-market creative representative";
        this.minimumApprovalScore = options.minimumApprovalScore || 82;
    }

    review({ packet, runSummary, outputMeasurement = {}, qcFrames = [] }) {
        const operations = packetOperations(packet);
        const expected = platformExpected(packet);
        const outputPath = outputPathFromEvidence(packet, runSummary, outputMeasurement);
        const broll = extractBrollCadence(packet);
        const rights = evaluateRights(packet);
        const opensProject = operations.some((operation) =>
            ["createProject", "openProject"].includes(opAction(operation))
        );
        const checks = [
            makeCheck(
                "runner_completed_without_operation_failures",
                runSummary?.status === "COMPLETED" && Number(runSummary?.counts?.failed || 0) === 0,
                "critical",
                "The live or dry-run operation receipt must complete without failed Premiere operations.",
                { status: runSummary?.status || null, counts: runSummary?.counts || null }
            ),
            makeCheck(
                "premiere_project_handoff_safe",
                !runSummary?.project_handoff || runSummary.project_handoff.ok !== false,
                "critical",
                "Premiere project handoff must not fail before switching work.",
                { project_handoff: runSummary?.project_handoff || null }
            ),
            makeCheck(
                "project_saved_after_create_or_open",
                !opensProject || hasSucceededAction(runSummary, "saveProject") || hasSucceededAction(runSummary, "saveProjectAs"),
                "critical",
                "Any packet that creates or opens a Premiere project must save it before approval.",
                { opens_project: opensProject }
            ),
            makeCheck(
                "no_publish_policy_preserved",
                packet?.not_published === true
                    && packet?.execution_policy?.publish_actions_allowed !== true
                    && packet?.execution_policy?.provider_write_apis_called !== true,
                "critical",
                "The edit receipt must remain local-only and unpublished.",
                { not_published: packet?.not_published, execution_policy: packet?.execution_policy || null }
            ),
            makeCheck(
                "execution_flag_consistent_with_live_run",
                Number(runSummary?.counts?.success || 0) === 0
                    || packet?.execution_policy?.premiere_actions_executed === true,
                "high",
                "A receipt for a live run must report premiere_actions_executed=true; "
                    + "a stale dry-run flag must not be rubber-stamped (audit F-05).",
                {
                    live_executed_operations: Number(runSummary?.counts?.success || 0),
                    premiere_actions_executed:
                        packet?.execution_policy?.premiere_actions_executed ?? null,
                }
            ),
            makeCheck(
                "direct_use_assets_have_rights",
                rights.passed,
                "critical",
                "Owned/licensed/direct-use assets are required for footage imported into Premiere.",
                {
                    direct_use_count: rights.directUseCount,
                    style_only_count: rights.styleOnlyCount,
                    problems: rights.problems,
                }
            ),
            makeCheck(
                "platform_resolution_matches_request",
                expected.width == null
                    || expected.height == null
                    || (Number(outputMeasurement.width || packet?.outputs?.resolution?.width) === expected.width
                        && Number(outputMeasurement.height || packet?.outputs?.resolution?.height) === expected.height),
                "high",
                "The rendered output resolution must match the requested platform format.",
                {
                    expected_width: expected.width,
                    expected_height: expected.height,
                    measured_width: outputMeasurement.width || packet?.outputs?.resolution?.width || null,
                    measured_height: outputMeasurement.height || packet?.outputs?.resolution?.height || null,
                }
            ),
            makeCheck(
                "output_file_evidence_exists",
                (() => {
                    if (!outputPath || !fs.existsSync(outputPath)) return false;
                    try {
                        return fs.statSync(outputPath).size > 0;
                    } catch (_) {
                        return false;
                    }
                })(),
                "high",
                "The reviewer needs a local, non-empty exported file as evidence.",
                {
                    output_path: outputPath,
                    output_bytes: (() => {
                        try {
                            return outputPath && fs.existsSync(outputPath)
                                ? fs.statSync(outputPath).size
                                : null;
                        } catch (_) {
                            return null;
                        }
                    })(),
                }
            ),
            makeCheck(
                "broll_cadence_three_to_five_seconds",
                // Audit F-15: aligned with the planner's 3-5s contract; the
                // ±0.25s is measurement tolerance only, not a different rule.
                broll.starts.length >= 2
                    && broll.maxGap != null
                    && broll.maxGap <= 5.25
                    && broll.minGap >= 2.75,
                "medium",
                "B-roll should be showcased every three to five seconds (3-5s contract, ±0.25s measurement tolerance).",
                broll
            ),
            makeCheck(
                "caption_or_narrative_clarity_present",
                captionRequired(packet) ? hasCaptionEvidence(packet, runSummary) : hasNarrativeEvidence(packet),
                "high",
                "Captioned edits need caption evidence; no-caption edits need clear narrative edit evidence.",
                {
                    caption_required: captionRequired(packet),
                    captions_enabled: packet?.captions?.enabled ?? packet?.premiere_contract?.captions?.enabled ?? null,
                }
            ),
            makeCheck(
                "audio_design_present",
                packetHasAction(packet, "setAudioGain")
                    || packetHasAction(packet, "setAudioMix")
                    || Boolean(packet?.audio_mix || packet?.premiere_contract?.audio_mix || firstRetentionPlan(packet)?.audioMix),
                "medium",
                "The edit should include voice/music/SFX mix instructions or executed audio commands.",
                { audio_mix: packet?.audio_mix || packet?.premiere_contract?.audio_mix || firstRetentionPlan(packet)?.audioMix || null }
            ),
            makeCheck(
                "social_analytics_trace_ids_present",
                Boolean(
                    (packet?.edit_plan_id)
                    && (packet?.output_id || packet?.outputs?.output_id)
                    && (packet?.style_profile_id || packet?.style_profile?.style_id)
                    && (packet?.social_action_id || packet?.content_project_id || packet?.experiment_id)
                ),
                "high",
                "The receipt needs stable IDs that social analytics can join back to.",
                buildTrace(packet, runSummary, outputMeasurement)
            ),
            makeCheck(
                "qc_visual_samples_present",
                safeArray(qcFrames).length >= 3 || safeArray(packet?.outputs?.qc_frames).length >= 3,
                "medium",
                "Marketing review needs enough visual samples to spot obvious edit problems.",
                { qc_frame_count: safeArray(qcFrames).length || safeArray(packet?.outputs?.qc_frames).length }
            ),
        ];
        const categories = {
            businessObjectiveFit: categoryScore(checks, ["social_analytics_trace_ids_present"]),
            rightsAndProvenance: categoryScore(checks, [
                "direct_use_assets_have_rights",
                "no_publish_policy_preserved",
                "execution_flag_consistent_with_live_run",
            ]),
            premiereProjectDiscipline: categoryScore(checks, [
                "premiere_project_handoff_safe",
                "project_saved_after_create_or_open",
            ]),
            platformReadiness: categoryScore(checks, [
                "runner_completed_without_operation_failures",
                "platform_resolution_matches_request",
                "output_file_evidence_exists",
                "qc_visual_samples_present",
            ]),
            retentionPacing: categoryScore(checks, ["broll_cadence_three_to_five_seconds"]),
            captionOrNarrativeClarity: categoryScore(checks, ["caption_or_narrative_clarity_present"]),
            audioAndSoundDesign: categoryScore(checks, ["audio_design_present"]),
            analyticsTraceability: categoryScore(checks, ["social_analytics_trace_ids_present"]),
        };
        const score = overallScore(categories);
        const failed = checks.filter((check) => !check.pass);
        const criticalFailed = failed.some((check) => check.severity === "critical");
        return {
            schemaVersion: 1,
            reviewer: {
                department: this.department,
                role: this.role,
                provider: "deterministic-local",
            },
            generatedAt: new Date().toISOString(),
            verdict: !criticalFailed && score >= this.minimumApprovalScore
                ? "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF"
                : "NEEDS_EDITING_REVISION",
            overallScore: score,
            minimumApprovalScore: this.minimumApprovalScore,
            categories,
            checks,
            requiredFixes: failed.map((check) => ({
                code: check.id,
                severity: check.severity,
                message: check.message,
                detail: check.detail,
            })),
            socialAnalyticsTrace: buildTrace(packet, runSummary, outputMeasurement),
        };
    }
}

module.exports = {
    CATEGORY_WEIGHTS,
    DIRECT_USE_RIGHTS,
    MarketingDepartmentRepresentative,
    extractBrollCadence,
    evaluateRights,
    overallScore,
};
