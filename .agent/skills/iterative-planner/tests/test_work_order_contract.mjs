#!/usr/bin/env node
// test_work_order_contract.mjs - Work-order schema and validator coverage.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildPlanWorkOrderProjection,
  buildRecipeWorkOrder,
  getIntentContractProjection,
  getWorkOrderSuccessCriteria,
  getWorkOrderVerificationRows,
  validateWorkOrder,
} from "../scripts/lib/work_order_contract.mjs";
import { loadRecipeDefinition } from "../scripts/lib/recipe_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..");
const fixtureRoot = join(testDir, "fixtures", "work_orders");
const schemaPath = join(testDir, "..", "config", "work_order.schema.json");
const validatorCli = join(testDir, "..", "scripts", "work_order_validate.mjs");
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function fixturePath(name) {
  return join(fixtureRoot, name);
}

function loadFixture(name) {
  return readJson(fixturePath(name));
}

function errorCodes(result) {
  return new Set((result.errors || []).map((issue) => issue.code));
}

function allErrorsAreActionable(result) {
  return (result.errors || []).every((issue) =>
    typeof issue.code === "string" && issue.code.length > 0 &&
    typeof issue.path === "string" && issue.path.length > 0 &&
    typeof issue.message === "string" && issue.message.length > 0
  );
}

function runCli(path) {
  try {
    const stdout = execFileSync(NODE, [validatorCli, path, "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exit_code: 0, stdout, parsed: JSON.parse(stdout) };
  } catch (err) {
    const stdout = err.stdout?.toString() || "";
    return {
      exit_code: err.status ?? 1,
      stdout,
      parsed: stdout ? JSON.parse(stdout) : null,
    };
  }
}

console.log("\nWork-Order Contract Tests\n");

{
  const schema = readJson(schemaPath);
  assert(schema.title === "Iterative Planner Work Order", "schema has work-order title");
  assert(schema.required.includes("claims_to_produce"), "schema requires claims_to_produce");
  assert(schema.required.includes("proof_obligations"), "schema requires proof_obligations");
  assert(schema.required.includes("stop_conditions"), "schema requires stop_conditions");
  assert(schema.required.includes("budget"), "schema requires budget");
  assert(schema.properties?.profile?.properties?.type?.enum?.includes("recipe"), "schema documents recipe work-order profile");
  assert(
    schema.properties?.proof_obligations?.items?.properties?.method?.enum?.join(",") === "executed,deterministic,rubric",
    "schema documents the three proof methods",
  );
}

{
  const result = validateWorkOrder(loadFixture("golden.basic.json"));
  assert(result.ok && result.status === "PASS", "golden work order passes");
  assert(result.errors.length === 0, "golden work order has no errors");
}

for (const [fixture, expectedCode] of [
  ["invalid.missing-proof-obligation.json", "claim_missing_proof_obligation"],
  ["invalid.unbounded-budget.json", "budget_field_unbounded"],
  ["invalid.ambiguous-goal.json", "ambiguous_goal"],
  ["invalid.duplicate-claim-id.json", "duplicate_claim_id"],
  ["invalid.orphan-proof-obligation.json", "orphan_proof_obligation"],
  ["invalid.recipe-profile-missing-dry-run.json", "recipe_profile_missing_dry_run_contract"],
]) {
  const result = validateWorkOrder(loadFixture(fixture));
  assert(!result.ok && result.status === "FAIL", `${fixture} fails validation`);
  assert(errorCodes(result).has(expectedCode), `${fixture} reports ${expectedCode}`);
  assert(allErrorsAreActionable(result), `${fixture} errors are actionable`);
}

{
  const result = validateWorkOrder(loadFixture("golden.recipe-profile.json"));
  assert(result.ok && result.status === "PASS", "golden recipe-profile work order passes");
  assert(result.errors.length === 0, "golden recipe-profile work order has no errors");
}

{
  const workOrder = buildPlanWorkOrderProjection({
    goal: "Migrate planner intent and verification contracts onto work-order projections.",
    planDirName: "plan_projection_contract",
    intentContract: {
      primary_user: "planner operator",
      job_to_be_done: "Read planner intent through work_order.json",
      desired_outcomes: ["Intent projection remains readable."],
      anti_goals: [],
      constraints: [],
      deliverables: [],
    },
    successCriteria: [
      { id: "sc_1", label: "Projection rows are valid." },
    ],
    verificationRows: [
      {
        criterion_id: "sc_1",
        story_linkage: "US-PROJECTION",
        repo_context: "migration parity",
        required_proof_type: "proof:migration_parity",
        command: "node test",
        pass_means: "test passes",
        what_remains_unverified: "Remote CI",
      },
    ],
  });
  const result = validateWorkOrder(workOrder);
  assert(result.ok && result.status === "PASS", "plan projection work order passes validation");
  assert(getIntentContractProjection(workOrder)?.primary_user === "planner operator", "intent projection helper reads normalized intent");
  assert(getWorkOrderSuccessCriteria(workOrder).length === 1, "success criteria projection helper reads criteria");
  assert(getWorkOrderVerificationRows(workOrder).length === 1, "verification row projection helper reads rows");

  const invalid = JSON.parse(JSON.stringify(workOrder));
  invalid.projections.verification_matrix.verification_strategy[0].criterion_id = "sc_missing";
  const invalidResult = validateWorkOrder(invalid);
  assert(!invalidResult.ok && invalidResult.status === "FAIL", "orphaned projection verification row fails validation");
  assert(errorCodes(invalidResult).has("verification_row_projection_orphan_criterion"), "orphaned projection row reports deterministic error code");
  assert(allErrorsAreActionable(invalidResult), "projection validation errors are actionable");
}

{
  const recipe = loadRecipeDefinition(join(testDir, "fixtures", "recipes", "canonical"), "sample-flow");
  const workOrder = buildRecipeWorkOrder(recipe);
  const result = validateWorkOrder(workOrder);
  assert(workOrder.profile?.type === "recipe", "buildRecipeWorkOrder emits recipe profile");
  assert(workOrder.profile?.dry_run_fail_closed === true, "buildRecipeWorkOrder marks dry-run fail-closed when dry-run flags exist");
  assert(result.ok && result.status === "PASS", "buildRecipeWorkOrder output passes validation for canonical fixture");
}

{
  const result = runCli(fixturePath("golden.basic.json"));
  assert(result.exit_code === 0, "CLI exits 0 for valid work order");
  assert(result.parsed?.status === "PASS", "CLI valid work order emits PASS JSON");
}

{
  const result = runCli(fixturePath("invalid.unbounded-budget.json"));
  assert(result.exit_code === 1, "CLI exits non-zero for invalid work order");
  assert(result.parsed?.status === "FAIL", "CLI invalid work order emits FAIL JSON");
  assert(errorCodes(result.parsed).has("budget_field_unbounded"), "CLI surfaces budget error code");
  assert(allErrorsAreActionable(result.parsed), "CLI invalid errors are actionable");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
