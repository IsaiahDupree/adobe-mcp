const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nowIso, slugify } = require("./util");

const AUTONOMY_MODES = new Set(["supervised", "guarded", "full"]);
const HEYGEN_ENGINES = new Set(["avatar_iii", "avatar_iv", "avatar_v"]);
const ASPECT_RATIOS = new Set(["16:9", "9:16", "4:5", "5:4", "1:1", "auto"]);

function normalizeAsset(asset, index) {
    const input = typeof asset === "string" ? { path: asset } : { ...asset };
    if (!input.path || !path.isAbsolute(input.path)) {
        throw new Error(`Asset ${index + 1} requires an absolute path.`);
    }
    return {
        id: input.id || `asset-${String(index + 1).padStart(3, "0")}`,
        path: path.normalize(input.path),
        role: input.role || "source",
        order: Number.isFinite(input.order) ? input.order : index,
    };
}

function collectAssets(spec) {
    const productionAssets = spec.production && spec.production.source_assets;
    const requestAssets = spec.request && spec.request.source_assets;
    const timeline = spec.production && spec.production.edit_plan
        ? spec.production.edit_plan.timeline
        : undefined;
    const raw = productionAssets || requestAssets || timeline || [];
    return raw
        .map((asset, index) => normalizeAsset(asset.asset_path ? { ...asset, path: asset.asset_path } : asset, index))
        .sort((a, b) => a.order - b.order);
}

function normalizeArchive(spec, defaultArchiveRoot) {
    const input = spec.archive || (spec.production && spec.production.archive);
    if (!input) {
        return {
            enabled: false,
            mode: "copy",
            destinationRoot: defaultArchiveRoot,
            includeSourceAssets: false,
        };
    }
    const mode = input.mode || "copy";
    if (!["copy", "move"].includes(mode)) {
        throw new Error("archive.mode must be copy or move.");
    }
    const destinationRoot = path.normalize(
        input.destination_root || input.destinationRoot || defaultArchiveRoot
    );
    if (!path.isAbsolute(destinationRoot)) {
        throw new Error("archive.destination_root must be absolute.");
    }
    return {
        enabled: input.enabled !== false,
        mode,
        destinationRoot,
        includeSourceAssets: Boolean(
            input.include_source_assets || input.includeSourceAssets
        ),
    };
}

function normalizeGeneration(spec, defaults = {}) {
    const input = spec.generation || (spec.production && spec.production.generation);
    if (!input || input.enabled === false) return { enabled: false };
    const provider = input.provider || "heygen";
    if (provider !== "heygen") throw new Error("generation.provider must be heygen.");
    const engine = input.engine || "avatar_iv";
    if (!HEYGEN_ENGINES.has(engine)) {
        throw new Error(`generation.engine must be one of: ${Array.from(HEYGEN_ENGINES).join(", ")}.`);
    }
    const aspectRatio = input.aspect_ratio || input.aspectRatio || "9:16";
    if (!ASPECT_RATIOS.has(aspectRatio)) {
        throw new Error(`generation.aspect_ratio must be one of: ${Array.from(ASPECT_RATIOS).join(", ")}.`);
    }
    const rawScenes = input.scenes || (input.script ? [{ script: input.script }] : []);
    if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
        throw new Error("generation.scenes requires at least one scripted scene.");
    }
    const scenes = rawScenes.map((scene, index) => {
        const item = typeof scene === "string" ? { script: scene } : { ...scene };
        if (!item.script || !item.script.trim()) {
            throw new Error(`generation.scenes[${index}].script is required.`);
        }
        return {
            id: slugify(item.id || `scene-${String(index + 1).padStart(3, "0")}`),
            script: item.script.trim(),
            title: item.title || null,
        };
    });
    const avatarId = input.avatar_id || input.avatarId || defaults.avatarId;
    const voiceId = input.voice_id || input.voiceId || defaults.voiceId;
    if (!avatarId) throw new Error("generation.avatar_id is required.");
    if (!voiceId) throw new Error("generation.voice_id is required.");
    return {
        enabled: true,
        provider,
        avatarId,
        voiceId,
        engine,
        aspectRatio,
        resolution: input.resolution || "720p",
        background: input.background || { type: "color", value: "#111111" },
        voiceSettings: input.voice_settings || input.voiceSettings || { speed: 1.04, locale: "en-US" },
        scenes,
        pollIntervalMs: Number(input.poll_interval_ms || input.pollIntervalMs || 8000),
        timeoutMs: Number(input.timeout_ms || input.timeoutMs || 20 * 60 * 1000),
    };
}

function normalizeRetention(spec) {
    const input = spec.retention || (spec.production && spec.production.retention) || {};
    return {
        enabled: input.enabled !== false,
        hookText: input.hook_text || input.hookText || null,
        patternInterruptText:
            input.pattern_interrupt_text || input.patternInterruptText || "THE FIX",
        captionStyle: input.caption_style || input.captionStyle || "bold-safe",
        punchInScale: Number(input.punch_in_scale || input.punchInScale || 1.08),
    };
}

function normalizeJobSpec(
    spec,
    campaignsDir,
    defaultArchiveRoot = "/Volumes/My Passport/VideoFactory",
    defaults = {}
) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("Video job must be a JSON object.");
    }

    const request = { ...(spec.request || {}) };
    const topic = request.topic || spec.topic || spec.title;
    if (!topic) {
        throw new Error("Video job requires request.topic.");
    }

    const campaignId = slugify(spec.campaign_id || "default-campaign", "default-campaign");
    const jobId = spec.job_id || `${campaignId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const projectName = slugify(
        (spec.production && spec.production.project_name) || topic,
        jobId
    );
    const workspace = path.join(campaignsDir, campaignId, jobId);
    const production = { ...(spec.production || {}) };
    const autonomy = { ...(spec.autonomy || {}) };
    const mode = autonomy.mode || "guarded";

    if (!AUTONOMY_MODES.has(mode)) {
        throw new Error(`autonomy.mode must be one of: ${Array.from(AUTONOMY_MODES).join(", ")}.`);
    }

    const scheduledFor =
        (spec.schedule && spec.schedule.production_start) ||
        spec.scheduled_for ||
        nowIso();
    if (Number.isNaN(Date.parse(scheduledFor))) {
        throw new Error("schedule.production_start must be a valid ISO date.");
    }

    const sourceAssets = collectAssets(spec);
    const archive = normalizeArchive(spec, defaultArchiveRoot);
    const generation = normalizeGeneration(spec, defaults);
    const retention = normalizeRetention(spec, defaults);
    const render = production.render
        ? {
              ...production.render,
              output_file:
                  production.render.output_file ||
                  path.join(workspace, "renders", `${projectName}.mp4`),
              export_type: production.render.export_type || "IMMEDIATELY",
          }
        : null;

    if (production.existing_project_path && !path.isAbsolute(production.existing_project_path)) {
        throw new Error("production.existing_project_path must be absolute.");
    }
    if (production.sequence_preset_path && !path.isAbsolute(production.sequence_preset_path)) {
        throw new Error("production.sequence_preset_path must be absolute.");
    }
    if (render && render.preset_file && !path.isAbsolute(render.preset_file)) {
        throw new Error("production.render.preset_file must be absolute.");
    }

    return {
        schemaVersion: 1,
        id: jobId,
        campaignId,
        priority: Math.max(0, Math.min(100, Number(spec.priority || 50))),
        scheduledFor: new Date(scheduledFor).toISOString(),
        request: { ...request, topic },
        autonomy: {
            mode,
            script_approval: autonomy.script_approval || "automatic",
            rough_cut_approval:
                autonomy.rough_cut_approval ||
                (mode === "supervised" ? "required" : "automatic_if_qc_passes"),
            final_publish_approval:
                autonomy.final_publish_approval || (mode === "full" ? "automatic" : "required"),
        },
        production: {
            projectName,
            sequenceName: production.sequence_name || "MASTER",
            sequencePresetPath: production.sequence_preset_path || null,
            existingProjectPath: production.existing_project_path
                ? path.normalize(production.existing_project_path)
                : null,
            sourceAssets,
            editPlan: production.edit_plan || null,
            render,
        },
        generation,
        retention,
        archive,
        workspace,
        outputPaths: {
            project: path.join(workspace, "premiere", `${projectName}-v001.prproj`),
            qc: path.join(workspace, "qc", "qc-report.json"),
            render: render ? render.output_file : null,
            generationManifest: path.join(workspace, "generated-assets", "heygen", "generation-manifest.json"),
            combinedCaptions: path.join(workspace, "transcripts", "combined-captions.srt"),
            editManifest: path.join(workspace, "edit-plans", "retention-edit-manifest.json"),
        },
    };
}

function validateAssets(job) {
    const missing = job.production.sourceAssets
        .filter((asset) => !fs.existsSync(asset.path))
        .map((asset) => asset.path);
    return { valid: missing.length === 0, missing };
}

module.exports = { normalizeJobSpec, validateAssets };
