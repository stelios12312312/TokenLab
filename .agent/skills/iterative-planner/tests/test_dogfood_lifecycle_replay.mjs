#!/usr/bin/env node
// test_dogfood_lifecycle_replay.mjs - Tier 2 committed journey compatibility proof.

import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { evaluateGateResults } from "../scripts/verify_gate.mjs";
import { summarizeProofTelemetry } from "../scripts/lib/proof_telemetry.mjs";
import { analyzeMutuallyExclusiveSubstrate } from "../scripts/lib/semantic_substrate.mjs";
import {
  DEFAULT_DOGFOOD_PLAN_SPECS,
  replayDogfoodLifecycleCorpus,
} from "../scripts/lib/dogfood_lifecycle_replay.mjs";
import {
  captureGateInputSnapshot,
  removeGateInputSnapshot,
  resolveGateInputSnapshot,
} from "../scripts/lib/gate_input_snapshot.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const repoRoot = resolve(skillRoot, "..", "..", "..");
const cli = join(skillRoot, "scripts", "dogfood_lifecycle_replay.mjs");
const NODE = process.execPath;
const INCIDENT_PLN017_NAME = "Context-sensitive verification matrix is defined for recipe/orchestration/integration-style work";
const INCIDENT_PLN017_DETAIL = "selected Verification Strategy table at line 80; sc_1 (`clamp` preserves in-range values and enforces both bounds: `node --test tests/clamp.test.mjs` passes all 3 assertions after the one-line repair (AC-US-001-001).) still relies on wrapper/unit proof only; Verification Strategy does not show proof coverage for synthesized obligation migration/parity; suggested proof IDs: proof:migration_parity, proof:migration_verification, proof:live_parity_check";
const INCIDENT_PLN017_FAILURE = `GATE-PLN-017: ${INCIDENT_PLN017_NAME} - ${INCIDENT_PLN017_DETAIL}`;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("\nCommitted Dogfood Lifecycle Replay Tests\n");

const stateBefore = new Map(DEFAULT_DOGFOOD_PLAN_SPECS.map((spec) => [
  spec.plan_dir,
  readFileSync(join(repoRoot, spec.plan_dir, "state.json"), "utf-8"),
]));
const report = replayDogfoodLifecycleCorpus({ repoRoot, generatedAt: "2026-07-09T00:00:00.000Z" });
assert(report.ok && report.status === "PASS", "real three-plan corpus passes current-code replay", JSON.stringify(report.failures));
assert(report.corpus.plan_count === 3, "default corpus pins exactly three plans");
assert(new Set(report.corpus.shapes).size === 3, "default corpus spans three distinct journey shapes");
assert(report.corpus.all_plans_tracked === true, "all default plans and canonical proof surfaces are tracked");
assert(report.plans.every((plan) => plan.gates.length === 6), "every plan replays all six recorded gates");
assert(report.plans.every((plan) => plan.recorded_transition_chain.length === 5 && plan.recorded_transition_chain.every((row) => row.ok)), "every plan has the legal five-edge state-changing chain");
assert(report.plans.every((plan) => plan.gates.every((gate) => ["PASS", "HISTORICAL_ONLY"].includes(gate.current_code.js_contract))), "current JS replay accepts every replayable contract and classifies time-bound checks");
assert(report.plans.every((plan) => plan.gates.filter((gate) => gate.gate !== "notify-user").every((gate) => ["PASS", "HISTORICAL_ONLY"].includes(gate.current_code.prolog_transition))), "current Prolog replay accepts every replayable state-changing edge and classifies time-bound checks");
assert(report.plans.every((plan) => {
  const explore = plan.gates.find((gate) => gate.gate === "explore-to-plan");
  return explore?.current_code.js_contract === "PASS"
    && explore?.current_code.prolog_transition === "PASS"
    && explore?.current_code.advisory_checks?.some((entry) => entry.code === "GATE-EXP-010" && entry.advisory_conversion === true);
}), "mutable KB-digest proof remains visible as an advisory instead of being rehashed into a blocker");
assert(report.plans.every((plan) => plan.close_signals.every((signal) => signal.satisfied)), "required close signals remain satisfied");
assert(report.plans.every((plan) => plan.state_json_bytes_unchanged), "replay reports unchanged state.json bytes");
assert(DEFAULT_DOGFOOD_PLAN_SPECS.every((spec) => readFileSync(join(repoRoot, spec.plan_dir, "state.json"), "utf-8") === stateBefore.get(spec.plan_dir)), "real state.json files are byte-identical after replay");
assert(report.claim_boundary.does_not_prove.includes("live lifecycle execution"), "claim boundary excludes L1 live execution");
assert(report.claim_boundary.does_not_prove.includes("autonomous coding behavior"), "claim boundary excludes L3 autonomous coding");

const injected = replayDogfoodLifecycleCorpus({
  repoRoot,
  planSpecs: DEFAULT_DOGFOOD_PLAN_SPECS,
  generatedAt: "2026-07-09T00:00:00.000Z",
  gateEvaluator(planDir, gate) {
    if (gate === "plan-to-execute" && planDir.endsWith("plan_2026-07-06_a562d891f2f965d0")) {
      return { results: [{ status: "FAIL", code: "TEST-INCOMPATIBLE", name: "Seeded contract drift", detail: "required artifact contract changed" }] };
    }
    return evaluateGateResults(planDir, gate);
  },
});
const injectedFailure = injected.failures.find((entry) => entry.code === "current_gate_contract_rejected");
assert(injected.status === "FAIL", "seeded current gate incompatibility fails replay");
assert(injectedFailure?.plan === "plan_2026-07-06_a562d891f2f965d0", "gate incompatibility names the plan");
assert(injectedFailure?.gate === "plan-to-execute", "gate incompatibility names the gate");
assert(injectedFailure?.detail.includes("TEST-INCOMPATIBLE"), "gate incompatibility retains the failed check code");

const snapshotTmp = mkdtempSync(join(tmpdir(), "dogfood-gate-input-snapshot-"));
try {
  symlinkSync(join(repoRoot, ".agent"), join(snapshotTmp, ".agent"), "dir");
  for (const spec of DEFAULT_DOGFOOD_PLAN_SPECS) {
    cpSync(join(repoRoot, spec.plan_dir), join(snapshotTmp, spec.plan_dir), { recursive: true });
  }
  const incidentSpec = DEFAULT_DOGFOOD_PLAN_SPECS[0];
  const incidentPlanDir = join(snapshotTmp, incidentSpec.plan_dir);
  const incidentStatePath = join(incidentPlanDir, "state.json");
  const finalStateBytes = readFileSync(incidentStatePath, "utf-8");
  const incidentFailureResult = {
    results: [{ status: "FAIL", code: "GATE-PLN-017", name: INCIDENT_PLN017_NAME, detail: INCIDENT_PLN017_DETAIL }],
  };
  const receiptShapedEvaluator = (planDir, gate) => {
    if (gate === "plan-to-execute" && planDir.endsWith(incidentSpec.plan_dir.split("/").at(-1))) {
      return incidentFailureResult;
    }
    return evaluateGateResults(planDir, gate);
  };
  const legacyControl = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator: receiptShapedEvaluator,
  });
  const legacyIncident = legacyControl.plans[0].gates.find((entry) => entry.gate === "plan-to-execute");
  assert(legacyControl.status === "FAIL", "receipt-shaped final-plan control reproduces the lifecycle replay failure");
  assert(legacyIncident?.current_code.input_source === "final_plan_legacy_fallback", "snapshot-absent replay reports the legacy final-plan provenance");
  assert(legacyControl.failures.some((entry) => entry.detail === INCIDENT_PLN017_FAILURE), "final-plan control reproduces the exact immutable receipt failure detail");

  const gateTimeState = JSON.parse(finalStateBytes);
  gateTimeState.state = "PLAN";
  writeFileSync(incidentStatePath, `${JSON.stringify(gateTimeState, null, 2)}\n`);
  const captured = captureGateInputSnapshot({
    planDir: incidentPlanDir,
    gate: "plan-to-execute",
    capturedAt: "2026-07-20T15:20:00.000Z",
  });
  writeFileSync(incidentStatePath, finalStateBytes);
  const resolvedSnapshot = resolveGateInputSnapshot({ planDir: incidentPlanDir, gate: "plan-to-execute" });
  assert(captured.status === "valid" && resolvedSnapshot.status === "valid", "content-hashed plan-to-execute snapshot resolves as valid");
  assert(JSON.parse(readFileSync(join(resolvedSnapshot.path, "state.json"), "utf-8")).state === "PLAN", "snapshot retains the gate-time PLAN state while the canonical plan remains CLOSE");
  const firstPointerBytes = readFileSync(resolvedSnapshot.pointer_path, "utf-8");
  let duplicateCaptureError = null;
  try {
    captureGateInputSnapshot({ planDir: incidentPlanDir, gate: "plan-to-execute", capturedAt: "2026-07-20T15:20:30.000Z" });
  } catch (error) {
    duplicateCaptureError = error;
  }
  assert(duplicateCaptureError?.message.includes("pointer already exists") && readFileSync(resolvedSnapshot.pointer_path, "utf-8") === firstPointerBytes, "a second capture cannot overwrite existing replay authority");

  const snapshotReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator(planDir, gate) {
      if (gate === "plan-to-execute" && planDir === resolvedSnapshot.path) return { results: [{ status: "PASS", code: "GATE-PLN-017", name: INCIDENT_PLN017_NAME, detail: "Gate-time matrix contains the required migration/parity proof." }] };
      return receiptShapedEvaluator(planDir, gate);
    },
  });
  const snapshotIncident = snapshotReplay.plans[0].gates.find((entry) => entry.gate === "plan-to-execute");
  assert(snapshotReplay.status === "PASS", "verified gate-time snapshot repairs the exact final-state over-synthesis false red");
  assert(snapshotIncident?.current_code.input_source === "gate_time_snapshot", "snapshot replay reports gate_time_snapshot provenance");
  assert(snapshotIncident?.current_code.input_plan_dir.endsWith("2026-07-20T15-20-00-000Z_plan-to-execute"), "snapshot replay names the exact verified input directory");

  const strictSnapshotReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator(planDir, gate) {
      if (gate === "plan-to-execute" && planDir === resolvedSnapshot.path) return incidentFailureResult;
      return evaluateGateResults(planDir, gate);
    },
  });
  assert(strictSnapshotReplay.status === "FAIL", "snapshot-level PLN-017 remains a hard current contract failure");
  assert(strictSnapshotReplay.failures.some((entry) => entry.detail === INCIDENT_PLN017_FAILURE), "strict snapshot rejection retains the exact receipt-shaped PLN-017 detail");

  writeFileSync(join(resolvedSnapshot.path, "plan.md"), `${readFileSync(join(resolvedSnapshot.path, "plan.md"), "utf-8")}\nTAMPER\n`);
  let tamperedEvaluatorCalls = 0;
  const tamperedReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator(planDir, gate) {
      if (gate === "plan-to-execute" && planDir.includes("gate_input_snapshots")) tamperedEvaluatorCalls += 1;
      return evaluateGateResults(planDir, gate);
    },
  });
  const tamperedIncident = tamperedReplay.plans[0].gates.find((entry) => entry.gate === "plan-to-execute");
  assert(tamperedReplay.failures.some((entry) => entry.code === "gate_input_snapshot_invalid"), "hash-mismatched snapshot fails closed");
  assert(tamperedIncident?.current_code.js_contract === "FAIL" && tamperedEvaluatorCalls === 0, "invalid snapshot bytes are never sent to the gate evaluator");

  writeFileSync(resolvedSnapshot.pointer_path, "{malformed\n");
  const malformedReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator: evaluateGateResults,
  });
  assert(malformedReplay.failures.some((entry) => entry.code === "gate_input_snapshot_invalid" && entry.detail.includes("not valid JSON")), "malformed snapshot pointer fails closed");

  const tamperedCleanup = removeGateInputSnapshot(resolvedSnapshot);
  assert(
    tamperedCleanup.status === "cleanup_pending"
      && existsSync(resolvedSnapshot.path)
      && existsSync(resolvedSnapshot.pointer_path),
    "owned snapshot cleanup preserves replaced input and pointer bytes",
  );
  rmSync(dirname(resolvedSnapshot.pointer_path), { recursive: true, force: true });
  writeFileSync(incidentStatePath, `${JSON.stringify(gateTimeState, null, 2)}\n`);
  const recaptured = captureGateInputSnapshot({
    planDir: incidentPlanDir,
    gate: "plan-to-execute",
    capturedAt: "2026-07-20T15:21:00.000Z",
  });
  writeFileSync(incidentStatePath, finalStateBytes);
  unlinkSync(join(recaptured.path, "state.json"));
  const incompleteReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator: evaluateGateResults,
  });
  assert(incompleteReplay.failures.some((entry) => entry.code === "gate_input_snapshot_invalid" && entry.detail.includes("snapshot file is missing: state.json")), "incomplete snapshot file census fails closed");

  const incompleteCleanup = removeGateInputSnapshot(recaptured);
  assert(
    incompleteCleanup.status === "cleanup_pending" && existsSync(recaptured.path),
    "owned snapshot cleanup preserves an incomplete replacement tree",
  );
  rmSync(dirname(recaptured.pointer_path), { recursive: true, force: true });
  writeFileSync(incidentStatePath, `${JSON.stringify(gateTimeState, null, 2)}\n`);
  const escapeCandidate = captureGateInputSnapshot({
    planDir: incidentPlanDir,
    gate: "plan-to-execute",
    capturedAt: "2026-07-20T15:22:00.000Z",
  });
  writeFileSync(incidentStatePath, finalStateBytes);
  const escapedPointer = JSON.parse(readFileSync(escapeCandidate.pointer_path, "utf-8"));
  escapedPointer.snapshot_dir = "../escaped";
  writeFileSync(escapeCandidate.pointer_path, `${JSON.stringify(escapedPointer, null, 2)}\n`);
  const escapedReplay = replayDogfoodLifecycleCorpus({
    repoRoot: snapshotTmp,
    requireTracked: false,
    gateEvaluator: evaluateGateResults,
  });
  assert(escapedReplay.failures.some((entry) => entry.code === "gate_input_snapshot_invalid" && entry.detail.includes("snapshot_dir")), "escaped snapshot pointer fails closed with explicit provenance detail");

  removeGateInputSnapshot(escapeCandidate);
  const snapshotRoot = dirname(escapeCandidate.pointer_path);
  rmSync(snapshotRoot, { recursive: true, force: true });
  const externalSnapshotRoot = mkdtempSync(join(tmpdir(), "dogfood-external-snapshot-root-"));
  try {
    symlinkSync(externalSnapshotRoot, snapshotRoot, "dir");
    const symlinkRoot = resolveGateInputSnapshot({ planDir: incidentPlanDir, gate: "plan-to-execute" });
    assert(symlinkRoot.status === "invalid" && symlinkRoot.errors.some((entry) => entry.includes("root must be a regular directory")), "symlinked snapshot root fails closed before any external artifact read");
  } finally {
    rmSync(snapshotRoot, { force: true });
    rmSync(externalSnapshotRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(snapshotTmp, { recursive: true, force: true });
}

const finalArtifactPlanDir = join(repoRoot, "plans", "plan_2026-07-11_04daff7be40be477");
const latePlannerConfigFiles = [
  "src/clamp.mjs",
  ".agent/skills/iterative-planner/config/source_hygiene.json",
];
const latePlannerConfigTelemetry = summarizeProofTelemetry({
  cwd: repoRoot,
  planDir: finalArtifactPlanDir,
  planDirName: "plan_2026-07-11_04daff7be40be477",
  goalText: "Repair the seeded clamp defect and preserve the immutable test",
  planContent: "# Final L2 replay artifact\n\n## Files To Modify\n- src/clamp.mjs\n- .agent/skills/iterative-planner/config/source_hygiene.json\n",
  plannedFiles: latePlannerConfigFiles,
  persist: false,
});
assert(!latePlannerConfigTelemetry.task_signals.includes("config_flags_changed"), "attempt-6-shaped final artifact does not relabel planner config as a host config change");
const latePlannerConfigSubstrate = analyzeMutuallyExclusiveSubstrate({
  goal: "Repair the seeded clamp defect and preserve the immutable test",
  planContent: "# Final L2 replay artifact",
  plannedFiles: latePlannerConfigFiles,
  proofTelemetry: latePlannerConfigTelemetry,
  annotationContext: { trusted_annotations: [], trusted_candidate_files: latePlannerConfigFiles },
});
assert(latePlannerConfigSubstrate.required === false, "attempt-6-shaped final artifact keeps GATE-REF-016 non-applicable without magic prose");

const realHostConfigFiles = ["src/clamp.mjs", "config/runtime.json"];
const realHostConfigTelemetry = summarizeProofTelemetry({
  cwd: repoRoot,
  planDir: finalArtifactPlanDir,
  planDirName: "plan_2026-07-11_04daff7be40be477",
  goalText: "Repair the seeded clamp defect",
  planContent: "# Strict host-config control",
  plannedFiles: realHostConfigFiles,
  persist: false,
});
assert(realHostConfigTelemetry.task_signals.includes("config_flags_changed"), "genuine host config path still emits the config task signal");
const realHostConfigSubstrate = analyzeMutuallyExclusiveSubstrate({
  goal: "Repair the seeded clamp defect",
  planContent: "# Strict host-config control",
  plannedFiles: realHostConfigFiles,
  proofTelemetry: realHostConfigTelemetry,
  annotationContext: { trusted_annotations: [], trusted_candidate_files: realHostConfigFiles },
});
assert(realHostConfigSubstrate.required === true && realHostConfigSubstrate.declared === false, "genuine host config control still requires mutually-exclusive semantic facts");

const tmp = mkdtempSync(join(tmpdir(), "dogfood-lifecycle-replay-"));
try {
  symlinkSync(join(repoRoot, ".agent"), join(tmp, ".agent"), "dir");
  for (const spec of DEFAULT_DOGFOOD_PLAN_SPECS) {
    cpSync(join(repoRoot, spec.plan_dir), join(tmp, spec.plan_dir), { recursive: true });
  }
  const target = join(tmp, DEFAULT_DOGFOOD_PLAN_SPECS[2].plan_dir);
  unlinkSync(join(target, "verification.md"));
  const tampered = replayDogfoodLifecycleCorpus({
    repoRoot: tmp,
    skillRoot,
    planSpecs: DEFAULT_DOGFOOD_PLAN_SPECS,
    requireTracked: false,
    generatedAt: "2026-07-09T00:00:00.000Z",
  });
  const missing = tampered.failures.find((entry) => entry.code === "required_artifact_missing" && entry.artifact === "verification.md");
  assert(tampered.status === "FAIL", "tampered required artifact fails replay");
  assert(missing?.plan === "plan_2026-07-09_09ac37d240a5fc72", "tampered artifact failure names the plan");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const cliReport = JSON.parse(execFileSync(NODE, [cli, "--json"], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }));
assert(cliReport.status === "PASS", "JSON CLI runs the real default corpus");
assert(cliReport.replay_id === "tier2_committed_dogfood_lifecycle_replay", "JSON CLI exposes stable replay id");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
