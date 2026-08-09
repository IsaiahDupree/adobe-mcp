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

test("allows ordinary video insert, trim, QC, and export", () => {
    const result = evaluatePremiereOperationSafety([
        op(1, "addMediaToSequence", { itemName: "IMG_2360.MOV" }),
        op(2, "setClipStartEndTimes", { trackType: "video" }),
        op(3, "exportFrame", { filePath: "/tmp/narrative-no-caption-frame.png" }),
        op(4, "exportSequence", { outputFile: "/tmp/out.mp4" }),
    ]);

    assert.equal(isCaptionOverlayMedia(op(3, "exportFrame", {
        filePath: "/tmp/narrative-no-caption-frame.png",
    })), false);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
});

test("quarantines timeline markers by default and honors the opt-in", () => {
    const marker = op(2, "addMarkerToSequence", { markerName: "CAPTION 001" });

    const blocked = evaluatePremiereOperationSafety([marker]);
    assert.equal(blocked.passed, false);
    assert.deepEqual(
        blocked.violations.map((item) => item.code),
        ["PREMIERE_TIMELINE_MARKER_QUARANTINED"]
    );

    const optedIn = evaluatePremiereOperationSafety([marker], {
        allowTimelineMarkers: true,
    });
    assert.equal(optedIn.passed, true);
});

test("quarantines bin create/move by default and honors the opt-in", () => {
    const operations = [
        op(1, "createBinInActiveProject", { binName: "A-Roll" }),
        op(2, "moveProjectItemsToBin", { binName: "A-Roll", itemNames: ["IMG_2360.MOV"] }),
    ];

    const blocked = evaluatePremiereOperationSafety(operations);
    assert.equal(blocked.passed, false);
    assert.deepEqual(
        blocked.violations.map((item) => item.code),
        [
            "PREMIERE_BIN_ORGANIZATION_QUARANTINED",
            "PREMIERE_BIN_ORGANIZATION_QUARANTINED",
        ]
    );

    const optedIn = evaluatePremiereOperationSafety(operations, {
        allowBinOrganization: true,
    });
    assert.equal(optedIn.passed, true);
});

test("quarantine opt-ins do not unlock other blocked classes", () => {
    const result = evaluatePremiereOperationSafety([
        op(1, "addMarkerToSequence", { markerName: "CAPTION 001" }),
        op(2, "setVideoClipProperties", { scalePercent: 118 }),
    ], {
        allowTimelineMarkers: true,
        allowBinOrganization: true,
    });

    assert.equal(result.passed, false);
    assert.deepEqual(
        result.violations.map((item) => item.code),
        ["PREMIERE_UNSTABLE_CLIP_PROPERTY_MUTATION"]
    );
});
