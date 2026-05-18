#!/usr/bin/env node
// test_archetype_gate_matrix.mjs — Deterministic gate coverage for the archetype acceptance matrix.

import { listArchetypeAcceptanceScenarios } from "../scripts/lib/archetype_scenarios.mjs";
import {
  cleanupTemp,
  makeTemp,
  runNode,
  seedArchetypeAcceptanceFixture,
  verifyGateScript,
} from "./helpers/archetype_matrix_fixture.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

console.log("\nArchetype Gate Matrix\n");

const scenarios = listArchetypeAcceptanceScenarios();
assert(scenarios.length === 45, "gate matrix reads the full 45-scenario acceptance registry");

for (const scenario of scenarios) {
  const tmp = makeTemp(scenario.id);
  try {
    seedArchetypeAcceptanceFixture(tmp, scenario);
    const result = runNode([verifyGateScript, scenario.gate.name], tmp);
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;

    assert(result.status === scenario.gate.expected_exit, `${scenario.id}: ${scenario.gate.name} exits with ${scenario.gate.expected_exit}`);
    assert(combinedOutput.includes(scenario.gate.expect_fragment), `${scenario.id}: ${scenario.gate.name} reports "${scenario.gate.expect_fragment}"`);
  } finally {
    cleanupTemp(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
