import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { SCIENTIFIC_EVIDENCE_ARTIFACT_SCHEMA, SCIENTIFIC_REVIEW_REQUEST_SCHEMA, sha256File } from "../../scripts/lib/scientific_contract.mjs";

export const SCIENTIFIC_IDENTITY = Object.freeze({
  experiment_id: "EXP-010",
  title: "Independent scientific reviewer fixture",
  hypothesis_id: "H-EXP-010",
  ticket_id: "T-EXP-010",
  story_id: "US-003",
  plan_id: "plan_scientific_fixture",
});

const WINDOWS = Object.freeze([
  { role: "training", start: "2025-01-01", end: "2025-03-31" },
  { role: "validation", start: "2025-04-08", end: "2025-06-30" },
  { role: "calibration", start: "2025-07-08", end: "2025-09-30" },
  { role: "final_holdout", start: "2025-10-08", end: "2025-10-31" },
  { role: "second_holdout", start: "2025-11-08", end: "2025-11-30" },
]);

const DIMENSIONS = Object.freeze([
  "windows", "frequency", "universe", "strategy_families", "parameter_ranges",
  "weights", "thresholds", "trials", "folds",
]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function artifact(type, payload) { return { schema_version: SCIENTIFIC_EVIDENCE_ARTIFACT_SCHEMA, artifact_type: type, identity: clone(SCIENTIFIC_IDENTITY), payload }; }

export function baseScientificDocuments({ outcome = "positive", runClass = "promotion_candidate", confirmationStage = false } = {}) {
  const choices = DIMENSIONS.map((dimension) => ({
    dimension,
    value: dimension === "weights" ? 0.5 : dimension === "trials" ? 5 : dimension === "folds" ? 3 : `${dimension}-frozen`,
    mechanism: "preregistered",
    prior: `prior basis for ${dimension}`,
    alternatives: [`alternative-${dimension}`],
    basis: `domain basis for ${dimension}`,
    rationale: `frozen before execution for ${dimension}`,
    sensitivity: { description: `vary ${dimension}`, outcomes: ["stable"] },
  }));
  const selectedParameters = Object.fromEntries(choices.map((row) => [row.dimension, clone(row.value)]));
  const assets = Array.from({ length: 5 }, (_, index) => ({ asset_id: `ASSET-${index + 1}`, rank: index + 1, eligible: true }));
  const observations = [];
  for (let index = 0; index < 20; index++) {
    observations.push({
      observation_id: `OBS-${index + 1}`,
      asset_id: `ASSET-${(index % 5) + 1}`,
      period_id: `P-${Math.floor(index / 5) + 1}`,
      event_id: `E-${index + 1}`,
      eligible: true,
    });
  }
  const counterarguments = [
    "temporal_leakage", "dependence_power", "parameter_arbitrariness",
    "universe_bias", "provenance_integrity", "identity_consistency",
  ].map((type) => ({ type, assessment: `${type} independently challenged`, status: "addressed" }));
  const artifacts = {
    preregistration: artifact("preregistration", { windows: clone(WINDOWS), purge_days: 7, parameter_choices: choices }),
    executed_config: artifact("executed_config", { windows: clone(WINDOWS), selected_parameters: selectedParameters, folds_requested: 3, trials_requested: 5, universe_target_count: 5 }),
    universe: artifact("universe", { as_of: "2024-12-31", ranking_method: "trailing-volume known at as_of", assets, survivorship_policy: "point-in-time membership including later delistings", sensitivity: ["top-3 and top-7 stable"] }),
    folds: artifact("folds", { records: Array.from({ length: 3 }, (_, index) => ({ fold_id: `F-${index + 1}`, status: "complete", usable: true })) }),
    trials: artifact("trials", { records: Array.from({ length: 5 }, (_, index) => ({ trial_id: `TR-${index + 1}`, status: "complete", parameter_set: { seed: index + 1 } })) }),
    observations: artifact("observations", { records: observations }),
    result: artifact("result", { execution_status: "complete", outcome, counterarguments }),
    registry: artifact("registry", { status: "registered", source: "reports/user_story_audit/story_registry.json" }),
    ticket: artifact("ticket", { status: "accepted", source: "ticket/T-EXP-010" }),
    plan_identity: artifact("plan_identity", { status: "active", source: "plans/plan_scientific_fixture" }),
  };
  const request = {
    schema_version: SCIENTIFIC_REVIEW_REQUEST_SCHEMA,
    canonical_evidence_root: "../canonical-evidence",
    artifacts: {},
    minimums: { assets: 5, completed_folds: 3, completed_trials: 5, eligible_observations: 20, effective_groups: 20 },
    expected_identity: clone(SCIENTIFIC_IDENTITY),
    claim_direction: outcome === "negative" ? "negative" : outcome === "positive" ? "positive" : "mixed",
    confirmation_stage: confirmationStage,
    run_metadata: { run_class: runClass, is_test: false, is_synthetic: false, short_history: false, bypass_used: false, output_root: "../run-output" },
    provenance: { code_revision: "abcdef1234567890", run_started_at: "2026-01-01T00:00:00.000Z", run_completed_at: "2026-01-02T00:00:00.000Z" },
  };
  return { request, artifacts };
}

export function materializeScientificBundle(projectRoot, { mutate = null, outcome = "positive", runClass = "promotion_candidate", confirmationStage = false } = {}) {
  const bundleRoot = join(projectRoot, "scientific");
  const artifactRoot = join(bundleRoot, "artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(join(projectRoot, "canonical-evidence"), { recursive: true });
  mkdirSync(join(projectRoot, "run-output"), { recursive: true });
  writeFileSync(join(projectRoot, "canonical-evidence", "immutable.txt"), "canonical evidence sentinel\n");
  const documents = baseScientificDocuments({ outcome, runClass, confirmationStage });
  if (mutate) mutate(documents);
  const paths = {};
  for (const [role, document] of Object.entries(documents.artifacts)) {
    const path = join(artifactRoot, `${role}.json`);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    paths[role] = path;
    documents.request.artifacts[role] = { path: `artifacts/${role}.json`, sha256: sha256File(path) };
  }
  const requestPath = join(bundleRoot, "review-request.json");
  writeFileSync(requestPath, `${JSON.stringify(documents.request, null, 2)}\n`);
  return {
    projectRoot,
    requestPath,
    requestReference: { path: "scientific/review-request.json", sha256: sha256File(requestPath) },
    paths,
    documents,
    canonicalRoot: join(projectRoot, "canonical-evidence"),
  };
}
