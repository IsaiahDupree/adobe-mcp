const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, run, writeJsonAtomic } = require("./util");

const ACCENTS = ["#ff4d4d", "#2dd4bf", "#facc15", "#60a5fa", "#f472b6"];

function frameSize(aspectRatio) {
    return aspectRatio === "9:16" ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

function concise(text, limit = 42) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length <= limit ? value : `${value.slice(0, limit - 1).trim()}...`;
}

class ShowcaseRenderer {
    constructor(config) {
        this.magickBin = config.IMAGEMAGICK_BIN;
        this.font = config.CAPTION_FONT;
    }

    async graphic(output, width, height, drawArgs) {
        await run(
            this.magickBin,
            ["-size", `${width}x${height}`, "xc:none", ...drawArgs, output],
            { timeout: 30000 }
        );
    }

    async render(job, plan) {
        if (!job.showcase || !job.showcase.enabled) {
            return { enabled: false, graphics: [], videos: [], audio: [] };
        }
        const directory = path.join(job.workspace, "generated-assets", "showcase");
        ensureDir(directory);
        const { width, height } = frameSize(job.generation.aspectRatio);
        const graphics = [];
        const scenesById = new Map(job.generation.scenes.map((scene) => [scene.id, scene]));

        for (let index = 0; index < plan.scenes.length; index += 1) {
            const scene = plan.scenes[index];
            const source = scenesById.get(scene.sceneId) || {};
            const title = concise(source.title || scene.sceneId.replaceAll("-", " "), 38).toUpperCase();
            const accent = ACCENTS[index % ACCENTS.length];
            const chapterPath = path.join(directory, `chapter-${String(index + 1).padStart(2, "0")}.png`);
            const progress = Math.max(1, Math.round(((index + 1) / plan.scenes.length) * (width - 120)));
            await this.graphic(chapterPath, width, height, [
                "-fill", "#29313ddd", "-draw", `roundrectangle 60,28 ${width - 60},42 7,7`,
                "-fill", accent, "-draw", `roundrectangle 60,28 ${60 + progress},42 7,7`,
                "-font", this.font, "-fill", "#d3d8e0", "-pointsize", String(Math.round(height * 0.027)),
                "-gravity", "northeast", "-annotate", "+60+56", `${String(index + 1).padStart(2, "0")} / ${String(plan.scenes.length).padStart(2, "0")}`,
            ]);
            graphics.push({
                id: `chapter-${index + 1}`,
                text: title,
                path: chapterPath,
                start: scene.start,
                end: Math.min(scene.end, scene.start + 1.8),
                trackIndex: 2,
                purpose: "chapter-card",
            });

            const calloutPath = path.join(directory, `callout-${String(index + 1).padStart(2, "0")}.png`);
            const callout = concise(source.script, 58).toUpperCase();
            await this.graphic(calloutPath, width, height, [
                "-fill", "#0b0d10d9", "-draw", `roundrectangle ${Math.round(width * 0.08)},${Math.round(height * 0.12)} ${Math.round(width * 0.67)},${Math.round(height * 0.31)} 8,8`,
                "-fill", accent, "-draw", `rectangle ${Math.round(width * 0.08)},${Math.round(height * 0.12)} ${Math.round(width * 0.095)},${Math.round(height * 0.31)}`,
                "-font", this.font, "-fill", "white", "-pointsize", String(Math.round(height * 0.034)),
                "-gravity", "northwest", "-annotate", `+${Math.round(width * 0.12)}+${Math.round(height * 0.17)}`, callout,
            ]);
            const calloutStart = scene.start + Math.max(4, scene.duration * 0.48);
            graphics.push({
                id: `callout-${index + 1}`,
                text: callout,
                path: calloutPath,
                start: calloutStart,
                end: Math.min(scene.end - 0.3, calloutStart + 2.6),
                trackIndex: 2,
                purpose: "retention-callout",
            });
        }

        const brollScenes = plan.scenes.slice(3, 3 + job.showcase.brollSources.length);
        const videos = job.showcase.brollSources.map((entry, index) => {
            const source = typeof entry === "string" ? entry : entry.path;
            const requestedSceneId = typeof entry === "string" ? null : entry.sceneId;
            if (!fs.existsSync(source)) throw new Error(`Showcase B-roll does not exist: ${source}`);
            const scene = plan.scenes.find((item) => item.sceneId === requestedSceneId) ||
                brollScenes[index] || plan.scenes[Math.min(index, plan.scenes.length - 1)];
            const start = scene.start + Math.min(7, scene.duration * 0.28);
            return {
                id: entry.id || `broll-${index + 1}`,
                path: source,
                sourceStart: typeof entry === "string" ? 0 : entry.sourceStart,
                scale: typeof entry === "string" ? 66.667 : entry.scale,
                start,
                end: Math.min(scene.end - 0.5, start + (entry.placementDurationSeconds || 5)),
                trackIndex: 1,
                purpose: entry.purpose || "visual-proof",
                provider: entry.provider || null,
                providerAssetId: entry.providerAssetId || null,
                pageUrl: entry.pageUrl || null,
                creator: entry.creator || null,
                attribution: entry.attribution || null,
                license: entry.license || "owner-supplied",
                licenseUrl: entry.licenseUrl || null,
                sha256: entry.sha256 || null,
            };
        });

        const audioScenes = plan.scenes.slice(1);
        const audio = job.showcase.sfxSources.map((source, index) => {
            if (!fs.existsSync(source)) throw new Error(`Showcase SFX does not exist: ${source}`);
            const scene = audioScenes[(index * 3) % audioScenes.length];
            return {
                id: `sfx-${index + 1}`,
                path: source,
                start: scene.start,
                end: Math.min(scene.end, scene.start + 1.5),
                trackIndex: 1 + index,
                purpose: "chapter-transition-sfx",
                license: "owner-supplied",
            };
        });

        const manifest = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            frameSize: { width, height },
            expectedDuration: {
                minimumSeconds: job.showcase.minimumDurationSeconds,
                maximumSeconds: job.showcase.maximumDurationSeconds,
            },
            coverage: plan.scenes.map((scene, index) => ({
                sceneId: scene.sceneId,
                chapter: index + 1,
                graphicEvents: 2,
            })),
            graphics,
            videos,
            audio,
        };
        writeJsonAtomic(job.outputPaths.showcaseManifest, manifest);
        return manifest;
    }
}

module.exports = { ShowcaseRenderer, frameSize };
