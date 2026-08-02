const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, run, writeJsonAtomic } = require("./util");

const GRAMMAR_REGISTRY = {
    kinetic_keyword: { enter: "scale-fade", exit: "collapse", density: "low" },
    structured_three_point_list: { enter: "stagger", exit: "fade", density: "medium" },
    symbol_orbit: { enter: "orbit", exit: "collapse", density: "medium" },
    behind_subject_diagram: { enter: "build", exit: "collapse", density: "medium" },
    stat_counter: { enter: "count", exit: "fade", density: "low" },
    video_window: { enter: "slide", exit: "slide", density: "medium" },
    screenshot_focus: { enter: "focus", exit: "fade", density: "medium" },
    timeline_build: { enter: "build", exit: "wipe", density: "high" },
    before_after: { enter: "split", exit: "merge", density: "medium" },
    comment_card: { enter: "rise", exit: "fade", density: "medium" },
    quote_card: { enter: "rise", exit: "fade", density: "medium" },
    map_path: { enter: "trace", exit: "fade", density: "medium" },
    process_flow: { enter: "build", exit: "collapse", density: "medium" },
    full_screen_takeover: { enter: "wipe", exit: "wipe", density: "high" },
    chapter_transition: { enter: "wipe", exit: "dissolve", density: "low" },
    visual_metaphor: { enter: "scale-fade", exit: "collapse", density: "low" },
    product_feature_callout: { enter: "focus", exit: "fade", density: "medium" },
};

function outputDimensions(job, format) {
    const high = job.generation.resolution === "4k" ? 2160 : job.generation.resolution === "1080p" ? 1080 : 720;
    if (format === "9:16") return { width: high, height: Math.round(high * 16 / 9) };
    if (format === "1:1") return { width: high, height: high };
    return { width: Math.round(high * 16 / 9), height: high };
}

class AnimationGrammarRenderer {
    constructor(config) {
        this.magickBin = config.IMAGEMAGICK_BIN;
        this.font = config.CAPTION_FONT;
    }

    async renderPanel(job, scene, format, output) {
        const dimensions = outputDimensions(job, format);
        const bounds = scene.graphicRegion.bounds;
        const panel = {
            left: Math.round(bounds.left * dimensions.width),
            top: Math.round(bounds.top * dimensions.height),
            width: Math.max(180, Math.round((bounds.right - bounds.left) * dimensions.width)),
            height: Math.max(120, Math.round((bounds.bottom - bounds.top) * dimensions.height)),
        };
        const panelPath = `${output}.panel.png`;
        const textPath = `${output}.text.png`;
        const accent = job.composition.animation.accentColor;
        await run(this.magickBin, [
            "-size", `${panel.width}x${panel.height}`,
            "xc:#10151B",
            "-fill", "#10151BDD",
            "-stroke", "#FFFFFF24",
            "-strokewidth", "2",
            "-draw", `roundrectangle 1,1 ${panel.width - 2},${panel.height - 2} 16,16`,
            "-fill", accent,
            "-stroke", "none",
            "-draw", `roundrectangle 0,0 ${Math.max(8, Math.round(panel.width * 0.018))},${panel.height} 8,8`,
            panelPath,
        ], { timeout: 30000 });
        const treatment = scene.treatment || {};
        const title = String(treatment.text || scene.semanticIntent || "").toUpperCase();
        const elements = (treatment.elements || []).slice(0, 4);
        const body = elements.length > 1 ? `\n${elements.map((item) => `- ${item}`).join("\n")}` : "";
        const text = `${title}${body}`;
        await run(this.magickBin, [
            "-background", "none",
            "-fill", "white",
            "-font", this.font,
            "-pointsize", String(Math.max(24, Math.min(56, Math.round(dimensions.height * 0.037)))),
            "-interline-spacing", "6",
            "-gravity", "west",
            "-size", `${Math.round(panel.width * 0.8)}x${Math.round(panel.height * 0.76)}`,
            `caption:${text}`,
            "-trim", "+repage",
            textPath,
        ], { timeout: 30000 });
        await run(this.magickBin, [
            panelPath,
            textPath,
            "-geometry", `+${Math.round(panel.width * 0.1)}+${Math.round(panel.height * 0.12)}`,
            "-composite",
            "-alpha", "off",
            "-depth", "8",
            `PNG24:${output}`,
        ], { timeout: 30000 });
        fs.unlinkSync(panelPath);
        fs.unlinkSync(textPath);
        return { dimensions, panel };
    }

    async render(job, layout) {
        if (!job.composition?.enabled) return { enabled: false, graphics: [], variants: [] };
        const root = path.join(job.workspace, "generated-assets", "composition");
        ensureDir(root);
        const variants = [];
        for (const variant of layout.variants) {
            const directory = path.join(root, variant.format.replace(":", "x"));
            ensureDir(directory);
            const graphics = [];
            for (const scene of variant.scenes) {
                if (!scene.treatment || scene.grammar === "clean_aroll") continue;
                const output = path.join(directory, `${scene.sceneId}-${scene.grammar}-panel.png`);
                const geometry = await this.renderPanel(job, scene, variant.format, output);
                const grammar = GRAMMAR_REGISTRY[scene.grammar] || GRAMMAR_REGISTRY.visual_metaphor;
                graphics.push({
                    id: `composition-${variant.format.replace(":", "x")}-${scene.sceneId}`,
                    sceneId: scene.sceneId,
                    text: scene.treatment.text,
                    path: output,
                    start: scene.start,
                    end: scene.end,
                    purpose: `scene-composition:${scene.grammar}`,
                    trackIndex: 1,
                    format: variant.format,
                    grammar: scene.grammar,
                    geometry,
                    animation: {
                        introSeconds: scene.animation.intro_seconds,
                        outroSeconds: scene.animation.outro_seconds,
                        enterStyle: grammar.enter,
                        exitStyle: grammar.exit,
                        density: grammar.density,
                        protectedIntro: true,
                        stretchableHold: true,
                        protectedOutro: true,
                    },
                });
            }
            variants.push({ format: variant.format, graphics });
        }
        const current = variants.find((variant) => variant.format === job.generation.aspectRatio) || variants[0];
        const manifest = {
            schemaVersion: 1,
            generatedAt: nowIso(),
            jobId: job.id,
            enabled: true,
            grammarRegistry: GRAMMAR_REGISTRY,
            currentFormat: current?.format || null,
            graphics: current?.graphics || [],
            variants,
        };
        writeJsonAtomic(job.outputPaths.compositionAssets, manifest);
        return manifest;
    }
}

module.exports = { AnimationGrammarRenderer, GRAMMAR_REGISTRY, outputDimensions };
