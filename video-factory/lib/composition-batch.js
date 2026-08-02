const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, slugify, writeJsonAtomic } = require("./util");
const { selectHeyGenLook } = require("./heygen-look-selector");

const SUPPORTED_FORMATS = new Set(["16:9", "9:16"]);

class CompositionBatchStore {
    constructor(config, jobStore) {
        this.directory = config.COMPOSITIONS_DIR;
        this.jobStore = jobStore;
        ensureDir(this.directory);
    }

    batchPath(id) {
        return path.join(this.directory, `${id}.json`);
    }

    save(batch) {
        batch.updatedAt = nowIso();
        writeJsonAtomic(this.batchPath(batch.id), batch);
        return batch;
    }

    get(id) {
        if (!fs.existsSync(this.batchPath(id))) throw new Error(`Composition batch ${id} was not found.`);
        return readJson(this.batchPath(id));
    }

    list() {
        return fs.readdirSync(this.directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(path.join(this.directory, name)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    submit(spec) {
        const baseJob = spec.base_job || spec.baseJob;
        if (!baseJob || typeof baseJob !== "object") throw new Error("composition.base_job is required.");
        const formats = [...new Set(spec.formats || ["16:9", "9:16"])];
        if (!formats.length || formats.some((format) => !SUPPORTED_FORMATS.has(format))) {
            throw new Error("composition.formats must contain 16:9 or 9:16.");
        }
        const id = slugify(spec.composition_id || spec.compositionId || `composition-${Date.now()}`);
        if (fs.existsSync(this.batchPath(id))) throw new Error(`Composition batch ${id} already exists.`);
        const childJobs = [];
        for (const format of formats) {
            const requestedLooks = spec.avatar_looks || spec.avatarLooks || {};
            const look = selectHeyGenLook(format, requestedLooks[format]);
            const childId = `${id}-${format.replace(":", "x")}`;
            const generation = {
                ...(baseJob.generation || {}),
                enabled: true,
                provider: "heygen",
                avatar_id: look.id,
                aspect_ratio: format,
            };
            const production = {
                ...(baseJob.production || {}),
                project_name: `${slugify(baseJob.production?.project_name || id)}-${format.replace(":", "x")}`,
                sequence_name: `MASTER_${format.replace(":", "x")}`,
            };
            const composition = {
                ...(baseJob.composition || {}),
                enabled: true,
                formats: [format],
                character: {
                    ...(baseJob.composition?.character || {}),
                    avatar_group_id: look.avatarGroupId,
                    avatar_look_id: look.id,
                    look_orientation: look.orientation,
                },
            };
            const childSpec = {
                ...baseJob,
                job_id: childId,
                production,
                generation,
                composition,
            };
            const child = this.jobStore.submit(childSpec);
            child.parentCompositionId = id;
            child.status = "COMPOSITION_HELD";
            this.jobStore.save(child);
            childJobs.push({
                format,
                jobId: child.id,
                avatarLook: look,
                sequenceName: child.production.sequenceName,
                projectPath: child.outputPaths.project,
                status: "COMPOSITION_HELD",
            });
        }
        return this.save({
            schemaVersion: 1,
            id,
            status: "REQUESTED",
            createdAt: nowIso(),
            updatedAt: nowIso(),
            formats,
            sharedCreative: {
                campaignId: baseJob.campaign_id || "default-campaign",
                scenes: baseJob.generation?.scenes || [],
                voiceId: baseJob.generation?.voice_id || null,
            },
            childJobs,
            error: null,
            completedAt: null,
        });
    }
}

class CompositionBatchRunner {
    constructor(store, jobStore, jobRunner) {
        this.store = store;
        this.jobStore = jobStore;
        this.jobRunner = jobRunner;
        this.activeBatchId = null;
    }

    async run(id) {
        if (this.activeBatchId && this.activeBatchId !== id) {
            throw new Error(`Composition runner is busy with ${this.activeBatchId}.`);
        }
        let batch = this.store.get(id);
        if (batch.status === "COMPLETE") return batch;
        this.activeBatchId = id;
        batch.status = "RUNNING";
        batch.error = null;
        this.store.save(batch);
        try {
            for (const child of batch.childJobs) {
                const current = this.jobStore.get(child.jobId);
                const result = current.status === "COMPLETE" ? current : await this.jobRunner.run(child.jobId);
                child.status = result.status;
                child.projectPath = result.result?.projectPath || result.outputPaths.project;
                child.render = result.result?.render || null;
                child.compositionQaPassed = result.result?.composition?.qa?.passed || false;
                this.store.save(batch);
                if (!["COMPLETE", "APPROVAL_REQUIRED"].includes(result.status)) {
                    throw new Error(`Child job ${child.jobId} stopped in ${result.status}.`);
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

module.exports = { CompositionBatchRunner, CompositionBatchStore };
