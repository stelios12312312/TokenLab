#!/usr/bin/env node
// Focused tests for annotation_hints.mjs.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { analyzeAnnotationHints } from "../scripts/annotation_hints.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function makeBaseFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-annotation-hints-"));
  writeJson(join(tmp, "reports", "user_story_audit", "project_goals.json"), {
    goals: [
      { id: "G-001", title: "Evidence-backed workflow", description: "Keep story-linked evidence visible." },
      { id: "G-002", title: "Uncovered future workflow", description: "Exercise feature-gap hints." },
    ],
  });
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    stories: [
      {
        id: "US-100",
        title: "Annotated source has a downstream consumer",
        status: "FULLY_COVERED",
        code_refs: ["src/source.py"],
        test_refs: ["tests/test_source.py"],
        validation_refs: ["tests/test_source.py"],
        goal_refs: ["G-001"],
      },
      {
        id: "US-101",
        title: "Affected story has no validation reference",
        status: "PARTIALLY_COVERED",
        code_refs: ["src/no_validation.py"],
        test_refs: [],
        validation_refs: [],
        goal_refs: ["G-001"],
      },
      {
        id: "US-102",
        title: "Planner-core gate file keeps selected-file impact truth",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        goal_refs: ["G-001"],
      },
    ],
  });
  writeText(join(tmp, "tests", "test_source.py"), "# validation target\n");
  writeText(join(tmp, ".agent", "skills", "iterative-planner", "scripts", "verify_gate.mjs"), "// planner-core gate fixture\n");
  writeText(join(tmp, ".agent", "skills", "iterative-planner", "tests", "test_transition_gate_flows.mjs"), "// gate test fixture\n");
  writeText(join(tmp, "src", "source.py"), `# @planner:story = US-100
# @planner:consumer = tests/test_source.py
def source():
    return True
`);
  writeText(join(tmp, "src", "no_validation.py"), `# @planner:story = US-101
def missing_validation():
    return True
`);
  writeText(join(tmp, "src", "flags.py"), `# @planner:story = US-100
# @planner:config_flag = selector_probability_diagnostic_only
# @planner:mutually_exclusive = selector_probability_as_stake
VALUE = True
`);
  return tmp;
}

function makeStaleFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-annotation-hints-stale-"));
  const planName = "plan_stale_fixture";
  writeText(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeText(join(tmp, "plans", planName, "plan.md"), `# Plan

## Goal
Stale proof fixture

## Success Criteria
1. Known proof criterion
`);
  writeText(join(tmp, "src", "stale.py"), `# @planner:proves = crit:ghost
def stale():
    return True
`);
  return tmp;
}

function runBin(bin, args, cwd) {
  return execFileSync(bin, args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function runNode(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function scenarioFileImpactHints() {
  const tmp = makeBaseFixture();
  try {
    const report = analyzeAnnotationHints({ cwd: tmp, files: ["src/source.py"] });
    assert(report.status === "WARN", "source file produces WARN-only annotation hints");
    assert(report.summary.invalid === 0 && report.summary.stale === 0, "clean fixture has no invalid or stale annotation facts");
    assert(report.hints.some((hint) =>
      hint.type === "affected_story" &&
      hint.story_refs.includes("US-100") &&
      hint.goal_refs.includes("G-001") &&
      hint.proof_files.includes("tests/test_source.py") &&
      hint.proof_file_count === 1
    ), "changed annotated file maps to a story, project goal, and proof file");
    assert(report.hints.some((hint) => hint.type === "downstream_consumer" && hint.file === "src/source.py"), "consumer annotation produces a downstream regression hint");

    const validationReport = analyzeAnnotationHints({ cwd: tmp, files: ["tests/test_source.py"] });
    assert(validationReport.hints.some((hint) =>
      hint.type === "validation_impact" &&
      hint.proof_files.includes("tests/test_source.py")
    ), "validation file refs produce validation impact hints with proof refs");

    const plannerCoreReport = analyzeAnnotationHints({ cwd: tmp, files: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"] });
    assert(plannerCoreReport.summary.selected_files === 1, "explicit planner-core files are not dropped by broad scan filters");
    assert(plannerCoreReport.hints.some((hint) =>
      hint.type === "affected_story" &&
      hint.file === ".agent/skills/iterative-planner/scripts/verify_gate.mjs" &&
      hint.story_refs.includes("US-102") &&
      hint.proof_files.includes(".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs")
    ), "planner-core selected file maps to story and proof refs");

    const gapReport = analyzeAnnotationHints({ cwd: tmp, files: ["src/no_validation.py"] });
    assert(gapReport.hints.some((hint) => hint.type === "proof_gap" && hint.story_refs.includes("US-101")), "story with no validation refs produces a proof-gap warning");

    const configReport = analyzeAnnotationHints({ cwd: tmp, files: ["src/flags.py"] });
    assert(configReport.hints.some((hint) => hint.type === "config_risk"), "asymmetric config annotation produces config-risk warning");
    assert(configReport.hints.some((hint) => hint.type === "feature_gap" && hint.goal_refs.includes("G-002")), "goal with no story coverage produces a feature-gap hint");

    const cli = execFileSync(NODE, [join(scriptDir, "annotation_hints.mjs"), "--dir", tmp, "--files", "src/source.py", "--json"], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(cli);
    assert(parsed.summary.affected_stories >= 1, "annotation_hints CLI emits parseable JSON for explicit files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioStaleProofEscalates() {
  const tmp = makeStaleFixture();
  try {
    const report = analyzeAnnotationHints({ cwd: tmp, files: ["src/stale.py"] });
    assert(report.status === "ACTION_REQUIRED", "stale proof target produces ACTION_REQUIRED status");
    assert(report.summary.stale >= 1, "stale proof target increments stale summary count");
    assert(report.hints.some((hint) => hint.type === "quality_stale"), "stale proof target produces a quality_stale hint");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDiffAndSuggestNextIntegration() {
  const tmp = makeBaseFixture();
  try {
    runBin("git", ["init"], tmp);
    const diffReport = analyzeAnnotationHints({ cwd: tmp, useDiff: true });
    assert(diffReport.summary.selected_files >= 3, "diff mode reads changed and untracked files");
    assert(diffReport.hints.some((hint) => hint.type === "downstream_consumer"), "diff mode keeps consumer hints visible");

    const result = runNode([join(scriptDir, "rule_engine.mjs"), "suggest-next", "--json"], tmp);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "rule_engine suggest-next emits valid JSON with annotation hints");
    assert(parsed?.annotation_hints?.status === "WARN", "suggest-next embeds annotation hint summary");
    assert(parsed?.recommended?.some((entry) => entry.skill === "regression_audit" && entry.reason === "annotation_consumer_or_validation_impact"), "suggest-next recommends regression_audit for consumer or validation impact");
    assert(parsed?.recommended?.some((entry) => entry.skill === "user_story_audit" && entry.reason === "annotation_story_proof_gap"), "suggest-next recommends user_story_audit for affected story proof gaps");
    assert(parsed?.recommended?.some((entry) => entry.skill === "steward" && entry.reason === "clustered_annotation_traceability_risk"), "suggest-next recommends steward for clustered annotation traceability risk");
    assert(parsed?.recommended?.some((entry) => entry.skill === "sme_improvement" && entry.reason === "annotation_goal_coverage_gap"), "suggest-next recommends sme-improvement only from goal coverage gaps");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nAnnotation Hints Test\n");

scenarioFileImpactHints();
scenarioStaleProofEscalates();
scenarioDiffAndSuggestNextIntegration();

console.log(`\nannotation_hints tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
