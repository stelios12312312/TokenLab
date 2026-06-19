#!/usr/bin/env node
// Focused coverage for e06 quant archetype-accomplice obligations and scope-gap reopen.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { generateLiveGraphPayload } from "../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import {
  ARCHETYPE_ACCOMPLICE_REGISTRY,
  detectQuantArchetype,
  evaluateAccompliceObligations,
  evaluateResidualScopeGap,
  renderArchetypeAccomplicePlanSection,
} from "../packs/quant/archetype_accomplices.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const SKILL_DIR = dirname(TEST_DIR);

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

function scenarioRegistryCoversQuantArchetypes() {
  const required = ["sports_betting_market", "crypto_perp_market", "token_launch"];
  for (const archetypeId of required) {
    const entry = ARCHETYPE_ACCOMPLICE_REGISTRY[archetypeId];
    assert(!!entry, `${archetypeId} registry entry exists`);
    assert((entry?.drivers || []).length >= 3, `${archetypeId} has at least three accomplice drivers`);
    for (const driver of entry?.drivers || []) {
      assert(typeof driver.id === "string" && driver.id.length > 0, `${archetypeId} driver has id`);
      assert(typeof driver.label === "string" && driver.label.length > 0, `${archetypeId}:${driver.id} driver has label`);
      assert(typeof driver.mechanism === "string" && driver.mechanism.split(/\s+/).length >= 4, `${archetypeId}:${driver.id} driver has one-line mechanism`);
      assert(typeof driver.prior === "string" && driver.prior.length > 0, `${archetypeId}:${driver.id} driver has tentative prior`);
      assert(Array.isArray(driver.aliases) && driver.aliases.length > 0, `${archetypeId}:${driver.id} driver has aliases`);
    }
  }
}

function scenarioSportsBettingPlanSeedsLineMovementObligation() {
  const goal = "Build a sports betting market backtest that claims CLV and closing-line edge";
  const detected = detectQuantArchetype(goal);
  const section = renderArchetypeAccomplicePlanSection({ goal });
  const bootstrapSource = readFileSync(join(SKILL_DIR, "scripts/bootstrap.mjs"), "utf-8");

  assert(detected?.id === "sports_betting_market", "sports betting goal detects sports_betting_market archetype");
  assert(section.includes("## Archetype Accomplice Obligations"), "plan renderer emits an accomplice obligation section");
  assert(section.includes("line movement/sharp money"), "plan renderer includes line movement/sharp money obligation");
  assert((section.match(/\[ \] Address or dismiss with reason/g) || []).length >= 3, "plan renderer seeds at least three PLAN-phase obligations");
  assert(bootstrapSource.includes("renderArchetypeAccomplicePlanSection"), "bootstrap.mjs is wired to the accomplice plan renderer");
}

function scenarioMissingLineMovementIsBlocked() {
  const verdict = evaluateAccompliceObligations({
    archetype: "sports_betting_market",
    obligations: [
      { driver_id: "vig_de_vig", status: "addressed", reason: "Model normalizes implied probabilities after removing vig." },
      { driver_id: "injury_news_shocks", status: "dismissed", reason: "Fixture excludes games with late injury news timestamps." },
      { driver_id: "correlated_parlays", status: "addressed", reason: "Parlay legs are excluded from the backtest sample." },
    ],
  });
  assert(verdict.satisfied === false, "missing line movement obligation is not satisfied");
  assert(verdict.blockers.includes("archetype_accomplice_missing_obligation:line_movement_sharp_money"), "missing line movement emits explicit blocker");
}

function scenarioFundingRateResidualReopensPlan() {
  const residuals = Array.from({ length: 40 }, (_, index) => index + 1);
  const fundingRate = residuals.map((value, index) => value * 0.8 + (index % 3) * 0.01);
  const verdict = evaluateResidualScopeGap({
    archetype: "crypto_perp_market",
    residuals,
    accomplice_series: {
      funding_rate: fundingRate,
    },
  });
  const match = verdict.matches?.find((entry) => entry.driver_id === "funding_rate");
  assert(verdict.blocked === true, "funding-rate residual correlation blocks the claim");
  assert(verdict.reopen_phase === "PLAN", "scope-gap blocker reopens PLAN rather than EXECUTE");
  assert(verdict.rerun_leakage_required === true, "scope-gap blocker requires rerunning leakage on the expanded scope");
  assert(match && Math.abs(match.r) >= 0.30 && match.p_value < 0.05, "funding-rate match crosses |r| >= 0.30 and p < 0.05");
}

function scenarioWeakOrConstantSeriesDoesNotBlock() {
  const verdict = evaluateResidualScopeGap({
    archetype: "crypto_perp_market",
    residuals: [1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
    accomplice_series: {
      funding_rate: Array(10).fill(0.01),
    },
  });
  assert(verdict.blocked === false, "constant accomplice series does not fabricate a scope-gap blocker");
  assert(verdict.warnings.includes("constant_series:funding_rate"), "constant accomplice series is reported as a warning");
}

function scenarioLivePayloadSurfacesScopeGapFact() {
  const planDir = mkdtempSync(join(tmpdir(), "planner-accomplice-payload-"));
  try {
    const residuals = Array.from({ length: 40 }, (_, index) => index + 1);
    const fundingRate = residuals.map((value) => value * 0.9);
    const validation = stampRunRecordPayload({
      version: 1,
      applicable: true,
      run_class: "wiring_proof",
      promotion_verdict: "diagnostic_only",
      archetype: "crypto_perp_market",
      search: {
        trials_completed: 16,
        unique_parameter_count: 4,
        objective_handling: "sampled",
      },
      controls: [],
      accomplice_obligations: [
        { driver_id: "funding_rate", status: "addressed", reason: "Funding rate was inspected." },
        { driver_id: "liquidation_cascades", status: "addressed", reason: "Liquidation windows were segmented." },
        { driver_id: "slippage_fees", status: "addressed", reason: "Execution costs were netted." },
        { driver_id: "oracle_depeg", status: "dismissed", reason: "Depeg windows are not present in the fixture." },
      ],
      residual_scope_gap: {
        residuals,
        accomplice_series: { funding_rate: fundingRate },
      },
      evidence: {
        strongest_counterargument: "Residuals may be explained by funding rather than model skill.",
        falsification_criteria: "Expanded scope must remove the residual funding-rate correlation.",
        presentation_stamp: "diagnostic_only",
      },
    }, {
      producer: "verification_runner",
      row_id: "VM-T-INTAKE-83B242B6",
      command: "node .agent/skills/iterative-planner/tests/test_archetype_accomplices.mjs",
      exit_code: 0,
      timestamp: "2026-06-03T12:00:00.000Z",
    });

    writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "VALIDATE", plan_dir: "planner-accomplice-payload" }, null, 2));
    writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Archetype Accomplice Obligations\nDetected archetype: `crypto_perp_market`.\n");
    writeFileSync(join(planDir, "verification.md"), "# Verification\n");
    writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(validation, null, 2));

    const payload = generateLiveGraphPayload({
      repoRoot: join(SKILL_DIR, "..", "..", ".."),
      planDir,
      generatedAt: "2026-06-03T12:00:00.000Z",
    });
    const fact = payload.entities.ontology_facts.find((entry) => entry.label === "scope_gap_reopen");
    assert(!!fact, "live payload surfaces QRV scope-gap blocker as ontology fact");
    assert(fact?.detail.includes("funding_rate"), "live payload scope-gap fact names funding_rate");
    assert(fact?.detail.includes("reopen PLAN"), "live payload scope-gap fact instructs PLAN reopen");
    assert(payload.invariant_violations.some((entry) => entry.id === "scope_gap_reopen"), "live payload mirrors scope gap under invariant_violations");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

scenarioRegistryCoversQuantArchetypes();
scenarioSportsBettingPlanSeedsLineMovementObligation();
scenarioMissingLineMovementIsBlocked();
scenarioFundingRateResidualReopensPlan();
scenarioWeakOrConstantSeriesDoesNotBlock();
scenarioLivePayloadSurfacesScopeGapFact();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
