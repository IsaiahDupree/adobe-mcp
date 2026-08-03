const fs = require("fs");
const path = require("path");
const { normalizeJobSpec } = require("./job-schema");
const { ensureDir, nowIso, readJson, writeJsonAtomic } = require("./util");

class JobStore {
    constructor(config) {
        this.config = config;
        ensureDir(config.JOBS_DIR);
        ensureDir(config.CAMPAIGNS_DIR);
    }

    jobPath(id) {
        return path.join(this.config.JOBS_DIR, `${id}.json`);
    }

    submit(spec) {
        const normalized = normalizeJobSpec(
            spec,
            this.config.CAMPAIGNS_DIR,
            this.config.PASSPORT_ARCHIVE_ROOT,
            {
                avatarId: this.config.HEYGEN_AVATAR_ID,
                voiceId: this.config.HEYGEN_VOICE_ID,
                elevenLabsVoiceId: this.config.ELEVENLABS_VOICE_ID,
            }
        );
        if (fs.existsSync(this.jobPath(normalized.id))) {
            throw new Error(`Job ${normalized.id} already exists.`);
        }

        const now = nowIso();
        const job = {
            ...normalized,
            status: Date.parse(normalized.scheduledFor) > Date.now() ? "SCHEDULED" : "REQUESTED",
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
            attempts: 0,
            checkpoints: {},
            events: [],
            error: null,
            result: null,
            lock: null,
        };

        this.prepareWorkspace(job);
        this.save(job);
        this.addEvent(job.id, "JOB_SUBMITTED", {
            status: job.status,
            scheduledFor: job.scheduledFor,
        });
        return this.get(job.id);
    }

    prepareWorkspace(job) {
        const folders = [
            "request",
            "research",
            "script",
            "source-assets",
            "generated-assets",
            "voice",
            "transcripts",
            "edit-plans",
            "premiere",
            "proxies",
            "renders",
            "qc",
            "approved",
            "published",
            "logs",
        ];
        for (const folder of folders) {
            ensureDir(path.join(job.workspace, folder));
        }
        writeJsonAtomic(path.join(job.workspace, "request", "job-request.json"), {
            campaign_id: job.campaignId,
            request: job.request,
            schedule: { production_start: job.scheduledFor },
            autonomy: job.autonomy,
            production: job.production,
            generation: job.generation,
            retention: job.retention,
            showcase: job.showcase,
            composition: job.composition,
            shortForm: job.shortForm,
            derivativeCampaign: job.derivativeCampaign,
            archive: job.archive,
        });
    }

    get(id) {
        const filePath = this.jobPath(id);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Job ${id} was not found.`);
        }
        return readJson(filePath);
    }

    save(job) {
        job.updatedAt = nowIso();
        writeJsonAtomic(this.jobPath(job.id), job);
        return job;
    }

    update(id, changes) {
        const job = this.get(id);
        Object.assign(job, changes);
        return this.save(job);
    }

    addEvent(id, type, data = {}) {
        const job = this.get(id);
        const event = { at: nowIso(), type, ...data };
        job.events.push(event);
        if (job.events.length > 500) {
            job.events = job.events.slice(-500);
        }
        this.save(job);
        fs.appendFileSync(
            path.join(job.workspace, "logs", "events.ndjson"),
            `${JSON.stringify(event)}\n`,
            "utf8"
        );
        return event;
    }

    list(filters = {}) {
        return fs
            .readdirSync(this.config.JOBS_DIR)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(path.join(this.config.JOBS_DIR, name)))
            .filter((job) => !filters.status || job.status === filters.status)
            .sort((a, b) => b.priority - a.priority || a.scheduledFor.localeCompare(b.scheduledFor));
    }

    dueJobs() {
        const runnable = new Set(["REQUESTED", "SCHEDULED", "FAILED_RECOVERABLE"]);
        return this.list().filter(
            (job) => runnable.has(job.status) && Date.parse(job.scheduledFor) <= Date.now()
        );
    }

    cancel(id) {
        const job = this.get(id);
        if (["COMPLETE", "CANCELLED"].includes(job.status)) {
            return job;
        }
        job.status = "CANCELLED";
        job.completedAt = nowIso();
        job.lock = null;
        this.save(job);
        this.addEvent(id, "JOB_CANCELLED");
        return this.get(id);
    }

    approve(id) {
        const job = this.get(id);
        if (job.status !== "APPROVAL_REQUIRED") {
            throw new Error(`Job ${id} is ${job.status}, not APPROVAL_REQUIRED.`);
        }
        job.status = "COMPLETE";
        job.completedAt = nowIso();
        this.save(job);
        this.addEvent(id, "JOB_APPROVED");
        return this.get(id);
    }
}

module.exports = { JobStore };
