#!/usr/bin/env node
/**
 * Execute a compiled Premiere UXP operation packet file against the live
 * Premiere bridge, one command_packet at a time, with per-operation receipts.
 *
 * Live-execution gate (docs/PREMIERE_EDITING_BENCHMARK.md) is enforced in
 * preflight: Premiere responsive, bridge connected, source files present,
 * export target local, explicit --approve flag recorded.
 *
 * Usage:
 *   node scripts/run-premiere-operation-packets.js \
 *     --packet <ops.json> --evidence-dir <dir> [--approve]
 *     [--preflight-only] [--only 1,2,3] [--skip 27] [--from N] [--to N]
 *     [--stop-on-error] [--command-timeout-ms 20000]
 */
const fs = require("fs");
const path = require("path");
const { io } = require(path.join(__dirname, "../../proxy-server/node_modules/socket.io-client"));
const {
  evaluatePremiereOperationSafety,
} = require("../lib/premiere-operation-safety");
const {
  executeProjectHandoff,
  projectSavePlanned,
  requestedProjectFromOperations,
} = require("../lib/premiere-project-handoff");

const PROXY_URL = process.env.PREMIERE_PROXY_URL || "http://127.0.0.1:3031";

function parseArgs(argv) {
  const out = {
    proxyUrl: PROXY_URL,
    commandTimeoutMs: 20000,
    stopOnError: false,
    exportRecoveryWaitMs: 45000,
    exportRecoveryPollMs: 500,
    exportRecoveryStableMs: 1500,
    allowDeclaredUnsafe: false,
    allowUnstableLiveOps: false,
    allowCaptionOverlayMedia: false,
    allowStillImageTimelineMedia: false,
    maxStillImageTimelineMedia: 0,
    allowAudioMediaPlacement: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--packet": out.packet = next(); break;
      case "--evidence-dir": out.evidenceDir = next(); break;
      case "--approve": out.approve = true; break;
      case "--preflight-only": out.preflightOnly = true; break;
      case "--stop-on-error": out.stopOnError = true; break;
      case "--command-timeout-ms": out.commandTimeoutMs = Number(next()); break;
      case "--export-recovery-wait-ms": out.exportRecoveryWaitMs = Number(next()); break;
      case "--export-recovery-poll-ms": out.exportRecoveryPollMs = Number(next()); break;
      case "--export-recovery-stable-ms": out.exportRecoveryStableMs = Number(next()); break;
      case "--allow-declared-unsafe": out.allowDeclaredUnsafe = true; break;
      case "--allow-unstable-live-ops": out.allowUnstableLiveOps = true; break;
      case "--allow-caption-overlay-media": out.allowCaptionOverlayMedia = true; break;
      case "--allow-still-image-timeline-media": out.allowStillImageTimelineMedia = true; break;
      case "--max-still-image-timeline-media": out.maxStillImageTimelineMedia = Number(next()); break;
      case "--allow-audio-media-placement": out.allowAudioMediaPlacement = true; break;
      case "--only": out.only = new Set(next().split(",").map((n) => Number(n.trim()))); break;
      case "--skip": out.skip = new Set(next().split(",").map((n) => Number(n.trim()))); break;
      case "--from": out.from = Number(next()); break;
      case "--to": out.to = Number(next()); break;
      case "--proxy-url": out.proxyUrl = next(); break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!out.packet) throw new Error("--packet is required");
  if (!out.evidenceDir) throw new Error("--evidence-dir is required");
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendCommand(proxyUrl, action, options, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = io(proxyUrl, { transports: ["websocket"], reconnection: false });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve({ ...value, durationMs: Date.now() - started });
    };
    const timer = setTimeout(
      () => finish({ ok: false, status: "TIMEOUT", message: `Timed out waiting for ${action}.` }),
      timeoutMs
    );
    socket.on("connect", () => {
      socket.emit("command_packet", { application: "premiere", command: { action, options } });
    });
    socket.on("packet_response", (packet) => {
      finish({ ok: packet.status === "SUCCESS", status: packet.status || "UNKNOWN", packet });
    });
    socket.on("connect_error", (err) =>
      finish({ ok: false, status: "BRIDGE_UNAVAILABLE", message: String(err && err.message || err) })
    );
  });
}

/** Replace ${operation_id.field} placeholders using results already captured. */
function resolvePlaceholders(value, symbols) {
  if (typeof value === "string") {
    const m = value.match(/^\$\{([^}]+)\}$/);
    if (m) return symbols.has(m[1]) ? symbols.get(m[1]) : value;
    return value.replace(/\$\{([^}]+)\}/g, (full, key) =>
      symbols.has(key) ? String(symbols.get(key)) : full
    );
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, symbols));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, symbols);
    return out;
  }
  return value;
}

function unresolvedPlaceholders(value, found = []) {
  if (typeof value === "string") {
    const m = value.match(/\$\{[^}]+\}/g);
    if (m) found.push(...m);
  } else if (Array.isArray(value)) value.forEach((v) => unresolvedPlaceholders(v, found));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => unresolvedPlaceholders(v, found));
  return found;
}

function operationNumber(op) {
  if (Number.isFinite(op.index)) return Number(op.index) + 1;
  if (Number.isFinite(op.step)) return Number(op.step);
  return null;
}

function operationSelected(op, cfg) {
  const human = operationNumber(op);
  if (human == null) return true;
  return (
    (!cfg.only || cfg.only.has(human)) &&
    (!cfg.skip || !cfg.skip.has(human)) &&
    (cfg.from == null || human >= cfg.from) &&
    (cfg.to == null || human <= cfg.to)
  );
}

function selectedOperations(doc, cfg) {
  return (doc.operations || []).filter((op) => operationSelected(op, cfg));
}

function liveSafetyPolicy(cfg) {
  return {
    allowDeclaredUnsafe: cfg.allowDeclaredUnsafe || cfg.allowUnstableLiveOps,
    allowSetVideoClipProperties: cfg.allowUnstableLiveOps,
    allowCaptionOverlayMedia: cfg.allowCaptionOverlayMedia || cfg.allowUnstableLiveOps,
    allowStillImageTimelineMedia: cfg.allowStillImageTimelineMedia || cfg.allowUnstableLiveOps,
    maxStillImageTimelineMedia: cfg.allowUnstableLiveOps
      ? Number.MAX_SAFE_INTEGER
      : cfg.maxStillImageTimelineMedia,
    allowAudioMediaPlacement: cfg.allowAudioMediaPlacement || cfg.allowUnstableLiveOps,
  };
}

async function waitForStableFile(filePath, waitMs, pollMs, stableMs) {
  const started = Date.now();
  const deadline = started + Math.max(0, waitMs);
  const poll = Math.max(50, pollMs);
  const stableFor = Math.max(0, stableMs);
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() <= deadline) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0 && stat.size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableFor) {
          return {
            exists: true,
            stable: true,
            bytes: stat.size,
            waitedMs: Date.now() - started,
          };
        }
      } else {
        lastSize = stat.size;
        stableSince = stat.size > 0 ? Date.now() : 0;
      }
    } catch (_) {
      lastSize = -1;
      stableSince = 0;
    }
    await sleep(poll);
  }
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: stat.size > 0,
      stable: false,
      bytes: stat.size,
      waitedMs: Date.now() - started,
    };
  } catch (_) {
    return {
      exists: false,
      stable: false,
      bytes: 0,
      waitedMs: Date.now() - started,
    };
  }
}

async function recoverExportResultFromFile(op, options, result, cfg) {
  if (op.action !== "exportSequence" || result.ok || !options.outputFile) return result;
  if (result.status !== "TIMEOUT") return result;
  const file = await waitForStableFile(
    options.outputFile,
    cfg.exportRecoveryWaitMs,
    cfg.exportRecoveryPollMs,
    cfg.exportRecoveryStableMs
  );
  if (file.exists && file.stable) {
    return {
      ...result,
      ok: true,
      status: "EXPORT_FILE_STABLE_AFTER_RESPONSE_TIMEOUT",
      message: (
        "Premiere did not return a bridge response before timeout, "
        + "but the requested export file appeared and stabilized on disk."
      ),
      recovered: true,
      recovery: {
        code: "EXPORT_FILE_STABLE_AFTER_RESPONSE_TIMEOUT",
        outputFile: options.outputFile,
        bytes: file.bytes,
        waitedMs: file.waitedMs,
        stableMs: cfg.exportRecoveryStableMs,
      },
    };
  }
  return {
    ...result,
    recovery: {
      code: "EXPORT_FILE_NOT_STABLE_AFTER_RESPONSE_TIMEOUT",
      outputFile: options.outputFile,
      exists: file.exists,
      bytes: file.bytes,
      waitedMs: file.waitedMs,
    },
  };
}

function collectPaths(obj, keys, acc = []) {
  if (Array.isArray(obj)) obj.forEach((v) => collectPaths(v, keys, acc));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k)) {
        if (typeof v === "string") acc.push([k, v]);
        else if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && acc.push([k, x]));
      }
      collectPaths(v, keys, acc);
    }
  }
  return acc;
}

async function preflight(cfg, doc) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });
  const selected = selectedOperations(doc, cfg);
  const operationSafety = evaluatePremiereOperationSafety(selected, liveSafetyPolicy(cfg));
  const requestedProject = requestedProjectFromOperations(selected);
  const savePlanned = projectSavePlanned(selected);
  add("live_operation_safety", operationSafety.passed, {
    selected_operations: selected.length,
    counts: operationSafety.counts,
    policy: operationSafety.policy,
    violations: operationSafety.violations,
  });
  add("project_save_planned", savePlanned, {
    requested_project: requestedProject,
    error_code: requestedProject && !savePlanned ? "PREMIERE_PROJECT_SAVE_REQUIRED" : null,
    requirement: requestedProject
      ? "Packets that create or open a Premiere project must also include saveProject/saveProjectAs."
      : "No project-open operation selected.",
  });

  // 1. bridge / proxy
  let proxyStatus = null;
  try {
    const r = await fetch(`${cfg.proxyUrl}/status`, { signal: AbortSignal.timeout(3000) });
    proxyStatus = await r.json();
  } catch (e) {
    proxyStatus = { error: String(e && e.message || e) };
  }
  const premiereClients = Number(proxyStatus && proxyStatus.clients && proxyStatus.clients.premiere || 0);
  add("bridge_connected", premiereClients > 0, { proxyUrl: cfg.proxyUrl, premiereClients, proxyStatus });

  // 2. Premiere responds to a read-only probe. Skip even read-only plugin traffic when
  // a packet has already failed the static live-operation safety gate.
  let probe = null;
  if (operationSafety.passed) {
    probe = await sendCommand(cfg.proxyUrl, "getProjectInfo", {}, cfg.commandTimeoutMs);
    add("premiere_responsive", probe.ok, {
      status: probe.status,
      durationMs: probe.durationMs,
      project: probe.packet && probe.packet.response,
    });
  } else {
    add("premiere_responsive", false, {
      status: "SKIPPED_BY_LIVE_OPERATION_SAFETY",
      reason: "Static packet safety failed; no Premiere command was sent.",
    });
  }

  // 3. source media present on disk
  const inputs = collectPaths(selected.map((o) => o.command_packet), ["filePaths"]);
  const missing = inputs.filter(([, p]) => !fs.existsSync(p)).map(([, p]) => p);
  add("source_media_present", missing.length === 0, {
    total: inputs.length,
    present: inputs.length - missing.length,
    missing,
  });

  // 4. export targets are local paths, nothing published
  const outputs = collectPaths(selected.map((o) => o.command_packet), ["outputFile", "filePath"]);
  const nonLocal = outputs.filter(([, p]) => !p.startsWith("/")).map(([, p]) => p);
  add("exports_local_only", nonLocal.length === 0 && doc.not_published === true, {
    outputs: outputs.map(([, p]) => p),
    nonLocal,
    not_published: doc.not_published,
  });

  const outputDirectoryErrors = [];
  for (const [, p] of outputs) {
    if (!p.startsWith("/")) continue;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    } catch (e) {
      outputDirectoryErrors.push({
        output: p,
        directory: path.dirname(p),
        error: String(e && e.message || e),
      });
    }
  }
  add("output_directories_ready", outputDirectoryErrors.length === 0, {
    checked: outputs.filter(([, p]) => p.startsWith("/")).length,
    errors: outputDirectoryErrors,
  });

  // 5. explicit approval recorded
  add("execution_approved", Boolean(cfg.approve), { approveFlag: Boolean(cfg.approve) });

  return { checks, passed: checks.every((c) => c.pass), probe };
}

(async () => {
  const cfg = parseArgs(process.argv);
  const doc = JSON.parse(fs.readFileSync(cfg.packet, "utf8"));
  fs.mkdirSync(cfg.evidenceDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const gate = await preflight(cfg, doc);

  const summary = {
    schema_version: "1.0",
    runner: "run-premiere-operation-packets",
    packet_file: path.resolve(cfg.packet),
    edit_plan_id: doc.edit_plan_id,
    proxy_url: cfg.proxyUrl,
    started_at: startedAt,
    preflight: gate,
    executed: [],
    counts: { total: 0, success: 0, failed: 0, skipped: 0 },
  };

  const writeSummary = () => {
    summary.finished_at = new Date().toISOString();
    fs.writeFileSync(
      path.join(cfg.evidenceDir, "run-summary.json"),
      JSON.stringify(summary, null, 2)
    );
  };

  if (cfg.preflightOnly || !gate.passed) {
    summary.status = cfg.preflightOnly ? "PREFLIGHT_ONLY" : "GATE_BLOCKED";
    writeSummary();
    console.log(JSON.stringify({ status: summary.status, preflight: gate.checks.map(c => ({id: c.id, pass: c.pass})), summaryPath: path.join(cfg.evidenceDir, "run-summary.json") }, null, 2));
    process.exit(gate.passed || cfg.preflightOnly ? 0 : 2);
  }

  const selectedForExecution = selectedOperations(doc, cfg);
  const requestedProject = requestedProjectFromOperations(selectedForExecution);
  summary.project_handoff = await executeProjectHandoff({
    sendCommand,
    proxyUrl: cfg.proxyUrl,
    timeoutMs: cfg.commandTimeoutMs,
    currentProject: gate.probe && gate.probe.packet && gate.probe.packet.response,
    requestedProject,
  });
  const skipProjectOperationIds = new Set(summary.project_handoff.skipOperationIds || []);
  if (!summary.project_handoff.ok) {
    summary.status = "PROJECT_HANDOFF_FAILED";
    writeSummary();
    console.log(JSON.stringify({
      status: summary.status,
      project_handoff: summary.project_handoff,
      summaryPath: path.join(cfg.evidenceDir, "run-summary.json"),
    }, null, 2));
    process.exit(3);
  }

  const symbols = new Map();
  for (const op of doc.operations) {
    const human = op.index + 1;
    const selected =
      (!cfg.only || cfg.only.has(human)) &&
      (!cfg.skip || !cfg.skip.has(human)) &&
      (cfg.from == null || human >= cfg.from) &&
      (cfg.to == null || human <= cfg.to);

    summary.counts.total += 1;
    if (!selected) {
      summary.counts.skipped += 1;
      summary.executed.push({ n: human, operation_id: op.operation_id, action: op.action, status: "SKIPPED_BY_SELECTION" });
      continue;
    }
    if (op.operation_id && skipProjectOperationIds.has(op.operation_id)) {
      summary.counts.skipped += 1;
      summary.executed.push({
        n: human,
        operation_id: op.operation_id,
        action: op.action,
        status: "SKIPPED_PROJECT_ALREADY_ACTIVE",
        message: "Premiere already had the requested project active before this packet started.",
      });
      continue;
    }

    const options = resolvePlaceholders(op.command_packet.options || {}, symbols);
    const opSafety = evaluatePremiereOperationSafety([op], liveSafetyPolicy(cfg));
    if (!opSafety.passed) {
      const record = {
        n: human,
        operation_id: op.operation_id,
        action: op.action,
        declared_safe_to_execute: op.safe_to_execute,
        sent_options: null,
        status: "BLOCKED_BY_LIVE_OPERATION_SAFETY",
        duration_ms: 0,
        message: "Operation was not sent to Premiere.",
        violations: opSafety.violations,
      };
      summary.counts.failed += 1;
      summary.executed.push(record);
      fs.writeFileSync(
        path.join(cfg.evidenceDir, `op-${String(human).padStart(2, "0")}-${op.operation_id}.json`),
        JSON.stringify({ operation: op, result: record }, null, 2)
      );
      console.log(`${String(human).padStart(2, "0")} ${op.action} -> ${record.status} (0ms) :: ${record.message}`);
      if (cfg.stopOnError) break;
      continue;
    }
    const stillUnresolved = unresolvedPlaceholders(options);
    if (stillUnresolved.length) {
      summary.counts.failed += 1;
      summary.executed.push({
        n: human, operation_id: op.operation_id, action: op.action,
        status: "UNRESOLVED_PLACEHOLDER", unresolved: stillUnresolved,
      });
      if (cfg.stopOnError) break;
      continue;
    }

    const result = await recoverExportResultFromFile(
      op,
      options,
      await sendCommand(cfg.proxyUrl, op.command_packet.action, options, cfg.commandTimeoutMs),
      cfg
    );
    const record = {
      n: human,
      operation_id: op.operation_id,
      action: op.action,
      declared_safe_to_execute: op.safe_to_execute,
      sent_options: options,
      status: result.ok ? result.status : result.status,
      duration_ms: result.durationMs,
      message: result.message || (result.packet && result.packet.message) || null,
      response: result.packet ? result.packet.response : null,
      recovery: result.recovery || null,
    };
    fs.writeFileSync(
      path.join(cfg.evidenceDir, `op-${String(human).padStart(2, "0")}-${op.operation_id}.json`),
      JSON.stringify({ operation: op, sent_options: options, result }, null, 2)
    );

    if (result.ok) {
      summary.counts.success += 1;
      const idField = op.metadata && op.metadata.response_id_field;
      const sym = op.metadata && op.metadata.symbolic_sequence_id;
      if (idField && sym) {
        const packet = result.packet || {};
        const resp = packet.response;
        let val = resp && (resp[idField] != null ? resp[idField] : (resp.sequence && resp.sequence[idField]));
        if (val == null && Array.isArray(packet.sequences)) {
          const sequence = packet.sequences.find((item) => item && item.isActive) || packet.sequences[0];
          val = sequence && sequence[idField];
        }
        if (val != null) {
          const key = sym.replace(/^\$\{|\}$/g, "");
          symbols.set(key, val);
          record.captured_symbol = { [key]: val };
        }
      }
    } else {
      summary.counts.failed += 1;
    }

    summary.executed.push(record);
    console.log(`${String(human).padStart(2, "0")} ${op.action} -> ${record.status} (${record.duration_ms}ms)${record.message ? " :: " + record.message : ""}`);
    if (!result.ok && cfg.stopOnError) break;
  }

  summary.status = summary.counts.failed === 0 ? "COMPLETED" : "COMPLETED_WITH_FAILURES";
  writeSummary();
  console.log("\n" + JSON.stringify({ status: summary.status, counts: summary.counts, summaryPath: path.join(cfg.evidenceDir, "run-summary.json") }, null, 2));
})().catch((err) => {
  console.error("RUNNER_ERROR:", err && err.stack || err);
  process.exit(1);
});
