// @planner:module = lifecycle_reconciler_test
// @planner:capability = verifies_j9_lifecycle_reconciliation_acceptance

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLifecycleReconciliationReport,
  duplicateConfidence,
  lifecycleReconciliationSummary,
  renderLifecycleReconciliationStatusLine,
  renderLifecycleReconciliationText,
} from "../scripts/lib/lifecycle_reconciler.mjs";
import {
  LIFECYCLE_GIT_CANDIDATE_LIMIT,
  classifyLifecycleCommitEvidence,
  collectStagedCloseEvidence,
  collectTrustedLifecycleCommitEvidence,
  textReferencesTicketId,
  verifyLifecycleCommitEvidence,
} from "../scripts/lib/lifecycle_delivery_evidence.mjs";
import {
  validateAwaitingExternalAction,
  validateProgramPacket,
} from "../scripts/lib/program_packet.mjs";
import { buildProgramDisposition } from "../scripts/lib/program_disposition.mjs";
import { parseArgs } from "../scripts/lifecycle_reconciler.mjs";

const DISPOSITION_RECEIPT_PATH = "reports/ive/lifecycle_dispositions/lifecycle_disposition_2026-07-06_p1.json";

const DISPOSITIONED_SHIPPED_OPEN = new Set([
  "T-INTAKE-CC50C9B4",
  "T-INTAKE-DB2421D7",
  "T-INTAKE-E8A55E22",
  "T-INTAKE-354A6E77",
  "T-INTAKE-BBD475FD",
  "T-INTAKE-0C4E706A",
  "T-INTAKE-663B9F81",
]);

const EXPECTED_COMMITS = new Map([
  ["T-INTAKE-CC50C9B4", "0959607a"],
  ["T-INTAKE-354A6E77", "ef9c4d6d"],
  ["T-INTAKE-BBD475FD", "b494c0ce"],
  ["T-INTAKE-0C4E706A", "e129e12b"],
  ["T-INTAKE-663B9F81", "04f603bd"],
]);

function byTicket(findings) {
  return new Map(findings.map((finding) => [finding.ticket_id, finding]));
}

function childPlanIsClosed(ticket) {
  const planDir = ticket?.child_plan?.plan_dir;
  if (!planDir) return false;
  try {
    return ["close", "closed"].includes(
      String(JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"))?.state || "").toLowerCase(),
    );
  } catch {
    return false;
  }
}

function receiptByTicket(receipt) {
  return new Map((receipt?.shipped_open || []).map((entry) => [entry.ticket_id, entry]));
}

function assertLifecycleExemptionConformance(candidateReport, { cwd }) {
  const findings = candidateReport?.findings?.shipped_open || [];
  const exemptions = candidateReport?.exemptions?.awaiting_external_action || [];
  const candidateSummary = lifecycleReconciliationSummary(candidateReport);
  assert.equal(
    candidateSummary.shipped_open_findings,
    findings.length,
    "summary shipped-open count matches the authoritative report",
  );
  assert.equal(
    candidateSummary.awaiting_external_action_exemptions,
    exemptions.length,
    "summary exemption count matches the authoritative report",
  );
  assert.equal(
    findings.length,
    0,
    `unexplained shipped-open ticket(s): ${findings.map((finding) => finding.ticket_id).join(", ")}`,
  );

  for (const exemption of exemptions) {
    assert.equal(exemption.kind, "awaiting_external_action", `${exemption.ticket_id} uses the canonical exemption kind`);
    assert.equal(exemption.status, "active", `${exemption.ticket_id} exemption is active and unexpired`);
    assert(
      exemption.packet_path && !exemption.packet_path.startsWith("/") && !exemption.packet_path.split("/").includes(".."),
      `${exemption.ticket_id} links a safe repository-relative Program Packet`,
    );
    const packetPath = join(cwd, exemption.packet_path);
    assert(existsSync(packetPath), `${exemption.ticket_id} linked Program Packet exists`);
    const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
    const packetValidation = validateProgramPacket(packet, { cwd });
    assert.equal(
      packetValidation.ok,
      true,
      `${exemption.ticket_id} exemption is approved through a schema-valid canonical Program Packet: ${packetValidation.errors.map((entry) => entry.code).join(", ")}`,
    );
    assert.equal(packet.id, exemption.program_id, `${exemption.ticket_id} exemption links its canonical Program`);

    const ticket = (packet.tickets || []).find((entry) => entry.id === exemption.ticket_id);
    assert(ticket, `${exemption.ticket_id} exemption links a canonical Program ticket`);
    assert.equal(ticket.lifecycle, exemption.current_lifecycle, `${exemption.ticket_id} report lifecycle matches its ticket`);
    const awaiting = validateAwaitingExternalAction(ticket.awaiting_external_action, { lifecycle: ticket.lifecycle });
    assert.equal(
      awaiting.ok,
      true,
      `${exemption.ticket_id} has a schema-valid external-action contract: ${awaiting.errors.map((entry) => entry.code).join(", ")}`,
    );
    assert.equal(exemption.action_kind, awaiting.normalized.kind, `${exemption.ticket_id} action kind matches its contract`);
    assert.equal(exemption.reason, awaiting.normalized.reason, `${exemption.ticket_id} declares the awaited external action`);
    assert.equal(exemption.recorded_at, awaiting.normalized.recorded_at, `${exemption.ticket_id} preserves its approval timestamp`);
    assert.deepEqual(
      {
        type: exemption.expected_evidence?.type,
        root: exemption.expected_evidence?.root,
        match: exemption.expected_evidence?.match,
      },
      awaiting.normalized.expected_evidence,
      `${exemption.ticket_id} report names the exact awaited evidence contract`,
    );
    assert.equal(exemption.expected_evidence?.complete, true, `${exemption.ticket_id} evidence absence scan completed`);
    assert(Number.isInteger(exemption.expected_evidence?.files_scanned), `${exemption.ticket_id} evidence scan count is inspectable`);

    assert.equal(ticket.child_plan?.policy, "required", `${exemption.ticket_id} declares its required child plan`);
    assert(ticket.child_plan?.plan_dir, `${exemption.ticket_id} links its child plan directory`);
    const childStatePath = join(cwd, ticket.child_plan.plan_dir, "state.json");
    assert(existsSync(childStatePath), `${exemption.ticket_id} linked child-plan state exists`);
    const childState = JSON.parse(readFileSync(childStatePath, "utf-8"));
    assert.equal(String(childState.state || "").toUpperCase(), "CLOSE", `${exemption.ticket_id} linked child plan is closed`);

    assert.equal(exemption.suppressed_finding?.kind, "shipped_open_ticket", `${exemption.ticket_id} suppresses only the shipped-open finding`);
    assert.equal(exemption.suppressed_finding?.proposed_lifecycle, "closed", `${exemption.ticket_id} child evidence proposes closure`);
    assert(
      exemption.suppressed_finding?.evidence_kinds?.includes("declared_child_plan"),
      `${exemption.ticket_id} exemption is backed by declared child-plan evidence`,
    );
  }
}

const unavailableSummary = lifecycleReconciliationSummary(null);
assert.deepEqual(
  unavailableSummary,
  {
    status: "UNKNOWN",
    advisory_findings: 0,
    shipped_open_findings: 0,
    duplicate_scope_findings: 0,
    awaiting_external_action_exemptions: 0,
    staged_close_pending_commit: 0,
    repair_packet_path: null,
    repair_packet_written: false,
    dirty_worktree: false,
    warning_count: 0,
  },
  "unavailable lifecycle input degrades to an explicit zero-count UNKNOWN summary",
);
assert.equal(renderLifecycleReconciliationStatusLine(null), "", "unavailable lifecycle input does not fabricate a status line");
assert(
  renderLifecycleReconciliationText(null).includes("Repair packet: not available (not written)"),
  "unavailable lifecycle text renders an explicit missing-proof boundary",
);

const presentationReport = {
  status: "ADVISORY",
  counts: {
    advisory_findings: 9,
    shipped_open_findings: 9,
    duplicate_scope_findings: 0,
    awaiting_external_action_exemptions: 1,
    staged_close_pending_commit: 1,
  },
  warnings: [{ code: "dirty_worktree" }],
  repo_state: { dirty: true },
  repair_packet: { path: "reports/ive/lifecycle_reconciliation/presentation.json", written: true },
  findings: {
    shipped_open: Array.from({ length: 9 }, (_, index) => ({
      ticket_id: `T-PRESENT-${index + 1}`,
      current_lifecycle: "in_progress",
      proposed_lifecycle: "closed",
      ticket_title: `Presentation finding ${index + 1}`,
      evidence_chain: [{ kind: "declared_child_plan" }],
    })),
  },
  pending: {
    staged_close: [{
      ticket_id: "T-PRESENT-PENDING",
      current_lifecycle: "in_progress",
      ticket_title: "Presentation pending close",
      index_fingerprint: "fixture-index",
    }],
  },
  exemptions: {
    awaiting_external_action: [{
      ticket_id: "T-PRESENT-WAIT",
      current_lifecycle: "in_progress",
      action_kind: "operator_run",
      reason: "Presentation wait fixture",
    }],
  },
};
const presentationStatus = renderLifecycleReconciliationStatusLine(presentationReport);
const presentationText = renderLifecycleReconciliationText(presentationReport);
const fallbackStatus = renderLifecycleReconciliationStatusLine({
  advisory_findings: 1,
  shipped_open_findings: 1,
  duplicate_scope_findings: 0,
  awaiting_external_action_exemptions: 0,
  staged_close_pending_commit: 0,
  repair_packet_path: null,
  repair_packet_written: false,
  dirty_worktree: false,
});
assert(
  presentationStatus.includes("repair packet: reports/ive/lifecycle_reconciliation/presentation.json (written; dirty proof warning)"),
  "non-empty status line renders written and dirty-proof state deterministically",
);
assert(
  presentationText.includes("... 1 more shipped-open finding(s)")
    && presentationText.includes("T-PRESENT-PENDING")
    && presentationText.includes("T-PRESENT-WAIT")
    && presentationText.includes("Warning: dirty worktree"),
  "non-empty text rendering covers bounded overflow, pending-close, exemption, and dirty-warning rows",
);
assert(
  fallbackStatus.includes("repair packet: not available (not written)"),
  "non-empty summary-form status line renders the missing repair-packet fallback",
);

const duplicateConfidenceCases = [
  [{ sharedLabel: false, sharedTokens: [], unitKind: "ticket", titleScore: 1, batchLabelHit: false }, "low"],
  [{ sharedLabel: true, sharedTokens: [], unitKind: "ticket", titleScore: 0.1, batchLabelHit: false }, "low"],
  [{ sharedLabel: true, sharedTokens: ["one", "two", "three"], unitKind: "ticket", titleScore: 0.8, batchLabelHit: false }, "high"],
  [{ sharedLabel: true, sharedTokens: [], unitKind: "decision", titleScore: 0.1, batchLabelHit: false }, "low"],
  [{ sharedLabel: true, sharedTokens: ["one", "two"], unitKind: "decision", titleScore: 0.1, batchLabelHit: true }, "medium"],
  [{ sharedLabel: true, sharedTokens: ["one"], unitKind: "other", titleScore: 0.8, batchLabelHit: false }, "low"],
];
assert(
  duplicateConfidenceCases.every(([input, expected]) => duplicateConfidence(input) === expected),
  "duplicate confidence classifier covers low, medium, and high boolean combinations deterministically",
);

function externalWaitProgramPacket(awaitingExternalAction) {
  const ticket = {
    id: "T-EXTERNAL-WAIT",
    epic_id: "EP-EXTERNAL-WAIT",
    title: "Wait for a future operator receipt",
    type: "feature",
    lifecycle: "in_progress",
    story_refs: ["US-EXTERNAL-WAIT"],
    acceptance_criteria: ["AC-EXTERNAL-WAIT"],
    verification_refs: ["VER-EXTERNAL-WAIT"],
    child_plan: { policy: "required", plan_dir: "plans/plan_external_wait_closed" },
  };
  if (awaitingExternalAction !== undefined) ticket.awaiting_external_action = awaitingExternalAction;
  return {
    version: 1,
    id: "PGM-EXTERNAL-WAIT",
    remote_mode: "local-only",
    title: "External wait fixture",
    status: "executing",
    goal: "Prove schema-approved external-action lifecycle conformance.",
    story_refs: ["US-EXTERNAL-WAIT"],
    epics: [{
      id: "EP-EXTERNAL-WAIT",
      title: "External wait",
      story_refs: ["US-EXTERNAL-WAIT"],
      ticket_refs: ["T-EXTERNAL-WAIT"],
    }],
    tickets: [ticket],
    acceptance_criteria: [{
      id: "AC-EXTERNAL-WAIT",
      subject_ref: "T-EXTERNAL-WAIT",
      story_refs: ["US-EXTERNAL-WAIT"],
      text: "An open ticket with closed child evidence fails unless a canonical active external-action contract names absent evidence.",
    }],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [{
      id: "VER-EXTERNAL-WAIT",
      subject_ref: "T-EXTERNAL-WAIT",
      acceptance_criterion_ref: "AC-EXTERNAL-WAIT",
      proof_type: "integration",
      command_or_action: "Run lifecycle conformance A and B.",
      pass_means: "A fails and B passes.",
    }],
    decisions: [],
  };
}

function runFixtureGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, `fixture git ${args.join(" ")} succeeds: ${result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

{
  const deliveryFiles = ["src/delivery.mjs", "tests/delivery.test.mjs"];
  const suppliedUnrelatedFact = classifyLifecycleCommitEvidence({
    ticketId: "T-INTAKE-FCD4BE31",
    commit: "100c21c2b733b0c00379d11a5ed9fe25aba483cb",
    commitMessage: "chore: external action cleanup",
    commitFiles: [],
    deliveryFiles,
    reachable: true,
  });
  assert.equal(suppliedUnrelatedFact.trusted, false, "supplied 100c21c2 zero-overlap fact is never shipment proof");
  assert.equal(suppliedUnrelatedFact.reason, "no_trusted_linkage", "synthetic 100c21c2 control records the missing linkage boundary");

  const exactId = classifyLifecycleCommitEvidence({
    ticketId: "T-INTAKE-FCD4BE31",
    commitMessage: "fix: close T-INTAKE-FCD4BE31 after verification",
    commitFiles: [],
    deliveryFiles,
    reachable: true,
  });
  assert.equal(exactId.trusted, true, "exact ticket-ID commit message is trusted shipment proof");
  assert.equal(exactId.reason, "exact_ticket_id", "exact ticket-ID positive names its proof mode");

  assert.equal(
    textReferencesTicketId("fix: close T-INTAKE-FCD4BE310 after verification", "T-INTAKE-FCD4BE31"),
    false,
    "ticket-ID matching rejects longer prefix collisions",
  );
  const prefixCollision = classifyLifecycleCommitEvidence({
    ticketId: "T-INTAKE-FCD4BE31",
    commitMessage: "fix: close T-INTAKE-FCD4BE310 after verification",
    commitFiles: [],
    deliveryFiles,
    reachable: true,
  });
  assert.equal(prefixCollision.trusted, false, "a longer ticket ID cannot satisfy exact-ID shipment proof");

  const fullScope = classifyLifecycleCommitEvidence({
    ticketId: "T-INTAKE-FCD4BE31",
    commitMessage: "fix: lifecycle boundary",
    commitFiles: deliveryFiles,
    deliveryFiles,
    reachable: true,
  });
  assert.equal(fullScope.trusted, true, "one commit covering the complete delivery scope is trusted shipment proof");
  assert.equal(fullScope.reason, "full_delivery_scope", "full-scope positive names its proof mode");

  for (const [label, commitFiles] of [
    ["partial", [deliveryFiles[0]]],
    ["unrelated", ["src/unrelated.mjs"]],
    ["governance-only", ["plans/plan_fixture/state.json", "reports/ive/proof.json"]],
  ]) {
    const negative = classifyLifecycleCommitEvidence({
      ticketId: "T-INTAKE-FCD4BE31",
      commitMessage: "fix: external action lifecycle",
      commitFiles,
      deliveryFiles,
      reachable: true,
    });
    assert.equal(negative.trusted, false, `${label} commit cannot establish shipment`);
  }
}

const planAuthorityTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-plan-authority-"));
try {
  const declaredTicketId = "T-BARE-PLAN";
  const prefixTicketId = "T-PREFIX-1";
  const invalidDeclaredTicketId = "T-INVALID-DECLARED";
  const missingDeclaredTicketId = "T-MISSING-DECLARED";
  const nestedDeclaredTicketId = "T-NESTED-SUPPORTED";
  const abandonedDeclaredTicketId = "T-ABANDONED-DECLARED";
  const blockedClosedTicketId = "T-BLOCKED-CLOSED-SUCCESSOR";
  const blockedOpenTicketId = "T-BLOCKED-OPEN-SUCCESSOR";
  const planRel = "plans/plan_bare_declared";
  const planDir = join(planAuthorityTemp, planRel);
  const openPlanRel = "plans/plan_blocked_open_successor";
  const openPlanDir = join(planAuthorityTemp, openPlanRel);
  const programDir = join(planAuthorityTemp, "plans", "programs", "plan-authority");
  const invalidDeclaredDir = join(planAuthorityTemp, "plans", "nested", "plan_declared");
  const nestedDeclaredRel = "plans/programs/plan-authority/child_plans/nested_supported";
  const nestedDeclaredDir = join(planAuthorityTemp, nestedDeclaredRel);
  const abandonedDeclaredRel = "plans/plan_abandoned_declared";
  const abandonedDeclaredDir = join(planAuthorityTemp, abandonedDeclaredRel);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(openPlanDir, { recursive: true });
  mkdirSync(programDir, { recursive: true });
  mkdirSync(invalidDeclaredDir, { recursive: true });
  mkdirSync(nestedDeclaredDir, { recursive: true });
  mkdirSync(abandonedDeclaredDir, { recursive: true });
  mkdirSync(join(planAuthorityTemp, "src"), { recursive: true });
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: `T-PREFIX-10 ${invalidDeclaredTicketId} ${missingDeclaredTicketId} appear only in an unrelated top-level goal`,
  }, null, 2));
  writeFileSync(join(planDir, "scope.json"), JSON.stringify({
    declared_files: ["src/plan-authority.mjs"],
    owned_files: ["src/plan-authority.mjs"],
  }, null, 2));
  writeFileSync(join(openPlanDir, "state.json"), JSON.stringify({ state: "EXPLORE", goal: `${blockedOpenTicketId} authorized successor remains open` }, null, 2));
  writeFileSync(join(openPlanDir, "scope.json"), JSON.stringify({
    declared_files: ["src/plan-authority.mjs"],
    owned_files: ["src/plan-authority.mjs"],
  }, null, 2));
  writeFileSync(join(invalidDeclaredDir, "state.json"), JSON.stringify({ state: "CLOSE", goal: "Unsupported nested plan" }, null, 2));
  writeFileSync(join(invalidDeclaredDir, "scope.json"), JSON.stringify({ declared_files: ["src/plan-authority.mjs"] }, null, 2));
  writeFileSync(join(nestedDeclaredDir, "state.json"), JSON.stringify({ state: "CLOSE", goal: "Supported Program child plan" }, null, 2));
  writeFileSync(join(nestedDeclaredDir, "scope.json"), JSON.stringify({ declared_files: ["src/plan-authority.mjs"] }, null, 2));
  writeFileSync(join(abandonedDeclaredDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: `${abandonedDeclaredTicketId} abandoned child plan`,
    transitions: [{
      from: "EXECUTE",
      to: "CLOSE",
      gate_result: "SKIP",
      marker: "[ABANDONED]",
      is_forced: true,
    }],
  }, null, 2));
  writeFileSync(join(abandonedDeclaredDir, "scope.json"), JSON.stringify({ declared_files: ["src/plan-authority.mjs"] }, null, 2));
  writeFileSync(join(planAuthorityTemp, "src", "plan-authority.mjs"), "export const authority = true;\n");
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    id: "PGM-PLAN-AUTHORITY",
    title: "Plan authority fixture",
    tickets: [
      {
        id: declaredTicketId,
        title: "Bare declared child plan",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: "plan_bare_declared" },
      },
      {
        id: prefixTicketId,
        title: "Prefix collision must not match",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: null },
      },
      {
        id: invalidDeclaredTicketId,
        title: "Unsupported nonempty declaration must stay exclusive",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: "plans/nested/plan_declared" },
      },
      {
        id: missingDeclaredTicketId,
        title: "Missing nonempty declaration must stay exclusive",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: "plan_missing" },
      },
      {
        id: nestedDeclaredTicketId,
        title: "Supported nested Program child plan",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: nestedDeclaredRel },
      },
      {
        id: abandonedDeclaredTicketId,
        title: "Abandoned declared child plan",
        lifecycle: "in_progress",
        child_plan: { policy: "required", plan_dir: abandonedDeclaredRel },
      },
      {
        id: "T-UNKNOWN-LIFECYCLE",
        title: "Unknown actionable lifecycle remains inspectable",
        lifecycle: "queued",
      },
      {
        title: "Missing ticket id is ignored safely",
        lifecycle: "proposed",
      },
      {
        id: blockedClosedTicketId,
        title: "Blocked ticket with a completed declared successor",
        lifecycle: "blocked",
        child_plan: { policy: "required", plan_dir: planRel },
      },
      {
        id: blockedOpenTicketId,
        title: "Blocked ticket with an open declared successor",
        lifecycle: "blocked",
        child_plan: { policy: "required", plan_dir: openPlanRel },
      },
    ],
  }, null, 2));
  runFixtureGit(planAuthorityTemp, ["init"]);
  runFixtureGit(planAuthorityTemp, ["add", "."]);
  runFixtureGit(planAuthorityTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", `${declaredTicketId} ${invalidDeclaredTicketId} ${missingDeclaredTicketId} ${nestedDeclaredTicketId} ${abandonedDeclaredTicketId} ${blockedClosedTicketId} ${blockedOpenTicketId} plan authority fixture`]);

  const authorityReport = buildLifecycleReconciliationReport({ cwd: planAuthorityTemp, write: false });
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === declaredTicketId),
    true,
    "scanner canonicalizes a supported bare declared child-plan reference",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === prefixTicketId),
    false,
    "scanner plan discovery rejects a longer ticket-ID prefix in canonical state.goal",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === invalidDeclaredTicketId),
    false,
    "scanner never falls back when a nonempty declared plan path is unsupported",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === missingDeclaredTicketId),
    false,
    "scanner never falls back when a canonical nonempty declared plan is missing",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === nestedDeclaredTicketId),
    true,
    "scanner discovers and honors a supported nested Program child plan",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === abandonedDeclaredTicketId),
    false,
    "scanner does not treat a sanctioned abandoned child plan as shipment evidence",
  );
  assert.equal(
    authorityReport.findings.shipped_open.filter((entry) => entry.ticket_id === blockedClosedTicketId).length,
    1,
    "blocked ticket with a declared closed successor enters evidence-verified reconciliation exactly once",
  );
  assert.equal(
    authorityReport.findings.shipped_open.some((entry) => entry.ticket_id === blockedOpenTicketId),
    false,
    "blocked ticket with a declared open successor remains ineligible and cannot fall back",
  );
  assert(
    authorityReport.warnings.some((entry) => entry.code === "canonical_declared_plan_path_invalid"),
    "scanner surfaces unsupported nonempty declared plan paths",
  );
  assert(
    authorityReport.warnings.some((entry) => entry.code === "canonical_declared_plan_missing"),
    "scanner surfaces missing canonical declared plan records",
  );
} finally {
  rmSync(planAuthorityTemp, { recursive: true, force: true });
}

const stagedLifecycleTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-staged-close-"));
try {
  const ticketId = "T-STAGED-CLOSE";
  const planRel = "plans/plan_staged_close";
  const planDir = join(stagedLifecycleTemp, planRel);
  const programDir = join(stagedLifecycleTemp, "plans", "programs", "staged-close");
  const deliveryFiles = ["src/delivery.mjs", "tests/delivery.test.mjs"];
  mkdirSync(planDir, { recursive: true });
  mkdirSync(programDir, { recursive: true });
  mkdirSync(join(stagedLifecycleTemp, "src"), { recursive: true });
  mkdirSync(join(stagedLifecycleTemp, "tests"), { recursive: true });
  writeFileSync(join(planDir, "scope.json"), JSON.stringify({
    version: 1,
    declared_files: [...deliveryFiles, `${planRel}/state.json`, "reports/ive/proof.json"],
    owned_files: [...deliveryFiles, `${planRel}/state.json`, "reports/ive/proof.json"],
  }, null, 2));
  writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "EXECUTE", goal: `${ticketId} staged close fixture` }, null, 2));
  writeFileSync(join(stagedLifecycleTemp, deliveryFiles[0]), "export const delivery = 'before';\n");
  writeFileSync(join(stagedLifecycleTemp, deliveryFiles[1]), "export const expected = 'before';\n");
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    id: "PGM-STAGED-CLOSE",
    title: "Staged close fixture",
    tickets: [{
      id: ticketId,
      title: "Exercise staged close proof order",
      lifecycle: "in_progress",
      child_plan: { policy: "required", plan_dir: planRel },
    }],
  }, null, 2));
  runFixtureGit(stagedLifecycleTemp, ["init"]);
  runFixtureGit(stagedLifecycleTemp, ["add", "."]);
  runFixtureGit(stagedLifecycleTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "seed staged lifecycle fixture"]);

  writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "CLOSE", goal: `${ticketId} staged close fixture` }, null, 2));
  writeFileSync(join(stagedLifecycleTemp, deliveryFiles[0]), "export const delivery = 'after';\n");
  writeFileSync(join(stagedLifecycleTemp, deliveryFiles[1]), "export const expected = 'after';\n");
  const unproven = buildLifecycleReconciliationReport({ cwd: stagedLifecycleTemp, write: false });
  assert.equal(unproven.findings.shipped_open.length, 0, "closed worktree without trusted Git or index evidence is not shipped-open");
  assert.equal(unproven.pending.staged_close.length, 0, "unstaged worktree close is not staged-pending evidence");

  runFixtureGit(stagedLifecycleTemp, ["add", `${planRel}/state.json`, deliveryFiles[0]]);
  const partial = buildLifecycleReconciliationReport({ cwd: stagedLifecycleTemp, write: false });
  assert.equal(partial.findings.shipped_open.length, 0, "partial staging remains unshipped");
  assert.equal(partial.pending.staged_close.length, 0, "partial staging cannot create staged-pending evidence");

  runFixtureGit(stagedLifecycleTemp, ["add", deliveryFiles[1]]);
  const staged = buildLifecycleReconciliationReport({ cwd: stagedLifecycleTemp, write: false });
  assert.equal(staged.findings.shipped_open.length, 0, "complete staged close is not mislabeled shipped-open");
  assert.equal(staged.pending.staged_close.length, 1, "complete indexed close and delivery scope create one staged-pending record");
  const stagedEvidence = collectStagedCloseEvidence({ cwd: stagedLifecycleTemp, ticketId, planDir: planRel });
  assert.equal(stagedEvidence.qualified, true, "direct staged-close verifier accepts the complete index state");
  const fingerprint = stagedEvidence.index_fingerprint;

  writeFileSync(join(stagedLifecycleTemp, deliveryFiles[0]), "export const delivery = 'later-worktree-only';\n");
  const afterWorktreeMutation = collectStagedCloseEvidence({ cwd: stagedLifecycleTemp, ticketId, planDir: planRel });
  assert.equal(afterWorktreeMutation.index_fingerprint, fingerprint, "later worktree mutation cannot change indexed staged-close proof");

  runFixtureGit(stagedLifecycleTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "fix: ship staged lifecycle fixture"]);
  const committedHash = runFixtureGit(stagedLifecycleTemp, ["rev-parse", "HEAD"]);
  const fileScopeShipment = verifyLifecycleCommitEvidence({
    cwd: stagedLifecycleTemp,
    ticketId: "T-FILE-SCOPE-NO-MESSAGE-MATCH",
    commit: committedHash,
    deliveryFiles,
    planDir: planRel,
  });
  assert.equal(fileScopeShipment.trusted, true, "real commit with complete delivery scope and committed CLOSE state is trusted without an ID message match");
  assert.equal(fileScopeShipment.reason, "full_delivery_scope", "real full-scope shipment records its independent proof mode");
  const shipped = buildLifecycleReconciliationReport({ cwd: stagedLifecycleTemp, write: false });
  assert.equal(shipped.pending.staged_close.length, 0, "committed shipment no longer reports staged-pending evidence");
  assert.equal(shipped.findings.shipped_open.length, 1, "HEAD-reachable full-scope commit restores genuine shipped-open detection");
  assert.equal(shipped.findings.shipped_open[0].evidence_chain.some((entry) => entry.kind === "git_commit" && entry.detail === "full_delivery_scope"), true, "scanner report carries verified no-ID full-scope linkage");
  const shippedWithoutStamps = buildLifecycleReconciliationReport({
    cwd: stagedLifecycleTemp,
    includeStampedArtifacts: false,
    write: false,
  });
  assert.equal(shippedWithoutStamps.findings.shipped_open.length, 1, "explicit stamped-artifact opt-out preserves trusted commit reconciliation");

  writeFileSync(join(planDir, "scope.json"), JSON.stringify({
    version: 1,
    declared_files: [...deliveryFiles, "src/later-scope.mjs", `${planRel}/state.json`],
    owned_files: [...deliveryFiles, "src/later-scope.mjs", `${planRel}/state.json`],
  }, null, 2));
  writeFileSync(join(stagedLifecycleTemp, "src", "later-scope.mjs"), "export const later = true;\n");
  const launderedScope = buildLifecycleReconciliationReport({ cwd: stagedLifecycleTemp, write: false });
  assert.equal(launderedScope.findings.shipped_open.length, 0, "a later-expanded worktree scope cannot launder an older commit into full-scope proof");
} finally {
  rmSync(stagedLifecycleTemp, { recursive: true, force: true });
}

const stagedDeletionTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-staged-deletion-"));
try {
  const ticketId = "T-STAGED-DELETION";
  const planRel = "plans/plan_staged_deletion";
  const planDir = join(stagedDeletionTemp, planRel);
  const deliveryFiles = ["src/kept.mjs", "src/removed.mjs"];
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(stagedDeletionTemp, "src"), { recursive: true });
  writeFileSync(join(planDir, "scope.json"), JSON.stringify({ declared_files: deliveryFiles, owned_files: deliveryFiles }, null, 2));
  writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "EXECUTE", goal: `${ticketId} fixture` }, null, 2));
  writeFileSync(join(stagedDeletionTemp, deliveryFiles[0]), "export const kept = 'before';\n");
  writeFileSync(join(stagedDeletionTemp, deliveryFiles[1]), "export const removed = true;\n");
  runFixtureGit(stagedDeletionTemp, ["init"]);
  runFixtureGit(stagedDeletionTemp, ["add", "."]);
  runFixtureGit(stagedDeletionTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "seed deletion fixture"]);

  writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "CLOSE", goal: `${ticketId} fixture` }, null, 2));
  writeFileSync(join(stagedDeletionTemp, deliveryFiles[0]), "export const kept = 'after';\n");
  rmSync(join(stagedDeletionTemp, deliveryFiles[1]));
  runFixtureGit(stagedDeletionTemp, ["add", "-A"]);
  const deletion = collectStagedCloseEvidence({ cwd: stagedDeletionTemp, ticketId, planDir: planRel });
  assert.equal(deletion.qualified, true, "complete staged close supports an intentional indexed delivery-file deletion");
  assert.deepEqual(deletion.deleted_delivery_files, [deliveryFiles[1]], "staged deletion evidence names the deleted delivery path");
  assert(deletion.deletion_entries.includes(`deleted\t${deliveryFiles[1]}`), "index fingerprint input includes an explicit deletion marker");
  assert.equal(deletion.dispositionable, false, "staged deletion remains pending commit and cannot close lifecycle");
} finally {
  rmSync(stagedDeletionTemp, { recursive: true, force: true });
}

{
  const planRel = "plans/plan_unmerged_index";
  const scopePath = `${planRel}/scope.json`;
  const statePath = `${planRel}/state.json`;
  const deliveryPath = "src/conflicted.mjs";
  const gitRunner = (_cwd, args) => {
    const key = args.join(" ");
    if (key === `show :${scopePath}`) return { status: 0, stdout: JSON.stringify({ declared_files: [deliveryPath] }), stderr: "" };
    if (key === `show :${statePath}`) return { status: 0, stdout: JSON.stringify({ state: "CLOSE" }), stderr: "" };
    if (key.includes("--diff-filter=ACMRTUXBD")) return { status: 0, stdout: `${scopePath}\n${statePath}\n${deliveryPath}\n`, stderr: "" };
    if (key.includes("--diff-filter=D")) return { status: 0, stdout: "", stderr: "" };
    if (key.startsWith("ls-files --stage")) return {
      status: 0,
      stdout: [
        `100644 ${"a".repeat(40)} 0\t${scopePath}`,
        `100644 ${"b".repeat(40)} 0\t${statePath}`,
        `100644 ${"c".repeat(40)} 2\t${deliveryPath}`,
        `100644 ${"d".repeat(40)} 3\t${deliveryPath}`,
      ].join("\n"),
      stderr: "",
    };
    if (key === "rev-parse --verify HEAD") return { status: 0, stdout: `${"e".repeat(40)}\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected fixture command: ${key}` };
  };
  const conflict = collectStagedCloseEvidence({
    cwd: process.cwd(),
    ticketId: "T-UNMERGED-INDEX",
    planDir: planRel,
    gitRunner,
  });
  assert.equal(conflict.qualified, false, "an unmerged index can never qualify as staged-close evidence");
  assert.equal(conflict.reason, "index_contains_unmerged_entries", "unmerged rejection names the exact index failure");
  assert.deepEqual(conflict.conflicting_index_paths, [deliveryPath], "unmerged rejection identifies the conflicted proof path");
  assert(conflict.diagnostics.includes("index_contains_unmerged_entries"), "unmerged index failure is surfaced as a diagnostic");
}

{
  const planRel = "plans/plan_malformed_scope";
  const scopePath = `${planRel}/scope.json`;
  const statePath = `${planRel}/state.json`;
  const gitRunner = (_cwd, args) => {
    const key = args.join(" ");
    if (key === `show :${scopePath}`) return { status: 0, stdout: "{ malformed", stderr: "" };
    if (key === `show :${statePath}`) return { status: 0, stdout: JSON.stringify({ state: "CLOSE" }), stderr: "" };
    if (key.startsWith("diff --cached")) return { status: 0, stdout: `${scopePath}\n${statePath}\n`, stderr: "" };
    if (key.startsWith("ls-files --stage")) return {
      status: 0,
      stdout: `100644 ${"a".repeat(40)} 0\t${scopePath}\n100644 ${"b".repeat(40)} 0\t${statePath}\n`,
      stderr: "",
    };
    if (key === "rev-parse --verify HEAD") return { status: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected fixture command: ${key}` };
  };
  const malformed = collectStagedCloseEvidence({
    cwd: process.cwd(),
    ticketId: "T-MALFORMED-SCOPE",
    planDir: planRel,
    gitRunner,
  });
  assert.equal(malformed.qualified, false, "malformed indexed scope fails closed");
  assert(malformed.diagnostics.includes("index_scope_json_invalid"), "malformed indexed scope emits an inspectable diagnostic");
}

{
  const hash = "a".repeat(40);
  const ancestryFailure = verifyLifecycleCommitEvidence({
    cwd: process.cwd(),
    ticketId: "T-ANCESTRY-FAILURE",
    commit: hash,
    deliveryFiles: ["src/delivery.mjs"],
    planDir: "plans/plan_ancestry_failure",
    gitRunner: (_cwd, args) => {
      if (args[0] === "rev-parse") return { status: 0, stdout: `${hash}\n`, stderr: "" };
      if (args[0] === "merge-base") return { status: null, signal: "SIGTERM", stdout: "", stderr: "timed out" };
      return { status: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    },
  });
  assert.equal(ancestryFailure.trusted, false, "an abnormal ancestry probe fails closed");
  assert.equal(ancestryFailure.reason, "git_commit_ancestry_check_failed", "ancestry infrastructure failure is distinct from ordinary non-ancestry");
  assert(ancestryFailure.diagnostics.includes("git_commit_ancestry_check_failed"), "ancestry infrastructure failure emits a structured diagnostic");

  const ordinaryNonAncestor = verifyLifecycleCommitEvidence({
    cwd: process.cwd(),
    ticketId: "T-ORDINARY-NON-ANCESTOR",
    commit: hash,
    deliveryFiles: [],
    planDir: "plans/plan_ordinary_non_ancestor",
    gitRunner: (_cwd, args) => {
      if (args[0] === "rev-parse") return { status: 0, stdout: `${hash}\n`, stderr: "" };
      if (args[0] === "merge-base") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "show" && args[1] === "-s") return { status: 0, stdout: "unrelated commit\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "path does not exist in candidate" };
    },
  });
  assert.equal(ordinaryNonAncestor.reason, "commit_not_head_reachable", "normal merge-base exit 1 remains an ordinary negative");
  assert(!ordinaryNonAncestor.diagnostics.includes("git_commit_ancestry_check_failed"), "ordinary non-ancestry does not emit an infrastructure diagnostic");
}

{
  let gitCalls = 0;
  const hashes = Array.from({ length: LIFECYCLE_GIT_CANDIDATE_LIMIT + 1 }, (_, index) =>
    index.toString(16).padStart(40, "0")
  );
  const gitRunner = (_cwd, args) => {
    gitCalls += 1;
    if (args[0] === "log") return { status: 0, stdout: `${hashes.join("\n")}\n`, stderr: "" };
    if (args[0] === "show" && args[1] === "-s") return { status: 0, stdout: "fix: unrelated candidate\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "path does not exist in candidate" };
  };
  const bounded = collectTrustedLifecycleCommitEvidence({
    cwd: process.cwd(),
    ticketId: "T-CANDIDATE-BUDGET",
    deliveryFiles: [],
    planDir: "plans/plan_candidate_budget",
    limit: 500,
    gitRunner,
  });
  assert.equal(bounded.candidate_limit, LIFECYCLE_GIT_CANDIDATE_LIMIT, "candidate scan enforces the global per-ticket ceiling");
  assert.equal(bounded.candidates_checked, LIFECYCLE_GIT_CANDIDATE_LIMIT, "candidate scan checks no more than its declared budget");
  assert(bounded.warnings.includes("git_candidate_budget_exhausted"), "candidate truncation emits an inspectable exhaustion warning");
  assert.equal(gitCalls, (LIFECYCLE_GIT_CANDIDATE_LIMIT * 2) + 1, "empty-scope exact-ID scan stays at one log plus two bounded probes per candidate");
}

{
  let gitCalls = 0;
  const deliveryPath = "src/full-scope-budget.mjs";
  const planRel = "plans/plan_full_scope_budget";
  const hashes = Array.from({ length: LIFECYCLE_GIT_CANDIDATE_LIMIT + 1 }, (_, index) =>
    (index + 100).toString(16).padStart(40, "0")
  );
  const gitRunner = (_cwd, args) => {
    gitCalls += 1;
    if (args[0] === "log") return { status: 0, stdout: `${hashes.join("\n")}\n`, stderr: "" };
    if (args[0] === "show" && args[1] === "-s") return { status: 0, stdout: "fix: unrelated full-scope candidate\n", stderr: "" };
    if (args[0] === "show" && String(args[1]).endsWith(`:${planRel}/scope.json`)) {
      return { status: 0, stdout: JSON.stringify({ declared_files: [deliveryPath] }), stderr: "" };
    }
    if (args[0] === "diff-tree") return { status: 0, stdout: "src/unrelated.mjs\n", stderr: "" };
    if (args[0] === "show" && String(args[1]).endsWith(`:${planRel}/state.json`)) {
      return { status: 0, stdout: JSON.stringify({ state: "CLOSE" }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected fixture command: ${args.join(" ")}` };
  };
  const bounded = collectTrustedLifecycleCommitEvidence({
    cwd: process.cwd(),
    ticketId: "T-FULL-SCOPE-CANDIDATE-BUDGET",
    deliveryFiles: [deliveryPath],
    planDir: planRel,
    limit: 500,
    gitRunner,
  });
  assert.equal(bounded.evidence.length, 0, "full-scope worst path does not fabricate a trusted commit");
  assert.equal(bounded.candidates_checked, LIFECYCLE_GIT_CANDIDATE_LIMIT, "full-scope scan honors the same aggregate candidate ceiling");
  assert(bounded.warnings.includes("git_candidate_budget_exhausted"), "full-scope saturation emits the shared exhaustion warning");
  assert.equal(gitCalls, (LIFECYCLE_GIT_CANDIDATE_LIMIT * 4) + 2, "aggregate worst path is two logs plus four bounded probes per candidate");
}

const report = buildLifecycleReconciliationReport({
  write: false,
});

const shippedByTicket = byTicket(report.findings.shipped_open);
const canonicalProgramPacket = JSON.parse(readFileSync("plans/programs/ive-trust-repair/program_packet.json", "utf-8"));
const convergenceProgramPacket = JSON.parse(readFileSync("plans/programs/ive-consolidation-rectification/program_packet.json", "utf-8"));
const expectedShippedOpen = [
  ["T-INTAKE-CF4AC8A5", "blocked"],
  ["T-INTAKE-D6AE86C9", "blocked"],
  ["T-INTAKE-56F58BA6", "in_progress"],
].filter(([ticketId, lifecycle]) => {
  const ticket = (canonicalProgramPacket.tickets || []).find((candidate) => candidate.id === ticketId);
  return ticket?.lifecycle === lifecycle
    && (ticketId !== "T-INTAKE-56F58BA6" || childPlanIsClosed(ticket));
}).map(([ticketId]) => ticketId);
const convergenceTicket = (convergenceProgramPacket.tickets || [])
  .find((ticket) => ticket.id === "T-INTAKE-A7B1851A");
if (convergenceTicket?.lifecycle === "in_progress" && childPlanIsClosed(convergenceTicket)) {
  expectedShippedOpen.push(convergenceTicket.id);
}
assert.deepEqual(
  [...shippedByTicket.keys()].sort(),
  expectedShippedOpen.sort(),
  "lifecycle reconciliation reports every canonical shipped/open ticket awaiting evidence-gated disposition",
);
const awaitingByTicket = byTicket(report.exemptions.awaiting_external_action);
assert(!awaitingByTicket.has("T-INTAKE-10643BA2"), "L3 ticket exemption expired after the green receipt closed it (2026-07-12)");
{
  const l3Ticket = (canonicalProgramPacket.tickets || []).find((ticket) => ticket.id === "T-INTAKE-10643BA2");
  assert.equal(l3Ticket?.lifecycle, "closed", "L3 ticket closed via evidence-verified disposition");
  assert(!l3Ticket?.awaiting_external_action, "expired awaiting_external_action is removed from the closed ticket");
  assert(
    String(l3Ticket?.awaiting_external_action_resolved?.resolving_evidence || "").includes("autonomous_dogfood_runs/2026-07-12/"),
    "archived exemption records the resolving green receipt",
  );
}

assert(existsSync(DISPOSITION_RECEIPT_PATH), "post-disposition receipt exists");
const dispositionReceipt = JSON.parse(readFileSync(DISPOSITION_RECEIPT_PATH, "utf-8"));
assert.equal(dispositionReceipt.status, "PASS", "post-disposition receipt passed");
const receiptTickets = receiptByTicket(dispositionReceipt);
for (const ticketId of DISPOSITIONED_SHIPPED_OPEN) {
  assert(!shippedByTicket.has(ticketId), `${ticketId} is no longer reported as shipped-open`);
  const receiptEntry = receiptTickets.get(ticketId);
  assert(receiptEntry, `${ticketId} has disposition receipt entry`);
  assert(
    ["applied_closed", "already_closed"].includes(receiptEntry.action),
    `${ticketId} receipt records closed disposition`,
  );
  assert.equal(
    receiptEntry.verification?.status,
    "pass",
    `${ticketId} receipt carries passing evidence verification`,
  );
}

for (const [ticketId, commit] of EXPECTED_COMMITS) {
  const receiptEntry = receiptTickets.get(ticketId);
  assert(
    (receiptEntry?.verification?.commit_checks || []).some((entry) =>
      String(entry.short_commit || entry.commit || "").startsWith(commit) ||
      String(entry.commit || "").startsWith(commit)),
    `${ticketId} includes supporting commit ${commit}`,
  );
}

assert(!shippedByTicket.has("T-INTAKE-2707D982"), "J6 negative control is not reported as shipped-open");

for (const ticketId of ["T-INTAKE-DB2421D7", "T-INTAKE-E8A55E22"]) {
  assert(
    dispositionReceipt.duplicate_scope.some((finding) =>
      finding.ticket_id === ticketId
      && finding.classification === "fold_into_existing_ticket"
      && finding.matched_scope?.program_id === "PGM-IVE-CONSOLIDATION-RECTIFICATION"),
    `${ticketId} has receipt-backed consolidation duplicate-scope disposition`,
  );
}

const summary = lifecycleReconciliationSummary(report);
assert.equal(summary.shipped_open_findings, expectedShippedOpen.length, "summary carries only the expected pending Item 4 and parked J16 findings");
assert.equal(summary.duplicate_scope_findings, 0, "active E4 delivery clears its former duplicate-scope advisory");
const renderedReport = renderLifecycleReconciliationText(report);
assert.match(renderedReport, /^Lifecycle reconciliation: ADVISORY$/m, "text report identifies the advisory reconciliation surface");
assert.match(
  renderedReport,
  new RegExp(`^Findings: ${expectedShippedOpen.length} \\(${expectedShippedOpen.length} shipped-open, 0 duplicate-scope\\)$`, "m"),
  "text report renders canonical finding counts",
);
const exemptionConformanceReport = JSON.parse(JSON.stringify(report));
exemptionConformanceReport.findings.shipped_open = exemptionConformanceReport.findings.shipped_open.filter((finding) =>
  !expectedShippedOpen.includes(finding.ticket_id)
);
exemptionConformanceReport.counts.shipped_open_findings = exemptionConformanceReport.findings.shipped_open.length;
exemptionConformanceReport.counts.advisory_findings = exemptionConformanceReport.findings.shipped_open.length
  + exemptionConformanceReport.findings.duplicate_scope.length;
assertLifecycleExemptionConformance(exemptionConformanceReport, { cwd: process.cwd() });
assert(
  !report.findings.duplicate_scope.some((finding) => finding.ticket_id === "T-INTAKE-D0585FC9"),
  "active E4 ticket is no longer reported as duplicate-scope backlog",
);
if (summary.advisory_findings === 0 && summary.awaiting_external_action_exemptions === 0 && summary.staged_close_pending_commit === 0) {
  assert.equal(renderLifecycleReconciliationStatusLine(summary), "", "clean reconciliation status line stays silent when no findings or exemptions exist");
} else {
  const statusLine = renderLifecycleReconciliationStatusLine(summary);
  if (summary.shipped_open_findings > 0) {
    assert.match(
      statusLine,
      new RegExp(`${summary.shipped_open_findings} shipped-open`),
      "pending shipped-open findings remain visible in the reconciliation status line",
    );
  }
  if (summary.awaiting_external_action_exemptions > 0) {
    assert.match(
      statusLine,
      new RegExp(`${summary.awaiting_external_action_exemptions} awaiting-external-action exemption\\(s\\)`),
      "active schema-approved exemptions remain visible in the reconciliation status line",
    );
  }
  if (summary.staged_close_pending_commit > 0) {
    assert.match(
      statusLine,
      new RegExp(`${summary.staged_close_pending_commit} staged-close pending-commit record\\(s\\)`),
      "authorized staged-close pending-commit evidence remains visible without claiming shipment",
    );
  }
}

const dirtyTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-dirty-"));
try {
  const init = spawnSync("git", ["init"], { cwd: dirtyTemp, encoding: "utf-8" });
  assert.equal(init.status, 0, "dirty-worktree fixture initializes git repository");
  writeFileSync(join(dirtyTemp, "dirty.txt"), "dirty\n");
  const dirtyReport = buildLifecycleReconciliationReport({
    cwd: dirtyTemp,
    write: false,
  });
  assert.equal(dirtyReport.repo_state.dirty, true, "dirty fixture reports dirty repo state");
  assert(
    dirtyReport.warnings.some((warning) => warning.code === "dirty_worktree"),
    "dirty worktree is reported as advisory proof context",
  );
} finally {
  rmSync(dirtyTemp, { recursive: true, force: true });
}

const gitFailureTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-git-failure-"));
try {
  const planRel = "plans/plan_git_failure";
  const planDir = join(gitFailureTemp, planRel);
  const programDir = join(gitFailureTemp, "plans", "programs", "git-failure");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(programDir, { recursive: true });
  writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "CLOSE", goal: "T-GIT-FAILURE fixture" }, null, 2));
  writeFileSync(join(planDir, "scope.json"), "{ malformed scope\n");
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    id: "PGM-GIT-FAILURE",
    title: "Git failure fixture",
    tickets: [{
      id: "T-GIT-FAILURE",
      title: "Surface Git diagnostics",
      lifecycle: "in_progress",
      child_plan: { policy: "required", plan_dir: planRel },
    }],
  }, null, 2));
  const gitFailureReport = buildLifecycleReconciliationReport({ cwd: gitFailureTemp, write: false });
  assert.equal(gitFailureReport.findings.shipped_open.length, 0, "Git command failure never becomes shipment evidence");
  assert(
    gitFailureReport.warnings.some((warning) => warning.code === "git_exact_id_log_failed"),
    "Git log execution failure is surfaced in the reconciliation report",
  );
  assert(
    gitFailureReport.warnings.some((warning) => warning.code === "git_indexed_scope_read_failed"),
    "indexed scope read failure is surfaced in the reconciliation report",
  );
  assert(
    gitFailureReport.warnings.some((warning) => warning.code === "worktree_scope_json_invalid"),
    "malformed canonical worktree scope is surfaced in the reconciliation report",
  );
} finally {
  rmSync(gitFailureTemp, { recursive: true, force: true });
}

const externalWaitTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-external-wait-"));
try {
  const programDir = join(externalWaitTemp, "plans", "programs", "external-wait");
  const planDir = join(externalWaitTemp, "plans", "plan_external_wait_closed");
  const receiptDir = join(externalWaitTemp, "reports", "ive", "autonomous_dogfood_runs");
  mkdirSync(programDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: "T-EXTERNAL-WAIT harness repair is complete",
  }, null, 2));
  const externalAction = {
    kind: "operator_run",
    reason: "Operator must run the credentialed lane and supply the declared receipt.",
    expected_evidence: {
      type: "json_match",
      root: "reports/ive/autonomous_dogfood_runs",
      match: { schema_version: "ive.autonomous_dogfood_run.v1", outcome: "PASS" },
    },
    recorded_at: "2026-07-11T14:00:00.000Z",
  };
  const packetPath = join(programDir, "program_packet.json");

  // Reproduction A: a closed child plus open ticket has no unexplained exemption and fails loudly.
  writeFileSync(packetPath, JSON.stringify(externalWaitProgramPacket(undefined), null, 2));
  runFixtureGit(externalWaitTemp, ["init"]);
  runFixtureGit(externalWaitTemp, ["add", "."]);
  runFixtureGit(externalWaitTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "T-EXTERNAL-WAIT shipped fixture"]);
  const unexplained = buildLifecycleReconciliationReport({ cwd: externalWaitTemp, write: false });
  assert.equal(unexplained.findings.shipped_open.length, 1, "Reproduction A emits one shipped-open finding");
  assert.throws(
    () => assertLifecycleExemptionConformance(unexplained, { cwd: externalWaitTemp }),
    /T-EXTERNAL-WAIT/,
    "Reproduction A fails conformance and names its unexplained ticket",
  );

  // Reproduction B: the same ticket passes only with a canonical, schema-valid, evidence-bound wait.
  writeFileSync(packetPath, JSON.stringify(externalWaitProgramPacket(externalAction), null, 2));

  const absent = buildLifecycleReconciliationReport({ cwd: externalWaitTemp, write: false });
  assert.equal(absent.findings.shipped_open.length, 0, "absent expected receipt suppresses the otherwise shipped-open finding");
  assert.equal(absent.exemptions.awaiting_external_action.length, 1, "absent expected receipt records an explicit active exemption");
  assert.equal(absent.exemptions.awaiting_external_action[0].expected_evidence.warning, "root_missing", "missing evidence root remains inspectable");
  assert.doesNotThrow(
    () => assertLifecycleExemptionConformance(absent, { cwd: externalWaitTemp }),
    "Reproduction B passes the complete exemption-quality predicate",
  );

  const orphaned = JSON.parse(JSON.stringify(absent));
  orphaned.exemptions.awaiting_external_action[0].ticket_id = "T-ORPHANED-WAIT";
  assert.throws(
    () => assertLifecycleExemptionConformance(orphaned, { cwd: externalWaitTemp }),
    /T-ORPHANED-WAIT.*canonical Program ticket/,
    "an unlinked report exemption fails conformance loudly",
  );

  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "EXECUTE",
    goal: "T-EXTERNAL-WAIT harness repair is not closed",
  }, null, 2));
  assert.throws(
    () => assertLifecycleExemptionConformance(absent, { cwd: externalWaitTemp }),
    /linked child plan is closed/,
    "a report exemption cannot outlive its closed-child linkage",
  );
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: "T-EXTERNAL-WAIT harness repair is complete",
  }, null, 2));

  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, "green.json"), JSON.stringify({
    schema_version: "ive.autonomous_dogfood_run.v1",
    outcome: "PASS",
    ok: true,
  }, null, 2));
  const present = buildLifecycleReconciliationReport({ cwd: externalWaitTemp, write: false });
  assert.equal(present.exemptions.awaiting_external_action.length, 0, "matching expected receipt expires the exemption immediately");
  const expiredFinding = present.findings.shipped_open.find((finding) => finding.ticket_id === "T-EXTERNAL-WAIT");
  assert(expiredFinding, "expired exemption restores the shipped-open finding");
  assert.equal(expiredFinding.awaiting_external_action?.status, "expired", "restored finding records why the exemption expired");
  assert(expiredFinding.evidence_chain.some((entry) => entry.kind === "expected_external_evidence" && entry.path.endsWith("green.json")), "restored finding links the matching receipt");
  assert.throws(
    () => assertLifecycleExemptionConformance(present, { cwd: externalWaitTemp }),
    /T-EXTERNAL-WAIT/,
    "an expired exemption restores loud conformance failure",
  );

  const malformedAction = { ...externalAction, unexpected_approval: true };
  writeFileSync(packetPath, JSON.stringify(externalWaitProgramPacket(malformedAction), null, 2));
  rmSync(receiptDir, { recursive: true, force: true });
  const malformed = buildLifecycleReconciliationReport({ cwd: externalWaitTemp, write: false });
  assert.equal(malformed.exemptions.awaiting_external_action.length, 0, "malformed contract never receives an exemption");
  assert.throws(
    () => assertLifecycleExemptionConformance(malformed, { cwd: externalWaitTemp }),
    /T-EXTERNAL-WAIT/,
    "a malformed external-action contract remains shipped-open",
  );

  writeFileSync(packetPath, JSON.stringify(externalWaitProgramPacket(externalAction), null, 2));

  mkdirSync(receiptDir, { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    writeFileSync(join(receiptDir, `${String(index).padStart(4, "0")}.json`), JSON.stringify({ outcome: "FAIL" }));
  }
  writeFileSync(join(receiptDir, "zzzz-green.json"), JSON.stringify({
    schema_version: "ive.autonomous_dogfood_run.v1",
    outcome: "PASS",
  }));
  const saturated = buildLifecycleReconciliationReport({ cwd: externalWaitTemp, write: false });
  assert.equal(saturated.exemptions.awaiting_external_action.length, 0, "scan-limit saturation never grants an absence exemption");
  const saturatedFinding = saturated.findings.shipped_open.find((finding) => finding.ticket_id === "T-EXTERNAL-WAIT");
  assert.equal(saturatedFinding?.awaiting_external_action?.status, "indeterminate", "incomplete evidence scan fails closed with inspectable status");
  assert(saturatedFinding?.evidence_chain.some((entry) => entry.kind === "expected_external_evidence_scan" && entry.status === "incomplete"), "scan-limit failure is present in the shipped-open evidence chain");
  assert.throws(
    () => assertLifecycleExemptionConformance(saturated, { cwd: externalWaitTemp }),
    /T-EXTERNAL-WAIT/,
    "an incomplete evidence scan remains a loud conformance failure",
  );
} finally {
  rmSync(externalWaitTemp, { recursive: true, force: true });
}

const authorizedRetryTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-authorized-retry-"));
try {
  const programDir = join(authorizedRetryTemp, "plans", "programs", "authorized-retry");
  const oldPlanDir = join(authorizedRetryTemp, "plans", "plan_old_disqualified");
  const currentPlanDir = join(authorizedRetryTemp, "plans", "plan_authorized_retry");
  mkdirSync(programDir, { recursive: true });
  mkdirSync(oldPlanDir, { recursive: true });
  mkdirSync(currentPlanDir, { recursive: true });
  writeFileSync(join(oldPlanDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: "T-AUTHORIZED-RETRY prior disqualified child",
  }, null, 2));
  writeFileSync(join(currentPlanDir, "state.json"), JSON.stringify({
    state: "EXPLORE",
    goal: "T-AUTHORIZED-RETRY operator-authorized successor",
  }, null, 2));
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    version: 1,
    id: "PGM-AUTHORIZED-RETRY",
    title: "Authorized retry fixture",
    tickets: [{
      id: "T-AUTHORIZED-RETRY",
      title: "Qualify one authorized successor",
      lifecycle: "in_progress",
      child_plan: { policy: "required", plan_dir: "plans/plan_authorized_retry" },
    }],
  }, null, 2));

  const retryReport = buildLifecycleReconciliationReport({ cwd: authorizedRetryTemp, write: false });
  assert.equal(retryReport.findings.shipped_open.length, 0, "declared active successor takes precedence over a historical closed disqualified child");
} finally {
  rmSync(authorizedRetryTemp, { recursive: true, force: true });
}

const administrativeTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-admin-disposition-"));
try {
  const programDir = join(administrativeTemp, "plans", "programs", "admin-disposition");
  const planDir = join(administrativeTemp, "plans", "plan_admin_closed");
  mkdirSync(programDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: "T-ADMIN-DISPOSITION closed elsewhere",
  }, null, 2));
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    version: 1,
    id: "PGM-ADMIN-DISPOSITION",
    title: "Administrative disposition fixture",
    status: "executing",
    goal: "Dispositioned deferred tickets are resolved pending work.",
    story_refs: ["US-001"],
    epics: [{
      id: "EP-ADMIN",
      title: "Administration",
      story_refs: ["US-001"],
      ticket_refs: ["T-ADMIN-DISPOSITION"],
    }],
    tickets: [{
      id: "T-ADMIN-DISPOSITION",
      epic_id: "EP-ADMIN",
      title: "Dispositioned deferred ticket",
      type: "feature",
      lifecycle: "deferred",
      gap_refs: ["GAP-ADMIN"],
      backlog_disposition: {
        classification: "fold_into_existing_ticket",
        decision_ref: "D-ADMIN",
        receipt_ref: "reports/ive/lifecycle_dispositions/admin.json",
        source: "program_manager_disposition",
      },
    }],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [{
      id: "D-ADMIN",
      type: "backlog_disposition",
      subject_ref: "T-ADMIN-DISPOSITION",
      status: "accepted",
      decision: "Fold this ticket into existing work.",
    }],
  }, null, 2));
  const adminReport = buildLifecycleReconciliationReport({
    cwd: administrativeTemp,
    write: false,
  });
  assert.equal(adminReport.findings.shipped_open.length, 0, "dispositioned deferred tickets are not shipped-open pending work");
  assert.equal(adminReport.findings.duplicate_scope.length, 0, "dispositioned deferred tickets are not duplicate-scope pending work");
  assert.equal(lifecycleReconciliationSummary(adminReport).advisory_findings, 0, "dispositioned deferred tickets produce a clean reconciliation summary");
} finally {
  rmSync(administrativeTemp, { recursive: true, force: true });
}

const proposedResolutionTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-proposed-resolution-"));
try {
  runFixtureGit(proposedResolutionTemp, ["init"]);
  const packetRel = "plans/programs/proposed-resolution/program_packet.json";
  const packetPath = join(proposedResolutionTemp, packetRel);
  const decisionsRel = "plans/plan_resolution/decisions.md";
  const receiptRel = "reports/ive/test_runs/resolution-pass/manifest.json";
  const requestRel = "plans/plan_resolution/artifacts/proposed_resolution_request.json";
  const dispositionRel = "reports/ive/lifecycle_dispositions/proposed_resolution.json";
  const ticketId = "T-RESOLUTION-LIFECYCLE";
  const ticketTitle = "W2: Evidence-backed administrative resolution";
  mkdirSync(join(proposedResolutionTemp, "plans", "programs", "proposed-resolution"), { recursive: true });
  mkdirSync(join(proposedResolutionTemp, "plans", "plan_resolution", "artifacts"), { recursive: true });
  mkdirSync(join(proposedResolutionTemp, "reports", "ive", "test_runs", "resolution-pass"), { recursive: true });
  const packet = {
    version: 1,
    id: "PGM-PROPOSED-RESOLUTION",
    title: "Proposed resolution lifecycle fixture",
    status: "design",
    goal: "Prove lifecycle reconciliation rejects copied administrative authority.",
    remote_mode: "local-only",
    story_refs: ["US-RESOLUTION"],
    epics: [{
      id: "EP-RESOLUTION",
      title: "Resolution",
      story_refs: ["US-RESOLUTION"],
      ticket_refs: [ticketId],
    }],
    tickets: [{
      id: ticketId,
      epic_id: "EP-RESOLUTION",
      title: ticketTitle,
      type: "administrative",
      ticket_type: "administrative",
      lifecycle: "proposed",
      review_status: "not_run",
      story_refs: ["US-RESOLUTION"],
      defect_refs: [],
      gap_refs: [],
      depends_on: [],
      acceptance_criteria: ["AC-RESOLUTION"],
      child_plan: { policy: "required", plan_dir: null, reason: "Administrative resolution lane fixture." },
      compatibility_contract_refs: [],
      migration_boundary_refs: [],
      deletion_move_census_refs: [],
      verification_refs: ["VER-RESOLUTION"],
      external_refs: [],
    }],
    acceptance_criteria: [{
      id: "AC-RESOLUTION",
      scope: "ticket",
      subject_ref: ticketId,
      story_refs: ["US-RESOLUTION"],
      text: "Committed evidence closes the exact canonical Program ticket only.",
      maintenance_rationale: null,
    }],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [{
      id: "VER-RESOLUTION",
      scope: "ticket",
      subject_ref: ticketId,
      acceptance_criterion_ref: "AC-RESOLUTION",
      proof_type: "proof:artifact_review",
      command_or_action: "Review the committed resolution request and evidence.",
      pass_means: "Every committed evidence reference passes.",
    }],
    decisions: [],
  };
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  writeFileSync(join(proposedResolutionTemp, decisionsRel), [
    "# Decision Log",
    "",
    "## D-RESOLUTION — Resolve the exact lifecycle ticket",
    "",
    `Committed evidence resolves ${ticketId} only at its canonical Program Packet path.`,
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(proposedResolutionTemp, receiptRel), `${JSON.stringify({ status: "PASS" }, null, 2)}\n`, "utf-8");
  runFixtureGit(proposedResolutionTemp, ["add", packetRel, decisionsRel, receiptRel]);
  runFixtureGit(proposedResolutionTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "seed lifecycle resolution evidence"]);
  const evidenceCommit = runFixtureGit(proposedResolutionTemp, ["rev-parse", "HEAD"]);
  writeFileSync(join(proposedResolutionTemp, requestRel), `${JSON.stringify({
    schema_version: "program_proposed_resolution_request.v1",
    program_id: packet.id,
    program_packet_path: packetRel,
    resolutions: [{
      ticket_id: ticketId,
      classification: "resolved_by_evidence",
      decision_ref: { path: decisionsRel, id: "D-RESOLUTION" },
      evidence_refs: [
        { kind: "git_commit", commit: evidenceCommit },
        { kind: "json_receipt", path: receiptRel },
      ],
    }],
  }, null, 2)}\n`, "utf-8");
  runFixtureGit(proposedResolutionTemp, ["add", requestRel]);
  runFixtureGit(proposedResolutionTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "commit lifecycle resolution request"]);

  const disposition = buildProgramDisposition({
    cwd: proposedResolutionTemp,
    fromResolutionRequest: requestRel,
    output: dispositionRel,
    write: true,
    clock: () => new Date("2026-07-21T23:30:00.000Z"),
  });
  assert.equal(disposition.status, "PASS", "canonical proposed resolution fixture writes with committed evidence");
  const resolvedPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
  const copiedPacketRel = "plans/programs/proposed-resolution-copy/program_packet.json";
  const copiedPacketPath = join(proposedResolutionTemp, copiedPacketRel);
  mkdirSync(join(proposedResolutionTemp, "plans", "programs", "proposed-resolution-copy"), { recursive: true });
  writeFileSync(copiedPacketPath, `${JSON.stringify(resolvedPacket, null, 2)}\n`, "utf-8");
  const peerPacketPath = join(proposedResolutionTemp, "plans", "programs", "resolution-peer", "program_packet.json");
  mkdirSync(join(proposedResolutionTemp, "plans", "programs", "resolution-peer"), { recursive: true });
  writeFileSync(peerPacketPath, `${JSON.stringify({
    version: 1,
    id: "PGM-RESOLUTION-PEER",
    title: "Resolution peer",
    tickets: [{ id: "T-RESOLUTION-PEER", title: `${ticketTitle} mirror`, lifecycle: "proposed" }],
    decisions: [],
  }, null, 2)}\n`, "utf-8");

  const resolutionReport = buildLifecycleReconciliationReport({ cwd: proposedResolutionTemp, write: false });
  assert(
    resolutionReport.findings.duplicate_scope.every((finding) => finding.packet_path !== packetRel || finding.ticket_id !== ticketId),
    "canonical evidence-backed administrative closure is excluded from lifecycle duplicate findings",
  );
  assert(
    resolutionReport.findings.duplicate_scope.some((finding) => finding.packet_path === copiedPacketRel && finding.ticket_id === ticketId),
    "copied administrative closure with the wrong Program Packet path remains visible to lifecycle reconciliation",
  );
  const filteredByCopy = buildLifecycleReconciliationReport({
    cwd: proposedResolutionTemp,
    program: join(proposedResolutionTemp, "plans", "programs", "proposed-resolution-copy"),
    includeStampedArtifacts: false,
    output: "reports/ive/lifecycle_reconciliation/copied-resolution.json",
    write: true,
  });
  assert.equal(filteredByCopy.repair_packet.written, true, "copied-path lifecycle proof exercises relative write output");
  assert(
    filteredByCopy.findings.duplicate_scope.some((finding) => finding.packet_path === copiedPacketRel && finding.ticket_id === ticketId),
    "directory-form Program filtering retains the copied-path authority finding",
  );
  const filteredByPeer = buildLifecycleReconciliationReport({
    cwd: proposedResolutionTemp,
    program: peerPacketPath,
    write: false,
  });
  assert(
    filteredByPeer.findings.duplicate_scope.some((finding) => finding.packet_path === copiedPacketRel && finding.matched_scope.packet_path === "plans/programs/resolution-peer/program_packet.json"),
    "Program filtering retains findings where the selected Program is the matched scope",
  );
  assert.equal(filteredByPeer.counts.programs_scanned, 1, "exact Program filtering scans only the selected Program for lifecycle evidence");
  assert.equal(filteredByPeer.counts.tickets_scanned, 1, "exact Program filtering applies candidate budgets only after target selection");
  const filteredByCanonicalId = buildLifecycleReconciliationReport({
    cwd: proposedResolutionTemp,
    program: "PGM-RESOLUTION-PEER",
    write: false,
  });
  assert.equal(filteredByCanonicalId.program_filter?.packet_path, "plans/programs/resolution-peer/program_packet.json", "canonical Program ID resolves independently of its directory slug");
  assert.equal(filteredByCanonicalId.counts.programs_scanned, 1, "canonical ID filtering preserves exact scan counts");
  const whitespaceFilter = buildLifecycleReconciliationReport({ cwd: proposedResolutionTemp, program: " ", write: false });
  assert.equal(whitespaceFilter.program_filter, null, "blank Program filter falls back to the complete lifecycle report");
} finally {
  rmSync(proposedResolutionTemp, { recursive: true, force: true });
}

assert.throws(
  () => parseArgs(["--write", "--no-write"]),
  /mutually exclusive/,
  "CLI rejects mutually exclusive write flags",
);

const temp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-"));
try {
  const output = join(temp, "repair.json");
  const written = buildLifecycleReconciliationReport({
    cwd: process.cwd(),
    write: true,
    output,
  });
  assert.equal(written.repair_packet.written, true, "write mode marks repair packet written");
  assert(existsSync(output), "repair packet output is written");
  const parsed = JSON.parse(readFileSync(output, "utf-8"));
  assert.equal(parsed.repair_packet.written, true, "written artifact records written status");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const stampedTemp = mkdtempSync(join(tmpdir(), "lifecycle-reconciler-stamp-"));
try {
  const programDir = join(stampedTemp, "plans", "programs", "stamp-program");
  const planDir = join(stampedTemp, "plans", "plan_2026-07-06_stamp");
  const artifactDir = join(planDir, "artifacts");
  mkdirSync(programDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(programDir, "program_packet.json"), JSON.stringify({
    id: "PGM-STAMP",
    title: "Stamped receipt fixture",
    tickets: [
      {
        id: "T-J11-STAMP",
        title: "J11 stamped receipt fixture",
        lifecycle: "done",
        child_plan: {
          policy: "required",
          plan_dir: "plans/plan_2026-07-06_stamp",
        },
      },
    ],
  }, null, 2));
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "CLOSE",
    goal: "T-J11-STAMP: stamped receipt fixture",
  }, null, 2));
  writeFileSync(join(artifactDir, "receipt.json"), JSON.stringify({
    ticket: "T-J11-STAMP",
    repo_state_stamp: {
      schema_version: "repo_state_stamp.v1",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      dirty_file_count: 0,
      dirty_files: [],
    },
  }, null, 2));
  runFixtureGit(stampedTemp, ["init"]);
  runFixtureGit(stampedTemp, ["add", "."]);
  runFixtureGit(stampedTemp, ["-c", "user.name=Planner Test", "-c", "user.email=planner-test@example.com", "commit", "-m", "T-J11-STAMP shipped fixture"]);
  const stampedReport = buildLifecycleReconciliationReport({
    cwd: stampedTemp,
    write: false,
    includeStampedArtifacts: true,
  });
  const stampedFinding = stampedReport.findings.shipped_open.find((finding) => finding.ticket_id === "T-J11-STAMP");
  assert(stampedFinding, "canonical stamped receipt fixture produces lifecycle finding");
  const stampedEvidence = stampedFinding.evidence_chain.find((entry) => entry.kind === "stamped_receipt");
  assert(stampedEvidence, "canonical stamped receipt is included in lifecycle evidence chain");
  assert.equal(stampedEvidence.stamp_schema, "repo_state_stamp.v1", "lifecycle reconciler preserves canonical stamp schema");
  assert.equal(stampedEvidence.stamp_head_sha, "0123456789abcdef0123456789abcdef01234567", "lifecycle reconciler preserves stamp HEAD sha");
  assert.match(stampedEvidence.detail, /Canonical repo_state_stamp receipt/, "lifecycle reconciler prefers canonical stamp detail");
} finally {
  rmSync(stampedTemp, { recursive: true, force: true });
}

console.log("lifecycle_reconciler: PASS");
