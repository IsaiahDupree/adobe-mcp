#!/usr/bin/env node
/**
 * Build three local marketing-department Premiere edits from the Vast MultiTalk
 * comparison outputs. This runner does not call FFmpeg, provider write APIs, or
 * social publishing APIs. Editing/export is performed through Premiere's local
 * CEP bridge.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("../lib/config");
const { CepAdapter } = require("../lib/cep-adapter");
const { MarketingDepartmentRepresentative } = require("../lib/marketing-review-judge");
const { ensureDir, nowIso, run, sleep, writeJsonAtomic } = require("../lib/util");

const TICKS_PER_SECOND = 254016000000;
const TARGET = {
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 30,
    aspectRatio: "9:16",
};

const FOUNDRY_ROOT = "/Users/isaiahdupree/Documents/Software/marketing-video-foundry";
const BENCHMARK_ROOT = path.join(
    FOUNDRY_ROOT,
    "work/cloud-benchmarks/multitalk-30s-dots-3090-4090-5090-20260810T041829Z"
);
const SOURCE_ASSETS = [
    {
        asset_id: "vast-multitalk-rtx-3090-30s",
        label: "RTX 3090 exact 30s",
        gpu: "rtx-3090",
        path: path.join(
            BENCHMARK_ROOT,
            "rtx-3090/final/multitalk-int8-vast-rtx-3090-24gb-30s-exact.mp4"
        ),
        render_seconds: 8285,
        estimated_direct_gpu_cost_usd: 0.4308,
    },
    {
        asset_id: "vast-multitalk-rtx-4090-30s",
        label: "RTX 4090 exact 30s",
        gpu: "rtx-4090",
        path: path.join(
            BENCHMARK_ROOT,
            "rtx-4090/final/multitalk-int8-vast-rtx-4090-24gb-30s-exact.mp4"
        ),
        render_seconds: 3935,
        estimated_direct_gpu_cost_usd: 0.5987,
    },
    {
        asset_id: "vast-multitalk-rtx-5090d-30s",
        label: "RTX 5090D exact 30s",
        gpu: "rtx-5090d",
        path: path.join(
            BENCHMARK_ROOT,
            "rtx-5090d/final/multitalk-int8-vast-rtx-5090-32gb-30s-exact.mp4"
        ),
        render_seconds: 2976,
        estimated_direct_gpu_cost_usd: 0.7372,
    },
];

const STYLE_REQUESTS = [
    {
        style_id: "clean-authority-proof",
        style_name: "Clean Authority Proof",
        primary_asset_id: "vast-multitalk-rtx-3090-30s",
        platform: "linkedin",
        platform_name: "LinkedIn vertical post",
        campaign_objective: {
            objective: "Turn the 3090 baseline into a credible cost-control proof point.",
            audience: "software founders comparing AI video production cost and speed",
            cta: "Comment BENCHMARK for the GPU comparison sheet.",
            primary_metric: "qualified_comments",
        },
        caption_style: "clean-receipt-lower-third",
        narrative_style: "baseline-first proof with restrained executive pacing",
        visual_treatment: "white lower-third receipt captions, steady punch-in, comparison B-roll",
        base_scale_percent: 142,
        intro_scale_multiplier: 1.03,
        outro_scale_multiplier: 1.01,
        dialogue_gain_db: 1.5,
        sfx_profile: "soft-ui",
        captions: [
            "Fastest is not always cheapest",
            "3090 proves the baseline",
            "Premiere turns tests into content",
            "Every cut keeps a receipt",
            "Use the winner when the metric fits",
            "Comment BENCHMARK for the sheet",
        ],
    },
    {
        style_id: "rapid-explainer-cuts",
        style_name: "Rapid Explainer Cuts",
        primary_asset_id: "vast-multitalk-rtx-4090-30s",
        platform: "instagram_reels",
        platform_name: "Instagram Reels",
        campaign_objective: {
            objective: "Make the 4090 result feel like the practical speed lane for marketing ops.",
            audience: "creator operators and agency owners scaling short-form production",
            cta: "DM EDITS for the Premiere proof stack.",
            primary_metric: "profile_dms",
        },
        caption_style: "bold-kinetic-keyword",
        narrative_style: "fast explain, reset attention every few seconds",
        visual_treatment: "large kinetic captions, frequent B-roll swaps, brighter impact hits",
        base_scale_percent: 156,
        intro_scale_multiplier: 1.08,
        outro_scale_multiplier: 1.03,
        dialogue_gain_db: 2.0,
        sfx_profile: "kinetic",
        captions: [
            "4090 cuts wait time hard",
            "Show the result first",
            "B-roll resets attention",
            "Cost and speed both matter",
            "Turn benchmarks into buying clarity",
            "DM EDITS for the proof stack",
        ],
    },
    {
        style_id: "kinetic-proof-stack",
        style_name: "Kinetic Proof Stack",
        primary_asset_id: "vast-multitalk-rtx-5090d-30s",
        platform: "youtube_shorts",
        platform_name: "YouTube Shorts",
        campaign_objective: {
            objective: "Frame the 5090D result as the premium speed lane with transparent cost evidence.",
            audience: "technical buyers evaluating rented GPU video generation",
            cta: "Comment RENDER for the cost and speed breakdown.",
            primary_metric: "comment_to_lead",
        },
        caption_style: "metric-pop-proof",
        narrative_style: "proof-stack countdown with explicit cost-speed tradeoffs",
        visual_treatment: "metric badges, fast proof cards, punchy comparison cutaways",
        base_scale_percent: 168,
        intro_scale_multiplier: 1.1,
        outro_scale_multiplier: 1.04,
        dialogue_gain_db: 2.5,
        sfx_profile: "premium-proof",
        captions: [
            "5090D is the speed lane",
            "Fast render, higher direct cost",
            "Proof beats opinion",
            "Premiere packages the evidence",
            "Trace every edit to analytics",
            "Comment RENDER for the breakdown",
        ],
    },
];

function timestampSlug() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ticks(seconds) {
    return String(Math.round(Number(seconds) * TICKS_PER_SECOND));
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function statFile(filePath) {
    const stat = fs.statSync(filePath);
    return {
        path: filePath,
        bytes: stat.size,
        sha256: sha256File(filePath),
        modified_at: stat.mtime.toISOString(),
    };
}

function assertLocalInputs() {
    const missing = [];
    for (const asset of SOURCE_ASSETS) {
        if (!fs.existsSync(asset.path)) missing.push(asset.path);
    }
    if (!fs.existsSync(config.PREMIERE_VERTICAL_SEQUENCE_PRESET)) {
        missing.push(config.PREMIERE_VERTICAL_SEQUENCE_PRESET);
    }
    const exportPreset = exportPresetPath();
    if (!fs.existsSync(exportPreset)) missing.push(exportPreset);
    if (!fs.existsSync(config.IMAGEMAGICK_BIN)) missing.push(config.IMAGEMAGICK_BIN);
    if (missing.length) {
        throw new Error(`Required local inputs are missing:\n${missing.join("\n")}`);
    }
}

function exportPresetPath() {
    const preferred = "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/01 - Match Source - High bitrate.epr";
    return fs.existsSync(preferred) ? preferred : config.PREMIERE_H264_PRESET;
}

function assetById(assetId) {
    const asset = SOURCE_ASSETS.find((item) => item.asset_id === assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    return asset;
}

function rightsRow(asset, role) {
    return {
        asset_id: asset.asset_id,
        role,
        source_type: "ai_generated_local_benchmark",
        rights_basis: "generated_with_commercial_rights",
        rights_confirmed: true,
        usage_role: "direct_use",
        will_import: true,
        eligible_for_import: true,
        provenance: {
            source_type: "generated",
            rights_basis: "generated",
            rights_confirmed: true,
            usage_role: "direct_use",
            generator: "vast-multitalk-int8",
            gpu: asset.gpu,
            source_path: asset.path,
        },
    };
}

function captionWindows() {
    return [
        [0.25, 3.0],
        [3.25, 6.0],
        [6.75, 9.8],
        [10.25, 13.8],
        [17.25, 20.4],
        [24.0, 29.0],
    ];
}

async function renderStyledCaptions({ workspace, request }) {
    const captionDir = ensureDir(path.join(workspace, "generated-assets", "captions"));
    const windows = captionWindows();
    const assets = [];
    for (let index = 0; index < request.captions.length; index += 1) {
        const text = request.captions[index];
        const [start, end] = windows[index];
        const output = path.join(
            captionDir,
            `${request.caption_style}-${String(index + 1).padStart(3, "0")}.png`
        );
        await renderOneCaption({
            output,
            text,
            style: request.caption_style,
            index,
        });
        assets.push({
            id: `${request.style_id}-caption-${String(index + 1).padStart(2, "0")}`,
            text,
            start,
            end,
            path: output,
            trackIndex: 2,
            purpose: request.caption_style,
            animation: {
                type: request.caption_style,
                introSeconds: request.caption_style === "bold-kinetic-keyword" ? 0.22 : 0.35,
                outroSeconds: 0.35,
            },
            geometry: {
                dimensions: { width: TARGET.width, height: TARGET.height },
                panel: captionPanelGeometry(request.caption_style),
            },
        });
    }
    return assets;
}

function captionPanelGeometry(style) {
    if (style === "metric-pop-proof") {
        return { left: 88, top: 180, width: 904, height: 260 };
    }
    if (style === "bold-kinetic-keyword") {
        return { left: 70, top: 1210, width: 940, height: 360 };
    }
    return { left: 78, top: 1320, width: 924, height: 280 };
}

async function renderOneCaption({ output, text, style, index }) {
    const tmp = path.join(path.dirname(output), `.caption-text-${process.pid}-${index}.png`);
    const panel = captionPanelGeometry(style);
    const pointSize = style === "bold-kinetic-keyword" ? 86 : style === "metric-pop-proof" ? 68 : 58;
    const fill = style === "bold-kinetic-keyword" && index % 2 === 0
        ? "#F7D64A"
        : style === "metric-pop-proof"
            ? "#DFFBFF"
            : "#FFFFFF";
    const stroke = style === "clean-receipt-lower-third" ? "#0D1117" : "#050505";
    const font = style === "clean-receipt-lower-third" ? config.CAPTION_FONT : config.HEADLINE_FONT;
    await run(
        config.IMAGEMAGICK_BIN,
        [
            "-background", "none",
            "-fill", fill,
            "-stroke", stroke,
            "-strokewidth", style === "clean-receipt-lower-third" ? "2" : "4",
            "-font", font,
            "-pointsize", String(pointSize),
            "-interline-spacing", "4",
            "-gravity", "center",
            "-size", `${panel.width - 110}x${panel.height - 90}`,
            `caption:${text.toUpperCase()}`,
            "-trim",
            "+repage",
            tmp,
        ],
        { timeout: 30000 }
    );

    const drawCommands = [];
    if (style === "clean-receipt-lower-third") {
        drawCommands.push(`fill '#07111FCC' roundrectangle ${panel.left},${panel.top} ${panel.left + panel.width},${panel.top + panel.height} 28,28`);
        drawCommands.push(`fill '#37E6A6' rectangle ${panel.left},${panel.top} ${panel.left + 14},${panel.top + panel.height}`);
    } else if (style === "bold-kinetic-keyword") {
        drawCommands.push(`fill '#050505B8' roundrectangle ${panel.left},${panel.top} ${panel.left + panel.width},${panel.top + panel.height} 40,40`);
        drawCommands.push(`fill '#F7D64A' rectangle ${panel.left + 36},${panel.top + 34} ${panel.left + panel.width - 36},${panel.top + 44}`);
    } else {
        drawCommands.push(`fill '#0A0B0ECC' roundrectangle ${panel.left},${panel.top} ${panel.left + panel.width},${panel.top + panel.height} 36,36`);
        drawCommands.push(`fill '#3EF2FF' roundrectangle ${panel.left + 36},${panel.top + 28} ${panel.left + 212},${panel.top + 82} 16,16`);
    }

    const textX = panel.left + Math.round(panel.width / 2);
    const textY = panel.top + Math.round(panel.height / 2) + (style === "metric-pop-proof" ? 28 : 8);
    await run(
        config.IMAGEMAGICK_BIN,
        [
            "-size", `${TARGET.width}x${TARGET.height}`,
            "xc:none",
            "-draw", drawCommands.join(" "),
            tmp,
            "-gravity", "center",
            "-geometry", `+${textX - Math.round(TARGET.width / 2)}+${textY - Math.round(TARGET.height / 2)}`,
            "-composite",
            output,
        ],
        { timeout: 30000 }
    );
    fs.unlinkSync(tmp);
}

function writeWavSfx(filePath, { durationSeconds, sampleRate = 48000, startHz, endHz, gain = 0.25 }) {
    ensureDir(path.dirname(filePath));
    const samples = Math.max(1, Math.floor(durationSeconds * sampleRate));
    const dataBytes = samples * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataBytes, 40);

    let phase = 0;
    for (let i = 0; i < samples; i += 1) {
        const t = i / Math.max(1, samples - 1);
        const freq = startHz + (endHz - startHz) * t;
        phase += (2 * Math.PI * freq) / sampleRate;
        const attack = Math.min(1, t / 0.12);
        const release = Math.min(1, (1 - t) / 0.18);
        const envelope = Math.max(0, Math.min(attack, release));
        const sample = Math.round(Math.sin(phase) * envelope * gain * 32767);
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    fs.writeFileSync(filePath, buffer);
}

function generateSfxAssets({ workspace, request }) {
    const dir = ensureDir(path.join(workspace, "generated-assets", "sfx"));
    const profiles = {
        "soft-ui": [
            { id: "soft-open", durationSeconds: 0.28, startHz: 360, endHz: 620, gain: 0.16 },
            { id: "soft-confirm", durationSeconds: 0.22, startHz: 520, endHz: 760, gain: 0.14 },
            { id: "soft-close", durationSeconds: 0.28, startHz: 620, endHz: 340, gain: 0.12 },
        ],
        kinetic: [
            { id: "kinetic-rise", durationSeconds: 0.32, startHz: 220, endHz: 980, gain: 0.2 },
            { id: "kinetic-hit", durationSeconds: 0.18, startHz: 120, endHz: 80, gain: 0.25 },
            { id: "kinetic-snap", durationSeconds: 0.2, startHz: 850, endHz: 420, gain: 0.18 },
        ],
        "premium-proof": [
            { id: "proof-glint", durationSeconds: 0.3, startHz: 720, endHz: 1280, gain: 0.17 },
            { id: "proof-hit", durationSeconds: 0.2, startHz: 150, endHz: 95, gain: 0.23 },
            { id: "proof-lift", durationSeconds: 0.34, startHz: 420, endHz: 1040, gain: 0.18 },
        ],
    };
    const selected = profiles[request.sfx_profile] || profiles["soft-ui"];
    return selected.map((spec) => {
        const filePath = path.join(dir, `${request.style_id}-${spec.id}.wav`);
        writeWavSfx(filePath, spec);
        return {
            id: `${request.style_id}-${spec.id}`,
            path: filePath,
            generated: true,
            rights_basis: "generated_with_commercial_rights",
        };
    });
}

function brollPlan(primaryAsset) {
    const alternates = SOURCE_ASSETS.filter((asset) => asset.asset_id !== primaryAsset.asset_id);
    const starts = [3.0, 6.5, 10.0, 13.5, 17.0, 20.5, 24.0];
    return starts.map((start, index) => {
        const asset = alternates[index % alternates.length];
        return {
            id: `${primaryAsset.gpu}-cutaway-${index + 1}-${asset.gpu}`,
            asset_id: asset.asset_id,
            path: asset.path,
            start,
            end: Math.min(TARGET.durationSeconds - 0.25, start + 2.0),
            sourceStart: (index % 3) * 4,
            trackIndex: 1,
            scale: 112 + (index % 2) * 8,
            role: "b_roll_cutaway",
        };
    });
}

function sfxPlacements(sfxAssets, request) {
    const starts = request.caption_style === "clean-receipt-lower-third"
        ? [0.25, 6.5, 13.5, 24.0]
        : [0.2, 3.0, 6.5, 10.0, 13.5, 17.0, 20.5, 24.0];
    return starts.map((start, index) => {
        const asset = sfxAssets[index % sfxAssets.length];
        return {
            id: `${asset.id}-${index + 1}`,
            path: asset.path,
            start,
            end: start + (request.caption_style === "bold-kinetic-keyword" ? 0.24 : 0.32),
            trackIndex: 1,
            gainDb: request.caption_style === "clean-receipt-lower-third" ? -18 : -15,
        };
    });
}

function retentionPlan({ request, primaryAsset }) {
    return {
        schemaVersion: 1,
        styleProfile: {
            style_id: request.style_id,
            style_name: request.style_name,
            caption_style: request.caption_style,
            visual_treatment: request.visual_treatment,
            narrative_style: request.narrative_style,
        },
        campaignObjective: request.campaign_objective,
        platformFormat: {
            platform: request.platform,
            platform_name: request.platform_name,
            aspect_ratio: TARGET.aspectRatio,
            width: TARGET.width,
            height: TARGET.height,
            fps: TARGET.fps,
            target_duration_seconds: TARGET.durationSeconds,
        },
        frame: { width: TARGET.width, height: TARGET.height },
        bRollRules: {
            cadence_seconds: "3-5",
            placement_strategy: "alternate other GPU outputs as proof cutaways",
            cutaway_duration_seconds: 2,
        },
        audioMix: {
            voice_gain_db: request.dialogue_gain_db,
            broll_audio_policy: "mute_overlay_video_audio",
            sfx_policy: "short generated local transition accents",
            loudness_target: "speech-forward short-form mix",
        },
        scenes: [
            {
                sceneId: `${primaryAsset.gpu}-full-arc`,
                start: 0,
                end: TARGET.durationSeconds,
                punchIn: {
                    start: 0.35,
                    end: 2.4,
                    scale: request.base_scale_percent,
                },
                cutRules: {
                    jumpCutPauses: true,
                    removeSilence: false,
                    reason: "single generated clip retained; narrative resets happen through B-roll and captions",
                },
            },
        ],
    };
}

function shortFormPlan(request) {
    return {
        target: { width: TARGET.width, height: TARGET.height },
        transform: {
            scalePercent: request.base_scale_percent,
            position: { x: TARGET.width / 2, y: TARGET.height / 2 },
        },
        motion: {
            introScaleMultiplier: request.intro_scale_multiplier,
            outroScaleMultiplier: request.outro_scale_multiplier,
            introSeconds: 0.7,
        },
        editing: { dialogueGainDb: request.dialogue_gain_db },
        sourceRange: { start: 0, end: TARGET.durationSeconds, duration: TARGET.durationSeconds },
        styleId: request.style_id,
    };
}

function commandOperation(index, action, options, metadata = {}) {
    return {
        index,
        operation_id: `${String(index + 1).padStart(3, "0")}-${action}`,
        action,
        command_packet: {
            action,
            options,
        },
        metadata,
    };
}

function buildPacket({
    request,
    primaryAsset,
    broll,
    captionAssets,
    sfx,
    projectPath,
    sequenceName,
    exportPath,
    qcFrames,
}) {
    const importedAssets = [primaryAsset, ...broll.map((item) => assetById(item.asset_id))];
    const sourceAssets = importedAssets.map((asset, index) => ({
        asset_id: asset.asset_id,
        path: asset.path,
        label: asset.label,
        source_type: "ai_generated_local_benchmark",
        usage_role: index === 0 ? "primary_footage" : "b_roll",
        rights_basis: "generated_with_commercial_rights",
        rights_confirmed: true,
        will_import: true,
        provenance: rightsRow(asset, index === 0 ? "primary_footage" : "b_roll").provenance,
    }));
    const plan = retentionPlan({ request, primaryAsset });
    const operations = [];
    operations.push(commandOperation(operations.length, "createProject", { projectPath }, { role: "project" }));
    operations.push(commandOperation(operations.length, "importMedia", {
        filePaths: [
            primaryAsset.path,
            ...broll.map((item) => item.path),
            ...captionAssets.map((item) => item.path),
            ...sfx.map((item) => item.path),
        ],
    }, { role: "asset_ingest" }));
    operations.push(commandOperation(operations.length, "createSequenceWithPresetPath", {
        sequenceName,
        presetPath: config.PREMIERE_VERTICAL_SEQUENCE_PRESET,
    }, { role: "timeline" }));
    operations.push(commandOperation(operations.length, "addMediaToSequence", {
        filePath: primaryAsset.path,
        insertionTimeTicks: "0",
        videoTrackIndex: 0,
        audioTrackIndex: 0,
        durationSeconds: TARGET.durationSeconds,
    }, { role: "primary_footage" }));
    for (const item of broll) {
        operations.push(commandOperation(operations.length, "addMediaToSequence", {
            filePath: item.path,
            insertionTimeTicks: ticks(item.start),
            startTimeSeconds: item.start,
            sourceStartSeconds: item.sourceStart,
            durationSeconds: Number((item.end - item.start).toFixed(3)),
            videoTrackIndex: item.trackIndex,
            audioTrackIndex: 1,
            trackIndex: item.trackIndex,
        }, { role: "b_roll_cutaway", asset_id: item.asset_id }));
    }
    for (const item of captionAssets) {
        operations.push(commandOperation(operations.length, "addCaptionGraphic", {
            filePath: item.path,
            startTimeSeconds: item.start,
            durationSeconds: Number((item.end - item.start).toFixed(3)),
            videoTrackIndex: item.trackIndex,
            text: item.text,
        }, { role: "caption_overlay", caption_style: request.caption_style }));
    }
    operations.push(commandOperation(operations.length, "applyRetentionPlan", {
        sequenceName,
        plan,
        captionAssets,
        showcaseAssets: { enabled: true, graphics: [], videos: broll, audio: sfxPlacements(sfx, request) },
        dialogueGainDb: request.dialogue_gain_db,
    }, { role: "style_compile" }));
    operations.push(commandOperation(operations.length, "applyShortFormPlan", {
        sequenceName,
        shortForm: shortFormPlan(request),
    }, { role: "vertical_framing" }));
    operations.push(commandOperation(operations.length, "setAudioMix", {
        voiceGainDb: request.dialogue_gain_db,
        brollAudio: "muted",
        sfxGainDb: request.caption_style === "clean-receipt-lower-third" ? -18 : -15,
    }, { role: "audio_design" }));
    for (const frame of qcFrames) {
        operations.push(commandOperation(operations.length, "exportFrame", {
            sequenceName,
            seconds: frame.seconds,
            filePath: frame.path,
        }, { role: "qc_frame" }));
    }
    operations.push(commandOperation(operations.length, "exportSequence", {
        sequenceName,
        outputFile: exportPath,
        presetFile: exportPresetPath(),
    }, { role: "export" }));
    operations.push(commandOperation(operations.length, "saveProject", { projectPath }, { role: "project" }));

    const ids = {
        edit_plan_id: `edit-plan-${request.style_id}-20260810`,
        job_id: `marketing-request-vast-${request.style_id}`,
        output_id: `premiere-export-${request.style_id}`,
        style_profile_id: request.style_id,
        social_action_id: `social-action-${request.platform}-${request.style_id}`,
        content_project_id: "content-project-vast-gpu-proof",
        experiment_id: "exp-vast-gpu-proof-20260810",
        variant_id: `variant-${request.style_id}`,
    };
    return {
        schemaVersion: 1,
        ...ids,
        requester_department: "marketing",
        request_type: "owned/generated media edit request",
        not_published: true,
        execution_policy: {
            premiere_actions_executed: true,
            bridge: "premiere-pro-cep",
            ffmpeg_used: false,
            provider_write_apis_called: false,
            publish_actions_allowed: false,
            social_publish_actions_called: false,
        },
        campaign_objective: request.campaign_objective,
        platform_format: plan.platformFormat,
        style_profile: plan.styleProfile,
        captions: {
            enabled: true,
            style: request.caption_style,
            cue_count: captionAssets.length,
        },
        cut_rules: {
            jump_cut_pauses: true,
            remove_silence: false,
            broll_cadence_seconds: "3-5",
            broll_duration_seconds: 2,
        },
        audio_mix: plan.audioMix,
        source_assets: sourceAssets,
        rights_summary: sourceAssets.map((asset) =>
            rightsRow(assetById(asset.asset_id), asset.usage_role)
        ),
        premiere_contract: {
            source_assets: sourceAssets,
            style_profile: plan.styleProfile,
            campaign_objective: request.campaign_objective,
            platform_format: plan.platformFormat,
            captions: { enabled: true, style: request.caption_style, assets: captionAssets },
            b_roll_rules: plan.bRollRules,
            cut_rules: { jump_cut_pauses: true, remove_silence: false },
            music_audio_mix_instructions: plan.audioMix,
            export_settings: {
                width: TARGET.width,
                height: TARGET.height,
                fps: TARGET.fps,
                codec: "h264",
                preset_path: exportPresetPath(),
            },
        },
        operations,
        outputs: {
            output_id: ids.output_id,
            export_path: exportPath,
            resolution: { width: TARGET.width, height: TARGET.height },
            duration_seconds: TARGET.durationSeconds,
            qc_frames: qcFrames.map((frame) => frame.path),
        },
    };
}

function editPlanDocument({ request, primaryAsset, broll, captionAssets, sfx, projectPath, exportPath }) {
    return {
        schemaVersion: 1,
        requester_department: "marketing",
        request_received_at: nowIso(),
        edit_plan_id: `edit-plan-${request.style_id}-20260810`,
        source_assets: [
            {
                asset_id: primaryAsset.asset_id,
                path: primaryAsset.path,
                role: "primary_footage",
                provenance: rightsRow(primaryAsset, "primary_footage").provenance,
            },
            ...broll.map((item) => {
                const asset = assetById(item.asset_id);
                return {
                    asset_id: asset.asset_id,
                    path: asset.path,
                    role: "b_roll",
                    start: item.start,
                    end: item.end,
                    provenance: rightsRow(asset, "b_roll").provenance,
                };
            }),
        ],
        style_profile: {
            style_id: request.style_id,
            style_name: request.style_name,
            caption_style: request.caption_style,
            visual_treatment: request.visual_treatment,
            narrative_style: request.narrative_style,
            base_scale_percent: request.base_scale_percent,
        },
        campaign_objective: request.campaign_objective,
        platform_format: {
            platform: request.platform,
            width: TARGET.width,
            height: TARGET.height,
            fps: TARGET.fps,
            aspect_ratio: TARGET.aspectRatio,
        },
        captions: {
            enabled: true,
            style: request.caption_style,
            cues: captionAssets.map((asset) => ({
                text: asset.text,
                start: asset.start,
                end: asset.end,
                asset_path: asset.path,
            })),
        },
        b_roll_cut_rules: {
            cadence_seconds: "3-5",
            placements: broll,
        },
        music_audio_mix_instructions: {
            voice_gain_db: request.dialogue_gain_db,
            sfx_assets: sfx,
            sfx_strategy: "generated local transition accents on caption and B-roll beats",
            broll_audio_policy: "mute overlay B-roll audio",
        },
        export_settings: {
            project_path: projectPath,
            output_path: exportPath,
            width: TARGET.width,
            height: TARGET.height,
            fps: TARGET.fps,
            preset_path: exportPresetPath(),
            not_published: true,
        },
    };
}

async function handoffActiveProject(cep, nextProjectPath) {
    const script = `(function(){try{
    var nextProjectPath=${JSON.stringify(nextProjectPath)};
    var before={hasProject:Boolean(app.project),path:app.project?app.project.path:null,name:app.project?app.project.name:null};
    if(app.project&&app.project.path&&app.project.path!==nextProjectPath){
        app.project.save();
        var closed=app.project.closeDocument(1,0);
        return JSON.stringify({success:true,action:"saved-and-closed-previous-project",before:before,closed:closed!==false,nextProjectPath:nextProjectPath});
    }
    return JSON.stringify({success:true,action:"no-project-switch-needed",before:before,nextProjectPath:nextProjectPath});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
    return cep.executeScript(script, 120000);
}

async function waitForCepReady(cep, { timeoutMs = 90000, pollMs = 500 } = {}) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await cep.executeScript(
                `(function(){try{return JSON.stringify({success:true,version:app.version,projectPath:app.project?app.project.path:null});}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`,
                2000
            );
            if (response && response.success === true) {
                return {
                    ready: true,
                    waitedMs: Date.now() - started,
                    response,
                };
            }
            lastError = new Error(JSON.stringify(response));
        } catch (error) {
            lastError = error;
        }
        await sleep(pollMs);
    }
    throw new Error(`Premiere CEP bridge was not ready after ${timeoutMs}ms: ${lastError && (lastError.message || lastError)}`);
}

async function prepareProjectWithRetry(cep, projectPath) {
    await waitForCepReady(cep);
    try {
        return await cep.prepareProject({ outputPath: projectPath });
    } catch (error) {
        if (!String(error && error.message || error).includes("CEP bridge did not respond")) {
            throw error;
        }
        await waitForCepReady(cep, { timeoutMs: 120000, pollMs: 750 });
        return cep.prepareProject({ outputPath: projectPath });
    }
}

async function waitForStableFile(filePath, waitMs = 90000, pollMs = 500, stableMs = 1500) {
    const started = Date.now();
    let lastSize = -1;
    let stableSince = 0;
    while (Date.now() - started < waitMs) {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > 0 && stat.size === lastSize) {
                if (!stableSince) stableSince = Date.now();
                if (Date.now() - stableSince >= stableMs) {
                    return { exists: true, stable: true, bytes: stat.size, waitedMs: Date.now() - started };
                }
            } else {
                lastSize = stat.size;
                stableSince = stat.size > 0 ? Date.now() : 0;
            }
        } catch (_) {
            lastSize = -1;
            stableSince = 0;
        }
        await sleep(pollMs);
    }
    return { exists: fs.existsSync(filePath), stable: false, bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0 };
}

async function runRecorded(runSummary, action, sent_options, fn, options = {}) {
    const startedAt = nowIso();
    const startMs = Date.now();
    try {
        const response = await fn();
        const record = {
            action,
            status: "SUCCESS",
            started_at: startedAt,
            completed_at: nowIso(),
            duration_ms: Date.now() - startMs,
            sent_options,
            response,
        };
        runSummary.executed.push(record);
        runSummary.counts.success += 1;
        return response;
    } catch (error) {
        const status = options.optional ? "SKIPPED_OPTIONAL_FAILURE" : "FAILED";
        const record = {
            action,
            status,
            started_at: startedAt,
            completed_at: nowIso(),
            duration_ms: Date.now() - startMs,
            sent_options,
            error: error.stack || error.message || String(error),
        };
        runSummary.executed.push(record);
        if (options.optional) {
            runSummary.counts.skipped += 1;
            runSummary.warnings.push({ action, error: record.error });
            return null;
        }
        runSummary.counts.failed += 1;
        throw error;
    }
}

async function runOneEdit({ cep, batchDir, siteBatchDir, request }) {
    const primaryAsset = assetById(request.primary_asset_id);
    const slug = request.style_id;
    const workspace = ensureDir(path.join(batchDir, slug));
    const projectPath = path.join(workspace, `${slug}.prproj`);
    const sequenceName = `${slug.toUpperCase().replace(/-/g, "_")}_9X16`;
    const exportPath = path.join(workspace, "exports", `${slug}.mp4`);
    const qcDir = ensureDir(path.join(workspace, "qc"));
    const qcFrameRequests = [0.5, 15.0, 29.0].map((seconds, index) => ({
        seconds,
        path: path.join(qcDir, `${slug}-frame-${String(index + 1).padStart(2, "0")}.png`),
    }));
    const broll = brollPlan(primaryAsset);
    const captionAssets = await renderStyledCaptions({ workspace, request });
    const sfxAssets = generateSfxAssets({ workspace, request });
    const sfx = sfxPlacements(sfxAssets, request);
    const editPlan = editPlanDocument({
        request,
        primaryAsset,
        broll,
        captionAssets,
        sfx: sfxAssets,
        projectPath,
        exportPath,
    });
    const packet = buildPacket({
        request,
        primaryAsset,
        broll,
        captionAssets,
        sfx: sfxAssets,
        projectPath,
        sequenceName,
        exportPath,
        qcFrames: qcFrameRequests,
    });

    const runSummary = {
        schemaVersion: 1,
        status: "RUNNING",
        started_at: nowIso(),
        style_profile_id: request.style_id,
        bridge: "premiere-pro-cep",
        not_published: true,
        ffmpeg_used: false,
        project_handoff: null,
        counts: { success: 0, failed: 0, skipped: 0 },
        warnings: [],
        executed: [],
    };

    const editPlanPath = path.join(workspace, "edit-plan.json");
    const packetPath = path.join(workspace, "premiere-cep-packet.json");
    const runSummaryPath = path.join(workspace, "run-summary.json");
    const receiptPath = path.join(workspace, "receipt.json");
    const reviewPath = path.join(workspace, "marketing-review.json");
    writeJsonAtomic(editPlanPath, editPlan);
    writeJsonAtomic(packetPath, packet);

    try {
        runSummary.project_handoff = await handoffActiveProject(cep, projectPath);
        await runRecorded(runSummary, "createProject", { projectPath }, () =>
            prepareProjectWithRetry(cep, projectPath)
        );
        await runRecorded(runSummary, "importMedia", {
            filePaths: [
                primaryAsset.path,
                ...broll.map((item) => item.path),
                ...captionAssets.map((item) => item.path),
                ...sfxAssets.map((item) => item.path),
            ],
        }, () =>
            cep.importMedia([
                primaryAsset.path,
                ...broll.map((item) => item.path),
                ...captionAssets.map((item) => item.path),
                ...sfxAssets.map((item) => item.path),
            ])
        );
        await runRecorded(runSummary, "createSequenceWithPresetPath", {
            sequenceName,
            presetPath: config.PREMIERE_VERTICAL_SEQUENCE_PRESET,
        }, () =>
            cep.assembleRoughCut({
                sequenceName,
                presetPath: config.PREMIERE_VERTICAL_SEQUENCE_PRESET,
                clips: [{
                    assetPath: primaryAsset.path,
                    sourceStartSeconds: 0,
                    durationSeconds: TARGET.durationSeconds,
                    insertionTimeTicks: "0",
                    videoTrackIndex: 0,
                    audioTrackIndex: 0,
                }],
            })
        );
        await runRecorded(runSummary, "applyRetentionPlan", {
            sequenceName,
            plan: retentionPlan({ request, primaryAsset }),
            captionAssetCount: captionAssets.length,
            brollCount: broll.length,
            sfxCount: sfx.length,
        }, () =>
            cep.applyRetentionPlan({
                sequenceName,
                plan: retentionPlan({ request, primaryAsset }),
                captionAssets,
                showcaseAssets: { enabled: true, graphics: [], videos: broll, audio: sfx },
                dialogueGainDb: request.dialogue_gain_db,
            })
        );
        await runRecorded(runSummary, "applyShortFormPlan", {
            sequenceName,
            shortForm: shortFormPlan(request),
        }, () =>
            cep.applyShortFormPlan({ sequenceName, shortForm: shortFormPlan(request) })
        );
        await runRecorded(runSummary, "inspectProject", { sequenceName }, () =>
            cep.inspectProject({ sequenceName })
        );
        const exportedQcFrames = [];
        for (const frame of qcFrameRequests) {
            const result = await runRecorded(runSummary, "exportFrame", frame, () =>
                cep.exportFrame({ sequenceName, seconds: frame.seconds, filePath: frame.path })
            , { optional: true });
            if (result && fs.existsSync(frame.path)) exportedQcFrames.push(frame.path);
        }
        await runRecorded(runSummary, "exportSequence", {
            sequenceName,
            outputFile: exportPath,
            presetFile: exportPresetPath(),
        }, () =>
            cep.exportSequence({
                sequenceName,
                outputFile: exportPath,
                presetFile: exportPresetPath(),
            })
        );
        const exportStable = await waitForStableFile(exportPath);
        if (!exportStable.exists || exportStable.bytes <= 0) {
            throw new Error(`Premiere export did not produce a non-empty file: ${exportPath}`);
        }
        runSummary.export_file = exportStable;
        await runRecorded(runSummary, "saveProject", { projectPath }, () => cep.saveProject());
        runSummary.status = "COMPLETED";

        const outputStats = statFile(exportPath);
        packet.outputs.bytes = outputStats.bytes;
        packet.outputs.sha256 = outputStats.sha256;
        packet.outputs.qc_frames = exportedQcFrames.length >= 3
            ? exportedQcFrames
            : captionAssets.slice(0, 3).map((asset) => asset.path);
        packet.outputs.qc_evidence_type = exportedQcFrames.length >= 3
            ? "premiere-exported-frames"
            : "caption-overlay-reference-fallback";
        writeJsonAtomic(packetPath, packet);

        const review = new MarketingDepartmentRepresentative().review({
            packet,
            runSummary: { ...runSummary, summaryPath: runSummaryPath },
            outputMeasurement: {
                path: exportPath,
                width: TARGET.width,
                height: TARGET.height,
                durationSeconds: TARGET.durationSeconds,
                sha256: outputStats.sha256,
            },
            qcFrames: packet.outputs.qc_frames,
        });
        writeJsonAtomic(reviewPath, review);

        const receipt = {
            schemaVersion: 1,
            generated_at: nowIso(),
            edit_plan_path: editPlanPath,
            packet_path: packetPath,
            run_summary_path: runSummaryPath,
            marketing_review_path: reviewPath,
            project_path: projectPath,
            output: {
                ...outputStats,
                width: TARGET.width,
                height: TARGET.height,
                duration_seconds: TARGET.durationSeconds,
            },
            qc_frames: packet.outputs.qc_frames,
            qc_evidence_type: packet.outputs.qc_evidence_type,
            not_published: true,
            ffmpeg_used: false,
            provider_write_apis_called: false,
            premiere_bridge: "cep",
            verdict: review.verdict,
            overall_score: review.overallScore,
        };
        writeJsonAtomic(receiptPath, receipt);

        const siteVideoPath = path.join(siteBatchDir, `${slug}.mp4`);
        const siteReceiptPath = path.join(siteBatchDir, `${slug}.receipt.json`);
        const siteReviewPath = path.join(siteBatchDir, `${slug}.marketing-review.json`);
        fs.copyFileSync(exportPath, siteVideoPath);
        fs.copyFileSync(receiptPath, siteReceiptPath);
        fs.copyFileSync(reviewPath, siteReviewPath);

        return {
            request,
            workspace,
            projectPath,
            exportPath,
            siteVideoPath,
            editPlanPath,
            packetPath,
            runSummaryPath,
            receiptPath,
            reviewPath,
            receipt,
            review,
        };
    } catch (error) {
        runSummary.status = "FAILED";
        runSummary.failed_error = error.stack || error.message || String(error);
        throw error;
    } finally {
        runSummary.completed_at = nowIso();
        writeJsonAtomic(runSummaryPath, runSummary);
    }
}

function relativeFrom(filePath, root) {
    return path.relative(root, filePath).split(path.sep).join("/");
}

function htmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function writeSitePages({ siteExamplesDir, siteBatchDir, batchSlug, results, batchManifestPath }) {
    const cards = results.map((result) => {
        const video = path.basename(result.siteVideoPath);
        const receipt = path.basename(result.receiptPath).replace("receipt.json", "receipt.json");
        const siteReceipt = `${result.request.style_id}.receipt.json`;
        const siteReview = `${result.request.style_id}.marketing-review.json`;
        const checks = result.review.checks.filter((check) => !check.pass).length;
        return `<section class="example-card">
  <video controls playsinline preload="metadata" src="./${htmlEscape(video)}"></video>
  <div class="copy">
    <p class="eyebrow">${htmlEscape(result.request.platform_name)} / ${htmlEscape(result.request.caption_style)}</p>
    <h2>${htmlEscape(result.request.style_name)}</h2>
    <p>${htmlEscape(result.request.campaign_objective.objective)}</p>
    <dl>
      <div><dt>Primary CTA</dt><dd>${htmlEscape(result.request.campaign_objective.cta)}</dd></div>
      <div><dt>B-roll cadence</dt><dd>Every 3 to 5 seconds, alternating GPU proof cutaways</dd></div>
      <div><dt>Audio</dt><dd>Dialogue gain, muted B-roll audio, generated local transition SFX</dd></div>
      <div><dt>Review</dt><dd>${htmlEscape(result.review.verdict)} / ${result.review.overallScore}</dd></div>
      <div><dt>Open fixes</dt><dd>${checks}</dd></div>
    </dl>
    <p class="links"><a href="./${htmlEscape(siteReceipt)}">Receipt JSON</a><a href="./${htmlEscape(siteReview)}">Marketing Review JSON</a></p>
  </div>
</section>`;
    }).join("\n");

    const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Premiere Edited Examples - Vast MultiTalk GPU Proof</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #f5f7fb; }
    body { margin: 0; background: #0b0d10; }
    main { max-width: 1180px; margin: 0 auto; padding: 40px 22px 64px; }
    header { display: grid; gap: 12px; margin-bottom: 30px; }
    h1 { font-size: clamp(32px, 5vw, 60px); line-height: 1; margin: 0; letter-spacing: 0; }
    h2 { font-size: 26px; margin: 0 0 10px; letter-spacing: 0; }
    p { color: #c7ced8; line-height: 1.55; margin: 0; }
    .meta { display: flex; gap: 10px; flex-wrap: wrap; color: #9aa6b2; font-size: 14px; }
    .pill { border: 1px solid #2d3642; border-radius: 999px; padding: 7px 10px; background: #151a21; }
    .example-card { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 26px; align-items: center; border-top: 1px solid #29313d; padding: 30px 0; }
    video { width: 100%; aspect-ratio: 9 / 16; background: #000; border-radius: 8px; border: 1px solid #29313d; }
    .copy { display: grid; gap: 14px; }
    .eyebrow { color: #41e7a5; text-transform: uppercase; font-size: 13px; letter-spacing: .08em; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; }
    dt { color: #8d99a8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    dd { color: #f3f6fa; margin: 4px 0 0; line-height: 1.35; }
    .links { display: flex; flex-wrap: wrap; gap: 12px; }
    a { color: #6ee7ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 760px) {
      .example-card { grid-template-columns: 1fr; }
      video { max-width: 320px; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div class="meta">
      <span class="pill">Local Premiere CEP export</span>
      <span class="pill">No FFmpeg editing</span>
      <span class="pill">No publishing</span>
      <span class="pill">Batch ${htmlEscape(batchSlug)}</span>
    </div>
    <h1>Premiere Edited Examples</h1>
    <p>Three marketing-department edit variants built from the Vast MultiTalk 3090, 4090, and 5090D generated outputs. Each variant includes a saved Premiere project, edit-plan packet, receipt, rights provenance, and deterministic marketing review.</p>
    <p><a href="./manifest.json">Batch manifest</a></p>
  </header>
  ${cards}
</main>
</body>
</html>
`;
    fs.writeFileSync(path.join(siteBatchDir, "index.html"), indexHtml, "utf8");

    const landing = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edited Examples</title></head>
<body style="font-family: system-ui, sans-serif; background:#0b0d10; color:#f5f7fb; padding:32px">
  <h1>Edited Examples</h1>
  <p><a style="color:#6ee7ff" href="./${htmlEscape(batchSlug)}/">Latest Premiere marketing examples: ${htmlEscape(batchSlug)}</a></p>
  <p><a style="color:#6ee7ff" href="./${htmlEscape(relativeFrom(batchManifestPath, siteExamplesDir))}">Latest manifest</a></p>
</body>
</html>
`;
    fs.writeFileSync(path.join(siteExamplesDir, "index.html"), landing, "utf8");
}

async function main() {
    assertLocalInputs();
    const cep = new CepAdapter(config);
    const probe = await cep.probe();
    if (!probe || probe.success !== true) {
        throw new Error(`Premiere CEP bridge did not pass probe: ${JSON.stringify(probe)}`);
    }

    const batchSlug = `multitalk-vast-marketing-edits-${timestampSlug()}`;
    const batchDir = ensureDir(path.join(FOUNDRY_ROOT, "work/marketing-requests", batchSlug));
    const siteExamplesDir = ensureDir(path.join(FOUNDRY_ROOT, "site/edited-examples"));
    const siteBatchDir = ensureDir(path.join(siteExamplesDir, batchSlug));
    const results = [];

    for (const request of STYLE_REQUESTS) {
        process.stdout.write(`[${nowIso()}] Starting ${request.style_id}\n`);
        const result = await runOneEdit({ cep, batchDir, siteBatchDir, request });
        results.push(result);
        process.stdout.write(`[${nowIso()}] Completed ${request.style_id}: ${result.exportPath}\n`);
    }

    const manifest = {
        schemaVersion: 1,
        generated_at: nowIso(),
        batch_slug: batchSlug,
        foundry_root: FOUNDRY_ROOT,
        work_dir: batchDir,
        site_dir: siteBatchDir,
        site_index: path.join(siteBatchDir, "index.html"),
        source_assets: SOURCE_ASSETS.map((asset) => ({ ...asset, ...statFile(asset.path) })),
        not_published: true,
        ffmpeg_used: false,
        provider_write_apis_called: false,
        premiere_bridge: "cep",
        results: results.map((result) => ({
            style_profile_id: result.request.style_id,
            style_name: result.request.style_name,
            platform: result.request.platform,
            caption_style: result.request.caption_style,
            project_path: result.projectPath,
            export_path: result.exportPath,
            site_video_path: result.siteVideoPath,
            receipt_path: result.receiptPath,
            marketing_review_path: result.reviewPath,
            verdict: result.review.verdict,
            overall_score: result.review.overallScore,
            output_bytes: result.receipt.output.bytes,
            output_sha256: result.receipt.output.sha256,
        })),
    };
    const manifestPath = path.join(batchDir, "manifest.json");
    const siteManifestPath = path.join(siteBatchDir, "manifest.json");
    writeJsonAtomic(manifestPath, manifest);
    writeJsonAtomic(siteManifestPath, manifest);
    writeSitePages({
        siteExamplesDir,
        siteBatchDir,
        batchSlug,
        results,
        batchManifestPath: siteManifestPath,
    });
    process.stdout.write(`${JSON.stringify({
        status: "COMPLETED",
        batchSlug,
        workDir: batchDir,
        siteIndex: path.join(siteBatchDir, "index.html"),
        results: manifest.results,
    }, null, 2)}\n`);
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
