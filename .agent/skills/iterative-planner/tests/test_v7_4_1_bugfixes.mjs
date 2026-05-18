#!/usr/bin/env node
// test_v7_4_1_bugfixes.mjs — Tennis incident bug fixes.
//
// Three bugs surfaced by the Tennis project's recover-poison loop:
//   1. Traceability TR-005 perspective coverage was HIGH severity on every
//      shape, including feature/integration where exhaustive perspective
//      coverage is overkill. Fix: shape-conditional severity downgrade.
//   2. recover-poison carried forward an empty intent_contract.json from the
//      source plan, leaving the successor with no job_to_be_done. Fix: when
//      source contract is blank, seed job_to_be_done from the source goal.
//   3. Plans created before v7.3.0 don't have state.json.plan_shape, so all
//      shape-aware gates fall through to the strict "unknown" default. Fix:
//      transition.mjs detects shape opportunistically on first transition
//      and persists it, so legacy plans gain the relaxations.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "fs";
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
  const tmp = mkdtempSync(join(tmpdir(), `v741-${suffix}-`));
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

console.log("\nv7.4.1 Tennis-Incident Bug Fixes\n");

// ── Bug 1: TR-005 severity is shape-conditional ──────────────────────
console.log("[Bug 1] TR-005 perspective coverage severity scales with shape");

import("../packs/traceability/index.mjs").then(async (mod) => {
  const pack = mod.default || mod.traceabilityPack || mod;

  const rawFinding = {
    ruleId: "TR-005",
    subject: "calibration",
    detail: "calibration",
    severity: "HIGH",
  };

  const featureCtx = { planShape: { primary: "feature" } };
  const featureNorm = pack.normalizeFinding(rawFinding, featureCtx);
  assert(featureNorm.severity === "LOW",
    "TR-005 severity downgraded to LOW for feature shape");

  const integrationCtx = { planShape: { primary: "integration" } };
  const integrationNorm = pack.normalizeFinding(rawFinding, integrationCtx);
  assert(integrationNorm.severity === "LOW",
    "TR-005 severity downgraded to LOW for integration shape");

  const bugFixCtx = { planShape: { primary: "bug-fix" } };
  const bugFixNorm = pack.normalizeFinding(rawFinding, bugFixCtx);
  assert(bugFixNorm.severity === "HIGH",
    "TR-005 severity STAYS HIGH for bug-fix shape");

  const unknownCtx = { planShape: { primary: "unknown" } };
  const unknownNorm = pack.normalizeFinding(rawFinding, unknownCtx);
  assert(unknownNorm.severity === "HIGH",
    "TR-005 severity STAYS HIGH for unknown shape (legacy strict default)");

  // Other rules (e.g. TR-001) NOT affected by shape downgrade
  const otherRaw = { ruleId: "TR-001", subject: "sc_1", detail: "criterion lacks evidence", severity: "HIGH" };
  const otherNorm = pack.normalizeFinding(otherRaw, featureCtx);
  assert(otherNorm.severity === "HIGH",
    "Other traceability rules (TR-001) keep their original severity regardless of shape");

  // ── Bug 2: recover-poison seeds blank intent_contract from source goal ─
  console.log("\n[Bug 2] recover-poison seeds blank intent_contract from source goal");

  const tmp = makeTemp("recover-blank-intent");
  try {
    // Create a plan with an integration goal
    const sourceGoal = "Add a webhook integration to GHL automation";
    runNode([bootstrap, "new", sourceGoal], tmp);

    // Confirm intent_contract.json starts blank (this is the bug condition)
    const plansDir = join(tmp, "plans");
    const sourcePlanName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
    const sourceIntentPath = join(plansDir, sourcePlanName, "intent_contract.json");
    const sourceIntent = JSON.parse(readFileSync(sourceIntentPath, "utf-8"));
    assert(!sourceIntent.job_to_be_done, "freshly bootstrapped intent_contract has blank job_to_be_done");

    // Forcibly mark the source plan as poisoned by appending failed transitions
    const stateJson = JSON.parse(readFileSync(join(plansDir, sourcePlanName, "state.json"), "utf-8"));
    stateJson.transitions = stateJson.transitions || [];
    for (let i = 0; i < 6; i++) {
      stateJson.transitions.push({
        from: "EXPLORE",
        to: "EXPLORE",
        timestamp: new Date().toISOString(),
        gate_result: "FAIL",
        failure_codes: ["GATE-EXP-001"],
      });
    }
    writeFileSync(join(plansDir, sourcePlanName, "state.json"), JSON.stringify(stateJson, null, 2));

    // Run recover-poison
    const recovery = runNode([bootstrap, "recover-poison"], tmp);
    if (!recovery.ok) {
      console.log("    recover-poison stdout: " + recovery.stdout.slice(0, 300));
      console.log("    recover-poison stderr: " + recovery.stderr.slice(0, 300));
    }
    assert(recovery.ok, "recover-poison runs cleanly on a poisoned plan");

    // Find the successor plan
    const successorPlanName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
    assert(successorPlanName !== sourcePlanName, "recover-poison creates a new successor plan");

    const successorIntent = JSON.parse(readFileSync(join(plansDir, successorPlanName, "intent_contract.json"), "utf-8"));
    assert(typeof successorIntent.job_to_be_done === "string" && successorIntent.job_to_be_done.includes(sourceGoal),
      "successor plan's intent_contract.job_to_be_done seeded with source goal text");
    assert(typeof successorIntent._recovery_note === "string",
      "successor intent_contract carries _recovery_note flag explaining the seeding");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ── Bug 3: opportunistic plan_shape detection on legacy plans ───────
  console.log("\n[Bug 3] transition.mjs detects plan_shape opportunistically when missing");

  const legacyTmp = makeTemp("legacy-no-shape");
  try {
    runNode([bootstrap, "new", "Fix the data pipeline merger join logic"], legacyTmp);
    const plansDir = join(legacyTmp, "plans");
    const planName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
    const statePath = join(plansDir, planName, "state.json");

    // Simulate a legacy plan: strip plan_shape from state.json AND re-sign
    // the integrity hash so the transition runner doesn't reject the file
    // as tampered. This mimics a plan created on v7.2.0 or earlier where
    // plan_shape was never written, then upgraded to v7.4.x.
    const stateJson = JSON.parse(readFileSync(statePath, "utf-8"));
    delete stateJson.plan_shape;
    delete stateJson._state_hash;
    const { computeStateHash } = await import("../scripts/lib/determinism.mjs");
    stateJson._state_hash = computeStateHash(stateJson);
    writeFileSync(statePath, JSON.stringify(stateJson, null, 2));
    assert(!JSON.parse(readFileSync(statePath, "utf-8")).plan_shape,
      "test fixture starts WITHOUT plan_shape (simulates legacy plan)");

    // Run a transition (it'll FAIL because no findings, but should still
    // detect and persist plan_shape before failing).
    runNode([transition, "explore-to-plan"], legacyTmp, { _PLANNER_FAST_TRACK: "1" });

    const afterShape = JSON.parse(readFileSync(statePath, "utf-8")).plan_shape;
    assert(afterShape && afterShape.primary === "bug-fix",
      `legacy plan gains plan_shape=bug-fix on first transition (got ${JSON.stringify(afterShape?.primary)})`);
    assert(afterShape && /opportunistic_legacy/.test(afterShape.source || ""),
      "opportunistic detection records source as opportunistic_legacy");
    assert(afterShape && afterShape.detected_at, "opportunistic detection records detected_at timestamp");
  } finally {
    rmSync(legacyTmp, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
