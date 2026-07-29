// determinism.mjs — Shared determinism helpers for iterative planner scripts.
//
// Provides: state.json R/W, decision logs, output sorting, script hashing,
// failure code emission, JSON Schema validation, and replay support.
//
// All features are gated behind config/determinism.json feature flags.
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, appendFileSync, realpathSync, openSync, closeSync, unlinkSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { debugLog } from "./plan_utils.mjs";
import { buildRepoStateStamp } from "./repo_state_stamp.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

// C1-FIX: Synchronous sleep without SharedArrayBuffer.
// SharedArrayBuffer + Atomics.wait() deadlocks in single-threaded Node.js main loop.
// spawnSync('sleep') delegates to the OS scheduler — no busy-wait, no SAB dependency.
// NOTE: Unix-only — `sleep` command not available on Windows. See F-010.
import { spawnSync } from "child_process";
function sleepMs(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configDir = resolve(__dirname, "..", "..", "config");

let _configCache = null;

/**
 * Load determinism config from config/determinism.json.
 * Returns cached config on subsequent calls.
 */
export function loadConfig() {
  if (_configCache) return _configCache;
  const configPath = join(configDir, "determinism.json");
  try {
    _configCache = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error(`  ⚠️  Config load failed (${e.code || "parse error"}): using built-in defaults. Feature flags may not apply.`);
    debugLog("determinism", `Config load failed: ${e.message} — using defaults`);
    _configCache = { features: {}, escalation_thresholds: {}, timestamps: { format: "iso8601", timezone: "UTC" } };
  }
  return _configCache;
}

/**
 * Check if a feature flag is enabled.
 */
export function isFeatureEnabled(featureName) {
  const config = loadConfig();
  return config.features?.[featureName]?.enabled === true;
}

// ---------------------------------------------------------------------------
// Failure codes
// ---------------------------------------------------------------------------

let _failureCodesCache = null;

/**
 * Load failure codes from config/failure-codes.json.
 */
export function loadFailureCodes() {
  if (_failureCodesCache) return _failureCodesCache;
  const codesPath = join(configDir, "failure-codes.json");
  try {
    _failureCodesCache = JSON.parse(readFileSync(codesPath, "utf-8"));
  } catch (e) {
    console.error(`  ⚠️  Failure codes load failed (${e.code || "parse error"}): gate checks will use inline codes only.`);
    debugLog("determinism", `Failure codes load failed: ${e.message}`);
    _failureCodesCache = { codes: {} };
  }
  return _failureCodesCache;
}

/**
 * Get the failure code string for a check, or null if not found.
 * @param {string} code - e.g. "GATE-EXP-001"
 * @returns {{ code: string, message: string, severity?: string } | null}
 */
export function getFailureCode(code) {
  const registry = loadFailureCodes();
  const entry = registry.codes?.[code];
  if (!entry) return null;
  return { code, ...entry };
}

/**
 * Augment a check result with a failure code if the feature is enabled.
 * Non-destructive: adds `code` field to the result object.
 */
export function withFailureCode(result, code) {
  if (!isFeatureEnabled("failure_codes")) return result;
  if (code) {
    result.code = code;
    const entry = getFailureCode(code);
    const advisory = ["warn", "warning", "advisory"].includes(String(entry?.severity || "").toLowerCase());
    const normalizedGateStatus = normalizeVerificationStatus(result.status, "gate");
    if (normalizedGateStatus.valid && normalizedGateStatus.kind === "fail" && advisory) {
      result.original_status = "FAIL";
      result.status = "WARN";
      result.classification = "advisory";
      result.advisory_conversion = true;
      result.classification_reason = entry?.classification_reason || "Failure-code policy classifies this check as advisory.";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Timestamps (UTC, ISO 8601)
// ---------------------------------------------------------------------------

/**
 * Get current timestamp in canonical format (UTC ISO 8601).
 */
export function nowISO() {
  return new Date().toISOString();
}

/**
 * Get current timestamp without milliseconds for state.md compatibility.
 */
export function nowCompact() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Compute a hash snapshot of the planner knowledge base for close-signal diffing.
 * Returns null when the project root is not available.
 */
export function computeKnowledgeSnapshot(projectRoot) {
  if (!projectRoot) return null;

  const knowledgeDir = join(projectRoot, "plans", "knowledge");
  const files = ["index.md", "mistakes.md", "patterns.md", "gotchas.md"];
  let combined = "";
  const fileHashes = {};

  for (const name of files) {
    const filePath = join(knowledgeDir, name);
    if (!existsSync(filePath)) {
      fileHashes[name] = null;
      continue;
    }
    const content = readFileSync(filePath, "utf-8");
    fileHashes[name] = createHash("sha256").update(content).digest("hex").slice(0, 32);
    combined += `\n--- ${name} ---\n${content}`;
  }

  return {
    captured_at: nowISO(),
    files: fileHashes,
    hash: createHash("sha256").update(combined).digest("hex").slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// State JSON
// ---------------------------------------------------------------------------

/**
 * Legacy helper retained for older tests and migration readers.
 * State hash enforcement was retired by E8-1; callers must not treat this hash
 * as an approval or security boundary.
 */
export function computeStateHash(stateObj) {
  const copy = { ...stateObj };
  delete copy._state_hash;
  return createHash("sha256").update(JSON.stringify(copy, Object.keys(copy).sort())).digest("hex").slice(0, 32);
}

/**
 * Read state.json from a plan directory. Returns parsed object or null.
 */
export function readStateJson(planDir) {
  const statePath = join(planDir, "state.json");
  try {
    // RT10-L1: Enforce size limit on state.json reads (same as other artifacts).
    // Raised to 5MB to accommodate auto-generated close_signals on large programs.
    const STATE_JSON_MAX_BYTES = 5_242_880;
    const st = statSync(statePath);
    if (st.size > STATE_JSON_MAX_BYTES) {
      debugLog("determinism", `state.json exceeds ${STATE_JSON_MAX_BYTES} bytes (${st.size} bytes) — possible inflation attack`);
      return null;
    }
    const obj = JSON.parse(readFileSync(statePath, "utf-8"));
    // RT8-L1: Reject state.json with null/undefined critical fields.
    // Prevents LLM from setting "state": null to bypass source-state checks.
    if (obj && obj.state !== undefined && (obj.state === null || typeof obj.state !== "string")) {
      debugLog("determinism", `state.json has invalid 'state' field (${typeof obj.state}) — treating as corrupt`);
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

/**
 * State hash validation is retired. Legacy `_state_hash` fields are ignored so
 * older plans can transition without a migration dance.
 */
export function validateStateIntegrity(stateObj) {
  if (!stateObj) return { intact: false, reason: "state.json is null" };
  return { intact: true, retired: true, reason: "state hash validation retired by E8-1" };
}

const PHASE_MUTATION_FIELDS = ["state", "phase", "status"];

function readPreviousStateForWrite(statePath) {
  try {
    if (!existsSync(statePath)) return null;
    const st = statSync(statePath);
    const STATE_JSON_MAX_BYTES = 5_242_880;
    if (st.size > STATE_JSON_MAX_BYTES) return null;
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

function callerLooksLikePlannerFixture() {
  const stack = new Error().stack || "";
  return /\/\.agent\/skills\/iterative-planner\/tests\//.test(stack) ||
    process.env.PLANNER_ALLOW_DIRECT_STATE_SETUP === "1" ||
    (process.env.PLANNER_SKIP_SELF_HEAL === "1" && process.env.CODEX_THREAD_ID === "");
}

function phaseMutationDiff(previous, next) {
  if (!previous || !next) return [];
  return PHASE_MUTATION_FIELDS.filter((field) => {
    if (previous[field] === undefined && next[field] === undefined) return false;
    return previous[field] !== next[field];
  });
}

function stampLatestTransitionRecord(stateObj, previousState) {
  // Ensures the latest transition carries a timestamp. The former per-transition
  // `record_hash` was removed: it was computed and stored but never read or verified
  // anywhere, so it manufactured false confidence without adding any tamper-evidence.
  const transitions = Array.isArray(stateObj?.transitions) ? stateObj.transitions : null;
  if (!transitions || transitions.length === 0) return;
  const latest = transitions[transitions.length - 1];
  if (!latest || typeof latest !== "object") return;
  const previousTransitions = Array.isArray(previousState?.transitions) ? previousState.transitions : [];
  if (transitions.length < previousTransitions.length) return;
  if (!latest.timestamp) latest.timestamp = nowISO();
}

/**
 * Write state.json to a plan directory (atomic write via tmp + rename).
 * Only writes if the state_json feature is enabled.
 */
export function writeStateJson(planDir, stateObj, opts = {}) {
  if (!isFeatureEnabled("state_json")) return false;
  const statePath = join(planDir, "state.json");
  const tmpPath = statePath + ".tmp";
  try {
    const previousState = readPreviousStateForWrite(statePath);
    const phaseDiff = phaseMutationDiff(previousState, stateObj);
    const phaseMutationAllowed = opts.allowPhaseMutation === true ||
      opts.phaseMutation === true ||
      process.env._PLANNER_STATE_FUNNEL === "1" ||
      callerLooksLikePlannerFixture();
    if (phaseDiff.length > 0 && !phaseMutationAllowed) {
      debugLog("determinism", `state.json phase/status mutation refused outside funnel (${phaseDiff.join(", ")})`);
      return false;
    }
    stampLatestTransitionRecord(stateObj, previousState);
    stateObj.updated_at = nowISO();
    delete stateObj._state_hash;
    writeFileSync(tmpPath, JSON.stringify(stateObj, null, 2) + "\n");
    renameSync(tmpPath, statePath);
    return true;
  } catch (e) {
    debugLog("determinism", `state.json write failed: ${e.message}`);
    // RT6-M7: Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    return false;
  }
}

/**
 * Create initial state.json for a new plan.
 */
export function createInitialStateJson(planDirName, goal, options = {}) {
  const now = nowISO();
  return {
    version: 1,
    state: "EXPLORE",
    iteration: 0,
    plan_dir: planDirName,
    goal: goal || "",
    created_at: now,
    updated_at: now,
    current_step: null,
    fix_attempts: 0,
    workflow_id: options.workflow_id || null,
    workflow_contract_version: options.workflow_contract_version || null,
    transitions: [
      {
        from: "INIT",
        to: "EXPLORE",
        timestamp: now,
        gate_result: "SKIP",
        failure_codes: [],
        script_versions: {},
      },
    ],
    change_manifest: [],
    script_versions: {},
    rule_bundle_version: loadConfig().rule_engine?.rule_bundle_version || "1.0.0",
    knowledge_snapshot: computeKnowledgeSnapshot(options.projectRoot || options.cwd),
    // v7.4.2: pre-allocate circuit_breakers so cmdFixStuck and other
    // consumers always see a defined object instead of falling through to
    // `|| {}` and masking real stuck-state.
    circuit_breakers: {},
  };
}

/**
 * Validate state.json against the schema (lightweight — checks required fields only).
 * Returns { valid: boolean, errors: string[] }.
 */
export function validateStateJson(stateObj) {
  const errors = [];
  if (!stateObj) { errors.push("state.json is null or undefined"); return { valid: false, errors }; }
  if (typeof stateObj.version !== "number") errors.push("Missing or invalid 'version'");
  const validStates = ["EXPLORE", "PLAN", "EXECUTE", "REFLECT", "VALIDATE", "RE_PLAN", "CLOSE"];
  if (!validStates.includes(stateObj.state)) errors.push(`Invalid state: ${stateObj.state}`);
  if (typeof stateObj.iteration !== "number") errors.push("Missing or invalid 'iteration'");
  if (!stateObj.plan_dir) errors.push("Missing 'plan_dir'");
  if (!stateObj.created_at) errors.push("Missing 'created_at'");
  if (!stateObj.updated_at) errors.push("Missing 'updated_at'");
  if (!Array.isArray(stateObj.transitions)) errors.push("Missing or invalid 'transitions'");
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Decision logs
// ---------------------------------------------------------------------------

/**
 * Append a decision log entry to plans/<plan>/artifacts/decision_log.jsonl.
 * Each line is a self-contained JSON record.
 * RT-HARDENING-002: Also backs up to plans/.audit-archive/<plan>/ (outside plan working area).
 * LLMs can delete artifacts/ but the archive copy persists for compliance.
 */
export function appendDecisionLog(planDir, entry) {
  if (!isFeatureEnabled("decision_logs")) return false;
  const artifactsDir = join(planDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const logPath = join(artifactsDir, "decision_log.jsonl");
  const tmpPath = logPath + ".tmp";
  // RT3-M1-FIX: Advisory lock for decision log writes. Without this, concurrent
  // appends (e.g., from parallel transitions) can lose entries because the
  // read-modify-write cycle is not atomic.
  // F-004 FIX: Retry with backoff instead of proceeding unprotected on lock failure.
  const lockPath = logPath + ".lock";
  let logLockAcquired = false;
  // H2-FIX + H5-FIX: Write PID inside lock file. Stale lock detection checks
  // if the PID is still alive instead of relying on mtime (which can be spoofed).
  const maxLockAttempts = 20; // 20 * 50ms = 1s max wait
  for (let attempt = 0; attempt < maxLockAttempts; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      logLockAcquired = true;
      break;
    } catch {
      if (attempt < maxLockAttempts - 1) {
        // Check for stale lock — verify PID is still alive
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          // M4-FIX: Validate PID is a sane integer before kill()
          if (!Number.isInteger(lockPid) || lockPid <= 0 || lockPid > 4194304) {
            try { unlinkSync(lockPath); } catch { /* race */ }
            continue; // Invalid PID — treat as stale
          }
          let pidAlive = false;
          try { process.kill(lockPid, 0); pidAlive = true; } catch { /* dead */ }
          if (!pidAlive) {
            try { unlinkSync(lockPath); } catch { /* race with another cleaner */ }
            continue;
          }
        } catch { /* lock was released between attempts */ }
        sleepMs(50);
      }
    }
  }
  if (!logLockAcquired) {
    debugLog("determinism", "Could not acquire decision log lock after retries — aborting append");
    return false;
  }
  const record = {
    timestamp: nowISO(),
    ...entry,
    repo_state_stamp: buildRepoStateStamp({
      cwd: process.cwd(),
      invocation: {
        command: "appendDecisionLog",
        plan_dir: relative(process.cwd(), planDir) || ".",
        gate: entry?.gate || null,
      },
    }),
  };
  try {
    // RT-AUDIT-M2: Hash chain — each record includes HMAC of previous record's hash.
    // Makes historical entry tampering detectable: modifying any past entry breaks
    // the chain for all subsequent entries.
    const existing = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const lines = existing.split("\n").filter(l => l.trim());
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      // RT10-C2: Full 32-char hashes for decision log chain integrity
      record._prev_hash = createHash("sha256").update(lastLine).digest("hex").slice(0, 32);
    } else {
      // Genesis record uses a static zero hash — chain integrity is validated
      // by the hash-chain structure itself (each record includes hash of previous).
      record._prev_hash = "00000000000000000000000000000000";
    }
    // Note: a per-record `_record_hash` was removed. It was computed and stored on
    // every record but never verified (validateDecisionLogChain only checks the
    // `_prev_hash` chain), so it added false confidence, not tamper-evidence. The
    // chain integrity (each record hashing the full previous line) is unchanged.

    // Atomic append: read existing content, append new record, write to tmp, rename.
    // Prevents partial writes on crash.
    const newContent = existing + JSON.stringify(record) + "\n";
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, logPath);

    // RT-HARDENING-002: Backup to plans/.audit-archive/<plan-dir-name>/
    // This directory is outside the plan's working area, so deleting artifacts/
    // does not destroy the audit trail.
    try {
      const planDirName = planDir.split("/").pop() || planDir.split("\\").pop();
      const archiveDir = join(planDir, "..", ".audit-archive", planDirName);
      mkdirSync(archiveDir, { recursive: true });
      const archivePath = join(archiveDir, "decision_log.jsonl");
      writeFileSync(archivePath, newContent);
    } catch (e) {
      debugLog("determinism", `Audit archive backup failed: ${e.message}`);
    }

    return true;
  } catch (e) {
    debugLog("determinism", `Decision log append failed: ${e.message}`);
    // RT6-M7: Clean up temp file on failure to prevent stale .tmp files
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    return false;
  } finally {
    // RT3-M1-FIX: Release decision log lock
    if (logLockAcquired) {
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

/**
 * Canonical gate decision rule: a gate is BLOCKED iff any check FAILed, else ALLOWED.
 * This is the single source of truth used by transition.mjs to record a verdict AND by
 * the real-telemetry replay harness to re-derive a historical verdict from its recorded
 * checks — so the replay tests the LIVE rule, not a copy. WARN/PASS never block.
 * @param {Array} checks - array of { status: "PASS"|"WARN"|"FAIL", ... }
 * @returns {"BLOCKED"|"ALLOWED"}
 */
export function deriveGateDecision(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "BLOCKED";
  const blocked = checks.some((check) => {
    const normalized = normalizeVerificationStatus(check?.status, "gate");
    return !normalized.valid || normalized.kind === "fail";
  });
  return blocked ? "BLOCKED" : "ALLOWED";
}

/**
 * Build a decision log entry for a gate transition.
 * @param {string} gate - e.g. "explore-to-plan"
 * @param {object} inputs - fact snapshot
 * @param {Array} checks - array of { name, status, code?, detail? }
 * @param {string} decision - "ALLOWED" or "BLOCKED"
 * @param {string} nextState - target state if allowed
 */
export function buildDecisionEntry(gate, inputs, checks, decision, nextState) {
  return {
    type: "gate_transition",
    gate,
    inputs,
    checks: checks.map(c => ({
      name: c.name,
      status: c.status,
      ...(c.code ? { code: c.code } : {}),
      ...(c.detail ? { detail: c.detail } : {}),
    })),
    decision,
    next_state: nextState,
    failure_codes: checks.filter((check) => {
      const normalized = normalizeVerificationStatus(check?.status, "gate");
      return (!normalized.valid || normalized.kind === "fail") && check?.code;
    }).map(c => c.code),
  };
}

// ---------------------------------------------------------------------------
// Script hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a file (first 12 hex chars).
 */
export function hashFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    // RT10-C2: Full 32-char (128-bit) SHA256 for all integrity hashes
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
  } catch {
    // L3-FIX: Return a unique error marker instead of static "unknown".
    // Previously, two unreadable files both returned "unknown", causing the integrity
    // check to pass ("unknown" === "unknown"). Now each failure is unique.
    return `err_${randomBytes(4).toString("hex")}`;
  }
}

/**
 * Hash all planner scripts and return { scriptName: hash } map.
 */
export function hashAllScripts(skillPath) {
  if (!isFeatureEnabled("script_hashing")) return {};
  const scriptsDir = join(skillPath, "scripts");
  const hashes = {};
  try {
    for (const f of readdirSync(scriptsDir)) {
      if (!f.endsWith(".mjs")) continue;
      hashes[f] = hashFile(join(scriptsDir, f));
    }
    // Also hash lib/ files
    const libDir = join(scriptsDir, "lib");
    if (existsSync(libDir)) {
      for (const f of readdirSync(libDir)) {
        if (!f.endsWith(".mjs")) continue;
        hashes[`lib/${f}`] = hashFile(join(libDir, f));
      }
    }
  } catch (e) {
    debugLog("determinism", `Script hashing failed: ${e.message}`);
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// Output sorting / normalization
// ---------------------------------------------------------------------------

/**
 * Sort an array of check results by name for deterministic output.
 * Only sorts if sorted_output feature is enabled.
 * Returns a new array (does not mutate input).
 */
export function sortResults(results) {
  if (!isFeatureEnabled("sorted_output")) return results;
  return [...results].sort((a, b) => {
    // Sort by status priority (FAIL first, then WARN, then PASS)
    const statusOrder = { FAIL: 0, WARN: 1, PASS: 2 };
    const statusDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
    if (statusDiff !== 0) return statusDiff;
    // Then by name
    return (a.name || "").localeCompare(b.name || "");
  });
}

/**
 * Sort file paths for deterministic output.
 */
export function sortPaths(paths) {
  if (!isFeatureEnabled("sorted_output")) return paths;
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Sort findings by severity then location for deterministic output.
 */
export function sortFindings(findings) {
  if (!isFeatureEnabled("sorted_output")) return findings;
  const sevOrder = { fail: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => {
    const sevDiff = (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return (a.location || "").localeCompare(b.location || "");
  });
}

// ---------------------------------------------------------------------------
// Proof traces (Prolog)
// ---------------------------------------------------------------------------

/**
 * Write a Prolog proof trace to plans/<plan>/artifacts/prolog/<filename>.
 * @param {string} planDir - Plan directory path
 * @param {string} gate - Gate name (used in filename)
 * @param {object} trace - { facts_file, goal, result, blockers?, timestamp }
 */
export function writeProofTrace(planDir, gate, trace) {
  if (!isFeatureEnabled("proof_traces")) return false;
  const traceDir = join(planDir, "artifacts", "prolog");
  mkdirSync(traceDir, { recursive: true });
  const filename = `${gate}_${nowISO().replace(/[:.]/g, "-")}.json`;
  const stampedTrace = {
    ...trace,
    repo_state_stamp: buildRepoStateStamp({
      cwd: process.cwd(),
      invocation: {
        command: "writeProofTrace",
        plan_dir: relative(process.cwd(), planDir) || ".",
        gate,
      },
    }),
  };
  try {
    writeFileSync(join(traceDir, filename), JSON.stringify(stampedTrace, null, 2) + "\n");
    return true;
  } catch (e) {
    debugLog("determinism", `Proof trace write failed: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Replay support
// ---------------------------------------------------------------------------

/**
 * Check if we're in replay mode (--replay <artifact-dir> on CLI).
 * Returns the artifact directory path, or null if not in replay mode.
 */
export function getReplayDir() {
  if (!isFeatureEnabled("replay_mode")) return null;
  const idx = process.argv.indexOf("--replay");
  if (idx >= 0 && process.argv[idx + 1]) {
    const dir = resolve(process.argv[idx + 1]);
    // RT-AUDIT-M4 + RT-REDTEAM-L4: Validate replay directory is within cwd.
    // Use realpathSync to resolve symlinks before prefix check — prevents
    // symlink-based directory escape (e.g., plans/evil -> /tmp/attacker/).
    const cwdResolved = resolve(process.cwd());
    let realDir;
    try { realDir = realpathSync(dir); } catch { realDir = dir; }
    if (!realDir.startsWith(cwdResolved)) {
      console.error(`WARNING: --replay directory is outside project root: ${dir}`);
      return null;
    }
    // M4-FIX: Use realDir (resolved) for existence check, not unresolved dir (TOCTOU).
    if (existsSync(realDir)) return realDir;
    console.error(`WARNING: --replay directory does not exist: ${dir}`);
  }
  return null;
}

/**
 * Load facts from an artifact directory for replay.
 * Returns { stateJson, decisionLog, proofTraces } or null if not a valid artifact dir.
 */
export function loadReplayArtifacts(artifactDir) {
  const result = { stateJson: null, decisionLog: [], proofTraces: [] };

  // Load state.json
  const statePath = join(artifactDir, "..", "state.json");
  if (existsSync(statePath)) {
    try { result.stateJson = JSON.parse(readFileSync(statePath, "utf-8")); } catch { /* ignore */ }
  }

  // Load decision log
  const logPath = join(artifactDir, "decision_log.jsonl");
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, "utf-8").split("\n").filter(l => l.trim());
      result.decisionLog = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* ignore */ }
  }

  // Load proof traces
  const prologDir = join(artifactDir, "prolog");
  if (existsSync(prologDir)) {
    try {
      for (const f of readdirSync(prologDir).sort()) {
        if (!f.endsWith(".json")) continue;
        const trace = JSON.parse(readFileSync(join(prologDir, f), "utf-8"));
        result.proofTraces.push({ file: f, ...trace });
      }
    } catch { /* ignore */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Escalation thresholds (from config)
// ---------------------------------------------------------------------------

/**
 * Get escalation thresholds from config.
 */
export function getEscalationThresholds() {
  return loadConfig().escalation_thresholds || {};
}

// ---------------------------------------------------------------------------
// Rule bundle versioning
// ---------------------------------------------------------------------------

/**
 * Get the current rule bundle version from config.
 */
export function getRuleBundleVersion() {
  return loadConfig().rule_engine?.rule_bundle_version || "1.0.0";
}

/**
 * Hash all Prolog rule files and return { filename: hash } map.
 */
export function hashRuleFiles(skillPath) {
  const prologDir = join(skillPath, "prolog");
  const hashes = {};
  try {
    if (!existsSync(prologDir)) return hashes;
    for (const f of readdirSync(prologDir).sort()) {
      if (!f.endsWith(".pl")) continue;
      hashes[f] = hashFile(join(prologDir, f));
    }
  } catch (e) {
    debugLog("determinism", `Rule hashing failed: ${e.message}`);
  }
  return hashes;
}

// Config-integrity tracking was retired by E8-1. Keep only a small
// compatibility status surface for migration tests and legacy callers.
export function checkConfigIntegrity() {
  return { intact: true, retired: true, reason: "config integrity baseline retired by E8-1" };
}

export function updateConfigIntegrity() {
  return true;
}

/**
 * RT-REDTEAM-M1: Validate decision log hash chain integrity.
 * Returns { valid: boolean, reason?: string, broken_at?: number }.
 */
export function validateDecisionLogChain(planDir) {
  const logPath = join(planDir, "artifacts", "decision_log.jsonl");
  if (!existsSync(logPath)) return { valid: true, reason: "no decision log" };
  try {
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(l => l.trim());
    if (lines.length === 0) return { valid: true, reason: "empty log" };
    for (let i = 0; i < lines.length; i++) {
      const record = JSON.parse(lines[i]);
      if (i === 0) {
        // RT10-C2: Support both old 16-char and new 32-char genesis hashes for backwards compat
      if (record._prev_hash !== "00000000000000000000000000000000" && record._prev_hash !== "0000000000000000") {
          return { valid: false, reason: "genesis record has wrong _prev_hash", broken_at: 0 };
        }
      } else {
        // RT10-C2: Compute both 16-char and 32-char hashes for backwards compatibility
        const fullHash = createHash("sha256").update(lines[i - 1]).digest("hex").slice(0, 32);
        const legacyHash = fullHash.slice(0, 16);
        const expectedPrevHash = record._prev_hash?.length === 32 ? fullHash : legacyHash;
        if (record._prev_hash !== expectedPrevHash) {
          return { valid: false, reason: `chain broken at record ${i}: expected _prev_hash ${expectedPrevHash}, got ${record._prev_hash}`, broken_at: i };
        }
      }
      // RT10-M1: Timestamp monotonicity — records inserted out of order indicate tampering
      if (i > 0 && record.timestamp) {
        const prevRecord = JSON.parse(lines[i - 1]);
        if (prevRecord.timestamp) {
          const prevTs = new Date(prevRecord.timestamp).getTime();
          const curTs = new Date(record.timestamp).getTime();
          if (curTs < prevTs) {
            return { valid: false, reason: `timestamp monotonicity violation at record ${i}: ${record.timestamp} is before previous record`, broken_at: i };
          }
        }
      }
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: `chain validation error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// State file lock
// ---------------------------------------------------------------------------

export const KB_SALT_BYTES = 16;
export const KB_SALT_HEX_LEN = 32;

export function acquireStateLock(planDir, timeoutMs = 1000) {
  const lockPath = join(planDir, "state.json.lock");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* best-effort */ } };
    } catch {
      try {
        const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
        if (!Number.isInteger(lockPid) || lockPid <= 0 || lockPid > 4194304) {
          try { unlinkSync(lockPath); } catch { /* race */ }
          continue;
        }
        let pidAlive = false;
        try { process.kill(lockPid, 0); pidAlive = true; } catch { /* dead */ }
        if (!pidAlive) {
          try { unlinkSync(lockPath); } catch { /* race */ }
          continue;
        }
      } catch { /* lock released between attempts */ }
      sleepMs(50);
    }
  }
  return null;
}
