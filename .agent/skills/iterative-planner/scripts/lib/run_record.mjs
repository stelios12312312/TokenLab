// run_record.mjs - runner-bound artifact provenance helpers.

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";

const DEFAULT_PRODUCER = "verification_runner";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => key !== "run_record")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadContentHash(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeExecution(execution = {}) {
  const exitCode = execution.exit_code ?? execution.exitCode ?? execution.code;
  return {
    producer: execution.producer || DEFAULT_PRODUCER,
    row_id: execution.row_id || execution.rowId || null,
    command: String(execution.command || "").trim(),
    exit_code: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    timestamp: execution.timestamp || execution.finished_at || execution.finishedAt || new Date().toISOString(),
    started_at: execution.started_at || execution.startedAt || null,
    finished_at: execution.finished_at || execution.finishedAt || null,
  };
}

function buildRunRecord(payload, execution = {}) {
  const normalized = normalizeExecution(execution);
  return {
    producer: normalized.producer,
    row_id: normalized.row_id,
    command: normalized.command,
    exit_code: normalized.exit_code,
    timestamp: normalized.timestamp,
    ...(normalized.started_at ? { started_at: normalized.started_at } : {}),
    ...(normalized.finished_at ? { finished_at: normalized.finished_at } : {}),
    content_hash: payloadContentHash(payload),
  };
}

function stampRunRecordPayload(payload, execution = {}) {
  const target = asObject(payload);
  target.run_record = buildRunRecord(target, execution);
  return target;
}

function readJsonArtifact(filePath) {
  if (!existsSync(filePath)) return { ok: false, reason: "artifact_missing" };
  try {
    return { ok: true, parsed: JSON.parse(readFileSync(filePath, "utf-8")) };
  } catch (error) {
    return { ok: false, reason: "artifact_json_invalid", detail: error?.message || "invalid JSON" };
  }
}

function stampJsonRunRecordFile(filePath, execution = {}) {
  const loaded = readJsonArtifact(filePath);
  if (!loaded.ok) return { ok: false, path: filePath, reason: loaded.reason, detail: loaded.detail || null };
  const stamped = stampRunRecordPayload(loaded.parsed, execution);
  writeFileSync(filePath, `${JSON.stringify(stamped, null, 2)}\n`);
  return {
    ok: true,
    path: filePath,
    content_hash: stamped.run_record.content_hash,
    run_record: stamped.run_record,
  };
}

function validateRunRecordBinding(payload, {
  expectedProducer = DEFAULT_PRODUCER,
  requireExitZero = true,
} = {}) {
  const doc = asObject(payload);
  const record = asObject(doc.run_record);
  const issues = [];

  if (Object.keys(record).length === 0) {
    return {
      valid: false,
      status: "missing",
      issues: ["run_record_missing"],
      record: null,
      content_hash: payloadContentHash(doc),
    };
  }

  if (record.producer !== expectedProducer) issues.push("run_record_producer_invalid");
  if (!record.command || typeof record.command !== "string") issues.push("run_record_command_missing");
  if (!Number.isFinite(Number(record.exit_code))) issues.push("run_record_exit_code_missing");
  else if (requireExitZero && Number(record.exit_code) !== 0) issues.push("run_record_exit_nonzero");
  if (!record.timestamp || Number.isNaN(Date.parse(record.timestamp))) issues.push("run_record_timestamp_missing");

  const expectedHash = payloadContentHash(doc);
  if (!record.content_hash || typeof record.content_hash !== "string") {
    issues.push("run_record_content_hash_missing");
  } else if (record.content_hash !== expectedHash) {
    issues.push("run_record_content_hash_mismatch");
  }

  return {
    valid: issues.length === 0,
    status: issues.length === 0 ? "valid" : "invalid",
    issues,
    record,
    content_hash: expectedHash,
  };
}

export {
  buildRunRecord,
  payloadContentHash,
  stampJsonRunRecordFile,
  stampRunRecordPayload,
  validateRunRecordBinding,
};
