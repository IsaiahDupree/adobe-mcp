const fs = require("fs");
const path = require("path");
const { CodexCliEditorialJudge, DeterministicEditorialJudge } = require("./editorial-judge");
const { nowIso, readJson, writeJsonAtomic } = require("./util");

class ProductionBoardRunner {
    constructor({
        config,
        boardStore,
        jobStore,
        jobRunner,
        trendScout,
        performanceMemory,
        briefArchitect,
        showrunner,
        technicalQa,
        mediaAnalyzer,
        releaseArbiter,
        releasePackager,
    }) {
        Object.assign(this, {
            config,
            boardStore,
            jobStore,
            jobRunner,
            trendScout,
            performanceMemory,
            briefArchitect,
            showrunner,
            technicalQa,
            mediaAnalyzer,
            releaseArbiter,
            releasePackager,
        });
        this.activeBoardId = null;
    }

    artifactPath(board, name) {
        return path.join(board.workspace, "artifacts", name);
    }

    async loadOrCreate(filePath, operation) {
        if (fs.existsSync(filePath)) return readJson(filePath);
        const result = await operation();
        writeJsonAtomic(filePath, result);
        return result;
    }

    versionPasses(board, qa, scorecards) {
        return qa.passed && scorecards.filter((card) =>
            this.releaseArbiter.judgePass(card, board.release)
        ).length >= board.release.requiredJudgePasses;
    }

    async judgeRevision(board, job, briefPath, qaPath, qa, media, revisionDirectory) {
        const profiles = ["retention", "clarity"].slice(0, board.agents.judgeCount);
        if (board.agents.provider === "codex_cli") {
            const scorecards = [];
            for (const profile of profiles) {
                const judge = new CodexCliEditorialJudge(this.config, profile, board.agents.codexBin);
                try {
                    scorecards.push(await judge.review({ job, briefPath, qaPath, media, outputDirectory: revisionDirectory }));
                } catch (error) {
                    const fallback = new DeterministicEditorialJudge(profile).review({
                        job,
                        brief: readJson(briefPath),
                        qa,
                        media,
                    });
                    fallback.provider = "deterministic-local-fallback";
                    fallback.fallback = {
                        requestedProvider: "codex-cli-chatgpt-auth",
                        reason: error.code || error.message,
                        occurredAt: nowIso(),
                    };
                    scorecards.push(fallback);
                }
            }
            return scorecards;
        }
        return profiles.map((profile) =>
            new DeterministicEditorialJudge(profile).review({ job, brief: readJson(briefPath), qa, media })
        );
    }

    async run(id) {
        if (this.activeBoardId && this.activeBoardId !== id) {
            throw new Error(`Production board node is busy with ${this.activeBoardId}.`);
        }
        let board = this.boardStore.get(id);
        if (board.status === "COMPLETE") return board;
        this.activeBoardId = id;
        board.status = "RESEARCHING";
        board.startedAt = board.startedAt || nowIso();
        board.error = null;
        this.boardStore.save(board);
        this.boardStore.addEvent(id, "BOARD_STARTED", { maxRevisions: board.maxRevisions });

        try {
            const trendPath = this.artifactPath(board, "trend-report.json");
            const trendReport = await this.loadOrCreate(trendPath, () => this.trendScout.research(board));
            const memoryPath = this.artifactPath(board, "lessons.json");
            const memory = await this.loadOrCreate(memoryPath, () => this.performanceMemory.analyze(board));
            const briefPath = this.artifactPath(board, "content-brief.json");
            const brief = await this.loadOrCreate(briefPath, () => this.briefArchitect.create(board, trendReport, memory));
            this.boardStore.addEvent(id, "BRIEF_COMPLETED", {
                trendCandidates: trendReport.candidates.length,
                lessons: memory.lessons.length,
                beats: brief.beatSheet.length,
            });

            let cumulativeChanges = board.revisions.flatMap((revision) => revision.directive.selectedChanges || []);
            for (let revision = board.revisions.length + 1; revision <= board.maxRevisions; revision += 1) {
                board = this.boardStore.get(id);
                board.status = revision === 1 ? "PRODUCING_V1" : `REVISING_V${revision}`;
                board.currentRevision = revision;
                this.boardStore.save(board);
                const priorScorecards = board.revisions.at(-1)?.scorecards || [];
                const directive = revision === 1
                    ? this.showrunner.initialDirective(board, brief)
                    : this.showrunner.selectChanges(revision, priorScorecards);
                if (revision > 1) cumulativeChanges = [...cumulativeChanges, ...directive.selectedChanges];
                const revisionDirectory = path.join(board.workspace, "revisions", `v${revision}`);
                fs.mkdirSync(revisionDirectory, { recursive: true });
                writeJsonAtomic(path.join(revisionDirectory, "edit-directive.json"), directive);
                const jobSpec = this.showrunner.applyDirectives(
                    board.baseJob,
                    board,
                    revision,
                    cumulativeChanges
                );
                writeJsonAtomic(path.join(revisionDirectory, "job-spec.json"), jobSpec);
                let job;
                try {
                    job = this.jobStore.get(jobSpec.job_id);
                } catch {
                    job = this.jobStore.submit(jobSpec);
                }
                this.boardStore.addEvent(id, "REVISION_STARTED", { revision, jobId: job.id });
                job = await this.jobRunner.run(job.id);
                const qaPath = path.join(revisionDirectory, "qa-report.json");
                const qa = await this.technicalQa.run(job, board, brief, qaPath);
                const media = await this.mediaAnalyzer.createContactSheet(
                    job,
                    job.result.render.outputFile,
                    job.result.render.durationSeconds,
                    path.join(board.workspace, "frames", `v${revision}`)
                );
                const scorecards = await this.judgeRevision(
                    board,
                    job,
                    briefPath,
                    qaPath,
                    qa,
                    media,
                    revisionDirectory
                );
                writeJsonAtomic(path.join(revisionDirectory, "judge-scorecards.json"), scorecards);
                const record = {
                    revision,
                    jobId: job.id,
                    projectPath: job.result.projectPath,
                    renderPath: job.result.render.outputFile,
                    directive,
                    appliedChanges: cumulativeChanges,
                    qa,
                    scorecards,
                    contactSheet: media.contactSheet,
                    completedAt: nowIso(),
                };
                board = this.boardStore.get(id);
                board.revisions.push(record);
                this.boardStore.save(board);
                this.boardStore.addEvent(id, "REVISION_JUDGED", {
                    revision,
                    scores: scorecards.map((scorecard) => scorecard.overallScore),
                    technicalPass: qa.passed,
                });
                if (revision >= board.minimumRevisions && this.versionPasses(board, qa, scorecards)) break;
            }

            board = this.boardStore.get(id);
            const decision = this.releaseArbiter.evaluate(board);
            const decisionPath = this.artifactPath(board, "release-decision.json");
            writeJsonAtomic(decisionPath, decision);
            const allScorecardsPath = this.artifactPath(board, "judge-scorecards.json");
            writeJsonAtomic(allScorecardsPath, board.revisions.map((revision) => ({
                revision: revision.revision,
                scorecards: revision.scorecards,
            })));
            const historyPath = this.artifactPath(board, "revision-history.json");
            writeJsonAtomic(historyPath, board.revisions.map((revision) => ({
                revision: revision.revision,
                jobId: revision.jobId,
                directive: revision.directive,
                projectPath: revision.projectPath,
                renderPath: revision.renderPath,
                scores: revision.scorecards.map((scorecard) => scorecard.overallScore),
                technicalPass: revision.qa.passed,
                completedAt: revision.completedAt,
            })));
            const winningRevision = board.revisions.find((revision) => revision.revision === decision.winner.revision);
            const winnerJob = this.jobStore.get(winningRevision.jobId);
            const packageResult = await this.releasePackager.package(board, winnerJob, decision, {
                trendReport: trendPath,
                performanceMemory: memoryPath,
                contentBrief: briefPath,
                scorecards: allScorecardsPath,
                revisionHistory: historyPath,
                qaReport: path.join(board.workspace, "revisions", `v${winningRevision.revision}`, "qa-report.json"),
            });
            board = this.boardStore.get(id);
            board.status = "COMPLETE";
            board.completedAt = nowIso();
            board.releaseDecision = decision;
            board.result = packageResult;
            board.error = null;
            this.boardStore.save(board);
            this.boardStore.addEvent(id, "BOARD_COMPLETED", {
                status: decision.status,
                winningRevision: decision.winner.revision,
                finalVideo: packageResult.finalVideo,
            });
            return this.boardStore.get(id);
        } catch (error) {
            board = this.boardStore.get(id);
            board.status = "FAILED";
            board.error = { code: error.code || "BOARD_FAILED", message: error.message, at: nowIso() };
            this.boardStore.save(board);
            this.boardStore.addEvent(id, "BOARD_FAILED", { error: board.error });
            throw error;
        } finally {
            this.activeBoardId = null;
        }
    }
}

module.exports = { ProductionBoardRunner };
