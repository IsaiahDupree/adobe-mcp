const test = require("node:test");
const assert = require("node:assert/strict");
const {
    evaluatePremiereOperationSafety,
    isCaptionOverlayMedia,
    isStillTimelineMedia,
} = require("../lib/premiere-operation-safety");

function op(n, action, options = {}, extra = {}) {
    return {
        index: n - 1,
        operation_id: extra.operation_id || `op_${n}`,
        action,
        safe_to_execute: extra.safe_to_execute !== undefined ? extra.safe_to_execute : true,
        command_packet: { action, options },
    };
}

test("blocks caption PNG timeline overlays by default", () => {
    const operation = op(7, "addMediaToSequence", {
        itemName: "kinetic-proof-caption-07.png",
    }, {
        operation_id: "place_caption_overlay_07",
    });

    const result = evaluatePremiereOperationSafety([operation]);

    assert.equal(isCaptionOverlayMedia(operation), true);
    assert.equal(isStillTimelineMedia(operation), true);
    assert.equal(result.passed, false);
    assert.deepEqual(
        result.violations.map((item) => item.code),
        [
            "PREMIERE_CAPTION_OVERLAY_MEDIA_UNSAFE",
            "PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_UNSAFE",
            "PREMIERE_STILL_IMAGE_TIMELINE_MEDIA_BURST",
        ]
    );
});

test("blocks live clip property mutation until explicitly opted in", () => {
    const result = evaluatePremiereOperationSafety([
        op(3, "setVideoClipProperties", { scalePercent: 118 }),
    ]);

    assert.equal(result.passed, false);
    assert.equal(
        result.violations[0].code,
        "PREMIERE_UNSTABLE_CLIP_PROPERTY_MUTATION"
    );

    const optedIn = evaluatePremiereOperationSafety([
        op(3, "setVideoClipProperties", { scalePercent: 118 }),
    ], {
        allowSetVideoClipProperties: true,
    });
    assert.equal(optedIn.passed, true);
});

test("blocks declared unsafe and audio-only media placement by default", () => {
    const result = evaluatePremiereOperationSafety([
        op(4, "appendVideoTransition", {}, { safe_to_execute: false }),
        op(5, "addMediaToSequence", { itemName: "owned-procedural-sfx.wav" }),
    ]);

    assert.equal(result.passed, false);
    assert.deepEqual(
        result.violations.map((item) => item.code),
        [
            "PREMIERE_DECLARED_UNSAFE_OPERATION",
            "PREMIERE_AUDIO_MEDIA_PLACEMENT_REQUIRES_OPT_IN",
        ]
    );
});

test("allows ordinary video insert, markers, trim, QC, and export", () => {
    const result = evaluatePremiereOperationSafety([
        op(1, "addMediaToSequence", { itemName: "IMG_2360.MOV" }),
        op(2, "addMarkerToSequence", { markerName: "CAPTION 001" }),
        op(3, "setClipStartEndTimes", { trackType: "video" }),
        op(4, "exportFrame", { filePath: "/tmp/frame.png" }),
        op(5, "exportSequence", { outputFile: "/tmp/out.mp4" }),
    ]);

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
});
