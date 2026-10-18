const { slugify } = require("./util");

const SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };

class Showrunner {
    initialDirective(board, brief) {
        return {
            revision: 1,
            objective: board.objective,
            selectedHook: brief.selectedHook,
            selectedChanges: [],
            rationale: "Compile the approved brief into the first immutable Premiere version.",
        };
    }

    selectChanges(revision, scorecards) {
        const candidates = scorecards.flatMap((scorecard) => scorecard.findings || [])
            .filter((finding) => finding.recommendedModification && !finding.conflictsWithBrief)
            .map((finding) => ({
                ...finding,
                impactScore:
                    (SEVERITY_WEIGHT[finding.severity] || 1) *
                    Number(finding.confidence || 0.5) *
                    Number(finding.expectedBenefit || 0.5) *
                    (1 - Number(finding.riskOfOverEditing || 0)),
            }))
            .sort((a, b) => b.impactScore - a.impactScore);
        const seen = new Set();
        const selectedChanges = [];
        for (const candidate of candidates) {
            const key = `${candidate.recommendedModification.operation}:${candidate.sceneId || candidate.start}`;
            if (seen.has(key)) continue;
            seen.add(key);
            selectedChanges.push(candidate);
            if (selectedChanges.length >= 5) break;
        }
        return {
            revision,
            selectedChanges,
            rationale: selectedChanges.length > 0
                ? "Selected the highest-confidence changes with the strongest expected benefit and lowest over-editing risk."
                : "No high-confidence editorial change survived the conflict and risk filters.",
        };
    }

    applyDirectives(baseJob, board, revision, directives) {
        const spec = JSON.parse(JSON.stringify(baseJob));
        spec.job_id = `${board.id}-v${revision}`;
        spec.campaign_id = board.campaignId;
        spec.autonomy = { ...(spec.autonomy || {}), mode: "full", final_publish_approval: "automatic" };
        spec.production = { ...(spec.production || {}) };
        const baseProjectName = spec.production.project_name || slugify(board.topic);
        spec.production.project_name = `${baseProjectName}-v${revision}`;
        spec.production.sequence_name = `${spec.production.sequence_name || "MASTER"}_V${revision}`;
        spec.production.render = { ...(spec.production.render || {}) };
        spec.archive = { enabled: false };
        spec.showcase = { ...(spec.showcase || {}) };
        spec.showcase.asset_requests = [...(spec.showcase.asset_requests || [])];
        spec.retention = { ...(spec.retention || {}) };
        if (revision > 1 && board.revisions?.[0]?.jobId && spec.generation?.enabled !== false) {
            spec.generation = { ...(spec.generation || {}), reuse_from_job_id: board.revisions[0].jobId };
        }

        for (const directive of directives) {
            const change = directive.recommendedModification || directive;
            if (change.operation === "add_broll" && change.scene_id) {
                const exists = spec.showcase.asset_requests.some((request) => request.scene_id === change.scene_id);
                if (!exists) {
                    spec.showcase.asset_requests.push({
                        id: `revision-${revision}-${slugify(change.scene_id)}-proof`,
                        scene_id: change.scene_id,
                        query: change.query || change.scene_id.replaceAll("-", " "),
                        providers: [revision % 2 === 0 ? "pexels" : "pixabay", revision % 2 === 0 ? "pixabay" : "pexels"],
                        purpose: "judge-requested-visual-proof",
                        orientation: spec.generation?.aspect_ratio === "9:16" ? "portrait" : "landscape",
                        min_duration_seconds: 5,
                        max_duration_seconds: 35,
                        placement_duration_seconds: 6,
                    });
                }
            }
            if (change.operation === "increase_motion") {
                const current = Number(spec.retention.punch_in_scale || 1.06);
                spec.retention.punch_in_scale = Math.min(1.12, Number((current + 0.01).toFixed(2)));
            }
            if (change.operation === "strengthen_pattern_interrupt") {
                spec.retention.pattern_interrupt_text = change.text || "LOOK HERE";
            }
            if (change.operation === "enable_animated_captions") {
                spec.retention.caption_mode = "both";
            }
        }
        return spec;
    }
}

module.exports = { Showrunner };
