#!/usr/bin/env node
// test_quant_persona_gate.mjs - deterministic quant/persona ticket gate contracts.

import {
  detectQuantPersonaScope,
  evaluateQuantPersonaGate,
  quantPersonaGateToBlockers,
} from "../scripts/lib/quant_persona_gate.mjs";

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

console.log("\nQuant Persona Gate Contracts\n");

{
  const result = evaluateQuantPersonaGate({
    sourceText: "Polymarket odds model: improve ranking strategy.",
  });
  const blockers = quantPersonaGateToBlockers(result);
  assert(result.required === true, "Polymarket/odds/model text activates quant gate");
  assert(result.status === "blocked", "high-level quant text blocks without required evidence");
  assert(result.summary.missing_guard_ids.includes("what_happened_overview"), "missing what-happened overview is a blocker");
  assert(blockers.some((entry) => entry.code === "quant_persona_what_happened_overview_missing"), "missing overview converts to deterministic blocker");
}

{
  const result = evaluateQuantPersonaGate({
    sourceText: "What happened: the Polymarket odds model reported positive ROI but actual outcome diverged from expected CLV on the latest date range.",
    ticket: {
      title: "Quant persona review for odds strategy",
      body: "Use quant persona. Target outcome is calibrated edge and ROI against the closing-line benchmark.",
    },
    acceptanceCriteria: [
      {
        text: "Quant persona must verify data source, odds snapshot as-of timestamps, known-at-time coverage, temporal leakage handling, and baseline controls.",
      },
    ],
    verificationRows: [
      {
        proof_type: "proof:quant_results_validation",
        command_or_action: "Run temporal split check, leakage check, calibration check, and benchmark comparison.",
      },
    ],
  });
  assert(result.required === true, "complete quant text still activates gate");
  assert(result.status === "pass", "complete quant evidence passes gate");
  assert(quantPersonaGateToBlockers(result).length === 0, "passing gate emits no blockers");
}

{
  const result = evaluateQuantPersonaGate({
    sourceText: "Add quant persona hard gate to the planner ticket review workflow.",
    planShape: { primary: "planner-core" },
    changedFiles: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
  });
  assert(result.required === false, "planner-core work about quant gates does not masquerade as a quant project");
  assert(result.status === "not_applicable", "planner-core quant-gate maintenance is not blocked by quant project proof requirements");
}

{
  const result = detectQuantPersonaScope({
    sourceText: "Add a generic ticket receipt field.",
  });
  assert(result.required === false, "generic ticket text does not activate quant gate");
}

{
  const result = evaluateQuantPersonaGate({
    sourceText: "kb close gate smoke",
    planContent: "Profile: scientific_training_quant\nOntology signals\nPersona signals\nVerification Strategy\nTarget placeholder",
    verificationContent: "Regression proof of work close gate",
  });
  assert(result.required === false, "default planner scaffold quant wording does not activate the project quant gate");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
