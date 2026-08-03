const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureDir, nowIso, readJson, slugify, writeJsonAtomic } = require("./util");

const styleRegistry = require("../config/short-form-style-registry.json");
const TICKS_PER_SECOND = 254016000000;
const DEFAULT_VERTICAL_PRESET = "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/SequencePresets/Social/Social Media Portrait 9x16 30 fps.sqpreset";

function styleById(id) {
    const style = styleRegistry.styles.find((item) => item.id === id);
    if (!style) throw new Error(`Unknown short-form style: ${id}`);
    return JSON.parse(JSON.stringify(style));
}

function loudnessCorrection(job, details) {
    if (details?.provider !== "ffmpeg-ebur128-read-only" || !job.shortForm?.enabled) return null;
    const currentGainDb = Number(job.shortForm.editing?.dialogueGainDb ?? 0);
    const targetLufs = Number(details.targetIntegratedLufs);
    const integratedLufs = Number(details.integratedLufs);
    const truePeakDb = Number(details.truePeakDb);
    const maximumTruePeakDb = Number(details.maximumTruePeakDb);
    if (![currentGainDb, targetLufs, integratedLufs, truePeakDb, maximumTruePeakDb].every(Number.isFinite)) {
        return null;
    }
    const targetDeltaDb = targetLufs - integratedLufs;
    const peakSafeDeltaDb = maximumTruePeakDb - 0.2 - truePeakDb;
    const appliedDeltaDb = Math.min(targetDeltaDb, peakSafeDeltaDb);
    const dialogueGainDb = Math.max(-6, Math.min(6, currentGainDb + appliedDeltaDb));
    if (Math.abs(dialogueGainDb - currentGainDb) < 0.05) return null;
    return {
        provider: "premiere-dialogue-gain-correction",
        measured: { integratedLufs, truePeakDb },
        target: { integratedLufs: targetLufs, maximumTruePeakDb, safetyMarginDb: 0.2 },
        previousDialogueGainDb: currentGainDb,
        appliedDeltaDb: Number((dialogueGainDb - currentGainDb).toFixed(2)),
        dialogueGainDb: Number(dialogueGainDb.toFixed(2)),
    };
}

function probeVideo(filePath, ffprobeBin = "ffprobe") {
    const output = execFileSync(ffprobeBin, [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json", filePath,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(output);
    const stream = parsed.streams?.[0];
    if (!stream?.width || !stream?.height) throw new Error(`Short-form source has no video stream: ${filePath}`);
    return { width: stream.width, height: stream.height, durationSeconds: Number(parsed.format?.duration || 0) };
}

function coverTransform(sourceFrame, targetFrame, focus = {}) {
    const zoomMultiplier = Math.max(1, Math.min(1.5, Number(focus.zoomMultiplier ?? 1)));
    const scale = Math.max(
        targetFrame.width / sourceFrame.width,
        targetFrame.height / sourceFrame.height
    ) * zoomMultiplier;
    const scaledWidth = sourceFrame.width * scale;
    const scaledHeight = sourceFrame.height * scale;
    const focusX = Math.max(0, Math.min(1, Number(focus.x ?? 0.5)));
    const focusY = Math.max(0, Math.min(1, Number(focus.y ?? 0.5)));
    const anchorX = Math.max(0, Math.min(1, Number(focus.anchorX ?? 0.5)));
    const anchorY = Math.max(0, Math.min(1, Number(focus.anchorY ?? 0.5)));
    const maximumShiftX = Math.max(0, (scaledWidth - targetFrame.width) / 2);
    const maximumShiftY = Math.max(0, (scaledHeight - targetFrame.height) / 2);
    const positionX = Math.max(
        targetFrame.width / 2 - maximumShiftX,
        Math.min(targetFrame.width / 2 + maximumShiftX, anchorX * targetFrame.width + (0.5 - focusX) * scaledWidth)
    );
    const positionY = Math.max(
        targetFrame.height / 2 - maximumShiftY,
        Math.min(targetFrame.height / 2 + maximumShiftY, anchorY * targetFrame.height + (0.5 - focusY) * scaledHeight)
    );
    return {
        mode: "safe-fill",
        scalePercent: Number((scale * 100).toFixed(4)),
        position: { x: Number(positionX.toFixed(3)), y: Number(positionY.toFixed(3)) },
        sourceFrame,
        targetFrame,
        focus: { x: focusX, y: focusY, anchorX, anchorY, zoomMultiplier },
        exposedCanvas: false,
    };
}

function createHeadlineGraphic(filePath, text, layout = {}, options = {}) {
    ensureDir(path.dirname(filePath));
    const magickBin = options.magickBin || "magick";
    const font = options.font || "/System/Library/Fonts/Supplemental/Impact.ttf";
    const y = Math.round(1920 * Number(layout.headlineYRatio ?? 0.12));
    const safeWidth = 900;
    const fill = options.fill || "white";
    const layer = `${filePath}.text.png`;
    const words = String(text).trim().toUpperCase().split(/\s+/);
    const splitAt = words.length > 3 ? Math.ceil(words.length / 2) : words.length;
    const displayText = words.length > 3
        ? `${words.slice(0, splitAt).join(" ")}\n${words.slice(splitAt).join(" ")}`
        : words.join(" ");
    execFileSync(magickBin, [
        "-background", "none", "-fill", fill, "-stroke", "#0A0D10", "-strokewidth", "3",
        "-font", font, "-pointsize", "82", "-gravity", "center", "-interline-spacing", "4", "-size", `${safeWidth}x300`,
        `caption:${displayText}`, "-trim", "+repage", layer,
    ]);
    execFileSync(magickBin, [
        "-size", "1080x1920", "xc:none", layer, "-gravity", "north", "-geometry", `+0+${y}`,
        "-composite", filePath,
    ]);
    fs.unlinkSync(layer);
    return filePath;
}

function createStableHighlightCaptions(directory, cues, captions = {}, options = {}) {
    ensureDir(directory);
    const magickBin = options.magickBin || "magick";
    const font = options.font || "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf";
    const pointSize = Number(options.pointSize || 70);
    const wordsPerChunk = Math.max(3, Math.min(7, Number(captions.wordsPerChunk || 5)));
    const anchorY = Math.max(0.55, Math.min(0.76, Number(captions.anchorYRatio || 0.67)));
    const frameRate = Math.max(24, Math.min(60, Number(captions.frameRate || 30)));
    const minimumVisibleFrames = Math.max(12, Number(captions.minimumVisibleFrames || 18));
    const bridgeGapFrames = Math.max(1, Number(captions.bridgeGapFrames || Math.round(frameRate * 0.2)));
    const assets = [];
    const widthCache = new Map();
    const wordWidth = (word) => {
        if (widthCache.has(word)) return widthCache.get(word);
        const width = Number(execFileSync(magickBin, [
            "-background", "none", "-font", font, "-pointsize", String(pointSize),
            `label:${word}`, "-format", "%w", "info:",
        ], { encoding: "utf8" }).trim());
        widthCache.set(word, width);
        return width;
    };
    const spaceWidth = Math.round(pointSize * 0.34);
    const stopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "was", "we", "with", "you"]);
    for (const [cueIndex, cue] of cues.entries()) {
        const words = cue.text.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        const cueStartFrame = Math.max(0, Math.round(cue.start * frameRate));
        const cueEndFrame = Math.max(cueStartFrame + 1, Math.round(cue.end * frameRate));
        const chunkCount = Math.max(1, Math.ceil(words.length / wordsPerChunk));
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            const chunkStart = chunkIndex * wordsPerChunk;
            const chunkEnd = Math.min(words.length, chunkStart + wordsPerChunk);
            const chunk = words.slice(chunkStart, chunkEnd);
            const startFrame = Math.round(cueStartFrame + ((cueEndFrame - cueStartFrame) * chunkStart) / words.length);
            const endFrame = Math.round(cueStartFrame + ((cueEndFrame - cueStartFrame) * chunkEnd) / words.length);
            if (endFrame - startFrame < Math.min(minimumVisibleFrames, cueEndFrame - cueStartFrame) && chunkCount > 1) {
                continue;
            }
            let active = 0;
            for (let index = 1; index < chunk.length; index += 1) {
                const candidate = chunk[index].replace(/[^A-Za-z0-9']/g, "").toLowerCase();
                const current = chunk[active].replace(/[^A-Za-z0-9']/g, "").toLowerCase();
                if ((!stopWords.has(candidate) && stopWords.has(current)) || (stopWords.has(candidate) === stopWords.has(current) && candidate.length > current.length)) {
                    active = index;
                }
            }
            const output = path.join(
                directory,
                `caption-${String(cueIndex + 1).padStart(3, "0")}-${String(chunkIndex + 1).padStart(2, "0")}.png`
            );
            const y = Math.round(anchorY * 1920);
            const widths = chunk.map(wordWidth);
            const totalWidth = widths.reduce((sum, width) => sum + width, 0) + spaceWidth * (chunk.length - 1);
            let x = Math.max(54, Math.round((1080 - totalWidth) / 2));
            const drawArgs = ["-size", "1080x1920", "xc:none", "-font", font, "-pointsize", String(pointSize), "-gravity", "northwest"];
            for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex += 1) {
                drawArgs.push(
                    "-fill", chunkIndex === active ? "#20D5C2" : "#FFFFFF",
                    "-stroke", "#090B0D", "-strokewidth", "3",
                    "-annotate", `+${x}+${y}`, chunk[chunkIndex]
                );
                x += widths[chunkIndex] + spaceWidth;
            }
            drawArgs.push(output);
            execFileSync(magickBin, drawArgs);
            if (options.headlinePath) {
                const composite = `${output}.composite.png`;
                execFileSync(magickBin, [output, options.headlinePath, "-composite", composite]);
                fs.renameSync(composite, output);
            }
            assets.push({
                path: output,
                text: chunk.join(" "),
                activeWord: chunk[active],
                cueIndex,
                chunkIndex,
                frameRate,
                startFrame,
                endFrame,
                visibleFrames: endFrame - startFrame,
                start: startFrame / frameRate,
                end: endFrame / frameRate,
                startTicks: Math.round((startFrame / frameRate) * TICKS_PER_SECOND),
                renderMode: "stable-keyword-highlight",
            });
        }
    }
    for (let index = 1; index < assets.length; index += 1) {
        const previous = assets[index - 1];
        const current = assets[index];
        const gapFrames = current.startFrame - previous.endFrame;
        if (gapFrames > 0 && gapFrames <= bridgeGapFrames) {
            previous.endFrame = current.startFrame;
            previous.visibleFrames = previous.endFrame - previous.startFrame;
            previous.end = previous.endFrame / previous.frameRate;
        }
    }
    for (let index = 0; index < assets.length; index += 1) {
        const current = assets[index];
        const minimumFrames = 12;
        if (current.endFrame - current.startFrame >= minimumFrames) continue;
        const missing = minimumFrames - (current.endFrame - current.startFrame);
        const previous = assets[index - 1];
        const next = assets[index + 1];
        if (previous && previous.endFrame === current.startFrame && previous.visibleFrames - missing >= minimumFrames) {
            previous.endFrame -= missing;
            previous.visibleFrames = previous.endFrame - previous.startFrame;
            previous.end = previous.endFrame / previous.frameRate;
            current.startFrame -= missing;
        } else if (next && next.startFrame === current.endFrame && next.visibleFrames - missing >= minimumFrames) {
            next.startFrame += missing;
            next.visibleFrames = next.endFrame - next.startFrame;
            next.start = next.startFrame / next.frameRate;
            next.startTicks = Math.round(next.start * TICKS_PER_SECOND);
            current.endFrame += missing;
        }
        current.visibleFrames = current.endFrame - current.startFrame;
        current.start = current.startFrame / current.frameRate;
        current.end = current.endFrame / current.frameRate;
        current.startTicks = Math.round(current.start * TICKS_PER_SECOND);
    }
    return assets;
}

function captionContinuityReport(graphics = []) {
    const rapidTransitions = graphics.filter((graphic) => graphic.visibleFrames < 12);
    const offFrameBoundaries = graphics.filter((graphic) =>
        Math.abs(graphic.start * graphic.frameRate - graphic.startFrame) > 1e-6 ||
        Math.abs(graphic.end * graphic.frameRate - graphic.endFrame) > 1e-6
    );
    const accidentalGaps = [];
    const microGaps = [];
    for (let index = 1; index < graphics.length; index += 1) {
        const previous = graphics[index - 1];
        const current = graphics[index];
        const gapFrames = current.startFrame - previous.endFrame;
        if (gapFrames > 0 && gapFrames <= Math.round(current.frameRate * 0.2)) {
            microGaps.push({ previous: previous.path, current: current.path, frames: gapFrames });
        }
        if (previous.cueIndex === current.cueIndex && current.startFrame !== previous.endFrame) {
            accidentalGaps.push({ previous: previous.path, current: current.path, frames: gapFrames });
        }
    }
    return {
        passed: rapidTransitions.length === 0 && offFrameBoundaries.length === 0 && accidentalGaps.length === 0 && microGaps.length === 0,
        rapidTransitions,
        offFrameBoundaries,
        accidentalGaps,
        microGaps,
    };
}

function createStableCaptionOverlay(filePath, headlinePath, graphics, durationSeconds, options = {}) {
    ensureDir(path.dirname(filePath));
    const ffmpegBin = options.ffmpegBin || "ffmpeg";
    const frameRate = Math.max(24, Math.min(60, Number(options.frameRate || 30)));
    const totalFrames = Math.max(1, Math.round(durationSeconds * frameRate));
    const segments = [];
    let cursorFrame = 0;
    for (const graphic of graphics) {
        if (graphic.startFrame > cursorFrame) {
            segments.push({ path: headlinePath, frames: graphic.startFrame - cursorFrame });
        }
        segments.push({ path: graphic.path, frames: Math.max(1, graphic.endFrame - graphic.startFrame) });
        cursorFrame = Math.max(cursorFrame, graphic.endFrame);
    }
    if (cursorFrame < totalFrames) {
        segments.push({ path: headlinePath, frames: totalFrames - cursorFrame });
    }
    if (!segments.length) segments.push({ path: headlinePath, frames: totalFrames });
    const concatPath = `${filePath}.concat.txt`;
    const quotePath = (value) => String(value).replaceAll("'", "'\\''");
    const concatLines = [];
    for (const segment of segments) {
        concatLines.push(`file '${quotePath(segment.path)}'`);
        concatLines.push(`duration ${(segment.frames / frameRate).toFixed(9)}`);
    }
    concatLines.push(`file '${quotePath(segments.at(-1).path)}'`);
    fs.writeFileSync(concatPath, `${concatLines.join("\n")}\n`, "utf8");
    execFileSync(ffmpegBin, [
        "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", `fps=${frameRate},format=yuva444p10le`,
        "-t", String(durationSeconds), "-an", "-c:v", "prores_ks", "-profile:v", "4",
        "-pix_fmt", "yuva444p10le", filePath,
    ]);
    fs.unlinkSync(concatPath);
    return {
        path: filePath,
        frameRate,
        totalFrames,
        segmentCount: segments.length,
        timelineClipCount: 1,
        noCaptionClipBoundaries: true,
    };
}

function condensedHeadline(value, maximumWords = 7) {
    return String(value || "")
        .replace(/[^A-Za-z0-9' -]+/g, " ")
        .trim()
        .split(/\s+/)
        .slice(0, maximumWords)
        .join(" ");
}

function srtTime(seconds) {
    const milliseconds = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const secs = Math.floor((milliseconds % 60000) / 1000);
    const millis = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function captionCues(source) {
    if (!source || !fs.existsSync(source)) return [];
    return fs.readFileSync(source, "utf8").replace(/\r/g, "").trim().split(/\n\s*\n/)
        .map((block) => {
            const lines = block.split("\n");
            const timingIndex = lines.findIndex((line) => line.includes("-->"));
            if (timingIndex < 0) return null;
            const toSeconds = (value) => {
                const match = value.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
                return match
                    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
                    : null;
            };
            const [startText, endText] = lines[timingIndex].split("-->");
            const start = toSeconds(startText);
            const end = toSeconds(endText);
            const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
            return Number.isFinite(start) && Number.isFinite(end) && text ? { start, end, text } : null;
        })
        .filter(Boolean);
}

function trimCaptions(source, output, range) {
    const cues = captionCues(source)
        .filter((cue) => cue.end > range.start && cue.start < range.end)
        .map((cue) => ({
            start: Math.max(0, cue.start - range.start),
            end: Math.min(range.duration, cue.end - range.start),
            text: cue.text,
        }))
        .filter((cue) => cue.end > cue.start);
    ensureDir(path.dirname(output));
    fs.writeFileSync(output, cues.length
        ? `${cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join("\n\n")}\n`
        : "", "utf8");
    return cues;
}

function createCaptionRemask(filePath, magickBin = "magick") {
    if (fs.existsSync(filePath)) return filePath;
    ensureDir(path.dirname(filePath));
    execFileSync(magickBin, [
        "-size", "1080x1920", "xc:none",
        "-fill", "#2A3942", "-draw", "rectangle 0,1536 1080,1920",
        "-fill", "#20D5C2", "-draw", "rectangle 0,1536 1080,1542",
        filePath,
    ]);
    return filePath;
}

function rangeScore(range, source, styles) {
    const scripts = new Map((source.scenes || []).map((scene) => [scene.id, scene.script || ""]));
    const text = `${range.title || ""} ${scripts.get(range.sceneId) || range.text || ""}`.toLowerCase();
    const keywords = [...new Set(styles.flatMap((style) => style.selectionKeywords))];
    const keywordScore = keywords.filter((keyword) => text.includes(keyword)).length * 10;
    const hookScore = /\b(result|proof|how|why|before|after|never|best|first)\b/.test(text) ? 15 : 0;
    return keywordScore + hookScore + Math.min(10, range.duration / 5);
}

function candidateRanges(source, minimumSeconds, maximumSeconds) {
    const scenes = source.editManifest?.scenes || [];
    if (!scenes.length) {
        const duration = Math.min(maximumSeconds, source.media.durationSeconds);
        return [{ id: "opening", sceneId: null, title: source.title, start: 0, end: duration, duration }];
    }
    return scenes.map((scene, index) => {
        let end = Number(scene.end);
        let cursor = index + 1;
        while (end - Number(scene.start) < minimumSeconds && cursor < scenes.length) {
            end = Number(scenes[cursor].end);
            cursor += 1;
        }
        end = Math.min(end, Number(scene.start) + maximumSeconds, source.media.durationSeconds);
        return {
            id: scene.sceneId || `range-${index + 1}`,
            sceneId: scene.sceneId || null,
            title: source.scenes?.find((item) => item.id === scene.sceneId)?.title || scene.sceneId || source.title,
            start: Number(scene.start),
            end,
            duration: Number((end - Number(scene.start)).toFixed(3)),
        };
    }).filter((range) => range.duration >= minimumSeconds && range.duration <= maximumSeconds);
}

function validateSelections(selections, sources) {
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const seen = new Set();
    for (const selection of selections) {
        const source = sourceMap.get(selection.sourceId);
        if (!source) throw new Error(`Short-form selection source does not exist: ${selection.sourceId}`);
        if (![selection.start, selection.end, selection.duration].every(Number.isFinite)) {
            throw new Error(`Short-form selection ${selection.id} has non-finite timing.`);
        }
        if (selection.start < 0 || selection.end <= selection.start || selection.end > source.media.durationSeconds + 0.05) {
            throw new Error(`Short-form selection ${selection.id} is outside its source duration.`);
        }
        if (selection.duration < 3 || selection.duration > 60) {
            throw new Error(`Short-form selection ${selection.id} must be between 3 and 60 seconds.`);
        }
        const key = `${selection.sourceId}:${selection.start}:${selection.end}:${selection.styleId}`;
        if (seen.has(key)) throw new Error(`Duplicate short-form selection: ${key}`);
        seen.add(key);
    }
    return selections;
}

function clippedCleanTimeline(source, selection) {
    const assets = [];
    const timeline = [];
    for (const [index, item] of (source.cleanTimeline || []).entries()) {
        const itemStart = Number(item.insertion_time_ticks || 0) / TICKS_PER_SECOND;
        const itemDuration = Number(item.duration_seconds || 0);
        const itemEnd = itemStart + itemDuration;
        const overlapStart = Math.max(selection.start, itemStart);
        const overlapEnd = Math.min(selection.end, itemEnd);
        const assetPath = path.normalize(item.asset_path || "");
        if (overlapEnd <= overlapStart || !path.isAbsolute(assetPath) || !fs.existsSync(assetPath)) continue;
        assets.push({
            id: `clean-source-${index + 1}`,
            path: assetPath,
            role: "clean-source-scene",
            order: assets.length,
        });
        timeline.push({
            asset_path: assetPath,
            order: timeline.length,
            video_track_index: 0,
            audio_track_index: 0,
            insertion_time_ticks: Math.round((overlapStart - selection.start) * TICKS_PER_SECOND),
            source_start_seconds: Number(item.source_start_seconds || 0) + overlapStart - itemStart,
            duration_seconds: Number((overlapEnd - overlapStart).toFixed(3)),
            overwrite: false,
        });
    }
    return { assets, timeline };
}

function inheritedSemanticVisuals(source, selection) {
    const showcase = source.showcaseManifest || {};
    return [...(showcase.videos || []), ...(showcase.graphics || []).filter((item) =>
        String(item.purpose || "").startsWith("semantic-explainer")
    )]
        .filter((item) => Number(item.end) > selection.start && Number(item.start) < selection.end)
        .map((item) => ({
            id: item.id,
            path: item.path,
            start: Number((Math.max(Number(item.start), selection.start) - selection.start).toFixed(3)),
            end: Number((Math.min(Number(item.end), selection.end) - selection.start).toFixed(3)),
            sourceStart: Number(item.sourceStart || 0) + Math.max(0, selection.start - Number(item.start)),
            provider: item.provider || (String(item.purpose || "").startsWith("semantic-explainer") ? "generated-2d" : null),
            query: item.purpose || null,
        }))
        .filter((item) => item.end > item.start && path.isAbsolute(path.normalize(item.path || "")) && fs.existsSync(item.path));
}

class ShortFormBatchStore {
    constructor(config, jobStore, boardStore = null, compositionStore = null) {
        this.config = config;
        this.jobStore = jobStore;
        this.boardStore = boardStore;
        this.compositionStore = compositionStore;
        this.directory = config.SHORT_FORM_DIR;
        ensureDir(this.directory);
    }

    batchPath(id) {
        return path.join(this.directory, id, "batch.json");
    }

    get(id) {
        if (!fs.existsSync(this.batchPath(id))) throw new Error(`Short-form batch ${id} was not found.`);
        return readJson(this.batchPath(id));
    }

    save(batch) {
        batch.updatedAt = nowIso();
        writeJsonAtomic(this.batchPath(batch.id), batch);
        return batch;
    }

    list() {
        return fs.readdirSync(this.directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(this.batchPath(entry.name)))
            .map((entry) => readJson(this.batchPath(entry.name)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    sourceFromJob(jobId) {
        const job = this.jobStore.get(jobId);
        const renderPath = job.result?.render?.outputFile || job.outputPaths?.render;
        const projectPath = job.result?.projectPath || job.outputPaths?.project;
        return this.normalizeSource({
            id: job.id,
            jobId: job.id,
            title: job.request?.topic || job.id,
            projectPath,
            renderPath,
            editManifestPath: job.outputPaths?.editManifest,
            showcaseManifestPath: job.outputPaths?.showcaseManifest,
            captionsPath: job.outputPaths?.combinedCaptions,
            cleanTimeline: job.production?.editPlan?.timeline || [],
            scenes: job.generation?.scenes || [],
            captionsEmbedded: Boolean(
                job.checkpoints?.["retention-edit"]?.result?.nativeCaptionTrack?.success ||
                job.result?.retention?.nativeCaptionTrack?.success
            ),
        });
    }

    normalizeSource(input) {
        const id = slugify(input.id || input.jobId || path.basename(input.projectPath || "source", ".prproj"));
        const projectPath = path.normalize(input.project_path || input.projectPath || "");
        const renderPath = path.normalize(input.render_path || input.renderPath || "");
        if (!path.isAbsolute(projectPath) || !fs.existsSync(projectPath)) {
            throw new Error(`Short-form source ${id} requires an existing absolute project path.`);
        }
        if (!path.isAbsolute(renderPath) || !fs.existsSync(renderPath)) {
            throw new Error(`Short-form source ${id} requires an existing absolute render path.`);
        }
        const editManifestPath = input.edit_manifest_path || input.editManifestPath || null;
        const showcaseManifestPath = input.showcase_manifest_path || input.showcaseManifestPath || null;
        const captionsPath = input.captions_path || input.captionsPath || null;
        const media = probeVideo(renderPath, this.config.FFPROBE_BIN || "ffprobe");
        return {
            id,
            jobId: input.jobId || null,
            title: input.title || id,
            projectPath,
            renderPath,
            editManifestPath: editManifestPath && fs.existsSync(editManifestPath) ? path.normalize(editManifestPath) : null,
            captionsPath: captionsPath && fs.existsSync(captionsPath) ? path.normalize(captionsPath) : null,
            captionsEmbedded: Boolean(input.captions_embedded || input.captionsEmbedded),
            editManifest: editManifestPath && fs.existsSync(editManifestPath) ? readJson(editManifestPath) : null,
            showcaseManifest: showcaseManifestPath && fs.existsSync(showcaseManifestPath) ? readJson(showcaseManifestPath) : null,
            cleanTimeline: (input.clean_timeline || input.cleanTimeline || []).map((item) => ({ ...item })),
            scenes: input.scenes || [],
            media,
        };
    }

    resolveSources(spec) {
        const ids = new Set(spec.source_job_ids || spec.sourceJobIds || []);
        for (const boardId of spec.source_board_ids || spec.sourceBoardIds || []) {
            if (!this.boardStore) throw new Error("Short-form board sources require a board store.");
            const board = this.boardStore.get(boardId);
            const revision = board.releaseDecision?.winner?.revision;
            const winner = board.revisions?.find((item) => item.revision === revision) || board.revisions?.at(-1);
            if (!winner?.jobId) throw new Error(`Production board ${boardId} has no completed winning job.`);
            ids.add(winner.jobId);
        }
        for (const compositionId of spec.source_composition_ids || spec.sourceCompositionIds || []) {
            if (!this.compositionStore) throw new Error("Short-form composition sources require a composition store.");
            const composition = this.compositionStore.get(compositionId);
            for (const child of composition.childJobs || []) {
                if (["COMPLETE", "APPROVAL_REQUIRED"].includes(child.status)) ids.add(child.jobId);
            }
        }
        const sources = [...ids].map((id) => this.sourceFromJob(id));
        sources.push(...(spec.sources || []).map((source) => this.normalizeSource(source)));
        const unique = [...new Map(sources.map((source) => [source.id, source])).values()];
        if (!unique.length) throw new Error("Short-form batch requires at least one source project.");
        return unique;
    }

    submit(spec) {
        const id = slugify(spec.short_form_id || spec.shortFormId || `short-form-${Date.now()}`);
        if (fs.existsSync(this.batchPath(id))) throw new Error(`Short-form batch ${id} already exists.`);
        const directory = path.dirname(this.batchPath(id));
        ensureDir(directory);
        const sources = this.resolveSources(spec);
        const styles = [...new Set(spec.styles || ["kinetic-proof", "clean-authority", "rapid-explainer"])]
            .map(styleById);
        const clipsPerSource = Math.max(1, Math.min(10, Number(spec.clips_per_source || spec.clipsPerSource || 3)));
        const minimumSeconds = Math.max(3, Math.min(60, Number(spec.minimum_seconds || spec.minimumSeconds || 15)));
        const maximumSeconds = Math.max(minimumSeconds, Math.min(60, Number(spec.maximum_seconds || spec.maximumSeconds || 60)));
        const variantMode = spec.variant_mode || spec.variantMode || "rotate";
        if (!new Set(["rotate", "all-styles"]).has(variantMode)) {
            throw new Error("short_form.variant_mode must be rotate or all-styles.");
        }
        const targetFrame = { width: 1080, height: 1920 };
        const campaignId = spec.campaign_id || "short-form";
        const rawSelections = [];
        for (const source of sources) {
            const candidates = candidateRanges(source, minimumSeconds, maximumSeconds)
                .map((range) => ({ ...range, score: rangeScore(range, source, styles) }))
                .sort((a, b) => b.score - a.score || a.start - b.start)
                .slice(0, clipsPerSource);
            candidates.forEach((range, index) => {
                const selectedStyles = variantMode === "all-styles" ? styles : [styles[index % styles.length]];
                selectedStyles.forEach((style) => rawSelections.push({
                    ...range,
                    id: `${source.id}-${range.id}-${style.id}`,
                    sourceId: source.id,
                    styleId: style.id,
                }));
            });
        }
        const selections = validateSelections(rawSelections, sources);
        const requireCaptions = spec.require_captions !== false;
        if (requireCaptions) {
            for (const selection of selections) {
                const source = sources.find((item) => item.id === selection.sourceId);
                const cues = captionCues(source.captionsPath)
                    .filter((cue) => cue.end > selection.start && cue.start < selection.end);
                if (!cues.length) {
                    throw new Error(`Short-form selection ${selection.id} requires captions in its source range.`);
                }
            }
        }
        const childJobs = [];
        for (const [index, selection] of selections.entries()) {
            const source = sources.find((item) => item.id === selection.sourceId);
            const style = styleById(selection.styleId);
            const childId = `${id}-${String(index + 1).padStart(2, "0")}-${selection.styleId}`;
            const workspace = path.join(this.config.CAMPAIGNS_DIR, campaignId, childId);
            const layout = { ...(style.layout || {}), ...(spec.layout || {}) };
            const sourceFocus = spec.focus || {};
            const transform = coverTransform(source.media, targetFrame, {
                x: sourceFocus.x ?? 0.5,
                y: sourceFocus.y ?? 0.44,
                anchorX: sourceFocus.anchorX ?? layout.faceAnchor?.x ?? 0.5,
                anchorY: sourceFocus.anchorY ?? layout.faceAnchor?.y ?? 0.35,
                zoomMultiplier: sourceFocus.zoomMultiplier ?? layout.faceZoomMultiplier ?? 1,
            });
            const cleanSource = clippedCleanTimeline(source, selection);
            const usesCleanSource = cleanSource.timeline.length > 0;
            const captionMode = usesCleanSource || !source.captionsEmbedded
                ? style.captions.mode
                : "source-embedded";
            const captionPath = path.join(workspace, "transcripts", "combined-captions.srt");
            const cues = source.captionsPath ? trimCaptions(source.captionsPath, captionPath, selection) : [];
            const headlineText = condensedHeadline(
                (spec.headlines || {})[style.id] || spec.headline || selection.title || source.title,
                Number(spec.headline_max_words || spec.headlineMaxWords || 7)
            );
            const sourceAssets = usesCleanSource
                ? cleanSource.assets
                : [{ id: "source-master", path: source.renderPath, role: "source-master", order: 0 }];
            const timeline = usesCleanSource
                ? cleanSource.timeline
                : [{
                    asset_path: source.renderPath,
                    order: 0,
                    video_track_index: 0,
                    audio_track_index: 0,
                    insertion_time_ticks: 0,
                    source_start_seconds: selection.start,
                    duration_seconds: selection.duration,
                    overwrite: true,
                }];

            const requestedSemanticVisuals = spec.semantic_visuals || spec.semanticVisuals || [];
            const semanticVisuals = (requestedSemanticVisuals.length
                ? requestedSemanticVisuals
                : inheritedSemanticVisuals(source, selection))
                .slice(0, Number(style.editing.maximumVisualInserts || 4));
            for (const [visualIndex, visual] of semanticVisuals.entries()) {
                const visualPath = path.normalize(visual.path || visual.localPath || "");
                const start = Number(visual.start);
                const end = Number(visual.end);
                if (!path.isAbsolute(visualPath) || !fs.existsSync(visualPath)) {
                    throw new Error(`Semantic visual ${visual.id || visualIndex + 1} requires an existing absolute path.`);
                }
                if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > selection.duration + 0.05) {
                    throw new Error(`Semantic visual ${visual.id || visualIndex + 1} is outside the selected short.`);
                }
                const visualId = visual.id || `semantic-visual-${visualIndex + 1}`;
                sourceAssets.push({
                    id: visualId,
                    path: visualPath,
                    role: "semantic-b-roll",
                    order: sourceAssets.length,
                    provider: visual.provider || null,
                    query: visual.query || null,
                });
                timeline.push({
                    asset_path: visualPath,
                    order: timeline.length,
                    video_track_index: 1,
                    audio_track_index: 1,
                    insertion_time_ticks: Math.round(start * TICKS_PER_SECOND),
                    source_start_seconds: Number(visual.sourceStart || 0),
                    duration_seconds: Number((end - start).toFixed(3)),
                    overwrite: true,
                });
            }

            let headlinePath = null;
            if (headlineText) {
                headlinePath = createHeadlineGraphic(
                    path.join(workspace, "generated-assets", "short-form", "headline.png"),
                    headlineText,
                    layout,
                    {
                        magickBin: this.config.IMAGEMAGICK_BIN || this.config.MAGICK_BIN || "magick",
                        font: this.config.HEADLINE_FONT || this.config.CAPTION_FONT,
                        fill: style.graphics?.headlineAccent || "white",
                    }
                );
            }

            const captionGraphics = captionMode === "stable-keyword-highlight"
                ? createStableHighlightCaptions(
                      path.join(workspace, "generated-assets", "short-form", "captions"),
                      cues,
                      style.captions,
                      {
                          magickBin: this.config.IMAGEMAGICK_BIN || this.config.MAGICK_BIN || "magick",
                          font: this.config.CAPTION_FONT,
                          headlinePath,
                      }
                  )
                : [];
            let captionOverlay = null;
            if (captionGraphics.length && headlinePath) {
                captionOverlay = createStableCaptionOverlay(
                    path.join(workspace, "generated-assets", "short-form", "stable-caption-overlay.mov"),
                    headlinePath,
                    captionGraphics,
                    selection.duration,
                    {
                        ffmpegBin: this.config.FFMPEG_BIN || "ffmpeg",
                        frameRate: style.captions.frameRate || 30,
                    }
                );
                sourceAssets.push({
                    id: "stable-caption-overlay",
                    path: captionOverlay.path,
                    role: "stable-caption-overlay",
                    order: sourceAssets.length,
                });
                timeline.push({
                    asset_path: captionOverlay.path,
                    order: timeline.length,
                    video_track_index: 2,
                    audio_track_index: 0,
                    insertion_time_ticks: 0,
                    source_start_seconds: 0,
                    duration_seconds: selection.duration,
                    overwrite: true,
                });
            }
            if (headlinePath && captionGraphics.length === 0) {
                sourceAssets.push({ id: "semantic-headline", path: headlinePath, role: "headline", order: sourceAssets.length });
                timeline.push({
                    asset_path: headlinePath,
                    order: timeline.length,
                    video_track_index: 2,
                    audio_track_index: 0,
                    insertion_time_ticks: 0,
                    source_start_seconds: 0,
                    duration_seconds: selection.duration,
                    overwrite: true,
                });
            }
            const child = this.jobStore.submit({
                job_id: childId,
                campaign_id: campaignId,
                priority: spec.priority || 80,
                request: {
                    topic: selection.title || source.title,
                    source_project: source.projectPath,
                    source_range: { start: selection.start, end: selection.end },
                },
                autonomy: { mode: "guarded", final_publish_approval: "required" },
                production: {
                    project_name: childId,
                    sequence_name: `SHORT_${String(index + 1).padStart(2, "0")}_${selection.styleId.replaceAll("-", "_").toUpperCase()}`,
                    existing_project_path: source.projectPath,
                    sequence_preset_path: this.config.PREMIERE_VERTICAL_SEQUENCE_PRESET || DEFAULT_VERTICAL_PRESET,
                    source_assets: sourceAssets,
                    edit_plan: { timeline },
                    render: { timeout_ms: 1800000 },
                },
                generation: { enabled: false },
                retention: { enabled: false },
                showcase: { enabled: false },
                composition: { enabled: false },
                short_form: {
                    enabled: true,
                    batch_id: id,
                    style_id: style.id,
                    source_job_id: source.jobId,
                    source_project_path: source.projectPath,
                    source_render_path: source.renderPath,
                    source_captions_path: source.captionsPath,
                    source_range: selection,
                    target: { format: "9:16", ...targetFrame },
                    transform,
                    motion: style.motion,
                    editing: style.editing,
                    layout,
                    headline: headlinePath ? { text: headlineText, path: headlinePath } : null,
                    semantic_visuals: semanticVisuals,
                    captions: {
                        ...style.captions,
                        required: requireCaptions,
                        mode: captionMode,
                        sourceEmbedded: source.captionsEmbedded,
                        cleanSource: usesCleanSource,
                        graphics: captionGraphics,
                        continuity: captionContinuityReport(captionGraphics),
                        overlay: captionOverlay,
                    },
                },
                archive: {
                    enabled: spec.archive?.enabled !== false,
                    mode: spec.archive?.mode || "copy",
                    destination_root: spec.archive?.destination_root || path.join(this.config.PASSPORT_ARCHIVE_ROOT, "ShortForm"),
                    include_source_assets: false,
                },
            });
            if (child.shortForm.captions.required && cues.length === 0) {
                throw new Error(`Short-form child ${child.id} requires captions in its selected source range.`);
            }
            child.parentShortFormBatchId = id;
            child.shortForm.captionPath = child.outputPaths.combinedCaptions;
            child.status = "SHORT_FORM_HELD";
            this.jobStore.save(child);
            childJobs.push({
                jobId: child.id,
                sourceId: source.id,
                styleId: style.id,
                sourceRange: selection,
                sequenceName: child.production.sequenceName,
                projectPath: child.outputPaths.project,
                renderPath: child.outputPaths.render,
                captionPath: child.outputPaths.combinedCaptions,
                captionCues: cues.length,
                captionGraphics: captionGraphics.length,
                semanticVisuals: semanticVisuals.length,
                headline: headlineText,
                transform,
                status: child.status,
            });
        }
        return this.save({
            schemaVersion: 1,
            id,
            status: "REQUESTED",
            createdAt: nowIso(),
            updatedAt: nowIso(),
            target: { format: "9:16", ...targetFrame },
            styles: styles.map((style) => style.id),
            variantMode,
            sourceCount: sources.length,
            selectionCount: selections.length,
            sources: sources.map((source) => ({
                id: source.id,
                jobId: source.jobId,
                title: source.title,
                projectPath: source.projectPath,
                renderPath: source.renderPath,
                captionsPath: source.captionsPath,
                captionsEmbedded: source.captionsEmbedded,
                cleanSourceAvailable: source.cleanTimeline.length > 0,
                media: source.media,
            })),
            childJobs,
            error: null,
            completedAt: null,
        });
    }
}

class ShortFormBatchRunner {
    constructor(store, jobStore, jobRunner) {
        this.store = store;
        this.jobStore = jobStore;
        this.jobRunner = jobRunner;
        this.activeBatchId = null;
    }

    resetPremiereStages(job) {
        for (const stage of ["project", "short-form-edit", "save", "structural-qc", "render", "short-form-framing-qc", "archive"]) {
            delete job.checkpoints[stage];
        }
        const renderPath = job.production?.render?.output_file;
        const workspace = `${path.resolve(job.workspace)}${path.sep}`;
        if (renderPath && path.resolve(renderPath).startsWith(workspace) && fs.existsSync(renderPath)) {
            fs.unlinkSync(renderPath);
        }
        job.status = "FAILED_RECOVERABLE";
        job.error = null;
        job.result = null;
    }

    syncStyleContract(job) {
        const baseline = styleById(job.shortForm.styleId).editing.dialogueGainDb;
        const normalizationBaseline = job.shortForm.audioNormalization?.previousDialogueGainDb;
        const current = job.shortForm.editing.dialogueGainDb;
        const stale = normalizationBaseline === undefined
            ? current !== baseline
            : normalizationBaseline !== baseline;
        if (!stale) return false;
        job.shortForm.presetSyncHistory = [
            ...(job.shortForm.presetSyncHistory || []),
            {
                syncedAt: nowIso(),
                styleId: job.shortForm.styleId,
                previousDialogueGainDb: current,
                previousNormalizationBaselineDb: normalizationBaseline ?? null,
                dialogueGainDb: baseline,
                invalidatedStages: ["project", "short-form-edit", "save", "structural-qc", "render", "short-form-framing-qc", "archive"],
            },
        ];
        job.shortForm.editing.dialogueGainDb = baseline;
        delete job.shortForm.audioNormalization;
        this.resetPremiereStages(job);
        this.jobStore.save(job);
        return true;
    }

    applyLoudnessRecovery(job) {
        const correction = loudnessCorrection(job, job.error?.details);
        if (!correction) return false;
        job.shortForm.editing.dialogueGainDb = correction.dialogueGainDb;
        job.shortForm.audioNormalization = { ...correction, correctedAt: nowIso() };
        this.resetPremiereStages(job);
        this.jobStore.save(job);
        return true;
    }

    async runChild(id) {
        let current = this.jobStore.get(id);
        this.applyLoudnessRecovery(current);
        current = this.jobStore.get(id);
        if (current.status.startsWith("FAILED") && current.checkpoints.project) {
            delete current.checkpoints.project;
            this.jobStore.save(current);
        }
        try {
            return await this.jobRunner.run(id);
        } catch (error) {
            current = this.jobStore.get(id);
            if (!this.applyLoudnessRecovery(current)) throw error;
            return this.jobRunner.run(id);
        }
    }

    async run(id) {
        if (this.activeBatchId && this.activeBatchId !== id) {
            throw new Error(`Short-form runner is busy with ${this.activeBatchId}.`);
        }
        let batch = this.store.get(id);
        this.activeBatchId = id;
        batch.status = "RUNNING";
        batch.error = null;
        this.store.save(batch);
        try {
            for (const child of batch.childJobs) {
                let current = this.jobStore.get(child.jobId);
                if (current.shortForm?.enabled && this.syncStyleContract(current)) {
                    current = this.jobStore.get(child.jobId);
                }
                const result = ["COMPLETE", "APPROVAL_REQUIRED"].includes(current.status)
                    ? current
                    : await this.runChild(child.jobId);
                child.status = result.status;
                child.projectPath = result.result?.projectPath || result.outputPaths.project;
                child.render = result.result?.render || null;
                this.store.save(batch);
                if (!["COMPLETE", "APPROVAL_REQUIRED"].includes(result.status)) {
                    throw new Error(`Short-form child ${child.jobId} stopped in ${result.status}.`);
                }
            }
            batch.status = batch.childJobs.every((child) => child.status === "COMPLETE")
                ? "COMPLETE"
                : "APPROVAL_REQUIRED";
            batch.completedAt = batch.status === "COMPLETE" ? nowIso() : null;
            return this.store.save(batch);
        } catch (error) {
            batch.status = "FAILED";
            batch.error = { message: error.message, at: nowIso() };
            this.store.save(batch);
            throw error;
        } finally {
            this.activeBatchId = null;
        }
    }
}

module.exports = {
    DEFAULT_VERTICAL_PRESET,
    ShortFormBatchRunner,
    ShortFormBatchStore,
    TICKS_PER_SECOND,
    candidateRanges,
    captionCues,
    captionContinuityReport,
    condensedHeadline,
    coverTransform,
    createCaptionRemask,
    createHeadlineGraphic,
    createStableCaptionOverlay,
    createStableHighlightCaptions,
    clippedCleanTimeline,
    inheritedSemanticVisuals,
    loudnessCorrection,
    probeVideo,
    styleById,
    styleRegistry,
    trimCaptions,
    validateSelections,
};
