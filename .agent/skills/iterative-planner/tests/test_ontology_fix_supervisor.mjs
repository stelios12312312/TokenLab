#!/usr/bin/env node
// test_ontology_fix_supervisor.mjs — Phase B integration tests for the
// ontology-fix supervisor wired through rule_engine.mjs enrichViolationsWithFixes.
//
// Tests the layer above runOntologyFixSupervisor (unit-tested in
// test_supervisor_runner.mjs). Specifically:
//   - enrichViolationsWithFixes mutates violations[] with fix commands
//   - phase-premature violations get phase_guard verdicts (M-009)
//   - unknown invariants degrade to null fix_command (not hallucination)
//   - LLM-unavailable / supervisor-error paths leave violations un-enriched
//   - re-running on already-enriched violations is idempotent

import { enrichViolationsWithFixes } from "../scripts/rule_engine.mjs";
import { clearSupervisorCache } from "../scripts/lib/supervisor_runner.mjs";

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

async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL: ${label} — threw ${err?.message || err}`);
  }
}

function makeSemanticResults(violations) {
  return [{
    name: "Story invariants",
    status: "FAIL",
    detail: `${violations.length} violation(s): test`,
    violations: violations.map((v) => ({
      name: v.name,
      detail: v.detail || "",
      phase_guard_required: v.phase_guard_required === true,
      suggested_fix_command: null,
      auto_repair_safe: false,
    })),
  }];
}

console.log("\nOntology Fix Supervisor (Phase B Wiring)\n");

clearSupervisorCache();

// ──────────────────────────────────────────────────────────────────────
// Test 1: Known invariant -> mock fix command propagates through enrichment
// ──────────────────────────────────────────────────────────────────────
await safeRun("known invariant gets suggested_fix_command from mock LLM", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs check",
      auto_repair_safe: true,
      explanation: "Add test refs to story_registry.json",
    }),
  };
  const results = makeSemanticResults([
    { name: "code_without_tests", detail: "US-001" },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  const v = enriched[0].violations[0];
  assert(v.suggested_fix_command && v.suggested_fix_command.includes("story_registry"),
    "fix_command populated from mock");
  assert(v.auto_repair_safe === true, "auto_repair_safe propagated as true");
  assert(v.explanation === "Add test refs to story_registry.json", "explanation propagated");
  assert(v.supervisor_status === "fresh", "supervisor_status=fresh on first call");
});

// ──────────────────────────────────────────────────────────────────────
// Test 2: Multiple distinct violations get distinct fix commands
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("two different invariants each get fix commands", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute",
      auto_repair_safe: false,
      explanation: "Use transition.mjs; never edit state.json directly",
    }),
  };
  const results = makeSemanticResults([
    { name: "code_without_tests", detail: "US-001" },
    { name: "gate_chain_broken", detail: "I-015" },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  assert(enriched[0].violations.length === 2, "both violations preserved");
  assert(enriched[0].violations[0].suggested_fix_command, "first violation has fix");
  assert(enriched[0].violations[1].suggested_fix_command, "second violation has fix");
});

// ──────────────────────────────────────────────────────────────────────
// Test 3: M-009 guard — phase_guard_required violations get phase_guard verdict
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("phase-premature invariant -> phase_guard verdict, null fix", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "this should be ignored",
      auto_repair_safe: true,
      explanation: "should not be used",
    }),
  };
  const results = makeSemanticResults([
    { name: "phase_premature_check", detail: "X", phase_guard_required: true },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  const v = enriched[0].violations[0];
  assert(v.suggested_fix_command === null, "phase-premature -> null fix_command (mock bypassed)");
  assert(v.auto_repair_safe === false, "phase-premature -> auto_repair_safe=false");
  assert(v.supervisor_status === "phase_guard", "phase-premature -> supervisor_status=phase_guard");
  assert(v.supervisor_source === "deterministic", "phase-premature -> source=deterministic");
});

// ──────────────────────────────────────────────────────────────────────
// Test 4: PLANNER_SUPERVISOR_DISABLED -> fallback verdicts, null fix
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("disabled env leaves violations with null fix and unavailable status", async () => {
  const env = { PLANNER_SUPERVISOR_DISABLED: "1" };
  const results = makeSemanticResults([
    { name: "code_without_tests", detail: "US-001" },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  const v = enriched[0].violations[0];
  assert(v.suggested_fix_command === null, "disabled -> null fix_command");
  assert(v.auto_repair_safe === false, "disabled -> auto_repair_safe=false");
  assert(v.supervisor_status === "unavailable", "disabled -> supervisor_status=unavailable");
});

// ──────────────────────────────────────────────────────────────────────
// Test 5: LLM timeout -> graceful fallback, no throw
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("LLM timeout leaves violations un-enriched without throwing", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout" };
  const results = makeSemanticResults([
    { name: "code_without_tests", detail: "US-001" },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  const v = enriched[0].violations[0];
  assert(v.suggested_fix_command === null, "timeout -> null fix_command");
  assert(v.supervisor_status === "unavailable", "timeout -> unavailable status");
});

// ──────────────────────────────────────────────────────────────────────
// Test 6: Malformed LLM JSON -> schema rejection -> fallback
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("malformed mock response -> schema fallback", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: 42, // wrong type
      auto_repair_safe: "yes",  // wrong type
    }),
  };
  const results = makeSemanticResults([
    { name: "some_invariant", detail: "Z" },
  ]);
  const enriched = await enrichViolationsWithFixes(results, { env });
  const v = enriched[0].violations[0];
  assert(v.suggested_fix_command === null, "malformed -> null fix");
  assert(v.supervisor_status === "unavailable", "malformed -> unavailable");
});

// ──────────────────────────────────────────────────────────────────────
// Test 7: Empty results -> no-op, doesn't throw
// ──────────────────────────────────────────────────────────────────────
await safeRun("empty results array -> returns empty without error", async () => {
  const enriched = await enrichViolationsWithFixes([], { env: {} });
  assert(Array.isArray(enriched) && enriched.length === 0, "empty -> empty");
});

await safeRun("results without violations -> unchanged", async () => {
  const input = [{ name: "Semantic: explore → plan", status: "PASS", detail: "ok" }];
  const enriched = await enrichViolationsWithFixes(input, { env: {} });
  assert(enriched.length === 1, "length preserved");
  assert(enriched[0].status === "PASS", "PASS row preserved");
});

// ──────────────────────────────────────────────────────────────────────
// Test 8: Idempotency — re-enriching skips already-populated violations
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("re-running enrichment is idempotent (skips already-set fix)", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "/first-run-cmd",
      auto_repair_safe: true,
      explanation: "first",
    }),
  };
  const results = makeSemanticResults([
    { name: "test_idempotent", detail: "A" },
  ]);
  const enriched1 = await enrichViolationsWithFixes(results, { env });
  assert(enriched1[0].violations[0].suggested_fix_command === "/first-run-cmd", "first run sets fix");

  // Change the mock — but the existing violation already has a fix; should be skipped
  const env2 = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "/second-run-cmd",
      auto_repair_safe: true,
      explanation: "second",
    }),
  };
  const enriched2 = await enrichViolationsWithFixes(enriched1, { env: env2 });
  assert(enriched2[0].violations[0].suggested_fix_command === "/first-run-cmd",
    "second run is no-op when fix already present");
});

// ──────────────────────────────────────────────────────────────────────
// Test 9: Original input is not mutated
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("original input array is not mutated", async () => {
  const env = {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      suggested_fix_command: "/mutation-test-cmd",
      auto_repair_safe: false,
      explanation: "x",
    }),
  };
  const original = makeSemanticResults([
    { name: "mutation_test", detail: "B" },
  ]);
  const originalRef = original[0].violations[0];
  const enriched = await enrichViolationsWithFixes(original, { env });
  assert(originalRef.suggested_fix_command === null,
    "original violation object NOT mutated (deep-cloned by enrichment)");
  assert(enriched[0].violations[0].suggested_fix_command === "/mutation-test-cmd",
    "enriched copy has the new fix");
});

// Final summary
console.log(`\n${passed} passed, ${failed} failed`);
clearSupervisorCache();
process.exit(failed > 0 ? 1 : 0);
