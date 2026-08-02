const fs = require("fs");
const path = require("path");
const { nowIso, readJson } = require("./util");

class PerformanceMemory {
    constructor(config) {
        this.boardsDir = config.BOARDS_DIR;
    }

    analyze(board) {
        const lessons = [...board.historicalEvidence];
        if (fs.existsSync(this.boardsDir)) {
            for (const entry of fs.readdirSync(this.boardsDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name === board.id) continue;
                const decisionPath = path.join(this.boardsDir, entry.name, "artifacts", "release-decision.json");
                if (!fs.existsSync(decisionPath)) continue;
                const decision = readJson(decisionPath);
                if (decision.winner?.lessons) lessons.push(...decision.winner.lessons);
            }
        }
        return {
            schemaVersion: 1,
            generatedAt: nowIso(),
            evidenceMode: "hypothesis-not-causality",
            lessons: lessons.map((lesson) => ({
                lesson: lesson.lesson,
                scope: lesson.scope || [board.topic],
                evidenceCount: Number(lesson.evidence_count || lesson.evidenceCount || 1),
                averageRetentionDelta: lesson.average_retention_delta ?? lesson.averageRetentionDelta ?? null,
                confidence: Number(lesson.confidence || 0.5),
                conditions: lesson.conditions || [],
                counterexamples: lesson.counterexamples || [],
                lastValidated: lesson.last_validated || lesson.lastValidated || nowIso().slice(0, 10),
            })),
        };
    }
}

module.exports = { PerformanceMemory };
