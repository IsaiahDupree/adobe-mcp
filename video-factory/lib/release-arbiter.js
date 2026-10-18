const { nowIso } = require("./util");

class ReleaseArbiter {
    judgePass(scorecard, release) {
        return scorecard.overallScore >= release.minimumOverallScore &&
            Object.values(scorecard.categories).every((score) => score >= release.minimumCategoryScore);
    }

    evaluate(board) {
        const candidates = board.revisions.map((revision) => {
            const averageScore = revision.scorecards.reduce((sum, card) => sum + card.overallScore, 0) /
                Math.max(1, revision.scorecards.length);
            const judgePasses = revision.scorecards.filter((card) => this.judgePass(card, board.release)).length;
            return {
                revision: revision.revision,
                jobId: revision.jobId,
                playable: Boolean(revision.renderPath),
                technicalPass: revision.qa.passed,
                averageScore: Number(averageScore.toFixed(2)),
                judgePasses,
                releaseReady: revision.qa.passed && judgePasses >= board.release.requiredJudgePasses,
                scorecards: revision.scorecards,
            };
        });
        const playable = candidates.filter((candidate) => candidate.playable && candidate.technicalPass);
        const pool = playable.length > 0 ? playable : candidates.filter((candidate) => candidate.playable);
        if (pool.length === 0) throw new Error("Release arbiter found no playable revision.");
        const winner = [...pool].sort((a, b) =>
            Number(b.releaseReady) - Number(a.releaseReady) ||
            b.averageScore - a.averageScore ||
            a.revision - b.revision
        )[0];
        const pairwiseComparisons = [];
        for (let left = 0; left < candidates.length; left += 1) {
            for (let right = left + 1; right < candidates.length; right += 1) {
                const a = candidates[left];
                const b = candidates[right];
                const preferred = a.averageScore === b.averageScore
                    ? (a.technicalPass ? a.revision : b.revision)
                    : (a.averageScore > b.averageScore ? a.revision : b.revision);
                pairwiseComparisons.push({
                    labels: [`candidate-${left + 1}`, `candidate-${right + 1}`],
                    revisions: [a.revision, b.revision],
                    preferredRevision: preferred,
                    scoreDelta: Number(Math.abs(a.averageScore - b.averageScore).toFixed(2)),
                });
            }
        }
        return {
            schemaVersion: 1,
            decidedAt: nowIso(),
            status: winner.releaseReady ? "release_ready" : "needs_review",
            releaseThreshold: board.release,
            winner: {
                revision: winner.revision,
                jobId: winner.jobId,
                averageScore: winner.averageScore,
                judgePasses: winner.judgePasses,
                technicalPass: winner.technicalPass,
                lessons: [{
                    lesson: `Revision ${winner.revision} produced the strongest blind aggregate editorial score for ${board.topic}.`,
                    scope: [board.topic, "Premiere production board"],
                    evidenceCount: winner.scorecards.length,
                    confidence: Math.min(...winner.scorecards.map((card) => card.confidence || 0.5)),
                    conditions: ["provider-only assets", "maximum three revisions"],
                }],
            },
            candidates: candidates.map(({ scorecards, ...candidate }) => candidate),
            pairwiseComparisons,
        };
    }
}

module.exports = { ReleaseArbiter };
