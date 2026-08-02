const crypto = require("crypto");
const path = require("path");
const { nowIso, slugify } = require("./util");

const EXPERIMENT_TYPES = new Set(["controlled", "creative_exploration", "platform_adaptation"]);
const METRIC_WINDOWS = new Set(["1h", "2h", "24h", "72h", "7d", "28d", "30d"]);

function requiredText(value, field) {
    const text = String(value || "").trim();
    if (!text) throw new Error(`${field} is required.`);
    return text;
}

function finiteNumber(value, field, minimum = -Infinity) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum) {
        throw new Error(`${field} must be a finite number${Number.isFinite(minimum) ? ` >= ${minimum}` : ""}.`);
    }
    return number;
}

function normalizeGuardrail(value, index) {
    if (typeof value === "string") {
        return {
            metric: requiredText(value, `experiment.guardrails[${index}]`),
            direction: "higher_is_better",
            maximumDeclineRatio: 0,
        };
    }
    const direction = value?.direction || "higher_is_better";
    if (!new Set(["higher_is_better", "lower_is_better"]).has(direction)) {
        throw new Error(`experiment.guardrails[${index}].direction is invalid.`);
    }
    return {
        metric: requiredText(value?.metric, `experiment.guardrails[${index}].metric`),
        direction,
        maximumDeclineRatio: finiteNumber(
            value.maximum_decline_ratio ?? value.maximumDeclineRatio ?? 0,
            `experiment.guardrails[${index}].maximum_decline_ratio`,
            0
        ),
    };
}

function normalizeEvidence(value, index) {
    const observedAt = requiredText(value?.observed_at || value?.observedAt, `research.evidence[${index}].observed_at`);
    if (Number.isNaN(Date.parse(observedAt))) {
        throw new Error(`research.evidence[${index}].observed_at must be a valid ISO date.`);
    }
    if (Date.parse(observedAt) > Date.now() + 5 * 60 * 1000) {
        throw new Error(`research.evidence[${index}].observed_at cannot be in the future.`);
    }
    return {
        source: requiredText(value?.source, `research.evidence[${index}].source`),
        observedAt: new Date(observedAt).toISOString(),
        signal: requiredText(value?.signal, `research.evidence[${index}].signal`),
        url: value?.url ? String(value.url) : null,
    };
}

function normalizeVariant(value, index, reviseId, contentFamilyId, experimentType) {
    const id = slugify(value?.variant_id || value?.variantId || `variant-${index + 1}`);
    const role = value?.role || (index === 0 && experimentType === "controlled" ? "control" : "treatment");
    if (!new Set(["control", "treatment", "exploration", "adaptation"]).has(role)) {
        throw new Error(`variants[${index}].role is invalid.`);
    }
    if (!value?.variables || typeof value.variables !== "object" || Array.isArray(value.variables)) {
        throw new Error(`variants[${index}].variables must be an object.`);
    }
    if (!value.board || typeof value.board !== "object" || Array.isArray(value.board)) {
        throw new Error(`variants[${index}].board is required.`);
    }
    const platform = requiredText(value.platform, `variants[${index}].platform`).toLowerCase();
    const board = JSON.parse(JSON.stringify(value.board));
    board.board_id = board.board_id || `${reviseId}-${id}`;
    return {
        id,
        role,
        platform,
        variables: JSON.parse(JSON.stringify(value.variables)),
        board,
        generationFamilyId: slugify(
            value.generation_family_id || value.generationFamilyId || contentFamilyId
        ),
        nearDuplicateGroup: value.near_duplicate_group || value.nearDuplicateGroup || contentFamilyId,
        proposedAt: value.proposed_at || value.proposedAt || null,
    };
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
    }
    return value;
}

function sameValue(left, right) {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function controlledProductionViews(variant, primaryVariable) {
    const job = JSON.parse(JSON.stringify(variant.board.base_job || {}));
    const generation = job.generation || {};
    const scenes = generation.scenes || [];
    const isPrimaryScene = (scene) => {
        const id = String(scene.id || "").toLowerCase();
        if (primaryVariable === "hook") return id.includes("hook");
        if (primaryVariable === "cta") return id.includes("cta");
        if (primaryVariable === "body_script") return !id.includes("hook") && !id.includes("cta");
        return false;
    };
    const primary = {};
    if (["hook", "cta", "body_script"].includes(primaryVariable)) {
        primary.scenes = scenes.filter(isPrimaryScene).map((scene) => ({ id: scene.id, script: scene.script }));
        generation.scenes = scenes.filter((scene) => !isPrimaryScene(scene));
    }
    const retention = job.retention || {};
    if (primaryVariable === "hook") {
        primary.hookText = retention.hook_text ?? retention.hookText ?? null;
        delete retention.hook_text;
        delete retention.hookText;
    }
    if (primaryVariable === "captions") {
        primary.captionMode = retention.caption_mode ?? retention.captionMode ?? null;
        delete retention.caption_mode;
        delete retention.captionMode;
        delete retention.native_caption_track_name;
        delete retention.nativeCaptionTrackName;
    }
    const request = job.request || {};
    if (primaryVariable === "cta") {
        primary.cta = request.cta || null;
        delete request.cta;
    }
    const showcase = job.showcase || {};
    if (primaryVariable === "music") {
        primary.music = showcase.music || showcase.music_sources || showcase.musicSources || null;
        delete showcase.music;
        delete showcase.music_sources;
        delete showcase.musicSources;
    }
    const composition = job.composition || {};
    if (composition.framing) {
        delete composition.framing.experiment_id;
        delete composition.framing.experimentId;
        delete composition.framing.variant_id;
        delete composition.framing.variantId;
        delete composition.framing.control_id;
        delete composition.framing.controlId;
    }
    const locked = {
        request,
        generation,
        retention,
        showcase,
        composition,
    };
    return { primary, locked };
}

function validateControlledExperiment(experiment, variants) {
    if (variants.length < 2 || variants.length > 3) {
        throw new Error("A controlled experiment requires one control and one or two treatments.");
    }
    const controls = variants.filter((variant) => variant.role === "control");
    if (controls.length !== 1) throw new Error("A controlled experiment requires exactly one control variant.");
    const primaryValues = new Set(variants.map((variant) =>
        JSON.stringify(canonicalValue(variant.variables[experiment.primaryVariable]))
    ));
    if (primaryValues.has(undefined) || variants.some((variant) => !(experiment.primaryVariable in variant.variables))) {
        throw new Error(`Every controlled variant must declare variables.${experiment.primaryVariable}.`);
    }
    if (primaryValues.size < 2) throw new Error("The primary variable must differ between control and treatment.");
    for (const locked of experiment.lockedVariables) {
        const reference = variants[0].variables[locked];
        if (variants.some((variant) => !(locked in variant.variables) || !sameValue(variant.variables[locked], reference))) {
            throw new Error(`Locked variable ${locked} must be identical across every controlled variant.`);
        }
    }
    const declared = new Set(variants.flatMap((variant) => Object.keys(variant.variables)));
    for (const variable of declared) {
        if (variable === experiment.primaryVariable) continue;
        const reference = variants[0].variables[variable];
        if (variants.some((variant) => !sameValue(variant.variables[variable], reference))) {
            throw new Error(`Controlled variants differ on undeclared variable ${variable}.`);
        }
    }
    const productionViews = variants.map((variant) => controlledProductionViews(
        variant,
        experiment.primaryVariable
    ));
    if (productionViews.some((view) => !sameValue(view.locked, productionViews[0].locked))) {
        throw new Error("Controlled variant board inputs differ outside the declared primary variable.");
    }
    if (productionViews.every((view) => sameValue(view.primary, productionViews[0].primary))) {
        throw new Error("The declared primary variable is not reflected in the controlled board inputs.");
    }
}

function normalizeReviseSpec(spec, reviseDir) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("REVISE request must be a JSON object.");
    }
    const topicId = slugify(requiredText(spec.topic_id || spec.topicId, "topic_id"));
    const contentFamilyId = slugify(requiredText(
        spec.content_family_id || spec.contentFamilyId,
        "content_family_id"
    ));
    const reviseId = slugify(
        spec.revise_id || spec.reviseId || `${contentFamilyId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
    );
    const inputExperiment = spec.experiment || {};
    const type = inputExperiment.type || inputExperiment.experiment_type;
    if (!EXPERIMENT_TYPES.has(type)) {
        throw new Error(`experiment.type must be one of: ${[...EXPERIMENT_TYPES].join(", ")}.`);
    }
    const primaryVariable = requiredText(
        inputExperiment.primary_variable || inputExperiment.primaryVariable,
        "experiment.primary_variable"
    );
    const minimumExposureInput = inputExperiment.minimum_exposure || inputExperiment.minimumExposure;
    if (!minimumExposureInput || typeof minimumExposureInput !== "object") {
        throw new Error("experiment.minimum_exposure is required.");
    }
    const experiment = {
        id: slugify(inputExperiment.experiment_id || inputExperiment.id || `${reviseId}-experiment`),
        type,
        hypothesis: requiredText(inputExperiment.hypothesis, "experiment.hypothesis"),
        primaryVariable,
        lockedVariables: [...new Set(
            (inputExperiment.locked_variables || inputExperiment.lockedVariables || []).map(String)
        )],
        primaryMetric: requiredText(
            inputExperiment.primary_metric || inputExperiment.primaryMetric,
            "experiment.primary_metric"
        ),
        primaryMetricDirection: inputExperiment.primary_metric_direction || inputExperiment.primaryMetricDirection || "higher_is_better",
        guardrails: (inputExperiment.guardrails || []).map(normalizeGuardrail),
        practicalSignificanceRatio: finiteNumber(
            inputExperiment.practical_significance_ratio ?? inputExperiment.practicalSignificanceRatio,
            "experiment.practical_significance_ratio",
            0
        ),
        minimumExposure: {
            metric: requiredText(minimumExposureInput.metric, "experiment.minimum_exposure.metric"),
            value: finiteNumber(minimumExposureInput.value, "experiment.minimum_exposure.value", 0),
        },
        replicationTargetFamilies: Math.max(1, Math.floor(finiteNumber(
            inputExperiment.replication_target_families ?? inputExperiment.replicationTargetFamilies ?? 3,
            "experiment.replication_target_families",
            1
        ))),
    };
    if (!new Set(["higher_is_better", "lower_is_better"]).has(experiment.primaryMetricDirection)) {
        throw new Error("experiment.primary_metric_direction is invalid.");
    }
    if (experiment.lockedVariables.includes(primaryVariable)) {
        throw new Error("The primary variable cannot also be locked.");
    }
    const variants = (spec.variants || []).map((value, index) =>
        normalizeVariant(value, index, reviseId, contentFamilyId, type)
    );
    if (!variants.length) throw new Error("At least one variant is required.");
    if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
        throw new Error("variant_id values must be unique.");
    }
    if (type === "controlled") validateControlledExperiment(experiment, variants);
    const startAt = requiredText(spec.schedule?.start_at || spec.schedule?.startAt, "schedule.start_at");
    if (Number.isNaN(Date.parse(startAt))) throw new Error("schedule.start_at must be a valid ISO date.");
    const research = spec.research || {};
    const evidence = (research.evidence || []).map(normalizeEvidence);
    if (!evidence.length) throw new Error("research.evidence must contain at least one current observation.");
    return {
        schemaVersion: 1,
        id: reviseId,
        topicId,
        contentFamilyId,
        opportunity: requiredText(research.opportunity, "research.opportunity"),
        uncertainty: requiredText(research.uncertainty, "research.uncertainty"),
        evidence,
        maximumEvidenceAgeDays: Math.max(1, Math.floor(finiteNumber(
            research.maximum_evidence_age_days ?? research.maximumEvidenceAgeDays ?? 90,
            "research.maximum_evidence_age_days",
            1
        ))),
        overusedPatterns: (research.overused_patterns || research.overusedPatterns || []).map(String),
        experiment,
        variants,
        schedule: {
            startAt: new Date(startAt).toISOString(),
            sameFamilySameDay: "blocked",
            sameFamilySamePlatformCooldownDays: 7,
            sameFamilyCrossPlatformCooldownHours: 24,
            nearDuplicateSamePlatformCooldownDays: 14,
            exactExportRepostCooldownDays: 90,
            adjacentCalendarSlotsSameFamily: "blocked",
        },
        workspace: path.join(reviseDir, reviseId),
        createdAt: nowIso(),
    };
}

function normalizeMetricSnapshot(input, experiment, variants) {
    const variantId = slugify(requiredText(input.variant_id || input.variantId, "variant_id"));
    const variant = variants.find((item) => item.id === variantId);
    if (!variant) throw new Error(`Unknown variant_id ${variantId}.`);
    const window = requiredText(input.window, "window");
    if (!METRIC_WINDOWS.has(window)) throw new Error(`window must be one of: ${[...METRIC_WINDOWS].join(", ")}.`);
    const capturedAt = requiredText(input.captured_at || input.capturedAt, "captured_at");
    if (Number.isNaN(Date.parse(capturedAt))) throw new Error("captured_at must be a valid ISO date.");
    if (!input.metrics || typeof input.metrics !== "object" || Array.isArray(input.metrics)) {
        throw new Error("metrics must be an object.");
    }
    const requiredMetrics = new Set([
        experiment.primaryMetric,
        experiment.minimumExposure.metric,
        ...experiment.guardrails.map((guardrail) => guardrail.metric),
    ]);
    const metrics = {};
    for (const [metric, value] of Object.entries(input.metrics)) {
        metrics[metric] = finiteNumber(value, `metrics.${metric}`, 0);
    }
    for (const metric of requiredMetrics) {
        if (!(metric in metrics)) throw new Error(`metrics.${metric} is required for evaluation.`);
    }
    return {
        schemaVersion: 1,
        snapshotId: slugify(input.snapshot_id || input.snapshotId || `${variantId}-${window}-${Date.now()}`),
        experimentId: experiment.id,
        variantId,
        platform: variant.platform,
        platformPostId: requiredText(input.platform_post_id || input.platformPostId, "platform_post_id"),
        window,
        capturedAt: new Date(capturedAt).toISOString(),
        metrics,
    };
}

module.exports = {
    EXPERIMENT_TYPES,
    METRIC_WINDOWS,
    canonicalValue,
    normalizeMetricSnapshot,
    normalizeReviseSpec,
    controlledProductionViews,
    validateControlledExperiment,
};
