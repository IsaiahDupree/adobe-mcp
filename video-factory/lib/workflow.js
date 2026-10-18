const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { validateAssets } = require("./job-schema");
const { ensureDir, nowIso, readJson, run, sleep, writeJsonAtomic } = require("./util");

class WaitingForAssetsError extends Error {
    constructor(missing) {
        super(`Waiting for ${missing.length} source asset(s).`);
        this.name = "WaitingForAssetsError";
        this.code = "WAITING_FOR_ASSETS";
        this.missing = missing;
    }
}

class WorkflowValidationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "WorkflowValidationError";
        this.code = "WORKFLOW_VALIDATION_FAILED";
        this.details = details;
    }
}

function requestedProjectIsOpen(state, outputPath) {
    return Boolean(
        state?.project?.hasProject &&
        state.project.path &&
        path.resolve(state.project.path) === path.resolve(outputPath)
    );
}

function retentionLoudnessCorrection(job, details) {
    if (
        details?.provider !== "ffmpeg-ebur128-read-only" ||
        !job.generation?.enabled ||
        !job.retention?.loudnessQa
    ) return null;
    const currentGainDb = Number(job.retention.dialogueGainDb || 0);
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
    const dialogueGainDb = Math.max(-12, Math.min(12, currentGainDb + appliedDeltaDb));
    if (Math.abs(dialogueGainDb - currentGainDb) < 0.05) return null;
    return {
        provider: "premiere-retention-dialogue-gain-recovery",
        measured: { integratedLufs, truePeakDb },
        target: { integratedLufs: targetLufs, maximumTruePeakDb, safetyMarginDb: 0.2 },
        previousDialogueGainDb: currentGainDb,
        appliedDeltaDb: Number((dialogueGainDb - currentGainDb).toFixed(2)),
        dialogueGainDb: Number(dialogueGainDb.toFixed(2)),
    };
}

async function averageVideoLuma(filePath) {
    const { stdout } = await run("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-i", filePath,
        "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:file=-",
        "-an",
        "-f", "null",
        "-",
    ], { timeout: 2 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const values = stdout.split(/\r?\n/)
        .filter((line) => line.includes("lavfi.signalstats.YAVG="))
        .map((line) => Number(line.split("=").at(-1)))
        .filter(Number.isFinite);
    if (!values.length) throw new WorkflowValidationError(`Pixel QA could not sample ${filePath}.`);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseEbur128Summary(text) {
    const integrated = [...String(text).matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)];
    const peaks = [...String(text).matchAll(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/g)];
    if (!integrated.length || !peaks.length) {
        throw new WorkflowValidationError("Audio loudness QA could not parse the FFmpeg EBU R128 summary.");
    }
    return {
        integratedLufs: Number(integrated.at(-1)[1]),
        truePeakDb: Number(peaks.at(-1)[1]),
    };
}

async function measureAudioLoudness(filePath) {
    const { stderr } = await run("ffmpeg", [
        "-hide_banner", "-nostats", "-i", filePath,
        "-filter_complex", "ebur128=peak=true", "-f", "null", "-",
    ], { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    return {
        provider: "ffmpeg-ebur128-read-only",
        ...parseEbur128Summary(stderr),
    };
}

class VideoJobRunner {
    constructor(
        store,
        appManager,
        adapter,
        archiveManager = null,
        heygenManager = null,
        retentionPlanner = null,
        cepAdapter = null,
        captionRenderer = null,
        showcaseRenderer = null,
        localNarrationManager = null,
        assetBroker = null,
        sceneDirector = null,
        subjectAnalyzer = null,
        responsiveLayoutEngine = null,
        animationGrammarRenderer = null,
        compositionQa = null,
        framingTracker = null
    ) {
        this.store = store;
        this.appManager = appManager;
        this.adapter = adapter;
        this.archiveManager = archiveManager;
        this.heygenManager = heygenManager;
        this.retentionPlanner = retentionPlanner;
        this.cepAdapter = cepAdapter;
        this.captionRenderer = captionRenderer;
        this.showcaseRenderer = showcaseRenderer;
        this.localNarrationManager = localNarrationManager;
        this.assetBroker = assetBroker;
        this.sceneDirector = sceneDirector;
        this.subjectAnalyzer = subjectAnalyzer;
        this.responsiveLayoutEngine = responsiveLayoutEngine;
        this.animationGrammarRenderer = animationGrammarRenderer;
        this.compositionQa = compositionQa;
        this.framingTracker = framingTracker;
        this.activeJobId = null;
    }

    checkpointComplete(job, stage) {
        return job.checkpoints[stage] && job.checkpoints[stage].status === "COMPLETE";
    }

    async canUseUxp() {
        return typeof this.adapter.isConnected !== "function" || (await this.adapter.isConnected());
    }

    async executeStage(id, stage, status, operation, options = {}) {
        let job = this.store.get(id);
        if (!options.always && this.checkpointComplete(job, stage)) {
            return job.checkpoints[stage].result;
        }

        const previous = job.checkpoints[stage] || { attempts: 0 };
        job.status = status;
        job.checkpoints[stage] = {
            ...previous,
            status: "RUNNING",
            attempts: previous.attempts + 1,
            startedAt: nowIso(),
            completedAt: null,
            error: null,
        };
        this.store.save(job);
        this.store.addEvent(id, "STAGE_STARTED", { stage, status });

        try {
            const result = await operation(this.store.get(id));
            job = this.store.get(id);
            job.checkpoints[stage] = {
                ...job.checkpoints[stage],
                status: "COMPLETE",
                completedAt: nowIso(),
                result: result || null,
            };
            this.store.save(job);
            this.store.addEvent(id, "STAGE_COMPLETED", { stage, result: result || null });
            return result;
        } catch (error) {
            job = this.store.get(id);
            job.checkpoints[stage] = {
                ...job.checkpoints[stage],
                status: "FAILED",
                completedAt: nowIso(),
                error: { code: error.code || "ERROR", message: error.message },
            };
            this.store.save(job);
            this.store.addEvent(id, "STAGE_FAILED", {
                stage,
                code: error.code || "ERROR",
                message: error.message,
            });
            throw error;
        }
    }

    async inspectProject(sequenceName = null) {
        if (await this.canUseUxp()) return this.adapter.inspectProject();
        if (!this.cepAdapter) throw new Error("No responsive Premiere automation bridge is available.");
        return this.cepAdapter.inspectProject({ sequenceName });
    }

    async inspectWithRetry(expected, timeoutMs = 30000, sequenceName = null) {
        const started = Date.now();
        let last;
        while (Date.now() - started < timeoutMs) {
            try {
                last = await this.inspectProject(sequenceName);
                if (!expected || expected(last)) return last;
            } catch (error) {
                last = error;
            }
            await sleep(1000);
        }
        if (last instanceof Error) throw last;
        throw new WorkflowValidationError("Premiere state did not reach the expected checkpoint.", {
            snapshot: last,
        });
    }

    reuseGeneration(job) {
        const sourceId = job.generation.reuseFromJobId;
        const source = this.store.get(sourceId);
        const checkpoint = source.checkpoints?.["heygen-generation"];
        if (!checkpoint || checkpoint.status !== "COMPLETE" || !checkpoint.result?.scenes?.length) {
            throw new WorkflowValidationError(`Generation source job ${sourceId} has no completed generation checkpoint.`);
        }
        if (source.generation.provider !== job.generation.provider) {
            throw new WorkflowValidationError("Generation reuse requires the same provider.");
        }
        const sourceScripts = new Map(source.generation.scenes.map((scene) => [scene.id, scene.script]));
        if (job.generation.scenes.some((scene) => sourceScripts.get(scene.id) !== scene.script)) {
            throw new WorkflowValidationError("Generation reuse requires identical scene IDs and scripts.");
        }
        const folder = job.generation.provider === "heygen" ? "heygen" : "local-narration";
        const scenes = checkpoint.result.scenes.map((scene) => {
            const destination = path.join(job.workspace, "generated-assets", folder, scene.sceneId);
            ensureDir(destination);
            const copied = { ...scene, reusedFromJobId: sourceId };
            for (const field of ["localVideo", "localAudio", "localSubtitle"]) {
                if (!scene[field]) continue;
                if (!fs.existsSync(scene[field])) {
                    throw new WorkflowValidationError(`Generation reuse source is missing ${scene[field]}.`);
                }
                const target = path.join(destination, path.basename(scene[field]));
                fs.copyFileSync(scene[field], target);
                copied[field] = target;
            }
            writeJsonAtomic(path.join(destination, "metadata.json"), copied);
            return copied;
        });
        const manifest = {
            ...checkpoint.result,
            jobId: job.id,
            generatedAt: nowIso(),
            reusedFromJobId: sourceId,
            scenes,
        };
        writeJsonAtomic(job.outputPaths.generationManifest, manifest);
        return manifest;
    }

    async prepareProject(job) {
        const outputPath = job.outputPaths.project;
        ensureDir(path.dirname(outputPath));

        if (!(await this.canUseUxp())) {
            if (job.production.existingProjectPath && !fs.existsSync(job.production.existingProjectPath)) {
                throw new WaitingForAssetsError([job.production.existingProjectPath]);
            }
            await this.cepAdapter.prepareProject({
                outputPath,
                existingProjectPath: job.production.existingProjectPath,
            });
            const snapshot = await this.inspectWithRetry(
                (state) => requestedProjectIsOpen(state, outputPath),
                45000,
                job.production.sequenceName
            );
            return {
                projectPath: outputPath,
                projectId: snapshot.project.id,
                projectName: snapshot.project.name,
            };
        }

        if (fs.existsSync(outputPath)) {
            await this.adapter.command("openProject", { filePath: outputPath });
        } else if (job.production.existingProjectPath) {
            if (!fs.existsSync(job.production.existingProjectPath)) {
                throw new WaitingForAssetsError([job.production.existingProjectPath]);
            }
            await this.adapter.command("openProject", {
                filePath: job.production.existingProjectPath,
            });
            await this.adapter.command("saveProjectAs", { filePath: outputPath });
        } else {
            await this.adapter.command("createProject", {
                path: path.dirname(outputPath),
                name: path.basename(outputPath, ".prproj"),
            });
        }

        const snapshot = await this.inspectWithRetry(
            (state) => requestedProjectIsOpen(state, outputPath),
            45000
        );
        if (!fs.existsSync(outputPath)) {
            await this.adapter.command("saveProject");
        }
        return {
            projectPath: outputPath,
            projectId: snapshot.project.id,
            projectName: snapshot.project.name,
        };
    }

    async importAssets(job) {
        const validation = validateAssets(job);
        if (!validation.valid) {
            throw new WaitingForAssetsError(validation.missing);
        }
        const basenames = job.production.sourceAssets.map((asset) => path.basename(asset.path));
        if (new Set(basenames).size !== basenames.length) {
            throw new WorkflowValidationError(
                "Source assets must have unique filenames because Premiere project-item lookup is name-based.",
                { basenames }
            );
        }
        if (basenames.length === 0) return { imported: [], alreadyPresent: [] };

        let snapshot = await this.inspectProject(job.production.sequenceName);
        const existing = new Set(snapshot.projectItems.map((item) => item.name));
        const missingPaths = job.production.sourceAssets
            .filter((asset) => !existing.has(path.basename(asset.path)))
            .map((asset) => asset.path);

        if (missingPaths.length > 0) {
            if (await this.canUseUxp()) {
                await this.adapter.command("importMedia", { filePaths: missingPaths });
            } else {
                await this.cepAdapter.importMedia(missingPaths);
            }
            snapshot = await this.inspectWithRetry((state) => {
                const names = new Set(state.projectItems.map((item) => item.name));
                return basenames.every((name) => names.has(name));
            }, 60000, job.production.sequenceName);
        }
        return {
            imported: missingPaths.map((item) => path.basename(item)),
            alreadyPresent: basenames.filter((name) => existing.has(name)),
            projectItemCount: snapshot.projectItems.length,
        };
    }

    timelineClips(job) {
        const timeline = job.production.editPlan && job.production.editPlan.timeline;
        if (!Array.isArray(timeline) || timeline.length === 0) {
            return job.production.sourceAssets.map((asset, index) => ({
                assetPath: asset.path,
                itemName: path.basename(asset.path),
                order: index,
            }));
        }
        return timeline
            .map((clip, index) => ({
                ...clip,
                assetPath: clip.asset_path || clip.path,
                itemName: path.basename(clip.asset_path || clip.path),
                order: Number.isFinite(clip.order) ? clip.order : index,
            }))
            .sort((a, b) => a.order - b.order);
    }

    async assembleRoughCut(job) {
        const sequenceName = job.production.sequenceName;
        let snapshot = await this.inspectProject(sequenceName);
        let sequence = snapshot.sequences.find((item) => item.name === sequenceName);
        const clips = this.timelineClips(job);
        const requiresSourceRanges = clips.some((clip) => Number(
            clip.source_start_seconds ?? clip.sourceStartSeconds ?? 0
        ) > 0);

        if (!sequence) {
            if (!(await this.canUseUxp()) || requiresSourceRanges) {
                await this.cepAdapter.assembleRoughCut({
                    sequenceName,
                    presetPath: job.production.sequencePresetPath,
                    clips: clips.map((clip) => ({
                        assetPath: clip.assetPath,
                        videoTrackIndex: Number(clip.video_track_index || 0),
                        audioTrackIndex: Number(clip.audio_track_index || 0),
                        insertionTimeTicks: Number.isFinite(clip.insertion_time_ticks)
                            ? clip.insertion_time_ticks
                            : null,
                        durationSeconds: Number(clip.duration_seconds || 0),
                        sourceStartSeconds: Number(
                            clip.source_start_seconds ?? clip.sourceStartSeconds ?? 0
                        ),
                        overwrite: clip.overwrite === true,
                    })),
                });
            } else if (job.production.sequencePresetPath) {
                if (!fs.existsSync(job.production.sequencePresetPath)) {
                    throw new WorkflowValidationError(
                        `Sequence preset does not exist: ${job.production.sequencePresetPath}`
                    );
                }
                await this.adapter.command("createSequenceWithPresetPath", {
                    sequenceName,
                    presetPath: job.production.sequencePresetPath,
                });
                snapshot = await this.inspectWithRetry((state) =>
                    state.sequences.some((item) => item.name === sequenceName)
                );
                sequence = snapshot.sequences.find((item) => item.name === sequenceName);

                for (const [index, clip] of clips.entries()) {
                    if (!Number.isFinite(clip.insertion_time_ticks) && index > 0) {
                        throw new WorkflowValidationError(
                            "Preset-based edit plans require insertion_time_ticks for every clip after the first."
                        );
                    }
                    await this.adapter.command("addMediaToSequence", {
                        sequenceId: sequence.id,
                        itemName: clip.itemName,
                        videoTrackIndex: Number(clip.video_track_index || 0),
                        audioTrackIndex: Number(clip.audio_track_index || 0),
                        insertionTimeTicks: Number(clip.insertion_time_ticks || 0),
                        overwrite: clip.overwrite !== false,
                    });
                }
            } else if (clips.length > 0) {
                await this.adapter.command("createSequenceFromMedia", {
                    sequenceName,
                    itemNames: clips.map((clip) => clip.itemName),
                });
            } else {
                await this.adapter.command("createSequence", { sequenceName });
            }
        }

        snapshot = await this.inspectWithRetry(
            (state) => state.sequences.some((item) => item.name === sequenceName),
            30000,
            sequenceName
        );
        sequence = snapshot.sequences.find((item) => item.name === sequenceName);
        return {
            sequenceId: sequence.id,
            sequenceName: sequence.name,
            frameSize: sequence.frameSize,
            clipsRequested: clips.length,
        };
    }

    async saveProject(job) {
        const packet = (await this.canUseUxp())
            ? await this.adapter.command("saveProject")
            : await this.cepAdapter.saveProject();
        if (!fs.existsSync(job.outputPaths.project)) {
            throw new WorkflowValidationError(
                `Premiere reported a save, but the project is missing: ${job.outputPaths.project}`
            );
        }
        const stats = fs.statSync(job.outputPaths.project);
        return { projectPath: job.outputPaths.project, bytes: stats.size, response: packet.response || packet };
    }

    async applyPremiereShortForm(job) {
        if (!job.shortForm?.enabled) return { skipped: true };
        if (!this.cepAdapter) throw new Error("Short-form editing requires the Premiere CEP bridge.");
        const captionPath = job.shortForm.captionPath || job.outputPaths.combinedCaptions;
        let nativeCaptionTrack = null;
        if (job.shortForm.captions.required && job.shortForm.captions.mode === "stable-keyword-highlight") {
            const graphics = job.shortForm.captions.graphics || [];
            if (!graphics.length) {
                throw new WorkflowValidationError("Stable captions require generated Premiere graphic assets.");
            }
            if (job.shortForm.captions.overlay?.timelineClipCount !== 1 || !job.shortForm.captions.overlay?.noCaptionClipBoundaries) {
                throw new WorkflowValidationError("Stable captions require one continuous Premiere overlay clip.");
            }
            nativeCaptionTrack = {
                success: true,
                created: true,
                reused: false,
                verification: "premiere-timeline-stable-keyword-graphics",
                graphics: graphics.length,
                timelineClips: 1,
            };
        } else if (job.shortForm.captions.required) {
            if (!fs.existsSync(captionPath) || fs.statSync(captionPath).size === 0) {
                throw new WorkflowValidationError("Short-form edit requires non-empty trimmed captions.");
            }
            nativeCaptionTrack = job.shortForm.captions.sourceEmbedded && !job.shortForm.captions.remaskPath
                ? {
                      success: true,
                      created: false,
                      reused: true,
                      verification: "source-render-inherits-native-caption-track",
                      source: job.shortForm.sourceRenderPath,
                  }
                : await this.cepAdapter.createNativeCaptionTrack({
                      sequenceName: job.production.sequenceName,
                      srtPath: captionPath,
                      requestedTrackName: "C1_SHORT_FORM_EN",
                  });
        }
        const plan = {
            schemaVersion: 1,
            jobId: job.id,
            sequenceName: job.production.sequenceName,
            ...job.shortForm,
            captionPath,
        };
        writeJsonAtomic(job.outputPaths.shortFormManifest, plan);
        const premiereEdit = await this.cepAdapter.applyShortFormPlan({
            sequenceName: job.production.sequenceName,
            shortForm: plan,
        });
        return { plan, premiereEdit, nativeCaptionTrack };
    }

    async runStructuralQc(job) {
        const snapshot = (await this.canUseUxp())
            ? await this.adapter.inspectProject()
            : await this.cepAdapter.inspectProject({
                  sequenceName: job.production.sequenceName,
              });
        const sequence = snapshot.sequences.find(
            (item) => item.name === job.production.sequenceName
        );
        const expectedItems = job.production.sourceAssets.map((asset) => path.basename(asset.path));
        const itemNames = new Set(snapshot.projectItems.map((item) => item.name));
        const missingItems = expectedItems.filter((name) => !itemNames.has(name));
        const videoClips = sequence
            ? sequence.videoTracks.reduce((sum, track) => sum + track.tracks.length, 0)
            : 0;
        const audioClips = sequence
            ? sequence.audioTracks.reduce((sum, track) => sum + track.tracks.length, 0)
            : 0;
        const issues = [];
        if (!sequence) issues.push({ severity: "critical", problem: "Expected sequence is missing." });
        if (missingItems.length > 0) {
            issues.push({
                severity: "critical",
                problem: "Imported project items are missing.",
                items: missingItems,
            });
        }
        if (expectedItems.length > 0 && videoClips + audioClips < expectedItems.length) {
            issues.push({
                severity: "critical",
                problem: "Timeline contains fewer clips than the edit plan.",
                expected: expectedItems.length,
                actualVideo: videoClips,
                actualAudio: audioClips,
            });
        }
        const requiresNativeCaptions =
            job.generation.enabled &&
            job.retention.enabled &&
            ["native", "both"].includes(job.retention.captionMode || "native");
        const nativeCaptionResult =
            job.checkpoints["retention-edit"] &&
            job.checkpoints["retention-edit"].result &&
            job.checkpoints["retention-edit"].result.nativeCaptionTrack;
        if (requiresNativeCaptions && (!nativeCaptionResult || !nativeCaptionResult.success)) {
            issues.push({
                severity: "critical",
                problem: "Native caption-track creation was not verified.",
            });
        }
        if (job.showcase && job.showcase.enabled) {
            const retentionResult = job.checkpoints["retention-edit"]?.result;
            const showcase = retentionResult && retentionResult.showcase;
            const premiereEdit = retentionResult && retentionResult.retentionEdit;
            const plannedDuration = job.production.editPlan?.retention?.durationSeconds || 0;
            if (
                plannedDuration < job.showcase.minimumDurationSeconds ||
                plannedDuration > job.showcase.maximumDurationSeconds
            ) {
                issues.push({
                    severity: "critical",
                    problem: "Benchmark runtime is outside the requested range.",
                    expectedSeconds: [
                        job.showcase.minimumDurationSeconds,
                        job.showcase.maximumDurationSeconds,
                    ],
                    actualSeconds: plannedDuration,
                });
            }
            if (!showcase || showcase.coverage.length !== job.generation.scenes.length) {
                issues.push({
                    severity: "critical",
                    problem: "Benchmark chapter coverage is incomplete.",
                });
            }
            if (
                premiereEdit &&
                (premiereEdit.broll.length !== job.showcase.brollSources.length ||
                    premiereEdit.audio.length !== job.showcase.sfxSources.length)
            ) {
                issues.push({
                    severity: "critical",
                    problem: "Premiere did not place every requested benchmark asset.",
                });
            }
        }
        if (job.shortForm?.enabled) {
            const shortResult = job.checkpoints["short-form-edit"]?.result;
            if (!sequence || sequence.frameSize.width >= sequence.frameSize.height) {
                issues.push({
                    severity: "critical",
                    problem: "Short-form sequence is not vertical.",
                    frameSize: sequence?.frameSize || null,
                });
            }
            const duration = (sequence?.videoTracks?.[0]?.tracks || [])
                .reduce((sum, clip) => sum + Number(clip.durationSeconds || 0), 0);
            if (Math.abs(duration - job.shortForm.sourceRange.duration) > 0.15) {
                issues.push({
                    severity: "critical",
                    problem: "Short-form sequence duration does not match its selected source range.",
                    expected: job.shortForm.sourceRange.duration,
                    actual: duration,
                });
            }
            if (job.shortForm.captions.required && !shortResult?.nativeCaptionTrack?.success) {
                issues.push({
                    severity: "critical",
                    problem: "Short-form native caption-track creation was not verified.",
                });
            }
            if (shortResult?.premiereEdit?.exposedCanvas) {
                issues.push({ severity: "critical", problem: "Short-form safe-fill predicts exposed canvas." });
            }
        }
        const passed = issues.every((issue) => issue.severity !== "critical");
        const report = {
            jobId: job.id,
            checkedAt: nowIso(),
            type: "premiere-structural-qc",
            passed,
            project: snapshot.project,
            sequence: sequence || null,
            metrics: {
                projectItems: snapshot.projectItems.length,
                expectedItems: expectedItems.length,
                videoClips,
                audioClips,
            },
            issues,
        };
        writeJsonAtomic(job.outputPaths.qc, report);
        if (!passed) {
            throw new WorkflowValidationError("Premiere structural QC failed.", report);
        }
        return report;
    }

    async waitForRender(outputFile, timeoutMs) {
        const started = Date.now();
        let previousSize = -1;
        let stableChecks = 0;
        while (Date.now() - started < timeoutMs) {
            if (fs.existsSync(outputFile)) {
                const size = fs.statSync(outputFile).size;
                if (size > 0 && size === previousSize) {
                    stableChecks += 1;
                    if (stableChecks >= 3) return size;
                } else {
                    stableChecks = 0;
                    previousSize = size;
                }
            }
            await sleep(2000);
        }
        const error = new Error(`Render did not complete within ${Math.round(timeoutMs / 60000)} minutes.`);
        error.code = "RENDER_TIMEOUT";
        throw error;
    }

    async renderAndValidate(job) {
        const render = job.production.render;
        if (!render) return { skipped: true };
        if (job.production.sourceAssets.length === 0) {
            throw new WorkflowValidationError("A render job requires at least one source asset.");
        }
        if (render.preset_file && !fs.existsSync(render.preset_file)) {
            throw new WorkflowValidationError(`Export preset does not exist: ${render.preset_file}`);
        }
        const snapshot = (await this.canUseUxp())
            ? await this.adapter.inspectProject()
            : await this.cepAdapter.inspectProject({ sequenceName: job.production.sequenceName });
        const sequence = snapshot.sequences.find(
            (item) => item.name === job.production.sequenceName
        );
        if (!sequence) throw new WorkflowValidationError("Cannot render a missing sequence.");
        ensureDir(path.dirname(render.output_file));
        if (await this.canUseUxp()) {
            await this.adapter.command(
                "exportSequence",
                {
                    sequenceId: sequence.id,
                    outputFile: render.output_file,
                    presetFile: render.preset_file || "",
                    exportType: render.export_type || "IMMEDIATELY",
                    exportFull: true,
                    startQueueImmediately: true,
                },
                Number(render.command_timeout_ms || 120000)
            );
        } else {
            await this.cepAdapter.exportSequence({
                sequenceName: sequence.name,
                outputFile: render.output_file,
                presetFile: render.preset_file,
            });
        }
        const bytes = await this.waitForRender(
            render.output_file,
            Number(render.timeout_ms || 30 * 60 * 1000)
        );
        const { stdout } = await run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,r_frame_rate",
            "-of",
            "json",
            render.output_file,
        ], { timeout: 30000 });
        const probe = JSON.parse(stdout);
        if (!probe.streams || !probe.streams.some((stream) => stream.codec_type === "video")) {
            throw new WorkflowValidationError("Rendered file has no readable video stream.", probe);
        }
        let pixelQa = null;
        if ((job.generation.enabled || job.shortForm?.enabled) && job.production.sourceAssets[0]?.path) {
            // FFmpeg is only decoding sparse frames for validation; Premiere remains the editor and exporter.
            const [renderAverageLuma, sourceAverageLuma] = await Promise.all([
                averageVideoLuma(render.output_file),
                averageVideoLuma(job.production.sourceAssets[0].path),
            ]);
            const minimumLuma = Math.max(8, sourceAverageLuma * 0.22);
            pixelQa = {
                provider: "ffmpeg-signalstats-read-only",
                sampleRateFps: 1,
                renderAverageLuma: Number(renderAverageLuma.toFixed(3)),
                sourceAverageLuma: Number(sourceAverageLuma.toFixed(3)),
                minimumLuma: Number(minimumLuma.toFixed(3)),
                passed: renderAverageLuma >= minimumLuma,
            };
        }
        let audioQa = null;
        if (job.retention?.loudnessQa?.enabled !== false) {
            const measured = await measureAudioLoudness(render.output_file);
            const target = job.retention.loudnessQa.targetIntegratedLufs;
            const tolerance = job.retention.loudnessQa.toleranceLufs;
            const minimumIntegratedLufs = target - tolerance;
            const maximumIntegratedLufs = target + tolerance;
            audioQa = {
                ...measured,
                targetIntegratedLufs: target,
                toleranceLufs: tolerance,
                minimumIntegratedLufs,
                maximumIntegratedLufs,
                maximumTruePeakDb: job.retention.loudnessQa.maximumTruePeakDb,
                passed:
                    measured.integratedLufs >= minimumIntegratedLufs &&
                    measured.integratedLufs <= maximumIntegratedLufs &&
                    measured.truePeakDb <= job.retention.loudnessQa.maximumTruePeakDb,
            };
        }
        const report = {
            outputFile: render.output_file,
            bytes,
            durationSeconds: Number(probe.format.duration),
            streams: probe.streams,
            pixelQa,
            audioQa,
        };
        if (job.shortForm?.enabled) {
            const video = probe.streams.find((stream) => stream.codec_type === "video");
            const durationDelta = Math.abs(Number(probe.format.duration) - job.shortForm.sourceRange.duration);
            report.shortFormQa = {
                expectedFrame: job.shortForm.target,
                expectedDurationSeconds: job.shortForm.sourceRange.duration,
                durationDeltaSeconds: Number(durationDelta.toFixed(4)),
                passed: Boolean(video && video.height > video.width && durationDelta <= 0.2),
            };
            if (!report.shortFormQa.passed) {
                throw new WorkflowValidationError("Rendered short-form video failed vertical frame or duration QA.", report.shortFormQa);
            }
        }
        writeJsonAtomic(path.join(job.workspace, "qc", "render-validation.json"), report);
        if (pixelQa && !pixelQa.passed) {
            throw new WorkflowValidationError("Rendered video is materially darker than its source and may be blank.", pixelQa);
        }
        if (audioQa && !audioQa.passed) {
            throw new WorkflowValidationError(
                "Rendered audio is outside the configured loudness or true-peak limits.",
                audioQa
            );
        }
        if (
            job.showcase &&
            job.showcase.enabled &&
            (report.durationSeconds < job.showcase.minimumDurationSeconds ||
                report.durationSeconds > job.showcase.maximumDurationSeconds)
        ) {
            throw new WorkflowValidationError("Rendered benchmark runtime is outside the requested range.", {
                durationSeconds: report.durationSeconds,
                minimumDurationSeconds: job.showcase.minimumDurationSeconds,
                maximumDurationSeconds: job.showcase.maximumDurationSeconds,
            });
        }
        return report;
    }

    applyGeneratedAssets(id, retentionResult) {
        const job = this.store.get(id);
        const premiereAssetsDir = path.join(job.workspace, "generated-assets", "heygen", "premiere-assets");
        ensureDir(premiereAssetsDir);
        const sceneAssets = [];
        const timeline = [];
        retentionResult.scenes.forEach((scene, index) => {
            const extension = path.extname(scene.source) || ".mp4";
            const assetPath = path.join(premiereAssetsDir, `${scene.sceneId}${extension}`);
            if (!fs.existsSync(assetPath)) {
                try {
                    fs.linkSync(scene.source, assetPath);
                } catch {
                    fs.copyFileSync(scene.source, assetPath);
                }
            }
            sceneAssets.push({
                id: `asset-heygen-${String(index + 1).padStart(3, "0")}`,
                path: assetPath,
                role: scene.audioSource ? "local-scene-visual" : "heygen-scene",
                order: sceneAssets.length,
            });
            timeline.push({
                asset_path: assetPath,
                order: timeline.length,
                video_track_index: 0,
                audio_track_index: 0,
                insertion_time_ticks: Math.round(scene.start * 254016000000),
                duration_seconds: scene.duration,
                overwrite: Boolean(scene.audioSource),
            });
            if (scene.audioSource) {
                const audioExtension = path.extname(scene.audioSource) || ".aiff";
                const audioPath = path.join(premiereAssetsDir, `${scene.sceneId}-narration${audioExtension}`);
                if (!fs.existsSync(audioPath)) {
                    try {
                        fs.linkSync(scene.audioSource, audioPath);
                    } catch {
                        fs.copyFileSync(scene.audioSource, audioPath);
                    }
                }
                sceneAssets.push({
                    id: `asset-narration-${String(index + 1).padStart(3, "0")}`,
                    path: audioPath,
                    role: "local-scene-narration",
                    order: sceneAssets.length,
                });
                timeline.push({
                    asset_path: audioPath,
                    order: timeline.length,
                    video_track_index: 0,
                    audio_track_index: 0,
                    insertion_time_ticks: Math.round(scene.start * 254016000000),
                    duration_seconds: scene.duration,
                    overwrite: true,
                });
            }
        });
        job.production.sourceAssets = sceneAssets;
        job.production.editPlan = {
            source: job.outputPaths.editManifest,
            timeline,
            retention: retentionResult,
        };
        this.store.save(job);
    }

    async applyPremiereRetention(job) {
        const plan = readJson(job.outputPaths.editManifest);
        const compositionLayout = job.composition?.enabled && fs.existsSync(job.outputPaths.responsiveLayout)
            ? readJson(job.outputPaths.responsiveLayout)
            : null;
        const compositionAssets = job.composition?.enabled && fs.existsSync(job.outputPaths.compositionAssets)
            ? readJson(job.outputPaths.compositionAssets)
            : { enabled: false, graphics: [] };
        const currentVariant = compositionLayout?.variants?.find(
            (variant) => variant.format === job.generation.aspectRatio
        );
        if (currentVariant) {
            plan.frame = currentVariant.dimensions;
            plan.scenes = plan.scenes.map((scene) => {
                const composed = currentVariant.scenes.find((item) => item.sceneId === scene.sceneId);
                if (!composed) return scene;
                return {
                    ...scene,
                    compositionCamera: composed.camera,
                };
            });
        }
        const snapshot = (await this.canUseUxp())
            ? await this.adapter.inspectProject()
            : await this.cepAdapter.inspectProject({ sequenceName: job.production.sequenceName });
        const sequence =
            snapshot.sequences.find((item) => item.name === job.production.sequenceName) ||
            (snapshot.project.activeSequenceName === job.production.sequenceName
                ? {
                      id: snapshot.project.activeSequenceId,
                      name: snapshot.project.activeSequenceName,
                  }
                : null);
        if (!sequence) throw new WorkflowValidationError("Cannot apply retention edits to a missing sequence.");
        if (!this.cepAdapter) throw new Error("Premiere CEP caption adapter is not configured.");
        const captionMode = job.retention.captionMode || "native";
        const useNativeCaptions = ["native", "both"].includes(captionMode);
        const useAnimatedCaptions = ["animated", "both"].includes(captionMode);
        if (useAnimatedCaptions && !this.captionRenderer) {
            throw new Error("Animated caption renderer is not configured.");
        }
        const captionAssets = useAnimatedCaptions
            ? await this.captionRenderer.render(job, plan)
            : [];
        const showcase = job.showcase && job.showcase.enabled
            ? await this.showcaseRenderer.render(job, plan)
            : { enabled: false, graphics: [], videos: [], audio: [] };
        showcase.graphics = [...(showcase.graphics || []), ...(compositionAssets.graphics || [])];
        const editPacket = await this.cepAdapter.applyRetentionPlan({
            sequenceName: sequence.name,
            plan,
            captionAssets,
            showcaseAssets: showcase,
            dialogueGainDb: job.retention.dialogueGainDb,
        });
        const nativeCaptionTrack = useNativeCaptions
            ? await this.cepAdapter.createNativeCaptionTrack({
                  sequenceName: sequence.name,
                  srtPath: job.outputPaths.combinedCaptions,
                  requestedTrackName: job.retention.nativeCaptionTrackName || "C1_ACCESSIBILITY_EN",
              })
            : null;
        return {
            editor: "premiere-pro",
            retentionEdit: editPacket,
            captionMode,
            nativeCaptionTrack,
            animatedCaptions: captionAssets,
            showcase,
            composition: {
                layout: currentVariant || null,
                assets: compositionAssets.graphics || [],
            },
        };
    }

    applyBrokerAssets(id, registry) {
        if (!registry || !Array.isArray(registry.assets) || registry.assets.length === 0) return;
        const job = this.store.get(id);
        job.showcase.brollSources = registry.assets.map((asset) => ({
            id: asset.id,
            path: asset.localPath,
            sceneId: asset.sceneId,
            sourceStart: asset.sourceStart,
            timelineOffsetSeconds: asset.timelineOffsetSeconds,
            placementDurationSeconds: asset.placementDurationSeconds,
            scale: asset.scale,
            purpose: asset.purpose,
            provider: asset.provider,
            providerAssetId: asset.providerAssetId,
            pageUrl: asset.pageUrl,
            creator: asset.creator,
            attribution: asset.attribution,
            license: asset.license,
            licenseUrl: asset.licenseUrl,
            sha256: asset.sha256,
        }));
        this.store.save(job);
    }

    classifyFailure(error, attempts) {
        if (error.code === "WAITING_FOR_ASSETS") return "AWAITING_ASSETS";
        const manual = new Set(["WORKFLOW_VALIDATION_FAILED"]);
        if (manual.has(error.code) || attempts >= 3) return "FAILED_MANUAL";
        return "FAILED_RECOVERABLE";
    }

    async run(id) {
        if (this.activeJobId && this.activeJobId !== id) {
            throw new Error(`Production node is busy with ${this.activeJobId}.`);
        }
        let job = this.store.get(id);
        if (["COMPLETE", "CANCELLED"].includes(job.status)) return job;
        this.activeJobId = id;
        job.attempts += 1;
        job.startedAt = job.startedAt || nowIso();
        job.lock = {
            owner: `${process.pid}@${require("os").hostname()}`,
            acquiredAt: nowIso(),
        };
        job.error = null;
        this.store.save(job);
        this.store.addEvent(id, "JOB_STARTED", { attempt: job.attempts });

        try {
            let generation = null;
            let retention = null;
            let visualScenePlan = null;
            let subjectTrack = null;
            let responsiveLayout = null;
            let compositionAssets = null;
            let compositionQa = null;
            let framingSourceAudit = null;
            let framingAudit = null;
            let shortFormFraming = null;
            if (this.store.get(id).generation.enabled) {
                if (this.store.get(id).composition?.enabled) {
                    visualScenePlan = await this.executeStage(
                        id,
                        "scene-direction",
                        "PLANNING_VISUAL_SCENES",
                        (current) => {
                            if (!this.sceneDirector) throw new Error("Scene director is not configured.");
                            return this.sceneDirector.plan(current);
                        }
                    );
                }
                generation = await this.executeStage(
                    id,
                    "heygen-generation",
                    "GENERATING_AVATAR",
                    (current) => {
                        if (current.generation.reuseFromJobId) return this.reuseGeneration(current);
                        if (current.generation.provider === "macos_say") {
                            if (!this.localNarrationManager) throw new Error("Local narration manager is not configured.");
                            return this.localNarrationManager.generate(current);
                        }
                        if (!this.heygenManager) throw new Error("HeyGen manager is not configured.");
                        return this.heygenManager.generate(current);
                    }
                );
                if (this.store.get(id).generation.provider === "heygen") {
                    framingSourceAudit = await this.executeStage(
                        id,
                        "framing-source-audit",
                        "AUDITING_SOURCE_FRAMING",
                        (current) => {
                            if (!this.framingTracker) throw new Error("Framing tracker is not configured.");
                            return this.framingTracker.auditSources(current, generation);
                        }
                    );
                }
                if (this.store.get(id).composition?.enabled) {
                    subjectTrack = await this.executeStage(
                        id,
                        "subject-analysis",
                        "ANALYZING_SUBJECT",
                        (current) => {
                            if (!this.subjectAnalyzer) throw new Error("Subject analyzer is not configured.");
                            return this.subjectAnalyzer.analyze(current, generation);
                        }
                    );
                }
                retention = await this.executeStage(
                    id,
                    "retention-plan",
                    "PLANNING_EDIT",
                    (current) => {
                        if (!this.retentionPlanner) throw new Error("Retention planner is not configured.");
                        return this.retentionPlanner.plan(current, generation);
                    }
                );
                if (this.store.get(id).composition?.enabled) {
                    responsiveLayout = await this.executeStage(
                        id,
                        "responsive-layout",
                        "PLANNING_RESPONSIVE_LAYOUT",
                        (current) => {
                            if (!this.responsiveLayoutEngine) throw new Error("Responsive layout engine is not configured.");
                            return this.responsiveLayoutEngine.build(current, visualScenePlan, subjectTrack, retention);
                        }
                    );
                    compositionAssets = await this.executeStage(
                        id,
                        "composition-rendering",
                        "RENDERING_COMPOSITION_ASSETS",
                        (current) => {
                            if (!this.animationGrammarRenderer) throw new Error("Animation grammar renderer is not configured.");
                            return this.animationGrammarRenderer.render(current, responsiveLayout);
                        }
                    );
                    compositionQa = await this.executeStage(
                        id,
                        "composition-qa",
                        "VALIDATING_COMPOSITION",
                        (current) => {
                            if (!this.compositionQa) throw new Error("Composition QA is not configured.");
                            return this.compositionQa.evaluate(
                                current,
                                visualScenePlan,
                                subjectTrack,
                                responsiveLayout,
                                compositionAssets
                            );
                        }
                    );
                }
                this.applyGeneratedAssets(id, retention);
            }
            if ((this.store.get(id).showcase?.assetRequests || []).length > 0) {
                const assetRegistry = await this.executeStage(
                    id,
                    "asset-sourcing",
                    "SOURCING_ASSETS",
                    (current) => {
                        if (!this.assetBroker) throw new Error("Production asset broker is not configured.");
                        return this.assetBroker.resolve(current);
                    }
                );
                this.applyBrokerAssets(id, assetRegistry);
            }
            await this.executeStage(
                id,
                "app-readiness",
                "PREPARING_APPS",
                (current) =>
                    this.appManager.ensureReady({
                        requireMediaEncoder: Boolean(current.production.render),
                    }),
                { always: true }
            );
            await this.executeStage(id, "project", "PROJECT_CREATING", (current) =>
                this.prepareProject(current)
            );
            await this.executeStage(id, "assets", "AWAITING_ASSETS", (current) =>
                this.importAssets(current)
            );
            await this.executeStage(id, "rough-cut", "ROUGH_CUT", (current) =>
                this.assembleRoughCut(current)
            );
            if (this.store.get(id).shortForm?.enabled) {
                await this.executeStage(id, "short-form-edit", "SHORT_FORM_EDITING", (current) =>
                    this.applyPremiereShortForm(current)
                );
            }
            if (this.store.get(id).generation.enabled) {
                await this.executeStage(id, "retention-edit", "RETENTION_EDITING", (current) =>
                    this.applyPremiereRetention(current)
                );
            }
            await this.executeStage(id, "save", "SAVING_PROJECT", (current) =>
                this.saveProject(current)
            );
            let qc = await this.executeStage(id, "structural-qc", "QUALITY_CONTROL", (current) =>
                this.runStructuralQc(current)
            );
            let render;
            try {
                render = await this.executeStage(id, "render", "EXPORTING", (current) =>
                    this.renderAndValidate(current)
                );
            } catch (error) {
                const current = this.store.get(id);
                const correction = error.code === "WORKFLOW_VALIDATION_FAILED"
                    ? retentionLoudnessCorrection(current, error.details)
                    : null;
                if (!correction) throw error;
                current.retention.dialogueGainDb = correction.dialogueGainDb;
                current.loudnessRecovery = correction;
                current.error = null;
                for (const stage of ["retention-edit", "save", "structural-qc", "render"]) {
                    delete current.checkpoints[stage];
                }
                this.store.save(current);
                this.store.addEvent(id, "LOUDNESS_RECOVERY_APPLIED", correction);
                await this.executeStage(id, "retention-edit", "RETENTION_EDITING", (retryJob) =>
                    this.applyPremiereRetention(retryJob)
                );
                await this.executeStage(id, "save", "SAVING_PROJECT", (retryJob) =>
                    this.saveProject(retryJob)
                );
                qc = await this.executeStage(id, "structural-qc", "QUALITY_CONTROL", (retryJob) =>
                    this.runStructuralQc(retryJob)
                );
                render = await this.executeStage(id, "render", "EXPORTING", (retryJob) =>
                    this.renderAndValidate(retryJob)
                );
            }
            if (this.store.get(id).shortForm?.enabled && render && !render.skipped) {
                shortFormFraming = await this.executeStage(
                    id,
                    "short-form-framing-qc",
                    "AUDITING_SHORT_FORM_FRAMING",
                    async (current) => {
                        if (!this.framingTracker) throw new Error("Framing tracker is not configured.");
                        const output = await this.framingTracker.analyzeMedia(render.outputFile);
                        const report = {
                            schemaVersion: 1,
                            jobId: current.id,
                            generatedAt: nowIso(),
                            provider: "short-form-persistent-bar-audit",
                            output,
                            maximumBarAreaRatio: 0.003,
                            passed: output.barAreaRatio <= 0.003,
                        };
                        writeJsonAtomic(path.join(current.workspace, "qc", "short-form-framing.json"), report);
                        if (!report.passed) {
                            throw new WorkflowValidationError("Short-form output contains persistent bars.", report);
                        }
                        return report;
                    }
                );
            }
            if (this.store.get(id).generation.provider === "heygen" && render && !render.skipped) {
                framingAudit = await this.executeStage(
                    id,
                    "framing-final-audit",
                    "AUDITING_FINAL_FRAMING",
                    (current) => {
                        if (!this.framingTracker) throw new Error("Framing tracker is not configured.");
                        return this.framingTracker.auditFinal(current, render, framingSourceAudit);
                    }
                );
            }
            const archive = this.store.get(id).archive.enabled
                ? await this.executeStage(id, "archive", "ARCHIVING", (current) => {
                      if (!this.archiveManager) {
                          throw new Error("Archive manager is not configured.");
                      }
                      return this.archiveManager.archiveJob(current);
                  })
                : null;

            job = this.store.get(id);
            const approvalRequired =
                job.autonomy.rough_cut_approval === "required" ||
                (job.production.render && job.autonomy.final_publish_approval === "required");
            job.status = approvalRequired ? "APPROVAL_REQUIRED" : "COMPLETE";
            job.completedAt = approvalRequired ? null : nowIso();
            job.lock = null;
            job.error = null;
            job.result = {
                projectPath:
                    archive && archive.mode === "move"
                        ? archive.archivedProjectPath
                        : job.outputPaths.project,
                sequenceName: job.production.sequenceName,
                render:
                    render && !render.skipped
                        ? {
                              ...render,
                              outputFile:
                                  archive && archive.mode === "move"
                                      ? archive.archivedRenderPath
                                      : render.outputFile,
                          }
                        : null,
                structuralQcPassed: qc.passed,
                archive,
                generation,
                retention,
                framing: {
                    source: framingSourceAudit,
                    final: framingAudit,
                },
                composition: this.store.get(id).composition?.enabled ? {
                    visualScenePlan,
                    subjectTrack,
                    responsiveLayout,
                    assets: compositionAssets,
                    qa: compositionQa,
                } : null,
                shortForm: this.store.get(id).shortForm?.enabled ? {
                    edit: this.store.get(id).checkpoints["short-form-edit"]?.result || null,
                    framing: shortFormFraming,
                } : null,
            };
            this.store.save(job);
            this.store.addEvent(id, approvalRequired ? "APPROVAL_REQUESTED" : "JOB_COMPLETED", {
                result: job.result,
            });
            return this.store.get(id);
        } catch (error) {
            job = this.store.get(id);
            job.status = this.classifyFailure(error, job.attempts);
            job.lock = null;
            job.error = {
                code: error.code || "ERROR",
                message: error.message,
                missing: error.missing || undefined,
                details: error.details || undefined,
                at: nowIso(),
            };
            this.store.save(job);
            this.store.addEvent(id, "JOB_FAILED", {
                status: job.status,
                error: job.error,
            });
            throw error;
        } finally {
            this.activeJobId = null;
        }
    }

    async tick() {
        if (this.activeJobId) return { busy: true, jobId: this.activeJobId };
        const next = this.store.dueJobs()[0];
        if (!next) return { busy: false, ran: false };
        try {
            const job = await this.run(next.id);
            return { busy: false, ran: true, jobId: next.id, status: job.status };
        } catch (error) {
            return {
                busy: false,
                ran: true,
                jobId: next.id,
                status: this.store.get(next.id).status,
                error: error.message,
            };
        }
    }

    async archive(id, overrides = {}) {
        if (!this.archiveManager) throw new Error("Archive manager is not configured.");
        if (this.activeJobId && this.activeJobId !== id) {
            throw new Error(`Production node is busy with ${this.activeJobId}.`);
        }
        let job = this.store.get(id);
        const resumableArchiveFailure =
            job.status === "ARCHIVING" &&
            job.checkpoints.archive &&
            job.checkpoints.archive.status === "FAILED";
        if (!["COMPLETE", "APPROVAL_REQUIRED"].includes(job.status) && !resumableArchiveFailure) {
            throw new Error(`Job ${id} must be complete before archival; current status is ${job.status}.`);
        }
        const priorStatus = job.completedAt ? "COMPLETE" : "APPROVAL_REQUIRED";
        this.activeJobId = id;
        try {
            const options = this.archiveManager.normalizeOptions(job, overrides);
            job.archive = options;
            this.store.save(job);
            const receipt = await this.executeStage(
                id,
                "archive",
                "ARCHIVING",
                (current) => this.archiveManager.archiveJob(current, options),
                { always: true }
            );
            job = this.store.get(id);
            job.status = job.completedAt ? "COMPLETE" : "APPROVAL_REQUIRED";
            job.result = {
                ...(job.result || {}),
                archive: receipt,
                projectPath:
                    receipt.mode === "move" && receipt.archivedProjectPath
                        ? receipt.archivedProjectPath
                        : job.result && job.result.projectPath,
                render:
                    job.result && job.result.render
                        ? {
                              ...job.result.render,
                              outputFile:
                                  receipt.mode === "move" && receipt.archivedRenderPath
                                      ? receipt.archivedRenderPath
                                      : job.result.render.outputFile,
                          }
                        : null,
            };
            this.store.save(job);
            this.store.addEvent(id, "JOB_ARCHIVED", receipt);
            return this.store.get(id);
        } catch (error) {
            job = this.store.get(id);
            job.status = priorStatus;
            job.error = {
                code: error.code || "ARCHIVE_FAILED",
                message: error.message,
                details: error.details || undefined,
                at: nowIso(),
            };
            this.store.save(job);
            this.store.addEvent(id, "JOB_ARCHIVE_FAILED", { error: job.error });
            throw error;
        } finally {
            this.activeJobId = null;
        }
    }
}

module.exports = {
    VideoJobRunner,
    WaitingForAssetsError,
    WorkflowValidationError,
    averageVideoLuma,
    measureAudioLoudness,
    parseEbur128Summary,
    requestedProjectIsOpen,
    retentionLoudnessCorrection,
};
