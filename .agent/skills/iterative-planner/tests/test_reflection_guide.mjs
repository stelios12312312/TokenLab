#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import {
  buildReflectionGuide,
  writeReflectionGuide,
} from "../scripts/lib/reflection_guide.mjs";
import { TEST_RUN_VERSION } from "../scripts/lib/evidence_verifier.mjs";

const scriptDir = dirname(fileURLToPath(new URL("../scripts/planner.mjs", import.meta.url)));
const migrateCliPath = join(scriptDir, "migrate.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function runNode(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || error?.message || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-reflection-guide-${name}-`));
}

function installPlannerFixture(cwd) {
  const result = runNode([migrateCliPath, "upgrade", cwd], cwd);
  assert(result.ok, "migrate upgrade installs planner into the reflection-guide fixture");
}

function seedOntologyFacts(cwd) {
  const factsDir = join(cwd, ".agent", "ontology", "facts");
  mkdirSync(factsDir, { recursive: true });

  writeFileSync(join(factsDir, "code.yaml"), JSON.stringify({
    code: {
      version: 1,
      modules: [],
      files: [],
      classes: [],
      functions: [],
      file_dependencies: [],
    },
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(factsDir, "specification.yaml"), JSON.stringify({
    specification: {
      version: 1,
      domains: [
        {
          name: "planner_core",
          description: "Planner runtime and workflow orchestration.",
        },
      ],
      stories: [
        {
          id: "US-091",
          title: "Reflection guidance stays deterministic for planner-core changes",
          status: "active",
          domain: "planner_core",
          acceptance_criteria: [
            {
              id: "AC-091-001",
              text: "Reflection guide emits sections derived from ontology and plan state.",
            },
          ],
        },
      ],
      plans: [],
    },
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(factsDir, "verification.yaml"), JSON.stringify({
    verification: {
      version: 1,
      criteria: [],
      tests: [],
      artifacts: [],
      test_runs: [],
      coverage_reports: [],
    },
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(factsDir, "process.yaml"), JSON.stringify({
    process: {
      version: 1,
      mistakes: [
        {
          id: "M-001",
          title: "Incomplete ripple-through on behavioural changes (fixture)",
          domain: "knowledge_base",
          frequency: 0,
        },
      ],
      patterns: [
        {
          id: "P-071",
          title: "Use a deterministic planner-core debug packet before touching prose or parsers",
          applies_to: ["parser_reader", "workflow", "ontology"],
        },
      ],
      gotchas: [],
      retros: [
        {
          id: "R-2026-04-12-001",
          title: "Planner-core debugging drifted into markdown ritual instead of deterministic diagnosis",
          mistake_ids: ["M-001"],
          domain_tags: ["planner_core", "verification"],
          change_classes: ["parser_reader", "verification", "workflow"],
          recurrence_count: 2,
        },
      ],
      adrs: [],
      workflows: [],
      mirror_readers: [],
      edge_cases: [
        {
          domain: "planner_core",
          label: "planner_core_cli_changes_keep_ripple_through_coverage_aligned",
          description: "Planner-core CLI changes keep ripple-through coverage aligned",
        },
      ],
      invariants: [],
    },
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(factsDir, "proof_weights.yaml"), JSON.stringify({
    proof_weights: {
      version: 1,
      proof_types: {
        integration_test: {
          label: "Integration test",
          category: "test",
          base_weight: 4,
          description: "An integration seam is exercised across collaborating components.",
        },
        test_output: {
          label: "Structured test output",
          category: "artifact",
          base_weight: 1,
          description: "A structured test artifact records the execution result.",
        },
      },
      risk_levels: {
        high: {
          required_weight: 2,
          description: "Fixture high-risk work requires at least one integration proof artifact.",
        },
        medium: {
          required_weight: 2,
          description: "Fixture medium-risk work still requires concrete proof.",
        },
        low: {
          required_weight: 1,
          description: "Fixture low-risk work requires a minimal artifact.",
        },
      },
      domain_defaults: {
        planner_core: "high",
        verification: "medium",
        knowledge_base: "low",
      },
    },
  }, null, 2) + "\n", "utf8");
}

function seedReflectionGuideFixture(cwd, { planName = "plan_reflection_guide_fixture" } = {}) {
  const planDir = join(cwd, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  seedOntologyFacts(cwd);

  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "REFLECT",
    goal: "Phase 2.9 reflection guide fixture for planner-core parser reader workflow verification",
    change_manifest: [
      { path: ".agent/skills/iterative-planner/scripts/planner.mjs" },
      { path: ".agent/skills/iterative-planner/scripts/verify_gate.mjs" },
      { path: "README.md" },
    ],
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(planDir, "plan.md"), `# Plan v0

## Goal
Phase 2.9 reflection guide fixture for planner-core parser reader workflow verification

## Files To Modify
- .agent/skills/iterative-planner/scripts/planner.mjs
- .agent/skills/iterative-planner/scripts/verify_gate.mjs

## Success Criteria
- [SC-001] Reflection guide emits the deterministic sections needed by REFLECT
- [SC-002] Planner-core work keeps ripple-through coverage visible

## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: update_relationships
- Story action: add_new
- Validation bundle: integration
- Strictness mode: full
- Close blocker if skipped: Reflection truth would drift from the runtime gate contract.

## Active Mistake Response

| Mistake | Guard | Planned handling | Planned evidence |
| --- | --- | --- | --- |
| M-001 | ripple-through | Update code, docs, tests, and workflow surfaces together | planner smoke + guide tests |
`, "utf8");

  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Updated \`.agent/skills/iterative-planner/scripts/planner.mjs\`
- [x] Updated \`.agent/skills/iterative-planner/scripts/verify_gate.mjs\`
- [x] Touched \`README.md\` while documenting the guide front door
`, "utf8");

  writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({
    verification_strategy: {
      version: 1,
      plan_id: planName,
      created_at: "2026-04-26T12:00:00.000Z",
      updated_at: "2026-04-26T12:00:00.000Z",
      repo_system_context: "Planner-core reflection contract change",
      verification_obligation_synthesis: {
        summary: "Planner-core behavioral change needs runtime + contract proof",
        scope: "planner.mjs, verify_gate.mjs, docs, and workflow front doors",
        non_goals: [],
        dependencies: ["planner core runtime", "reflection contract"],
      },
      criteria: [
        {
          id: "CRIT-REF-001",
          criterion: "Reflection guide writes deterministic plan-local output",
          story_id: "US-091",
          repo_system_context: "Planner-core workflow contract",
          domain: "planner_core",
          risk_level: "high",
          required_proof_type: "integration smoke",
          required_proof_weight: 2,
          implementation: {
            file: ".agent/skills/iterative-planner/scripts/reflection_guide.mjs",
            lines: "1-200",
          },
          tests: [
            {
              name: "test_reflection_guide_generates_sections",
              file: ".agent/skills/iterative-planner/tests/test_reflection_guide.mjs",
              type: "integration",
            },
          ],
          evidence_artifacts: [
            {
              type: "test_output",
              path: `reports/test_runs/${planName}_latest.yaml`,
              assert_all_passed: true,
              proof_type: "integration_test",
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n", "utf8");

  mkdirSync(join(planDir, "telemetry"), { recursive: true });
  writeFileSync(join(planDir, "telemetry", "summary.json"), JSON.stringify({
    mode: "planner_core",
    total_tool_calls: 14,
    execute_tool_calls: 9,
  }, null, 2) + "\n", "utf8");

  writeFileSync(join(planDir, "metrics.json"), JSON.stringify({
    tool_calls: 14,
    execute_iterations: 2,
  }, null, 2) + "\n", "utf8");

  mkdirSync(join(cwd, "reports", "test_runs"), { recursive: true });
  writeFileSync(join(cwd, "reports", "test_runs", `${planName}_2026-04-26T12-00-00.yaml`), JSON.stringify({
    test_run: {
      version: TEST_RUN_VERSION,
      plan_id: planName,
      generated_at: "2026-04-26T12:00:00.000Z",
      framework: "node",
      command: "node .agent/skills/iterative-planner/tests/test_reflection_guide.mjs",
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
      },
      tests: [
        {
          name: "test_reflection_guide_generates_sections",
          file: ".agent/skills/iterative-planner/tests/test_reflection_guide.mjs",
          outcome: "pass",
          assertion_count: 8,
          output_summary: "guide generation fixture passed",
        },
      ],
    },
  }, null, 2) + "\n", "utf8");

  return planDir;
}

function scenarioBuildReflectionGuide() {
  const tmp = makeTemp("build");
  try {
    installPlannerFixture(tmp);
    const planDir = seedReflectionGuideFixture(tmp);
    const result = buildReflectionGuide({ cwd: tmp, planDir, now: "2026-04-26T12:05:00.000Z" });

    assert(result.ok, "buildReflectionGuide succeeds for a planner-core fixture");
    assert(result.required_question_count >= 4, "buildReflectionGuide emits several required questions");

    const sections = result.document?.reflection_guide?.sections || {};
    assert(!!sections.plan_vs_progress, "guide includes the plan_vs_progress section");
    assert(!!sections.applicable_kb, "guide includes the applicable_kb section");
    assert(!!sections.relevant_retros, "guide includes the relevant_retros section");
    assert(!!sections.edge_case_coverage, "guide includes the edge_case_coverage section");
    assert(!!sections.process_signals, "guide includes the process_signals section");
    assert(!!sections.proof_weight_audit, "guide includes the proof_weight_audit section");
    assert(!!sections.next_time_candidates, "guide includes the next_time_candidates section");
    assert(!!sections.convention_application_check, "guide includes the convention_application_check section");
    assert((sections.plan_vs_progress.unplanned_work || []).includes("README.md"), "guide surfaces unplanned work from observed/progress files");
    assert((sections.applicable_kb.mistakes || []).some((entry) => entry.id === "M-001"), "guide surfaces active mistake M-001 for planner-core ripple-through work");
    assert((sections.relevant_retros.retros || []).length > 0, "guide surfaces at least one relevant retro");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioWriteReflectionGuide() {
  const tmp = makeTemp("write");
  try {
    installPlannerFixture(tmp);
    const planDir = seedReflectionGuideFixture(tmp, { planName: "plan_reflection_guide_write" });
    const result = writeReflectionGuide({ cwd: tmp, planDir, now: "2026-04-26T12:10:00.000Z" });
    assert(result.ok, "writeReflectionGuide succeeds");
    assert(result.wrote === true, "writeReflectionGuide records a write");
    const artifactPath = join(planDir, "reflection_guide.yaml");
    const content = readFileSync(artifactPath, "utf8");
    const parsed = JSON.parse(content);
    assert(parsed?.reflection_guide?.plan_id === "plan_reflection_guide_write", "written guide preserves the canonical plan id");
    assert(parsed?.reflection_guide?.required_question_count === result.required_question_count, "written guide preserves the required-question count");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nReflection Guide\n");

scenarioBuildReflectionGuide();
scenarioWriteReflectionGuide();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
