const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, slugify, writeJsonAtomic } = require("./util");

const campaignPresets = require("../config/short-form-campaign-presets.json");
const METRIC_FIELDS = [
    "views",
    "averagePercentageViewed",
    "completionRate",
    "threeSecondViewRate",
    "engagementRate",
];

function campaignPreset(id = "heygen-style-matrix-v1") {
    const preset = campaignPresets.presets.find((item) => item.id === id && item.status === "active");
    if (!preset) throw new Error(`Unknown active short-form campaign preset: ${id}`);
    return JSON.parse(JSON.stringify(preset));
}

function metricValue(input, camel, snake) {
    const value = Number(input[camel] ?? input[snake]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`metrics.${snake} must be a non-negative number.`);
    return value;
}

function normalizeMetrics(input) {
    return {
        views: metricValue(input, "views", "views"),
        averagePercentageViewed: metricValue(input, "averagePercentageViewed", "average_percentage_viewed"),
        completionRate: metricValue(input, "completionRate", "completion_rate"),
        threeSecondViewRate: metricValue(input, "threeSecondViewRate", "three_second_view_rate"),
        engagementRate: metricValue(input, "engagementRate", "engagement_rate"),
    };
}

function weightedAverage(rows, field) {
    const totalViews = rows.reduce((sum, row) => sum + row.metrics.views, 0);
    if (!totalViews) return 0;
    return rows.reduce((sum, row) => sum + row.metrics[field] * row.metrics.views, 0) / totalViews;
}

class ShortFormCampaignStore {
    constructor(config, jobStore, shortFormStore) {
        this.config = config;
        this.jobStore = jobStore;
        this.shortFormStore = shortFormStore;
        this.directory = config.SHORT_FORM_CAMPAIGNS_DIR;
        ensureDir(this.directory);
    }

    statePath(id) {
        return path.join(this.directory, id, "campaign.json");
    }

    presetLibraryPath() {
        return path.join(this.directory, "validated-style-presets.json");
    }

    save(state) {
        state.updatedAt = nowIso();
        writeJsonAtomic(this.statePath(state.id), state);
        return state;
    }

    get(id) {
        if (!fs.existsSync(this.statePath(id))) throw new Error(`Short-form campaign ${id} was not found.`);
        return readJson(this.statePath(id));
    }

    list() {
        return fs.readdirSync(this.directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(this.statePath(entry.name)))
            .map((entry) => readJson(this.statePath(entry.name)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    validatedPresets() {
        return fs.existsSync(this.presetLibraryPath())
            ? readJson(this.presetLibraryPath())
            : { schemaVersion: 1, updatedAt: null, presets: [] };
    }

    submit(spec) {
        const preset = campaignPreset(spec.preset || spec.preset_id || spec.presetId);
        const id = slugify(spec.campaign_id || spec.campaignId || `short-campaign-${Date.now()}`);
        if (fs.existsSync(this.statePath(id))) throw new Error(`Short-form campaign ${id} already exists.`);
        const sourceJobIds = [...new Set(spec.source_job_ids || spec.sourceJobIds || [])];
        for (const [index, sourceSpec] of (spec.source_jobs || spec.sourceJobs || []).entries()) {
            if (sourceSpec?.generation?.provider !== "heygen") {
                throw new Error(`source_jobs[${index}] must use generation.provider heygen.`);
            }
            const prepared = JSON.parse(JSON.stringify(sourceSpec));
            prepared.derivative_campaign = { enabled: false };
            sourceJobIds.push(this.jobStore.submit(prepared).id);
        }
        if (!sourceJobIds.length) throw new Error("Short-form campaign requires source_job_ids or source_jobs.");
        const platforms = [...new Set(spec.platforms || preset.platforms)].map((item) => String(item).toLowerCase());
        if (!platforms.length) throw new Error("Short-form campaign requires at least one platform.");
        const styles = [...new Set(spec.styles || preset.styles)];
        const startAt = spec.start_at || spec.startAt || new Date(Date.now() + 24 * 3600000).toISOString();
        if (Number.isNaN(Date.parse(startAt))) throw new Error("Short-form campaign start_at must be a valid ISO date.");
        const state = {
            schemaVersion: 1,
            id,
            status: "REQUESTED",
            presetId: preset.id,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            triggerJobId: spec.trigger_job_id || spec.triggerJobId || null,
            sourceJobIds,
            sourceAssetPolicy: "reuse-completed-heygen-generation",
            styles,
            clipsPerSource: Math.max(1, Math.min(5, Number(spec.clips_per_source || spec.clipsPerSource || preset.clipsPerSource))),
            minimumSeconds: Number(spec.minimum_seconds || spec.minimumSeconds || preset.minimumSeconds),
            maximumSeconds: Number(spec.maximum_seconds || spec.maximumSeconds || preset.maximumSeconds),
            platforms,
            startAt: new Date(startAt).toISOString(),
            schedule: { ...preset.schedule, ...(spec.schedule || {}) },
            experiment: { ...preset.experiment, ...(spec.experiment || {}) },
            archive: {
                enabled: spec.archive?.enabled !== false,
                mode: spec.archive?.mode || "copy",
                destination_root: spec.archive?.destination_root || path.join(this.config.PASSPORT_ARCHIVE_ROOT, "ShortForm"),
            },
            shortFormBatchId: null,
            matrix: [],
            metricSnapshots: [],
            evaluation: null,
            error: null,
            completedAt: null,
        };
        ensureDir(path.dirname(this.statePath(id)));
        return this.save(state);
    }

    findByTriggerJob(jobId) {
        return this.list().find((item) => item.triggerJobId === jobId) || null;
    }

    ensureForJob(job) {
        const existing = this.findByTriggerJob(job.id);
        if (existing) return existing;
        const input = job.derivativeCampaign;
        return this.submit({
            campaign_id: input.campaignId || `${job.id}-style-matrix`,
            trigger_job_id: job.id,
            source_job_ids: [job.id],
            preset: input.presetId,
            styles: input.styles,
            clips_per_source: input.clipsPerSource,
            platforms: input.platforms,
            start_at: input.startAt,
            schedule: input.schedule,
            experiment: input.experiment,
            archive: input.archive,
        });
    }

    planMatrix(id, batch) {
        const state = this.get(id);
        const existingById = new Map(state.matrix.map((cell) => [cell.cellId, cell]));
        const start = Date.parse(state.startAt);
        const styleOrder = new Map(state.styles.map((style, index) => [style, index]));
        const sourceOrder = new Map(state.sourceJobIds.map((source, index) => [source, index]));
        state.matrix = batch.childJobs.flatMap((child) => {
            const sourceIndex = sourceOrder.get(child.sourceId) || 0;
            const rawStyleIndex = styleOrder.get(child.styleId) || 0;
            const balancedStyleIndex = (rawStyleIndex - sourceIndex + state.styles.length) % state.styles.length;
            return state.platforms.map((platform, platformIndex) => {
                const scheduled = start + balancedStyleIndex * Number(state.schedule.styleSpacingHours) * 3600000 +
                    platformIndex * Number(state.schedule.crossPlatformOffsetMinutes) * 60000;
                const cellId = `${child.jobId}-${platform}`;
                const existing = existingById.get(cellId);
                return {
                    cellId,
                    campaignId: state.id,
                    sourceJobId: child.sourceId,
                    generationFamilyId: child.sourceId,
                    shortJobId: child.jobId,
                    styleId: child.styleId,
                    sourceRange: child.sourceRange,
                    platform,
                    scheduledFor: new Date(scheduled).toISOString(),
                    renderPath: child.render?.outputFile || child.renderPath,
                    projectPath: child.projectPath,
                    status: existing?.status || (state.schedule.approvalRequired ? "planned-approval-required" : "planned"),
                    approvedAt: existing?.approvedAt,
                    platformPostId: existing?.platformPostId,
                    publishPayload: {
                        platform,
                        mediaPath: child.render?.outputFile || child.renderPath,
                        scheduledFor: new Date(scheduled).toISOString(),
                        approvalRequired: existing?.publishPayload?.approvalRequired ?? Boolean(state.schedule.approvalRequired),
                    },
                };
            });
        });
        this.save(state);
        writeJsonAtomic(path.join(path.dirname(this.statePath(id)), "publication-matrix.json"), {
            schemaVersion: 1,
            generatedAt: nowIso(),
            campaignId: id,
            experiment: state.experiment,
            cells: state.matrix,
        });
        return state.matrix;
    }

    recordMetrics(id, input) {
        const state = this.get(id);
        const cellId = input.cell_id || input.cellId;
        const cell = state.matrix.find((item) => item.cellId === cellId);
        if (!cell) throw new Error(`Experiment cell ${cellId} was not found.`);
        const window = String(input.window || "24h");
        if (state.metricSnapshots.some((item) => item.cellId === cellId && item.window === window)) {
            throw new Error(`Metrics already exist for ${cellId}/${window}.`);
        }
        const snapshot = {
            snapshotId: `${cellId}-${window}`,
            observedAt: new Date(input.observed_at || input.observedAt || Date.now()).toISOString(),
            cellId,
            shortJobId: cell.shortJobId,
            styleId: cell.styleId,
            platform: cell.platform,
            platformPostId: String(input.platform_post_id || input.platformPostId || ""),
            window,
            metrics: normalizeMetrics(input.metrics || input),
        };
        if (!snapshot.platformPostId) throw new Error("platform_post_id is required.");
        state.metricSnapshots.push(snapshot);
        cell.status = "published-metrics-observed";
        cell.platformPostId = snapshot.platformPostId;
        this.save(state);
        return snapshot;
    }

    approve(id, cellIds = "all") {
        const state = this.get(id);
        const requested = cellIds === "all"
            ? new Set(state.matrix.map((cell) => cell.cellId))
            : new Set(Array.isArray(cellIds) ? cellIds : [cellIds]);
        if (!requested.size) throw new Error("At least one experiment cell is required for approval.");
        const known = new Set(state.matrix.map((cell) => cell.cellId));
        const missing = [...requested].filter((cellId) => !known.has(cellId));
        if (missing.length) throw new Error(`Experiment cells were not found: ${missing.join(", ")}`);
        for (const cell of state.matrix) {
            if (!requested.has(cell.cellId)) continue;
            cell.status = "approved-for-publisher";
            cell.approvedAt = nowIso();
            cell.publishPayload.approvalRequired = false;
        }
        this.save(state);
        return state.matrix.filter((cell) => requested.has(cell.cellId));
    }

    evaluate(id) {
        const state = this.get(id);
        const summaries = state.styles.map((styleId) => {
            const rows = state.metricSnapshots.filter((item) => item.styleId === styleId);
            return {
                styleId,
                replications: rows.length,
                views: rows.reduce((sum, row) => sum + row.metrics.views, 0),
                averagePercentageViewed: weightedAverage(rows, "averagePercentageViewed"),
                completionRate: weightedAverage(rows, "completionRate"),
                threeSecondViewRate: weightedAverage(rows, "threeSecondViewRate"),
                engagementRate: weightedAverage(rows, "engagementRate"),
            };
        });
        const enough = summaries.every((item) =>
            item.replications >= Number(state.experiment.minimumReplicationsPerStyle) &&
            item.views >= Number(state.experiment.minimumViewsPerStyle)
        );
        const ranked = [...summaries].sort((a, b) => b.averagePercentageViewed - a.averagePercentageViewed);
        const winner = enough ? ranked[0] : null;
        const runnerUp = enough ? ranked[1] : null;
        const liftRatio = winner && runnerUp && runnerUp.averagePercentageViewed > 0
            ? (winner.averagePercentageViewed - runnerUp.averagePercentageViewed) / runnerUp.averagePercentageViewed
            : 0;
        const guardrailsPassed = winner && runnerUp
            ? state.experiment.guardrails.every((field) => {
                  const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
                  return winner[camel] >= runnerUp[camel] * 0.95;
              })
            : false;
        const promoted = Boolean(
            enough && guardrailsPassed && liftRatio >= Number(state.experiment.practicalSignificanceRatio)
        );
        state.evaluation = {
            evaluatedAt: nowIso(),
            status: enough ? (promoted ? "WINNER_PROMOTED" : "NO_PRACTICAL_WINNER") : "INSUFFICIENT_EVIDENCE",
            primaryMetric: state.experiment.primaryMetric,
            summaries,
            winnerStyleId: promoted ? winner.styleId : null,
            liftRatio,
            guardrailsPassed,
        };
        if (promoted) this.promote(state, winner, state.evaluation);
        this.save(state);
        return state.evaluation;
    }

    promote(state, winner, evaluation) {
        const library = this.validatedPresets();
        const id = `${state.presetId}-${winner.styleId}`;
        const existing = library.presets.find((item) => item.id === id);
        const record = {
            id,
            status: "validated",
            basePresetId: state.presetId,
            preferredStyleId: winner.styleId,
            sourceCampaignIds: [...new Set([...(existing?.sourceCampaignIds || []), state.id])],
            primaryMetric: state.experiment.primaryMetric,
            liftRatio: evaluation.liftRatio,
            promotedAt: existing?.promotedAt || nowIso(),
            updatedAt: nowIso(),
        };
        if (existing) Object.assign(existing, record);
        else library.presets.push(record);
        library.updatedAt = nowIso();
        writeJsonAtomic(this.presetLibraryPath(), library);
    }
}

class ShortFormCampaignRunner {
    constructor(campaignStore, jobStore, jobRunner, shortFormStore, shortFormRunner) {
        this.store = campaignStore;
        this.jobStore = jobStore;
        this.jobRunner = jobRunner;
        this.shortFormStore = shortFormStore;
        this.shortFormRunner = shortFormRunner;
        this.activeCampaignId = null;
    }

    async run(id) {
        if (this.activeCampaignId && this.activeCampaignId !== id) {
            throw new Error(`Short-form campaign runner is busy with ${this.activeCampaignId}.`);
        }
        let state = this.store.get(id);
        this.activeCampaignId = id;
        state.status = "RUNNING";
        state.error = null;
        this.store.save(state);
        try {
            for (const sourceId of state.sourceJobIds) {
                let source = this.jobStore.get(sourceId);
                if (source.generation.provider !== "heygen") {
                    throw new Error(`Short-form campaign source ${sourceId} is not a HeyGen generation job.`);
                }
                if (!["COMPLETE", "APPROVAL_REQUIRED"].includes(source.status)) {
                    source = await this.jobRunner.run(sourceId);
                }
                if (!source.checkpoints?.["heygen-generation"]?.result) {
                    throw new Error(`Short-form campaign source ${sourceId} has no reusable HeyGen generation receipt.`);
                }
            }
            const batchId = state.shortFormBatchId || `${state.id}-batch`;
            let batch;
            try {
                batch = this.shortFormStore.get(batchId);
            } catch {
                batch = this.shortFormStore.submit({
                    short_form_id: batchId,
                    campaign_id: state.id,
                    source_job_ids: state.sourceJobIds,
                    clips_per_source: state.clipsPerSource,
                    styles: state.styles,
                    variant_mode: "all-styles",
                    minimum_seconds: state.minimumSeconds,
                    maximum_seconds: state.maximumSeconds,
                    require_captions: true,
                    archive: state.archive,
                });
            }
            state.shortFormBatchId = batch.id;
            this.store.save(state);
            batch = await this.shortFormRunner.run(batch.id);
            this.store.planMatrix(id, batch);
            state = this.store.get(id);
            state.status = "APPROVAL_REQUIRED";
            state.error = null;
            this.store.save(state);
            return state;
        } catch (error) {
            state = this.store.get(id);
            state.status = "FAILED";
            state.error = { code: error.code || "ERROR", message: error.message, at: nowIso() };
            this.store.save(state);
            throw error;
        } finally {
            this.activeCampaignId = null;
        }
    }
}

module.exports = {
    METRIC_FIELDS,
    ShortFormCampaignRunner,
    ShortFormCampaignStore,
    campaignPreset,
    campaignPresets,
    normalizeMetrics,
};
