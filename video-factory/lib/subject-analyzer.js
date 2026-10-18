const path = require("path");
const { nowIso, readJson, run, writeJsonAtomic } = require("./util");

class SubjectAnalyzer {
    constructor(config) {
        this.pythonBin = config.PYTHON_BIN;
        this.scriptPath = path.join(config.FACTORY_PACKAGE_DIR, "scripts", "analyze_subject.py");
    }

    async analyze(job, generation) {
        if (!job.composition?.enabled) return { enabled: false, scenes: [] };
        const inputPath = path.join(job.workspace, "edit-plans", "subject-analysis-input.json");
        const payload = {
            sampleIntervalSeconds: job.composition.subjectAnalysis.sampleIntervalSeconds,
            scenes: generation.scenes.map((scene) => ({
                sceneId: scene.sceneId,
                source: scene.localVideo,
                durationSeconds: scene.durationSeconds,
            })),
        };
        writeJsonAtomic(inputPath, payload);
        await run(this.pythonBin, [
            this.scriptPath,
            "--input", inputPath,
            "--output", job.outputPaths.subjectTrack,
        ], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
        const result = readJson(job.outputPaths.subjectTrack);
        result.generatedAt = nowIso();
        result.jobId = job.id;
        result.minimumFaceConfidence = job.composition.subjectAnalysis.minimumFaceConfidence;
        result.summary = {
            samples: result.scenes.reduce((sum, scene) => sum + scene.sample_count, 0),
            scenesWithFace: result.scenes.filter((scene) => scene.face_detection_rate > 0).length,
            scenesWithoutFace: result.scenes.filter((scene) => scene.face_detection_rate === 0).map((scene) => scene.scene_id),
        };
        writeJsonAtomic(job.outputPaths.subjectTrack, result);
        return result;
    }
}

module.exports = { SubjectAnalyzer };
