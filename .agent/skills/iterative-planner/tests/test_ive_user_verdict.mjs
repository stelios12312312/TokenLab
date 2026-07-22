#!/usr/bin/env node
// test_ive_user_verdict.mjs - IVE user verdict golden coverage.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildIveUserVerdict,
  renderIveUserVerdictText,
} from "../scripts/lib/ive_user_verdict.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..");
const cliPath = join(testDir, "..", "scripts", "ive_user_verdict.mjs");
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

function makeTemp() {
  return mkdtempSync(join(tmpdir(), "ive-user-verdict-"));
}

function baseRoute(overrides = {}) {
  return {
    source_finding: "F-001",
    ontology_fact: "ive_fact(user_visible_blocker,F-001)",
    status: "removed",
    concept_guard: "user visible verdicts require routed material facts",
    valid_next_action: "report_only",
    verification_required: "Golden verdict output includes fulfillment, blockers, non-claims, next action, and evidence.",
    stop_condition: "Stop once the verdict is honest about fulfillment and blockers.",
    recurrence_guard: "core.user-verdict fixture prevents report-only false green closure.",
    removal_evidence: "The blocker is removed by deterministic verdict rendering.",
    evidence_refs: ["reports/ive/verdict-proof.json"],
    ...overrides,
  };
}

function packet(overrides = {}) {
  const route = baseRoute();
  return {
    schema_version: 1,
    intent: {
      goal: "Render an honest IVE user verdict.",
      what_ran: ["IVE packet validation", "IVE fact routing"],
      what_did_not_run: ["External GitHub publication"],
    },
    source_findings: [
      { id: "F-001", summary: "The user needs a visible verdict." },
    ],
    ontology_facts: [
      {
        id: route.ontology_fact,
        ontology_fact: route.ontology_fact,
        source_finding: "F-001",
        material: true,
      },
    ],
    concept_dictionary: {
      user_visible_blocker: "A blocker that must be visible in the user closeout.",
    },
    fact_routes: [route],
    closure_status: "closeable",
    closure_reason: "All material facts have terminal routes.",
    evidence_refs: ["plans/plan_verification.md"],
    non_claims: ["No external publishing was performed."],
    strongest_counterargument: "A short success summary could hide evidence boundaries.",
    false_green_risk: "Report-only prose can look complete while evidence links are absent.",
    advisory_review: {
      status: "not_run",
    },
    ...overrides,
  };
}

function runCli(args, inputPacket) {
  const tmp = makeTemp();
  const packetPath = join(tmp, "packet.json");
  writeFileSync(packetPath, `${JSON.stringify(inputPacket, null, 2)}\n`, "utf-8");
  try {
    const stdout = execFileSync(NODE, [cliPath, "--packet", packetPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout?.toString() || "", status: error.status };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nIVE User Verdict Tests\n");

{
  const verdict = buildIveUserVerdict(packet());
  const text = renderIveUserVerdictText(verdict);
  assert(verdict.status === "PASS", "satisfied verdict reports PASS");
  assert(verdict.verdict === "fulfilled", "satisfied verdict label is fulfilled");
  assert(verdict.fulfillment_status === "satisfied", "fulfilled packet is satisfied");
  assert(verdict.valid_next_action === "report_only", "fulfilled terminal route can report only");
  assert(verdict.user_decision_required === false, "fulfilled packet does not require user decision");
  assert(verdict.blockers.length === 0, "fulfilled packet has no blockers");
  assert(verdict.evidence_links.some((entry) => entry.ref === "plans/plan_verification.md"), "packet evidence links are preserved");
  assert(text.includes("Fulfillment: satisfied"), "text includes fulfillment status");
  assert(text.includes("Not claimed:"), "text includes non-claim section");
  assert(text.includes("Evidence:"), "text includes evidence section");
}

{
  const accepted = baseRoute({
    ontology_fact: "ive_fact(alpha_claim_limited,F-002)",
    source_finding: "F-002",
    status: "accepted",
    valid_next_action: "accept_limitation",
    claim_boundary: "No alpha, ROI, betting, or model-performance claim is made from this fixture.",
  });
  const deferred = baseRoute({
    ontology_fact: "ive_fact(market_provenance_ticketed,F-003)",
    source_finding: "F-003",
    status: "deferred_with_ticket",
    valid_next_action: "ticket_now",
    ticket_ref: "T-INTAKE-MARKET-PROVENANCE",
    acceptance_criteria: ["Ticket records entry price, reference price, timestamp, and liquidity boundary."],
  });
  const verdict = buildIveUserVerdict(packet({
    source_findings: [
      { id: "F-002", summary: "Alpha claim must be bounded." },
      { id: "F-003", summary: "Market provenance needs a ticket." },
    ],
    ontology_facts: [
      { ontology_fact: accepted.ontology_fact, source_finding: "F-002", material: true },
      { ontology_fact: deferred.ontology_fact, source_finding: "F-003", material: true },
    ],
    fact_routes: [accepted, deferred],
    non_claims: ["No stale market-signal claim is promoted."],
  }));
  const text = renderIveUserVerdictText(verdict);
  assert(verdict.status === "WARN", "accepted/deferred verdict reports WARN");
  assert(verdict.fulfillment_status === "partially_satisfied", "accepted/deferred routes are partially satisfied");
  assert(verdict.valid_next_action === "ticket_now", "deferred ticket drives next action");
  assert(verdict.non_claims.some((entry) => entry.includes("No alpha")), "claim boundary is rendered as a non-claim");
  assert(verdict.evidence_links.some((entry) => entry.ref === "T-INTAKE-MARKET-PROVENANCE"), "ticket ref is preserved as evidence");
  assert(text.includes("Fulfillment: partially_satisfied"), "text names partial fulfillment");
  assert(text.includes("No stale market-signal claim is promoted."), "text includes packet non-claim");
}

{
  const blocked = baseRoute({
    status: "blocked",
    valid_next_action: "ask_user",
    blocker_reason: "Operator must decide whether to accept this limitation.",
  });
  const verdict = buildIveUserVerdict(packet({
    fact_routes: [blocked],
    closure_status: "blocked",
    closure_reason: "User decision is required.",
  }));
  assert(verdict.status === "FAIL", "blocked verdict reports FAIL");
  assert(verdict.fulfillment_status === "not_satisfied", "blocked packet is not satisfied");
  assert(verdict.valid_next_action === "ask_user", "blocked packet asks user");
  assert(verdict.user_decision_required === true, "blocked packet requires user decision");
  assert(verdict.blockers.some((entry) => entry.kind === "route_blocker"), "blocked route remains visible");
}

{
  const falseGreen = baseRoute({
    status: "unrouted",
    valid_next_action: "report_only",
  });
  const verdict = buildIveUserVerdict(packet({
    fact_routes: [falseGreen],
    closure_status: "blocked",
    closure_reason: "Material fact is unresolved.",
  }));
  assert(verdict.status === "FAIL", "false-green packet reports FAIL");
  assert(verdict.fulfillment_status === "not_satisfied", "false-green packet is not satisfied");
  assert(verdict.valid_next_action === "ask_user", "invalid report_only does not remain the suggested next action");
  assert(verdict.blockers.some((entry) => entry.code === "report_only_with_unrouted_material_fact"), "packet contract error is rendered");
  assert(verdict.blockers.some((entry) => entry.code === "report_only_with_unresolved_material_fact"), "router error is rendered");
}

{
  const jsonRun = runCli(["--json"], packet());
  assert(jsonRun.ok, "CLI JSON exits 0 for satisfied packet");
  const parsed = JSON.parse(jsonRun.stdout);
  assert(parsed.fulfillment_status === "satisfied", "CLI JSON emits structured verdict");
  assert(parsed.evidence_links.length > 0, "CLI JSON includes evidence links");

  const textRun = runCli([], packet());
  assert(textRun.ok, "CLI text exits 0 for satisfied packet");
  assert(textRun.stdout.includes("IVE User Verdict"), "CLI text includes title");
  assert(textRun.stdout.includes("Counterargument / false-green risk:"), "CLI text includes false-green risk section");
  assert(textRun.stdout.includes("User decision required: no"), "CLI text includes user-decision status");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
