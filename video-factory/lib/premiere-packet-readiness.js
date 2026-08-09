const fs = require("fs");
const path = require("path");
const {
    evaluatePremiereOperationSafety,
} = require("./premiere-operation-safety");
const {
    buildProjectHandoffPlan,
    projectSavePlanned,
    requestedProjectFromOperations,
} = require("./premiere-project-handoff");

function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

function collectPaths(obj, keys, acc = []) {
    if (Array.isArray(obj)) {
        obj.forEach((value) => collectPaths(value, keys, acc));
    } else if (obj && typeof obj === "object") {
        for (const [key, value] of Object.entries(obj)) {
            if (keys.includes(key)) {
                if (typeof value === "string") acc.push([key, value]);
                else if (Array.isArray(value)) {
                    value.forEach((item) => {
                        if (typeof item === "string") acc.push([key, item]);
                    });
                }
            }
            collectPaths(value, keys, acc);
        }
    }
    return acc;
}

function operationNumber(operation) {
    if (Number.isFinite(operation?.index)) return Number(operation.index) + 1;
    if (Number.isFinite(operation?.step)) return Number(operation.step);
    return null;
}

function selectedOperations(packet, selection = {}) {
    return safeArray(packet?.operations || packet?.premiere_operations).filter((operation) => {
        const human = operationNumber(operation);
        if (human == null) return true;
        return (
            (!selection.only || selection.only.has(human)) &&
            (!selection.skip || !selection.skip.has(human)) &&
            (selection.from == null || human >= selection.from) &&
            (selection.to == null || human <= selection.to)
        );
    });
}

function liveSafetyPolicy(policy = {}) {
    return {
        allowDeclaredUnsafe: Boolean(policy.allowDeclaredUnsafe || policy.allowUnstableLiveOps),
        allowSetVideoClipProperties: Boolean(policy.allowSetVideoClipProperties || policy.allowUnstableLiveOps),
        allowCaptionOverlayMedia: Boolean(policy.allowCaptionOverlayMedia || policy.allowUnstableLiveOps),
        allowStillImageTimelineMedia: Boolean(policy.allowStillImageTimelineMedia || policy.allowUnstableLiveOps),
        maxStillImageTimelineMedia: policy.allowUnstableLiveOps
            ? Number.MAX_SAFE_INTEGER
            : Number(policy.maxStillImageTimelineMedia || 0),
        allowAudioMediaPlacement: Boolean(policy.allowAudioMediaPlacement || policy.allowUnstableLiveOps),
    };
}

async function inspectPremiereState(appManager) {
    const proxyStatus = await appManager.proxyStatus();
    const premiereClients = Number(proxyStatus?.clients?.premiere || 0);
    let responsive = false;
    let project = { hasProject: false };
    let error = null;
    if (premiereClients > 0) {
        try {
            const snapshot = await appManager.adapter.inspectProject();
            responsive = true;
            project = snapshot.project || project;
        } catch (err) {
            error = String(err?.message || err);
        }
    }
    return {
        schemaVersion: 1,
        proxy: {
            running: Boolean(proxyStatus),
            status: proxyStatus,
            premiereClients,
            bridgeConnected: premiereClients > 0,
        },
        premiere: {
            responsive,
            project,
            error,
        },
    };
}

function outputDirectoryErrors(outputs) {
    const errors = [];
    for (const [, output] of outputs) {
        if (!String(output).startsWith("/")) continue;
        try {
            fs.mkdirSync(path.dirname(output), { recursive: true });
        } catch (error) {
            errors.push({
                output,
                directory: path.dirname(output),
                error: String(error?.message || error),
            });
        }
    }
    return errors;
}

function check(id, pass, detail = {}) {
    return { id, pass: Boolean(pass), detail };
}

function evaluatePacketReadiness(packet, premiereState, options = {}) {
    const operations = selectedOperations(packet, options.selection || {});
    const safety = evaluatePremiereOperationSafety(operations, liveSafetyPolicy(options.policy || {}));
    const requestedProject = requestedProjectFromOperations(operations);
    const savePlanned = projectSavePlanned(operations);
    const inputs = collectPaths(operations.map((operation) => operation.command_packet || operation), ["filePaths"]);
    const missing = inputs.filter(([, filePath]) => !fs.existsSync(filePath)).map(([, filePath]) => filePath);
    const outputs = collectPaths(operations.map((operation) => operation.command_packet || operation), ["outputFile", "filePath"]);
    const nonLocal = outputs.filter(([, filePath]) => !String(filePath).startsWith("/")).map(([, filePath]) => filePath);
    const directoryErrors = outputDirectoryErrors(outputs);
    const currentProject = premiereState?.premiere?.project || { hasProject: false };
    const handoffPlan = buildProjectHandoffPlan(currentProject, requestedProject);
    const checks = [
        check("live_operation_safety", safety.passed, {
            selected_operations: operations.length,
            counts: safety.counts,
            policy: safety.policy,
            violations: safety.violations,
        }),
        check("project_save_planned", savePlanned, {
            requested_project: requestedProject,
            error_code: requestedProject && !savePlanned ? "PREMIERE_PROJECT_SAVE_REQUIRED" : null,
        }),
        check("bridge_connected", Boolean(premiereState?.proxy?.bridgeConnected), {
            premiereClients: premiereState?.proxy?.premiereClients || 0,
        }),
        check("premiere_responsive", Boolean(premiereState?.premiere?.responsive), {
            project: premiereState?.premiere?.project || null,
            error: premiereState?.premiere?.error || null,
        }),
        check("source_media_present", missing.length === 0, {
            total: inputs.length,
            present: inputs.length - missing.length,
            missing,
        }),
        check("exports_local_only", nonLocal.length === 0 && packet?.not_published === true, {
            outputs: outputs.map(([, filePath]) => filePath),
            nonLocal,
            not_published: packet?.not_published,
        }),
        check("output_directories_ready", directoryErrors.length === 0, {
            checked: outputs.filter(([, filePath]) => String(filePath).startsWith("/")).length,
            errors: directoryErrors,
        }),
    ];
    return {
        schemaVersion: 1,
        status: checks.every((item) => item.pass) ? "READY_TO_RENDER" : "BLOCKED",
        readyToRender: checks.every((item) => item.pass),
        requestedProject,
        currentProject,
        projectHandoffPlan: handoffPlan,
        checks,
    };
}

module.exports = {
    collectPaths,
    evaluatePacketReadiness,
    inspectPremiereState,
    liveSafetyPolicy,
    selectedOperations,
};
