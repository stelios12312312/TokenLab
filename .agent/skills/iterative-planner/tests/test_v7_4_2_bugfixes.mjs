#!/usr/bin/env node
// test_v7_4_2_bugfixes.mjs — Class A (pack rule shape-blindness siblings of TR-005)
// and Class B (recover-poison + legacy state-field carry-forward) fixes.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;
const bootstrap = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
const transition = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "transition.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function makeTemp(suffix) {
  const tmp = mkdtempSync(join(tmpdir(), `v742-${suffix}-`));
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2) + "\n");
  execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });
  return tmp;
}

function runNode(args, cwd, env = {}) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

console.log("\nv7.4.2 Class A + Class B Bug Fixes\n");

// ── Class A — pack rule shape-blindness ──────────────────────────────
console.log("[Class A] Pack rule severity is shape-conditional");

const packs = [
  { id: "ux_ui", path: "../packs/ux_ui/index.mjs", rule: "UX-001",
    raw: { ruleId: "UX-001", subject: "project", detail: "no a11y story", severity: "HIGH" },
    expectedDowngradeShape: "refactor",
    expectedKeepShape: "feature" },
  { id: "wiring_auditor", path: "../packs/wiring_auditor/index.mjs", rule: "WR-004",
    raw: { ruleId: "WR-004", subject: "us_001", detail: "us_001", severity: "HIGH" },
    expectedDowngradeShape: "docs",
    expectedKeepShape: "bug-fix" },
  { id: "config_integrity", path: "../packs/config_integrity/index.mjs", rule: "CI-002",
    raw: { ruleId: "CI-002", subject: "sharpe_cap", detail: "sharpe_cap", severity: "HIGH" },
    expectedDowngradeShape: "refactor",
    expectedKeepShape: "integration" },
  { id: "assumptions_challenger", path: "../packs/assumptions_challenger/index.mjs", rule: "AC-001",
    raw: { ruleId: "AC-001", subject: "model_a", detail: "model_a", severity: "CRITICAL" },
    expectedDowngradeShape: "refactor",
    expectedKeepShape: "bug-fix" },
];

for (const p of packs) {
  const mod = await import(p.path);
  const pack = mod.default || mod[`${p.id}Pack`] || mod;
  const downgrade = pack.normalizeFinding(p.raw, { planShape: { primary: p.expectedDowngradeShape } });
  assert(downgrade.severity === "LOW",
    `${p.rule} downgraded to LOW for ${p.expectedDowngradeShape} shape`);
  const keep = pack.normalizeFinding(p.raw, { planShape: { primary: p.expectedKeepShape } });
  assert(keep.severity === p.raw.severity,
    `${p.rule} keeps ${p.raw.severity} for ${p.expectedKeepShape} shape`);
  // No context provided — falls back to original severity
  const noCtx = pack.normalizeFinding(p.raw);
  assert(noCtx.severity === p.raw.severity,
    `${p.rule} keeps ${p.raw.severity} when no context provided (legacy compatibility)`);
}

// AC-002 (real edge proof) stays CRITICAL on every shape
const acMod = await import("../packs/assumptions_challenger/index.mjs");
const acPack = acMod.default || acMod;
const ac002 = acPack.normalizeFinding(
  { ruleId: "AC-002", subject: "model_x", detail: "model_x", severity: "CRITICAL" },
  { planShape: { primary: "refactor" } }
);
assert(ac002.severity === "CRITICAL",
  "AC-002 (real edge proof) stays CRITICAL on refactor — not downgraded by accident");

// ── Class B — recover-poison carry-forward + legacy backfill ─────────
console.log("\n[Class B] recover-poison carries state.json fields + legacy backfill");

const tmp = makeTemp("recover-state-fields");
try {
  runNode([bootstrap, "new", "Migrate fleet to v7.4.2"], tmp);
  const plansDir = join(tmp, "plans");
  const sourcePlanName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
  const sourceStatePath = join(plansDir, sourcePlanName, "state.json");

  // Pre-populate source state with fields the successor should inherit
  const sourceState = JSON.parse(readFileSync(sourceStatePath, "utf-8"));
  sourceState.registry_hash = "abc123def456";
  // plan_shape was already set by bootstrap (migration shape). Mark for traceability.
  sourceState._test_marker_source = sourcePlanName;
  // Force poison
  sourceState.transitions = sourceState.transitions || [];
  for (let i = 0; i < 6; i++) {
    sourceState.transitions.push({
      from: "EXPLORE", to: "EXPLORE", timestamp: new Date().toISOString(),
      gate_result: "FAIL", failure_codes: ["GATE-EXP-001"],
    });
  }
  // Re-sign integrity
  delete sourceState._state_hash;
  const { computeStateHash } = await import("../scripts/lib/determinism.mjs");
  sourceState._state_hash = computeStateHash(sourceState);
  writeFileSync(sourceStatePath, JSON.stringify(sourceState, null, 2));

  const recovery = runNode([bootstrap, "recover-poison"], tmp);
  assert(recovery.ok, "recover-poison runs cleanly");

  const successorPlanName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
  const successorState = JSON.parse(readFileSync(join(plansDir, successorPlanName, "state.json"), "utf-8"));

  assert(successorState.registry_hash === "abc123def456",
    "successor state.json carries registry_hash from source");
  assert(successorState.plan_shape && /carried_from_source_plan/.test(successorState.plan_shape.source || ""),
    "successor plan_shape marked carried_from_source_plan");
  assert(successorState.circuit_breakers && typeof successorState.circuit_breakers === "object",
    "successor circuit_breakers is an empty object (not undefined)");
  assert(successorState.approval_nonce_hash !== sourceState.approval_nonce_hash || successorState.approval_nonce_hash === undefined,
    "successor does NOT carry approval_nonce_hash (security: forces fresh approval)");
  assert(successorState.kb_digest_hash !== sourceState.kb_digest_hash || successorState.kb_digest_hash === undefined,
    "successor does NOT carry kb_digest_hash (forces fresh KB read proof)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Legacy plan without circuit_breakers — opportunistic backfill on transition
const legacyTmp = makeTemp("legacy-circuit-breakers");
try {
  runNode([bootstrap, "new", "Some legacy goal"], legacyTmp);
  const plansDir = join(legacyTmp, "plans");
  const planName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
  const statePath = join(plansDir, planName, "state.json");

  const stateJson = JSON.parse(readFileSync(statePath, "utf-8"));
  delete stateJson.circuit_breakers;
  delete stateJson._state_hash;
  const { computeStateHash } = await import("../scripts/lib/determinism.mjs");
  stateJson._state_hash = computeStateHash(stateJson);
  writeFileSync(statePath, JSON.stringify(stateJson, null, 2));
  assert(JSON.parse(readFileSync(statePath, "utf-8")).circuit_breakers === undefined,
    "fixture starts WITHOUT circuit_breakers (simulates legacy plan)");

  runNode([transition, "explore-to-plan"], legacyTmp, { _PLANNER_FAST_TRACK: "1" });
  const after = JSON.parse(readFileSync(statePath, "utf-8"));
  assert(typeof after.circuit_breakers === "object" && after.circuit_breakers !== null,
    "legacy plan gains circuit_breakers={} on first transition");
} finally {
  rmSync(legacyTmp, { recursive: true, force: true });
}

// New plans get circuit_breakers from createInitialStateJson
const freshTmp = makeTemp("fresh-circuit-breakers");
try {
  runNode([bootstrap, "new", "Fresh plan test"], freshTmp);
  const plansDir = join(freshTmp, "plans");
  const planName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
  const stateJson = JSON.parse(readFileSync(join(plansDir, planName, "state.json"), "utf-8"));
  assert(typeof stateJson.circuit_breakers === "object" && stateJson.circuit_breakers !== null,
    "newly bootstrapped plans have circuit_breakers={} from createInitialStateJson");
} finally {
  rmSync(freshTmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
