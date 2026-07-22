#!/usr/bin/env node
// test_contract_reliability.mjs - general IVE contract reliability guards.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildComplaintRegressionSeed,
  evaluateAssumptionLedger,
  evaluateClaimProofRoutes,
  evaluateComplaintRegression,
  evaluateOutputContract,
  evaluateProjectContractRegistry,
} from "../scripts/lib/contract_reliability.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..", "..", "..", "..");
const cli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "contract_reliability.mjs");
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

function codes(report) {
  return new Set((report.issues || []).map((issue) => issue.code));
}

console.log("\nIVE Contract Reliability Tests\n");

console.log("[output contracts]");
const goodReport = [
  "# Match Report",
  "",
  "## Exact Format",
  "The requested section order is preserved.",
  "",
  "## Evidence",
  "Proof refs: VM-REPORT-001.",
  "",
  "## Counterargument",
  "The strongest counterargument is recorded.",
].join("\n");

let report = evaluateOutputContract({
  id: "ipbs_report_shape",
  type: "output_contract",
  artifact_text: goodReport,
  required_sections: ["Exact Format", "Evidence", "Counterargument"],
  required_signals: ["Proof refs"],
  forbidden_placeholders: ["TODO", "TBD"],
  anti_goals: ["marketing copy"],
});
assert(report.ok, "well-formed report satisfies required sections, evidence signals, placeholders, and anti-goals");

report = evaluateOutputContract({
  id: "bad_report_shape",
  type: "output_contract",
  artifact_text: "# Match Report\n\n## Evidence\nTODO: trust me, tests passed.\n",
  required_sections: ["Exact Format", "Evidence"],
  required_signals: ["Proof refs"],
  forbidden_placeholders: ["TODO"],
});
assert(!report.ok, "bad report fails deterministic output contract");
assert(codes(report).has("output_contract_missing_section"), "missing requested report section is detected");
assert(codes(report).has("output_contract_missing_signal"), "missing proof signal is detected");
assert(codes(report).has("output_contract_forbidden_placeholder"), "placeholder text is detected");

console.log("\n[assumption ledger]");
report = evaluateAssumptionLedger({
  id: "odds_assumptions",
  type: "assumption_ledger",
  assumptions: [
    {
      id: "odds_ok",
      text: "User said the odds are probably okay.",
      impact: "high",
      status: "user_asserted",
    },
  ],
});
assert(!report.ok, "high-impact user assertion cannot silently pass as fact");
assert(codes(report).has("assumption_high_impact_unverified"), "unverified high-impact assumption emits stable blocker code");

report = evaluateAssumptionLedger({
  id: "bounded_unverified_assumptions",
  type: "assumption_ledger",
  assumptions: [
    {
      id: "odds_snapshot_pending",
      text: "Odds snapshot is not verified in this pass.",
      impact: "high",
      status: "unverified_allowed",
      waiver_ref: "D-NO-PROMOTION",
      boundary: "No odds-quality or edge claim is made until an external snapshot is attached.",
    },
    {
      id: "config_flag",
      text: "Feature flag name came from the repo config.",
      impact: "low",
      status: "externally_verified",
      evidence_refs: ["config/features.json"],
    },
  ],
});
assert(report.ok, "explicit waiver plus no-claim boundary permits a known unverified assumption");

// Regression guard (red-team F-001): a status label is not proof.
report = evaluateAssumptionLedger({
  id: "externally_verified_without_evidence",
  type: "assumption_ledger",
  assumptions: [
    {
      id: "odds_ok",
      text: "Agent relabelled the odds assumption as externally verified.",
      impact: "high",
      status: "externally_verified",
    },
  ],
});
assert(!report.ok, "externally_verified assumption without evidence cannot pass");
assert(codes(report).has("assumption_externally_verified_without_evidence"), "externally_verified without evidence emits a stable blocker code");

console.log("\n[claim proof routing]");
report = evaluateClaimProofRoutes({
  id: "report_claims",
  type: "claim_proof_routes",
  claims: [
    {
      id: "format_done",
      type: "output_conforms",
      statement: "The report follows the requested format.",
      proof_refs: [{ kind: "proof:test_log", ref: "tests passed" }, { kind: "proof:self_report", ref: "agent said so" }],
    },
  ],
});
assert(!report.ok, "generic test logs and self-report do not satisfy a format-conformance claim");
assert(codes(report).has("claim_route_missing_required_proof"), "claim-specific proof kind is required");
assert(codes(report).has("claim_route_rejects_self_report"), "self-report proof is rejected for user-visible claims");

report = evaluateClaimProofRoutes({
  id: "verified_claims",
  type: "claim_proof_routes",
  claims: [
    {
      id: "format_done",
      type: "output_conforms",
      statement: "The report follows the requested format.",
      proof_refs: [{ kind: "proof:output_contract", ref: "reports/ive/contracts/report.json" }],
    },
    {
      id: "quant_result_bounded",
      type: "quantitative_result",
      statement: "The quantitative claim is bounded by QRV proof.",
      proof_refs: [{ kind: "proof:quant_results_validation", ref: "reports/ive/qrv.json" }],
    },
  ],
});
assert(report.ok, "claim routes pass when matching proof artifacts are attached");

// Regression guard (red-team F-002): a bare proof kind with no ref/artifact is not proof.
report = evaluateClaimProofRoutes({
  id: "bare_proof_kind",
  type: "claim_proof_routes",
  claims: [
    {
      id: "format_done",
      type: "output_conforms",
      proof_refs: [{ kind: "proof:output_contract" }],
    },
  ],
});
assert(!report.ok, "bare proof kind without a backing ref/artifact cannot satisfy a claim");
assert(codes(report).has("claim_route_proof_ref_missing_artifact"), "missing proof artifact emits a stable blocker code");

// Regression guard (red-team F-003): project-local routes cannot weaken built-in anti-fabrication routes.
report = evaluateClaimProofRoutes({
  id: "self_report_override",
  type: "claim_proof_routes",
  claim_routes: [
    {
      claim_type: "output_conforms",
      required_proof_kinds: ["proof:self_report"],
      reject_generic_self_report: false,
    },
  ],
  claims: [
    {
      id: "format_done",
      type: "output_conforms",
      proof_refs: [{ kind: "proof:self_report", ref: "agent says done" }],
    },
  ],
});
assert(!report.ok, "project-local route cannot weaken a built-in claim route into accepting self-report");
assert(codes(report).has("claim_route_builtin_override_rejected"), "built-in claim route override is rejected with a stable code");
assert(codes(report).has("claim_route_rejects_self_report"), "the built-in route still rejects self-report after the override attempt");

console.log("\n[complaint regression]");
const seed = buildComplaintRegressionSeed({
  id: "ignored_format",
  user_text: "You ignored my requested report format.",
  violated_contract_kind: "output_contract",
  expected_behavior: "A failing fixture checks the exact section contract.",
  proof_target: "test_contract_reliability.mjs",
  recurrence_guard: "IVE conformance runner includes contract-reliability.",
});
assert(seed.fixed_claim_allowed === false && seed.user_correction.includes("ignored"), "complaint seed captures correction without claiming it is fixed");

report = evaluateComplaintRegression({
  id: "format_complaint",
  type: "complaint_regression",
  complaint: {
    id: "ignored_format",
    user_text: "You ignored my requested report format.",
    violated_contract_kind: "output_contract",
    expected_behavior: "A failing fixture checks the exact section contract.",
    proof_target: "test_contract_reliability.mjs",
    recurrence_guard: "IVE conformance runner includes contract-reliability.",
    resolution_claim: "fixed now",
  },
});
assert(!report.ok, "complaint artifact cannot claim resolution without proof refs");
assert(codes(report).has("complaint_resolution_claim_without_proof"), "resolution claim requires proof");

console.log("\n[project-local registry]");
const registry = {
  id: "ipbs_local_contracts",
  version: 1,
  contracts: [
    {
      id: "report_shape",
      type: "output_contract",
      artifact_text: goodReport,
      required_sections: ["Exact Format", "Evidence", "Counterargument"],
      required_signals: ["Proof refs"],
    },
    {
      id: "assumption_policy",
      type: "assumption_ledger",
      assumptions: [
        {
          id: "odds_pending",
          impact: "high",
          status: "unverified_allowed",
          waiver_ref: "D-NO-PROMOTION",
          boundary: "No edge claim until an external odds snapshot is attached.",
        },
      ],
    },
    {
      id: "claim_policy",
      type: "claim_proof_routes",
      claims: [
        {
          id: "format_done",
          type: "output_conforms",
          proof_refs: [{ kind: "proof:output_contract", ref: "reports/ive/contracts/report.json" }],
        },
      ],
    },
    {
      id: "complaint_policy",
      type: "complaint_regression",
      complaint: {
        id: "ignored_format",
        user_text: "You ignored my requested report format.",
        violated_contract_kind: "output_contract",
        expected_behavior: "A failing fixture checks the exact section contract.",
        proof_target: "test_contract_reliability.mjs",
        recurrence_guard: "IVE conformance runner includes contract-reliability.",
      },
    },
  ],
};
report = evaluateProjectContractRegistry(registry);
assert(report.ok && report.contract_count === 4, "project-local registry executes all known contract types");

report = evaluateProjectContractRegistry({
  id: "bad_registry",
  contracts: [{ id: "unknown", type: "ipbs_only_magic" }],
});
assert(!report.ok && codes(report).has("project_contract_unknown_type"), "unknown project-local contract types fail closed");

console.log("\n[CLI]");
const tmp = mkdtempSync(join(tmpdir(), "contract-reliability-"));
try {
  const registryPath = join(tmp, "registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const output = execFileSync(NODE, [cli, "check", "--registry", registryPath, "--json"], { cwd: repoRoot, encoding: "utf-8" });
  const parsed = JSON.parse(output);
  assert(parsed.ok && parsed.status === "PASS", "CLI emits JSON PASS for valid registry");

  const badPath = join(tmp, "bad-registry.json");
  writeFileSync(badPath, `${JSON.stringify({ contracts: [{ id: "unknown", type: "made_up" }] }, null, 2)}\n`);
  let failedStatus = null;
  let failedJson = null;
  try {
    execFileSync(NODE, [cli, "check", "--registry", badPath, "--json"], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failedStatus = error.status;
    failedJson = JSON.parse(String(error.stdout || "{}"));
  }
  assert(failedStatus === 1 && codes(failedJson).has("project_contract_unknown_type"), "CLI exits non-zero and surfaces unknown-type issue");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
