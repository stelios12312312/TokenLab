#!/usr/bin/env node
// test_pack_contract.mjs - E5 pack contract schema and validator coverage.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  KERNEL_PROCESS_PERSONA_EXEMPTIONS,
  validatePackContractFile,
  validatePackContracts,
} from "../scripts/lib/pack_contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const skillRoot = join(repoRoot, ".agent", "skills", "iterative-planner");
const schemaPath = join(skillRoot, "config", "pack_contract.schema.json");
const validatorCli = join(skillRoot, "scripts", "pack_contract_validate.mjs");
const incompleteFixtureDir = join(testDir, "fixtures", "pack_contract", "incomplete_pack");
const incompleteFixturePath = join(incompleteFixtureDir, "pack_contract.json");
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

function runCli(args) {
  try {
    const stdout = execFileSync(NODE, [validatorCli, ...args, "--json"], {
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

console.log("\nPack Contract Tests\n");

{
  const schema = readJson(schemaPath);
  assert(schema.title === "Iterative Planner Pack Contract", "schema has pack-contract title");
  for (const required of ["rubrics", "checkers", "calibration_ref", "goldens_ref", "seeded_defects_ref", "serves_projects"]) {
    assert(schema.required.includes(required), `schema requires ${required}`);
  }
  assert(schema.properties?.rubrics?.items?.required?.includes("closed_question"), "schema requires closed_question rubrics");
  assert(schema.properties?.checkers?.items?.required?.includes("deterministic"), "schema requires deterministic checkers");
  assert(schema.properties?.serves_projects?.minItems === 2, "schema documents serves_projects >= 2");
}

{
  const result = validatePackContracts({ rootDir: repoRoot });
  assert(result.ok && result.status === "PASS", "current pack contracts pass");
  for (const packId of ["app_dev_tesseract", "quant", "quant_target", "tokenomics", "ux_ui"]) {
    const pack = result.pack_results.find((entry) => entry.pack_id === packId);
    assert(pack?.status === "PASS", `${packId} contract passes`);
  }
  assert(allErrorsAreActionable(result), "aggregate validator errors are actionable");
}

{
  const result = validatePackContracts({ rootDir: repoRoot });
  for (const [packId, reason] of Object.entries(KERNEL_PROCESS_PERSONA_EXEMPTIONS)) {
    const pack = result.pack_results.find((entry) => entry.pack_id === packId);
    assert(pack?.status === "EXEMPT", `${packId} is exempt`);
    assert(pack?.reason_code === reason, `${packId} records ${reason}`);
  }
}

{
  const result = validatePackContractFile(incompleteFixturePath, {
    packDir: incompleteFixtureDir,
    rootDir: repoRoot,
  });
  const codes = errorCodes(result);
  assert(!result.ok && result.status === "FAIL", "incomplete fixture fails validation");
  assert(codes.has("seeded_defects_ref_missing"), "incomplete fixture reports missing seeded_defects_ref");
  assert(codes.has("serves_projects_too_few"), "incomplete fixture reports too few served projects");
  assert(codes.has("rubric_not_closed_question"), "incomplete fixture reports open rubric");
  assert(codes.has("checker_not_deterministic"), "incomplete fixture reports nondeterministic checker");
  assert(allErrorsAreActionable(result), "incomplete fixture errors are actionable");
}

{
  const result = runCli([]);
  assert(result.exit_code === 0, "CLI exits 0 for current packs");
  assert(result.parsed?.status === "PASS", "CLI emits PASS JSON for current packs");
  assert(result.parsed?.counts?.exempt === 4, "CLI reports four kernel process persona exemptions");
}

{
  const result = runCli([incompleteFixtureDir]);
  assert(result.exit_code === 1, "CLI exits non-zero for incomplete fixture");
  assert(result.parsed?.status === "FAIL", "CLI emits FAIL JSON for incomplete fixture");
  assert(errorCodes(result.parsed).has("seeded_defects_ref_missing"), "CLI surfaces seeded-defect error code");
}

{
  const template = readFileSync(join(skillRoot, "packs", "_template", "README.md"), "utf-8");
  for (const token of ["pack_contract.json", "rubrics", "checkers", "calibration_ref", "goldens_ref", "seeded_defects_ref", "serves_projects"]) {
    assert(template.includes(token), `_template docs mention ${token}`);
  }
  assert(template.includes("kernel_process_persona"), "_template docs mention kernel process persona exemptions");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
