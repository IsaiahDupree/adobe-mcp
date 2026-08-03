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
    const scale = Math.max(
        targetFrame.width / sourceFrame.width,
        targetFrame.height / sourceFrame.height
    );
    const scaledWidth = sourceFrame.width * scale;
    const scaledHeight = sourceFrame.height * scale;
    const focusX = Math.max(0, Math.min(1, Number(focus.x ?? 0.5)));
    const focusY = Math.max(0, Math.min(1, Number(focus.y ?? 0.5)));
    const maximumShiftX = Math.max(0, (scaledWidth - targetFrame.width) / 2);
    const maximumShiftY = Math.max(0, (scaledHeight - targetFrame.height) / 2);
    const positionX = Math.max(
        targetFrame.width / 2 - maximumShiftX,
        Math.min(targetFrame.width / 2 + maximumShiftX, targetFrame.width / 2 + (0.5 - focusX) * scaledWidth)
    );
    const positionY = Math.max(
        targetFrame.height / 2 - maximumShiftY,
        Math.min(targetFrame.height / 2 + maximumShiftY, targetFrame.height / 2 + (0.5 - focusY) * scaledHeight)
    );
    return {
        mode: "safe-fill",
        scalePercent: Number((scale * 100).toFixed(4)),
        position: { x: Number(positionX.toFixed(3)), y: Number(positionY.toFixed(3)) },
        sourceFrame,
        targetFrame,
        focus: { x: focusX, y: focusY },
        exposedCanvas: false,
    };
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
            captionsPath: job.outputPaths?.combinedCaptions,
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
            const transform = coverTransform(source.media, targetFrame, spec.focus || {});
            const childId = `${id}-${String(index + 1).padStart(2, "0")}-${selection.styleId}`;
            const captionRemaskPath = source.captionsEmbedded
                ? createCaptionRemask(
                      path.join(
                          this.config.CAMPAIGNS_DIR,
                          campaignId,
                          childId,
                          "generated-assets",
                          "short-form",
                          "caption-remask.png"
                      ),
                      this.config.MAGICK_BIN || "magick"
                  )
                : null;
            const sourceAssets = [{ id: "source-master", path: source.renderPath, role: "source-master", order: 0 }];
            const timeline = [{
                asset_path: source.renderPath,
                order: 0,
                video_track_index: 0,
                audio_track_index: 0,
                insertion_time_ticks: 0,
                source_start_seconds: selection.start,
                duration_seconds: selection.duration,
                overwrite: true,
            }];
            if (captionRemaskPath) {
                sourceAssets.push({ id: "caption-remask", path: captionRemaskPath, role: "caption-remask", order: 1 });
                timeline.push({
                    asset_path: captionRemaskPath,
                    order: 1,
                    video_track_index: 1,
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
                    captions: {
                        ...style.captions,
                        required: requireCaptions,
                        mode: source.captionsEmbedded ? "native-remasked" : style.captions.mode,
                        sourceEmbedded: source.captionsEmbedded,
                        remaskPath: captionRemaskPath,
                    },
                },
                archive: {
                    enabled: spec.archive?.enabled !== false,
                    mode: spec.archive?.mode || "copy",
                    destination_root: spec.archive?.destination_root || path.join(this.config.PASSPORT_ARCHIVE_ROOT, "ShortForm"),
                    include_source_assets: false,
                },
            });
            const cues = source.captionsPath
                ? trimCaptions(source.captionsPath, child.outputPaths.combinedCaptions, selection)
                : [];
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

    async run(id) {
        if (this.activeBatchId && this.activeBatchId !== id) {
            throw new Error(`Short-form runner is busy with ${this.activeBatchId}.`);
        }
        let batch = this.store.get(id);
        if (["COMPLETE", "APPROVAL_REQUIRED"].includes(batch.status)) return batch;
        this.activeBatchId = id;
        batch.status = "RUNNING";
        batch.error = null;
        this.store.save(batch);
        try {
            for (const child of batch.childJobs) {
                const current = this.jobStore.get(child.jobId);
                const result = ["COMPLETE", "APPROVAL_REQUIRED"].includes(current.status)
                    ? current
                    : await this.jobRunner.run(child.jobId);
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
    coverTransform,
    createCaptionRemask,
    probeVideo,
    styleById,
    styleRegistry,
    trimCaptions,
    validateSelections,
};
