const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { ensureDir, nowIso, readJson, run, sleep, writeJsonAtomic } = require("./util");

class HeyGenError extends Error {
    constructor(message, code = "HEYGEN_ERROR", details = {}) {
        super(message);
        this.name = "HeyGenError";
        this.code = code;
        this.details = details;
    }
}

class HeyGenManager {
    constructor(config, elevenLabsManager = null) {
        this.apiUrl = config.HEYGEN_API_URL.replace(/\/$/, "");
        this.apiKey = config.HEYGEN_API_KEY;
        this.elevenLabsManager = elevenLabsManager;
    }

    headers(json = false) {
        const headers = { "x-api-key": this.apiKey };
        if (json) headers["content-type"] = "application/json";
        return headers;
    }

    async request(endpoint, options = {}) {
        let lastError;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
            try {
                const response = await fetch(`${this.apiUrl}${endpoint}`, {
                    ...options,
                    headers: { ...this.headers(Boolean(options.body)), ...(options.headers || {}) },
                    signal: controller.signal,
                });
                const text = await response.text();
                const body = text ? JSON.parse(text) : {};
                if (response.ok) return body;
                const message =
                    body.message || body.error?.message || body.error || `HTTP ${response.status}`;
                const error = new HeyGenError(`HeyGen request failed: ${message}`, "HEYGEN_API_FAILED", {
                    status: response.status,
                    endpoint,
                });
                if (response.status !== 429 && response.status < 500) throw error;
                lastError = error;
                const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
                await sleep(retryAfter || attempt * 1500);
            } catch (error) {
                if (error instanceof HeyGenError && error.details.status < 500 && error.details.status !== 429) {
                    throw error;
                }
                lastError = error;
                await sleep(attempt * 1000);
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError || new HeyGenError("HeyGen request failed after retries.");
    }

    async download(url, destination) {
        ensureDir(path.dirname(destination));
        const partial = `${destination}.partial`;
        const response = await fetch(url);
        if (!response.ok || !response.body) {
            throw new HeyGenError(`HeyGen asset download failed with HTTP ${response.status}.`, "HEYGEN_DOWNLOAD_FAILED");
        }
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
        if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) {
            throw new HeyGenError("HeyGen returned an empty asset.", "HEYGEN_DOWNLOAD_FAILED");
        }
        fs.renameSync(partial, destination);
        return destination;
    }

    async uploadAsset(filePath) {
        const file = fs.statSync(filePath);
        if (file.size > 32 * 1024 * 1024) {
            throw new HeyGenError("HeyGen assets must be 32 MB or smaller.", "HEYGEN_ASSET_TOO_LARGE");
        }
        const form = new FormData();
        form.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
        const response = await fetch(`${this.apiUrl}/v3/assets`, {
            method: "POST",
            headers: this.headers(false),
            body: form,
            signal: AbortSignal.timeout(120000),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : {};
        if (!response.ok) {
            throw new HeyGenError(
                `HeyGen asset upload failed: ${body.error?.message || body.message || `HTTP ${response.status}`}`,
                "HEYGEN_ASSET_UPLOAD_FAILED",
                { status: response.status }
            );
        }
        const data = body.data || body;
        const assetId = data.asset_id || data.id;
        if (!assetId) throw new HeyGenError("HeyGen asset upload returned no asset ID.", "HEYGEN_INVALID_RESPONSE");
        return { assetId, url: data.url || null, mimeType: data.mime_type || null, sizeBytes: data.size_bytes || file.size };
    }

    async listVoices(filters = {}) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
        }
        return this.request(`/v3/voices?${params}`);
    }

    scenePaths(job, scene) {
        const directory = path.join(job.workspace, "generated-assets", "heygen", scene.id);
        const extension = job.generation.outputFormat === "webm" ? "webm" : "mp4";
        return {
            directory,
            video: path.join(directory, `clean.${extension}`),
            subtitle: path.join(directory, "captions.srt"),
            metadata: path.join(directory, "metadata.json"),
        };
    }

    requestBody(job, scene, audioAssetId = null) {
        const generation = job.generation;
        const body = {
            type: "avatar",
            avatar_id: generation.avatarId,
            engine: { type: generation.engine },
            title: scene.title || `${job.campaignId} / ${scene.id}`,
            aspect_ratio: generation.aspectRatio,
            resolution: generation.resolution,
            caption: { file_format: "srt" },
            output_format: generation.outputFormat,
        };
        if (audioAssetId) {
            body.audio_asset_id = audioAssetId;
        } else {
            body.voice_id = generation.voiceId;
            body.script = scene.script;
            body.voice_settings = generation.voiceSettings;
        }
        if (generation.background) body.background = generation.background;
        if (generation.fit) body.fit = generation.fit;
        if (generation.removeBackground) body.remove_background = true;
        if (generation.engine === "avatar_iv") {
            if (generation.motionPrompt) body.motion_prompt = generation.motionPrompt;
            if (generation.expressiveness) body.expressiveness = generation.expressiveness;
        }
        return body;
    }

    async poll(videoId, generation) {
        const started = Date.now();
        let resource;
        while (Date.now() - started < generation.timeoutMs) {
            const response = await this.request(`/v3/videos/${encodeURIComponent(videoId)}`);
            resource = response.data || response;
            if (resource.status === "completed") return resource;
            if (resource.status === "failed") {
                throw new HeyGenError(
                    `HeyGen video ${videoId} failed: ${resource.failure_message || resource.failure_code || "unknown error"}`,
                    "HEYGEN_GENERATION_FAILED",
                    { videoId, failureCode: resource.failure_code || null }
                );
            }
            await sleep(generation.pollIntervalMs);
        }
        throw new HeyGenError(
            `HeyGen video ${videoId} did not complete within ${Math.round(generation.timeoutMs / 60000)} minutes.`,
            "HEYGEN_TIMEOUT",
            { videoId, lastStatus: resource && resource.status }
        );
    }

    async generateScene(job, scene) {
        const paths = this.scenePaths(job, scene);
        ensureDir(paths.directory);
        let metadata = fs.existsSync(paths.metadata) ? readJson(paths.metadata) : null;
        if (
            metadata &&
            metadata.status === "completed" &&
            fs.existsSync(paths.video) &&
            fs.existsSync(paths.subtitle)
        ) {
            return metadata;
        }

        let videoId = metadata && metadata.videoId;
        if (!videoId) {
            let narration = null;
            let audioAsset = null;
            if (job.generation.voiceProvider === "elevenlabs") {
                if (!this.elevenLabsManager) {
                    throw new HeyGenError("ElevenLabs narration manager is not configured.", "ELEVENLABS_NOT_CONFIGURED");
                }
                const localAudio = path.join(paths.directory, "narration.mp3");
                narration = fs.existsSync(localAudio) && fs.statSync(localAudio).size > 0
                    ? readJson(`${localAudio}.json`)
                    : await this.elevenLabsManager.generateSpeech({
                        text: scene.script,
                        voiceId: job.generation.elevenLabsVoiceId,
                        modelId: job.generation.elevenLabsModelId,
                        outputFormat: job.generation.elevenLabsOutputFormat,
                        voiceSettings: job.generation.elevenLabsVoiceSettings,
                        destination: localAudio,
                    });
                audioAsset = await this.uploadAsset(localAudio);
            }
            const body = this.requestBody(job, scene, audioAsset?.assetId || null);
            const response = await this.request("/v3/videos", {
                method: "POST",
                body: JSON.stringify(body),
            });
            const data = response.data || response;
            videoId = data.video_id || data.id;
            if (!videoId) {
                throw new HeyGenError("HeyGen accepted no video identifier.", "HEYGEN_INVALID_RESPONSE");
            }
            metadata = {
                sceneId: scene.id,
                videoId,
                status: data.status || "pending",
                submittedAt: nowIso(),
                request: {
                    ...body,
                    script: audioAsset ? undefined : scene.script,
                },
                narration,
                heygenAudioAsset: audioAsset,
            };
            writeJsonAtomic(paths.metadata, metadata);
        }

        const resource = await this.poll(videoId, job.generation);
        if (!resource.video_url) {
            throw new HeyGenError("Completed HeyGen video has no video_url.", "HEYGEN_INVALID_RESPONSE", { videoId });
        }
        if (!resource.subtitle_url) {
            throw new HeyGenError("Completed HeyGen video has no subtitle_url.", "HEYGEN_INVALID_RESPONSE", { videoId });
        }
        await this.download(resource.video_url, paths.video);
        await this.download(resource.subtitle_url, paths.subtitle);

        const { stdout } = await run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height",
            "-of",
            "json",
            paths.video,
        ], { timeout: 30000 });
        const probe = JSON.parse(stdout);
        if (!probe.streams || !probe.streams.some((stream) => stream.codec_type === "video")) {
            throw new HeyGenError("Downloaded HeyGen asset has no readable video stream.", "HEYGEN_INVALID_VIDEO");
        }
        metadata = {
            ...metadata,
            status: "completed",
            completedAt: nowIso(),
            durationSeconds: Number(resource.duration || probe.format.duration),
            videoPageUrl: resource.video_page_url || null,
            localVideo: paths.video,
            localSubtitle: paths.subtitle,
            bytes: Number(probe.format.size),
            streams: probe.streams,
        };
        writeJsonAtomic(paths.metadata, metadata);
        return metadata;
    }

    async generate(job) {
        if (!job.generation.enabled) return { skipped: true };
        if (!this.apiKey) {
            throw new HeyGenError("HEYGEN_API_KEY is not configured.", "HEYGEN_NOT_CONFIGURED");
        }
        const scenes = new Array(job.generation.scenes.length);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < job.generation.scenes.length) {
                const index = nextIndex;
                nextIndex += 1;
                scenes[index] = await this.generateScene(job, job.generation.scenes[index]);
            }
        };
        const concurrency = Math.min(job.generation.concurrency || 3, job.generation.scenes.length);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        const manifest = {
            schemaVersion: 1,
            provider: "heygen-v3",
            jobId: job.id,
            generatedAt: nowIso(),
            avatarId: job.generation.avatarId,
            voiceId: job.generation.voiceId,
            voiceProvider: job.generation.voiceProvider,
            elevenLabsVoiceId: job.generation.voiceProvider === "elevenlabs"
                ? job.generation.elevenLabsVoiceId
                : null,
            voiceExperimentId: job.generation.voiceExperimentId,
            voiceVariantId: job.generation.voiceVariantId,
            engine: job.generation.engine,
            aspectRatio: job.generation.aspectRatio,
            outputFormat: job.generation.outputFormat,
            removeBackground: job.generation.removeBackground,
            scenes,
            totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
        };
        writeJsonAtomic(job.outputPaths.generationManifest, manifest);
        return manifest;
    }
}

module.exports = { HeyGenError, HeyGenManager };
