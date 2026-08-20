#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import { materializeScientificBundle } from "./lib/scientific_fixture.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
let passed = 0;
let failed = 0;
function assert(value, label) { if (value) { passed++; console.log(`  PASS: ${label}`); } else { failed++; console.log(`  FAIL: ${label}`); } }

function diagnosticArtifact(root, reference) {
  const dataPath = join(root, "scientific-source.db");
  writeFileSync(dataPath, "independent non-empty source\n");
  const stable = new Date(Date.now() - 5000);
  utimesSync(dataPath, stable, stable);
  return stampRunRecordPayload({
    version: 2,
    applicable: true,
    run_class: "wiring_proof",
    promotion_verdict: "diagnostic_only",
    scientific_review_request: reference,
    search: { trials_completed: 5, unique_parameter_count: 5, objective_handling: "frozen" },
    controls: [],
    evidence: {
      claimed_data_sources: [{ id: "scientific_source", path: dataPath, expected_worktree_root: root, freshness: { max_age_seconds: 86400 } }],
      strongest_counterargument: "Scientific design validity remains independent of implementation success.",
      falsification_criteria: "Any structural blocker prevents scientific close.",
      presentation_stamp: "diagnostic_only",
    },
  }, {
    producer: "verification_runner", row_id: "VM-SCIENTIFIC-TRANSITION",
    command: "node test_scientific_transition.mjs", exit_code: 0,
    timestamp: "2026-08-03T12:00:00.000Z",
  });
}

function overlapMutation({ artifacts }) {
  const windows = artifacts.preregistration.payload.windows;
  Object.assign(windows.find((row) => row.role === "calibration"), { start: "2025-11-01", end: "2026-01-31" });
  Object.assign(windows.find((row) => row.role === "second_holdout"), { start: "2026-01-01", end: "2026-01-31" });
  artifacts.executed_config.payload.windows = JSON.parse(JSON.stringify(windows));
}

function implementationScienceSeparation() {
  const root = mkdtempSync(join(tmpdir(), "scientific-transition-split-"));
  try {
    const overlap = materializeScientificBundle(root, { mutate: overlapMutation });
    writeFileSync(join(root, "plan.md"), "# Plan\n\nQuant model final OOS result is under scientific review.\n");
    writeFileSync(join(root, "verification.md"), "# Verification\n\nImplementation test PASS.\n");
    writeFileSync(join(root, "reflection.md"), "# Reflection\n");
    writeFileSync(join(root, "quant_results_validation.json"), `${JSON.stringify(diagnosticArtifact(root, overlap.requestReference), null, 2)}\n`);
    const signal = computeQuantResultsValidationSignal({ planDir: root, projectRoot: root });
    assert(signal.implementation_validation?.satisfied === true, "implementation validation remains PASS for a runner-bound artifact");
    assert(signal.satisfied === false && signal.scientific_review?.design_validity === "invalid", "scientific close fails independently when evidence design overlaps");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "scientific-transition-fixture-"));
    try {
      const fixture = materializeScientificBundle(fixtureRoot, { mutate: ({ request }) => { request.run_metadata.is_test = true; } });
      writeFileSync(join(fixtureRoot, "plan.md"), "# Plan\n\nQuant model final OOS result is under scientific review.\n");
      writeFileSync(join(fixtureRoot, "verification.md"), "# Verification\n\nImplementation test PASS.\n");
      writeFileSync(join(fixtureRoot, "reflection.md"), "# Reflection\n");
      writeFileSync(join(fixtureRoot, "quant_results_validation.json"), `${JSON.stringify(diagnosticArtifact(fixtureRoot, fixture.requestReference), null, 2)}\n`);
      const fixtureSignal = computeQuantResultsValidationSignal({ planDir: fixtureRoot, projectRoot: fixtureRoot });
      assert(fixtureSignal.scientific_review?.evidence_grade === "smoke_fixture" && fixtureSignal.satisfied === false, "fixture provenance blocks QRV scientific close");
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }

    const legacyArtifact = diagnosticArtifact(root, overlap.requestReference);
    delete legacyArtifact.scientific_review_request;
    legacyArtifact.run_class = "serious_search";
    writeFileSync(join(root, "quant_results_validation.json"), `${JSON.stringify(legacyArtifact, null, 2)}\n`);
    const legacySignal = computeQuantResultsValidationSignal({ planDir: root, projectRoot: root });
    assert(legacySignal.scientific_review?.evidence_grade === "legacy_unknown", "unstamped historical scientific evidence is classified legacy_unknown");
    assert(legacySignal.scientific_review?.promotion_status === "blocked", "legacy_unknown evidence is not promotable");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function exactOverlapBlocksActualTransition() {
  const root = mkdtempSync(join(tmpdir(), "scientific-transition-real-"));
  try {
    symlinkSync(agentDir, join(root, ".agent"), "dir");
    writeFileSync(join(root, "audit.config.json"), `${JSON.stringify({ roles: ["core"], fail_on: ["CRITICAL"] }, null, 2)}\n`);
    execFileSync(process.execPath, [join(skillDir, "scripts", "bootstrap.mjs"), "new", "--force", "quant model final OOS scientific result close"], { cwd: root, stdio: "pipe", env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" } });
    const planName = readFileSync(join(root, "plans", ".current_plan"), "utf8").trim();
    const planDir = join(root, "plans", planName);
    const bundle = materializeScientificBundle(planDir, { mutate: overlapMutation });
    writeFileSync(join(planDir, "quant_results_validation.json"), `${JSON.stringify(diagnosticArtifact(root, bundle.requestReference), null, 2)}\n`);
    const preTransitionSignal = computeQuantResultsValidationSignal({ planDir, projectRoot: root });
    assert(preTransitionSignal.blocking_issues.includes("scientific_review:time_window_overlap"), "exact EXP-010 overlap enters the live QRV close signal");
    writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nReview quant model final OOS evidence.\n\n## Problem Statement\nThe result must not close when calibration overlaps second holdout.\n\n## Files To Modify\n- reports/model.json\n\n## Verification Strategy\nRun proof:quant_results_validation through validate-to-close.\n\n[KB_NO_NEW_LEARNINGS]\n");
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Criteria Verification\n| # | Criterion | Method | Result |\n|---|---|---|---|\n| 1 | implementation | test | PASS |\n\n## Regression Audit\nCaptured.\n\n## Proof of Work\n```text\nPASS\n```\n");
    writeFileSync(join(planDir, "reflection.md"), "# Reflection\n\nScientific review pending.\n");
    writeFileSync(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");
    const statePath = join(planDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.state = "VALIDATE";
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    let output = "";
    try {
      execFileSync(process.execPath, [join(skillDir, "scripts", "transition.mjs"), "validate-to-close", "--plan", planDir], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" } });
    } catch (error) { output = `${error.stdout || ""}\n${error.stderr || ""}`; }
    assert(output.includes("GATE-VAL-016"), "real validate-to-close transition consumes and blocks on the unsatisfied QRV signal");
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert(after.state !== "CLOSE", "real transition cannot close overlapping evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

implementationScienceSeparation();
exactOverlapBlocksActualTransition();
console.log(`\nScientific transition tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
