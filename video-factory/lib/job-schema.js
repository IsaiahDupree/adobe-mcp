const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nowIso, slugify } = require("./util");

const AUTONOMY_MODES = new Set(["supervised", "guarded", "full"]);

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

function normalizeJobSpec(spec, campaignsDir, defaultArchiveRoot = "/Volumes/My Passport/VideoFactory") {
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
        archive,
        workspace,
        outputPaths: {
            project: path.join(workspace, "premiere", `${projectName}-v001.prproj`),
            qc: path.join(workspace, "qc", "qc-report.json"),
            render: render ? render.output_file : null,
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
