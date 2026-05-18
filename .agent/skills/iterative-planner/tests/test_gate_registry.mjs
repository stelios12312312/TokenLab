#!/usr/bin/env node
// test_gate_registry.mjs — contract coverage for the normalized gate registry helper.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { loadGateRegistry, normalizeGateRegistryDocument } from "../scripts/lib/gate_registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");

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

console.log("\nGate Registry Contract Tests\n");

const loaded = loadGateRegistry({ skillPath: skillDir });
const gates = loaded?.gates || {};

assert(Object.keys(gates).length === 6, "loaded registry exposes all 6 gates");
assert(Boolean(gates["plan-to-execute"]?.authority_profile), "loaded registry exposes effective authority metadata");
assert(gates["plan-to-execute"]?.authority_profile?.phase === "execute", "plan-to-execute resolves execute authority phase");
assert(gates["plan-to-execute"]?.authority_profile?.persona_role === "boundary_only", "execute authority stays boundary-only");
assert(gates["plan-to-execute"]?.authority_profile?.ontology_role === "boundary_verification", "execute ontology role stays boundary verification");
assert(gates["explore-to-plan"]?.health_scan === "quick", "explore-to-plan keeps quick health scan");
assert(gates["reflect-to-validate"]?.health_scan === "full", "reflect-to-validate keeps full health scan");
assert(gates["notify-user"]?.audit_only === true, "notify-user stays audit-only");
assert(Array.isArray(gates["notify-user"]?.from) && gates["notify-user"].from.length === 2, "notify-user preserves both allowed source states");
assert(gates["notify-user"]?.reachability_audit === false, "notify-user keeps reachability audit disabled");

const compact = normalizeGateRegistryDocument({
  defaults: {
    persona_audit: true,
    health_scan: null,
    trace_audit: true,
    reachability_audit: true,
    audit_only: false,
  },
  gates: {
    "explore-to-plan": { from: "explore", to: "plan", health_scan: "quick" },
    "plan-to-execute": { from: "plan", to: "execute" },
    "execute-to-reflect": { from: "execute", to: "reflect" },
    "reflect-to-validate": { from: "reflect", to: "validate", health_scan: "full" },
    "validate-to-close": { from: "validate", to: "close", health_scan: "full" },
    "notify-user": { from: ["close", "validate"], to: null, audit_only: true, reachability_audit: false },
  },
});

assert(Object.keys(compact).length === 6, "compact registry normalizes all 6 gates");
assert(compact["plan-to-execute"]?.authority_profile?.phase === "execute", "compact registry derives execute phase authority");
assert(compact["execute-to-reflect"]?.persona_audit === true, "compact registry inherits persona audit default");
assert(compact["validate-to-close"]?.authority_profile?.phase === "close", "compact registry derives close phase authority");
assert(compact["notify-user"]?.authority_profile?.phase === "close", "compact registry derives notify-user close authority");
assert(compact["notify-user"]?.trace_audit === true, "compact registry inherits trace audit default");
assert(compact["notify-user"]?.reachability_audit === false, "compact registry preserves explicit reachability override");

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
