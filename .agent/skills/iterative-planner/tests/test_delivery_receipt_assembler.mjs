#!/usr/bin/env node
// test_delivery_receipt_assembler.mjs - E6-4 dispute escalation and receipt assembly.

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  assembleDeliveryReceipt,
  validateDeliveryReceipt,
} from "../scripts/lib/delivery_receipt_assembler.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const fixturePath = join(testDir, "fixtures", "delivery_receipt", "e6_4.dispute.json");
const cliPath = join(skillDir, "scripts", "delivery_receipt_assemble.mjs");
const artifactPath = join(repoRoot, "reports", "ive", "delivery_receipts", "e6-4-focused", "receipt.json");
const NODE = process.execPath;
const NOW = "2026-01-01T00:00:00.000Z";

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function claimById(receipt, id) {
  return receipt.claims.find((claim) => claim.id === id);
}

function runCli(args) {
  try {
    const stdout = execFileSync(NODE, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exit_code: 0, stdout, parsed: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout?.toString() || "";
    return {
      exit_code: error.status ?? 1,
      stdout,
      parsed: stdout ? JSON.parse(stdout) : null,
    };
  }
}

console.log("\nDelivery Receipt Assembler Tests (E6-4)\n");

const fixture = readJson(fixturePath);

const receipt = await assembleDeliveryReceipt({ input: fixture, now: NOW });
const validation = validateDeliveryReceipt(receipt);
assert(validation.ok && validation.status === "PASS", "assembled receipt validates");
assert(receipt.return_type === "delivery_receipt", "receipt has stable return_type");
assert(receipt.receipt_type === "autocoder_delivery_receipt", "receipt has stable receipt_type");
assert(receipt.generated_at === NOW, "receipt generated_at is caller-controlled");
assert(receipt.status === "ESCALATED", "dispute fixture records escalated status");
assert(receipt.claims.length === 3, "receipt includes every claim");
assert(receipt.dispute_trail.length === 2, "receipt records both dispute trail entries");
assert(receipt.escalation_telemetry.event_count === 2, "receipt emits two escalation telemetry events");
assert(receipt.escalation_telemetry.escalation_count === 2, "receipt counts two frontier escalations");
assert(receipt.escalation_telemetry.by_trigger.verifier_disagreement === 2, "telemetry groups verifier disagreement triggers");
assert(receipt.escalation_telemetry.cost_per_escalation_usd > 0, "telemetry records cost per escalation");
assert(receipt.cost_ledger.sections.frontier_escalation.call_count === 2, "full cost ledger counts frontier calls");
assert(receipt.cost_ledger.total.provider_call_count === 2, "full cost ledger totals provider calls");
assert(receipt.cost_ledger.total.usd > 0, "full cost ledger totals escalation cost");
assert(receipt.residual_risks.length === 3, "receipt carries fixture risk plus one risk per escalation");

const split = receipt.dispute_trail.find((row) => row.dispute_id === "rubric_admin_split");
assert(split?.action === "escalate", "rubric-admin split escalates");
assert(split?.reasons?.includes("rubric_admin_split"), "rubric-admin split preserves stable reason");
assert(split?.provider?.role === "escalation", "rubric-admin split uses escalation role");
assert(split?.provider?.quality === "frontier", "rubric-admin split uses frontier provider");
assert(split?.telemetry_event?.cost_estimate_usd > 0, "rubric-admin split records telemetry cost");

const contradiction = receipt.dispute_trail.find((row) => row.dispute_id === "rubric_deterministic_contradiction");
assert(contradiction?.action === "escalate", "rubric-vs-deterministic contradiction escalates");
assert(
  contradiction?.reasons?.includes("rubric_deterministic_contradiction"),
  "rubric-vs-deterministic contradiction preserves stable reason",
);

const splitClaim = claimById(receipt, "claim_scoreboard_status");
assert(splitClaim?.verification_method === "escalated", "rubric split impacted claim is marked escalated");
assert(splitClaim?.evidence_refs?.some((ref) => ref.startsWith("escalation:e6_4_rubric_admin_split")), "rubric split claim links escalation evidence");

const contradictionClaim = claimById(receipt, "claim_budget_gate");
assert(contradictionClaim?.verification_method === "escalated", "contradiction impacted claim is marked escalated");
assert(contradictionClaim?.evidence_refs?.some((ref) => ref.startsWith("escalation:e6_4_rubric_deterministic_contradiction")), "contradiction claim links escalation evidence");

const quietClaim = claimById(receipt, "claim_no_dispute");
assert(quietClaim?.verification_method === "executed", "unimpacted claim preserves original method");
assert(quietClaim?.escalation_refs?.length === 0, "unimpacted claim has no escalation refs");

const repeat = await assembleDeliveryReceipt({ input: readJson(fixturePath), now: NOW });
assert(JSON.stringify(receipt) === JSON.stringify(repeat), "receipt JSON is repeat-stable with fixed timestamp");

const noDisputeInput = clone(fixture);
noDisputeInput.delivery_id = "delivery_e6_4_no_dispute_fixture";
noDisputeInput.verifier_disputes = [
  {
    id: "no_dispute_agreement",
    impacted_claim_ids: ["claim_no_dispute"],
    rubric_verdicts: [
      { id: "cheap_honest", status: "pass" },
      { id: "cheap_peer", status: "pass" }
    ],
    deterministic_check: {
      id: "deterministic_agreement",
      status: "pass"
    },
    transcript: {
      id: "no_dispute_agreement",
      ref: "fixture:no_dispute",
      event_id: "e6_4_no_dispute"
    }
  }
];
const noDispute = await assembleDeliveryReceipt({ input: noDisputeInput, now: NOW });
assert(noDispute.status === "PASS", "no-dispute path returns PASS");
assert(noDispute.escalation_telemetry.event_count === 0, "no-dispute path emits zero escalation events");
assert(noDispute.cost_ledger.sections.frontier_escalation.call_count === 0, "no-dispute path records zero frontier calls");
assert(claimById(noDispute, "claim_no_dispute")?.verification_method === "executed", "no-dispute path preserves executed method");
assert(noDispute.dispute_trail[0]?.action === "accept", "no-dispute path records accept trail");

const missingProvider = clone(fixture);
delete missingProvider.escalation_mock_response;
try {
  await assembleDeliveryReceipt({ input: missingProvider, env: {}, now: NOW });
  assert(false, "missing escalation provider fails explicitly");
} catch (error) {
  assert(error?.code === "provider_unavailable", "missing escalation provider reports provider_unavailable");
}

const cli = runCli(["--input", fixturePath, "--output", artifactPath, "--now", NOW, "--json"]);
assert(cli.exit_code === 0, "CLI exits zero for valid fixture");
assert(cli.parsed?.status === "ESCALATED", "CLI emits escalated receipt JSON");
assert(cli.parsed?.output_path === artifactPath, "CLI reports output path");
assert(existsSync(artifactPath), "CLI writes receipt artifact for scoreboard collection");
const written = readJson(artifactPath);
assert(validateDeliveryReceipt(written).ok, "written receipt artifact validates");

const invalidCli = runCli(["--input", join(testDir, "fixtures", "claims_evidence", "invalid.unstructured-prose.json"), "--json"]);
assert(invalidCli.exit_code === 1, "CLI exits non-zero for invalid input");
assert(invalidCli.parsed?.status === "FAIL", "CLI invalid input emits FAIL JSON");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
