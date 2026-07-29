#!/usr/bin/env node
// test_presentation_contract.mjs - E3-5 render contracts and write authority.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { projectClaimsEvidenceReceipt } from "../scripts/lib/claims_evidence_contract.mjs";
import {
  DEFAULT_PRESENTATION_CONTRACTS,
  DEFAULT_WRITE_AUTHORITY_MATRIX,
  assertVerbatimRender,
  renderPresentationBlock,
  validatePresentationContract,
  validateWriteAuthorityMatrix,
} from "../scripts/lib/presentation_contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const fixtureRoot = join(testDir, "fixtures");
const schemaPath = join(testDir, "..", "config", "presentation_contract.schema.json");

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

function issueCodes(result) {
  return new Set((result.errors || []).map((issue) => issue.code));
}

function fieldNames(block) {
  return block.fields.map((field) => field.name);
}

console.log("\nPresentation Contract Tests\n");

{
  const schema = readJson(schemaPath);
  assert(schema.title === "Iterative Planner Presentation Contract", "schema has presentation-contract title");
  assert(schema.required.includes("render_contracts"), "schema requires render_contracts");
  assert(schema.required.includes("write_authority_matrix"), "schema requires write_authority_matrix");
  assert(schema.$defs?.write_authority_row?.required?.includes("owner"), "schema requires authority row owner");
}

{
  const dispatch = readJson(join(fixtureRoot, "work_orders", "golden.basic.json"));
  const block = renderPresentationBlock("dispatch", dispatch);
  assert(
    fieldNames(block).join(",") === "id,goal,inputs,constraints,claims_to_produce,proof_obligations,stop_conditions,budget",
    "dispatch render preserves fixed field order",
  );
  const proof = assertVerbatimRender("dispatch", dispatch, block);
  assert(proof.ok && proof.status === "PASS", "dispatch render is verbatim against source payload");

  const tampered = JSON.parse(JSON.stringify(block));
  tampered.fields[1].rendered_value = "paraphrased goal";
  const tamperResult = assertVerbatimRender("dispatch", dispatch, tampered);
  assert(!tamperResult.ok && issueCodes(tamperResult).has("render_value_mismatch"), "paraphrased dispatch field fails verbatim proof");
}

{
  const stepPayload = {
    step: "Implement presentation contract helper",
    files: [".agent/skills/iterative-planner/scripts/lib/presentation_contract.mjs"],
    commit: "pending",
    surprises: "none",
    next: "Run focused contract tests",
  };
  const block = renderPresentationBlock("step", stepPayload);
  assert(fieldNames(block).join(",") === "step,files,commit,surprises,next", "step render uses exactly five fixed fields");
  assert(assertVerbatimRender("step", stepPayload, block).ok, "step render is verbatim");
}

{
  const claims = readJson(join(fixtureRoot, "claims_evidence", "golden.basic.json"));
  const receipt = projectClaimsEvidenceReceipt(claims);
  const block = renderPresentationBlock("receipt", receipt);
  assert(fieldNames(block).join(",") === "receipt_type,claims,cost_ledger,invalid_claim_count", "receipt render preserves receipt fields");
  assert(assertVerbatimRender("receipt", receipt, block).ok, "receipt render is verbatim");
}

{
  const invalid = JSON.parse(JSON.stringify(DEFAULT_PRESENTATION_CONTRACTS.dispatch));
  invalid.fields = invalid.fields.filter((field) => field.name !== "goal");
  const result = validatePresentationContract(invalid, { surface: "dispatch" });
  assert(!result.ok && issueCodes(result).has("render_contract_missing_required_field"), "missing dispatch goal is rejected");
}

{
  const result = validateWriteAuthorityMatrix(DEFAULT_WRITE_AUTHORITY_MATRIX);
  assert(result.ok && result.status === "PASS", "default write-authority matrix passes");
}

{
  const validCoOwner = [
    {
      artifact: "verification.md",
      state: "VALIDATE",
      owner: "orchestrator",
      artifact_class: "plan_artifact",
      writers: [
        { actor: "orchestrator", paths: ["criteria"], sequence: 1 },
        { actor: "verification_agent", paths: ["evidence"], sequence: 2 },
      ],
    },
  ];
  assert(validateWriteAuthorityMatrix(validCoOwner).ok, "disjoint sequenced co-owner row passes");
}

for (const [label, matrix, expectedCode] of [
  [
    "duplicate artifact/state rows fail",
    [
      { artifact: "plan.md", state: "PLAN", owner: "orchestrator", writers: [{ actor: "orchestrator" }] },
      { artifact: "plan.md", state: "PLAN", owner: "orchestrator", writers: [{ actor: "orchestrator" }] },
    ],
    "duplicate_authority_entry",
  ],
  [
    "unsequenced multi-writer row fails",
    [
      {
        artifact: "verification.md",
        state: "VALIDATE",
        owner: "orchestrator",
        writers: [
          { actor: "orchestrator", paths: ["criteria"] },
          { actor: "verification_agent", paths: ["evidence"] },
        ],
      },
    ],
    "unsequenced_multi_writer",
  ],
  [
    "overlapping writer paths fail",
    [
      {
        artifact: "verification.md",
        state: "VALIDATE",
        owner: "orchestrator",
        writers: [
          { actor: "orchestrator", paths: ["evidence"], sequence: 1 },
          { actor: "verification_agent", paths: ["evidence"], sequence: 2 },
        ],
      },
    ],
    "overlapping_writer_path",
  ],
  [
    "sub-agent state writes fail",
    [
      {
        artifact: "state.json",
        state: "EXECUTE",
        owner: "orchestrator",
        artifact_class: "orchestrator_state",
        writers: [{ actor: "sub_agent", paths: ["state"], sequence: 1 }],
      },
    ],
    "subagent_orchestrator_state_write",
  ],
]) {
  const result = validateWriteAuthorityMatrix(matrix);
  assert(!result.ok && issueCodes(result).has(expectedCode), label);
}

assert(Object.keys(DEFAULT_PRESENTATION_CONTRACTS).join(",") === "dispatch,step,receipt", "default contracts define dispatch, step, and receipt");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
