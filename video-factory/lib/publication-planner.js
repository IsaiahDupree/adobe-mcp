const { nowIso } = require("./util");

const DAY_MS = 24 * 60 * 60 * 1000;

function hoursBetween(left, right) {
    return Math.abs(Date.parse(left) - Date.parse(right)) / 3600000;
}

function sameUtcDay(left, right) {
    return String(left).slice(0, 10) === String(right).slice(0, 10);
}

class PublicationPlanner {
    collision(candidate, occupied, state) {
        const rules = state.schedule;
        const reasons = [];
        for (const slot of occupied) {
            const sameFamily = slot.generationFamilyId === candidate.generationFamilyId;
            const samePlatform = slot.platform === candidate.platform;
            const hours = hoursBetween(slot.scheduledFor, candidate.scheduledFor);
            if (sameFamily && sameUtcDay(slot.scheduledFor, candidate.scheduledFor)) {
                reasons.push("same-family-same-day");
            }
            if (sameFamily && hours < 24) reasons.push("adjacent-calendar-slots-same-family");
            if (sameFamily && samePlatform && hours < rules.sameFamilySamePlatformCooldownDays * 24) {
                reasons.push("same-family-same-platform-cooldown");
            }
            if (sameFamily && !samePlatform && hours < rules.sameFamilyCrossPlatformCooldownHours) {
                reasons.push("same-family-cross-platform-cooldown");
            }
            const controlledException =
                state.experiment.type === "controlled" &&
                slot.experimentId === state.experiment.id;
            if (
                samePlatform &&
                slot.nearDuplicateGroup === candidate.nearDuplicateGroup &&
                hours < rules.nearDuplicateSamePlatformCooldownDays * 24 &&
                !controlledException
            ) {
                reasons.push("near-duplicate-same-platform-cooldown");
            }
            if (
                samePlatform &&
                candidate.renderSha256 &&
                slot.renderSha256 === candidate.renderSha256 &&
                hours < rules.exactExportRepostCooldownDays * 24
            ) {
                reasons.push("exact-export-repost-cooldown");
            }
        }
        return [...new Set(reasons)];
    }

    occupiedSlots(states, currentId) {
        return states.filter((item) => item.id !== currentId)
            .flatMap((item) => item.publicationPlan?.slots || []);
    }

    plan(state, variantManifest, states = []) {
        const occupied = this.occupiedSlots(states, state.id);
        const slots = [];
        const adjustments = [];
        const base = Date.parse(state.schedule.startAt);
        for (const [index, variant] of state.variants.entries()) {
            const lineage = variantManifest.variants.find((item) => item.variantId === variant.id);
            const spacingMs = state.experiment.type === "controlled" ? 7 * DAY_MS : DAY_MS;
            let proposed = variant.proposedAt ? Date.parse(variant.proposedAt) : base + index * spacingMs;
            if (!Number.isFinite(proposed)) throw new Error(`Variant ${variant.id} has an invalid proposed_at value.`);
            let candidate;
            let reasons = [];
            for (let attempt = 0; attempt < 60; attempt += 1) {
                candidate = {
                    slotId: `${state.id}-${variant.id}`,
                    reviseId: state.id,
                    experimentId: state.experiment.id,
                    contentFamilyId: state.contentFamilyId,
                    generationFamilyId: variant.generationFamilyId,
                    nearDuplicateGroup: variant.nearDuplicateGroup,
                    variantId: variant.id,
                    platform: variant.platform,
                    scheduledFor: new Date(proposed).toISOString(),
                    renderPath: lineage.renderPath,
                    renderSha256: lineage.renderSha256,
                    status: "planned",
                };
                reasons = this.collision(candidate, [...occupied, ...slots], state);
                if (!reasons.length) break;
                proposed += spacingMs;
                adjustments.push({
                    variantId: variant.id,
                    attempt: attempt + 1,
                    reasons,
                    movedTo: new Date(proposed).toISOString(),
                });
            }
            if (reasons.length) throw new Error(`Could not find a collision-free publication slot for ${variant.id}.`);
            slots.push(candidate);
        }
        return {
            schemaVersion: 1,
            generatedAt: nowIso(),
            reviseId: state.id,
            experimentId: state.experiment.id,
            passed: true,
            mode: "plan-only-no-publish-side-effect",
            rules: state.schedule,
            slots,
            adjustments,
        };
    }
}

module.exports = { PublicationPlanner, hoursBetween, sameUtcDay };
