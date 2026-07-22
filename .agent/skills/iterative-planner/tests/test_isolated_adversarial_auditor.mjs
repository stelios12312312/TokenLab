#!/usr/bin/env node
// test_isolated_adversarial_auditor.mjs - e05 forged-proof auditor fixture.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildAdversarialScopingPanel,
  buildIsolatedAuditInputFromPlan,
  runIsolatedAdversarialAudit,
} from "../scripts/lib/isolated_adversarial_auditor.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function forgedGatePassInput() {
  return {
    gate: "reflect-to-validate",
    sanitized_gate: {
      gate_name: "reflect-to-validate",
      changed_gate_files: [".agent/skills/iterative-planner/config/gates.json"],
      gate_edit_intent: "edited to pass after blocker",
    },
    plan_artifacts: {
      findings: "Lead approach: edit gate JSON until the ticket passes.",
      plan: "Lead approach: edit gate JSON until the ticket passes.",
      verification: "Proof: PASS appears in the transcript substring. No disconfirming run was captured.",
      reflection: "The original approach is still unchanged since EXPLORE.",
    },
    evidence_events: [
      { kind: "confirming", author: "foreground-agent", artifact: "verification.md", claim: "PASS substring exists" },
      { kind: "confirming", author: "foreground-agent", artifact: "progress.md", claim: "gate edited and now green" },
      { kind: "confirming", author: "foreground-agent", artifact: "reflection.md", claim: "same approach retained" },
      { kind: "confirming", author: "foreground-agent", artifact: "decisions.md", claim: "approved after edit" },
    ],
    proof_claims: [
      { type: "substring", value: "PASS", artifact: "terminal output excerpt" },
    ],
  };
}

function scenarioFlagsForgedGateJsonPass() {
  const result = runIsolatedAdversarialAudit(forgedGatePassInput());
  const ids = result.findings.map((finding) => finding.id);

  assert(result.status === "blocked", "forged gate-pass fixture is blocking");
  assert(ids.includes("IA-001"), "auditor flags gate JSON edited to pass");
  assert(ids.includes("IA-002"), "auditor flags confirming/disconfirming imbalance");
  assert(ids.includes("IA-003"), "auditor flags unchanged lead approach anchoring");
  assert(ids.includes("IA-004"), "auditor flags same-author evidence");
  assert(ids.includes("IA-005"), "auditor flags substring-only proof");
  assert(result.isolation.raw_gate_json_seen === false, "auditor records that raw gate JSON was not visible");
  assert(result.findings.every((finding) => finding.severity === "fail"), "forged-proof findings escalate rather than confirm quality");
}

function scenarioDoesNotFlagBalancedArtifactBackedReview() {
  const input = forgedGatePassInput();
  input.sanitized_gate.changed_gate_files = [];
  input.sanitized_gate.gate_edit_intent = null;
  input.plan_artifacts.plan = "Lead approach: keep transition gate logic and add a real conformance test.";
  input.plan_artifacts.findings = "Lead approach: compare alternatives and do not edit gates to pass.";
  input.plan_artifacts.verification = "Proof: node tests/run.mjs exits 0 with artifact path reports/ive/test_runs/e05.json.";
  input.plan_artifacts.reflection = "Alternative proof path was reviewed and the original gate-edit approach was rejected.";
  input.evidence_events = [
    { kind: "confirming", author: "foreground-agent", artifact: "verification.md", claim: "targeted suite passed" },
    { kind: "disconfirming", author: "adversarial-auditor", artifact: "red_team_notes.md", claim: "gate bypass attempt checked" },
  ];
  input.proof_claims = [
    { type: "artifact", value: "reports/ive/test_runs/e05.json", artifact: "conformance report" },
  ];

  const result = runIsolatedAdversarialAudit(input);
  assert(result.status === "pass", "balanced artifact-backed review passes");
  assert(result.findings.length === 0, "balanced artifact-backed review has no blocking findings");
}

function scenarioDoesNotFlagDefensiveDiscussionOfForgedGateProof() {
  const planDir = mkdtempSync(join(tmpdir(), "isolated-auditor-defensive-"));
  try {
    writeFileSync(join(planDir, "findings.md"), [
      "The verification line discusses a fixture where gate JSON was edited to pass.",
      "That should not mean searching for the substring `gates.json` anywhere in a plan.",
      "Disconfirming evidence: the real plan keeps gate logic intact and tests the negative fixture.",
    ].join("\n") + "\n");
    writeFileSync(join(planDir, "plan.md"), [
      "# Plan",
      "Risk: if the auditor reads raw `gates.json`, it violates isolation.",
      "F-004: forged-gate fixture must be artifact-backed rather than substring-only.",
    ].join("\n") + "\n");
    writeFileSync(join(planDir, "verification.md"), [
      "Proof: node tests/run.mjs exits 0 with artifact path reports/ive/test_runs/e05.json.",
      "Negative fixture: forged gate-pass proof blocks in the conformance test.",
    ].join("\n") + "\n");
    writeFileSync(join(planDir, "reflection.md"), "PASS: defensive language was reviewed and the implementation did not edit gate files.\n");
    writeFileSync(join(planDir, "progress.md"), "PASS: conformance and browser proof are complete.\n");
    writeFileSync(join(planDir, "decisions.md"), "Decision: do not edit gates to pass; use runtime wiring and tests.\n");
    writeFileSync(join(planDir, "state.json"), JSON.stringify({
      state: "REFLECT",
      goal: "defensive discussion false positive fixture",
      plan_shape: { primary: "planner-core" },
      change_manifest: [
        ".agent/skills/iterative-planner/scripts/audit_runner.mjs",
        ".agent/skills/iterative-planner/tests/ive/run.mjs",
      ],
    }, null, 2) + "\n");

    const input = buildIsolatedAuditInputFromPlan({ planDir, gate: "reflect-to-validate" });
    const result = runIsolatedAdversarialAudit(input);
    const ids = result.findings.map((finding) => finding.id);
    assert(result.status === "pass", "defensive forged-proof discussion with artifacts passes", JSON.stringify(result.findings));
    assert(!ids.includes("IA-001"), "defensive gates.json mention is not treated as gate edit");
    assert(!ids.includes("IA-005"), "defensive substring-only mention is not treated as substring-only proof");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioScopingPanelRejectsGenericCritiques() {
  const panel = buildAdversarialScopingPanel({
    summary: "planner orchestrator single-writer gate",
    generic_critiques: ["needs more testing", "unclear"],
  });

  assert(panel.length === 3, "fixed scoping panel has three perspectives");
  assert(panel.every((entry) => entry.driver && entry.mechanism), "every panel entry names driver and mechanism");
  assert(panel.every((entry) => entry.accepted === true), "generic critiques are not accepted as panel output");
  assert(panel.some((entry) => entry.role === "auditor" && entry.driver.includes("gate")), "auditor perspective names a gate-bypass driver");
}

console.log("\nIsolated Adversarial Auditor Tests\n");
scenarioFlagsForgedGateJsonPass();
scenarioDoesNotFlagBalancedArtifactBackedReview();
scenarioDoesNotFlagDefensiveDiscussionOfForgedGateProof();
scenarioScopingPanelRejectsGenericCritiques();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
