const registry = require("../config/content-benchmark-profiles.json");

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function profileById(id) {
    const profile = registry.profiles.find((item) => item.id === id && item.status === "active");
    if (!profile) throw new Error(`Unknown active content benchmark profile: ${id}`);
    return clone(profile);
}

function words(value) {
    return String(value || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

function overlapRatio(left, right) {
    const leftWords = new Set(words(left));
    const rightWords = new Set(words(right));
    if (!leftWords.size || !rightWords.size) return 0;
    const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
    return shared / Math.min(leftWords.size, rightWords.size);
}

function tripleHook(profile, input) {
    const spoken = String(input.spoken || "").trim();
    const written = String(input.written || "").trim();
    const visual = String(input.visual || "").trim();
    if (!spoken || !written || !visual) throw new Error("Benchmark triple hook requires spoken, written, and visual hooks.");
    const writtenCount = words(written).length;
    const limits = profile.scriptRules.writtenHookWords;
    if (writtenCount < limits.minimum || writtenCount > limits.maximum) {
        throw new Error(`Benchmark written hook must contain ${limits.minimum}-${limits.maximum} words.`);
    }
    const overlap = overlapRatio(spoken, written);
    if (overlap > 0.72) {
        throw new Error("Benchmark written hook must reframe the spoken hook instead of transcribing it.");
    }
    return {
        windowSeconds: profile.scriptRules.hookWindowSeconds,
        spoken,
        written,
        visual,
        semanticOverlapRatio: Number(overlap.toFixed(3)),
        nonDuplicative: true,
    };
}

function ctaForGoal(profile, goal = "authority") {
    const rule = profile.ctaRules[goal];
    if (!rule) throw new Error(`Benchmark CTA goal is not supported: ${goal}`);
    return { goal, ...clone(rule) };
}

function executionContract(profile, input) {
    const family = profile.formatFamilies.find((item) => item.id === input.formatFamily);
    if (!family) throw new Error(`Benchmark format family is not supported: ${input.formatFamily}`);
    return {
        profileId: profile.id,
        adaptationPolicy: profile.sourceAttribution.adaptationPolicy,
        formatFamily: clone(family),
        tripleHook: tripleHook(profile, input),
        cta: ctaForGoal(profile, input.ctaGoal),
        researchRules: clone(profile.researchRules),
        scriptRules: clone(profile.scriptRules),
        editingRules: clone(profile.editingRules),
        portablePrinciples: clone(profile.portablePrinciples),
    };
}

module.exports = { ctaForGoal, executionContract, overlapRatio, profileById, tripleHook };
