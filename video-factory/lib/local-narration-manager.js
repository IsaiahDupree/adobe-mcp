const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, run, writeJsonAtomic } = require("./util");

const ACCENTS = ["#ff4d4d", "#2dd4bf", "#facc15", "#60a5fa", "#f472b6"];

function srtTime(seconds) {
    const milliseconds = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const secs = Math.floor((milliseconds % 60000) / 1000);
    const millis = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function captionCues(text, durationSeconds) {
    const phrases = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((item) => item.trim()).filter(Boolean) || [text];
    const totalWords = phrases.reduce((sum, phrase) => sum + phrase.split(/\s+/).length, 0);
    let cursor = 0;
    return phrases.map((phrase, index) => {
        const words = phrase.split(/\s+/).length;
        const start = cursor;
        const end = index === phrases.length - 1
            ? durationSeconds
            : Math.min(durationSeconds, cursor + (durationSeconds * words) / totalWords);
        cursor = end;
        return { start, end, text: phrase };
    });
}

class LocalNarrationManager {
    constructor(config) {
        this.magickBin = config.IMAGEMAGICK_BIN;
        this.font = config.CAPTION_FONT;
    }

    scenePaths(job, scene) {
        const directory = path.join(job.workspace, "generated-assets", "local-narration", scene.id);
        return {
            directory,
            visual: path.join(directory, "visual.png"),
            audio: path.join(directory, "narration.aiff"),
            subtitle: path.join(directory, "captions.srt"),
            metadata: path.join(directory, "metadata.json"),
        };
    }

    async generateScene(job, scene, index) {
        const paths = this.scenePaths(job, scene);
        ensureDir(paths.directory);
        if (fs.existsSync(paths.metadata)) {
            const prior = readJson(paths.metadata);
            if (
                prior.status === "completed" &&
                fs.existsSync(paths.visual) &&
                fs.existsSync(paths.audio) &&
                fs.existsSync(paths.subtitle)
            ) return prior;
        }
        await run("/usr/bin/say", [
            "-v", job.generation.voiceName,
            "-r", String(job.generation.wordsPerMinute),
            "-o", paths.audio,
            scene.script,
        ], { timeout: 5 * 60 * 1000 });
        const { stdout } = await run("ffprobe", [
            "-v", "error", "-show_entries", "format=duration,size", "-of", "json", paths.audio,
        ]);
        const probe = JSON.parse(stdout);
        const durationSeconds = Number(probe.format.duration);
        const accent = ACCENTS[index % ACCENTS.length];
        const width = job.generation.aspectRatio === "9:16" ? 720 : 1280;
        const height = job.generation.aspectRatio === "9:16" ? 1280 : 720;
        const title = String(scene.title || scene.id.replaceAll("-", " ")).toUpperCase();
        await run(this.magickBin, [
            "-size", `${width}x${height}`, "xc:#0b0d10",
            "-fill", "#121720", "-draw", `roundrectangle 64,64 ${width - 64},${height - 64} 8,8`,
            "-fill", accent, "-draw", `rectangle 64,64 80,${height - 64}`,
            "-font", this.font, "-fill", "#8b95a5", "-pointsize", "28",
            "-gravity", "northwest", "-annotate", "+120+170", `RETENTION SYSTEM ${String(index + 1).padStart(2, "0")}`,
            "-fill", "white", "-pointsize", "54", "-annotate", "+120+235", title,
            "-fill", "#d3d8e0", "-pointsize", "25", "-annotate", "+120+365", "PREMIERE PRO  /  EDITABLE BENCHMARK",
            paths.visual,
        ], { timeout: 30000 });
        const cues = captionCues(scene.script, durationSeconds);
        fs.writeFileSync(paths.subtitle, `${cues.map((cue, cueIndex) =>
            `${cueIndex + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`
        ).join("\n\n")}\n`, "utf8");
        const metadata = {
            sceneId: scene.id,
            status: "completed",
            completedAt: nowIso(),
            provider: "macos-say",
            voiceName: job.generation.voiceName,
            wordsPerMinute: job.generation.wordsPerMinute,
            durationSeconds,
            localVideo: paths.visual,
            localAudio: paths.audio,
            localSubtitle: paths.subtitle,
            bytes: Number(probe.format.size),
            streams: [{ codec_type: "video", codec_name: "png", width, height }, { codec_type: "audio", codec_name: "pcm_s16be" }],
        };
        writeJsonAtomic(paths.metadata, metadata);
        return metadata;
    }

    async generate(job) {
        const scenes = [];
        for (let index = 0; index < job.generation.scenes.length; index += 1) {
            scenes.push(await this.generateScene(job, job.generation.scenes[index], index));
        }
        const manifest = {
            schemaVersion: 1,
            provider: "macos-say",
            jobId: job.id,
            generatedAt: nowIso(),
            aspectRatio: job.generation.aspectRatio,
            scenes,
            totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
        };
        writeJsonAtomic(job.outputPaths.generationManifest, manifest);
        return manifest;
    }
}

module.exports = { LocalNarrationManager, captionCues };
