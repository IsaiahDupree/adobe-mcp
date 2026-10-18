const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { ensureDir, nowIso, run, writeJsonAtomic } = require("./util");

const RATIOS = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "4:5": 4 / 5,
    "5:4": 5 / 4,
    "1:1": 1,
};

function validationError(message, details = {}) {
    const error = new Error(message);
    error.code = "WORKFLOW_VALIDATION_FAILED";
    error.details = details;
    return error;
}

async function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}

async function probeMedia(filePath, ffprobeBin = "ffprobe") {
    const { stdout } = await run(ffprobeBin, [
        "-v", "error",
        "-show_entries", "format=duration,size:stream=index,codec_name,codec_type,width,height,r_frame_rate",
        "-of", "json",
        filePath,
    ], { timeout: 30000 });
    const parsed = JSON.parse(stdout);
    const streams = parsed.streams || [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const durationSeconds = Number(parsed.format?.duration);
    const bytes = Number(parsed.format?.size || fs.statSync(filePath).size);
    return { streams, video, audio, durationSeconds, bytes };
}

async function averageVideoLuma(filePath, ffmpegBin = "ffmpeg") {
    const { stdout } = await run(ffmpegBin, [
        "-hide_banner", "-loglevel", "error", "-i", filePath,
        "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:file=-",
        "-an", "-f", "null", "-",
    ], { timeout: 3 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const values = stdout.split(/\r?\n/)
        .filter((line) => line.includes("lavfi.signalstats.YAVG="))
        .map((line) => Number(line.split("=").at(-1)))
        .filter(Number.isFinite);
    if (!values.length) throw validationError(`Visual signal QA could not sample ${filePath}.`);
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

class DirectHeyGenDelivery {
    constructor(config, framingTracker) {
        this.ffprobeBin = config.FFPROBE_BIN || "ffprobe";
        this.ffmpegBin = config.FFMPEG_BIN || "ffmpeg";
        this.framingTracker = framingTracker;
    }

    source(job, generation) {
        if (job.production.directSource) {
            return {
                localPath: job.production.directSource.localPath,
                provider: job.production.directSource.provider,
                providerVideoId: job.production.directSource.providerVideoId,
                providerSessionId: job.production.directSource.providerSessionId,
                providerPageUrl: job.production.directSource.providerPageUrl,
                title: job.production.directSource.title || job.request.topic,
                aspectRatio: job.production.directSource.aspectRatio,
                consentAsserted: job.production.directSource.consentAsserted,
                rightsBasis: job.production.directSource.rightsBasis,
                maximumBarAreaRatio: job.production.directSource.maximumBarAreaRatio,
            };
        }
        const scenes = generation?.scenes || [];
        if (scenes.length !== 1) {
            throw validationError("Direct HeyGen delivery requires exactly one completed source video.", {
                sceneCount: scenes.length,
            });
        }
        const scene = scenes[0];
        return {
            localPath: scene.localVideo,
            provider: generation.provider === "heygen" ? "heygen-v3" : generation.provider || "heygen-v3",
            providerVideoId: scene.videoId || null,
            providerSessionId: null,
            providerPageUrl: scene.videoPageUrl || null,
            title: job.request.topic,
            aspectRatio: job.generation.aspectRatio,
            consentAsserted: true,
            rightsBasis: "owner-consented-digital-twin",
            maximumBarAreaRatio: job.composition?.framing?.maximumFinalBarAreaRatio ?? 0.003,
        };
    }

    async package(job, generation = null) {
        const source = this.source(job, generation);
        if (!source.localPath || !fs.existsSync(source.localPath)) {
            throw validationError(`Direct HeyGen source is missing: ${source.localPath || "not provided"}.`);
        }
        if (!source.consentAsserted) {
            throw validationError("Direct HeyGen delivery requires an asserted owner consent record.");
        }
        if (!this.framingTracker) {
            throw validationError("Direct HeyGen framing QA is not configured.");
        }

        const extension = path.extname(source.localPath).toLowerCase() || ".mp4";
        if (![".mp4", ".webm"].includes(extension)) {
            throw validationError(`Direct HeyGen source must be MP4 or WebM, not ${extension}.`);
        }
        const approvedDir = ensureDir(path.join(job.workspace, "approved"));
        const outputFile = path.join(
            approvedDir,
            `${job.production.projectName}-direct-heygen${extension}`
        );
        if (path.resolve(source.localPath) !== path.resolve(outputFile)) {
            fs.copyFileSync(source.localPath, outputFile);
        }

        const media = await probeMedia(outputFile, this.ffprobeBin);
        const [sha256, averageLuma] = await Promise.all([
            sha256File(outputFile),
            averageVideoLuma(outputFile, this.ffmpegBin),
        ]);
        let framing;
        try {
            framing = await this.framingTracker.analyzeMedia(outputFile);
        } catch (error) {
            if (!/produced no crop samples/.test(error.message) || !media.video) throw error;
            framing = {
                filePath: outputFile,
                frame: { width: media.video.width, height: media.video.height },
                sampleCount: 0,
                dominantSampleCount: 0,
                persistence: 1,
                detectedContentBounds: {
                    width: media.video.width,
                    height: media.video.height,
                    x: 0,
                    y: 0,
                },
                edgeInsetsPixels: { left: 0, top: 0, right: 0, bottom: 0 },
                barAreaRatio: 0,
                fullFrameSampleRate: 1,
                provider: "ffmpeg-cropdetect-no-crop-full-frame",
            };
        }
        const expectedRatio = RATIOS[source.aspectRatio];
        const actualRatio = media.video ? media.video.width / media.video.height : null;
        const aspectRatioPassed = !expectedRatio || (
            Number.isFinite(actualRatio) && Math.abs(actualRatio - expectedRatio) <= 0.03
        );
        const checks = {
            videoStream: Boolean(media.video),
            audioStream: Boolean(media.audio),
            duration: Number.isFinite(media.durationSeconds) && media.durationSeconds > 0,
            aspectRatio: aspectRatioPassed,
            fullFrame: framing.barAreaRatio <= source.maximumBarAreaRatio,
            visualSignal: averageLuma >= 5 && averageLuma <= 250,
        };
        const passed = Object.values(checks).every(Boolean);
        const approvalRequired =
            job.autonomy.rough_cut_approval === "required" ||
            job.autonomy.final_publish_approval === "required";
        const receipt = {
            schemaVersion: 1,
            contractType: "direct_heygen_delivery_receipt",
            jobId: job.id,
            campaignId: job.campaignId,
            createdAt: nowIso(),
            deliveryMode: "direct_heygen",
            editor: null,
            notPublished: true,
            approvalRequired,
            source: {
                provider: source.provider,
                providerVideoId: source.providerVideoId,
                providerSessionId: source.providerSessionId,
                providerPageUrl: source.providerPageUrl,
                title: source.title,
                localPath: source.localPath,
                consentAsserted: source.consentAsserted,
                rightsBasis: source.rightsBasis,
            },
            output: {
                outputFile,
                bytes: media.bytes,
                sha256,
                durationSeconds: Number(media.durationSeconds.toFixed(3)),
                streams: media.streams,
            },
            qc: {
                passed,
                checks,
                expectedAspectRatio: source.aspectRatio,
                actualAspectRatio: actualRatio === null ? null : Number(actualRatio.toFixed(6)),
                maximumBarAreaRatio: source.maximumBarAreaRatio,
                framing,
                averageLuma,
            },
            bypassedDependencies: [
                "adobe-premiere-pro",
                "adobe-media-encoder",
                "premiere-uxp-bridge",
            ],
        };
        writeJsonAtomic(job.outputPaths.directDeliveryReceipt, receipt);
        if (!passed) {
            throw validationError("Direct HeyGen output failed delivery QA.", receipt.qc);
        }
        return receipt;
    }
}

module.exports = { DirectHeyGenDelivery, averageVideoLuma, probeMedia, sha256File };
