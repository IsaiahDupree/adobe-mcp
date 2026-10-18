class AutonomousProductionCoordinator {
    constructor(jobRunner, campaignStore, campaignRunner) {
        this.jobRunner = jobRunner;
        this.campaignStore = campaignStore;
        this.campaignRunner = campaignRunner;
    }

    get activeJobId() {
        return this.jobRunner.activeJobId;
    }

    async run(id) {
        let job = await this.jobRunner.run(id);
        if (job.derivativeCampaign?.enabled) {
            if (job.generation.provider !== "heygen") {
                throw new Error("Autonomous derivative campaigns require a HeyGen source job.");
            }
            const campaign = this.campaignStore.ensureForJob(job);
            const result = await this.campaignRunner.run(campaign.id);
            job = this.jobRunner.store.get(id);
            job.result = { ...(job.result || {}), derivativeCampaign: {
                campaignId: result.id,
                status: result.status,
                shortFormBatchId: result.shortFormBatchId,
                matrixCells: result.matrix.length,
            } };
            this.jobRunner.store.save(job);
        }
        return job;
    }

    async tick() {
        if (this.activeJobId) return { busy: true, jobId: this.activeJobId };
        const next = this.jobRunner.store.dueJobs()[0];
        if (!next) return { busy: false, ran: false };
        try {
            const job = await this.run(next.id);
            return { busy: false, ran: true, jobId: next.id, status: job.status };
        } catch (error) {
            return {
                busy: false,
                ran: true,
                jobId: next.id,
                status: this.jobRunner.store.get(next.id).status,
                error: error.message,
            };
        }
    }

    archive(id, options) {
        return this.jobRunner.archive(id, options);
    }
}

module.exports = { AutonomousProductionCoordinator };
