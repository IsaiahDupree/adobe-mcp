const fs = require("fs");
const path = require("path");
const { ensureDir, readJson, run } = require("./util");

function uniqueTimes(values, duration, max = 20) {
    return [...new Set(values
        .map((value) => Math.max(0, Math.min(duration - 0.05, Number(value))))
        .filter((value) => Number.isFinite(value))
        .map((value) => Number(value.toFixed(3))))]
        .sort((a, b) => a - b)
        .slice(0, max);
}

class MediaAnalyzer {
    constructor(config) {
        this.ffmpegBin = config.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
        this.magickBin = config.IMAGEMAGICK_BIN;
    }

    sampleTimes(job, duration) {
        const times = [];
        const interval = Math.max(1, duration / 10);
        for (let time = 0.25; time < duration; time += interval) times.push(time);
        if (fs.existsSync(job.outputPaths.editManifest)) {
            const edit = readJson(job.outputPaths.editManifest);
            for (const scene of edit.scenes || []) {
                times.push(scene.start + 0.1, Math.min(scene.end - 0.1, scene.start + 1.5));
            }
        }
        if (fs.existsSync(job.outputPaths.showcaseManifest)) {
            const showcase = readJson(job.outputPaths.showcaseManifest);
            for (const video of showcase.videos || []) times.push(video.start + 0.5);
        }
        return uniqueTimes(times, duration);
    }

    async createContactSheet(job, renderPath, duration, outputDirectory) {
        ensureDir(outputDirectory);
        const times = this.sampleTimes(job, duration);
        const frames = [];
        for (let index = 0; index < times.length; index += 1) {
            const output = path.join(outputDirectory, `frame-${String(index + 1).padStart(3, "0")}-${times[index].toFixed(2)}.png`);
            await run(this.ffmpegBin, [
                "-hide_banner", "-loglevel", "error", "-ss", String(times[index]),
                "-i", renderPath, "-frames:v", "1", "-vf", "scale=640:-2", "-y", output,
            ], { timeout: 30000 });
            frames.push({ timeSeconds: times[index], path: output });
        }
        const contactSheet = path.join(outputDirectory, "contact-sheet.png");
        await run(this.magickBin, [
            "montage", ...frames.map((frame) => frame.path),
            "-tile", "4x", "-geometry", "640x360+6+6", "-background", "#111111", contactSheet,
        ], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        return { times, frames, contactSheet };
    }
}

module.exports = { MediaAnalyzer, uniqueTimes };
