const fs = require("fs");
const path = require("path");
const { normalizeMetricSnapshot, normalizeReviseSpec } = require("./revise-schema");
const { ensureDir, nowIso, readJson, writeJsonAtomic } = require("./util");

class ReviseStore {
    constructor(config) {
        this.directory = config.REVISE_DIR;
        ensureDir(this.directory);
    }

    templateLibraryPath() {
        return path.join(this.directory, "validated-templates.json");
    }

    templateLibrary() {
        if (!fs.existsSync(this.templateLibraryPath())) {
            return { schemaVersion: 1, updatedAt: null, templates: [] };
        }
        return readJson(this.templateLibraryPath());
    }

    promoteTemplate(state, learningRecord) {
        if (!learningRecord.templatePromotionEligible || !learningRecord.winnerVariantId) return null;
        const winner = state.variants.find((variant) => variant.id === learningRecord.winnerVariantId);
        const library = this.templateLibrary();
        const templateId = `${state.experiment.primaryVariable}-${winner.id}`;
        const existing = library.templates.find((template) => template.id === templateId);
        const record = {
            id: templateId,
            status: "validated",
            hypothesis: state.experiment.hypothesis,
            primaryVariable: state.experiment.primaryVariable,
            winningValue: winner.variables[state.experiment.primaryVariable],
            primaryMetric: state.experiment.primaryMetric,
            practicalSignificanceRatio: state.experiment.practicalSignificanceRatio,
            validatedContentFamilies: learningRecord.replicationFamilies,
            sourceLearningIds: [...new Set([...(existing?.sourceLearningIds || []), learningRecord.learningId])],
            productionVariables: winner.variables,
            promotedAt: existing?.promotedAt || nowIso(),
            updatedAt: nowIso(),
        };
        if (existing) Object.assign(existing, record);
        else library.templates.push(record);
        library.updatedAt = nowIso();
        writeJsonAtomic(this.templateLibraryPath(), library);
        return record;
    }

    statePath(id) {
        return path.join(this.directory, id, "revise.json");
    }

    artifactPath(state, name) {
        return path.join(state.workspace, "artifacts", name);
    }

    save(state) {
        state.updatedAt = nowIso();
        writeJsonAtomic(this.statePath(state.id), state);
        return state;
    }

    submit(spec) {
        const normalized = normalizeReviseSpec(spec, this.directory);
        if (fs.existsSync(this.statePath(normalized.id))) {
            throw new Error(`REVISE loop ${normalized.id} already exists.`);
        }
        for (const folder of ["artifacts", "metrics", "logs"]) {
            ensureDir(path.join(normalized.workspace, folder));
        }
        const state = {
            ...normalized,
            status: "REQUESTED",
            startedAt: null,
            completedAt: null,
            variantRuns: [],
            metricSnapshots: [],
            learningRecord: null,
            result: null,
            error: null,
            events: [],
        };
        this.save(state);
        this.addEvent(state.id, "REVISE_SUBMITTED", {
            experimentId: state.experiment.id,
            type: state.experiment.type,
            variants: state.variants.map((variant) => variant.id),
        });
        return this.get(state.id);
    }

    get(id) {
        if (!fs.existsSync(this.statePath(id))) throw new Error(`REVISE loop ${id} was not found.`);
        return readJson(this.statePath(id));
    }

    list() {
        return fs.readdirSync(this.directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(this.statePath(entry.name)))
            .map((entry) => readJson(this.statePath(entry.name)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    addEvent(id, type, data = {}) {
        const state = this.get(id);
        const event = { at: nowIso(), type, ...data };
        state.events.push(event);
        state.events = state.events.slice(-500);
        this.save(state);
        fs.appendFileSync(path.join(state.workspace, "logs", "events.ndjson"), `${JSON.stringify(event)}\n`);
        return event;
    }

    recordMetrics(id, input) {
        const state = this.get(id);
        const inputs = Array.isArray(input) ? input : [input];
        const snapshots = inputs.map((item) => normalizeMetricSnapshot(
            item,
            state.experiment,
            state.variants
        ));
        for (const snapshot of snapshots) {
            const duplicate = state.metricSnapshots.find((item) =>
                item.variantId === snapshot.variantId &&
                item.platformPostId === snapshot.platformPostId &&
                item.window === snapshot.window
            );
            if (duplicate) throw new Error(
                `Metric snapshot already exists for ${snapshot.variantId}/${snapshot.platformPostId}/${snapshot.window}.`
            );
            state.metricSnapshots.push(snapshot);
            writeJsonAtomic(path.join(state.workspace, "metrics", `${snapshot.snapshotId}.json`), snapshot);
            const slot = state.publicationPlan?.slots?.find((item) => item.variantId === snapshot.variantId);
            if (slot) {
                slot.platformPostId = snapshot.platformPostId;
                slot.status = "published-metrics-observed";
            }
        }
        if (state.artifacts?.publicationPlan && state.publicationPlan) {
            writeJsonAtomic(state.artifacts.publicationPlan, state.publicationPlan);
        }
        this.save(state);
        this.addEvent(id, "METRICS_RECORDED", {
            snapshotIds: snapshots.map((snapshot) => snapshot.snapshotId),
        });
        return snapshots;
    }
}

module.exports = { ReviseStore };
