#!/usr/bin/env node
// test_archetype_preflight_scenarios.mjs — Registry-driven routing coverage for representative archetype tasks.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { listArchetypePreflightScenarios } from "../scripts/lib/archetype_scenarios.mjs";
import { AUDIT_POSTURES, AUTHORITY_PHASES, RECOMMENDED_PATHS } from "../scripts/lib/planner_phase_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const preflightScript = join(skillDir, "scripts", "planner_preflight.mjs");
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

function runNode(args, cwd) {
  try {
    return {
      ok: true,
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
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-archetype-preflight-${name}-`));
}

function seedDiscoveryPolicy(projectRoot, archetype) {
  writeFileSync(join(projectRoot, "planner.discovery.json"), JSON.stringify({
    archetype,
  }, null, 2) + "\n");
}

function seedPoisonedPlan(projectRoot, scenario) {
  const planName = `plan_${scenario.id}`;
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);

  const state = createInitialStateJson(planName, scenario.goal, { projectRoot });
  state.state = scenario.active_plan?.state || "PLAN";
  state.transitions = [
    { from: "INIT", to: "EXPLORE", gate_result: "SKIP", timestamp: "2026-04-07T10:00:00Z" },
    { from: "EXPLORE", to: "PLAN", gate_result: "PASS", timestamp: "2026-04-07T10:01:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:02:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:03:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:04:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:05:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:06:00Z" },
  ];
  writeStateJson(planDir, state);

  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${scenario.goal}

## Files To Modify
${scenario.files.map((filePath) => `- ${filePath}`).join("\n")}
`);
}

console.log("\nArchetype Preflight Scenarios\n");

const scenarios = listArchetypePreflightScenarios();
const countsByArchetype = new Map();
const familiesByArchetype = new Map();

for (const scenario of scenarios) {
  countsByArchetype.set(scenario.archetype, (countsByArchetype.get(scenario.archetype) || 0) + 1);
  if (!familiesByArchetype.has(scenario.archetype)) familiesByArchetype.set(scenario.archetype, new Set());
  familiesByArchetype.get(scenario.archetype).add(scenario.family);
}

assert(scenarios.length >= 25, "archetype scenario registry provides a compact but non-trivial benchmark matrix");
assert(countsByArchetype.size >= 5, "archetype scenario registry covers at least five archetypes");
for (const [archetype, count] of countsByArchetype.entries()) {
  assert(count >= 5 && count <= 10, `${archetype} keeps 5-10 representative scenarios`);
  assert(familiesByArchetype.get(archetype)?.size >= 7, `${archetype} covers the expected task families`);
}

for (const scenario of scenarios) {
  const tmp = makeTemp(scenario.id);
  try {
    seedDiscoveryPolicy(tmp, scenario.archetype);

    const args = [preflightScript, "--json", "--dir", tmp];
    if (scenario.active_plan?.poisoned) {
      seedPoisonedPlan(tmp, scenario);
    } else {
      args.push("--goal", scenario.goal);
      for (const filePath of scenario.files || []) {
        args.push("--file", filePath);
      }
    }

    const result = runNode(args, tmp);
    assert(result.ok, `${scenario.id}: planner_preflight exits cleanly`);

    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, `${scenario.id}: planner_preflight emits valid JSON`);
    assert(parsed?.flow?.mode === scenario.expected.flow_mode, `${scenario.id}: flow mode matches ${scenario.expected.flow_mode}`);
    assert(parsed?.evidence?.mode === scenario.expected.evidence_mode, `${scenario.id}: evidence mode matches ${scenario.expected.evidence_mode}`);
    assert(parsed?.workflow?.recommended === scenario.expected.workflow, `${scenario.id}: workflow recommendation matches ${scenario.expected.workflow}`);
    assert(parsed?.recovery?.mode === scenario.expected.recovery_mode, `${scenario.id}: recovery mode matches ${scenario.expected.recovery_mode}`);
    assert(parsed?.strictness?.mode === scenario.expected.strictness_mode, `${scenario.id}: strictness mode matches ${scenario.expected.strictness_mode}`);
    assert(AUTHORITY_PHASES.includes(parsed?.authority_profile?.phase), `${scenario.id}: authority_profile phase stays within the supported enum`);
    assert(AUDIT_POSTURES.includes(parsed?.audit_posture), `${scenario.id}: audit_posture stays within the supported enum`);
    assert(RECOMMENDED_PATHS.includes(parsed?.recommended_path), `${scenario.id}: recommended_path stays within the supported enum`);

    if (scenario.active_plan?.poisoned) {
      assert(parsed?.active_plan?.poisoned === true, `${scenario.id}: poisoned active plan is surfaced`);
      assert((parsed?.recovery?.command || "").includes("recover-poison"), `${scenario.id}: poisoned recovery points to recover-poison`);
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
