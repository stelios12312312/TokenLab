#!/usr/bin/env node
// test_archetype_gate_canonicalization.mjs — Deterministic alias and proof-label coverage for plan gates.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { listGateCanonicalizationScenarios } from "../scripts/lib/archetype_scenarios.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const verifyGateScript = join(skillDir, "scripts", "verify_gate.mjs");
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
  return mkdtempSync(join(tmpdir(), `planner-gate-canonical-${name}-`));
}

function withSemanticUpkeepContract(planContent) {
  if (String(planContent || "").includes("## Semantic Upkeep Contract")) {
    return planContent;
  }
  return `${String(planContent || "").trim()}

## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: update_relationships
- Story action: revise_existing
- Validation bundle: behavioral
- Strictness mode: full
- Close blocker if skipped: Gate semantics would drift from the documented planner contract.
`;
}

function seedPlanFixture(projectRoot, scenario) {
  const planName = `plan_${scenario.id}`;
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);

  const approvalNonce = "abcdef0123456789";
  const state = createInitialStateJson(planName, scenario.goal, { projectRoot });
  state.state = "PLAN";
  state.approval_nonce_hash = createHash("sha256").update(approvalNonce).digest("hex").slice(0, 32);
  state.nonce_generated_at = new Date().toISOString();
  writeStateJson(planDir, state);
  writeFileSync(join(planDir, "plan.md"), withSemanticUpkeepContract(scenario.plan_content));
  writeFileSync(join(planDir, "decisions.md"), `# Decision Log

## D-001
[APPROVED:${approvalNonce}]

Accepted the deterministic gate fixture.
`);

  if (Array.isArray(scenario.story_registry_ids) && scenario.story_registry_ids.length > 0) {
    mkdirSync(join(projectRoot, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(projectRoot, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: scenario.story_registry_ids.map((id) => ({
        id,
        title: `${id} story`,
        priority: "HIGH",
        status: "FULLY_COVERED",
        validation_refs: ["tests/validation_traceability.mjs"],
      })),
    }, null, 2) + "\n");
  }
}

console.log("\nArchetype Gate Canonicalization\n");

const scenarios = listGateCanonicalizationScenarios();
assert(scenarios.length >= 4, "gate canonicalization registry provides representative deterministic fixtures");

for (const scenario of scenarios) {
  const tmp = makeTemp(scenario.id);
  try {
    seedPlanFixture(tmp, scenario);
    const result = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(result.ok === (scenario.expected_exit === 0), `${scenario.id}: verify_gate exit status matches expectation`);
    assert((result.stdout || "").includes(scenario.expect_fragment), `${scenario.id}: output includes the expected diagnostic fragment`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
