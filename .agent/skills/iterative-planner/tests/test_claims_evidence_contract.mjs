#!/usr/bin/env node
// test_claims_evidence_contract.mjs - Claims/evidence schema and bounce protocol coverage.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  VERIFICATION_METHODS,
  decideClaimsEvidenceBounce,
  projectClaimsEvidenceReceipt,
  validateClaimsEvidence,
} from "../scripts/lib/claims_evidence_contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..");
const fixtureRoot = join(testDir, "fixtures", "claims_evidence");
const schemaPath = join(testDir, "..", "config", "claims_evidence.schema.json");
const validatorCli = join(testDir, "..", "scripts", "claims_evidence_validate.mjs");
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

function canonicalJson(value) {
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

console.log("\nClaims/Evidence Contract Tests\n");

{
  const schema = readJson(schemaPath);
  assert(schema.title === "Iterative Planner Claims/Evidence Return", "schema has claims/evidence title");
  assert(schema.required.includes("claims"), "schema requires claims");
  assert(schema.required.includes("bounce"), "schema requires bounded bounce metadata");
  assert(schema.properties?.claims?.items?.required?.includes("evidence_refs"), "schema requires evidence_refs");
  assert(schema.properties?.claims?.items?.required?.includes("verification_method"), "schema requires verification_method");
  assert(schema.properties?.claims?.items?.required?.includes("cost"), "schema requires cost");
  assert(
    schema.properties?.claims?.items?.properties?.verification_method?.enum?.join(",") === "executed,deterministic,rubric,escalated,none",
    "schema documents all verification methods including escalated and none",
  );
  assert(schema.$defs?.receipt_projection?.required?.includes("cost_ledger"), "schema defines receipt projection with cost ledger");
  assert(VERIFICATION_METHODS.has("escalated"), "validator exports escalated verification method");
  assert(VERIFICATION_METHODS.has("none"), "validator exports none verification method");
}

{
  const result = validateClaimsEvidence(loadFixture("golden.basic.json"));
  assert(result.ok && result.status === "PASS", "golden claims/evidence payload passes");
  assert(result.errors.length === 0, "golden claims/evidence payload has no errors");
  const decision = decideClaimsEvidenceBounce(result);
  assert(decision.action === "accept", "valid payload produces accept decision");
  assert(decision.next_action === "return_receipt", "valid payload returns receipt next action");
}

for (const [fixture, expectedCode] of [
  ["invalid.unstructured-prose.json", "unstructured_prose_payload"],
  ["invalid.missing-evidence-ref.json", "claim_evidence_refs_empty"],
  ["invalid.unbounded-cost.json", "claim_cost_unbounded"],
  ["invalid.unknown-verification-method.json", "unknown_verification_method"],
  ["invalid.duplicate-claim-id.json", "duplicate_claim_id"],
  ["invalid.bounce-budget-exhausted.json", "claim_evidence_refs_empty"],
]) {
  const result = validateClaimsEvidence(loadFixture(fixture));
  assert(!result.ok && result.status === "FAIL", `${fixture} fails validation`);
  assert(errorCodes(result).has(expectedCode), `${fixture} reports ${expectedCode}`);
  assert(allErrorsAreActionable(result), `${fixture} errors are actionable`);
}

{
  const result = validateClaimsEvidence(loadFixture("invalid.missing-evidence-ref.json"));
  const decision = decideClaimsEvidenceBounce(result);
  assert(decision.action === "bounce", "invalid payload below budget produces bounce");
  assert(decision.next_action === "retry_with_schema_errors", "bounce tells caller to retry with schema errors");
  assert(decision.next_attempt === 1, "bounce increments attempt");
  assert(decision.remaining_bounces === 1, "bounce reports remaining retry budget");
}

{
  const result = validateClaimsEvidence(loadFixture("invalid.bounce-budget-exhausted.json"));
  const decision = decideClaimsEvidenceBounce(result);
  assert(decision.action === "escalate", "invalid payload at budget produces escalation");
  assert(decision.reason === "bounce_budget_exhausted", "exhausted budget reports stable reason");
  assert(decision.remaining_bounces === 0, "exhausted budget reports no remaining retries");
}

{
  const golden = loadFixture("golden.basic.json");
  const receipt = projectClaimsEvidenceReceipt(golden);
  const repeat = projectClaimsEvidenceReceipt(loadFixture("golden.basic.json"));
  assert(canonicalJson(receipt) === canonicalJson(repeat), "receipt projection is repeat-stable");
  assert(receipt.receipt_type === "claims_evidence_receipt", "receipt has stable receipt_type");
  assert(receipt.claims.length === 2, "receipt includes both claims");
  assert(receipt.cost_ledger.claim_count === 2, "receipt cost ledger counts claims");
  assert(receipt.cost_ledger.total.tokens === 320, "receipt cost ledger totals tokens");
  assert(receipt.cost_ledger.total.usd === 0, "receipt cost ledger totals usd");
  assert(receipt.cost_ledger.total.wall_clock_ms === 47, "receipt cost ledger totals wall clock");
  assert(receipt.invalid_claim_count === 0, "receipt records zero invalid claims");
}

{
  const escalated = clone(loadFixture("golden.basic.json"));
  escalated.claims[0].verification_method = "escalated";
  const result = validateClaimsEvidence(escalated);
  assert(result.ok, "escalated verification method passes validation");
  const receipt = projectClaimsEvidenceReceipt(escalated);
  assert(receipt.claims.some((claim) => claim.verification_method === "escalated"), "receipt projection preserves escalated method");
}

{
  const result = runCli(fixturePath("golden.basic.json"));
  assert(result.exit_code === 0, "CLI exits 0 for valid claims/evidence payload");
  assert(result.parsed?.status === "PASS", "CLI valid payload emits PASS JSON");
  assert(result.parsed?.bounce_decision?.action === "accept", "CLI valid payload includes accept decision");
  assert(result.parsed?.receipt?.receipt_type === "claims_evidence_receipt", "CLI valid payload includes receipt");
}

{
  const result = runCli(fixturePath("invalid.unbounded-cost.json"));
  assert(result.exit_code === 1, "CLI exits 1 for invalid bounceable payload");
  assert(result.parsed?.status === "FAIL", "CLI invalid payload emits FAIL JSON");
  assert(errorCodes(result.parsed).has("claim_cost_unbounded"), "CLI surfaces cost error code");
  assert(result.parsed?.bounce_decision?.action === "bounce", "CLI invalid payload includes bounce decision");
  assert(allErrorsAreActionable(result.parsed), "CLI invalid errors are actionable");
}

{
  const result = runCli(fixturePath("invalid.bounce-budget-exhausted.json"));
  assert(result.exit_code === 2, "CLI exits 2 for exhausted invalid payload");
  assert(result.parsed?.bounce_decision?.action === "escalate", "CLI exhausted payload includes escalation decision");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
