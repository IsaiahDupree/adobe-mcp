const path = require("path");

const PROJECT_OPEN_ACTIONS = new Set(["createProject", "openProject"]);
const PROJECT_SAVE_ACTIONS = new Set(["saveProject", "saveProjectAs"]);

function operationAction(operation) {
    return operation?.command_packet?.action || operation?.action || null;
}

function operationOptions(operation) {
    return operation?.command_packet?.options || operation?.options || {};
}

function normalizeProjectPath(value) {
    if (!value || typeof value !== "string") return null;
    return path.resolve(value);
}

function createProjectFilePath(options) {
    if (!options?.path || !options?.name) return null;
    return normalizeProjectPath(path.join(String(options.path), `${options.name}.prproj`));
}

function requestedProjectFromOperation(operation) {
    const action = operationAction(operation);
    if (!PROJECT_OPEN_ACTIONS.has(action)) return null;
    const options = operationOptions(operation);
    if (action === "createProject") {
        return {
            action,
            operation_id: operation.operation_id || null,
            name: options.name || null,
            filePath: createProjectFilePath(options),
        };
    }
    return {
        action,
        operation_id: operation.operation_id || null,
        name: options.name || (options.filePath ? path.basename(options.filePath, path.extname(options.filePath)) : null),
        filePath: normalizeProjectPath(options.filePath),
    };
}

function requestedProjectFromOperations(operations) {
    for (const operation of operations || []) {
        const requested = requestedProjectFromOperation(operation);
        if (requested) return requested;
    }
    return null;
}

function projectSavePlanned(operations) {
    const requestedProject = requestedProjectFromOperations(operations);
    if (!requestedProject) return true;
    return (operations || []).some((operation) => PROJECT_SAVE_ACTIONS.has(operationAction(operation)));
}

function currentProjectSnapshot(projectInfo) {
    const hasProject = Boolean(projectInfo?.hasProject);
    return {
        hasProject,
        name: projectInfo?.name || null,
        path: normalizeProjectPath(projectInfo?.path),
        rawPath: projectInfo?.path || null,
    };
}

function projectsMatch(currentProject, requestedProject) {
    const current = currentProjectSnapshot(currentProject);
    if (!current.hasProject || !requestedProject) return false;
    const requestedPath = normalizeProjectPath(requestedProject.filePath);
    if (current.path && requestedPath) return current.path === requestedPath;
    if (current.name && requestedProject.name) return current.name === requestedProject.name;
    return false;
}

function projectSnapshotsMatch(leftProject, rightProject) {
    const left = currentProjectSnapshot(leftProject);
    const right = currentProjectSnapshot(rightProject);
    if (!left.hasProject || !right.hasProject) return false;
    if (left.path && right.path) return left.path === right.path;
    if (left.name && right.name) return left.name === right.name;
    return false;
}

function buildProjectHandoffPlan(currentProject, requestedProject) {
    const current = currentProjectSnapshot(currentProject);
    if (!requestedProject) {
        return {
            mode: "NO_REQUESTED_PROJECT",
            skipOpeningOperation: false,
            skipOperationIds: [],
            currentProject: current,
            requestedProject: null,
            steps: [],
        };
    }
    if (!current.hasProject) {
        return {
            mode: "NO_ACTIVE_PROJECT",
            skipOpeningOperation: false,
            skipOperationIds: [],
            currentProject: current,
            requestedProject,
            steps: [],
        };
    }
    if (projectsMatch(currentProject, requestedProject)) {
        return {
            mode: "REQUESTED_PROJECT_ALREADY_ACTIVE",
            skipOpeningOperation: true,
            skipOperationIds: requestedProject.operation_id ? [requestedProject.operation_id] : [],
            currentProject: current,
            requestedProject,
            steps: [],
        };
    }
    return {
        mode: "SAVE_AND_CLOSE_ACTIVE_PROJECT",
        skipOpeningOperation: false,
        skipOperationIds: [],
        currentProject: current,
        requestedProject,
        steps: [
            { action: "saveProject", options: {}, required: true },
            { action: "closeProject", options: {}, required: true },
            { action: "getProjectInfo", options: {}, required: true, verify: "closed_or_changed" },
        ],
    };
}

function handoffStepRecord(step, result) {
    return {
        action: step.action,
        required: step.required !== false,
        status: result?.status || "UNKNOWN",
        ok: Boolean(result?.ok),
        duration_ms: result?.durationMs ?? null,
        message: result?.message || result?.packet?.message || null,
        response: result?.packet?.response || null,
    };
}

async function executeProjectHandoff({ sendCommand, proxyUrl, timeoutMs, currentProject, requestedProject }) {
    const plan = buildProjectHandoffPlan(currentProject, requestedProject);
    const executed = [];
    const receipt = {
        status: "PROJECT_HANDOFF_NOT_REQUIRED",
        ok: true,
        plan,
        executed,
        skipOperationIds: plan.skipOperationIds,
    };
    if (!plan.steps.length) {
        if (plan.mode === "REQUESTED_PROJECT_ALREADY_ACTIVE") {
            receipt.status = "PROJECT_ALREADY_ACTIVE";
        }
        return receipt;
    }
    for (const step of plan.steps) {
        const result = await sendCommand(proxyUrl, step.action, step.options || {}, timeoutMs);
        const record = handoffStepRecord(step, result);
        executed.push(record);
        if (!result.ok) {
            receipt.status = "PROJECT_HANDOFF_FAILED";
            receipt.ok = false;
            receipt.failedStep = record;
            return receipt;
        }
        if (step.verify === "closed_or_changed") {
            const after = result.packet?.response || {};
            const stillSame = projectSnapshotsMatch(after, plan.currentProject);
            if (after.hasProject && stillSame) {
                receipt.status = "PROJECT_HANDOFF_FAILED";
                receipt.ok = false;
                receipt.failedStep = {
                    ...record,
                    status: "PROJECT_CLOSE_VERIFY_FAILED",
                    message: "Premiere still reports the previous project as active after closeProject.",
                };
                return receipt;
            }
            receipt.finalProject = currentProjectSnapshot(after);
        }
    }
    receipt.status = "PROJECT_HANDOFF_COMPLETE";
    return receipt;
}

module.exports = {
    buildProjectHandoffPlan,
    createProjectFilePath,
    executeProjectHandoff,
    normalizeProjectPath,
    operationAction,
    operationOptions,
    projectSnapshotsMatch,
    projectSavePlanned,
    projectsMatch,
    requestedProjectFromOperation,
    requestedProjectFromOperations,
};
