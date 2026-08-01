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

class VideoJobRunner {
    constructor(
        store,
        appManager,
        adapter,
        archiveManager = null,
        heygenManager = null,
        retentionPlanner = null,
        cepAdapter = null,
        captionRenderer = null
    ) {
        this.store = store;
        this.appManager = appManager;
        this.adapter = adapter;
        this.archiveManager = archiveManager;
        this.heygenManager = heygenManager;
        this.retentionPlanner = retentionPlanner;
        this.cepAdapter = cepAdapter;
        this.captionRenderer = captionRenderer;
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
                (state) => state.project && state.project.hasProject,
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
            (state) => state.project && state.project.hasProject,
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

        if (!sequence) {
            if (!(await this.canUseUxp())) {
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
        const report = {
            outputFile: render.output_file,
            bytes,
            durationSeconds: Number(probe.format.duration),
            streams: probe.streams,
        };
        writeJsonAtomic(path.join(job.workspace, "qc", "render-validation.json"), report);
        return report;
    }

    applyGeneratedAssets(id, retentionResult) {
        const job = this.store.get(id);
        const premiereAssetsDir = path.join(job.workspace, "generated-assets", "heygen", "premiere-assets");
        ensureDir(premiereAssetsDir);
        const sceneAssets = retentionResult.scenes.map((scene, index) => {
            const extension = path.extname(scene.source) || ".mp4";
            const assetPath = path.join(premiereAssetsDir, `${scene.sceneId}${extension}`);
            if (!fs.existsSync(assetPath)) {
                try {
                    fs.linkSync(scene.source, assetPath);
                } catch {
                    fs.copyFileSync(scene.source, assetPath);
                }
            }
            return {
                id: `asset-heygen-${String(index + 1).padStart(3, "0")}`,
                path: assetPath,
                role: "heygen-scene",
                order: index,
            };
        });
        job.production.sourceAssets = sceneAssets;
        job.production.editPlan = {
            source: job.outputPaths.editManifest,
            timeline: retentionResult.scenes.map((scene, index) => ({
                asset_path: sceneAssets[index].path,
                order: index,
                video_track_index: 0,
                audio_track_index: 0,
            })),
            retention: retentionResult,
        };
        this.store.save(job);
    }

    async applyPremiereRetention(job) {
        const plan = readJson(job.outputPaths.editManifest);
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
        const editPacket = await this.cepAdapter.applyRetentionPlan({
            sequenceName: sequence.name,
            plan,
            captionAssets,
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
        };
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
            if (this.store.get(id).generation.enabled) {
                generation = await this.executeStage(
                    id,
                    "heygen-generation",
                    "GENERATING_AVATAR",
                    (current) => {
                        if (!this.heygenManager) throw new Error("HeyGen manager is not configured.");
                        return this.heygenManager.generate(current);
                    }
                );
                retention = await this.executeStage(
                    id,
                    "retention-plan",
                    "PLANNING_EDIT",
                    (current) => {
                        if (!this.retentionPlanner) throw new Error("Retention planner is not configured.");
                        return this.retentionPlanner.plan(current, generation);
                    }
                );
                this.applyGeneratedAssets(id, retention);
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
            if (this.store.get(id).generation.enabled) {
                await this.executeStage(id, "retention-edit", "RETENTION_EDITING", (current) =>
                    this.applyPremiereRetention(current)
                );
            }
            await this.executeStage(id, "save", "SAVING_PROJECT", (current) =>
                this.saveProject(current)
            );
            const qc = await this.executeStage(id, "structural-qc", "QUALITY_CONTROL", (current) =>
                this.runStructuralQc(current)
            );
            const render = await this.executeStage(id, "render", "EXPORTING", (current) =>
                this.renderAndValidate(current)
            );
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

module.exports = { VideoJobRunner, WaitingForAssetsError, WorkflowValidationError };
