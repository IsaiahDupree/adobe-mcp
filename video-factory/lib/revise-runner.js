const crypto = require("crypto");
const fs = require("fs");
const { ExperimentIntegrity } = require("./experiment-integrity");
const { LearningEvaluator } = require("./learning-evaluator");
const { PublicationPlanner } = require("./publication-planner");
const { nowIso, readJson, writeJsonAtomic } = require("./util");

async function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

class ReviseRunner {
    constructor({ reviseStore, boardStore, boardRunner, jobStore }) {
        this.store = reviseStore;
        this.boardStore = boardStore;
        this.boardRunner = boardRunner;
        this.jobStore = jobStore;
        this.integrity = new ExperimentIntegrity();
        this.publicationPlanner = new PublicationPlanner();
        this.learningEvaluator = new LearningEvaluator();
        this.activeId = null;
    }

    artifact(state, name, value) {
        const filePath = this.store.artifactPath(state, name);
        writeJsonAtomic(filePath, value);
        return filePath;
    }

    async design(id) {
        let state = this.store.get(id);
        if (
            state.artifacts?.researchPacket &&
            state.artifacts?.experimentSpec &&
            fs.existsSync(state.artifacts.researchPacket) &&
            fs.existsSync(state.artifacts.experimentSpec)
        ) return state;
        const now = Date.now();
        const evidence = state.evidence.map((item) => ({
            ...item,
            ageDays: Number(((now - Date.parse(item.observedAt)) / 86400000).toFixed(2)),
            current: now - Date.parse(item.observedAt) <= state.maximumEvidenceAgeDays * 86400000,
        }));
        const researchPacket = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            topicId: state.topicId,
            contentFamilyId: state.contentFamilyId,
            opportunity: state.opportunity,
            uncertainty: state.uncertainty,
            overusedPatterns: state.overusedPatterns,
            maximumEvidenceAgeDays: state.maximumEvidenceAgeDays,
            evidence,
            validatedTemplates: this.store.templateLibrary().templates,
            passed: evidence.some((item) => item.current),
        };
        if (!researchPacket.passed) throw new Error("Research gate failed because no evidence is current.");
        const experimentSpec = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            topicId: state.topicId,
            contentFamilyId: state.contentFamilyId,
            experiment: state.experiment,
            variants: state.variants.map((variant) => ({
                variantId: variant.id,
                role: variant.role,
                platform: variant.platform,
                generationFamilyId: variant.generationFamilyId,
                variables: variant.variables,
                boardId: variant.board.board_id,
            })),
            passed: true,
        };
        const researchPath = this.artifact(state, "research_packet.json", researchPacket);
        const experimentPath = this.artifact(state, "experiment_spec.json", experimentSpec);
        state = this.store.get(id);
        state.status = "DESIGNED";
        state.startedAt = state.startedAt || nowIso();
        state.artifacts = { ...(state.artifacts || {}), researchPacket: researchPath, experimentSpec: experimentPath };
        this.store.save(state);
        this.store.addEvent(id, "EXPERIMENT_DESIGNED", { researchPassed: true, experimentPassed: true });
        return this.store.get(id);
    }

    async produceVariant(state, variant) {
        let board;
        try {
            board = this.boardStore.get(variant.board.board_id);
        } catch {
            board = this.boardStore.submit(variant.board);
        }
        board = await this.boardRunner.run(board.id);
        const winner = board.releaseDecision?.winner;
        if (!winner) throw new Error(`Variant ${variant.id} has no winning revision.`);
        const winnerJob = this.jobStore.get(winner.jobId);
        const renderPath = winnerJob.result?.render?.outputFile;
        if (!renderPath || !fs.existsSync(renderPath)) {
            throw new Error(`Variant ${variant.id} has no playable winning render.`);
        }
        const generationScenes = winnerJob.result?.generation?.scenes || [];
        return {
            variantId: variant.id,
            role: variant.role,
            platform: variant.platform,
            boardId: board.id,
            board,
            winnerJob,
            lineage: {
                topicId: state.topicId,
                contentFamilyId: state.contentFamilyId,
                experimentId: state.experiment.id,
                heygenGenerationIds: generationScenes.map((scene) => scene.videoId).filter(Boolean),
                generationFamilyId: variant.generationFamilyId,
                variantId: variant.id,
                renderId: winnerJob.id,
                renderPath,
                renderSha256: await sha256(renderPath),
                platformPostId: null,
                metricSnapshotIds: [],
                learningId: null,
            },
        };
    }

    async run(id) {
        if (this.activeId && this.activeId !== id) throw new Error(`REVISE runner is busy with ${this.activeId}.`);
        let state = this.store.get(id);
        if (state.status === "COMPLETE") return state;
        this.activeId = id;
        try {
            if (!state.artifacts?.experimentSpec) state = await this.design(id);
            state.status = "PRODUCING_VARIANTS";
            state.error = null;
            this.store.save(state);
            const produced = [];
            for (const variant of state.variants) {
                this.store.addEvent(id, "VARIANT_PRODUCTION_STARTED", { variantId: variant.id });
                const result = await this.produceVariant(state, variant);
                produced.push(result);
                this.store.addEvent(id, "VARIANT_PRODUCTION_COMPLETED", {
                    variantId: variant.id,
                    boardId: result.boardId,
                    renderId: result.lineage.renderId,
                });
            }
            state = this.store.get(id);
            const variantManifest = {
                schemaVersion: 1,
                generatedAt: nowIso(),
                reviseId: state.id,
                experimentId: state.experiment.id,
                variants: produced.map((item) => item.lineage),
            };
            const variantManifestPath = this.artifact(state, "variant_manifest.json", variantManifest);
            const integrity = this.integrity.evaluate(state, produced);
            const reviewBundle = {
                schemaVersion: 1,
                generatedAt: nowIso(),
                reviseId: state.id,
                innerLoop: {
                    maximumRevisionTurns: 3,
                    variants: produced.map((item) => ({
                        variantId: item.variantId,
                        boardId: item.boardId,
                        revisionCount: item.board.revisions.length,
                        releaseDecision: item.board.releaseDecision,
                    })),
                },
                integrity,
                passed: integrity.passed,
            };
            const reviewBundlePath = this.artifact(state, "review_bundle.json", reviewBundle);
            const publicationPlan = integrity.passed
                ? this.publicationPlanner.plan(state, variantManifest, this.store.list())
                : {
                    schemaVersion: 1,
                    generatedAt: nowIso(),
                    reviseId: state.id,
                    experimentId: state.experiment.id,
                    passed: false,
                    mode: "blocked-contaminated-experiment",
                    slots: [],
                    issues: integrity.issues,
                };
            const publicationPlanPath = this.artifact(state, "publication_plan.json", publicationPlan);
            state = this.store.get(id);
            state.variantRuns = produced.map((item) => ({
                variantId: item.variantId,
                boardId: item.boardId,
                renderId: item.lineage.renderId,
                renderPath: item.lineage.renderPath,
            }));
            state.reviewBundle = reviewBundle;
            state.publicationPlan = publicationPlan;
            state.status = integrity.passed ? "READY_TO_SCHEDULE" : "BLOCKED_CONTAMINATED";
            state.productionCompletedAt = nowIso();
            state.artifacts = {
                ...state.artifacts,
                variantManifest: variantManifestPath,
                reviewBundle: reviewBundlePath,
                publicationPlan: publicationPlanPath,
            };
            state.result = { artifacts: state.artifacts, publicationPlan };
            this.store.save(state);
            this.store.addEvent(id, "INNER_REVISE_COMPLETED", {
                status: state.status,
                integrityPassed: integrity.passed,
                slots: publicationPlan.slots.length,
            });
            return this.store.get(id);
        } catch (error) {
            state = this.store.get(id);
            state.status = "FAILED";
            state.error = { code: error.code || "REVISE_FAILED", message: error.message, at: nowIso() };
            this.store.save(state);
            this.store.addEvent(id, "REVISE_FAILED", { error: state.error });
            throw error;
        } finally {
            this.activeId = null;
        }
    }

    evaluate(id, window = null) {
        let state = this.store.get(id);
        const learningRecord = this.learningEvaluator.evaluate(state, this.store.list(), window);
        const learningPath = this.artifact(state, "learning_record.json", learningRecord);
        if (state.artifacts?.variantManifest && fs.existsSync(state.artifacts.variantManifest)) {
            const manifest = readJson(state.artifacts.variantManifest);
            for (const lineage of manifest.variants) {
                const snapshots = state.metricSnapshots.filter((snapshot) => snapshot.variantId === lineage.variantId);
                const selected = snapshots.find((snapshot) => snapshot.window === learningRecord.window);
                lineage.platformPostId = selected?.platformPostId || lineage.platformPostId;
                lineage.metricSnapshotIds = snapshots.map((snapshot) => snapshot.snapshotId);
                lineage.learningId = learningRecord.learningId;
            }
            writeJsonAtomic(state.artifacts.variantManifest, manifest);
        }
        const promotedTemplate = this.store.promoteTemplate(state, learningRecord);
        state = this.store.get(id);
        state.learningRecord = learningRecord;
        state.status = "COMPLETE";
        state.completedAt = nowIso();
        state.artifacts = { ...state.artifacts, learningRecord: learningPath };
        state.result = {
            ...(state.result || {}),
            learningRecord,
            promotedTemplate,
            validatedTemplateLibrary: promotedTemplate ? this.store.templateLibraryPath() : null,
            artifacts: state.artifacts,
        };
        this.store.save(state);
        this.store.addEvent(id, "OUTER_REVISE_EVALUATED", {
            decision: learningRecord.decision,
            window: learningRecord.window,
            winnerVariantId: learningRecord.winnerVariantId,
            promotedTemplateId: promotedTemplate?.id || null,
        });
        return this.store.get(id);
    }
}

module.exports = { ReviseRunner, sha256 };
