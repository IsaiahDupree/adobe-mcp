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

function normalizedWords(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isCaptionEcho(callout, script) {
    const normalizedCallout = normalizedWords(callout);
    const normalizedScript = normalizedWords(script);
    if (!normalizedCallout || !normalizedScript) return false;
    return normalizedScript === normalizedCallout || normalizedScript.startsWith(`${normalizedCallout} `);
}

function semanticCallout(scene = {}) {
    const explicit = String(scene.calloutText || scene.callout_text || scene.callout || "")
        .replace(/\s+/g, " ")
        .trim();
    if (explicit) {
        if (explicit.length > 48) throw new Error("Callout text must be 48 characters or fewer.");
        if (isCaptionEcho(explicit, scene.script)) {
            throw new Error(`Callout repeats the opening caption: ${explicit}`);
        }
        return explicit.toUpperCase();
    }

    const text = normalizedWords(`${scene.title || ""} ${scene.script || ""}`);
    const candidates = [
        [/\b(research|evidence|proof)\b/, "PROTECT THE EVIDENCE"],
        [/\b(premiere|project|edit|editor)\b/, "KEEP THE PROJECT EDITABLE"],
        [/\b(quality|check|release|review)\b/, "PROVE IT BEFORE RELEASE"],
        [/\b(asset|license|provider|provenance)\b/, "TRACK EVERY ASSET"],
        [/\b(voice|audio|sound|dialogue)\b/, "KEEP DIALOGUE IN FRONT"],
        [/\b(experiment|test|measure|retention)\b/, "TEST ONE VARIABLE AT A TIME"],
    ];
    const match = candidates.find(([pattern]) => pattern.test(text));
    const derived = match ? match[1] : "THE KEY DECISION";
    return isCaptionEcho(derived, scene.script) ? "THE KEY DECISION" : derived;
}

function validateShowcaseTimeline(manifest) {
    const collections = [
        ["graphics", manifest.graphics || []],
        ["videos", manifest.videos || []],
        ["audio", manifest.audio || []],
    ];
    for (const [kind, events] of collections) {
        for (const event of events) {
            if (![event.start, event.end, event.trackIndex].every(Number.isFinite)) {
                throw new Error(`${kind} event ${event.id} has non-finite timing or track data.`);
            }
            if (event.start < 0 || event.end <= event.start || event.trackIndex < 0) {
                throw new Error(`${kind} event ${event.id} has an invalid timeline range.`);
            }
        }
        const byTrack = new Map();
        for (const event of events) {
            if (!byTrack.has(event.trackIndex)) byTrack.set(event.trackIndex, []);
            byTrack.get(event.trackIndex).push(event);
        }
        for (const [trackIndex, trackEvents] of byTrack) {
            const ordered = trackEvents.sort((a, b) => a.start - b.start || a.end - b.end);
            for (let index = 1; index < ordered.length; index += 1) {
                const previous = ordered[index - 1];
                const current = ordered[index];
                if (current.start < previous.end - 0.001) {
                    throw new Error(
                        `${kind} track ${trackIndex} overlaps: ${previous.id} and ${current.id}.`
                    );
                }
            }
        }
    }
    return manifest;
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

    async explainerGraphic(output, width, height, explainer, accent) {
        const pointSize = Math.round(height * 0.034);
        const titleSize = Math.round(height * 0.06);
        const cardWidth = Math.round((width - 180) / explainer.points.length);
        const cards = explainer.points.map((point, index) => {
            const left = 70 + index * cardWidth;
            const right = left + cardWidth - 18;
            const top = Math.round(height * 0.43);
            const bottom = Math.round(height * 0.76);
            return [
                "-fill", index === 0 ? "#17222bea" : "#111820e8",
                "-stroke", index === 0 ? accent : "#63718066",
                "-strokewidth", "2",
                "-draw", `roundrectangle ${left},${top} ${right},${bottom} 8,8`,
                "-fill", accent,
                "-stroke", "none",
                "-draw", `circle ${left + 34},${top + 34} ${left + 45},${top + 34}`,
                "-font", this.font,
                "-fill", "#091015",
                "-pointsize", String(Math.round(pointSize * 0.72)),
                "-gravity", "northwest",
                "-annotate", `+${left + 26}+${top + 22}`, String(index + 1),
                "-fill", "white",
                "-pointsize", String(pointSize),
                "-annotate", `+${left + 20}+${top + 88}`, concise(point, 24).toUpperCase(),
            ];
        }).flat();
        await this.graphic(output, width, height, [
            "-fill", "#071016f2", "-draw", `rectangle 0,0 ${width},${height}`,
            "-fill", accent, "-draw", `rectangle 0,0 14,${height}`,
            "-font", this.font, "-gravity", "northwest",
            "-fill", accent, "-pointsize", String(Math.round(height * 0.025)),
            "-annotate", "+70+70", concise(explainer.eyebrow, 34).toUpperCase(),
            "-fill", "white", "-pointsize", String(titleSize),
            "-annotate", "+70+112", concise(explainer.title, 42).toUpperCase(),
            ...cards,
            "-fill", "#94a3b8", "-pointsize", String(Math.round(height * 0.022)),
            "-gravity", "southwest", "-annotate", "+70+42", "PREMIERE VIDEO FACTORY / AUDITABLE PRODUCTION",
        ]);
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
            const callout = semanticCallout(source);
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
            const requestedOffset = typeof entry === "string" ? null : entry.timelineOffsetSeconds;
            const start = scene.start + (Number.isFinite(requestedOffset)
                ? Math.min(requestedOffset, Math.max(0, scene.duration - 2.5))
                : Math.min(7, scene.duration * 0.28));
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

        for (const [index, explainer] of (job.showcase.explainerAssets || []).entries()) {
            const scene = plan.scenes.find((item) => item.sceneId === explainer.sceneId);
            if (!scene) throw new Error(`Explainer scene does not exist: ${explainer.sceneId}`);
            const accent = ACCENTS[(index + 1) % ACCENTS.length];
            const output = path.join(directory, `${explainer.id}.png`);
            await this.explainerGraphic(output, width, height, explainer, accent);
            const start = scene.start + Math.min(
                explainer.timelineOffsetSeconds,
                Math.max(0, scene.duration - 2.5)
            );
            graphics.push({
                id: explainer.id,
                text: explainer.title,
                path: output,
                start,
                end: Math.min(scene.end - 0.15, start + explainer.placementDurationSeconds),
                trackIndex: 3,
                purpose: `semantic-explainer:${explainer.layout}`,
                points: explainer.points,
            });
        }

        const audioScenes = plan.scenes.length > 1 ? plan.scenes.slice(1) : plan.scenes;
        const audio = job.showcase.sfxSources.map((entry, index) => {
            const source = typeof entry === "string" ? entry : entry.path;
            if (!fs.existsSync(source)) throw new Error(`Showcase SFX does not exist: ${source}`);
            const scene = audioScenes[(index * 3) % audioScenes.length];
            const requestedStart = typeof entry === "string" ? null : entry.timelineSeconds;
            const start = Number.isFinite(requestedStart) ? requestedStart : scene.start;
            const duration = typeof entry === "string" ? 1.5 : entry.durationSeconds;
            return {
                id: typeof entry === "string" ? `sfx-${index + 1}` : entry.id,
                path: source,
                start,
                end: start + duration,
                trackIndex: typeof entry === "string" ? 1 + index : entry.trackIndex,
                gainDb: typeof entry === "string" ? -12 : entry.gainDb,
                purpose: typeof entry === "string" ? "chapter-transition-sfx" : entry.purpose,
                provider: typeof entry === "string" ? null : entry.provider,
                license: typeof entry === "string" ? "owner-supplied" : entry.license,
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
                graphicEvents: 2 + (job.showcase.explainerAssets || [])
                    .filter((item) => item.sceneId === scene.sceneId).length,
            })),
            graphics,
            videos,
            audio,
        };
        validateShowcaseTimeline(manifest);
        writeJsonAtomic(job.outputPaths.showcaseManifest, manifest);
        return manifest;
    }
}

module.exports = {
    ShowcaseRenderer,
    frameSize,
    isCaptionEcho,
    semanticCallout,
    validateShowcaseTimeline,
};
