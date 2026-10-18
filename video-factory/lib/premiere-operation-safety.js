const path = require("path");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".aif", ".aiff", ".m4a", ".aac"]);

// Crash-class operations quarantined by the operating spec: these caused a live
// Premiere/bridge disconnect during the 2026-08-09 canary work and must stay
// blocked in render transactions until isolated single-op stability tests pass.
const QUARANTINED_MARKER_ACTIONS = new Set(["addMarkerToSequence"]);
const QUARANTINED_BIN_ACTIONS = new Set([
    "createBinInActiveProject",
    "moveProjectItemsToBin",
]);

function operationNumber(op) {
    if (Number.isFinite(op.index)) return Number(op.index) + 1;
    if (Number.isFinite(op.step)) return Number(op.step);
    return null;
}

function operationOptions(op) {
    return (op.command_packet && op.command_packet.options) || op.options || {};
}

function mediaExtension(op) {
    const options = operationOptions(op);
    const itemName = String(options.itemName || options.filePath || options.outputFile || "");
    return path.extname(itemName).toLowerCase();
}

function isCaptionOverlayMedia(op) {
    if (op.action !== "addMediaToSequence") return false;
    const options = operationOptions(op);
    const text = [
        op.operation_id,
        op.action,
        options.itemName,
        options.filePath,
    ].map((value) => String(value || "").toLowerCase()).join(" ");
    return text.includes("caption_overlay") || (
        text.includes("caption") && IMAGE_EXTENSIONS.has(mediaExtension(op))
    );
}

function isStillTimelineMedia(op) {
    if (op.action !== "addMediaToSequence") return false;
    return IMAGE_EXTENSIONS.has(mediaExtension(op));
}

function isAudioTimelineMedia(op) {
    if (op.action !== "addMediaToSequence") return false;
    return AUDIO_EXTENSIONS.has(mediaExtension(op));
}

function violation(op, code, message, extra = {}) {
    return {
        code,
        message,
        operation: {
            n: operationNumber(op),
            operation_id: op.operation_id || null,
            action: op.action || null,
            itemName: operationOptions(op).itemName || null,
        },
        ...extra,
    };
}

function evaluatePremiereOperationSafety(operations, policy = {}) {
    const resolvedPolicy = {
        allowDeclaredUnsafe: Boolean(policy.allowDeclaredUnsafe),
        allowSetVideoClipProperties: Boolean(policy.allowSetVideoClipProperties),
        allowCaptionOverlayMedia: Boolean(policy.allowCaptionOverlayMedia),
        allowStillImageTimelineMedia: Boolean(policy.allowStillImageTimelineMedia),
        maxStillImageTimelineMedia: Number.isFinite(policy.maxStillImageTimelineMedia)
            ? Number(policy.maxStillImageTimelineMedia)
            : 0,
        allowAudioMediaPlacement: Boolean(policy.allowAudioMediaPlacement),
        allowTimelineMarkers: Boolean(policy.allowTimelineMarkers),
        allowBinOrganization: Boolean(policy.allowBinOrganization),
    };
    const violations = [];
    let stillTimelineMedia = 0;

    for (const op of operations) {
        if (op.safe_to_execute === false && !resolvedPolicy.allowDeclaredUnsafe) {
            violations.push(violation(
                op,
                "PREMIERE_DECLARED_UNSAFE_OPERATION",
                "Operation is explicitly marked safe_to_execute=false."
            ));
        }

        if (QUARANTINED_MARKER_ACTIONS.has(op.action) && !resolvedPolicy.allowTimelineMarkers) {
            violations.push(violation(
                op,
                "PREMIERE_TIMELINE_MARKER_QUARANTINED",
                "addMarkerToSequence is quarantined: marker bursts destabilized live "
                    + "Premiere runs. Opt in with allowTimelineMarkers only for isolated "
                    + "single-op stability tests, never inside a batch render transaction."
            ));
        }

        if (QUARANTINED_BIN_ACTIONS.has(op.action) && !resolvedPolicy.allowBinOrganization) {
            violations.push(violation(
                op,
                "PREMIERE_BIN_ORGANIZATION_QUARANTINED",
                "Bin create/move operations are quarantined from render transactions "
                    + "after a live Premiere disconnect. Run bin organization as an "
                    + "isolated post-assembly transaction with allowBinOrganization."
            ));
        }

        if (op.action === "setVideoClipProperties" && !resolvedPolicy.allowSetVideoClipProperties) {
            violations.push(violation(
                op,
                "PREMIERE_UNSTABLE_CLIP_PROPERTY_MUTATION",
                "Live clip property mutation is blocked until the UXP route is hardened."
            ));
        }

        if (
            op.action === "setClipStartEndTimes"
            && String(op.operation_id || "").toLowerCase().includes("caption_overlay")
        ) {
            violations.push(violation(
                op,
                "PREMIERE_CAPTION_OVERLAY_TRIM_UNSAFE",
                "Trimming caption-overlay still media is blocked because it has hung Premiere/bridge live runs."
            ));
        }

        if (isCaptionOverlayMedia(op) && !resolvedPolicy.allowCaptionOverlayMedia) {
            violations.push(violation(
                op,
                "PREMIERE_CAPTION_OVERLAY_MEDIA_UNSAFE",
                "Caption graphics must stay as markers/sidecars until a native caption or graphics route is stable."
            ));
        }

        if (isStillTimelineMedia(op)) {
            stillTimelineMedia += 1;
            if (!resolvedPolicy.allowStillImageTimelineMedia) {
                violations.push(violation(
                    op,
                    "PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_UNSAFE",
                    "Still-image timeline media is blocked in live packets unless explicitly opted in."
                ));
            }
        }

        if (isAudioTimelineMedia(op) && !resolvedPolicy.allowAudioMediaPlacement) {
            violations.push(violation(
                op,
                "PREMIERE_AUDIO_MEDIA_PLACEMENT_REQUIRES_OPT_IN",
                "Audio-only media placement requires explicit opt-in until track routing is verified."
            ));
        }
    }

    if (stillTimelineMedia > resolvedPolicy.maxStillImageTimelineMedia) {
        violations.push({
            code: "PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_BURST",
            message: "Too many still-image timeline insertions for a live Premiere run.",
            count: stillTimelineMedia,
            maximum: resolvedPolicy.maxStillImageTimelineMedia,
        });
    }

    return {
        passed: violations.length === 0,
        policy: resolvedPolicy,
        counts: {
            operations: operations.length,
            stillTimelineMedia,
        },
        violations,
    };
}

module.exports = {
    evaluatePremiereOperationSafety,
    isAudioTimelineMedia,
    isCaptionOverlayMedia,
    isStillTimelineMedia,
    operationNumber,
    operationOptions,
};
