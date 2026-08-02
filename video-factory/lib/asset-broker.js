const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { ensureDir, nowIso, slugify, writeJsonAtomic } = require("./util");

const PROVIDER_LICENSES = {
    pexels: {
        name: "Pexels License",
        url: "https://www.pexels.com/license/",
    },
    pixabay: {
        name: "Pixabay Content License",
        url: "https://pixabay.com/service/license-summary/",
    },
};

class AssetBrokerError extends Error {
    constructor(message, code = "ASSET_BROKER_FAILED", details = {}) {
        super(message);
        this.name = "AssetBrokerError";
        this.code = code;
        this.details = details;
    }
}

function orientationMatches(width, height, orientation) {
    if (!width || !height || orientation === "any") return true;
    if (orientation === "landscape") return width > height;
    if (orientation === "portrait") return height > width;
    return Math.abs(width - height) <= Math.max(width, height) * 0.12;
}

function chooseRendition(renditions, orientation, targetWidth = 1920) {
    const usable = renditions.filter((item) =>
        item.url && item.width && item.height && orientationMatches(item.width, item.height, orientation)
    );
    const pool = usable.length > 0 ? usable : renditions.filter((item) => item.url);
    return pool.sort((a, b) => {
        const aDelta = Math.abs((a.width || 0) - targetWidth);
        const bDelta = Math.abs((b.width || 0) - targetWidth);
        return aDelta - bDelta || (b.width || 0) - (a.width || 0);
    })[0] || null;
}

async function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}

class ProductionAssetBroker {
    constructor(config) {
        this.pexelsApiKey = config.PEXELS_API_KEY || "";
        this.pixabayApiKey = config.PIXABAY_API_KEY || "";
        this.userAgent = "PremiereVideoFactory/1.0";
    }

    async requestWithRetry(url, options, attempts = 3, timeoutMs = 30000) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const response = await fetch(url, {
                    ...options,
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (response.ok || (response.status < 500 && response.status !== 429)) return response;
                lastError = new Error(`HTTP ${response.status}`);
            } catch (error) {
                lastError = error;
            }
            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 750));
            }
        }
        throw lastError;
    }

    async fetchJson(url, options = {}) {
        const response = await this.requestWithRetry(url, {
            ...options,
            headers: { "User-Agent": this.userAgent, ...(options.headers || {}) },
        }, 3, 30000);
        if (!response.ok) {
            const body = await response.text();
            throw new AssetBrokerError(
                `Asset provider returned HTTP ${response.status}.`,
                "ASSET_PROVIDER_REQUEST_FAILED",
                { url: new URL(url).origin, status: response.status, body: body.slice(0, 200) }
            );
        }
        return response.json();
    }

    async searchPexels(request) {
        if (!this.pexelsApiKey) {
            throw new AssetBrokerError("PEXELS_API_KEY is not configured.", "ASSET_PROVIDER_NOT_CONFIGURED");
        }
        const params = new URLSearchParams({
            query: request.query,
            orientation: request.orientation,
            per_page: String(Math.max(10, request.candidateCount)),
            min_duration: String(request.minDurationSeconds),
            max_duration: String(request.maxDurationSeconds),
        });
        const endpoint = `https://api.pexels.com/v1/videos/search?${params}`;
        const data = await this.fetchJson(endpoint, {
            headers: { Authorization: this.pexelsApiKey },
        });
        return (data.videos || []).map((video) => {
            const rendition = chooseRendition(
                (video.video_files || []).map((file) => ({
                    url: file.link,
                    width: file.width,
                    height: file.height,
                    size: file.size,
                    fileType: file.file_type,
                })),
                request.orientation
            );
            return rendition && {
                provider: "pexels",
                providerAssetId: String(video.id),
                pageUrl: video.url,
                creator: video.user?.name || "Unknown",
                creatorUrl: video.user?.url || null,
                durationSeconds: Number(video.duration || 0),
                ...rendition,
            };
        }).filter(Boolean);
    }

    async searchPixabay(request) {
        if (!this.pixabayApiKey) {
            throw new AssetBrokerError("PIXABAY_API_KEY is not configured.", "ASSET_PROVIDER_NOT_CONFIGURED");
        }
        const params = new URLSearchParams({
            key: this.pixabayApiKey,
            q: request.query,
            video_type: "film",
            per_page: String(Math.max(10, request.candidateCount)),
            min_width: request.orientation === "portrait" ? "720" : "1280",
            min_height: request.orientation === "portrait" ? "1280" : "720",
            safesearch: "true",
        });
        const endpoint = `https://pixabay.com/api/videos/?${params}`;
        const data = await this.fetchJson(endpoint);
        return (data.hits || []).map((video) => {
            const rendition = chooseRendition(
                Object.values(video.videos || {}).map((file) => ({
                    url: file.url,
                    width: file.width,
                    height: file.height,
                    size: file.size,
                    thumbnail: file.thumbnail,
                    fileType: "video/mp4",
                })),
                request.orientation
            );
            return rendition && {
                provider: "pixabay",
                providerAssetId: String(video.id),
                pageUrl: video.pageURL,
                creator: video.user || "Unknown",
                creatorUrl: video.user && video.user_id
                    ? `https://pixabay.com/users/${slugify(video.user)}-${video.user_id}/`
                    : null,
                durationSeconds: Number(video.duration || 0),
                tags: String(video.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
                ...rendition,
            };
        }).filter(Boolean);
    }

    rankCandidates(candidates, request, used) {
        return candidates
            .filter((candidate) => !used.has(`${candidate.provider}:${candidate.providerAssetId}`))
            .filter((candidate) => orientationMatches(candidate.width, candidate.height, request.orientation))
            .filter((candidate) => !candidate.durationSeconds || (
                candidate.durationSeconds >= request.minDurationSeconds &&
                candidate.durationSeconds <= request.maxDurationSeconds
            ))
            .sort((a, b) => {
                const aResolution = (a.width || 0) * (a.height || 0);
                const bResolution = (b.width || 0) * (b.height || 0);
                const aDurationFit = Math.abs((a.durationSeconds || request.idealDurationSeconds) - request.idealDurationSeconds);
                const bDurationFit = Math.abs((b.durationSeconds || request.idealDurationSeconds) - request.idealDurationSeconds);
                return aDurationFit - bDurationFit || bResolution - aResolution;
            });
    }

    async download(candidate, destination) {
        ensureDir(path.dirname(destination));
        const temporary = `${destination}.partial-${process.pid}`;
        try {
            const response = await this.requestWithRetry(candidate.url, {
                headers: { "User-Agent": this.userAgent },
                redirect: "follow",
            }, 3, 120000);
            if (!response.ok || !response.body) {
                throw new AssetBrokerError(
                    `Could not download ${candidate.provider} asset ${candidate.providerAssetId}.`,
                    "ASSET_DOWNLOAD_FAILED",
                    { status: response.status }
                );
            }
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
            if (fs.statSync(temporary).size === 0) {
                throw new AssetBrokerError(`Downloaded asset is empty: ${destination}`, "ASSET_DOWNLOAD_FAILED");
            }
            fs.renameSync(temporary, destination);
        } catch (error) {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
            if (error instanceof AssetBrokerError) throw error;
            throw new AssetBrokerError(
                `Could not download ${candidate.provider} asset ${candidate.providerAssetId} after retries.`,
                "ASSET_DOWNLOAD_FAILED",
                { cause: error.message }
            );
        }
    }

    async resolve(job) {
        const requests = job.showcase?.assetRequests || [];
        if (requests.length === 0) {
            return { enabled: false, assets: [], generatedAt: nowIso() };
        }
        if (job.showcase.assetPolicy.mode !== "provider-only") {
            throw new AssetBrokerError("Semantic asset requests require provider-only policy.", "ASSET_POLICY_FAILED");
        }
        if ((job.showcase.brollSources || []).length > 0 || (job.showcase.sfxSources || []).length > 0) {
            throw new AssetBrokerError(
                "Provider-only jobs cannot include pre-existing local B-roll or SFX.",
                "ASSET_POLICY_FAILED"
            );
        }

        const directory = path.join(job.workspace, "source-assets", "broker");
        ensureDir(directory);
        const used = new Set();
        const assets = [];

        for (const request of requests) {
            let selected = null;
            const failures = [];
            for (const provider of request.providers) {
                try {
                    const candidates = provider === "pexels"
                        ? await this.searchPexels(request)
                        : await this.searchPixabay(request);
                    selected = this.rankCandidates(candidates, request, used)[0] || null;
                    if (selected) break;
                    failures.push(`${provider}: no qualifying results`);
                } catch (error) {
                    failures.push(`${provider}: ${error.message}`);
                }
            }
            if (!selected) {
                throw new AssetBrokerError(
                    `No provider asset satisfied request ${request.id}.`,
                    "ASSET_NOT_FOUND",
                    { requestId: request.id, failures }
                );
            }

            const fileName = `${request.id}-${selected.provider}-${selected.providerAssetId}.mp4`;
            const localPath = path.join(directory, fileName);
            await this.download(selected, localPath);
            used.add(`${selected.provider}:${selected.providerAssetId}`);
            const license = PROVIDER_LICENSES[selected.provider];
            assets.push({
                id: request.id,
                type: "video",
                role: "b-roll",
                sceneId: request.sceneId,
                purpose: request.purpose,
                query: request.query,
                provider: selected.provider,
                providerAssetId: selected.providerAssetId,
                pageUrl: selected.pageUrl,
                creator: selected.creator,
                creatorUrl: selected.creatorUrl,
                license: license.name,
                licenseUrl: license.url,
                attribution: `${selected.creator} via ${selected.provider === "pexels" ? "Pexels" : "Pixabay"}`,
                localPath,
                sourceStart: request.sourceStart,
                placementDurationSeconds: request.placementDurationSeconds,
                scale: request.scale,
                width: selected.width,
                height: selected.height,
                durationSeconds: selected.durationSeconds,
                sizeBytes: fs.statSync(localPath).size,
                sha256: await sha256File(localPath),
                downloadedAt: nowIso(),
            });
        }

        const manifest = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            policy: job.showcase.assetPolicy,
            providers: [...new Set(assets.map((asset) => asset.provider))],
            assets,
        };
        writeJsonAtomic(job.outputPaths.assetRegistry, manifest);
        return manifest;
    }
}

module.exports = {
    AssetBrokerError,
    ProductionAssetBroker,
    chooseRendition,
    orientationMatches,
};
