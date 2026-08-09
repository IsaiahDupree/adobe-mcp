#!/usr/bin/env node
/**
 * Review a Premiere operation packet/run summary as a marketing representative.
 *
 * This is intentionally artifact-only: it does not call Premiere, UXP, providers,
 * or publishing APIs. It reads local evidence and writes a deterministic review.
 */
const fs = require("fs");
const path = require("path");
const {
    MarketingDepartmentRepresentative,
} = require("../lib/marketing-review-judge");

function usage() {
    console.error(`Usage:
  node scripts/review-premiere-edit.js \\
    --packet /absolute/path/packet.json \\
    --run-summary /absolute/path/run-summary.json \\
    [--output /absolute/path/export.mp4] \\
    [--width 1080 --height 1920] \\
    [--duration-seconds 20] \\
    [--qc-frame /absolute/path/frame-a.png --qc-frame /absolute/path/frame-b.png] \\
    [--write /absolute/path/marketing-review.json]`);
}

function parseArgs(argv) {
    const out = {
        qcFrames: [],
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case "--packet":
                out.packet = next();
                break;
            case "--run-summary":
                out.runSummary = next();
                break;
            case "--output":
                out.output = next();
                break;
            case "--width":
                out.width = Number(next());
                break;
            case "--height":
                out.height = Number(next());
                break;
            case "--duration-seconds":
                out.durationSeconds = Number(next());
                break;
            case "--qc-frame":
                out.qcFrames.push(next());
                break;
            case "--write":
                out.write = next();
                break;
            case "-h":
            case "--help":
                out.help = true;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return out;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function selectedOperations(packet) {
    return Array.isArray(packet.operations)
        ? packet.operations
        : Array.isArray(packet.premiere_operations)
            ? packet.premiere_operations
            : [];
}

function opOptions(operation) {
    return operation?.command_packet?.options || operation?.options || operation?.sent_options || {};
}

function findExportPath(packet, runSummary, providedOutput) {
    if (providedOutput) return path.resolve(providedOutput);
    if (packet?.outputs?.export_path) return path.resolve(packet.outputs.export_path);
    const packetExport = selectedOperations(packet).find((operation) =>
        (operation.action || operation?.command_packet?.action) === "exportSequence"
    );
    if (packetExport) {
        const output = opOptions(packetExport).outputFile;
        if (output) return path.resolve(output);
    }
    const runExport = (runSummary.executed || []).find((record) => record.action === "exportSequence");
    if (runExport) {
        const output = runExport?.sent_options?.outputFile || runExport?.response?.outputFile;
        if (output) return path.resolve(output);
    }
    return null;
}

function findQcFrames(packet, providedFrames) {
    const frames = new Set(providedFrames.map((item) => path.resolve(item)));
    for (const frame of packet?.outputs?.qc_frames || []) {
        if (frame) frames.add(path.resolve(frame));
    }
    for (const operation of selectedOperations(packet)) {
        const action = operation.action || operation?.command_packet?.action;
        if (action !== "exportFrame") continue;
        const filePath = opOptions(operation).filePath;
        if (filePath) frames.add(path.resolve(filePath));
    }
    return Array.from(frames);
}

function enrichPacket(packet, { outputPath, qcFrames }) {
    return {
        ...packet,
        outputs: {
            ...(packet.outputs || {}),
            export_path: packet?.outputs?.export_path || outputPath,
            qc_frames: packet?.outputs?.qc_frames || qcFrames,
        },
    };
}

function outputMeasurement(packet, cfg, outputPath) {
    const platform = packet.platform_format || {};
    return {
        path: outputPath,
        width: Number.isFinite(cfg.width) ? cfg.width : packet?.outputs?.resolution?.width,
        height: Number.isFinite(cfg.height) ? cfg.height : packet?.outputs?.resolution?.height,
        durationSeconds: Number.isFinite(cfg.durationSeconds)
            ? cfg.durationSeconds
            : packet?.outputs?.duration_seconds || platform.target_duration_seconds,
    };
}

function main() {
    const cfg = parseArgs(process.argv);
    if (cfg.help) {
        usage();
        return;
    }
    if (!cfg.packet || !cfg.runSummary) {
        usage();
        process.exitCode = 2;
        return;
    }
    const packet = readJson(cfg.packet);
    const runSummary = readJson(cfg.runSummary);
    const outputPath = findExportPath(packet, runSummary, cfg.output);
    const qcFrames = findQcFrames(packet, cfg.qcFrames);
    const reviewPacket = enrichPacket(packet, { outputPath, qcFrames });
    const review = new MarketingDepartmentRepresentative().review({
        packet: reviewPacket,
        runSummary,
        outputMeasurement: outputMeasurement(reviewPacket, cfg, outputPath),
        qcFrames,
    });
    if (cfg.write) {
        const destination = path.resolve(cfg.write);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `${JSON.stringify(review, null, 2)}\n`, "utf8");
        review.reviewPath = destination;
    }
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    if (review.verdict !== "APPROVED_FOR_INTERNAL_MARKETING_HANDOFF") {
        process.exitCode = 10;
    }
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message || error);
    process.exit(1);
}
