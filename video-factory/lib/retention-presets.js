const PRESETS = Object.freeze({
    "social-dynamic": Object.freeze({
        id: "social-dynamic",
        visualChangeIntervalSeconds: 2.5,
        captionMode: "native",
        motion: "micro_punch_in",
        transition: "hard_cut",
        scale: 1.08,
        maxDecorativeTransitionsPerMinute: 4,
    }),
    "social-accessible": Object.freeze({
        id: "social-accessible",
        visualChangeIntervalSeconds: 3.5,
        captionMode: "native",
        motion: "slow_push",
        transition: "hard_cut",
        scale: 1.05,
        maxDecorativeTransitionsPerMinute: 2,
    }),
    "youtube-explainer": Object.freeze({
        id: "youtube-explainer",
        visualChangeIntervalSeconds: 5,
        captionMode: "native",
        motion: "micro_punch_in",
        transition: "cross_dissolve",
        scale: 1.06,
        maxDecorativeTransitionsPerMinute: 3,
    }),
});

function getRetentionPreset(id = "social-dynamic") {
    const preset = PRESETS[id];
    if (!preset) throw new Error(`Unknown retention preset: ${id}`);
    return preset;
}

module.exports = { PRESETS, getRetentionPreset };
