// conformance_session.mjs — shared identity, forecast, progress, receipt, and checkpoint authority.
// @planner:story = US-065, US-102, US-PM-AUTO-077
// @planner:proves = sc_2, sc_3, sc_4, sc_5

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

const DEFAULT_CONFIG_RELATIVE = ".agent/skills/iterative-planner/config/conformance_session.json";
const DEFAULT_VERSION_RELATIVE = ".agent/skills/iterative-planner/config/version.json";
const SESSION_SCHEMA_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function digestValue(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
}

function normalizeSuiteId(value) {
  return String(value || "").trim();
}

function validateConfig(config) {
  if (!config || config.schema_version !== 1) throw new Error("conformance session config must use schema_version 1");
  const positive = [
    ["receipt_freshness_ms", config.receipt_freshness_ms],
    ["heartbeat_interval_ms", config.heartbeat_interval_ms],
    ["retention_count", config.retention_count],
    ["forecast.fallback_suite_ms", config.forecast?.fallback_suite_ms],
    ["forecast.duration_multiplier", config.forecast?.duration_multiplier],
    ["forecast.cleanup_cushion_ms", config.forecast?.cleanup_cushion_ms],
    ["forecast.min_outer_timeout_ms", config.forecast?.min_outer_timeout_ms],
    ["forecast.max_outer_timeout_ms", config.forecast?.max_outer_timeout_ms],
  ];
  for (const [field, value] of positive) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`${field} must be positive`);
  }
  if (Number(config.forecast.min_outer_timeout_ms) > Number(config.forecast.max_outer_timeout_ms)) {
    throw new Error("forecast min_outer_timeout_ms cannot exceed max_outer_timeout_ms");
  }
  return config;
}

function loadConformanceSessionConfig({ repoRoot = process.cwd(), configPath = null, env = process.env, overrides = {} } = {}) {
  const path = resolve(configPath || join(repoRoot, DEFAULT_CONFIG_RELATIVE));
  const source = JSON.parse(readFileSync(path, "utf-8"));
  const integerEnv = (name, fallback) => {
    const raw = env?.[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
    return parsed;
  };
  const config = {
    ...source,
    receipt_freshness_ms: Number(overrides.receipt_freshness_ms ?? integerEnv("IVE_RECEIPT_FRESHNESS_MS", source.receipt_freshness_ms)),
    heartbeat_interval_ms: Number(overrides.heartbeat_interval_ms ?? integerEnv("IVE_HEARTBEAT_INTERVAL_MS", source.heartbeat_interval_ms)),
    retention_count: Number(overrides.retention_count ?? integerEnv("IVE_CONFORMANCE_RETENTION_COUNT", source.retention_count)),
    forecast: {
      ...(source.forecast || {}),
      ...(overrides.forecast || {}),
      fallback_suite_ms: Number(overrides.forecast?.fallback_suite_ms ?? integerEnv("IVE_FORECAST_FALLBACK_SUITE_MS", source.forecast?.fallback_suite_ms)),
      duration_multiplier: Number(overrides.forecast?.duration_multiplier ?? integerEnv("IVE_FORECAST_DURATION_MULTIPLIER", source.forecast?.duration_multiplier)),
      cleanup_cushion_ms: Number(overrides.forecast?.cleanup_cushion_ms ?? integerEnv("IVE_FORECAST_CLEANUP_CUSHION_MS", source.forecast?.cleanup_cushion_ms)),
      min_outer_timeout_ms: Number(overrides.forecast?.min_outer_timeout_ms ?? integerEnv("IVE_FORECAST_MIN_OUTER_TIMEOUT_MS", source.forecast?.min_outer_timeout_ms)),
      max_outer_timeout_ms: Number(overrides.forecast?.max_outer_timeout_ms ?? integerEnv("IVE_FORECAST_MAX_OUTER_TIMEOUT_MS", source.forecast?.max_outer_timeout_ms)),
    },
  };
  return validateConfig(config);
}

function buildConformanceIdentity({
  tree_sha,
  base_sha,
  dirty_state_digest,
  catalog_digest,
  config_digest,
  planner_version,
  command_contract_digest,
  suites = [],
} = {}) {
  const inputs = {
    tree_sha: String(tree_sha || "unavailable"),
    base_sha: String(base_sha || "unavailable"),
    dirty_state_digest: String(dirty_state_digest || "unavailable"),
    catalog_digest: String(catalog_digest || "unavailable"),
    config_digest: String(config_digest || "unavailable"),
    planner_version: String(planner_version || "unavailable"),
    command_contract_digest: String(command_contract_digest || "unavailable"),
  };
  const contextDigest = digestValue({ schema_version: SESSION_SCHEMA_VERSION, ...inputs });
  const normalizedSuites = (Array.isArray(suites) ? suites : []).map((suite) => ({
    id: normalizeSuiteId(suite?.id),
    fixture_digest: String(suite?.fixture_digest || "unavailable"),
    command_digest: String(suite?.command_digest || "unavailable"),
  })).filter((suite) => suite.id).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalizedSuites.map((suite) => suite.id)).size !== normalizedSuites.length) throw new Error("conformance identity suite IDs must be unique");
  const suiteIdentities = Object.fromEntries(normalizedSuites.map((suite) => [suite.id, digestValue({
    context_digest: contextDigest,
    suite_id: suite.id,
    fixture_digest: suite.fixture_digest,
    command_digest: suite.command_digest,
  })]));
  const selectedSuiteIds = normalizedSuites.map((suite) => suite.id);
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    inputs,
    context_digest: contextDigest,
    selected_suite_ids: selectedSuiteIds,
    suite_identities: suiteIdentities,
    identity_digest: digestValue({ context_digest: contextDigest, selected_suite_ids: selectedSuiteIds, suite_identities: suiteIdentities }),
  };
}

function percentile95(values) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function forecastSelectedWorkload({ selectedSuites = [], history = [], config = {} } = {}) {
  const fallbackSuiteMs = Number(config.fallback_suite_ms ?? config.forecast?.fallback_suite_ms ?? 30000);
  const multiplier = Number(config.duration_multiplier ?? config.forecast?.duration_multiplier ?? 1.5);
  const cleanupCushionMs = Number(config.cleanup_cushion_ms ?? config.forecast?.cleanup_cushion_ms ?? 120000);
  const minOuterTimeoutMs = Number(config.min_outer_timeout_ms ?? config.forecast?.min_outer_timeout_ms ?? 900000);
  const maxOuterTimeoutMs = Number(config.max_outer_timeout_ms ?? config.forecast?.max_outer_timeout_ms ?? 14400000);
  const values = [fallbackSuiteMs, multiplier, cleanupCushionMs, minOuterTimeoutMs, maxOuterTimeoutMs];
  if (values.some((value) => !Number.isFinite(value) || value <= 0) || minOuterTimeoutMs > maxOuterTimeoutMs) {
    return { ok: false, status: "invalid_forecast_config", suite_forecasts: [], required_outer_timeout_ms: null, issues: ["forecast configuration must be positive and min must not exceed max"] };
  }
  const historyRows = Array.isArray(history) ? history : [];
  const suiteForecasts = (Array.isArray(selectedSuites) ? selectedSuites : []).map((suite) => {
    const suiteId = normalizeSuiteId(suite?.id);
    const durations = historyRows
      .filter((row) => normalizeSuiteId(row?.suite_id || row?.id) === suiteId && String(row?.status || "").toUpperCase() === "PASS")
      .map((row) => Number(row?.duration_ms));
    const historical = percentile95(durations);
    const rawMs = historical === null ? fallbackSuiteMs : historical;
    const forecastMs = Math.max(1, Math.ceil(rawMs * multiplier));
    return {
      suite_id: suiteId,
      source: historical === null ? "configured_fallback" : "history_p95",
      sample_count: durations.filter((value) => Number.isFinite(value) && value >= 0).length,
      raw_ms: rawMs,
      multiplier,
      forecast_ms: forecastMs,
      declared_timeout_ms: Number.isFinite(Number(suite?.timeout_ms)) ? Number(suite.timeout_ms) : null,
    };
  }).filter((row) => row.suite_id);
  const selectedWorkloadMs = suiteForecasts.reduce((sum, row) => sum + row.forecast_ms, 0);
  const uncappedRequiredMs = Math.max(minOuterTimeoutMs, selectedWorkloadMs + cleanupCushionMs);
  const exceedsMax = uncappedRequiredMs > maxOuterTimeoutMs;
  return {
    ok: !exceedsMax,
    status: exceedsMax ? "forecast_exceeds_max_outer_timeout" : "ready",
    selected_count: suiteForecasts.length,
    suite_forecasts: suiteForecasts,
    selected_workload_ms: selectedWorkloadMs,
    cleanup_cushion_ms: cleanupCushionMs,
    required_outer_timeout_ms: uncappedRequiredMs,
    max_outer_timeout_ms: maxOuterTimeoutMs,
    degraded_history: suiteForecasts.some((row) => row.source === "configured_fallback"),
    issues: exceedsMax ? [`selected workload requires ${uncappedRequiredMs}ms, above configured maximum ${maxOuterTimeoutMs}ms`] : [],
  };
}

function admitConformanceWorkload({ forecast, outerTimeoutMs = null } = {}) {
  if (!forecast?.ok) return { ok: false, status: "infrastructure_preflight_failed", reason: forecast?.status || "invalid_forecast", forecast };
  if (outerTimeoutMs === null || outerTimeoutMs === undefined) {
    return { ok: true, status: "admitted", outer_timeout_ms: forecast.required_outer_timeout_ms, source: "forecast" };
  }
  const supplied = Number(outerTimeoutMs);
  if (!Number.isFinite(supplied) || supplied <= 0) return { ok: false, status: "infrastructure_preflight_failed", reason: "invalid_outer_timeout", forecast };
  if (supplied < forecast.required_outer_timeout_ms) {
    return {
      ok: false,
      status: "infrastructure_preflight_failed",
      reason: "outer_timeout_below_selected_workload_bound",
      outer_timeout_ms: supplied,
      required_outer_timeout_ms: forecast.required_outer_timeout_ms,
      forecast,
    };
  }
  return { ok: true, status: "admitted", outer_timeout_ms: supplied, source: "caller", required_outer_timeout_ms: forecast.required_outer_timeout_ms };
}

function receiptDigest(receipt) {
  const { receipt_digest, ...body } = receipt || {};
  return digestValue(body);
}

function createConformanceReceipt({ identity, status, results = [], created_at = new Date().toISOString(), freshness_ms = 21600000, run_id = null, manifest_path = null } = {}) {
  if (!identity?.context_digest) throw new Error("conformance receipt requires an identity");
  const createdMs = Date.parse(created_at);
  if (!Number.isFinite(createdMs) || !Number.isFinite(Number(freshness_ms)) || Number(freshness_ms) <= 0) throw new Error("conformance receipt requires valid freshness timestamps");
  const rows = (Array.isArray(results) ? results : []).map((result) => ({
    id: normalizeSuiteId(result?.id),
    status: String(result?.status || "UNKNOWN").toUpperCase(),
    duration_ms: Math.max(0, Number(result?.duration_ms) || 0),
    suite_identity_digest: identity.suite_identities?.[normalizeSuiteId(result?.id)] || null,
    proof_artifact: result?.proof_artifact || null,
  })).filter((row) => row.id);
  const receipt = {
    schema_version: SESSION_SCHEMA_VERSION,
    kind: "conformance_receipt",
    run_id: run_id || null,
    status: String(status || "UNKNOWN").toUpperCase(),
    created_at,
    expires_at: new Date(createdMs + Number(freshness_ms)).toISOString(),
    identity,
    results: rows,
    manifest_path: manifest_path || null,
  };
  return { ...receipt, receipt_digest: receiptDigest(receipt) };
}

function rerunAll(identity, reason) {
  return {
    ok: false,
    reusable_results: [],
    rerun: (identity?.selected_suite_ids || []).map((id) => ({ id, reason })),
    reason,
  };
}

function selectReusableSuiteResults({ receipt, identity, now = new Date() } = {}) {
  if (!receipt || receipt.schema_version !== SESSION_SCHEMA_VERSION || receipt.kind !== "conformance_receipt") return rerunAll(identity, "receipt_missing_or_malformed");
  if (receipt.receipt_digest !== receiptDigest(receipt)) return rerunAll(identity, "receipt_digest_mismatch");
  if (String(receipt.status || "").toUpperCase() !== "PASS") return rerunAll(identity, "receipt_not_pass");
  if (receipt.identity?.context_digest !== identity?.context_digest) return rerunAll(identity, "session_context_mismatch");
  if (!Number.isFinite(Date.parse(receipt.expires_at)) || Date.parse(receipt.expires_at) <= now.getTime()) return rerunAll(identity, "receipt_expired");
  const rowsById = new Map((receipt.results || []).map((row) => [normalizeSuiteId(row?.id), row]));
  const reusableResults = [];
  const rerun = [];
  for (const id of identity?.selected_suite_ids || []) {
    const row = rowsById.get(id);
    const expectedDigest = identity.suite_identities?.[id];
    if (!row) rerun.push({ id, reason: "suite_not_covered" });
    else if (String(row.status || "").toUpperCase() !== "PASS") rerun.push({ id, reason: "suite_not_pass" });
    else if (!expectedDigest || row.suite_identity_digest !== expectedDigest) rerun.push({ id, reason: "suite_identity_mismatch" });
    else reusableResults.push({ ...row, reused: true, reuse_source: "receipt" });
  }
  return { ok: rerun.length === 0, reusable_results: reusableResults, rerun, reason: rerun.length ? "partial_reuse" : "exact_reuse" };
}

function conformanceStoragePaths({ gitDir, identity } = {}) {
  if (!gitDir || !identity?.context_digest) throw new Error("conformance storage requires gitDir and identity");
  const root = resolve(gitDir, "iterative-planner", "conformance");
  return {
    root,
    receipts_dir: join(root, "receipts"),
    checkpoints_dir: join(root, "checkpoints"),
    receipt_path: join(root, "receipts", `${identity.context_digest}--${identity.identity_digest}.json`),
    checkpoint_path: join(root, "checkpoints", `${identity.identity_digest}.json`),
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function writeConformanceReceipt({ gitDir, receipt } = {}) {
  const paths = conformanceStoragePaths({ gitDir, identity: receipt?.identity });
  if (receipt?.receipt_digest !== receiptDigest(receipt)) throw new Error("refusing to write an invalid conformance receipt digest");
  writeJsonAtomic(paths.receipt_path, receipt);
  return { path: paths.receipt_path, receipt_digest: receipt.receipt_digest };
}

function checkpointDigest(checkpoint) {
  const { checkpoint_digest, ...body } = checkpoint || {};
  return digestValue(body);
}

function writeConformanceCheckpoint({ gitDir, identity, run_id = null, status = "in_progress", active_suite_id = null, completed_results = [], updated_at = new Date().toISOString() } = {}) {
  const paths = conformanceStoragePaths({ gitDir, identity });
  const completed = (Array.isArray(completed_results) ? completed_results : [])
    .filter((row) => String(row?.status || "").toUpperCase() === "PASS")
    .map((row) => ({
      id: normalizeSuiteId(row?.id),
      status: "PASS",
      duration_ms: Math.max(0, Number(row?.duration_ms) || 0),
      suite_identity_digest: identity.suite_identities?.[normalizeSuiteId(row?.id)] || null,
      proof_artifact: row?.proof_artifact || null,
    }))
    .filter((row) => row.id && row.suite_identity_digest);
  const checkpoint = {
    schema_version: SESSION_SCHEMA_VERSION,
    kind: "conformance_checkpoint",
    run_id,
    status: String(status || "in_progress"),
    updated_at,
    identity,
    active_suite_id: active_suite_id || null,
    completed_results: completed,
  };
  checkpoint.checkpoint_digest = checkpointDigest(checkpoint);
  writeJsonAtomic(paths.checkpoint_path, checkpoint);
  return { path: paths.checkpoint_path, checkpoint_digest: checkpoint.checkpoint_digest, checkpoint };
}

function readConformanceCheckpoint({ path } = {}) {
  try {
    const checkpoint = JSON.parse(readFileSync(path, "utf-8"));
    if (checkpoint?.schema_version !== SESSION_SCHEMA_VERSION || checkpoint?.kind !== "conformance_checkpoint") return { ok: false, reason: "checkpoint_malformed", checkpoint: null };
    if (checkpoint.checkpoint_digest !== checkpointDigest(checkpoint)) return { ok: false, reason: "checkpoint_digest_mismatch", checkpoint: null };
    return { ok: true, reason: null, checkpoint };
  } catch (error) {
    return { ok: false, reason: existsSync(path) ? "checkpoint_unreadable" : "checkpoint_missing", error: error.message, checkpoint: null };
  }
}

function selectReusableCheckpointResults({ checkpoint, identity } = {}) {
  if (!checkpoint || checkpoint.schema_version !== SESSION_SCHEMA_VERSION || checkpoint.kind !== "conformance_checkpoint") return rerunAll(identity, "checkpoint_missing_or_malformed");
  if (checkpoint.checkpoint_digest !== checkpointDigest(checkpoint)) return rerunAll(identity, "checkpoint_digest_mismatch");
  if (checkpoint.identity?.context_digest !== identity?.context_digest) return rerunAll(identity, "checkpoint_context_mismatch");
  const pseudoReceipt = {
    schema_version: SESSION_SCHEMA_VERSION,
    kind: "conformance_receipt",
    status: "PASS",
    expires_at: "9999-12-31T23:59:59.999Z",
    identity: checkpoint.identity,
    results: checkpoint.completed_results,
  };
  pseudoReceipt.receipt_digest = receiptDigest(pseudoReceipt);
  const selected = selectReusableSuiteResults({ receipt: pseudoReceipt, identity, now: new Date(0) });
  return { ...selected, reusable_results: selected.reusable_results.map((row) => ({ ...row, reuse_source: "checkpoint" })) };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function findReusableConformanceEvidence({ gitDir, identity, now = new Date(), allowReceipt = true, allowCheckpoint = true } = {}) {
  const paths = conformanceStoragePaths({ gitDir, identity });
  if (allowReceipt && existsSync(paths.receipts_dir)) {
    const candidates = readdirSync(paths.receipts_dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(paths.receipts_dir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of candidates) {
      const receipt = readJson(path);
      const selection = selectReusableSuiteResults({ receipt, identity, now });
      if (selection.reusable_results.length > 0) return { source: "receipt", path, ...selection };
    }
  }
  if (allowCheckpoint && existsSync(paths.checkpoint_path)) {
    const read = readConformanceCheckpoint({ path: paths.checkpoint_path });
    if (read.ok) {
      const selection = selectReusableCheckpointResults({ checkpoint: read.checkpoint, identity });
      if (selection.reusable_results.length > 0) return { source: "checkpoint", path: paths.checkpoint_path, ...selection };
    }
  }
  return { source: null, path: null, ...rerunAll(identity, "no_reusable_evidence") };
}

function readConformanceDurationHistory({ gitDir, limit = 200 } = {}) {
  const receiptsDir = resolve(gitDir || ".", "iterative-planner", "conformance", "receipts");
  if (!gitDir || !existsSync(receiptsDir)) return [];
  const rows = [];
  const candidates = readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(receiptsDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const path of candidates) {
    const receipt = readJson(path);
    if (!receipt || receipt.receipt_digest !== receiptDigest(receipt)) continue;
    for (const result of receipt.results || []) {
      if (String(result?.status || "").toUpperCase() !== "PASS") continue;
      rows.push({
        suite_id: normalizeSuiteId(result?.id),
        duration_ms: Math.max(0, Number(result?.duration_ms) || 0),
        status: "PASS",
        receipt_path: path,
        created_at: receipt.created_at || null,
      });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

function pruneConformanceEvidence({ gitDir, retentionCount = 20 } = {}) {
  if (!gitDir || !Number.isInteger(Number(retentionCount)) || Number(retentionCount) <= 0) return { removed: [], retained: [] };
  const root = resolve(gitDir, "iterative-planner", "conformance");
  const removed = [];
  const retained = [];
  for (const name of ["receipts", "checkpoints"]) {
    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => join(dir, entry))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    retained.push(...files.slice(0, Number(retentionCount)));
    // Retention cleanup is intentionally report-only. Removing Git-metadata proof
    // requires an explicit caller-owned maintenance action.
    removed.push(...files.slice(Number(retentionCount)).map((path) => ({ path, action: "eligible_for_explicit_cleanup" })));
  }
  return { removed, retained };
}

function safeProgressPayload(event, payload, state, now) {
  const allowed = [
    "run_id", "selected_count", "suite_id", "index", "total", "status", "duration_ms",
    "eta_ms", "remaining_eta_ms", "completed_count", "reused_count", "reason", "wave_id",
  ];
  const result = { event, at_ms: now() };
  for (const key of allowed) {
    const value = payload?.[key];
    if (["string", "number", "boolean"].includes(typeof value) && value !== "") result[key] = value;
  }
  if (state.active_suite_id && result.suite_id === undefined) result.suite_id = state.active_suite_id;
  return result;
}

function createProgressEmitter({
  write = (line) => process.stderr.write(line),
  now = () => Date.now(),
  heartbeatIntervalMs = 30000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const state = { active_suite_id: null, stopped: false, timer: null };
  const emit = (event, payload = {}) => {
    if (state.stopped) return;
    write(`[ive-progress] ${JSON.stringify(safeProgressPayload(event, payload, state, now))}\n`);
  };
  const heartbeat = () => {
    if (state.active_suite_id) emit("heartbeat", {});
  };
  const ensureTimer = () => {
    if (!state.timer && Number.isFinite(Number(heartbeatIntervalMs)) && Number(heartbeatIntervalMs) > 0) {
      state.timer = setIntervalFn(heartbeat, Number(heartbeatIntervalMs));
      state.timer?.unref?.();
    }
  };
  return {
    runStarted(payload) { emit("run_started", payload); ensureTimer(); },
    waveStarted(payload) { emit("wave_started", payload); ensureTimer(); },
    suiteStarted(payload) { state.active_suite_id = normalizeSuiteId(payload?.suite_id) || null; emit("suite_started", payload); ensureTimer(); },
    heartbeat,
    suiteFinished(payload) { emit("suite_finished", payload); state.active_suite_id = null; },
    waveFinished(payload) { emit("wave_finished", payload); },
    reused(payload) { emit("suite_reused", payload); },
    runFinished(payload) { emit("run_finished", payload); },
    stop() { if (state.timer) clearIntervalFn(state.timer); state.timer = null; state.stopped = true; },
  };
}

function gitOutput(repoRoot, args, fallback = "unavailable") {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim() || fallback;
  } catch { return fallback; }
}

function resolveGitDir(repoRoot = process.cwd()) {
  const raw = gitOutput(repoRoot, ["rev-parse", "--absolute-git-dir"], "");
  if (!raw) return null;
  return resolve(raw);
}

function collectFiles(path, repoRoot, output) {
  const absolute = resolve(repoRoot, path);
  if (!existsSync(absolute)) {
    output.push({ path: String(path).replace(/\\/g, "/"), digest: "missing" });
    return;
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    output.push({ path: String(path).replace(/\\/g, "/"), digest: digestValue(`symlink:${readlinkSync(absolute)}`) });
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(absolute).sort()) collectFiles(join(path, name), repoRoot, output);
  } else if (stat.isFile()) output.push({ path: String(path).replace(/\\/g, "/"), digest: digestValue(readFileSync(absolute)) });
}

function digestFixturePaths(paths, repoRoot = process.cwd()) {
  const rows = [];
  for (const path of [...new Set(Array.isArray(paths) ? paths : [])].sort()) collectFiles(path, repoRoot, rows);
  return digestValue(rows);
}

function readPlannerVersion(repoRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, DEFAULT_VERSION_RELATIVE), "utf-8"));
    return String(parsed.version || parsed.planner_version || "unavailable");
  } catch { return "unavailable"; }
}

function buildConformanceIdentityFromRepository({ repoRoot = process.cwd(), suites = [], catalogSuites = suites, baseSha = null, configPath = null } = {}) {
  const configFile = resolve(configPath || join(repoRoot, DEFAULT_CONFIG_RELATIVE));
  const treeSha = gitOutput(repoRoot, ["write-tree"], gitOutput(repoRoot, ["rev-parse", "HEAD^{tree}"], "unavailable"));
  const resolvedBase = baseSha || gitOutput(repoRoot, ["merge-base", "HEAD", "@{upstream}"], "unavailable");
  const unstagedDiff = gitOutput(repoRoot, ["diff", "--no-ext-diff", "--binary"], "");
  const untrackedPaths = gitOutput(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], "")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = untrackedPaths.map((path) => {
    const rows = [];
    collectFiles(path, repoRoot, rows);
    return { path, rows };
  });
  const suiteDescriptors = (Array.isArray(suites) ? suites : []).map((suite) => ({
    id: suite.id,
    fixture_digest: digestFixturePaths(suite.fixtures || [], repoRoot),
    command_digest: digestValue({ command: suite.display_command || suite.command || [], timeout_ms: suite.timeout_ms || null, required: suite.required !== false }),
  }));
  const catalogDigest = digestValue((Array.isArray(catalogSuites) ? catalogSuites : []).map((suite) => ({
    id: suite.id,
    category: suite.category,
    required: suite.required !== false,
    timeout_ms: suite.timeout_ms || null,
    fixtures: suite.fixtures || [],
    command: suite.display_command || suite.command || [],
  })));
  return buildConformanceIdentity({
    tree_sha: treeSha,
    base_sha: resolvedBase,
    dirty_state_digest: digestValue({ unstaged_diff: unstagedDiff, untracked }),
    catalog_digest: catalogDigest,
    config_digest: existsSync(configFile) ? digestValue(readFileSync(configFile)) : "missing",
    planner_version: readPlannerVersion(repoRoot),
    command_contract_digest: digestValue({ node: process.versions.node, platform: process.platform, arch: process.arch, schema_version: SESSION_SCHEMA_VERSION }),
    suites: suiteDescriptors,
  });
}

export {
  SESSION_SCHEMA_VERSION,
  admitConformanceWorkload,
  buildConformanceIdentity,
  buildConformanceIdentityFromRepository,
  canonicalJson,
  conformanceStoragePaths,
  createConformanceReceipt,
  createProgressEmitter,
  digestFixturePaths,
  digestValue,
  findReusableConformanceEvidence,
  forecastSelectedWorkload,
  loadConformanceSessionConfig,
  pruneConformanceEvidence,
  readConformanceDurationHistory,
  readConformanceCheckpoint,
  resolveGitDir,
  selectReusableCheckpointResults,
  selectReusableSuiteResults,
  validateConfig as validateConformanceSessionConfig,
  writeConformanceCheckpoint,
  writeConformanceReceipt,
};
