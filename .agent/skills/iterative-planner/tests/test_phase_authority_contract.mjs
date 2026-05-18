#!/usr/bin/env node
// test_phase_authority_contract.mjs — contract coverage for phase authority metadata.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  AGENT_AUTHORITY_ROLES,
  AUTHORITY_PHASES,
  ONTOLOGY_AUTHORITY_ROLES,
  PERSONA_AUTHORITY_ROLES,
  buildPhaseContract,
  resolveAuthorityProfile,
  resolveProofPosture,
} from "../scripts/lib/planner_phase_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const gatesPath = join(skillDir, "config", "gates.json");
const gates = JSON.parse(readFileSync(gatesPath, "utf-8")).gates || {};

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

console.log("\nPhase Authority Contract Tests\n");

for (const [gateName, gateDef] of Object.entries(gates)) {
  const profile = resolveAuthorityProfile({ gateName, gateDef });
  const proofPosture = resolveProofPosture({ gateName, gateDef });
  const contract = buildPhaseContract({ authorityProfile: profile, proofPosture });

  assert(!!gateDef.authority_profile, `${gateName}: gates.json includes authority_profile metadata`);
  assert(AUTHORITY_PHASES.includes(profile.phase), `${gateName}: authority_profile phase stays within the supported enum`);
  assert(AGENT_AUTHORITY_ROLES.includes(profile.agent_role), `${gateName}: agent_role stays within the supported enum`);
  assert(PERSONA_AUTHORITY_ROLES.includes(profile.persona_role), `${gateName}: persona_role stays within the supported enum`);
  assert(ONTOLOGY_AUTHORITY_ROLES.includes(profile.ontology_role), `${gateName}: ontology_role stays within the supported enum`);
  assert(profile.continuous_execute_supervision === false, `${gateName}: continuous execute supervision stays disabled`);
  assert(typeof proofPosture?.label === "string" && proofPosture.label.length > 0, `${gateName}: proof posture resolves for the entered phase`);
  assert(typeof contract?.summary === "string" && contract.summary.length > 20, `${gateName}: phase contract summary resolves for the entered phase`);
}

for (const [gateName, gateDef] of Object.entries(gates)) {
  if (gateDef?.authority_profile?.phase !== "execute") continue;
  assert(gateDef.authority_profile.persona_role === "boundary_only", `${gateName}: execute phase keeps personas boundary-only`);
  assert(gateDef.authority_profile.ontology_role === "boundary_verification", `${gateName}: execute phase keeps ontology boundary-only`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
