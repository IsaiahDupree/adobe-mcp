const crypto = require("crypto");
const path = require("path");
const { nowIso, slugify } = require("./util");

const AGENT_PROVIDERS = new Set(["local", "codex_cli"]);

function normalizeBoardSpec(spec, boardsDir, defaultArchiveRoot) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("Production board must be a JSON object.");
    }
    if (!spec.base_job || typeof spec.base_job !== "object") {
        throw new Error("Production board requires base_job.");
    }
    const topic = spec.topic || spec.base_job.request?.topic;
    if (!topic) throw new Error("Production board requires topic or base_job.request.topic.");
    const id = slugify(
        spec.board_id || `${topic}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        "production-board"
    );
    const maxRevisions = Math.max(1, Math.min(3, Number(spec.max_revisions || 3)));
    const agents = spec.agents || {};
    const provider = agents.provider || "local";
    if (!AGENT_PROVIDERS.has(provider)) {
        throw new Error(`agents.provider must be one of: ${Array.from(AGENT_PROVIDERS).join(", ")}.`);
    }
    const archiveRoot = path.normalize(
        spec.archive?.destination_root || path.join(defaultArchiveRoot, "ProductionBoards")
    );
    if (!path.isAbsolute(archiveRoot)) throw new Error("archive.destination_root must be absolute.");
    return {
        schemaVersion: 1,
        id,
        campaignId: slugify(spec.campaign_id || spec.base_job.campaign_id || "production-board"),
        topic,
        objective: spec.objective || spec.base_job.request?.objective || "Produce the strongest release-ready video.",
        maxRevisions,
        minimumRevisions: Math.max(1, Math.min(maxRevisions, Number(spec.minimum_revisions || 1))),
        baseJob: JSON.parse(JSON.stringify(spec.base_job)),
        trend: {
            enabled: spec.trend?.enabled !== false,
            query: spec.trend?.query || topic,
            limit: Math.max(1, Math.min(20, Number(spec.trend?.limit || 8))),
            maxAgeDays: Math.max(1, Math.min(90, Number(spec.trend?.max_age_days || 30))),
            region: spec.trend?.region || "US",
        },
        agents: {
            provider,
            judgeCount: Math.max(2, Math.min(3, Number(agents.judge_count || 2))),
            codexBin: agents.codex_bin || "/Applications/ChatGPT.app/Contents/Resources/codex",
        },
        release: {
            minimumOverallScore: Number(spec.release?.minimum_overall_score || 82),
            minimumCategoryScore: Number(spec.release?.minimum_category_score || 6),
            requiredJudgePasses: Math.max(2, Number(spec.release?.required_judge_passes || 2)),
            requireClaims: spec.release?.require_claims !== false,
            requireCaptions: spec.release?.require_captions !== false,
        },
        archive: {
            enabled: spec.archive?.enabled !== false,
            destinationRoot: archiveRoot,
        },
        claimsAndSources: Array.isArray(spec.claims_and_sources) ? spec.claims_and_sources : [],
        historicalEvidence: Array.isArray(spec.historical_evidence) ? spec.historical_evidence : [],
        prohibitedPatterns: Array.isArray(spec.prohibited_patterns) ? spec.prohibited_patterns : [],
        contentBenchmark: spec.content_benchmark ? {
            enabled: spec.content_benchmark.enabled !== false,
            profileId: spec.content_benchmark.profile_id || spec.content_benchmark.profileId || "authority-education-v1",
            formatFamily: spec.content_benchmark.format_family || spec.content_benchmark.formatFamily || "benchmark-comparison-ladder",
            writtenHook: spec.content_benchmark.written_hook || spec.content_benchmark.writtenHook || null,
            visualHook: spec.content_benchmark.visual_hook || spec.content_benchmark.visualHook || null,
            ctaGoal: spec.content_benchmark.cta_goal || spec.content_benchmark.ctaGoal || "authority",
        } : { enabled: false },
        workspace: path.join(boardsDir, id),
        createdAt: nowIso(),
    };
}

module.exports = { normalizeBoardSpec };
