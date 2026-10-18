const { nowIso, writeJsonAtomic } = require("./util");

const STOP_WORDS = new Set([
    "about", "after", "again", "also", "and", "because", "before", "being", "from",
    "have", "into", "just", "more", "that", "their", "there", "these", "this", "those",
    "through", "very", "what", "when", "where", "which", "while", "with", "would", "your",
]);

const RULES = [
    { intent: "quantify_result", pattern: /(?:\b\d+(?:[.,]\d+)?%?\b|percent|revenue|result|increase|decrease|score)/i, grammar: "stat_counter", layout: "side_stat_card", assetType: "stat_card", priority: 10 },
    { intent: "show_contrast", pattern: /(?:before|after|versus|vs\.?|instead|unlike|contrast|but now)/i, grammar: "before_after", layout: "split_screen", assetType: "comparison", priority: 9 },
    { intent: "explain_process", pattern: /(?:process|workflow|pipeline|first|then|next|finally|research|create|judge|improve|step)/i, grammar: "process_flow", layout: "behind_subject_diagram", assetType: "animated_diagram", priority: 9 },
    { intent: "show_product", pattern: /(?:app|software|dashboard|premiere|heygen|api|plugin|project|timeline|screen)/i, grammar: "screenshot_focus", layout: "video_window", assetType: "screenshot_or_recording", priority: 8 },
    { intent: "tell_example", pattern: /(?:example|imagine|story|customer|client|case study|for instance)/i, grammar: "video_window", layout: "broll_window", assetType: "provider_video", priority: 7 },
    { intent: "emotional_moment", pattern: /(?:feel|felt|believe|honestly|personally|struggle|fear|hope|love|pain)/i, grammar: "clean_aroll", layout: "face_focus", assetType: null, priority: 10 },
    { intent: "summarize", pattern: /(?:summary|recap|remember|key points|in short|takeaway)/i, grammar: "structured_three_point_list", layout: "visual_stack", assetType: "structured_list", priority: 8 },
    { intent: "important_claim", pattern: /(?:must|never|always|critical|important|strongest|best|only|complete|autonomous)/i, grammar: "kinetic_keyword", layout: "side_keyword", assetType: "animated_text", priority: 7 },
];

function contentWords(text, maximum = 8) {
    return String(text)
        .replace(/[^a-zA-Z0-9%'-]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word.toLowerCase()))
        .slice(0, maximum);
}

function shortTreatmentText(text) {
    const words = contentWords(text, 8);
    return (words.length >= 2 ? words : String(text).trim().split(/\s+/).slice(0, 8)).join(" ");
}

function processElements(text) {
    const parts = String(text).split(/,|;|\band\b|\bthen\b|\bnext\b/i)
        .map((part) => contentWords(part, 3).join(" "))
        .filter(Boolean);
    return [...new Set(parts)].slice(0, 5);
}

class SceneDirector {
    classify(text) {
        return RULES.find((rule) => rule.pattern.test(text)) || {
            intent: "explain_concept",
            grammar: "visual_metaphor",
            layout: "side_symbol",
            assetType: "symbol",
            priority: 5,
        };
    }

    plan(job) {
        if (!job.composition?.enabled) return { enabled: false, scenes: [] };
        const secondsPerWord = 60 / Math.max(80, job.generation.wordsPerMinute || 165);
        let cursor = 0;
        let scenes = job.generation.scenes.map((scene, index) => {
            const duration = Math.max(3, scene.script.trim().split(/\s+/).length * secondsPerWord);
            const start = cursor;
            const end = start + duration;
            cursor = end;
            const rule = this.classify(scene.script);
            const elements = rule.intent === "explain_process"
                ? processElements(scene.script)
                : contentWords(scene.script, 5);
            const intro = Math.min(job.composition.animation.introSeconds, duration * 0.2);
            const outro = Math.min(job.composition.animation.outroSeconds, duration * 0.2);
            return {
                scene_id: scene.id,
                order: index,
                start: Number(start.toFixed(3)),
                end: Number(end.toFixed(3)),
                timing_basis: "script-estimate-before-generation",
                spoken_text: scene.script,
                semantic_intent: rule.intent,
                treatment_priority: rule.priority,
                layout: rule.layout,
                subject_preference: index % 2 === 0 ? "right_third" : "left_third",
                animation_grammar: rule.grammar,
                asset_request: rule.assetType ? {
                    type: rule.assetType,
                    text: shortTreatmentText(scene.script),
                    elements,
                    style: job.composition.animation.style,
                    motion: rule.intent === "explain_process" ? "sequential_connection" : "build_and_resolve",
                } : null,
                animation: {
                    intro_seconds: Number(intro.toFixed(3)),
                    focus_seconds: Number(Math.max(0.5, duration - intro - outro).toFixed(3)),
                    outro_seconds: Number(outro.toFixed(3)),
                    phases: ["entrance", "focus", "hold", "exit", "resolution"],
                },
                format_variants: job.composition.formats,
                heygen_requests: Object.fromEntries(job.composition.formats.map((format) => [format, {
                    character_id: job.composition.character.id,
                    avatar_group_id: job.composition.character.avatarGroupId,
                    avatar_look_id: job.composition.character.avatarLookId,
                    look_orientation: job.composition.character.lookOrientation,
                    requested_format: format,
                    output_mode: job.generation.outputFormat === "webm" ? "transparent_webm" : "standard_mp4",
                    composition_role: job.composition.character.compositionRole,
                    face_space_request: format === "9:16" ? "upper_center" : (index % 2 === 0 ? "right_third" : "left_third"),
                    gesture_space_request: job.composition.character.gestureSpaceRequest,
                }])),
            };
        });

        const maximumTreatments = Math.max(1, Math.floor(
            (cursor / 60) * job.composition.animation.maximumTreatmentsPerMinute
        ));
        const selected = new Set([...scenes]
            .filter((scene) => scene.animation_grammar !== "clean_aroll")
            .sort((a, b) => b.treatment_priority - a.treatment_priority || a.order - b.order)
            .slice(0, maximumTreatments)
            .map((scene) => scene.scene_id));
        scenes = scenes.map((scene) => selected.has(scene.scene_id) || scene.animation_grammar === "clean_aroll"
            ? scene
            : { ...scene, layout: "clean_aroll", animation_grammar: "clean_aroll", asset_request: null });
        const manifest = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            provider: "deterministic-semantic-scene-director",
            source: "script-and-job-brief",
            formats: job.composition.formats,
            estimatedDurationSeconds: Number(cursor.toFixed(3)),
            treatmentCount: scenes.filter((scene) => scene.asset_request).length,
            tasteRules: {
                maximumTreatmentsPerMinute: job.composition.animation.maximumTreatmentsPerMinute,
                cleanArrollScenes: scenes.filter((scene) => !scene.asset_request).map((scene) => scene.scene_id),
                maximumWordsPerTreatment: 8,
            },
            scenes,
        };
        writeJsonAtomic(job.outputPaths.visualScenePlan, manifest);
        return manifest;
    }
}

module.exports = { RULES, SceneDirector, contentWords, shortTreatmentText };
