const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  finalizeExportResultFromFile,
  shouldWaitForExportFile,
} = require("../scripts/run-premiere-operation-packets");

function tempOutput(name = "out.mp4") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-runner-export-"));
  return path.join(dir, name);
}

const cfg = {
  exportRecoveryWaitMs: 250,
  exportRecoveryPollMs: 1,
  exportRecoveryStableMs: 0,
};

test("export file wait is required for started AME exports", () => {
  assert.equal(
    shouldWaitForExportFile(
      { outputFile: "/tmp/out.mp4", exportType: "QUEUE_TO_AME", startQueueImmediately: true },
      { ok: true, status: "SUCCESS" }
    ),
    true
  );
  // Audit F-06: AME-queued exports are awaited by default now — a queue-accept
  // alone is no longer treated as evidence the file rendered.
  assert.equal(
    shouldWaitForExportFile(
      { outputFile: "/tmp/out.mp4", exportType: "QUEUE_TO_AME", startQueueImmediately: false },
      { ok: true, status: "SUCCESS" }
    ),
    true
  );
  assert.equal(
    shouldWaitForExportFile(
      { outputFile: "/tmp/out.mp4", exportType: "QUEUE_TO_AME", startQueueImmediately: false },
      { ok: true, status: "SUCCESS" },
      { awaitQueuedExports: false }
    ),
    false
  );
});

test("queued export opted out of awaiting records explicit not-awaited evidence", async () => {
  const outputFile = tempOutput();
  const result = await finalizeExportResultFromFile(
    { action: "exportSequence" },
    { outputFile, exportType: "QUEUE_TO_AME", startQueueImmediately: false },
    { ok: true, status: "SUCCESS", durationMs: 12 },
    { ...cfg, awaitQueuedExports: false }
  );
  assert.equal(result.ok, true);
  assert.equal(result.exportFile.code, "EXPORT_QUEUED_NOT_AWAITED");
  assert.equal(result.exportFile.awaited, false);
});

test("queued export without startQueueImmediately is awaited and verified by default", async () => {
  const outputFile = tempOutput();
  fs.writeFileSync(outputFile, Buffer.alloc(96, 1));
  const result = await finalizeExportResultFromFile(
    { action: "exportSequence" },
    { outputFile, exportType: "QUEUE_TO_AME", startQueueImmediately: false },
    { ok: true, status: "SUCCESS", durationMs: 12 },
    { ...cfg, queuedExportWaitMs: 250 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.exportFile.code, "EXPORT_FILE_STABLE_AFTER_SUCCESS_RESPONSE");
  assert.equal(result.exportFile.bytes, 96);
});

test("successful export command records stable output file evidence", async () => {
  const outputFile = tempOutput();
  fs.writeFileSync(outputFile, Buffer.alloc(64, 1));
  const result = await finalizeExportResultFromFile(
    { action: "exportSequence" },
    { outputFile, exportType: "QUEUE_TO_AME", startQueueImmediately: true },
    { ok: true, status: "SUCCESS", durationMs: 12 },
    cfg
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.exportFile.code, "EXPORT_FILE_STABLE_AFTER_SUCCESS_RESPONSE");
  assert.equal(result.exportFile.outputFile, outputFile);
  assert.equal(result.exportFile.bytes, 64);
});

test("successful export command fails approval when output file never appears", async () => {
  const outputFile = tempOutput();
  const result = await finalizeExportResultFromFile(
    { action: "exportSequence" },
    { outputFile, exportType: "QUEUE_TO_AME", startQueueImmediately: true },
    { ok: true, status: "SUCCESS", durationMs: 12 },
    cfg
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "EXPORT_FILE_NOT_STABLE_AFTER_SUCCESS_RESPONSE");
  assert.equal(result.exportFile.exists, false);
});

test("timed out export command can recover from a stable output file", async () => {
  const outputFile = tempOutput();
  fs.writeFileSync(outputFile, Buffer.alloc(128, 1));
  const result = await finalizeExportResultFromFile(
    { action: "exportSequence" },
    { outputFile, exportType: "QUEUE_TO_AME", startQueueImmediately: true },
    { ok: false, status: "TIMEOUT", durationMs: 120000 },
    cfg
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "EXPORT_FILE_STABLE_AFTER_RESPONSE_TIMEOUT");
  assert.equal(result.recovery.code, "EXPORT_FILE_STABLE_AFTER_RESPONSE_TIMEOUT");
  assert.equal(result.exportFile.bytes, 128);
});

const { finalizeExportFrameResult } = require("../scripts/run-premiere-operation-packets");

test("exportFrame repairs a doubled-extension frame back to the requested path", () => {
  const requested = tempOutput("canary-first.png");
  fs.writeFileSync(`${requested}.png`, Buffer.alloc(32, 1));
  const result = finalizeExportFrameResult(
    { action: "exportFrame" },
    { filePath: requested },
    { ok: true, status: "SUCCESS" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.qcFrame.written_path, requested);
  assert.equal(result.qcFrame.renamed, true);
  assert.equal(fs.existsSync(requested), true);
  assert.equal(fs.existsSync(`${requested}.png`), false);
});

test("exportFrame success without a frame on disk fails the operation", () => {
  const requested = tempOutput("missing-frame.png");
  const result = finalizeExportFrameResult(
    { action: "exportFrame" },
    { filePath: requested },
    { ok: true, status: "SUCCESS" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "QC_FRAME_NOT_ON_DISK_AFTER_SUCCESS_RESPONSE");
});

test("exportFrame written at the requested path records plain evidence", () => {
  const requested = tempOutput("ok-frame.png");
  fs.writeFileSync(requested, Buffer.alloc(48, 1));
  const result = finalizeExportFrameResult(
    { action: "exportFrame" },
    { filePath: requested },
    { ok: true, status: "SUCCESS" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.qcFrame.renamed, false);
  assert.equal(result.qcFrame.bytes, 48);
});
