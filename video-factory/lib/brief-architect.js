const { nowIso } = require("./util");
const { executionContract, profileById } = require("./content-benchmark");

function estimateDuration(script, wordsPerMinute) {
    const words = String(script || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.max(2, words / Math.max(80, wordsPerMinute) * 60);
}

class BriefArchitect {
    create(board, trendReport, performanceMemory) {
        const generation = board.baseJob.generation || {};
        const scenes = generation.scenes || [];
        const wordsPerMinute = Number(generation.words_per_minute || generation.wordsPerMinute || 165);
        let cursor = 0;
        const beatSheet = scenes.map((scene, index) => {
            const item = typeof scene === "string" ? { id: `scene-${index + 1}`, script: scene } : scene;
            const duration = estimateDuration(item.script, wordsPerMinute);
            const start = cursor;
            cursor += duration;
            return {
                sceneId: item.id || `scene-${index + 1}`,
                start: Number(start.toFixed(2)),
                end: Number(cursor.toFixed(2)),
                spokenLine: item.script,
                viewerQuestion: index === 0 ? "Why should I keep watching?" : "What proof or useful detail comes next?",
                visual: item.title || `Visual proof for ${item.id || `scene ${index + 1}`}`,
                editPattern: index === 0 ? "result_first_hook" : "semantic_cut",
                captionEmphasis: String(item.script || "").split(/\s+/).filter((word) => word.length >= 7).slice(0, 2),
                sfx: null,
                retentionReason: index === 0 ? "Make the promise immediate." : "Reset attention at a new idea.",
            };
        });
        const hookText = board.baseJob.retention?.hook_text || board.baseJob.retention?.hookText ||
            scenes[0]?.script || scenes[0] || board.topic;
        const benchmark = board.contentBenchmark?.enabled
            ? executionContract(profileById(board.contentBenchmark.profileId), {
                  spoken: hookText,
                  written: board.contentBenchmark.writtenHook,
                  visual: board.contentBenchmark.visualHook,
                  formatFamily: board.contentBenchmark.formatFamily,
                  ctaGoal: board.contentBenchmark.ctaGoal,
              })
            : null;
        const assetRequests = board.baseJob.showcase?.asset_requests || [];
        return {
            schemaVersion: 1,
            generatedAt: nowIso(),
            videoGoal: { objective: board.objective, platform: "youtube", format: generation.aspect_ratio || "16:9" },
            targetViewer: board.baseJob.request?.audience || "Defined by campaign",
            viewerProblem: board.baseJob.request?.viewer_problem || "The viewer needs useful proof without wasted time.",
            corePromise: board.baseJob.request?.core_promise || board.objective,
            topicAngle: board.topic,
            trendEvidence: trendReport.candidates.slice(0, 5).map((item) => ({
                url: item.url,
                title: item.title,
                score: item.trendScore,
                publicMetrics: { views: item.views, likes: item.likes, comments: item.comments },
            })),
            channelPerformanceEvidence: performanceMemory.lessons,
            hookOptions: [
                { type: "result-first", text: hookText },
                { type: "problem-first", text: board.baseJob.request?.viewer_problem || board.topic },
            ],
            selectedHook: { type: "result-first", text: hookText, start: 0, targetProofBySeconds: 12 },
            benchmarkExecution: benchmark,
            script: scenes.map((scene, index) => ({
                sceneId: typeof scene === "string" ? `scene-${index + 1}` : scene.id,
                text: typeof scene === "string" ? scene : scene.script,
            })),
            beatSheet,
            retentionHypotheses: [
                { hypothesis: "Early proof and semantic visual changes improve comprehension and reduce visual fatigue.", confidence: 0.65 },
            ],
            visualPlan: beatSheet.map((beat) => ({ sceneId: beat.sceneId, visual: beat.visual, pattern: beat.editPattern })),
            captionPlan: {
                mode: board.baseJob.retention?.caption_mode || "native",
                nativeTrackRequired: true,
                readableSafeZoneRequired: true,
            },
            bRollRequests: assetRequests,
            graphicsRequests: beatSheet.map((beat) => ({ sceneId: beat.sceneId, type: "chapter-and-callout" })),
            soundDesignPlan: board.baseJob.showcase?.sfx_sources || [],
            musicDirection: board.baseJob.music_direction || { enabled: false },
            premiereTemplateModules: board.baseJob.retention?.creative_reference_ids || [],
            claimsAndSources: board.claimsAndSources,
            cta: {
                text: board.baseJob.request?.cta || scenes.at(-1)?.script || "",
                requiredInFinalBeat: true,
                benchmarkRule: benchmark?.cta || null,
            },
            successTargets: board.release,
            experiments: [{ id: "revision-comparison", variants: board.maxRevisions, measure: "blind editorial score" }],
            prohibitedPatterns: board.prohibitedPatterns,
        };
    }
}

module.exports = { BriefArchitect, estimateDuration };
