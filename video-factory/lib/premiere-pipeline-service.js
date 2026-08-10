"use strict";

/**
 * Premiere pipeline service — the bridge behind the spec's missing API routes
 * (compile-request, run-packet, write-receipt, evidence/:run_id, styles,
 * assets). It shells out to the same CLIs the operator runs by hand today
 * (compile-premiere-edit-plans.py, run-premiere-operation-packets.js,
 * premiere-live-receipt.py) so the HTTP surface and the manual surface can
 * never drift apart.
 *
 * Safety properties:
 * - Every filesystem path a caller supplies must resolve inside one of the
 *   configured allowed roots (PREMIERE_PATH_OUTSIDE_ALLOWED_ROOTS otherwise).
 * - run-packet starts the runner as a tracked child process and returns a
 *   run id immediately; live progress is read from the evidence dir the
 *   runner itself writes. Nothing here bypasses the runner's safety gates —
 *   quarantine opt-ins must still be passed explicitly per run.
 * - Nothing here publishes or calls provider write APIs.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_RUNNER_ARGS_ALLOWED = new Set([
    "--approve",
    "--preflight-only",
    "--stop-on-error",
    "--only",
    "--skip",
    "--from",
    "--to",
    "--allow-timeline-markers",
    "--allow-bin-organization",
    "--allow-audio-media-placement",
    "--allow-caption-overlay-media",
    "--allow-still-image-timeline-media",
    "--max-still-image-timeline-media",
    "--no-await-queued-exports",
    "--queued-export-wait-ms",
    "--command-timeout-ms",
    "--proxy-url",
]);

class PipelineError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

function defaultSpawn(command, args, options) {
    return spawn(command, args, options);
}

class PremierePipelineService {
    constructor({
        foundryRoot,
        videoFactoryRoot,
        allowedRoots = null,
        python = "python3",
        node = process.execPath,
        spawnImpl = defaultSpawn,
    } = {}) {
        if (!foundryRoot) {
            throw new PipelineError(
                "PREMIERE_PIPELINE_NOT_CONFIGURED",
                "foundryRoot is required (path to the marketing-video-foundry repo)."
            );
        }
        this.foundryRoot = path.resolve(foundryRoot);
        this.videoFactoryRoot = path.resolve(videoFactoryRoot || path.join(__dirname, ".."));
        this.allowedRoots = (allowedRoots || [this.foundryRoot, this.videoFactoryRoot])
            .map((root) => path.resolve(root));
        this.python = python;
        this.node = node;
        this.spawn = spawnImpl;
        this.runs = new Map();
        this.runCounter = 0;
    }

    resolveInsideAllowedRoots(candidate, label) {
        const resolved = path.resolve(String(candidate));
        const ok = this.allowedRoots.some(
            (root) => resolved === root || resolved.startsWith(root + path.sep)
        );
        if (!ok) {
            throw new PipelineError(
                "PREMIERE_PATH_OUTSIDE_ALLOWED_ROOTS",
                `${label} must resolve inside an allowed root.`,
                { path: resolved, allowed_roots: this.allowedRoots }
            );
        }
        return resolved;
    }

    _collect(command, args, { cwd, timeoutMs = 300000 } = {}) {
        return new Promise((resolve) => {
            const child = this.spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { child.kill("SIGTERM"); } catch (_) { /* noop */ }
                    resolve({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
                }
            }, timeoutMs);
            child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
            child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
            child.on("error", (error) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
                }
            });
            child.on("close", (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ code, stdout, stderr });
                }
            });
        });
    }

    static _tail(text, size = 4000) {
        const value = String(text || "");
        return value.length > size ? value.slice(-size) : value;
    }

    static _parseJsonLoose(stdout) {
        const text = String(stdout || "").trim();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (_) {
            const start = text.indexOf("{");
            if (start >= 0) {
                try { return JSON.parse(text.slice(start)); } catch (_ignored) { /* noop */ }
            }
            return null;
        }
    }

    async compileRequest({
        planPath,
        outputDir,
        liveSafeOnly = true,
        legacyNormalize = true,
        requireImportableFiles = true,
    }) {
        const plan = this.resolveInsideAllowedRoots(planPath, "planPath");
        const packets = this.resolveInsideAllowedRoots(outputDir, "outputDir");
        if (!fs.existsSync(plan)) {
            throw new PipelineError("API_RESOURCE_NOT_FOUND", `edit plan not found: ${plan}`);
        }
        fs.mkdirSync(packets, { recursive: true });
        const args = [
            path.join(this.foundryRoot, "scripts", "compile-premiere-edit-plans.py"),
            "--plan", plan,
            "--output-dir", packets,
        ];
        if (legacyNormalize) args.push("--legacy-normalize");
        if (liveSafeOnly) args.push("--live-safe-only");
        if (requireImportableFiles) args.push("--require-importable-files");
        const result = await this._collect(this.python, args, { cwd: this.foundryRoot });
        if (result.code !== 0) {
            throw new PipelineError(
                "PREMIERE_COMPILE_FAILED",
                "edit-plan compilation failed.",
                {
                    exit_code: result.code,
                    stderr_tail: PremierePipelineService._tail(result.stderr),
                    stdout_tail: PremierePipelineService._tail(result.stdout),
                }
            );
        }
        const files = fs.readdirSync(packets)
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => {
                const filePath = path.join(packets, name);
                return { name, path: filePath, bytes: fs.statSync(filePath).size };
            });
        return {
            status: "compiled",
            plan_path: plan,
            output_dir: packets,
            packets: files,
            compiler_output: PremierePipelineService._parseJsonLoose(result.stdout),
        };
    }

    startPacketRun({ packetPath, evidenceDir, extraArgs = [] }) {
        const packet = this.resolveInsideAllowedRoots(packetPath, "packetPath");
        const evidence = this.resolveInsideAllowedRoots(evidenceDir, "evidenceDir");
        if (!fs.existsSync(packet)) {
            throw new PipelineError("API_RESOURCE_NOT_FOUND", `packet not found: ${packet}`);
        }
        for (let index = 0; index < extraArgs.length; index += 1) {
            const flag = String(extraArgs[index]);
            if (flag.startsWith("--")) {
                if (!DEFAULT_RUNNER_ARGS_ALLOWED.has(flag)) {
                    throw new PipelineError(
                        "API_VALIDATION_FAILED",
                        `runner flag not allowed over the API: ${flag}`,
                        { allowed: [...DEFAULT_RUNNER_ARGS_ALLOWED].sort() }
                    );
                }
            }
        }
        fs.mkdirSync(evidence, { recursive: true });
        this.runCounter += 1;
        const runId = `run-${String(this.runCounter).padStart(4, "0")}-${path.basename(evidence)}`;
        const args = [
            path.join(this.videoFactoryRoot, "scripts", "run-premiere-operation-packets.js"),
            "--packet", packet,
            "--evidence-dir", evidence,
            ...extraArgs.map(String),
        ];
        const child = this.spawn(this.node, args, {
            cwd: this.videoFactoryRoot,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });
        const run = {
            run_id: runId,
            packet_path: packet,
            evidence_dir: evidence,
            args: extraArgs.map(String),
            pid: child.pid || null,
            status: "running",
            started_at: new Date().toISOString(),
            finished_at: null,
            exit_code: null,
            stderr_tail: "",
        };
        child.stderr?.on("data", (chunk) => {
            run.stderr_tail = PremierePipelineService._tail(run.stderr_tail + String(chunk), 4000);
        });
        child.on("error", (error) => {
            run.status = "failed";
            run.finished_at = new Date().toISOString();
            run.stderr_tail = PremierePipelineService._tail(`${run.stderr_tail}\n${error.message}`, 4000);
        });
        child.on("close", (code) => {
            run.exit_code = code;
            run.finished_at = new Date().toISOString();
            run.status = code === 0 ? "completed" : "failed";
        });
        this.runs.set(runId, run);
        return { run_id: runId, status: run.status, pid: run.pid, evidence_dir: evidence };
    }

    listRuns() {
        return [...this.runs.values()].map((run) => ({ ...run }));
    }

    getRun(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new PipelineError("PREMIERE_RUN_NOT_FOUND", `unknown run id: ${runId}`);
        }
        return run;
    }

    readEvidence(runIdOrDir) {
        let evidenceDir;
        let run = null;
        if (this.runs.has(runIdOrDir)) {
            run = this.getRun(runIdOrDir);
            evidenceDir = run.evidence_dir;
        } else {
            evidenceDir = this.resolveInsideAllowedRoots(runIdOrDir, "evidence dir");
        }
        if (!fs.existsSync(evidenceDir)) {
            throw new PipelineError("API_RESOURCE_NOT_FOUND", `evidence dir not found: ${evidenceDir}`);
        }
        const readJson = (name) => {
            const filePath = path.join(evidenceDir, name);
            if (!fs.existsSync(filePath)) return null;
            try {
                return JSON.parse(fs.readFileSync(filePath, "utf8"));
            } catch (error) {
                return { error: `unreadable ${name}: ${error.message}` };
            }
        };
        const summary = readJson("run-summary.json");
        const review = readJson("marketing-review.json");
        const operations = fs.readdirSync(evidenceDir)
            .filter((name) => /^op-\d+.*\.json$/.test(name))
            .sort()
            .map((name) => {
                const payload = readJson(name);
                const record = payload && (payload.result || payload);
                return {
                    file: name,
                    operation_id: record?.operation_id
                        || payload?.operation?.operation_id
                        || null,
                    action: record?.action || payload?.operation?.action || null,
                    status: record?.status || null,
                };
            });
        return {
            run: run ? { ...run } : null,
            evidence_dir: evidenceDir,
            run_summary: summary ? {
                status: summary.status,
                counts: summary.counts,
                edit_plan_id: summary.edit_plan_id,
                packet_sha256: summary.packet_sha256 || null,
                started_at: summary.started_at,
                finished_at: summary.finished_at || null,
                preflight_passed: summary.preflight ? Boolean(summary.preflight.passed) : null,
            } : null,
            marketing_review: review ? {
                verdict: review.verdict,
                overallScore: review.overallScore,
                requiredFixes: review.requiredFixes,
            } : null,
            operations,
            executed_packet_present: fs.existsSync(path.join(evidenceDir, "executed-packet.json")),
            receipt_present: fs.existsSync(path.join(evidenceDir, "premiere-production-receipt.json")),
        };
    }

    async writeReceipt({
        renderDir,
        evidenceDir = null,
        receiptPath = null,
        ingestSocialRegistry = null,
        referenceProfileId = null,
        compareGenerationOutputId = null,
    }) {
        const render = this.resolveInsideAllowedRoots(renderDir, "renderDir");
        const args = [
            path.join(this.foundryRoot, "scripts", "premiere-live-receipt.py"),
            "--render-dir", render,
        ];
        if (evidenceDir) args.push("--evidence-dir", this.resolveInsideAllowedRoots(evidenceDir, "evidenceDir"));
        if (receiptPath) args.push("--receipt-path", this.resolveInsideAllowedRoots(receiptPath, "receiptPath"));
        if (ingestSocialRegistry) {
            args.push("--ingest-social-registry", this.resolveInsideAllowedRoots(ingestSocialRegistry, "ingestSocialRegistry"));
        }
        if (referenceProfileId) args.push("--reference-profile-id", String(referenceProfileId));
        if (compareGenerationOutputId) args.push("--compare-generation-output-id", String(compareGenerationOutputId));
        const result = await this._collect(this.python, args, { cwd: this.foundryRoot, timeoutMs: 600000 });
        if (result.code !== 0) {
            throw new PipelineError(
                "PREMIERE_RECEIPT_WRITE_FAILED",
                "live receipt writing failed.",
                {
                    exit_code: result.code,
                    stderr_tail: PremierePipelineService._tail(result.stderr),
                    stdout_tail: PremierePipelineService._tail(result.stdout),
                }
            );
        }
        return {
            status: "written",
            summary: PremierePipelineService._parseJsonLoose(result.stdout),
        };
    }

    getStyles({ styleBankPath = null } = {}) {
        const bankPath = styleBankPath
            ? this.resolveInsideAllowedRoots(styleBankPath, "styleBankPath")
            : path.join(this.foundryRoot, "work", "ops-console", "creator-style-bank.json");
        if (!fs.existsSync(bankPath)) {
            return { style_bank_path: bankPath, present: false, style_profiles: [], recipes: [] };
        }
        let bank;
        try {
            bank = JSON.parse(fs.readFileSync(bankPath, "utf8"));
        } catch (error) {
            throw new PipelineError(
                "API_REQUEST_FAILED", `style bank unreadable: ${error.message}`
            );
        }
        const profiles = (bank.style_profiles || []).map((profile) => ({
            id: profile.id,
            name: profile.name || null,
            pacing: profile.pacing || null,
            caption_style: profile.caption_style || null,
            b_roll_cadence: profile.b_roll_cadence || profile.b_roll_rules || null,
            source: profile.source || profile.creator_id || null,
        }));
        const recipes = (bank.premiere_style_recipes || []).map((recipe) => ({
            id: recipe.id,
            style_profile_id: recipe.style_profile_id || null,
            name: recipe.name || null,
        }));
        return {
            style_bank_path: bankPath,
            present: true,
            style_profiles: profiles,
            recipes,
        };
    }

    getAssets({ editPlanPath }) {
        const plan = this.resolveInsideAllowedRoots(editPlanPath, "editPlanPath");
        if (!fs.existsSync(plan)) {
            throw new PipelineError("API_RESOURCE_NOT_FOUND", `edit plan not found: ${plan}`);
        }
        let payload;
        try {
            payload = JSON.parse(fs.readFileSync(plan, "utf8"));
        } catch (error) {
            throw new PipelineError("API_REQUEST_FAILED", `edit plan unreadable: ${error.message}`);
        }
        const assets = (payload.source_assets || []).map((asset) => {
            const provenance = asset.provenance || {};
            const assetPath = asset.path || null;
            let exists = null;
            let bytes = null;
            if (assetPath) {
                exists = fs.existsSync(assetPath);
                bytes = exists ? fs.statSync(assetPath).size : null;
            }
            return {
                asset_id: asset.asset_id,
                role: asset.role || null,
                kind: asset.kind || null,
                path: assetPath,
                exists,
                bytes,
                rights_basis: provenance.rights_basis || null,
                rights_confirmed: provenance.rights_confirmed ?? null,
                usage_role: provenance.usage_role || null,
                direct_use_eligible: Boolean(
                    provenance.rights_confirmed
                    && ["owned", "licensed", "consented", "public_domain", "generated"]
                        .includes(provenance.rights_basis)
                ),
            };
        });
        const missing = assets.filter((asset) => asset.exists === false);
        return {
            edit_plan_path: plan,
            edit_plan_id: payload.edit_plan_id || null,
            assets,
            counts: {
                total: assets.length,
                missing_files: missing.length,
                direct_use_eligible: assets.filter((asset) => asset.direct_use_eligible).length,
            },
            missing_files: missing.map((asset) => asset.path),
        };
    }
}

module.exports = { PremierePipelineService, PipelineError, DEFAULT_RUNNER_ARGS_ALLOWED };
