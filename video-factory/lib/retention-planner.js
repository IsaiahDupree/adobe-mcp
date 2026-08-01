const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, writeJsonAtomic } = require("./util");

function subtitleSeconds(value) {
    const match = value.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(filePath) {
    return fs
        .readFileSync(filePath, "utf8")
        .replace(/\r/g, "")
        .trim()
        .split(/\n\s*\n/)
        .map((block) => {
            const lines = block.split("\n");
            const timingIndex = lines.findIndex((line) => line.includes("-->"));
            if (timingIndex < 0) return null;
            const [startText, endText] = lines[timingIndex].split("-->");
            const start = subtitleSeconds(startText);
            const end = subtitleSeconds(endText);
            const text = lines
                .slice(timingIndex + 1)
                .join(" ")
                .replace(/<[^>]+>/g, "")
                .replace(/\s+/g, " ")
                .trim();
            return start === null || end === null || !text ? null : { start, end, text };
        })
        .filter(Boolean);
}

function srtTime(seconds) {
    const milliseconds = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const secs = Math.floor((milliseconds % 60000) / 1000);
    const millis = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

class RetentionPlanner {
    plan(job, generationResult = null) {
        if (!job.generation.enabled || !job.retention.enabled) return { skipped: true };
        const generation = generationResult || readJson(job.outputPaths.generationManifest);
        const scenes = [];
        const captions = [];
        let cursor = 0;

        generation.scenes.forEach((scene, index) => {
            if (!fs.existsSync(scene.localVideo) || !fs.existsSync(scene.localSubtitle)) {
                throw new Error(`Generated scene ${scene.sceneId} is missing its video or SRT.`);
            }
            const duration = Number(scene.durationSeconds);
            const sceneCaptions = parseSrt(scene.localSubtitle).map((cue) => ({
                ...cue,
                start: cue.start + cursor,
                end: Math.min(cursor + duration, cue.end + cursor),
                sceneId: scene.sceneId,
            }));
            captions.push(...sceneCaptions);
            const punchStart = cursor + Math.min(1.1, duration * 0.25);
            const punchEnd = Math.min(cursor + duration - 0.1, punchStart + Math.min(1.6, duration * 0.35));
            scenes.push({
                sceneId: scene.sceneId,
                source: scene.localVideo,
                start: cursor,
                end: cursor + duration,
                duration,
                punchIn: {
                    start: punchStart,
                    end: punchEnd,
                    scale: Math.round(job.retention.punchInScale * 100),
                },
                patternInterrupt: index > 0 ? job.retention.patternInterruptText : null,
            });
            cursor += duration;
        });
        if (captions.length === 0) throw new Error("HeyGen returned no usable caption cues.");

        ensureDir(path.dirname(job.outputPaths.combinedCaptions));
        fs.writeFileSync(
            job.outputPaths.combinedCaptions,
            `${captions
                .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`)
                .join("\n\n")}\n`,
            "utf8"
        );
        const manifest = {
            schemaVersion: 1,
            jobId: job.id,
            createdAt: nowIso(),
            editor: "premiere-pro",
            sequenceName: job.production.sequenceName,
            durationSeconds: cursor,
            hook: job.retention.hookText
                ? { text: job.retention.hookText, start: 0, end: Math.min(1.9, cursor) }
                : null,
            scenes,
            captions,
            metrics: {
                scenes: scenes.length,
                captionCues: captions.length,
                plannedPunchIns: scenes.length,
                plannedPatternInterrupts: scenes.filter((scene) => scene.patternInterrupt).length,
            },
        };
        writeJsonAtomic(job.outputPaths.editManifest, manifest);
        return manifest;
    }
}

module.exports = { RetentionPlanner, parseSrt };
