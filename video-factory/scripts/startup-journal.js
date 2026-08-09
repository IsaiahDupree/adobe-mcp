#!/usr/bin/env node

const {
    appendStartupEvent,
    detailsFromPairs,
    initStartupJournal,
    writeStartupSummary,
} = require("../lib/startup-journal");

function usage() {
    console.error(`Usage:
  node scripts/startup-journal.js init [options]
  node scripts/startup-journal.js event --run-dir <path> --phase <name> --status <status> [--message <text>] [--duration-ms <n>] [--detail key=value]
  node scripts/startup-journal.js summary --run-dir <path> --status <status> [--detail key=value]

Init options:
  --root <path>
  --adobe-mcp-root <path>
  --factory-home <path>
  --log-dir <path>
  --startup-log-root <path>
  --run-dir <path>
  --proxy-url <url>
  --factory-url <url>
  --factory-ready-url <url>
  --loader-evidence-dir <path>
  --loader-args-json <json-array>
  --git-branch <branch>
  --git-revision <sha>`);
}

function readOption(args, name, fallback = null) {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function repeatedOptions(args, name) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === name && args[index + 1]) {
            values.push(args[index + 1]);
            index += 1;
        } else if (arg.startsWith(`${name}=`)) {
            values.push(arg.slice(name.length + 1));
        }
    }
    return values;
}

function parseLoaderArgs(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
        // Fall through to the empty arg list.
    }
    return [];
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "--help" || command === "-h") {
        usage();
        process.exitCode = command ? 0 : 1;
        return;
    }

    if (command === "init") {
        const config = initStartupJournal({
            root: readOption(args, "--root"),
            adobeMcpRoot: readOption(args, "--adobe-mcp-root"),
            factoryHome: readOption(args, "--factory-home"),
            logDir: readOption(args, "--log-dir"),
            startupLogRoot: readOption(args, "--startup-log-root"),
            runDir: readOption(args, "--run-dir"),
            proxyUrl: readOption(args, "--proxy-url"),
            factoryUrl: readOption(args, "--factory-url"),
            factoryReadyUrl: readOption(args, "--factory-ready-url"),
            loaderEvidenceDir: readOption(args, "--loader-evidence-dir"),
            loaderArgs: parseLoaderArgs(readOption(args, "--loader-args-json")),
            gitBranch: readOption(args, "--git-branch"),
            gitRevision: readOption(args, "--git-revision"),
        });
        process.stdout.write(`${JSON.stringify({
            runId: config.runId,
            runDir: config.logs.runDir,
            paths: config.logs,
        }, null, 2)}\n`);
        return;
    }

    if (command === "event") {
        const event = appendStartupEvent({
            runDir: readOption(args, "--run-dir"),
            phase: readOption(args, "--phase"),
            status: readOption(args, "--status"),
            message: readOption(args, "--message", ""),
            durationMs: readOption(args, "--duration-ms") === null
                ? null
                : Number(readOption(args, "--duration-ms")),
            details: detailsFromPairs(repeatedOptions(args, "--detail")),
        });
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
    }

    if (command === "summary") {
        const summary = writeStartupSummary({
            runDir: readOption(args, "--run-dir"),
            status: readOption(args, "--status"),
            details: detailsFromPairs(repeatedOptions(args, "--detail")),
        });
        process.stdout.write(`${JSON.stringify({
            runId: summary.runId,
            status: summary.status,
            summaryPath: summary.logs.startupSummary,
            durationMs: summary.durationMs,
        }, null, 2)}\n`);
        return;
    }

    usage();
    process.exitCode = 1;
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
