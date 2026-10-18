const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
    buildProjectHandoffPlan,
    executeProjectHandoff,
    projectSavePlanned,
    requestedProjectFromOperations,
} = require("../lib/premiere-project-handoff");

function op(n, action, options = {}, operationId = `${action}_${n}`) {
    return {
        index: n - 1,
        operation_id: operationId,
        action,
        command_packet: { action, options },
    };
}

test("detects the project requested by createProject and requires a later save", () => {
    const operations = [
        op(1, "createProject", { path: "/tmp/premiere-jobs/launch", name: "launch-cut" }, "create_launch"),
        op(2, "addMediaToSequence", { itemName: "owned-source.mov" }),
    ];

    const requested = requestedProjectFromOperations(operations);

    assert.deepEqual(requested, {
        action: "createProject",
        operation_id: "create_launch",
        name: "launch-cut",
        filePath: path.resolve("/tmp/premiere-jobs/launch/launch-cut.prproj"),
    });
    assert.equal(projectSavePlanned(operations), false);
    assert.equal(projectSavePlanned([...operations, op(3, "saveProject")]), true);
});

test("plans save, close, and verify when a different Premiere project is active", () => {
    const requested = requestedProjectFromOperations([
        op(1, "openProject", { filePath: "/tmp/new-marketing-project.prproj" }, "open_new"),
        op(2, "saveProject"),
    ]);
    const plan = buildProjectHandoffPlan({
        hasProject: true,
        name: "previous",
        path: "/tmp/previous-project.prproj",
    }, requested);

    assert.equal(plan.mode, "SAVE_AND_CLOSE_ACTIVE_PROJECT");
    assert.equal(plan.skipOpeningOperation, false);
    assert.deepEqual(plan.steps.map((step) => step.action), [
        "saveProject",
        "closeProject",
        "getProjectInfo",
    ]);
});

test("skips the opening operation when Premiere already has the requested project active", () => {
    const requested = requestedProjectFromOperations([
        op(1, "createProject", { path: "/tmp/current", name: "campaign-edit" }, "create_campaign"),
        op(2, "saveProject"),
    ]);
    const plan = buildProjectHandoffPlan({
        hasProject: true,
        name: "campaign-edit",
        path: "/tmp/current/campaign-edit.prproj",
    }, requested);

    assert.equal(plan.mode, "REQUESTED_PROJECT_ALREADY_ACTIVE");
    assert.equal(plan.skipOpeningOperation, true);
    assert.deepEqual(plan.skipOperationIds, ["create_campaign"]);
    assert.deepEqual(plan.steps, []);
});

test("executes project handoff commands in order and records the final closed state", async () => {
    const calls = [];
    const receipt = await executeProjectHandoff({
        proxyUrl: "http://127.0.0.1:3031",
        timeoutMs: 1000,
        currentProject: { hasProject: true, name: "old", path: "/tmp/old.prproj" },
        requestedProject: {
            action: "openProject",
            operation_id: "open_new",
            name: "new",
            filePath: "/tmp/new.prproj",
        },
        sendCommand: async (_proxyUrl, action, options, _timeoutMs) => {
            calls.push({ action, options });
            return {
                ok: true,
                status: "SUCCESS",
                durationMs: 1,
                packet: { response: action === "getProjectInfo" ? { hasProject: false } : {} },
            };
        },
    });

    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, "PROJECT_HANDOFF_COMPLETE");
    assert.deepEqual(calls.map((call) => call.action), ["saveProject", "closeProject", "getProjectInfo"]);
    assert.deepEqual(receipt.finalProject, {
        hasProject: false,
        name: null,
        path: null,
        rawPath: null,
    });
});

test("fails closed when Premiere cannot save the active project before switching", async () => {
    const receipt = await executeProjectHandoff({
        proxyUrl: "http://127.0.0.1:3031",
        timeoutMs: 1000,
        currentProject: { hasProject: true, name: "old", path: "/tmp/old.prproj" },
        requestedProject: {
            action: "openProject",
            operation_id: "open_new",
            name: "new",
            filePath: "/tmp/new.prproj",
        },
        sendCommand: async (_proxyUrl, action) => ({
            ok: action !== "saveProject",
            status: action === "saveProject" ? "ERROR" : "SUCCESS",
            durationMs: 1,
            message: "save failed",
            packet: { response: {} },
        }),
    });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.status, "PROJECT_HANDOFF_FAILED");
    assert.equal(receipt.executed.length, 1);
    assert.equal(receipt.failedStep.action, "saveProject");
});

test("fails closed when close verification still shows the previous project active", async () => {
    const receipt = await executeProjectHandoff({
        proxyUrl: "http://127.0.0.1:3031",
        timeoutMs: 1000,
        currentProject: { hasProject: true, name: "old", path: "/tmp/old.prproj" },
        requestedProject: {
            action: "createProject",
            operation_id: "create_new",
            name: "new",
            filePath: "/tmp/new.prproj",
        },
        sendCommand: async (_proxyUrl, action) => ({
            ok: true,
            status: "SUCCESS",
            durationMs: 1,
            packet: {
                response: action === "getProjectInfo"
                    ? { hasProject: true, name: "old", path: "/tmp/old.prproj" }
                    : {},
            },
        }),
    });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.status, "PROJECT_HANDOFF_FAILED");
    assert.equal(receipt.failedStep.status, "PROJECT_CLOSE_VERIFY_FAILED");
});
