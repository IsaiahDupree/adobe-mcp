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

const PROXY_URL = process.env.PREMIERE_PROXY_URL || "http://127.0.0.1:3031";

function parseArgs(argv) {
  const out = { proxyUrl: PROXY_URL, commandTimeoutMs: 20000, stopOnError: false };
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

function recoverExportResultFromFile(op, options, result) {
  if (op.action !== "exportSequence" || result.ok || !options.outputFile) return result;
  if (result.status !== "TIMEOUT") return result;
  try {
    const stat = fs.statSync(options.outputFile);
    if (stat.size <= 0) return result;
    return {
      ...result,
      ok: true,
      status: "EXPORT_FILE_CREATED_RESPONSE_TIMEOUT",
      message: (
        "Premiere did not return a bridge response before timeout, "
        + "but the requested export file exists on disk."
      ),
      recovered: true,
      recovery: {
        code: "EXPORT_FILE_CREATED_RESPONSE_TIMEOUT",
        outputFile: options.outputFile,
        bytes: stat.size,
      },
    };
  } catch (_) {
    return result;
  }
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

  // 2. Premiere responds to a read-only probe
  const probe = await sendCommand(cfg.proxyUrl, "getProjectInfo", {}, cfg.commandTimeoutMs);
  add("premiere_responsive", probe.ok, {
    status: probe.status,
    durationMs: probe.durationMs,
    project: probe.packet && probe.packet.response,
  });

  // 3. source media present on disk
  const inputs = collectPaths(doc.operations.map((o) => o.command_packet), ["filePaths"]);
  const missing = inputs.filter(([, p]) => !fs.existsSync(p)).map(([, p]) => p);
  add("source_media_present", missing.length === 0, {
    total: inputs.length,
    present: inputs.length - missing.length,
    missing,
  });

  // 4. export targets are local paths, nothing published
  const outputs = collectPaths(doc.operations.map((o) => o.command_packet), ["outputFile", "filePath"]);
  const nonLocal = outputs.filter(([, p]) => !p.startsWith("/")).map(([, p]) => p);
  add("exports_local_only", nonLocal.length === 0 && doc.not_published === true, {
    outputs: outputs.map(([, p]) => p),
    nonLocal,
    not_published: doc.not_published,
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

    const options = resolvePlaceholders(op.command_packet.options || {}, symbols);
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

    const result = recoverExportResultFromFile(
      op,
      options,
      await sendCommand(cfg.proxyUrl, op.command_packet.action, options, cfg.commandTimeoutMs)
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
        const resp = result.packet && result.packet.response;
        const val = resp && (resp[idField] != null ? resp[idField] : (resp.sequence && resp.sequence[idField]));
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
