const { METRIC_WINDOWS } = require("./revise-schema");
const { nowIso } = require("./util");

const WINDOW_ORDER = [...METRIC_WINDOWS];

function ratioDelta(control, treatment, direction = "higher_is_better") {
    if (control === 0) return treatment === 0 ? 0 : null;
    const raw = (treatment - control) / Math.abs(control);
    return direction === "lower_is_better" ? -raw : raw;
}

function guardrailPass(control, treatment, guardrail) {
    if (control === 0) return treatment === 0;
    const decline = ratioDelta(control, treatment, guardrail.direction);
    return decline !== null && decline >= -guardrail.maximumDeclineRatio;
}

class LearningEvaluator {
    selectWindow(state, requestedWindow = null) {
        if (requestedWindow && !METRIC_WINDOWS.has(requestedWindow)) {
            throw new Error(`Unknown metric window ${requestedWindow}.`);
        }
        const candidates = requestedWindow ? [requestedWindow] : [...WINDOW_ORDER].reverse();
        for (const window of candidates) {
            if (state.variants.every((variant) => state.metricSnapshots.some((snapshot) =>
                snapshot.variantId === variant.id && snapshot.window === window
            ))) return window;
        }
        throw new Error("No comparable metric window contains every variant.");
    }

    replicationFamilies(state, states) {
        const families = new Set([state.contentFamilyId]);
        for (const candidate of states) {
            if (candidate.id === state.id || !candidate.learningRecord) continue;
            const positive = ["Ship", "Replicate"].includes(candidate.learningRecord.decision);
            if (
                positive &&
                candidate.experiment.hypothesis === state.experiment.hypothesis &&
                candidate.experiment.primaryVariable === state.experiment.primaryVariable
            ) families.add(candidate.contentFamilyId);
        }
        return [...families];
    }

    evaluate(state, states = [], requestedWindow = null) {
        const window = this.selectWindow(state, requestedWindow);
        const snapshots = state.variants.map((variant) => {
            const matching = state.metricSnapshots.filter((snapshot) =>
                snapshot.variantId === variant.id && snapshot.window === window
            ).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
            return { variant, snapshot: matching[0] };
        });
        const exposure = snapshots.map(({ variant, snapshot }) => ({
            variantId: variant.id,
            value: snapshot.metrics[state.experiment.minimumExposure.metric],
            required: state.experiment.minimumExposure.value,
            passed: snapshot.metrics[state.experiment.minimumExposure.metric] >= state.experiment.minimumExposure.value,
        }));
        const contaminated = state.reviewBundle?.integrity?.passed === false;
        const replicationFamilies = this.replicationFamilies(state, states);
        let decision = "Hold";
        let winnerVariantId = null;
        let comparisons = [];
        const reasons = [];

        if (contaminated) {
            reasons.push("Experiment integrity failed because revisions changed non-primary variables asymmetrically.");
        } else if (exposure.some((item) => !item.passed)) {
            reasons.push("At least one variant has not reached the declared minimum exposure.");
        } else if (state.experiment.type === "platform_adaptation") {
            decision = "Segment";
            reasons.push("Platform adaptations are evaluated as separate audience segments, not causal A/B tests.");
        } else {
            const control = snapshots.find(({ variant }) => variant.role === "control") || snapshots[0];
            comparisons = snapshots.filter((item) => item !== control).map(({ variant, snapshot }) => {
                const primaryControl = control.snapshot.metrics[state.experiment.primaryMetric];
                const primaryTreatment = snapshot.metrics[state.experiment.primaryMetric];
                const primaryDeltaRatio = ratioDelta(
                    primaryControl,
                    primaryTreatment,
                    state.experiment.primaryMetricDirection
                );
                const guardrails = state.experiment.guardrails.map((guardrail) => ({
                    metric: guardrail.metric,
                    direction: guardrail.direction,
                    control: control.snapshot.metrics[guardrail.metric],
                    treatment: snapshot.metrics[guardrail.metric],
                    passed: guardrailPass(
                        control.snapshot.metrics[guardrail.metric],
                        snapshot.metrics[guardrail.metric],
                        guardrail
                    ),
                }));
                return {
                    controlVariantId: control.variant.id,
                    treatmentVariantId: variant.id,
                    primaryMetric: state.experiment.primaryMetric,
                    controlValue: primaryControl,
                    treatmentValue: primaryTreatment,
                    primaryDeltaRatio,
                    practicallyMeaningful: primaryDeltaRatio !== null &&
                        Math.abs(primaryDeltaRatio) >= state.experiment.practicalSignificanceRatio,
                    guardrails,
                    guardrailsPassed: guardrails.every((guardrail) => guardrail.passed),
                };
            });
            const ranked = comparisons.filter((item) => item.primaryDeltaRatio !== null)
                .sort((a, b) => b.primaryDeltaRatio - a.primaryDeltaRatio);
            const best = ranked[0];
            if (
                best &&
                best.primaryDeltaRatio >= state.experiment.practicalSignificanceRatio &&
                best.guardrailsPassed
            ) {
                winnerVariantId = best.treatmentVariantId;
                decision = replicationFamilies.length >= state.experiment.replicationTargetFamilies
                    ? "Ship"
                    : "Replicate";
                reasons.push("Primary metric improved by the declared practical threshold and every guardrail passed.");
            } else if (
                ranked.length > 0 &&
                ranked.every((item) => item.primaryDeltaRatio <= -state.experiment.practicalSignificanceRatio)
            ) {
                decision = "Reject";
                reasons.push("Every treatment underperformed the control by the declared practical threshold.");
            } else {
                reasons.push("The result is inconclusive or a guardrail failed.");
            }
        }
        return {
            schemaVersion: 1,
            learningId: `${state.experiment.id}-${window}`,
            generatedAt: nowIso(),
            reviseId: state.id,
            topicId: state.topicId,
            contentFamilyId: state.contentFamilyId,
            experimentId: state.experiment.id,
            window,
            decision,
            winnerVariantId,
            reasons,
            contaminated,
            exposure,
            comparisons,
            replicationFamilies,
            replicationTargetFamilies: state.experiment.replicationTargetFamilies,
            templatePromotionEligible:
                decision === "Ship" &&
                !contaminated &&
                exposure.every((item) => item.passed),
            lineage: snapshots.map(({ variant, snapshot }) => ({
                variantId: variant.id,
                platformPostId: snapshot.platformPostId,
                snapshotId: snapshot.snapshotId,
            })),
        };
    }
}

module.exports = { LearningEvaluator, guardrailPass, ratioDelta };
