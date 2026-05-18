#!/usr/bin/env node
// test_archetype_ontology_diagnostics_matrix.mjs — Ontology fact and diagnostics coverage for the archetype acceptance matrix.

import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { listArchetypeAcceptanceScenarios } from "../scripts/lib/archetype_scenarios.mjs";
import {
  cleanupTemp,
  makeTemp,
  ontologySerializerScript,
  runNode,
  seedArchetypeAcceptanceFixture,
  skillDir,
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

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

console.log("\nArchetype Ontology Diagnostics Matrix\n");

const scenarios = listArchetypeAcceptanceScenarios();
assert(scenarios.length === 45, "ontology matrix reads the full 45-scenario acceptance registry");

for (const scenario of scenarios) {
  const tmp = makeTemp(scenario.id);
  try {
    const seeded = seedArchetypeAcceptanceFixture(tmp, scenario);
    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      planDirName: seeded.planName,
      refreshOntology: true,
      persistOntology: false,
      persistState: false,
      syncFindings: false,
    });
    const serializer = runNode([ontologySerializerScript, "--json", "--dir", tmp], tmp);
    assert(serializer.ok, `${scenario.id}: ontology_serializer CLI exits cleanly`);
    const serializerJson = parseJson(serializer.stdout);
    assert(!!serializerJson, `${scenario.id}: ontology_serializer CLI emits valid JSON`);

    const facts = Array.isArray(serializerJson?.facts)
      ? serializerJson.facts.join("\n")
      : String(refresh.ontology?.facts || "");

    if (scenario.ontology.objective_verdict) {
      assert(facts.includes("objective_claim("), `${scenario.id}: ontology emits objective_claim/2 facts`);
      assert(facts.includes("claim_required("), `${scenario.id}: ontology emits claim_required/2 facts`);
      assert(facts.includes("claim_deliverable("), `${scenario.id}: ontology emits claim_deliverable/2 facts`);
      assert(facts.includes("claim_relation("), `${scenario.id}: ontology emits claim_relation/3 facts`);
      assert(facts.includes("claim_scope("), `${scenario.id}: ontology emits claim_scope/2 facts`);
      assert(facts.includes(`claim_verdict('primary_path_mobile', '${scenario.ontology.objective_verdict}').`), `${scenario.id}: ontology emits claim_verdict/2 with ${scenario.ontology.objective_verdict}`);
      if (!["missing_proof", "artifact_invalid"].includes(scenario.ontology.objective_verdict)) {
        assert(facts.includes("claim_proof_type("), `${scenario.id}: ontology emits claim_proof_type/2 facts when usable proof metadata exists`);
      }
    } else {
      assert(!facts.includes("objective_claim("), `${scenario.id}: ontology stays compact when no objective claims are required`);
    }

    assert(!facts.includes("browser_observation("), `${scenario.id}: raw browser observation predicates stay out of the ontology`);
    assert(!facts.includes("observation_status("), `${scenario.id}: raw browser observation status facts stay out of the ontology`);
    assert(!facts.includes("observation_viewport("), `${scenario.id}: raw browser observation viewport facts stay out of the ontology`);
    assert(!facts.includes("workflow_hint_ranking"), `${scenario.id}: fuzzy workflow ranking stays out of the ontology`);
    assert(!facts.includes("retro_hint_ranking"), `${scenario.id}: fuzzy retro ranking stays out of the ontology`);

    const engine = createSemanticEngine({
      cwd: tmp,
      skillPath: skillDir,
      refreshOntology: false,
      transientCloseSignals: refresh.closeSignals,
      transientOntologyFacts: facts,
    });

    if (scenario.ontology.expected_variance) {
      assert(
        engine.session.check(`repairable_variance(objective_claim_gap, info(${scenario.ontology.expected_variance}, 'primary_path_mobile'))`),
        `${scenario.id}: diagnostics expose ${scenario.ontology.expected_variance} as repairable objective-claim variance`
      );
    } else {
      assert(
        !engine.session.check("repairable_variance(objective_claim_gap, Detail)"),
        `${scenario.id}: diagnostics stay clean when no objective-claim variance is expected`
      );
    }
  } finally {
    cleanupTemp(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
