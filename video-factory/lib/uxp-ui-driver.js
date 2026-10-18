const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DRIVER = path.join(__dirname, "../scripts/uxp-ui-driver.py");
const ERROR_LOG = path.join(__dirname, "../work/uxp-ui-driver-errors.jsonl");

class UxpUiDriverError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = "UxpUiDriverError";
        this.code = code || "UXP_UI_DRIVER_FAILED";
        this.details = details;
    }
}

function logFailure(entry) {
    try {
        fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
        fs.appendFileSync(
            ERROR_LOG,
            `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
        );
    } catch {
        // logging is best-effort; never mask the original failure
    }
}

function runDriver(args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        execFile(
            "python3",
            [DRIVER, ...args],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout, stderr) => {
                let parsed = null;
                try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
                if (parsed && parsed.ok) return resolve(parsed);
                const code = (parsed && parsed.error) || "UXP_UI_DRIVER_FAILED";
                const message =
                    (parsed && parsed.message) ||
                    (error && error.message) ||
                    "uxp-ui-driver produced no parseable result";
                const details = {
                    args,
                    driver_result: parsed,
                    stderr: (stderr || "").slice(-2000),
                    exit_error: error ? String(error.message) : null,
                };
                logFailure({ code, message, ...details });
                reject(new UxpUiDriverError(code, message, details));
            }
        );
    });
}

async function inspectUi({ ocr } = {}) {
    return runDriver(ocr ? ["inspect", "--ocr"] : ["inspect"]);
}

async function pluginAction({ row, pluginName, action, verifyTimeoutMs, pollIntervalMs, evidenceDir }) {
    const args = ["click", "--action", String(action)];
    if (pluginName) args.push("--plugin-name", String(pluginName));
    else args.push("--row", String(row));
    if (verifyTimeoutMs) args.push("--verify-timeout-ms", String(verifyTimeoutMs));
    if (pollIntervalMs) args.push("--poll-interval-ms", String(pollIntervalMs));
    if (evidenceDir) args.push("--evidence-dir", evidenceDir);
    return runDriver(args, Math.max(15000, (verifyTimeoutMs || 4000) + 10000));
}

module.exports = { inspectUi, pluginAction, UxpUiDriverError, ERROR_LOG };
