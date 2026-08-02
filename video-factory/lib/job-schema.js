const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nowIso, slugify } = require("./util");
const creativeReferenceRegistry = require("../config/creative-reference-registry.json");

const AUTONOMY_MODES = new Set(["supervised", "guarded", "full"]);
const HEYGEN_ENGINES = new Set(["avatar_iii", "avatar_iv", "avatar_v"]);
const GENERATION_PROVIDERS = new Set(["heygen", "macos_say"]);
const VOICE_PROVIDERS = new Set(["elevenlabs", "heygen"]);
const ASPECT_RATIOS = new Set(["16:9", "9:16", "4:5", "5:4", "1:1", "auto"]);
const CAPTION_MODES = new Set(["native", "animated", "both"]);
const RETENTION_PRESETS = new Set(["social-dynamic", "social-accessible", "youtube-explainer"]);
const ASSET_PROVIDERS = new Set(["pexels", "pixabay"]);
const COMPOSITION_FORMATS = new Set(["16:9", "9:16", "1:1"]);
const CREATIVE_REFERENCE_IDS = new Set(creativeReferenceRegistry.references.map((item) => item.id));

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
    if (!GENERATION_PROVIDERS.has(provider)) {
        throw new Error(`generation.provider must be one of: ${Array.from(GENERATION_PROVIDERS).join(", ")}.`);
    }
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
    const voiceProvider = input.voice_provider || input.voiceProvider || "elevenlabs";
    if (!VOICE_PROVIDERS.has(voiceProvider)) {
        throw new Error(`generation.voice_provider must be one of: ${Array.from(VOICE_PROVIDERS).join(", ")}.`);
    }
    const elevenLabsVoiceId = input.elevenlabs_voice_id || input.elevenLabsVoiceId || defaults.elevenLabsVoiceId;
    const outputFormat = input.output_format || input.outputFormat || "mp4";
    if (!["mp4", "webm"].includes(outputFormat)) {
        throw new Error("generation.output_format must be mp4 or webm.");
    }
    const fit = input.fit || null;
    if (fit && !["contain", "cover"].includes(fit)) {
        throw new Error("generation.fit must be contain or cover.");
    }
    if (provider === "heygen" && !avatarId) throw new Error("generation.avatar_id is required.");
    if (provider === "heygen" && voiceProvider === "heygen" && !voiceId) {
        throw new Error("generation.voice_id is required when generation.voice_provider is heygen.");
    }
    if (provider === "heygen" && voiceProvider === "elevenlabs" && !elevenLabsVoiceId) {
        throw new Error("generation.elevenlabs_voice_id is required when generation.voice_provider is elevenlabs.");
    }
    return {
        enabled: true,
        provider,
        avatarId,
        voiceId,
        voiceProvider,
        elevenLabsVoiceId,
        elevenLabsModelId: input.elevenlabs_model_id || input.elevenLabsModelId || "eleven_multilingual_v2",
        elevenLabsOutputFormat: input.elevenlabs_output_format || input.elevenLabsOutputFormat || "mp3_44100_128",
        elevenLabsVoiceSettings: input.elevenlabs_voice_settings || input.elevenLabsVoiceSettings || {
            stability: 0.48,
            similarity_boost: 0.82,
            style: 0.2,
            use_speaker_boost: true,
        },
        voiceExperimentId: input.voice_experiment_id || input.voiceExperimentId || null,
        voiceVariantId: input.voice_variant_id || input.voiceVariantId || null,
        engine,
        aspectRatio,
        resolution: input.resolution || "720p",
        background: outputFormat === "webm" ? null : (input.background || { type: "color", value: "#111111" }),
        outputFormat,
        removeBackground: outputFormat === "webm" || Boolean(input.remove_background || input.removeBackground),
        fit,
        motionPrompt: input.motion_prompt || input.motionPrompt || null,
        expressiveness: input.expressiveness || null,
        voiceSettings: input.voice_settings || input.voiceSettings || { speed: 1.04, locale: "en-US" },
        voiceName: input.voice_name || input.voiceName || "Samantha",
        wordsPerMinute: Number(input.words_per_minute || input.wordsPerMinute || 165),
        reuseFromJobId: input.reuse_from_job_id || input.reuseFromJobId || null,
        scenes,
        concurrency: Math.max(1, Math.min(4, Number(input.concurrency || 3))),
        pollIntervalMs: Number(input.poll_interval_ms || input.pollIntervalMs || 8000),
        timeoutMs: Number(input.timeout_ms || input.timeoutMs || 20 * 60 * 1000),
    };
}

function normalizeComposition(spec, generation) {
    const input = spec.composition || (spec.production && spec.production.composition);
    if (!input || input.enabled === false || !generation.enabled) return { enabled: false };
    const formats = input.formats || [generation.aspectRatio];
    if (!Array.isArray(formats) || formats.length === 0 || formats.some((format) => !COMPOSITION_FORMATS.has(format))) {
        throw new Error("composition.formats must contain 16:9, 9:16, or 1:1.");
    }
    const character = input.character || {};
    const analysis = input.subject_analysis || input.subjectAnalysis || {};
    const layout = input.layout || {};
    const animation = input.animation || {};
    const framing = input.framing || {};
    const edgeSafetyMargin = layout.edge_safety_margin ?? layout.edgeSafetyMargin ?? 0.005;
    const maximumAddedBarAreaRatio = framing.maximum_added_bar_area_ratio ?? framing.maximumAddedBarAreaRatio ?? 0.003;
    const maximumFinalBarAreaRatio = framing.maximum_final_bar_area_ratio ?? framing.maximumFinalBarAreaRatio ?? 0.003;
    const framingMode = layout.framing_mode || layout.framingMode || "safe-fill";
    if (framingMode !== "safe-fill") throw new Error("composition.layout.framing_mode must be safe-fill.");
    return {
        enabled: true,
        formats: [...new Set(formats)],
        character: {
            id: character.id || "primary-presenter",
            avatarGroupId: character.avatar_group_id || character.avatarGroupId || null,
            avatarLookId: character.avatar_look_id || character.avatarLookId || generation.avatarId || null,
            lookOrientation: character.look_orientation || character.lookOrientation || null,
            compositionRole: character.composition_role || character.compositionRole || "foreground-speaker",
            faceSpaceRequest: character.face_space_request || character.faceSpaceRequest || "auto",
            gestureSpaceRequest: character.gesture_space_request || character.gestureSpaceRequest || "upper-body",
        },
        subjectAnalysis: {
            provider: "opencv-haar",
            sampleIntervalSeconds: Math.max(0.25, Math.min(3, Number(analysis.sample_interval_seconds || analysis.sampleIntervalSeconds || 1))),
            minimumFaceConfidence: Math.max(0, Math.min(1, Number(analysis.minimum_face_confidence || analysis.minimumFaceConfidence || 0.62))),
        },
        layout: {
            framingMode,
            facePadding: Math.max(0.02, Math.min(0.25, Number(layout.face_padding || layout.facePadding || 0.08))),
            deadband: Math.max(0, Math.min(0.1, Number(layout.deadband || 0.018))),
            smoothingAlpha: Math.max(0.05, Math.min(0.95, Number(layout.smoothing_alpha || layout.smoothingAlpha || 0.32))),
            maxZoom: Math.max(1, Math.min(1.4, Number(layout.max_zoom || layout.maxZoom || 1.28))),
            edgeSafetyMargin: Math.max(0, Math.min(0.04, Number(edgeSafetyMargin))),
            minSecondsBetweenZooms: Math.max(1, Number(layout.min_seconds_between_zooms || layout.minSecondsBetweenZooms || 6)),
        },
        framing: {
            enabled: framing.enabled !== false,
            experimentId: framing.experiment_id || framing.experimentId || null,
            variantId: framing.variant_id || framing.variantId || null,
            controlId: framing.control_id || framing.controlId || null,
            maximumAddedBarAreaRatio: Math.max(0, Math.min(0.05, Number(maximumAddedBarAreaRatio))),
            maximumFinalBarAreaRatio: Math.max(0, Math.min(0.05, Number(maximumFinalBarAreaRatio))),
        },
        animation: {
            style: animation.style || "clean-dark-glass",
            accentColor: animation.accent_color || animation.accentColor || "#20D5C2",
            introSeconds: Math.max(0.25, Math.min(1, Number(animation.intro_seconds || animation.introSeconds || 0.45))),
            outroSeconds: Math.max(0.25, Math.min(1, Number(animation.outro_seconds || animation.outroSeconds || 0.55))),
            maximumTreatmentsPerMinute: Math.max(2, Math.min(12, Number(animation.maximum_treatments_per_minute || animation.maximumTreatmentsPerMinute || 7))),
        },
    };
}

function normalizeRetention(spec) {
    const input = spec.retention || (spec.production && spec.production.retention) || {};
    const captionMode = input.caption_mode || input.captionMode || "native";
    const preset = input.preset || "social-dynamic";
    if (!CAPTION_MODES.has(captionMode)) {
        throw new Error(`retention.caption_mode must be one of: ${Array.from(CAPTION_MODES).join(", ")}.`);
    }
    if (!RETENTION_PRESETS.has(preset)) {
        throw new Error(`retention.preset must be one of: ${Array.from(RETENTION_PRESETS).join(", ")}.`);
    }
    const creativeReferences = input.creative_reference_ids || input.creativeReferenceIds || [];
    if (!Array.isArray(creativeReferences) || creativeReferences.some((id) => !CREATIVE_REFERENCE_IDS.has(id))) {
        throw new Error("retention.creative_reference_ids contains an unknown creative reference.");
    }
    return {
        enabled: input.enabled !== false,
        preset,
        hookText: input.hook_text || input.hookText || null,
        patternInterruptText:
            input.pattern_interrupt_text || input.patternInterruptText || "THE FIX",
        captionStyle: input.caption_style || input.captionStyle || "bold-safe",
        captionMode,
        nativeCaptionTrackName:
            input.native_caption_track_name || input.nativeCaptionTrackName || "C1_ACCESSIBILITY_EN",
        punchInScale: Number(input.punch_in_scale || input.punchInScale || 1.08),
        dialogueGainDb: Math.max(-12, Math.min(12, Number(
            input.dialogue_gain_db ?? input.dialogueGainDb ?? 0
        ))),
        creativeReferences: [...new Set(creativeReferences)],
    };
}

function normalizeShowcase(spec) {
    const input = spec.showcase || (spec.production && spec.production.showcase);
    if (!input || input.enabled === false) return { enabled: false };
    const normalizeSfx = (items) =>
        (items || []).map((item, index) => {
            const inputItem = typeof item === "string" ? { path: item } : { ...item };
            const value = inputItem.path;
            if (!value || !path.isAbsolute(value)) {
                throw new Error(`showcase.sfx_sources[${index}] requires an absolute path.`);
            }
            const timelineSeconds = inputItem.timeline_seconds ?? inputItem.timelineSeconds;
            const parsedTimelineSeconds = timelineSeconds === null || timelineSeconds === undefined
                ? null
                : Number(timelineSeconds);
            const parsedDurationSeconds = Number(inputItem.duration_seconds || inputItem.durationSeconds || 1.5);
            const parsedTrackIndex = Number(inputItem.track_index || inputItem.trackIndex || index + 1);
            const parsedGainDb = Number(inputItem.gain_db ?? inputItem.gainDb ?? -12);
            if (parsedTimelineSeconds !== null && (!Number.isFinite(parsedTimelineSeconds) || parsedTimelineSeconds < 0)) {
                throw new Error(`showcase.sfx_sources[${index}].timeline_seconds must be zero or greater.`);
            }
            if (!Number.isFinite(parsedDurationSeconds) || parsedDurationSeconds <= 0) {
                throw new Error(`showcase.sfx_sources[${index}].duration_seconds must be greater than zero.`);
            }
            if (!Number.isFinite(parsedTrackIndex) || parsedTrackIndex < 1) {
                throw new Error(`showcase.sfx_sources[${index}].track_index must be one or greater.`);
            }
            if (!Number.isFinite(parsedGainDb) || parsedGainDb < -96 || parsedGainDb > 12) {
                throw new Error(`showcase.sfx_sources[${index}].gain_db must be between -96 and 12.`);
            }
            return {
                id: inputItem.id || `sfx-${index + 1}`,
                path: path.normalize(value),
                timelineSeconds: parsedTimelineSeconds,
                durationSeconds: parsedDurationSeconds,
                trackIndex: Math.floor(parsedTrackIndex),
                gainDb: parsedGainDb,
                purpose: inputItem.purpose || "chapter-transition-sfx",
                provider: inputItem.provider || null,
                license: inputItem.license || "owner-supplied",
            };
        });
    const normalizeBroll = (items) =>
        (items || []).map((item, index) => {
            const inputItem = typeof item === "string" ? { path: item } : { ...item };
            if (!inputItem.path || !path.isAbsolute(inputItem.path)) {
                throw new Error(`showcase.broll_sources[${index}] requires an absolute path.`);
            }
            return {
                path: path.normalize(inputItem.path),
                sceneId: inputItem.scene_id || inputItem.sceneId || null,
                sourceStart: Number(inputItem.source_start || inputItem.sourceStart || 0),
                scale: Number(inputItem.scale || 0) || null,
            };
        });
    const normalizeAssetRequests = (items) =>
        (items || []).map((item, index) => {
            const request = { ...item };
            if (!request.query || !String(request.query).trim()) {
                throw new Error(`showcase.asset_requests[${index}].query is required.`);
            }
            const providers = request.providers || (request.provider ? [request.provider] : ["pexels", "pixabay"]);
            if (!Array.isArray(providers) || providers.length === 0 || providers.some((provider) => !ASSET_PROVIDERS.has(provider))) {
                throw new Error(
                    `showcase.asset_requests[${index}].providers must contain pexels or pixabay.`
                );
            }
            const orientation = request.orientation || "landscape";
            if (!["landscape", "portrait", "square", "any"].includes(orientation)) {
                throw new Error(`showcase.asset_requests[${index}].orientation is invalid.`);
            }
            const minDurationSeconds = Number(request.min_duration_seconds || request.minDurationSeconds || 5);
            const maxDurationSeconds = Number(request.max_duration_seconds || request.maxDurationSeconds || 45);
            if (minDurationSeconds <= 0 || maxDurationSeconds < minDurationSeconds) {
                throw new Error(`showcase.asset_requests[${index}] has an invalid duration range.`);
            }
            return {
                id: slugify(request.id || `broll-${String(index + 1).padStart(2, "0")}`),
                type: "video",
                sceneId: slugify(request.scene_id || request.sceneId || `scene-${index + 1}`),
                purpose: request.purpose || "visual-proof",
                query: String(request.query).trim(),
                providers: [...new Set(providers)],
                orientation,
                minDurationSeconds,
                maxDurationSeconds,
                idealDurationSeconds: Number(
                    request.ideal_duration_seconds || request.idealDurationSeconds ||
                    Math.min(maxDurationSeconds, Math.max(minDurationSeconds, 12))
                ),
                candidateCount: Math.max(3, Math.min(40, Number(request.candidate_count || request.candidateCount || 15))),
                sourceStart: Math.max(0, Number(request.source_start || request.sourceStart || 0)),
                timelineOffsetSeconds: Math.max(0, Number(
                    request.timeline_offset_seconds || request.timelineOffsetSeconds || 0
                )),
                placementDurationSeconds: Math.max(
                    2,
                    Math.min(12, Number(request.placement_duration_seconds || request.placementDurationSeconds || 5))
                ),
                scale: Number(request.scale || 0) || null,
            };
        });
    const normalizeExplainers = (items) =>
        (items || []).map((item, index) => {
            const explainer = { ...item };
            const title = String(explainer.title || "").trim();
            const points = (explainer.points || explainer.items || [])
                .map((point) => String(point).trim())
                .filter(Boolean)
                .slice(0, 5);
            if (!title) throw new Error(`showcase.explainer_assets[${index}].title is required.`);
            if (points.length < 2) {
                throw new Error(`showcase.explainer_assets[${index}].points requires at least two items.`);
            }
            return {
                id: slugify(explainer.id || `explainer-${String(index + 1).padStart(2, "0")}`),
                sceneId: slugify(explainer.scene_id || explainer.sceneId || `scene-${index + 1}`),
                title,
                eyebrow: String(explainer.eyebrow || "VISUAL EXPLAINER").trim(),
                points,
                layout: explainer.layout || "process",
                timelineOffsetSeconds: Math.max(0, Number(
                    explainer.timeline_offset_seconds || explainer.timelineOffsetSeconds || 0
                )),
                placementDurationSeconds: Math.max(2.5, Math.min(10, Number(
                    explainer.placement_duration_seconds || explainer.placementDurationSeconds || 5
                ))),
            };
        });
    const minimumDurationSeconds = Number(
        input.minimum_duration_seconds || input.minimumDurationSeconds || 300
    );
    const maximumDurationSeconds = Number(
        input.maximum_duration_seconds || input.maximumDurationSeconds || 480
    );
    if (minimumDurationSeconds <= 0 || maximumDurationSeconds < minimumDurationSeconds) {
        throw new Error("showcase duration range is invalid.");
    }
    const brollSources = normalizeBroll(input.broll_sources || input.brollSources);
    const sfxSources = normalizeSfx(input.sfx_sources || input.sfxSources);
    const assetRequests = normalizeAssetRequests(input.asset_requests || input.assetRequests);
    const explainerAssets = normalizeExplainers(input.explainer_assets || input.explainerAssets);
    const policyInput = input.asset_policy || input.assetPolicy || {};
    const assetPolicy = {
        mode: policyInput.mode || (assetRequests.length > 0 ? "provider-only" : "local-allowed"),
        recordProvenance: policyInput.record_provenance !== false && policyInput.recordProvenance !== false,
    };
    if (!["provider-only", "local-allowed"].includes(assetPolicy.mode)) {
        throw new Error("showcase.asset_policy.mode must be provider-only or local-allowed.");
    }
    if (assetPolicy.mode === "provider-only" && (brollSources.length > 0 || sfxSources.length > 0)) {
        throw new Error("Provider-only showcase jobs cannot include pre-existing local B-roll or SFX paths.");
    }
    return {
        enabled: true,
        minimumDurationSeconds,
        maximumDurationSeconds,
        brollSources,
        sfxSources,
        assetRequests,
        explainerAssets,
        assetPolicy,
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
    const showcase = normalizeShowcase(spec);
    const composition = normalizeComposition(spec, generation);
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
        showcase,
        composition,
        archive,
        workspace,
        outputPaths: {
            project: path.join(workspace, "premiere", `${projectName}-v001.prproj`),
            qc: path.join(workspace, "qc", "qc-report.json"),
            render: render ? render.output_file : null,
            generationManifest: path.join(workspace, "generated-assets", "heygen", "generation-manifest.json"),
            combinedCaptions: path.join(workspace, "transcripts", "combined-captions.srt"),
            editManifest: path.join(workspace, "edit-plans", "retention-edit-manifest.json"),
            showcaseManifest: path.join(workspace, "edit-plans", "showcase-asset-manifest.json"),
            assetRegistry: path.join(workspace, "source-assets", "asset-registry.json"),
            visualScenePlan: path.join(workspace, "edit-plans", "visual-scene-plan.json"),
            subjectTrack: path.join(workspace, "edit-plans", "subject-track.json"),
            responsiveLayout: path.join(workspace, "edit-plans", "responsive-layout.json"),
            compositionAssets: path.join(workspace, "edit-plans", "composition-assets.json"),
            compositionQa: path.join(workspace, "qc", "composition-qa.json"),
            framingSourceAudit: path.join(workspace, "qc", "heygen-source-framing.json"),
            framingAudit: path.join(workspace, "qc", "final-framing-audit.json"),
        },
    };
}

function validateAssets(job) {
    const missing = job.production.sourceAssets
        .filter((asset) => !fs.existsSync(asset.path))
        .map((asset) => asset.path);
    return { valid: missing.length === 0, missing };
}

module.exports = { normalizeComposition, normalizeJobSpec, validateAssets };
