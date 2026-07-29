#!/usr/bin/env node
// test_claim_briefing_compiler.mjs - Claim briefing schema and compiler coverage.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  compileClaimBriefingFromFiles,
  validateClaimBriefing,
} from "../scripts/lib/claim_briefing_compiler.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const fixtureRoot = join(testDir, "fixtures", "work_orders");
const schemaPath = join(testDir, "..", "config", "claim_briefing.schema.json");
const fixturePath = join(fixtureRoot, "golden.claim-briefing.json");

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

function canonical(value) {
  return JSON.stringify(value);
}

console.log("\nClaim Briefing Compiler Tests\n");

{
  const schema = readJson(schemaPath);
  assert(schema.title === "Iterative Planner Claim Briefing", "schema has claim briefing title");
  assert(schema.required.includes("claims"), "schema requires claims");
  assert(schema.required.includes("packs"), "schema requires packs");
  assert(schema.required.includes("context_refs"), "schema requires context_refs");
  assert(schema.properties?.claims?.items?.required?.includes("questions"), "schema requires claim questions");
  assert(schema.$defs?.question?.required?.includes("answer_contract"), "schema requires answer_contract");
  assert(schema.$defs?.question?.properties?.closed_question?.const === true, "schema documents closed_question=true");
  assert(
    schema.$defs?.question?.properties?.answer_contract?.properties?.type?.enum?.join(",") === "run_command,cite_line,compare_value,allowed_answer",
    "schema documents closed answer contract types",
  );
}

let briefing = null;
{
  const result = compileClaimBriefingFromFiles({
    workOrderPath: fixturePath,
    packIds: ["quant", "app_dev_tesseract"],
    rootDir: repoRoot,
  });
  const repeat = compileClaimBriefingFromFiles({
    workOrderPath: fixturePath,
    packIds: ["app_dev_tesseract", "quant"],
    rootDir: repoRoot,
  });
  briefing = result.briefing;
  assert(result.ok && result.status === "PASS", "fixture work-order compiles successfully");
  assert(repeat.ok && repeat.status === "PASS", "repeat compile succeeds with different pack order");
  assert(canonical(result.briefing) === canonical(repeat.briefing), "compiled briefing is deterministic across pack order");
  assert(briefing.return_type === "claim_briefing", "briefing has claim_briefing discriminator");
  assert(briefing.summary.claim_count === 2, "briefing includes both fixture claims");
  assert(briefing.summary.pack_count === 2, "briefing includes both selected pack contracts");
  assert(briefing.summary.question_count === 15, "briefing fans out proof and pack rubric questions");
  assert(briefing.summary.proof_obligation_question_count === 3, "briefing includes proof obligation questions");
  assert(briefing.summary.pack_rubric_question_count === 12, "briefing includes pack rubric questions per claim");
  assert(briefing.context_refs.length === 2, "briefing carries focused context refs");
  assert(briefing.packs.map((pack) => pack.pack_id).join(",") === "app_dev_tesseract,quant", "briefing sorts selected pack ids");
  assert(
    briefing.claims.every((claim) => claim.questions.every((question) => question.closed_question === true)),
    "every generated question is closed",
  );
  assert(
    briefing.claims.some((claim) => claim.questions.some((question) => question.source_type === "pack_rubric" && question.pack_id === "quant" && question.rubric_id === "temporal_leakage")),
    "quant rubric question is attached to claims",
  );
  assert(
    briefing.claims.some((claim) => claim.questions.some((question) => question.source_type === "pack_rubric" && question.pack_id === "app_dev_tesseract" && question.allowed_answers.includes("not_applicable"))),
    "app-dev rubric allowed answers are preserved",
  );
}

{
  const validation = validateClaimBriefing(briefing);
  assert(validation.ok && validation.status === "PASS", "compiled briefing passes output validator");
  assert(validation.errors.length === 0, "compiled briefing has no validation errors");
}

{
  const invalid = JSON.parse(JSON.stringify(briefing));
  invalid.claims[0].questions[0].question = "Explain why this implementation is good enough.";
  const result = validateClaimBriefing(invalid);
  assert(!result.ok && result.status === "FAIL", "open-ended question fails validation");
  assert(errorCodes(result).has("question_open_ended"), "open-ended question reports question_open_ended");
  assert(allErrorsAreActionable(result), "open-ended question errors are actionable");
}

{
  const invalid = JSON.parse(JSON.stringify(briefing));
  invalid.claims[0].questions[0].allowed_answers = ["pass"];
  const result = validateClaimBriefing(invalid);
  assert(!result.ok && result.status === "FAIL", "single allowed answer fails validation");
  assert(errorCodes(result).has("question_allowed_answers_invalid"), "single allowed answer reports allowed-answer error");
  assert(allErrorsAreActionable(result), "allowed-answer errors are actionable");
}

{
  const result = compileClaimBriefingFromFiles({
    workOrderPath: fixturePath,
    packIds: ["missing_pack"],
    rootDir: repoRoot,
  });
  assert(!result.ok && result.status === "FAIL", "unknown pack fails closed");
  assert(errorCodes(result).has("pack_contract_missing"), "unknown pack reports pack_contract_missing");
  assert(allErrorsAreActionable(result), "unknown pack errors are actionable");
}

{
  const result = compileClaimBriefingFromFiles({
    workOrderPath: join(fixtureRoot, "invalid.ambiguous-goal.json"),
    packIds: ["quant"],
    rootDir: repoRoot,
  });
  assert(!result.ok && result.status === "FAIL", "invalid work-order fails closed");
  assert(errorCodes(result).has("ambiguous_goal"), "invalid work-order errors are surfaced");
  assert(allErrorsAreActionable(result), "invalid work-order errors are actionable");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
