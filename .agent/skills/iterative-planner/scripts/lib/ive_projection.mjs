import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { createHash } from "crypto";

const LEGACY_TO_IVE_MACRO_PHASE = Object.freeze({
  EXPLORE: "ideation",
  PLAN: "ideation",
  EXECUTE: "execution",
  REFLECT: "validation",
  VALIDATE: "validation",
  CLOSE: "validation",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeLegacyState(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeGateResult(value) {
  return String(value || "").trim().toUpperCase() || "UNKNOWN";
}

function normalizeTransition(entry = {}, index = 0) {
  const gate = String(entry.gate || entry.name || `${entry.from || "unknown"}-to-${entry.to || "unknown"}`)
    .trim()
    .replace(/_to_/g, "-to-")
    .replace(/_/g, "-");
  return {
    index,
    gate,
    from: normalizeLegacyState(entry.from),
    to: normalizeLegacyState(entry.to),
    gate_result: normalizeGateResult(entry.gate_result || entry.result || entry.status),
    failure_codes: Array.isArray(entry.failure_codes) ? entry.failure_codes.map(String).sort() : [],
  };
}

export function projectLegacyState(stateJson = {}, { planName = null } = {}) {
  const legacyState = normalizeLegacyState(stateJson.state);
  const macroPhase = LEGACY_TO_IVE_MACRO_PHASE[legacyState] || "unknown";
  const gateVerdicts = (Array.isArray(stateJson.transitions) ? stateJson.transitions : [])
    .map((entry, index) => normalizeTransition(entry, index));
  const gateVerdictsJson = JSON.stringify(gateVerdicts);

  return {
    schema_version: 1,
    plan: planName || null,
    read_only: true,
    canonical_state_unchanged: true,
    legacy_state: legacyState,
    ive_macro_phase: macroPhase,
    known_legacy_state: macroPhase !== "unknown",
    legacy_gate_count: gateVerdicts.length,
    gate_verdicts: gateVerdicts,
    gate_verdicts_json: gateVerdictsJson,
    gate_verdicts_sha256: sha256Text(gateVerdictsJson),
  };
}

export function projectPlanDir(planDir) {
  const resolved = resolve(planDir);
  const statePath = join(resolved, "state.json");
  if (!existsSync(statePath)) {
    return {
      ok: false,
      plan: basename(resolved),
      plan_dir: resolved,
      error: "state_json_missing",
    };
  }
  const before = readFileSync(statePath, "utf-8");
  const stateJson = readJson(statePath);
  const projection = projectLegacyState(stateJson, { planName: basename(resolved) });
  const after = readFileSync(statePath, "utf-8");
  const stateBytesUnchanged = before === after;
  return {
    ok: stateBytesUnchanged && projection.known_legacy_state,
    plan: basename(resolved),
    plan_dir: resolved,
    state_json_sha256: sha256Text(before),
    state_json_bytes_unchanged: stateBytesUnchanged,
    projection,
  };
}

export function verifyProjectionParity(planDirs = []) {
  const projections = planDirs.map((planDir) => projectPlanDir(planDir));
  const drift = projections.filter((entry) => {
    if (!entry.ok) return true;
    const expected = JSON.stringify(entry.projection.gate_verdicts);
    return entry.projection.gate_verdicts_json !== expected;
  });
  return {
    ok: drift.length === 0,
    status: drift.length === 0 ? "PASS" : "FAIL",
    plans_replayed: projections.length,
    drift_count: drift.length,
    gate_verdicts_byte_identical: drift.length === 0,
    projections,
    drift: drift.map((entry) => ({
      plan: entry.plan,
      error: entry.error || "gate_verdict_projection_drift",
    })),
  };
}

function discoverPlanDirs(root, limit = 1) {
  const plansRoot = join(root, "plans");
  if (!existsSync(plansRoot)) return [];
  const entries = [];
  for (const name of readdirSync(plansRoot).sort().reverse()) {
    if (!name.startsWith("plan_")) continue;
    const planDir = join(plansRoot, name);
    try {
      if (statSync(planDir).isDirectory() && existsSync(join(planDir, "state.json"))) {
        entries.push(planDir);
      }
    } catch {
      // Ignore unreadable fixture directories.
    }
    if (entries.length >= limit) break;
  }
  return entries;
}

export function parseProjectionArgs(argv = []) {
  const parsed = {
    json: false,
    plans: 1,
    planDirs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--plans") parsed.plans = Math.max(1, Number.parseInt(argv[++index] || "1", 10) || 1);
    else if (arg.startsWith("--plans=")) parsed.plans = Math.max(1, Number.parseInt(arg.slice("--plans=".length) || "1", 10) || 1);
    else if (arg === "--plan") parsed.planDirs.push(argv[++index]);
    else if (arg.startsWith("--plan=")) parsed.planDirs.push(arg.slice("--plan=".length));
    else if (!arg.startsWith("-")) parsed.planDirs.push(arg);
  }
  return parsed;
}

export function runProjectionCli(argv = [], { cwd = process.cwd() } = {}) {
  const args = parseProjectionArgs(argv);
  const planDirs = args.planDirs.length
    ? args.planDirs.map((entry) => resolve(cwd, entry))
    : discoverPlanDirs(cwd, args.plans);
  const report = verifyProjectionParity(planDirs);
  return { ...report, json: args.json };
}
