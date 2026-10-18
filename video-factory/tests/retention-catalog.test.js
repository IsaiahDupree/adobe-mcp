const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../config/retention-capabilities.json");
const creativeReferences = require("../config/creative-reference-registry.json");
const { PRESETS, getRetentionPreset } = require("../lib/retention-presets");

test("retention catalog has unique purpose-tagged capabilities", () => {
    const ids = catalog.capabilities.map((capability) => capability.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(catalog.capabilities.length >= 35);
    assert.ok(catalog.capabilities.every((capability) => catalog.tiers[capability.tier]));
    assert.ok(catalog.capabilities.every((capability) => capability.compiler && capability.goal));
    assert.ok(catalog.activeCompilers.includes("srt_caption_track"));
});

test("retention presets define a stable visual cadence", () => {
    assert.equal(getRetentionPreset().id, "social-dynamic");
    for (const preset of Object.values(PRESETS)) {
        assert.ok(preset.visualChangeIntervalSeconds >= 2);
        assert.ok(preset.visualChangeIntervalSeconds <= 6);
        assert.equal(preset.captionMode, "native");
    }
});

test("creative references are GitHub pattern sources, never implicit media licenses", () => {
    const ids = creativeReferences.references.map((reference) => reference.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(creativeReferences.policy.includes("Never import repository media"));
    assert.ok(creativeReferences.references.every((reference) =>
        reference.repository.startsWith("https://github.com/") &&
        reference.patterns.length > 0 &&
        reference.licenseScope
    ));
});
