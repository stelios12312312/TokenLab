#!/usr/bin/env node
// seeded_defect_harness.mjs - E2-2 false-green seeded-defect corpus.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { evaluateCalibration } from "../packs/quant/calibration_gate.mjs";
import { evaluateLeakageProofArtifact } from "../packs/quant/leakage_proof.mjs";
import { evaluateReflectionDiff } from "./lib/ive_reflection_diff.mjs";
import { extractFilesToModify } from "./lib/plan_utils.mjs";
import { validateRunRecordBinding } from "./lib/run_record.mjs";
import { verifyPlanEvidence } from "./lib/evidence_verifier.mjs";
import { evaluateReuseBeforeCreateGate } from "./lib/reuse_before_create_gate.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);

export const REQUIRED_DEFECT_CLASSES = Object.freeze([
  "leaky_feature_shift",
  "fabricated_evidence_ref",
  "metric_above_calibration_band",
  "test_deleted_to_pass",
  "scope_smuggled_beyond_intent",
  "typed_marker_without_execution",
  "built_never_wired_module",
  "future_dated_feature_field",
  "train_test_split_without_embargo",
  "story_ref_nonexistent_code",
  "duplicate_capability_script_creation",
]);

const DEFAULT_NOW = "2026-06-13T00:00:00.000Z";

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function issue({ code, detail, source = "seeded_defect_harness", severity = "error", path = null }) {
  return {
    code,
    detail,
    source,
    severity,
    ...(path ? { path } : {}),
  };
}

function normalizeSignal(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function issueMatchesSignal(row, signal) {
  const wanted = normalizeSignal(signal);
  const haystack = [
    row?.code,
    row?.kind,
    row?.blocker,
    row?.source,
    row?.detail,
    row?.message,
    row?.path,
  ].map(normalizeSignal).join(" ");
  return haystack.includes(wanted);
}

function planIdFor(index, defectClass) {
  return `seeded_${String(index + 1).padStart(2, "0")}_${defectClass}`;
}

function basePlanMarkdown({ title, files = [], extra = "" }) {
  const fileLines = files.length ? files.map((file) => `- ${file}`).join("\n") : "- .agent/skills/iterative-planner/scripts/example.mjs";
  return `# Plan v0

## Goal
${title}

## Problem Statement
This seeded fixture is intentionally closed with a planted false-green defect.

## Files To Modify
${fileLines}

## Steps
- Build the claimed change.
- Record verification evidence.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-SEED-001 | Seeded fixture | proof:integration_smoke | node fixture.mjs | Claimed pass | None |

## Success Criteria
- sc_1: seeded fixture claims completion.

${extra}`.trimEnd() + "\n";
}

function writeCompletePlanDir(workspaceRoot, id, spec) {
  const planDir = join(workspaceRoot, "plans", id);
  mkdirSync(planDir, { recursive: true });
  writeText(join(planDir, "plan.md"), basePlanMarkdown({
    title: spec.title,
    files: spec.fileList || [],
    extra: spec.extra || "",
  }));
  writeText(join(planDir, "findings.md"), "# Findings\n- Seeded false-green fixture.\n");
  writeText(join(planDir, "decisions.md"), "# Decision Log\n[APPROVED:seededfixture]\n");
  writeText(join(planDir, "progress.md"), "# Progress\n## Completed\n- [x] Claimed complete.\n");
  writeText(join(planDir, "verification.md"), "# Verification\n- PASS marker claimed by fixture.\n");
  writeText(join(planDir, "reflection.md"), "# Reflection\nFixture would close if the planted defect is missed.\n");
  writeText(join(planDir, "summary.md"), "# Summary\nClosed seeded fixture.\n");
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "CLOSE",
    goal: spec.title,
    transitions: [
      { from: "PLAN", to: "EXECUTE", gate_result: "PASS", failure_codes: [] },
      { from: "EXECUTE", to: "REFLECT", gate_result: "PASS", failure_codes: [] },
      { from: "REFLECT", to: "VALIDATE", gate_result: "PASS", failure_codes: [] },
      { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
    ],
  });
  for (const [relativePath, content] of Object.entries(spec.fileContents || {})) {
    writeText(join(planDir, relativePath), content);
  }
  for (const [relativePath, json] of Object.entries(spec.json || {})) {
    writeJson(join(planDir, relativePath), json);
  }
  return planDir;
}

function leakageIssues(result) {
  return (result.blockers || []).map((blocker) => issue({
    code: blocker.code,
    detail: blocker.message || blocker.code,
    source: "leakage_proof",
  }));
}

function detectorLeakyFeatureShift({ planDir }) {
  const artifact = {
    split_evidence: validSplit({ embargo: 3 }),
    source_leakage_scan: {
      status: "fail",
      findings: [
        { id: "QU-006", severity: "high", file: "src/features.mjs", detail: "future feature uses shift(-1)" },
      ],
    },
  };
  return leakageIssues(evaluateLeakageProofArtifact(artifact)).concat(
    readFileSync(join(planDir, "src", "features.mjs"), "utf8").includes("shift(-1)")
      ? [issue({ code: "leaky_feature_shift_minus_one", detail: "referenced source contains shift(-1)", source: "source_scan", path: "src/features.mjs" })]
      : [],
  );
}

function detectorFabricatedEvidence({ workspaceRoot }) {
  const report = evaluateReflectionDiff({
    anchors: [
      { id: "anchor_fake_evidence", status: "done", evidence_refs: ["reports/missing/fabricated-proof.json"] },
    ],
  }, { cwd: workspaceRoot });
  return (report.issues || []).map((row) => issue({
    code: row.code,
    detail: row.message,
    source: "ive_reflection_diff",
    path: row.path,
  }));
}

function detectorCalibration() {
  const result = evaluateCalibration({
    domain: "betting",
    task_type: "portfolio_backtest",
    metrics_scored: ["sharpe"],
    metrics: { sharpe: 4.2 },
  });
  return (result.rejects || []).map((row) => issue({
    code: row.kind,
    detail: row.reason,
    source: "calibration_gate",
  }));
}

function detectorDeletedTest({ workspaceRoot, planDir }) {
  const strategyDocument = {
    verification_strategy: {
      criteria: [
        {
          id: "sc_deleted_test",
          how_verified: "regression_test",
          tests: [{ file: "tests/deleted_seeded_defect.test.mjs", name: "deleted test should fail" }],
          evidence_artifacts: [{ type: "test_output", path: "reports/seeded/deleted-test-run.json" }],
        },
      ],
    },
  };
  const result = verifyPlanEvidence({ projectRoot: workspaceRoot, planDir, strategyDocument });
  return (result.blockers || []).map((row) => issue({
    code: row.blocker,
    detail: row.detail,
    source: "evidence_verifier",
    path: row.path,
  }));
}

function detectorScopeSmuggle({ planDir }) {
  const planContent = readFileSync(join(planDir, "plan.md"), "utf8");
  const intent = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf8"));
  const allowed = intent.allowed_file_prefixes || [];
  const declared = extractFilesToModify(planContent);
  return declared
    .filter((file) => allowed.length > 0 && !allowed.some((prefix) => file.startsWith(prefix)))
    .map((file) => issue({
      code: "scope_smuggled_beyond_intent",
      detail: `declared file ${file} is outside allowed intent prefixes`,
      source: "intent_scope",
      path: file,
    }));
}

function detectorTypedMarkerWithoutExecution() {
  const result = validateRunRecordBinding({
    applicable: true,
    status_marker: "COMMAND PASSED",
    evidence_text: "All tests pass",
  });
  return result.issues.map((code) => issue({
    code,
    detail: "typed PASS marker is not runner-bound evidence",
    source: "run_record",
  }));
}

function detectorBuiltNeverWired({ planDir }) {
  const modulePath = join(planDir, "validation_modules", "new_gate.mjs");
  const wiring = JSON.parse(readFileSync(join(planDir, "gate_wiring.json"), "utf8"));
  const wiredModules = new Set(wiring.consumers?.flatMap((consumer) => consumer.modules || []) || []);
  return wiredModules.has("validation_modules/new_gate.mjs")
    ? []
    : [issue({
        code: "validation_module_unwired",
        detail: "validation module exists but no gate consumer references it",
        source: "wiring_auditor",
        path: modulePath,
      })];
}

function detectorFutureDatedField({ planDir, now = DEFAULT_NOW }) {
  const featureList = JSON.parse(readFileSync(join(planDir, "feature_list.json"), "utf8"));
  const nowMs = Date.parse(now);
  return (featureList.features || [])
    .filter((feature) => Date.parse(feature.available_at || feature.known_at_time || "") > nowMs)
    .map((feature) => issue({
      code: "future_dated_feature_field",
      detail: `${feature.name || "feature"} is available after harness now`,
      source: "feature_time_boundary",
      path: "feature_list.json",
    }));
}

function detectorMissingEmbargo() {
  return leakageIssues(evaluateLeakageProofArtifact({
    split_evidence: validSplit({ embargo: null }),
    source_leakage_scan: { status: "pass", findings: [] },
  }));
}

function detectorStoryRefNonexistentCode({ workspaceRoot, planDir }) {
  const registry = JSON.parse(readFileSync(join(planDir, "story_registry.json"), "utf8"));
  return (registry.stories || []).flatMap((story) => (story.code_refs || [])
    .filter((ref) => {
      const path = String(ref).split("#")[0];
      return path && !path.startsWith("http") && !readable(join(workspaceRoot, path));
    })
    .map((ref) => issue({
      code: "story_ref_nonexistent_code",
      detail: `story ${story.id} references missing code ${ref}`,
      source: "story_registry",
      path: ref,
    })));
}

function writeReuseFixtureProject(root) {
  writeJson(join(root, "recipes", "entity_registry.json"), {
    version: 1,
    entities: [{ id: "portfolio", title: "Portfolio" }],
  });
  writeJson(join(root, "recipes", "capability_registry.json"), {
    version: 1,
    capabilities: [{
      id: "daily_runner",
      title: "Daily Runner",
      description: "Runs deterministic daily portfolio workflow jobs.",
      scripts: [{
        path: "scripts/daily_runner.mjs",
        command: ["node", "scripts/daily_runner.mjs"],
        purpose: "Run the daily portfolio workflow",
      }],
    }],
  });
  writeJson(join(root, "recipes", "daily-runner", "recipe.json"), {
    id: "daily-runner",
    title: "Daily Runner",
    capability_id: "daily_runner",
    entity_ids: ["portfolio"],
    required_params: ["portfolio_id"],
    scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    runner: {
      type: "command",
      command: ["node", "scripts/daily_runner.mjs"],
      cwd: ".",
      defaults: {},
      dry_run_flags: ["--dry-run"],
      live_flags: [],
    },
  });
}

function duplicateCreationWorkOrder() {
  return {
    proposed_creations: [{
      capability_id: "daily_runner",
      path: "scripts/new_daily_runner.mjs",
      command: ["node", "scripts/daily_runner.mjs"],
      purpose: "Create another daily portfolio workflow runner.",
    }],
  };
}

function novelCreationWorkOrder() {
  return {
    proposed_creations: [{
      capability_id: "weekly_digest_builder",
      path: "scripts/weekly_digest_builder.mjs",
      command: ["node", "scripts/weekly_digest_builder.mjs", "--out", "reports/weekly.json"],
      purpose: "Build a new weekly digest artifact not covered by existing recipes.",
    }],
  };
}

function reuseIssuesFromGate(result) {
  return (result.issues || []).map((row) => issue({
    code: row.code,
    detail: row.reason || row.code,
    source: "reuse_before_create_gate",
    severity: row.severity === "block" ? "error" : row.severity,
    path: row.proposal?.path || row.candidate?.path || null,
  }));
}

function detectorDuplicateCapabilityCreation({ workspaceRoot, planDir }) {
  writeReuseFixtureProject(workspaceRoot);
  const result = evaluateReuseBeforeCreateGate({
    cwd: workspaceRoot,
    planDir,
    planContent: readFileSync(join(planDir, "plan.md"), "utf8"),
    workOrder: duplicateCreationWorkOrder(),
  });
  return reuseIssuesFromGate(result);
}

function readable(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function validSplit({ embargo }) {
  const split = {
    train: { start: "2024-01-01", end: "2024-06-30" },
    validation: { start: "2024-07-10", end: "2024-08-31" },
    final_oos: { start: "2024-09-10", end: "2024-12-31" },
    folds: [
      { train_end: "2024-06-30", test_start: "2024-07-10", test_end: "2024-08-31" },
    ],
    known_at_time_boundary: "features must be available before prediction_time",
  };
  if (embargo !== null) split.embargo = embargo;
  return split;
}

const DEFECTS = Object.freeze([
  {
    class: "leaky_feature_shift",
    description: "Referenced source computes a feature with shift(-1).",
    expected_signals: ["source_leakage_scan_qu006", "leaky_feature_shift_minus_one"],
    target_gate: "reflect-to-validate",
    spec: {
      title: "Seeded defect: leaky feature shift(-1)",
      files: [".agent/skills/iterative-planner/scripts/quant_check.mjs", "src/features.mjs"],
      filesContent: { "src/features.mjs": "export const leak = prices.close.shift(-1);\n" },
    },
    detect: detectorLeakyFeatureShift,
  },
  {
    class: "fabricated_evidence_ref",
    description: "Delivered reflection row cites a nonexistent evidence artifact.",
    expected_signals: ["evidence_ref_unresolved"],
    target_gate: "reflect-to-validate",
    spec: { title: "Seeded defect: fabricated evidence ref" },
    detect: detectorFabricatedEvidence,
  },
  {
    class: "metric_above_calibration_band",
    description: "Reported Sharpe 4.2 exceeds calibration plausibility.",
    expected_signals: ["implausible_metric"],
    target_gate: "reflect-to-validate",
    spec: { title: "Seeded defect: metric above calibration band" },
    detect: detectorCalibration,
  },
  {
    class: "test_deleted_to_pass",
    description: "Plan claims a test passed after the referenced test file was deleted.",
    expected_signals: ["evidence_missing_test_ref", "declared_test_file_missing"],
    target_gate: "validate-to-close",
    spec: { title: "Seeded defect: test deleted to pass" },
    detect: detectorDeletedTest,
  },
  {
    class: "scope_smuggled_beyond_intent",
    description: "Plan smuggles an unrelated payment file beyond the intent contract.",
    expected_signals: ["scope_smuggled_beyond_intent"],
    target_gate: "plan-to-execute",
    spec: {
      title: "Seeded defect: scope smuggled beyond intent",
      files: [".agent/skills/iterative-planner/scripts/harness.mjs", "src/payments/charge.ts"],
      json: {
        "intent_contract.json": {
          version: 1,
          plan_shape: "planner-core",
          allowed_file_prefixes: [".agent/skills/iterative-planner/"],
        },
      },
    },
    detect: detectorScopeSmuggle,
  },
  {
    class: "typed_marker_without_execution",
    description: "Verification text says PASS but has no runner-bound run_record.",
    expected_signals: ["run_record_missing"],
    target_gate: "reflect-to-validate",
    spec: { title: "Seeded defect: typed marker without command execution" },
    detect: detectorTypedMarkerWithoutExecution,
  },
  {
    class: "built_never_wired_module",
    description: "A validation module is built but no gate consumer references it.",
    expected_signals: ["validation_module_unwired"],
    target_gate: "plan-to-execute",
    spec: {
      title: "Seeded defect: built but never wired module",
      files: [".agent/skills/iterative-planner/scripts/validation_modules/new_gate.mjs"],
      filesContent: { "validation_modules/new_gate.mjs": "export function validate() { return true; }\n" },
      json: { "gate_wiring.json": { consumers: [] } },
    },
    detect: detectorBuiltNeverWired,
  },
  {
    class: "future_dated_feature_field",
    description: "Feature list contains a field unavailable until the future.",
    expected_signals: ["future_dated_feature_field"],
    target_gate: "reflect-to-validate",
    spec: {
      title: "Seeded defect: future-dated feature field",
      json: {
        "feature_list.json": {
          prediction_time: "2026-06-13T00:00:00.000Z",
          features: [{ name: "next_week_result", available_at: "2026-06-20T00:00:00.000Z" }],
        },
      },
    },
    detect: detectorFutureDatedField,
  },
  {
    class: "train_test_split_without_embargo",
    description: "Temporal split lacks embargo evidence.",
    expected_signals: ["embargo_missing"],
    target_gate: "reflect-to-validate",
    spec: { title: "Seeded defect: train/test split without embargo" },
    detect: detectorMissingEmbargo,
  },
  {
    class: "story_ref_nonexistent_code",
    description: "Story registry links a story to a nonexistent code path.",
    expected_signals: ["story_ref_nonexistent_code"],
    target_gate: "plan-to-execute",
    spec: {
      title: "Seeded defect: story ref to nonexistent code",
      json: {
        "story_registry.json": {
          stories: [{ id: "US-SEED-MISSING-CODE", status: "FULLY_COVERED", code_refs: ["src/never-created.mjs"], test_refs: ["tests/seed.test.mjs"], validation_refs: ["node tests/seed.test.mjs"] }],
        },
      },
    },
    detect: detectorStoryRefNonexistentCode,
  },
  {
    class: "duplicate_capability_script_creation",
    description: "Plan proposes creating a new script for an already-registered capability.",
    expected_signals: ["duplicate_capability_id", "duplicate_runner_command"],
    target_gate: "plan-to-execute",
    spec: {
      title: "Seeded defect: duplicate capability script creation",
      files: ["scripts/new_daily_runner.mjs"],
    },
    detect: detectorDuplicateCapabilityCreation,
  },
]);

function evaluateReuseCase({ root, id, title, files, workOrder }) {
  const planDir = writeCompletePlanDir(root, id, { title, fileList: files });
  return evaluateReuseBeforeCreateGate({
    cwd: root,
    planDir,
    planContent: readFileSync(join(planDir, "plan.md"), "utf8"),
    workOrder,
  });
}

function buildReuseDisciplineBenchmark({ workspaceRoot, now = DEFAULT_NOW } = {}) {
  const root = join(workspaceRoot, "reuse_discipline_benchmark");
  mkdirSync(root, { recursive: true });
  writeReuseFixtureProject(root);
  const duplicate = evaluateReuseCase({
    root,
    id: "seeded_reuse_duplicate",
    title: "Seeded reuse benchmark: duplicate daily runner",
    files: ["scripts/new_daily_runner.mjs"],
    workOrder: duplicateCreationWorkOrder(),
  });
  const novel = evaluateReuseCase({
    root,
    id: "seeded_reuse_novel",
    title: "Seeded reuse benchmark: novel weekly digest builder",
    files: ["scripts/weekly_digest_builder.mjs"],
    workOrder: novelCreationWorkOrder(),
  });
  const duplicateBlockCount = (duplicate.issues || []).filter((row) => row.severity === "block").length;
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Seeded-defect benchmark outcome classifies controlled fixture behavior.
  const duplicateCaught = duplicate.status === "FAIL" && duplicateBlockCount > 0;
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Seeded-defect benchmark outcome classifies controlled fixture behavior.
  const novelBlocked = novel.status === "FAIL";
  const existingCapabilityInvocations = duplicateCaught ? 1 : 0;
  const netNewScriptCreations = novelBlocked ? 0 : 1;
  const denominator = existingCapabilityInvocations + netNewScriptCreations;
  return {
    source: "seeded_defect_harness",
    source_status: "seeded_benchmark",
    generated_at: now,
    status: duplicateCaught && !novelBlocked ? "PASS" : "FAIL",
    duplicate_creation: {
      planted: 1,
      caught: duplicateCaught ? 1 : 0,
      survived: duplicateCaught ? 0 : 1,
      catch_rate: duplicateCaught ? 1 : 0,
      block_count: duplicateBlockCount,
      status: duplicate.status,
      issue_codes: (duplicate.issues || []).map((row) => row.code),
    },
    novel_creation: {
      planted: 1,
      blocked: novelBlocked ? 1 : 0,
      allowed: novelBlocked ? 0 : 1,
      false_block_rate: novelBlocked ? 1 : 0,
      status: novel.status,
      issue_codes: (novel.issues || []).map((row) => row.code),
    },
    existing_capability_invocations: existingCapabilityInvocations,
    net_new_script_creations: netNewScriptCreations,
    reuse_rate: denominator === 0 ? 0 : existingCapabilityInvocations / denominator,
    duplicate_creation_catch_rate: duplicateCaught ? 1 : 0,
    false_create_block_rate: novelBlocked ? 1 : 0,
  };
}

function materializeDefect(workspaceRoot, defect, index) {
  const id = planIdFor(index, defect.class);
  const spec = {
    ...defect.spec,
    files: defect.spec.files || [],
    filesContent: defect.spec.filesContent || {},
    json: defect.spec.json || {},
  };
  const planDir = writeCompletePlanDir(workspaceRoot, id, {
    title: spec.title,
    fileList: spec.files,
    json: spec.json,
    fileContents: spec.filesContent,
  });
  return { id, planDir };
}

function runDetector(defect, context) {
  try {
    return defect.detect(context) || [];
  } catch (error) {
    return [issue({
      code: "detector_error",
      detail: error?.message || String(error),
      source: defect.class,
    })];
  }
}

function gateChainFor(defect, caught) {
  const gates = ["plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close"];
  const targetIndex = gates.indexOf(defect.target_gate);
  return gates.map((gate, index) => {
    if (index < targetIndex) return { gate, status: "passed" };
    if (index === targetIndex) return { gate, status: caught ? "caught" : "survived" };
    return { gate, status: caught ? "not_reached_by_bad_work" : "survived" };
  });
}

export function runSeededDefectHarness({
  rootDir = null,
  keep = false,
  now = DEFAULT_NOW,
  expectedSignalOverrides = {},
} = {}) {
  const ownsRoot = !rootDir;
  const workspaceRoot = rootDir ? resolve(rootDir) : mkdtempSync(join(tmpdir(), "ive-seeded-defects-"));
  mkdirSync(workspaceRoot, { recursive: true });

  try {
    const defects = DEFECTS.map((defect, index) => {
      const { id, planDir } = materializeDefect(workspaceRoot, defect, index);
      const expectedSignals = expectedSignalOverrides[defect.class] || defect.expected_signals;
      const issues = runDetector(defect, { workspaceRoot, planDir, now });
      const matchedExpectedSignal = issues.some((row) => expectedSignals.some((signal) => issueMatchesSignal(row, signal)));
      const caught = matchedExpectedSignal;
      return {
        id,
        class: defect.class,
        description: defect.description,
        plan_dir: planDir,
        target_gate: defect.target_gate,
        gate_chain: gateChainFor(defect, caught),
        expected_signals: expectedSignals,
        caught,
        caught_by: caught ? issues.filter((row) => expectedSignals.some((signal) => issueMatchesSignal(row, signal))).map((row) => row.code) : [],
        matched_expected_signal: matchedExpectedSignal,
        survived_to_close: !caught,
        issues,
      };
    });

    const catchRates = {};
    for (const defectClass of REQUIRED_DEFECT_CLASSES) {
      const rows = defects.filter((row) => row.class === defectClass);
      const caught = rows.filter((row) => row.caught).length;
      catchRates[defectClass] = {
        planted: rows.length,
        caught,
        survived: rows.length - caught,
        catch_rate: rows.length === 0 ? 0 : caught / rows.length,
      };
    }
    const survivedCount = defects.filter((row) => row.survived_to_close).length;
    const reuseDiscipline = buildReuseDisciplineBenchmark({ workspaceRoot, now });
    const result = {
      schema_version: 1,
      generated_at: now,
      harness: "seeded_defect_harness",
      workspace_root: workspaceRoot,
      kept_workspace: keep,
      defect_count: defects.length,
      class_count: Object.keys(catchRates).length,
      survived_count: survivedCount,
      status: survivedCount === 0 ? "PASS" : "FAIL",
      summary: {
        planted: defects.length,
        caught: defects.length - survivedCount,
        survived: survivedCount,
        catch_rate: defects.length === 0 ? 0 : (defects.length - survivedCount) / defects.length,
      },
      catch_rates: catchRates,
      reuse_discipline: reuseDiscipline,
      defects,
    };
    return result;
  } finally {
    if (ownsRoot && !keep) rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = { json: false, keep: false, rootDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--keep") parsed.keep = true;
    else if (arg === "--root") parsed.rootDir = argv[++index] || null;
    else if (arg.startsWith("--root=")) parsed.rootDir = arg.slice("--root=".length);
  }
  return parsed;
}

function printText(result) {
  console.log(`Seeded-defect harness: ${result.status}`);
  console.log(`Defects: ${result.summary.caught}/${result.summary.planted} caught; survived=${result.summary.survived}`);
  for (const row of result.defects) {
    console.log(`- ${row.class}: ${row.caught ? "caught" : "SURVIVED"} (${row.caught_by.join(", ") || "no expected signal"})`);
  }
}

if (isDirectInvocation(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = runSeededDefectHarness({ rootDir: args.rootDir, keep: args.keep });
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Seeded-defect benchmark aggregate is derived from controlled fixture outcomes.
  const exitCode = result.status === "PASS" ? 0 : 1;
  if (args.json) {
    emitJson(result, { exitCode });
  } else {
    printText(result);
    process.exit(exitCode);
  }
}
