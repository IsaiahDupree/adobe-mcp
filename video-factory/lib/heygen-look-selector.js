const registry = require("../config/heygen-avatar-look-registry.json");

function selectHeyGenLook(format, requestedId = null) {
    const selectedId = requestedId || registry.selected[format]?.id;
    const look = registry.looks.find((item) => item.id === selectedId);
    if (!look) throw new Error(`No registered HeyGen look is available for ${format}.`);
    const expectedOrientation = format === "16:9" ? "landscape" : "portrait";
    if (look.orientation !== expectedOrientation) {
        throw new Error(`HeyGen look ${look.id} is ${look.orientation}, not ${expectedOrientation} for ${format}.`);
    }
    return {
        ...look,
        avatarGroupId: registry.avatarGroupId,
        selectedBy: requestedId ? "explicit-request" : registry.selectionMethod,
        reason: registry.selected[format]?.id === look.id ? registry.selected[format].reason : null,
    };
}

module.exports = { registry, selectHeyGenLook };
