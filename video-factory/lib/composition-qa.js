const fs = require("fs");
const { nowIso, writeJsonAtomic } = require("./util");

function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function paddedFaceBounds(face, padding) {
    if (!face) return null;
    return {
        left: Math.max(0, face.cx - face.width / 2 - padding),
        top: Math.max(0, face.cy - face.height / 2 - padding),
        right: Math.min(1, face.cx + face.width / 2 + padding),
        bottom: Math.min(1, face.cy + face.height / 2 + padding),
    };
}

class CompositionQa {
    evaluate(job, visualPlan, subjectTrack, layout, assets) {
        if (!job.composition?.enabled) return { enabled: false, passed: true, variants: [] };
        const variants = layout.variants.map((variant) => {
            const issues = [];
            for (const scene of variant.scenes) {
                const words = String(scene.treatment?.text || "").trim().split(/\s+/).filter(Boolean).length;
                if (scene.treatment && (words < 2 || words > 8)) {
                    issues.push({ severity: "critical", sceneId: scene.sceneId, problem: "Treatment text is outside the 2-8 word limit.", words });
                }
                if (scene.treatment && intersects(scene.graphicRegion.bounds, scene.exclusions.captionSafeZone)) {
                    issues.push({ severity: "critical", sceneId: scene.sceneId, problem: "Graphic intersects the caption or platform UI safe zone." });
                }
                const subjectScene = subjectTrack.scenes.find((item) => item.scene_id === scene.sceneId);
                const faceCollisions = (subjectScene?.samples || []).filter((sample) => {
                    const faceBounds = paddedFaceBounds(sample.face, scene.exclusions.facePadding);
                    return scene.treatment && faceBounds && intersects(scene.graphicRegion.bounds, faceBounds);
                }).length;
                if (faceCollisions > 0) {
                    issues.push({
                        severity: "critical",
                        sceneId: scene.sceneId,
                        problem: "Foreground graphic intersects the padded face-safe region.",
                        collidingSamples: faceCollisions,
                    });
                }
                if (scene.animation.intro_seconds + scene.animation.outro_seconds >= scene.end - scene.start) {
                    issues.push({ severity: "critical", sceneId: scene.sceneId, problem: "Protected intro and outro consume the complete scene." });
                }
                if (scene.camera.enabled && scene.camera.confidence < job.composition.subjectAnalysis.minimumFaceConfidence) {
                    issues.push({ severity: "critical", sceneId: scene.sceneId, problem: "Camera move was enabled below the face-confidence threshold." });
                }
            }
            const rendered = assets.variants.find((item) => item.format === variant.format)?.graphics || [];
            const expected = variant.scenes.filter((scene) => scene.treatment && scene.grammar !== "clean_aroll");
            if (rendered.length !== expected.length) {
                issues.push({ severity: "critical", problem: "Rendered composition asset count does not match the approved layout.", expected: expected.length, actual: rendered.length });
            }
            for (const graphic of rendered) {
                if (!fs.existsSync(graphic.path) || fs.statSync(graphic.path).size === 0) {
                    issues.push({ severity: "critical", sceneId: graphic.sceneId, problem: "Rendered composition asset is missing or empty." });
                }
            }
            return {
                format: variant.format,
                passed: !issues.some((issue) => issue.severity === "critical"),
                checks: {
                    sceneCount: variant.scenes.length,
                    treatmentCount: expected.length,
                    renderedAssets: rendered.length,
                    faceDetectedScenes: variant.scenes.filter((scene) => scene.subjectDetectionRate > 0).length,
                    cameraMoveScenes: variant.scenes.filter((scene) => scene.camera.enabled).length,
                },
                issues,
            };
        });
        const report = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            enabled: true,
            passed: variants.every((variant) => variant.passed),
            evidence: {
                visualScenePlan: job.outputPaths.visualScenePlan,
                subjectTrack: job.outputPaths.subjectTrack,
                responsiveLayout: job.outputPaths.responsiveLayout,
                compositionAssets: job.outputPaths.compositionAssets,
                subjectProvider: subjectTrack.provider,
                sceneDirectorProvider: visualPlan.provider,
            },
            variants,
        };
        writeJsonAtomic(job.outputPaths.compositionQa, report);
        if (!report.passed) {
            const error = new Error("Scene composition QA failed.");
            error.code = "WORKFLOW_VALIDATION_FAILED";
            error.details = report;
            throw error;
        }
        return report;
    }
}

module.exports = { CompositionQa, intersects, paddedFaceBounds };
