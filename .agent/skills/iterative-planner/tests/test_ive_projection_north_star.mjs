#!/usr/bin/env node
// test_ive_projection_north_star.mjs — IVE phase 1/2 projection and North Star proof.

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { buildNorthStarFacts, normalizePlannerManifesto } from "../scripts/lib/planner_manifesto.mjs";
import { projectPlanDir, projectLegacyState, verifyProjectionParity } from "../scripts/lib/ive_projection.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const projectIveCli = join(skillDir, "scripts", "project_ive.mjs");
const NODE = process.execPath;

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

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function createPlan(tmp, name, state, transitions = []) {
  const planDir = join(tmp, "plans", name);
  writeJson(join(planDir, "state.json"), { state, transitions });
  return planDir;
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

console.log("\nIVE Projection and North Star Tests\n");

function testProjectionIsReadOnlyAndParityPreserving() {
  const tmp = mkdtempSync(join(tmpdir(), "ive-projection-"));
  try {
    const planDirs = [
      createPlan(tmp, "plan_2026-05-01_ideation", "EXPLORE", [
        { gate: "explore-to-plan", from: "EXPLORE", to: "PLAN", gate_result: "PASS", failure_codes: [] },
      ]),
      createPlan(tmp, "plan_2026-05-02_execution", "EXECUTE", [
        { gate: "plan-to-execute", from: "PLAN", to: "EXECUTE", gate_result: "PASS", failure_codes: [] },
      ]),
      createPlan(tmp, "plan_2026-05-03_validation", "VALIDATE", [
        { gate: "execute-to-reflect", from: "EXECUTE", to: "REFLECT", gate_result: "WARN", failure_codes: ["advisory"] },
        { gate: "reflect-to-validate", from: "REFLECT", to: "VALIDATE", gate_result: "PASS", failure_codes: [] },
      ]),
    ];

    const before = readFileSync(join(planDirs[2], "state.json"), "utf-8");
    const projection = projectPlanDir(planDirs[2]);
    assert(projection.ok, "projectPlanDir reports a valid projection");
    assert(projection.projection.ive_macro_phase === "validation", "VALIDATE maps to validation macro-phase");
    assert(projection.projection.gate_verdicts[0].gate_result === "WARN", "gate verdict result is preserved");
    assert(readFileSync(join(planDirs[2], "state.json"), "utf-8") === before, "projection leaves state.json bytes unchanged");

    const parity = verifyProjectionParity(planDirs);
    assert(parity.ok && parity.gate_verdicts_byte_identical && parity.plans_replayed === 3, "replay parity reports byte-identical gate verdicts");

    const cli = JSON.parse(execFileSync(NODE, [projectIveCli, planDirs[0], "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }));
    assert(cli.status === "PASS" && cli.projections[0].projection.ive_macro_phase === "ideation", "project_ive.mjs emits JSON projection");
  } finally {
    cleanup(tmp);
  }
}

function testManifestoV1AndV2Facts() {
  const v1 = normalizePlannerManifesto({
    version: 1,
    north_star: "legacy traceability",
  });
  const v1Facts = buildNorthStarFacts(v1);
  assert(v1.valid && v1.version === 1, "v1 manifesto remains valid");
  assert(v1Facts.facts.includes("planner_manifesto_version(1)."), "v1 facts include manifest version");
  assert(v1Facts.facts.some((fact) => fact.includes("planner_north_star")), "v1 facts include planner_north_star");

  const v2 = normalizePlannerManifesto({
    schema_version: 2,
    north_star: "Find durable alpha without temporal leakage",
    north_star_type: "quant_alpha",
    hard_policy_mode: "minimal_semantic_core",
    core_metrics: [
      { id: "information_coefficient", threshold: "> 0.05", scope: "final_out_of_sample" },
      { id: "time_to_interactive_p75", threshold: "<= 2500ms", scope: "synthetic_lab" },
    ],
    invariant_directives: [
      { id: "NO_TEMPORAL_LEAKAGE", severity: "fail", description: "No leakage" },
      { id: "RENDERED_JOURNEY_PROOF", severity: "warn", description: "Rendered proof" },
    ],
  });
  const v2Facts = buildNorthStarFacts(v2);
  assert(v2.valid && v2.version === 2 && v2.north_star_type === "quant_alpha", "v2 manifesto normalizes schema_version 2");
  assert(v2Facts.facts.includes("north_star_type('quant_alpha')."), "v2 facts include north_star_type");
  assert(v2Facts.facts.includes("north_star_policy_mode('minimal_semantic_core')."), "v2 facts include hard_policy_mode");
  assert(v2Facts.facts.includes("north_star_metric('information_coefficient', 'final_out_of_sample', 'threshold_gt_0_05')."), "v2 facts include quant metric threshold");
  assert(v2Facts.facts.includes("north_star_directive('no_temporal_leakage', 'fail')."), "v2 facts include quant directive");
  assert(v2Facts.facts.includes("north_star_directive('rendered_journey_proof', 'warn')."), "v2 facts include UX directive");
}

function testReservedPredicateRejection() {
  const unsafe = normalizePlannerManifesto({
    version: 2,
    north_star: "Unsafe override attempt",
    north_star_type: "traceability_only",
    hard_policy_mode: "strict_full",
    core_metrics: [
      { id: "can_transition", threshold: "required", scope: "project" },
    ],
    invariant_directives: [
      { id: "invariant_violated", severity: "fail", description: "Override core invariant" },
      { id: "SAFE_DIRECTIVE :- can_transition(explore,close)", severity: "fail", description: "Clause injection" },
    ],
  });
  const facts = buildNorthStarFacts(unsafe);
  assert(!unsafe.valid && unsafe.parse_issues.length >= 2, "reserved predicate and clause injection ids are rejected");
  assert(!facts.facts.some((fact) => fact.includes("can_transition")), "unsafe metric id is not emitted as a fact");
  assert(!facts.facts.some((fact) => fact.includes("invariant_violated")), "unsafe directive id is not emitted as a fact");
}

function testStateMappingCoverage() {
  const expected = {
    EXPLORE: "ideation",
    PLAN: "ideation",
    EXECUTE: "execution",
    REFLECT: "validation",
    VALIDATE: "validation",
    CLOSE: "validation",
  };
  for (const [legacy, macro] of Object.entries(expected)) {
    assert(projectLegacyState({ state: legacy }).ive_macro_phase === macro, `${legacy} maps to ${macro}`);
  }
}

testProjectionIsReadOnlyAndParityPreserving();
testManifestoV1AndV2Facts();
testReservedPredicateRejection();
testStateMappingCoverage();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
