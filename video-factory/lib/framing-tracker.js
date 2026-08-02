const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, run, writeJsonAtomic } = require("./util");

function dominantCrop(crops) {
    const counts = new Map();
    for (const crop of crops) {
        const key = `${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const [key, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const [width, height, x, y] = key.split(":").map(Number);
    return { width, height, x, y, count };
}

class FramingTracker {
    constructor(config) {
        this.ffmpegBin = config.FFMPEG_BIN;
        this.ffprobeBin = config.FFPROBE_BIN;
        this.directory = config.FRAMING_DIR;
        this.eventsDirectory = path.join(this.directory, "events");
        ensureDir(this.eventsDirectory);
    }

    eventPath(jobId) {
        return path.join(this.eventsDirectory, `${jobId}.json`);
    }

    sourceAuditPath(job) {
        return job.outputPaths.framingSourceAudit || path.join(job.workspace, "qc", "heygen-source-framing.json");
    }

    finalAuditPath(job) {
        return job.outputPaths.framingAudit || path.join(job.workspace, "qc", "final-framing-audit.json");
    }

    async analyzeMedia(filePath) {
        const { stdout: probeText } = await run(this.ffprobeBin, [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            filePath,
        ], { timeout: 30000 });
        const stream = JSON.parse(probeText).streams?.[0];
        if (!stream?.width || !stream?.height) throw new Error(`Framing audit found no video stream in ${filePath}.`);
        const { stderr } = await run(this.ffmpegBin, [
            "-hide_banner", "-nostats",
            "-i", filePath,
            "-vf", "fps=1,cropdetect=limit=18:round=2:reset=1",
            "-an", "-f", "null", "-",
        ], { timeout: 3 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
        const crops = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((match) => ({
            width: Number(match[1]),
            height: Number(match[2]),
            x: Number(match[3]),
            y: Number(match[4]),
        }));
        if (!crops.length) throw new Error(`Framing audit produced no crop samples for ${filePath}.`);
        const dominant = dominantCrop(crops);
        const insets = {
            left: dominant.x,
            top: dominant.y,
            right: Math.max(0, stream.width - dominant.width - dominant.x),
            bottom: Math.max(0, stream.height - dominant.height - dominant.y),
        };
        const barAreaRatio = 1 - (dominant.width * dominant.height) / (stream.width * stream.height);
        return {
            filePath,
            frame: { width: stream.width, height: stream.height },
            sampleCount: crops.length,
            dominantSampleCount: dominant.count,
            persistence: Number((dominant.count / crops.length).toFixed(4)),
            detectedContentBounds: {
                width: dominant.width,
                height: dominant.height,
                x: dominant.x,
                y: dominant.y,
            },
            edgeInsetsPixels: insets,
            barAreaRatio: Number(barAreaRatio.toFixed(6)),
            fullFrameSampleRate: Number((crops.filter((crop) =>
                crop.width === stream.width && crop.height === stream.height && crop.x === 0 && crop.y === 0
            ).length / crops.length).toFixed(4)),
            provider: "ffmpeg-cropdetect-read-only",
        };
    }

    experiment(job) {
        const framing = job.composition?.framing || {};
        const format = job.generation.aspectRatio;
        const maxZoom = job.composition?.layout?.maxZoom || null;
        return {
            experimentId: framing.experimentId || `heygen-framing-${job.generation.avatarId}-${format}`,
            variantId: framing.variantId || `safe-fill-maxzoom-${maxZoom || "default"}`,
            controlId: framing.controlId || null,
            changedVariable: "camera-framing",
            framingMode: job.composition?.layout?.framingMode || "source-only",
            maximumAddedBarAreaRatio: framing.maximumAddedBarAreaRatio ?? 0.003,
            maximumFinalBarAreaRatio: framing.maximumFinalBarAreaRatio ?? 0.003,
        };
    }

    saveEvent(job, changes) {
        const existing = fs.existsSync(this.eventPath(job.id)) ? readJson(this.eventPath(job.id)) : {};
        const event = {
            ...existing,
            schemaVersion: 1,
            jobId: job.id,
            parentCompositionId: job.parentCompositionId || null,
            campaignId: job.campaignId,
            provider: job.generation.provider,
            avatarId: job.generation.avatarId,
            voiceId: job.generation.voiceId,
            engine: job.generation.engine,
            format: job.generation.aspectRatio,
            experiment: this.experiment(job),
            attempts: job.attempts,
            createdAt: existing.createdAt || nowIso(),
            updatedAt: nowIso(),
            ...changes,
        };
        writeJsonAtomic(this.eventPath(job.id), event);
        this.writeSummary();
        return event;
    }

    async auditSources(job, generation) {
        if (!job.generation.enabled || job.generation.provider !== "heygen") return { skipped: true };
        const scenes = [];
        for (const scene of generation.scenes) {
            scenes.push({
                sceneId: scene.sceneId,
                heygenVideoId: scene.videoId,
                ...(await this.analyzeMedia(scene.localVideo)),
            });
        }
        const report = {
            schemaVersion: 1,
            jobId: job.id,
            generatedAt: nowIso(),
            provider: "heygen-source-framing-audit",
            passed: scenes.every((scene) => scene.barAreaRatio <= 0.003),
            maximumBarAreaRatio: Math.max(...scenes.map((scene) => scene.barAreaRatio)),
            scenes,
        };
        writeJsonAtomic(this.sourceAuditPath(job), report);
        this.saveEvent(job, { sourceAudit: report });
        return report;
    }

    async auditFinal(job, render, sourceAudit) {
        if (!job.generation.enabled || job.generation.provider !== "heygen" || !render || render.skipped) {
            return { skipped: true };
        }
        const output = await this.analyzeMedia(render.outputFile);
        const baseline = sourceAudit?.maximumBarAreaRatio || 0;
        const maximumAdded = job.composition?.framing?.maximumAddedBarAreaRatio ?? 0.003;
        const maximumFinal = job.composition?.framing?.maximumFinalBarAreaRatio ?? 0.003;
        const addedBarAreaRatio = Math.max(0, output.barAreaRatio - baseline);
        const layout = job.composition?.enabled && fs.existsSync(job.outputPaths.responsiveLayout)
            ? readJson(job.outputPaths.responsiveLayout)
            : null;
        const cameraPlans = layout?.variants?.flatMap((variant) => variant.scenes.map((scene) => ({
            format: variant.format,
            sceneId: scene.sceneId,
            enabled: scene.camera.enabled,
            scale: scene.camera.scale,
            translation: scene.camera.translation,
            coverage: scene.camera.coverage,
        }))) || [];
        const report = {
            schemaVersion: 1,
            jobId: job.id,
            generatedAt: nowIso(),
            provider: "premiere-final-framing-audit",
            passed: addedBarAreaRatio <= maximumAdded && output.barAreaRatio <= maximumFinal,
            sourceBarAreaRatio: baseline,
            addedBarAreaRatio: Number(addedBarAreaRatio.toFixed(6)),
            maximumAddedBarAreaRatio: maximumAdded,
            maximumFinalBarAreaRatio: maximumFinal,
            output,
            cameraPlans,
        };
        writeJsonAtomic(this.finalAuditPath(job), report);
        this.saveEvent(job, { finalAudit: report });
        if (!report.passed) {
            const error = new Error("Final framing audit detected persistent bars in the final output.");
            error.code = "WORKFLOW_VALIDATION_FAILED";
            error.details = report;
            throw error;
        }
        return report;
    }

    events() {
        return fs.readdirSync(this.eventsDirectory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(path.join(this.eventsDirectory, name)))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    writeSummary() {
        const events = this.events();
        const complete = events.filter((event) => event.finalAudit && !event.finalAudit.skipped);
        const group = (field) => Object.values(events.reduce((out, event) => {
            const key = event[field] || "unknown";
            const item = out[key] || { key, generations: 0, finalAudits: 0, passes: 0 };
            item.generations += 1;
            if (event.finalAudit) {
                item.finalAudits += 1;
                if (event.finalAudit.passed) item.passes += 1;
            }
            out[key] = item;
            return out;
        }, {}));
        const groupExperiment = (field) => Object.values(events.reduce((out, event) => {
            const key = event.experiment?.[field] || "unknown";
            const item = out[key] || { key, generations: 0, finalAudits: 0, passes: 0 };
            item.generations += 1;
            if (event.finalAudit) {
                item.finalAudits += 1;
                if (event.finalAudit.passed) item.passes += 1;
            }
            out[key] = item;
            return out;
        }, {}));
        const summary = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            generationsTracked: events.length,
            finalAudits: complete.length,
            passes: complete.filter((event) => event.finalAudit.passed).length,
            failures: complete.filter((event) => !event.finalAudit.passed).length,
            passRate: complete.length
                ? Number((complete.filter((event) => event.finalAudit.passed).length / complete.length).toFixed(4))
                : null,
            byAvatar: group("avatarId"),
            byFormat: group("format"),
            byExperiment: groupExperiment("experimentId"),
            byVariant: groupExperiment("variantId"),
        };
        writeJsonAtomic(path.join(this.directory, "summary.json"), summary);
        return summary;
    }

    status(jobId = null) {
        if (jobId) {
            if (!fs.existsSync(this.eventPath(jobId))) throw new Error(`Framing event ${jobId} was not found.`);
            return readJson(this.eventPath(jobId));
        }
        return { summary: this.writeSummary(), events: this.events() };
    }
}

module.exports = { FramingTracker, dominantCrop };
