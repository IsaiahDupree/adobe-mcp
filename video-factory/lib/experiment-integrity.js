const { nowIso } = require("./util");

const OPERATION_VARIABLE = {
    add_broll: "body_edit",
    increase_motion: "body_edit",
    strengthen_pattern_interrupt: "hook",
    enable_animated_captions: "captions",
};

function canonicalChange(change) {
    const modification = change.recommendedModification || change;
    return JSON.stringify({
        operation: modification.operation,
        sceneId: modification.scene_id || change.sceneId || null,
        query: modification.query || null,
        text: modification.text || null,
    });
}

function revisionChanges(board) {
    const winner = board.releaseDecision?.winner?.revision;
    const revision = board.revisions.find((item) => item.revision === winner) || board.revisions.at(-1);
    return revision?.appliedChanges || [];
}

class ExperimentIntegrity {
    evaluate(state, boards) {
        const issues = [];
        const variants = state.variants.map((variant) => {
            const board = boards.find((item) => item.variantId === variant.id)?.board;
            if (!board) {
                issues.push({ severity: "critical", variantId: variant.id, problem: "Variant has no completed production board." });
                return { variantId: variant.id, boardId: null, revisionCount: 0, nonPrimaryChanges: [] };
            }
            if (board.revisions.length > 3) {
                issues.push({ severity: "critical", variantId: variant.id, problem: "Variant exceeded the three-turn revision budget." });
            }
            if (!board.releaseDecision?.winner) {
                issues.push({ severity: "critical", variantId: variant.id, problem: "Variant has no blind release decision." });
            }
            const changes = revisionChanges(board);
            const nonPrimaryChanges = changes.filter((change) => {
                const operation = (change.recommendedModification || change).operation;
                return (OPERATION_VARIABLE[operation] || "unknown") !== state.experiment.primaryVariable;
            }).map(canonicalChange).sort();
            return {
                variantId: variant.id,
                boardId: board.id,
                revisionCount: board.revisions.length,
                winningRevision: board.releaseDecision?.winner?.revision || null,
                nonPrimaryChanges,
            };
        });
        if (state.experiment.type === "controlled" && variants.length > 1) {
            const reference = JSON.stringify(variants[0].nonPrimaryChanges);
            for (const variant of variants.slice(1)) {
                if (JSON.stringify(variant.nonPrimaryChanges) !== reference) {
                    issues.push({
                        severity: "critical",
                        variantId: variant.variantId,
                        problem: "Asymmetrical revision changed a variable outside the controlled experiment variable.",
                        requiredScope: "mirrored",
                        primaryVariable: state.experiment.primaryVariable,
                        referenceVariantId: variants[0].variantId,
                    });
                }
            }
            if (state.experiment.lockedVariables.includes("duration")) {
                const durations = boards.map((item) => Number(item.winnerJob?.result?.render?.durationSeconds));
                if (durations.some((duration) => !Number.isFinite(duration))) {
                    issues.push({ severity: "critical", problem: "Locked duration could not be verified for every variant." });
                } else {
                    const shortest = Math.min(...durations);
                    const longest = Math.max(...durations);
                    const spreadRatio = shortest > 0 ? (longest - shortest) / shortest : Infinity;
                    if (spreadRatio > 0.05) {
                        issues.push({
                            severity: "critical",
                            problem: "Controlled variant durations differ by more than five percent.",
                            durations,
                            spreadRatio: Number(spreadRatio.toFixed(4)),
                        });
                    }
                }
            }
            if (state.experiment.lockedVariables.includes("captions")) {
                const captionModes = boards.map((item) => item.winnerJob?.retention?.captionMode || null);
                if (new Set(captionModes).size !== 1 || captionModes.includes(null)) {
                    issues.push({
                        severity: "critical",
                        problem: "Locked caption mode is not identical across rendered variants.",
                        captionModes,
                    });
                }
            }
        }
        return {
            schemaVersion: 1,
            generatedAt: nowIso(),
            experimentId: state.experiment.id,
            type: state.experiment.type,
            primaryVariable: state.experiment.primaryVariable,
            passed: !issues.some((issue) => issue.severity === "critical"),
            revisionPolicy: {
                maximumTurns: 3,
                nonPrimaryChanges: "mirrored",
                asymmetricChangesOutsidePrimaryVariable: "publishing-blocked",
            },
            variants,
            issues,
        };
    }
}

module.exports = { ExperimentIntegrity, OPERATION_VARIABLE, canonicalChange };
