const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso, readJson, run, writeJsonAtomic } = require("./util");

async function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

function parseSrt(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").replace(/\r/g, "").trim().split(/\n\s*\n/)
        .map((block) => {
            const lines = block.split("\n");
            const timing = lines.find((line) => line.includes("-->"));
            return timing ? { timing, text: lines.slice(lines.indexOf(timing) + 1).join(" ").trim() } : null;
        }).filter(Boolean);
}

function detections(text, pattern, keys) {
    const output = [];
    for (const match of text.matchAll(pattern)) {
        output.push(Object.fromEntries(keys.map((key, index) => [key, Number(match[index + 1])])));
    }
    return output;
}

class TechnicalQa {
    constructor(config) {
        this.ffmpegBin = config.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
        this.ffprobeBin = config.FFPROBE_BIN || "ffprobe";
    }

    gate(id, passed, evidence, severity = "critical") {
        return { id, passed: Boolean(passed), severity, evidence };
    }

    async analyzeFilters(renderPath) {
        const [black, freeze, silence, volume] = await Promise.all([
            run(this.ffmpegBin, ["-hide_banner", "-nostats", "-i", renderPath, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"], { timeout: 180000 }),
            run(this.ffmpegBin, ["-hide_banner", "-nostats", "-i", renderPath, "-vf", "freezedetect=n=0.003:d=6", "-an", "-f", "null", "-"], { timeout: 180000 }),
            run(this.ffmpegBin, ["-hide_banner", "-nostats", "-i", renderPath, "-af", "silencedetect=n=-45dB:d=1.5", "-vn", "-f", "null", "-"], { timeout: 180000 }),
            run(this.ffmpegBin, ["-hide_banner", "-nostats", "-i", renderPath, "-af", "volumedetect", "-vn", "-f", "null", "-"], { timeout: 180000 }),
        ]);
        const blackText = black.stderr || "";
        const freezeText = freeze.stderr || "";
        const silenceText = silence.stderr || "";
        const volumeText = volume.stderr || "";
        return {
            blackFrames: detections(blackText, /black_start:([0-9.]+) black_end:([0-9.]+) black_duration:([0-9.]+)/g, ["start", "end", "duration"]),
            freezeStarts: [...freezeText.matchAll(/freeze_start: ([0-9.]+)/g)].map((match) => Number(match[1])),
            silence: detections(silenceText, /silence_start: ([0-9.]+)[\s\S]*?silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/g, ["start", "end", "duration"]),
            meanVolumeDb: Number((volumeText.match(/mean_volume: (-?[0-9.]+) dB/) || [])[1]),
            maxVolumeDb: Number((volumeText.match(/max_volume: (-?[0-9.]+) dB/) || [])[1]),
        };
    }

    async verifyAssets(job) {
        if (!fs.existsSync(job.outputPaths.assetRegistry)) {
            return { present: false, valid: !job.showcase?.assetRequests?.length, assets: [] };
        }
        const registry = readJson(job.outputPaths.assetRegistry);
        const assets = [];
        for (const asset of registry.assets || []) {
            const exists = fs.existsSync(asset.localPath);
            const checksum = exists ? await sha256(asset.localPath) : null;
            assets.push({
                id: asset.id,
                provider: asset.provider,
                exists,
                checksumMatches: checksum === asset.sha256,
                hasLicense: Boolean(asset.license && asset.licenseUrl && asset.pageUrl),
            });
        }
        return {
            present: true,
            valid: assets.length === (registry.assets || []).length &&
                assets.every((asset) => asset.exists && asset.checksumMatches && asset.hasLicense),
            providers: registry.providers,
            assets,
        };
    }

    async run(job, board, brief, outputPath) {
        const renderPath = job.result?.render?.outputFile;
        if (!renderPath || !fs.existsSync(renderPath)) throw new Error("Technical QA requires a completed render.");
        const { stdout } = await run(this.ffprobeBin, [
            "-v", "error", "-show_entries",
            "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,r_frame_rate",
            "-of", "json", renderPath,
        ], { timeout: 30000 });
        const probe = JSON.parse(stdout);
        const duration = Number(probe.format?.duration || 0);
        const video = probe.streams?.find((stream) => stream.codec_type === "video");
        const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
        const filters = await this.analyzeFilters(renderPath);
        const captions = parseSrt(job.outputPaths.combinedCaptions);
        const captionReceipt = job.checkpoints?.["retention-edit"]?.result?.nativeCaptionTrack;
        const assets = await this.verifyAssets(job);
        const expectedAspect = job.generation.aspectRatio;
        const aspectPass = expectedAspect === "9:16" ? video?.height > video?.width : video?.width >= video?.height;
        const transcript = captions.map((cue) => cue.text).join(" ").toLowerCase();
        const ctaWords = String(brief.cta.text || "").toLowerCase().split(/\s+/).filter(Boolean).slice(-5);
        const ctaPass = ctaWords.length === 0 || ctaWords.filter((word) => transcript.includes(word)).length >= Math.min(3, ctaWords.length);
        const claimsPass = !board.release.requireClaims || board.claimsAndSources.length === 0 ||
            board.claimsAndSources.every((claim) => claim.claim && claim.source);
        const gates = [
            this.gate("decodable_export", Boolean(video && duration > 0), { duration, format: probe.format?.format_name }),
            this.gate("aspect_ratio", aspectPass, { expected: expectedAspect, width: video?.width, height: video?.height }),
            this.gate("audio_stream", Boolean(audio), { codec: audio?.codec_name || null }),
            this.gate("black_frames", filters.blackFrames.length === 0, filters.blackFrames),
            this.gate("accidental_freeze", filters.freezeStarts.length === 0, filters.freezeStarts),
            this.gate("audio_clipping", Number.isFinite(filters.maxVolumeDb) && filters.maxVolumeDb < 0, { maxVolumeDb: filters.maxVolumeDb, meanVolumeDb: filters.meanVolumeDb }),
            this.gate("excessive_silence", filters.silence.every((item) => item.duration < 4), filters.silence),
            this.gate("native_caption_track", !board.release.requireCaptions || Boolean(captionReceipt?.success), captionReceipt || null),
            this.gate("caption_timing", !board.release.requireCaptions || captions.length > 0, { cues: captions.length }),
            this.gate("caption_safe_zone", !board.release.requireCaptions || Boolean(captionReceipt?.success), { method: "Premiere native caption track with editor-safe default placement" }),
            this.gate("asset_provenance", assets.valid, assets),
            this.gate("claim_sources", claimsPass, board.claimsAndSources),
            this.gate("cta_present", ctaPass, { requiredWords: ctaWords }),
        ];
        const report = {
            schemaVersion: 1,
            jobId: job.id,
            checkedAt: nowIso(),
            renderPath,
            passed: gates.every((gate) => gate.passed || gate.severity !== "critical"),
            gates,
            probe,
            filters,
            captionCueCount: captions.length,
            assetVerification: assets,
        };
        writeJsonAtomic(outputPath, report);
        return report;
    }
}

module.exports = { TechnicalQa, parseSrt };
