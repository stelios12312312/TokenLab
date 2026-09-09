#!/usr/bin/env node
// test_boost_workflow.mjs — Comprehensive test suite for /boost workflow and slash command normalization.

import assert from "assert";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  normalizeClientGoal,
  planUsesFastTrack,
  analyzeFindingsDepth,
  resolveFindingsTruth,
} from "../scripts/lib/plan_utils.mjs";
import { computeTriage } from "../scripts/lib/triage.mjs";
import { getWorkflowContract } from "../scripts/lib/workflow_contracts.mjs";
import {
  FAST_TRACK_RELAXABLE_INVARIANTS,
  FAST_TRACK_PERMITTED_EARLY_GATES,
  runSemanticChecks,
} from "../scripts/rule_engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const scriptsDir = join(skillDir, "scripts");

const fixtureBase = join(testDir, "fixtures", "tmp_boost_test");

function runNode(script, args = [], options = {}) {
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd || repoRoot,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...(options.env || {}),
    },
    encoding: "utf-8",
  });
  let json = null;
  try {
    const raw = String(child.stdout || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      json = JSON.parse(raw.slice(start, end + 1));
    }
  } catch {}
  return {
    status: child.status,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    json,
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

async function runAllTests() {
  console.log("Running /boost Workflow Test Suite...\n");

  // -------------------------------------------------------------------------
  // 1. Workflow contract registration
  // -------------------------------------------------------------------------
  console.log("1. Workflow contract registration:");
  test("/boost has valid contract and implementation_full profile", () => {
    const contract = getWorkflowContract(repoRoot, "/boost");
    assert.strictEqual(contract.workflow_id, "/boost");
    assert.strictEqual(contract.contract_profile, "implementation_full");
    assert.ok(contract.profile);
    assert.ok(contract.profile.required_gates.includes("explore-to-plan"));
    assert.ok(contract.profile.required_gates.includes("validate-to-close"));
  });

  // -------------------------------------------------------------------------
  // 2. Goal normalization (normalizeClientGoal)
  // -------------------------------------------------------------------------
  console.log("\n2. Goal normalization (normalizeClientGoal):");
  const known = ["/boost", "/safe-change", "/safe-change-power", "/safe-plan"];

  test("pure /boost returns explicitWorkflow and cleanGoal /boost", () => {
    const res = normalizeClientGoal("/boost", known);
    assert.strictEqual(res.explicitWorkflow, "/boost");
    assert.strictEqual(res.cleanGoal, "/boost");
    assert.strictEqual(res.hasBoost, true);
  });

  test("leading /boost strips prefix and returns cleanGoal", () => {
    const res = normalizeClientGoal("/boost fix bug in solver", known);
    assert.strictEqual(res.explicitWorkflow, "/boost");
    assert.strictEqual(res.cleanGoal, "fix bug in solver");
    assert.strictEqual(res.hasBoost, true);
  });

  test("trailing /boost strips suffix and returns cleanGoal", () => {
    const res = normalizeClientGoal("fix bug in solver /boost", known);
    assert.strictEqual(res.explicitWorkflow, "/boost");
    assert.strictEqual(res.cleanGoal, "fix bug in solver");
    assert.strictEqual(res.hasBoost, true);
  });

  test("client slash command /goal /boost strips /goal and detects /boost", () => {
    const res = normalizeClientGoal("/goal /boost fix bug in solver", known);
    assert.strictEqual(res.explicitWorkflow, "/boost");
    assert.strictEqual(res.cleanGoal, "fix bug in solver");
    assert.strictEqual(res.hasBoost, true);
  });

  test("client slash command /goal alone normalizes to empty cleanGoal", () => {
    const res = normalizeClientGoal("/goal", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "");
    assert.strictEqual(res.hasBoost, false);
  });

  test("client slash command /teamwork-preview alone normalizes to empty cleanGoal", () => {
    const res = normalizeClientGoal("/teamwork-preview", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "");
    assert.strictEqual(res.hasBoost, false);
  });

  test("/goal <task> strips /goal and preserves task", () => {
    const res = normalizeClientGoal("/goal implement feature", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "implement feature");
    assert.strictEqual(res.hasBoost, false);
  });

  test("/teamwork-preview <task> strips /teamwork-preview and preserves task", () => {
    const res = normalizeClientGoal("/teamwork-preview implement feature", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "implement feature");
    assert.strictEqual(res.hasBoost, false);
  });

  test("/goal /safe-change <task> strips /goal and extracts /safe-change", () => {
    const res = normalizeClientGoal("/goal /safe-change fix bug", known);
    assert.strictEqual(res.explicitWorkflow, "/safe-change");
    assert.strictEqual(res.cleanGoal, "/safe-change fix bug");
    assert.strictEqual(res.hasBoost, false);
  });

  test("prose targeting /boost is not hijacked: fix /boost", () => {
    const res = normalizeClientGoal("fix /boost", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "fix /boost");
    assert.strictEqual(res.hasBoost, false);
  });

  test("prose with /boost in the middle is not hijacked: document how /boost works", () => {
    const res = normalizeClientGoal("document how /boost works", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "document how /boost works");
    assert.strictEqual(res.hasBoost, false);
  });

  test("prose with /boost as modifier is not hijacked: audit /boost workflow", () => {
    const res = normalizeClientGoal("audit /boost workflow", known);
    assert.strictEqual(res.explicitWorkflow, null);
    assert.strictEqual(res.cleanGoal, "audit /boost workflow");
    assert.strictEqual(res.hasBoost, false);
  });

  // -------------------------------------------------------------------------
  // 3. Triage handling of /boost and stripped commands
  // -------------------------------------------------------------------------
  console.log("\n3. Triage handling of /boost and stripped commands:");

  test("computeTriage on pure /boost returns standard_planner with planner operator_action", () => {
    const triage = computeTriage({ goalText: "/boost" });
    assert.strictEqual(triage.recommended_path, "standard_planner");
    assert.strictEqual(triage.operator_action, "planner");
  });

  test("computeTriage on /boost <task> does not downgrade below standard_planner", () => {
    const triage = computeTriage({ goalText: "/boost fix typo" });
    assert.ok(triage.recommended_path === "standard_planner" || triage.recommended_path === "full_planner");
    assert.strictEqual(triage.operator_action, "planner");
  });

  test("computeTriage strips /goal and /teamwork-preview prefixes", () => {
    const triage = computeTriage({ goalText: "/goal fix bug in solver" });
    assert.strictEqual(triage.word_count, 4);
    assert.strictEqual(triage.shape.primary, "bug-fix");
  });

  // -------------------------------------------------------------------------
  // 4. task_intake.mjs front-door routing
  // -------------------------------------------------------------------------
  console.log("\n4. task_intake.mjs front-door routing:");

  test("task_intake with /boost routes to explicit_workflow without route conflict", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "/boost", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.strictEqual(res.json.task_intake.route, "explicit_workflow");
    assert.strictEqual(res.json.task_intake.explicit_workflow, "/boost");
    assert.strictEqual(res.json.task_intake.decision_request, null);
    assert.strictEqual(res.json.task_intake.recommended_action?.workflow, "/boost");
    assert.strictEqual(res.json.guidance_packet?.workflow_requirements?.contract_profile, "implementation_full");
  });

  test("task_intake with /boost <task> retains cleanGoal and /boost workflow", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "/boost fix the SLD cycle bug", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.strictEqual(res.json.task_intake.route, "explicit_workflow");
    assert.strictEqual(res.json.task_intake.explicit_workflow, "/boost");
    assert.strictEqual(res.json.task_intake.goal, "fix the SLD cycle bug");
  });

  test("task_intake with /goal /boost <task> routes to explicit_workflow /boost", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "/goal /boost fix the SLD cycle bug", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.strictEqual(res.json.task_intake.route, "explicit_workflow");
    assert.strictEqual(res.json.task_intake.explicit_workflow, "/boost");
  });

  test("task_intake with /teamwork-preview does not deadlock in authoritative_route_conflict", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "/teamwork-preview", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.notStrictEqual(res.json.task_intake.decision_request?.reason_code, "authoritative_route_conflict");
  });

  test("task_intake with prose 'fix /boost' does not hijack into explicit_workflow /boost", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "fix /boost", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.notStrictEqual(res.json.task_intake.route, "explicit_workflow");
    assert.strictEqual(res.json.task_intake.explicit_workflow, null);
    assert.strictEqual(res.json.task_intake.goal, "fix /boost");
  });

  test("task_intake with prose 'document how /boost works' does not hijack into explicit_workflow /boost", () => {
    const res = runNode(join(scriptsDir, "task_intake.mjs"), ["--goal", "document how /boost works", "--json", "--no-plan-context"]);
    assert.strictEqual(res.status, 0);
    assert.ok(res.json);
    assert.notStrictEqual(res.json.task_intake.route, "explicit_workflow");
    assert.strictEqual(res.json.task_intake.explicit_workflow, null);
    assert.strictEqual(res.json.task_intake.goal, "document how /boost works");
  });

  // -------------------------------------------------------------------------
  // 5. planUsesFastTrack resolution
  // -------------------------------------------------------------------------
  console.log("\n5. planUsesFastTrack resolution:");

  mkdirSync(fixtureBase, { recursive: true });
  try {
    const planA = join(fixtureBase, "plan_fast_track_env");
    mkdirSync(planA, { recursive: true });
    test("planUsesFastTrack returns true when env var is set", () => {
      assert.strictEqual(planUsesFastTrack(planA, { _PLANNER_FAST_TRACK: "1" }), true);
      assert.strictEqual(planUsesFastTrack(planA, { _PLANNER_FAST_TRACK: "0" }), false);
    });

    const planB = join(fixtureBase, "plan_workflow_boost");
    mkdirSync(planB, { recursive: true });
    writeFileSync(join(planB, "state.json"), JSON.stringify({ workflow_id: "/boost" }));
    test("planUsesFastTrack returns true when state.json workflow_id is /boost", () => {
      assert.strictEqual(planUsesFastTrack(planB, {}), true);
    });

    const planC = join(fixtureBase, "plan_ledger_fast_track");
    mkdirSync(planC, { recursive: true });
    writeFileSync(join(planC, "findings_ledger.json"), JSON.stringify({ fast_track: true }));
    test("planUsesFastTrack returns true when findings_ledger.json fast_track is true", () => {
      assert.strictEqual(planUsesFastTrack(planC, {}), true);
    });

    const planD = join(fixtureBase, "plan_findings_md_fast_track");
    mkdirSync(planD, { recursive: true });
    writeFileSync(join(planD, "findings.md"), "# Findings\n[FAST_TRACK]\n## F-001\nShort analysis.");
    test("planUsesFastTrack returns true when findings.md contains [FAST_TRACK]", () => {
      assert.strictEqual(planUsesFastTrack(planD, {}), true);
    });

    const planE = join(fixtureBase, "plan_normal");
    mkdirSync(planE, { recursive: true });
    writeFileSync(join(planE, "state.json"), JSON.stringify({ workflow_id: "/safe-change" }));
    writeFileSync(join(planE, "findings_ledger.json"), JSON.stringify({ fast_track: false }));
    writeFileSync(join(planE, "findings.md"), "# Findings\n## F-001\nAnalysis.");
    test("planUsesFastTrack returns false for standard plan", () => {
      assert.strictEqual(planUsesFastTrack(planE, {}), false);
    });
  } finally {
    rmSync(fixtureBase, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 6. Depth relaxation and semantic invariant parity
  // -------------------------------------------------------------------------
  console.log("\n6. Depth relaxation and semantic invariant parity:");

  test("analyzeFindingsDepth relaxes minWordsPerFinding from 50 to 20 under fastTrack", () => {
    const content = "# Findings\n## F-001: Issue\nOne two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.";
    const normalResult = analyzeFindingsDepth(content, { fastTrack: false });
    const fastTrackResult = analyzeFindingsDepth(content, { fastTrack: true });
    assert.strictEqual(normalResult.minWordsPerFinding, 50);
    assert.strictEqual(fastTrackResult.minWordsPerFinding, 20);
    assert.strictEqual(fastTrackResult.fastTrack, true);
  });

  test("resolveFindingsTruth detects isBoost from state.json workflow_id: /boost", () => {
    const tmpPlan = join(testDir, "fixtures", "tmp_resolve_truth");
    mkdirSync(tmpPlan, { recursive: true });
    try {
      writeFileSync(join(tmpPlan, "state.json"), JSON.stringify({ workflow_id: "/boost" }));
      writeFileSync(join(tmpPlan, "findings.md"), "# Findings\n## F-001: Issue\nDetail text here.");
      const truth = resolveFindingsTruth(tmpPlan);
      assert.strictEqual(truth.markdown?.depth.fastTrack, true);
    } finally {
      rmSync(tmpPlan, { recursive: true, force: true });
    }
  });

  test("resolveFindingsTruth detects fastTrack from findings_ledger.json fast_track: true even with null workflow_id", () => {
    const tmpPlan = join(testDir, "fixtures", "tmp_resolve_truth_ledger");
    mkdirSync(tmpPlan, { recursive: true });
    try {
      writeFileSync(join(tmpPlan, "state.json"), JSON.stringify({ workflow_id: null }));
      writeFileSync(join(tmpPlan, "findings_ledger.json"), JSON.stringify({
        version: 1,
        fast_track: true,
        findings: [
          { id: "F-001", title: "F-001: Issue", summary: "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty." }
        ]
      }));
      writeFileSync(join(tmpPlan, "findings.md"), "# Findings\n## F-001: Issue\nOne two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.");
      const truth = resolveFindingsTruth(tmpPlan);
      assert.strictEqual(truth.effective?.depth.fastTrack, true);
      assert.strictEqual(truth.effective?.depth.minWordsPerFinding, 20);
    } finally {
      rmSync(tmpPlan, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. bootstrap.mjs new plan creation with /boost
  // -------------------------------------------------------------------------
  console.log("\n7. bootstrap.mjs new plan creation with /boost:");

  test("bootstrap new --workflow /boost initializes fast_track in ledger and state.json", () => {
    const tmpRepo = join(testDir, "fixtures", "tmp_bootstrap_test_1");
    mkdirSync(tmpRepo, { recursive: true });
    try {
      const res = runNode(join(scriptsDir, "bootstrap.mjs"), ["new", "--workflow", "/boost", "Fix issue"], { cwd: tmpRepo });
      assert.strictEqual(res.status, 0);
      const plans = existsSync(join(tmpRepo, "plans")) ? readdirSync(join(tmpRepo, "plans")).filter(f => f.startsWith("plan_")) : [];
      assert.ok(plans.length > 0);
      const planDir = join(tmpRepo, "plans", plans[0]);
      const ledger = JSON.parse(readFileSync(join(planDir, "findings_ledger.json"), "utf-8"));
      const findings = readFileSync(join(planDir, "findings.md"), "utf-8");
      const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
      assert.strictEqual(ledger.fast_track, true);
      assert.ok(findings.startsWith("[FAST_TRACK]"));
      assert.strictEqual(state.workflow_id, "/boost");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test("bootstrap new --boost flag initializes fast_track and workflow_id /boost", () => {
    const tmpRepo = join(testDir, "fixtures", "tmp_bootstrap_test_2");
    mkdirSync(tmpRepo, { recursive: true });
    try {
      const res = runNode(join(scriptsDir, "bootstrap.mjs"), ["new", "--boost", "Fix issue"], { cwd: tmpRepo });
      assert.strictEqual(res.status, 0);
      const plans = existsSync(join(tmpRepo, "plans")) ? readdirSync(join(tmpRepo, "plans")).filter(f => f.startsWith("plan_")) : [];
      assert.ok(plans.length > 0);
      const planDir = join(tmpRepo, "plans", plans[0]);
      const ledger = JSON.parse(readFileSync(join(planDir, "findings_ledger.json"), "utf-8"));
      const findings = readFileSync(join(planDir, "findings.md"), "utf-8");
      const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
      assert.strictEqual(ledger.fast_track, true);
      assert.ok(findings.startsWith("[FAST_TRACK]"));
      assert.strictEqual(state.workflow_id, "/boost");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 8. rule_engine.mjs semantic checks with /boost plan
  // -------------------------------------------------------------------------
  console.log("\n8. rule_engine.mjs semantic checks with /boost plan:");

  test("FAST_TRACK_RELAXABLE_INVARIANTS excludes security-critical auth_story_untested", () => {
    assert.strictEqual(FAST_TRACK_RELAXABLE_INVARIANTS.has("auth_story_untested"), false);
    assert.ok(FAST_TRACK_RELAXABLE_INVARIANTS.has("high_priority_untested"));
    assert.ok(FAST_TRACK_RELAXABLE_INVARIANTS.has("code_without_tests"));
    assert.ok(FAST_TRACK_RELAXABLE_INVARIANTS.has("depends_on_unimplemented"));
    assert.ok(FAST_TRACK_RELAXABLE_INVARIANTS.has("depends_on_retired"));
  });

  test("FAST_TRACK_PERMITTED_EARLY_GATES only allows early gates (explore-to-plan, plan-to-execute)", () => {
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("explore-to-plan"), true);
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("plan-to-execute"), true);
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("execute-to-reflect"), false);
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("reflect-to-validate"), false);
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("validate-to-close"), false);
    assert.strictEqual(FAST_TRACK_PERMITTED_EARLY_GATES.has("notify-user"), false);
  });

  test("runSemanticChecks at explore-to-plan downgrades relaxable invariants to WARN but hard-fails auth_story_untested", () => {
    const tmpPlan = join(testDir, "fixtures", "tmp_rule_engine_test");
    mkdirSync(tmpPlan, { recursive: true });
    try {
      writeFileSync(join(tmpPlan, "state.json"), JSON.stringify({
        state: "EXPLORE",
        workflow_id: "/boost",
        iteration: 0,
      }));
      writeFileSync(join(tmpPlan, "findings_ledger.json"), JSON.stringify({ fast_track: true, findings: [] }));
      writeFileSync(join(tmpPlan, "findings.md"), "[FAST_TRACK]\n# Findings\n");

      assert.strictEqual(planUsesFastTrack(tmpPlan), true);

      // 1. Relaxable invariant at explore-to-plan -> downgraded to WARN
      const resRelaxable = runSemanticChecks("explore-to-plan", tmpPlan, {
        refreshOntology: false,
        transientOntologyFacts: "invariant_violated(code_without_tests, 'f1.js has no test').",
      });
      const warnResult = resRelaxable.find((r) => r.name === "Fast-track story invariant advisories");
      const failResult = resRelaxable.find((r) => r.name === "Story invariants");
      assert.ok(warnResult, "Expected fast-track WARN advisory result");
      assert.strictEqual(warnResult.status, "WARN");
      assert.strictEqual(failResult, undefined, "Expected no FAIL on relaxable invariant");

      // 2. Security invariant (auth_story_untested) at explore-to-plan -> hard FAIL
      const resAuth = runSemanticChecks("explore-to-plan", tmpPlan, {
        refreshOntology: false,
        transientOntologyFacts: "invariant_violated(auth_story_untested, 'US-001 has no test').",
      });
      const authFail = resAuth.find((r) => r.name === "Story invariants");
      assert.ok(authFail, "Expected FAIL on auth_story_untested");
      assert.strictEqual(authFail.status, "FAIL");
    } finally {
      rmSync(tmpPlan, { recursive: true, force: true });
    }
  });

  test("runSemanticChecks at validate-to-close hard-fails on all invariants even under /boost", () => {
    const tmpPlan = join(testDir, "fixtures", "tmp_rule_engine_close_test");
    mkdirSync(tmpPlan, { recursive: true });
    try {
      writeFileSync(join(tmpPlan, "state.json"), JSON.stringify({
        state: "VALIDATE",
        workflow_id: "/boost",
        iteration: 0,
      }));
      writeFileSync(join(tmpPlan, "findings_ledger.json"), JSON.stringify({ fast_track: true, findings: [] }));
      writeFileSync(join(tmpPlan, "findings.md"), "[FAST_TRACK]\n# Findings\n");

      assert.strictEqual(planUsesFastTrack(tmpPlan), true);

      // At validate-to-close, even a relaxable invariant MUST cause hard FAIL
      const resRelaxableAtClose = runSemanticChecks("validate-to-close", tmpPlan, {
        refreshOntology: false,
        transientOntologyFacts: "invariant_violated(code_without_tests, 'f1.js has no test').",
      });
      const failResult = resRelaxableAtClose.find((r) => r.name === "Story invariants");
      const fastTrackWarn = resRelaxableAtClose.find((r) => r.name === "Fast-track story invariant advisories");
      assert.ok(failResult, "Expected hard FAIL at validate-to-close");
      assert.strictEqual(failResult.status, "FAIL");
      assert.strictEqual(fastTrackWarn, undefined, "Expected no fast-track WARN downgrade at validate-to-close");

      // auth_story_untested also hard-fails at validate-to-close
      const resAuthAtClose = runSemanticChecks("validate-to-close", tmpPlan, {
        refreshOntology: false,
        transientOntologyFacts: "invariant_violated(auth_story_untested, 'US-001 has no test').",
      });
      const authFail = resAuthAtClose.find((r) => r.name === "Story invariants");
      assert.ok(authFail, "Expected hard FAIL on auth_story_untested at validate-to-close");
      assert.strictEqual(authFail.status, "FAIL");
    } finally {
      rmSync(tmpPlan, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
