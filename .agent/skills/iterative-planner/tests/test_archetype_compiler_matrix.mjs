#!/usr/bin/env node
// test_archetype_compiler_matrix.mjs — Compiled close-signal coverage for the archetype acceptance matrix.

import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { listArchetypeAcceptanceScenarios } from "../scripts/lib/archetype_scenarios.mjs";
import {
  cleanupTemp,
  makeTemp,
  retroPromoteScript,
  runNode,
  seedArchetypeAcceptanceFixture,
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

function sorted(values) {
  return [...(Array.isArray(values) ? values : [])].sort();
}

console.log("\nArchetype Compiler Matrix\n");

const scenarios = listArchetypeAcceptanceScenarios();
assert(scenarios.length === 45, "compiler matrix reads the full 45-scenario acceptance registry");

for (const scenario of scenarios) {
  const tmp = makeTemp(scenario.id);
  try {
    const seeded = seedArchetypeAcceptanceFixture(tmp, scenario);
    const firstRefresh = refreshPlanArtifacts({
      cwd: tmp,
      planDirName: seeded.planName,
      refreshOntology: true,
      persistOntology: false,
      persistState: true,
      syncFindings: false,
    });
    const secondRefresh = refreshPlanArtifacts({
      cwd: tmp,
      planDirName: seeded.planName,
      refreshOntology: true,
      persistOntology: false,
      persistState: true,
      syncFindings: false,
    });

    const closeSignals = secondRefresh.closeSignals || {};
    assert(firstRefresh.refreshed === true, `${scenario.id}: first refresh compiles close signals`);
    assert(secondRefresh.refreshed === true, `${scenario.id}: second refresh reuses the compiled planner surface`);
    assert(firstRefresh.closeSignals?.provenance?.cache_hit === false, `${scenario.id}: first refresh starts cold`);
    assert(closeSignals?.provenance?.cache_hit === true, `${scenario.id}: second refresh reports cache_hit=true`);
    assert(typeof closeSignals?.provenance?.input_fingerprint === "string" && closeSignals.provenance.input_fingerprint.length > 0, `${scenario.id}: compiled close signals carry an input fingerprint`);
    assert(Array.isArray(closeSignals?.provenance?.input_files) && closeSignals.provenance.input_files.length > 0, `${scenario.id}: compiled close signals carry input file provenance`);

    assert(closeSignals?.objective_claims?.required === scenario.compiler.objective_required, `${scenario.id}: objective_claims.required matches the registry contract`);
    assert(closeSignals?.objective_claims?.status === scenario.compiler.objective_status, `${scenario.id}: objective_claims.status matches ${scenario.compiler.objective_status}`);
    assert(closeSignals?.intent_evidence?.required === scenario.compiler.intent_required, `${scenario.id}: intent_evidence.required matches the registry contract`);
    assert(closeSignals?.intent_evidence?.satisfied === scenario.compiler.intent_satisfied, `${scenario.id}: intent_evidence.satisfied matches the registry contract`);
    assert(closeSignals?.learned_obligations?.required === scenario.compiler.learned_required, `${scenario.id}: learned_obligations.required matches the registry contract`);
    assert(JSON.stringify(sorted(closeSignals?.learned_obligations?.active_ids)) === JSON.stringify(sorted(scenario.compiler.learned_active_ids)), `${scenario.id}: learned_obligations.active_ids match the registry contract`);
    assert(closeSignals?.audit_freshness?.false_green_risk === scenario.compiler.false_green_risk, `${scenario.id}: audit_freshness.false_green_risk matches the registry contract`);

    if (scenario.retro_fixture) {
      const preview = runNode([retroPromoteScript, "preview", scenario.retro_fixture.retro_id, "--json"], tmp);
      assert(preview.ok, `${scenario.id}: retro_promote preview exits cleanly`);
      const previewJson = parseJson(preview.stdout);
      assert(!!previewJson, `${scenario.id}: retro_promote preview emits valid JSON`);
      assert(previewJson?.trusted_promotion?.mistake_family === scenario.retro_fixture.expected_mistake_family, `${scenario.id}: retro_promote preview reuses ${scenario.retro_fixture.expected_mistake_family}`);
      assert((previewJson?.write_actions || []).some((action) => action.action === "reuse_existing_family"), `${scenario.id}: retro_promote preview reports reusable planner-core mistake-family reuse`);
    }
  } finally {
    cleanupTemp(tmp);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
