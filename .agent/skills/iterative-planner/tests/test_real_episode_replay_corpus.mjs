#!/usr/bin/env node
// test_real_episode_replay_corpus.mjs - real Mac mini IVE autocode replay coverage.

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildRealEpisodeScenarioFixtures,
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  loadRealEpisodeCorpus,
  validateRealEpisodeCorpus,
} from "../scripts/lib/ive_real_episode_corpus.mjs";
import {
  runIveScenarioFixture,
  runIveScenarioSuite,
  writeIveScenarioReport,
} from "../scripts/lib/ive_scenario_harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` — ${details}` : ""}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectKeys(entry, keys);
  }
  return keys;
}

function collectValues(value, values = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectValues(entry, values);
    return values;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") values.push(value);
    return values;
  }
  for (const entry of Object.values(value)) collectValues(entry, values);
  return values;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function routeActions(fixtures) {
  return unique(fixtures.map((fixture) => fixture.packet.fact_routes[0]?.valid_next_action));
}

function routeStatuses(fixtures) {
  return unique(fixtures.map((fixture) => fixture.packet.fact_routes[0]?.status));
}

console.log("\nReal Mac Mini IVE Episode Replay Corpus Tests\n");

const loaded = loadRealEpisodeCorpus(DEFAULT_REAL_EPISODE_CORPUS_PATH);
const corpus = loaded.corpus;
const validation = validateRealEpisodeCorpus(corpus);
const requiredLeakageDiagnostics = [
  "leakage_boundary",
  "data_lineage",
  "controls_baselines",
  "diagnostic_only",
  "result_claim_validation",
];
const requiredMissedFeatureDiagnostics = [
  "candidate_signal",
  "edge_mechanism",
  "target_outcome",
  "expected_metric",
  "known_at_time_feature_availability",
  "leakage_check",
  "controls_baselines",
  "benchmark_comparison",
  "strongest_counterargument",
  "next_experiment",
  "diagnostic_only",
  "result_claim_validation",
];
const requiredExperimentLedgerDiagnostics = [
  "experiment_record",
  "run_record",
  "command",
  "config_hash",
  "dataset_source_hash",
  "split_id",
  "objective_version",
  "baseline_refs",
  "result_artifact",
  "run_class",
  "target_outcome",
  "data_lineage",
  "known_at_time_split_lineage",
  "temporal_leakage_handling",
  "controls_baselines",
  "benchmark_comparison",
  "alpha_discovery_loop",
  "diagnostic_only",
  "result_claim_validation",
];
const requiredOptimizerScaleDiagnostics = [
  "run_class",
  "trial_count",
  "unique_param_count",
  "active_param_count",
  "search_surface_hash",
  "search_surface",
  "objective_version",
  "objective_frozen",
  "eval_feedback_tuning",
  "target_outcome",
  "data_lineage",
  "known_at_time_split_lineage",
  "temporal_leakage_handling",
  "controls_baselines",
  "benchmark_comparison",
  "alpha_discovery_loop",
  "scale_verdict",
  "diagnostic_only",
  "result_claim_validation",
];
const requiredSoftwareValidationPathDiagnostics = [
  "validation_case",
  "exercised_system_path",
  "contract_owner",
  "direct_plus_conformance_parity",
  "validation_layers",
  "detected_failure_modes",
  "target_outcome",
  "data_lineage",
  "known_at_time_split_lineage",
  "temporal_leakage_handling",
  "controls_baselines",
  "alpha_discovery_loop",
  "migration_smoke_required",
  "configuration_default_parity",
  "quant_results_validation",
  "diagnostic_only",
  "result_claim_validation",
];
const requiredControlsCalibrationReplayDiagnostics = [
  "target_outcome",
  "data_lineage",
  "known_at_time_evaluation_boundary",
  "temporal_leakage_handling",
  "controls_baselines",
  "benchmark_comparison",
  "calibration_check",
  "stability_confidence",
  "strongest_counterargument",
  "alpha_discovery_loop",
  "next_experiment",
  "evidence_families",
  "diagnostic_only",
  "result_claim_validation",
];
const softwareValidationFailureModes = [
  "wrapper_only_proof",
  "adapter_bypass",
  "duplicate_validation",
  "brittle_migration_path",
  "convoluted_implementation_route",
];
const controlsCalibrationEvidenceFamilies = [
  "market_baseline",
  "naive_baseline",
  "current_production_baseline",
  "shuffled_baseline",
  "ablation_baseline",
  "calibration_curve",
  "brier_score",
  "log_loss",
];

assert(existsSync(DEFAULT_REAL_EPISODE_CORPUS_PATH), "real episode corpus fixture exists");
assert(validation.ok, "real episode corpus schema validates", JSON.stringify(validation.issues.slice(0, 3)));
assert(validation.summary.episode_count >= 10, "corpus has at least 10 real episodes");
assert(validation.summary.episode_count === 14, "corpus has the planned 14 episode seed set");
assert(validation.summary.quant_guard_count >= 12, "corpus has broad quant guard coverage");
assert(
  validation.summary.leakage_recurrence_count >= 1 && validation.summary.leakage_recurrence_count <= 20,
  "corpus has bounded leakage recurrence fixtures",
  String(validation.summary.leakage_recurrence_count),
);
assert(
  validation.summary.missed_feature_replay_count >= 1 && validation.summary.missed_feature_replay_count <= 20,
  "corpus has bounded missed-feature replay fixtures",
  String(validation.summary.missed_feature_replay_count),
);
assert(
  validation.summary.experiment_ledger_provenance_count >= 1 &&
    validation.summary.experiment_ledger_provenance_count <= 20,
  "corpus has bounded experiment-ledger provenance fixtures",
  String(validation.summary.experiment_ledger_provenance_count),
);
assert(
  validation.summary.optimizer_scale_contract_count >= 1 &&
    validation.summary.optimizer_scale_contract_count <= 20,
  "corpus has bounded optimizer-scale contract fixtures",
  String(validation.summary.optimizer_scale_contract_count),
);
assert(
  validation.summary.software_validation_path_count >= 1 &&
    validation.summary.software_validation_path_count <= 20,
  "corpus has bounded software-validation path fixtures",
  String(validation.summary.software_validation_path_count),
);
assert(
  validation.summary.controls_calibration_replay_count >= 1 &&
    validation.summary.controls_calibration_replay_count <= 20,
  "corpus has bounded controls/calibration replay fixtures",
  String(validation.summary.controls_calibration_replay_count),
);
assert(
  validation.summary.knowledge_trigger_count === validation.summary.episode_count,
  "every episode has a Knowledge Trigger candidate",
);

const requiredFamilies = ["trueskill", "ipbs_ufc", "polymarket", "valueinvesting", "evolution_automation"];
for (const family of requiredFamilies) {
  assert(validation.summary.families.includes(family), `family covered: ${family}`);
}

const forbiddenKeys = new Set([
  "raw_excerpt",
  "raw_source_excerpt",
  "source_text",
  "raw_source_text",
  "copied_excerpt",
  "quote",
]);
const foundForbiddenKeys = collectKeys(corpus).filter((key) => forbiddenKeys.has(key));
assert(foundForbiddenKeys.length === 0, "corpus contains no raw source excerpt keys", foundForbiddenKeys.join(", "));

const absoluteSourcePaths = asArray(corpus.episodes)
  .flatMap((episode) => asArray(episode.source_refs))
  .map((ref) => ref.source_path)
  .filter((sourcePath) => typeof sourcePath === "string" && sourcePath.startsWith("/"));
assert(absoluteSourcePaths.length === 0, "source refs use project-relative paths");

const sourceRefHashes = asArray(corpus.episodes)
  .flatMap((episode) => asArray(episode.source_refs))
  .map((ref) => ref.source_sha256);
assert(
  sourceRefHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
  "every source ref has a 64-character sha256",
);

const corpusTextValues = collectValues(corpus);
assert(
  corpusTextValues.every((value) => !value.includes("/Users/stelios/Documents/Github/")),
  "corpus does not embed absolute local project paths",
);

const fixtures = buildRealEpisodeScenarioFixtures(corpus);
assert(fixtures.length === validation.summary.episode_count, "adapter emits one scenario fixture per episode");
const leakageFixtures = fixtures.filter((fixture) => fixture.leakage_recurrence);
assert(leakageFixtures.length === validation.summary.leakage_recurrence_count, "adapter preserves leakage recurrence fixtures");
for (const fixture of leakageFixtures) {
  assert(!!fixture.leakage_recurrence.leakage_vector, `${fixture.id} names a leakage vector`);
  assert(!!fixture.leakage_recurrence.known_at_time_statement, `${fixture.id} states known-at-time proof`);
  assert(!!fixture.leakage_recurrence.temporal_split, `${fixture.id} states temporal split proof`);
  assert(
    asArray(fixture.leakage_recurrence.controls_baselines).length >= 1,
    `${fixture.id} carries controls/baselines`,
  );
  const diagnostics = asArray(fixture.leakage_recurrence.required_diagnostics);
  for (const diagnostic of requiredLeakageDiagnostics) {
    assert(diagnostics.includes(diagnostic), `${fixture.id} requires diagnostic ${diagnostic}`);
  }
}
const missedFeatureFixtures = fixtures.filter((fixture) => fixture.missed_feature_replay);
assert(
  missedFeatureFixtures.length === validation.summary.missed_feature_replay_count,
  "adapter preserves missed-feature replay fixtures",
);
for (const fixture of missedFeatureFixtures) {
  assert(!!fixture.missed_feature_replay.candidate_signal, `${fixture.id} names a candidate signal`);
  assert(!!fixture.missed_feature_replay.edge_mechanism, `${fixture.id} states edge mechanism hypothesis`);
  assert(!!fixture.missed_feature_replay.target_outcome, `${fixture.id} states target outcome`);
  assert(!!fixture.missed_feature_replay.expected_metric, `${fixture.id} states expected metric`);
  assert(
    !!fixture.missed_feature_replay.known_at_time_feature_availability,
    `${fixture.id} states known-at-time feature availability`,
  );
  assert(!!fixture.missed_feature_replay.leakage_check, `${fixture.id} states leakage check`);
  assert(
    asArray(fixture.missed_feature_replay.controls_baselines).length >= 1,
    `${fixture.id} carries missed-feature controls/baselines`,
  );
  assert(!!fixture.missed_feature_replay.benchmark_comparison, `${fixture.id} states benchmark comparison`);
  assert(
    !!fixture.missed_feature_replay.strongest_counterargument,
    `${fixture.id} states strongest counterargument`,
  );
  assert(!!fixture.missed_feature_replay.next_experiment, `${fixture.id} states next experiment`);
  const diagnostics = asArray(fixture.missed_feature_replay.required_diagnostics);
  for (const diagnostic of requiredMissedFeatureDiagnostics) {
    assert(diagnostics.includes(diagnostic), `${fixture.id} requires missed-feature diagnostic ${diagnostic}`);
  }
  assert(
    fixture.missed_feature_replay.result_claim_validation?.promotion_allowed === false &&
      fixture.missed_feature_replay.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(fixture.missed_feature_replay.result_claim_validation?.result_claims).length === 0,
    `${fixture.id} keeps missed-feature replay diagnostic-only`,
  );
}
const experimentLedgerFixtures = fixtures.filter((fixture) => fixture.experiment_ledger_provenance);
assert(
  experimentLedgerFixtures.length === validation.summary.experiment_ledger_provenance_count,
  "adapter preserves experiment-ledger provenance fixtures",
);
for (const fixture of experimentLedgerFixtures) {
  const ledger = fixture.experiment_ledger_provenance;
  assert(!!ledger.experiment_record, `${fixture.id} has experiment record`);
  assert(!!ledger.run_record, `${fixture.id} has run record`);
  assert(!!ledger.command, `${fixture.id} has command provenance`);
  assert(!!ledger.config_hash, `${fixture.id} has config hash`);
  assert(!!ledger.dataset_source_hash, `${fixture.id} has dataset/source hash`);
  assert(!!ledger.split_id, `${fixture.id} has split id`);
  assert(!!ledger.objective_version, `${fixture.id} has objective version`);
  assert(asArray(ledger.baseline_refs).length >= 1, `${fixture.id} has baseline refs`);
  assert(!!ledger.result_artifact, `${fixture.id} has result artifact`);
  assert(!!ledger.run_class, `${fixture.id} has run class`);
  assert(!!ledger.target_outcome, `${fixture.id} has target outcome`);
  assert(!!ledger.data_lineage, `${fixture.id} has data lineage`);
  assert(!!ledger.known_at_time_split_lineage, `${fixture.id} has known-at-time split lineage`);
  assert(!!ledger.temporal_leakage_handling, `${fixture.id} has temporal leakage handling`);
  assert(asArray(ledger.controls_baselines).length >= 1, `${fixture.id} has controls/baselines`);
  assert(!!ledger.benchmark_comparison, `${fixture.id} has benchmark comparison`);
  assert(!!ledger.alpha_discovery_loop, `${fixture.id} has alpha discovery loop`);
  const diagnostics = asArray(ledger.required_diagnostics);
  for (const diagnostic of requiredExperimentLedgerDiagnostics) {
    assert(diagnostics.includes(diagnostic), `${fixture.id} requires experiment-ledger diagnostic ${diagnostic}`);
  }
  assert(
    ledger.result_claim_validation?.promotion_allowed === false &&
      ledger.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(ledger.result_claim_validation?.result_claims).length === 0,
    `${fixture.id} keeps experiment ledger diagnostic-only`,
  );
}
const optimizerScaleFixtures = fixtures.filter((fixture) => fixture.optimizer_scale_contract);
assert(
  optimizerScaleFixtures.length === validation.summary.optimizer_scale_contract_count,
  "adapter preserves optimizer-scale contract fixtures",
);
for (const fixture of optimizerScaleFixtures) {
  const scale = fixture.optimizer_scale_contract;
  assert(!!scale.run_class, `${fixture.id} has optimizer run class`);
  assert(Number.isFinite(Number(scale.trial_count)), `${fixture.id} has optimizer trial count`);
  assert(Number.isFinite(Number(scale.unique_param_count)), `${fixture.id} has unique parameter count`);
  assert(Number.isFinite(Number(scale.active_param_count)), `${fixture.id} has active parameter count`);
  assert(!!scale.search_surface_hash, `${fixture.id} has search surface hash`);
  assert(asArray(scale.search_surface).length >= 1, `${fixture.id} has search surface dimensions`);
  assert(!!scale.objective_version, `${fixture.id} has optimizer objective version`);
  assert(scale.objective_frozen === true, `${fixture.id} freezes optimizer objective`);
  assert(scale.eval_feedback_tuning === false, `${fixture.id} blocks eval-feedback tuning`);
  assert(!!scale.target_outcome, `${fixture.id} has optimizer target outcome`);
  assert(!!scale.data_lineage, `${fixture.id} has optimizer data lineage`);
  assert(!!scale.known_at_time_split_lineage, `${fixture.id} has optimizer known-at-time split lineage`);
  assert(!!scale.temporal_leakage_handling, `${fixture.id} has optimizer temporal leakage handling`);
  assert(asArray(scale.controls_baselines).length >= 1, `${fixture.id} has optimizer controls/baselines`);
  assert(!!scale.benchmark_comparison, `${fixture.id} has optimizer benchmark comparison`);
  assert(!!scale.alpha_discovery_loop, `${fixture.id} has optimizer alpha discovery loop`);
  assert(!!scale.scale_verdict, `${fixture.id} has optimizer scale verdict`);
  const diagnostics = asArray(scale.required_diagnostics);
  for (const diagnostic of requiredOptimizerScaleDiagnostics) {
    assert(diagnostics.includes(diagnostic), `${fixture.id} requires optimizer-scale diagnostic ${diagnostic}`);
  }
  assert(
    scale.result_claim_validation?.promotion_allowed === false &&
      scale.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(scale.result_claim_validation?.result_claims).length === 0,
    `${fixture.id} keeps optimizer scale diagnostic-only`,
  );
}
const softwareValidationPathFixtures = fixtures.filter((fixture) => fixture.software_validation_path);
assert(
  softwareValidationPathFixtures.length === validation.summary.software_validation_path_count,
  "adapter preserves software-validation path fixtures",
);
const observedSoftwareFailureModes = unique(
  softwareValidationPathFixtures.flatMap((fixture) => asArray(fixture.software_validation_path.detected_failure_modes)),
);
for (const mode of softwareValidationFailureModes) {
  assert(observedSoftwareFailureModes.includes(mode), `software-validation mode covered: ${mode}`);
}
for (const fixture of softwareValidationPathFixtures) {
  const softwarePath = fixture.software_validation_path;
  assert(!!softwarePath.validation_case, `${fixture.id} has software validation case`);
  assert(!!softwarePath.exercised_system_path, `${fixture.id} has exercised system path`);
  assert(!!softwarePath.contract_owner, `${fixture.id} has contract owner`);
  assert(!!softwarePath.direct_plus_conformance_parity, `${fixture.id} has direct plus conformance parity`);
  assert(asArray(softwarePath.validation_layers).length >= 1, `${fixture.id} has validation layers`);
  assert(asArray(softwarePath.detected_failure_modes).length >= 1, `${fixture.id} has detected failure modes`);
  assert(
    asArray(softwarePath.detected_failure_modes).some((mode) => softwareValidationFailureModes.includes(mode)),
    `${fixture.id} detects a recognized false-validation mode`,
  );
  assert(!!softwarePath.target_outcome, `${fixture.id} has software validation target outcome`);
  assert(!!softwarePath.data_lineage, `${fixture.id} has software validation data lineage`);
  assert(!!softwarePath.known_at_time_split_lineage, `${fixture.id} has software validation known-at-time lineage`);
  assert(!!softwarePath.temporal_leakage_handling, `${fixture.id} has software validation temporal handling`);
  assert(asArray(softwarePath.controls_baselines).length >= 1, `${fixture.id} has software controls/baselines`);
  assert(!!softwarePath.alpha_discovery_loop, `${fixture.id} has software alpha discovery loop`);
  assert(softwarePath.migration_smoke_required === true, `${fixture.id} requires migration smoke`);
  assert(!!softwarePath.configuration_default_parity, `${fixture.id} has configuration/default parity`);
  assert(
    softwarePath.quant_results_validation_required === true,
    `${fixture.id} requires quant results validation`,
  );
  const diagnostics = asArray(softwarePath.required_diagnostics);
  for (const diagnostic of requiredSoftwareValidationPathDiagnostics) {
    assert(diagnostics.includes(diagnostic), `${fixture.id} requires software-path diagnostic ${diagnostic}`);
  }
  assert(
    softwarePath.result_claim_validation?.promotion_allowed === false &&
      softwarePath.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(softwarePath.result_claim_validation?.result_claims).length === 0,
    `${fixture.id} keeps software validation diagnostic-only`,
  );
}
const controlsCalibrationFixtures = fixtures.filter((fixture) => fixture.controls_calibration_replay);
assert(
  controlsCalibrationFixtures.length === validation.summary.controls_calibration_replay_count,
  "adapter preserves controls/calibration replay fixtures",
);
for (const fixture of controlsCalibrationFixtures) {
  const replay = fixture.controls_calibration_replay;
  assert(!!replay.target_outcome, `${fixture.id} has controls/calibration target outcome`);
  assert(!!replay.data_lineage, `${fixture.id} has controls/calibration data lineage`);
  assert(!!replay.as_of, `${fixture.id} has controls/calibration as-of timestamp`);
  assert(
    !!replay.known_at_time_evaluation_boundary,
    `${fixture.id} has known-at-time evaluation boundary`,
  );
  assert(
    !!replay.temporal_leakage_handling,
    `${fixture.id} has controls/calibration temporal leakage handling`,
  );
  assert(asArray(replay.controls_baselines).length >= 1, `${fixture.id} has controls/calibration baselines`);
  assert(!!replay.benchmark_comparison, `${fixture.id} has controls/calibration benchmark comparison`);
  assert(!!replay.calibration_check, `${fixture.id} has calibration check`);
  assert(!!replay.stability_confidence, `${fixture.id} has stability confidence`);
  assert(!!replay.strongest_counterargument, `${fixture.id} has strongest counterargument`);
  assert(!!replay.alpha_discovery_loop, `${fixture.id} has controls/calibration alpha loop`);
  assert(!!replay.next_experiment, `${fixture.id} has controls/calibration next experiment`);
  assert(asArray(replay.evidence_families).length >= 1, `${fixture.id} has evidence families`);
  assert(
    asArray(replay.evidence_families).some((family) => controlsCalibrationEvidenceFamilies.includes(family)),
    `${fixture.id} has a recognized controls/calibration evidence family`,
  );
  const diagnostics = asArray(replay.required_diagnostics);
  for (const diagnostic of requiredControlsCalibrationReplayDiagnostics) {
    assert(
      diagnostics.includes(diagnostic),
      `${fixture.id} requires controls/calibration diagnostic ${diagnostic}`,
    );
  }
  assert(
    replay.result_claim_validation?.promotion_allowed === false &&
      replay.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(replay.result_claim_validation?.result_claims).length === 0,
    `${fixture.id} keeps controls/calibration replay diagnostic-only`,
  );
}

for (const action of ["fix_now", "ticket_now", "run_experiment", "ask_user", "accept_limitation"]) {
  assert(routeActions(fixtures).includes(action), `route action covered: ${action}`);
}
for (const status of ["routed", "deferred_with_ticket", "accepted"]) {
  assert(routeStatuses(fixtures).includes(status), `route status covered: ${status}`);
}

const ticketRoutes = fixtures.filter((fixture) => fixture.expected.ticket_route_count === 1);
assert(ticketRoutes.length >= 4, "multiple real episodes route to Program Manager tickets");
assert(
  fixtures.some((fixture) => fixture.expected.valid_next_action === "ask_user" && fixture.expected.user_decision_required === true),
  "autocode ambiguity can require an explicit user decision",
);

const report = runIveScenarioSuite(fixtures, {
  clock: () => new Date("2026-06-10T00:00:00.000Z"),
});
const written = writeIveScenarioReport(report, {
  cwd: repoRoot,
  runId: "real-episode-replay-corpus-test",
});

assert(report.ok, "real episode replay suite passes");
assert(report.status === "PASS", "suite report status is PASS");
assert(report.summary.total === fixtures.length, "suite report counts every corpus fixture");
assert(report.summary.failed === 0, "suite report has no failed scenario expectations");
assert(report.quant_results_validation.status === "PASS", "quant results validation guard passes");
assert(report.quant_results_validation.promotion_allowed === false, "quant replay forbids promotion");
assert(report.quant_results_validation.result_claims.length === 0, "quant replay emits no result claims");
assert(
  report.quant_results_validation.checks.every((check) => check.promotion_verdict === "diagnostic_only"),
  "every quant replay remains diagnostic only",
);
const leakageChecks = report.quant_results_validation.checks.filter((check) => check.leakage_recurrence);
assert(leakageChecks.length === leakageFixtures.length, "quant validation reports leakage recurrence checks");
for (const check of leakageChecks) {
  assert(!!check.leakage_vector, `${check.scenario_id} report includes leakage vector`);
  assert(!!check.temporal_split, `${check.scenario_id} report includes temporal split`);
  assert(asArray(check.controls_baselines).length >= 1, `${check.scenario_id} report includes controls/baselines`);
  assert(check.diagnostic_only === true, `${check.scenario_id} report includes diagnostic_only flag`);
  assert(
    check.result_claim_validation?.promotion_allowed === false &&
      check.result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} report blocks result claims`,
  );
  for (const diagnostic of requiredLeakageDiagnostics) {
    assert(asArray(check.required_diagnostics).includes(diagnostic), `${check.scenario_id} report carries ${diagnostic}`);
  }
}
const missedFeatureChecks = report.quant_results_validation.checks.filter((check) => check.missed_feature_replay);
assert(missedFeatureChecks.length === missedFeatureFixtures.length, "quant validation reports missed-feature replay checks");
for (const check of missedFeatureChecks) {
  assert(!!check.candidate_signal, `${check.scenario_id} report includes candidate signal`);
  assert(!!check.edge_mechanism, `${check.scenario_id} report includes edge mechanism`);
  assert(!!check.missed_feature_target_outcome, `${check.scenario_id} report includes missed-feature target outcome`);
  assert(!!check.expected_metric, `${check.scenario_id} report includes expected metric`);
  assert(
    !!check.known_at_time_feature_availability,
    `${check.scenario_id} report includes known-at-time feature availability`,
  );
  assert(!!check.leakage_check, `${check.scenario_id} report includes missed-feature leakage check`);
  assert(
    asArray(check.missed_feature_controls_baselines).length >= 1,
    `${check.scenario_id} report includes missed-feature controls/baselines`,
  );
  assert(!!check.benchmark_comparison, `${check.scenario_id} report includes benchmark comparison`);
  assert(!!check.strongest_counterargument, `${check.scenario_id} report includes strongest counterargument`);
  assert(!!check.next_experiment, `${check.scenario_id} report includes next experiment`);
  assert(check.diagnostic_only === true, `${check.scenario_id} missed-feature report is diagnostic only`);
  assert(
    check.missed_feature_result_claim_validation?.promotion_allowed === false &&
      check.missed_feature_result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.missed_feature_result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} missed-feature report blocks result claims`,
  );
  for (const diagnostic of requiredMissedFeatureDiagnostics) {
    assert(
      asArray(check.missed_feature_required_diagnostics).includes(diagnostic),
      `${check.scenario_id} report carries missed-feature ${diagnostic}`,
    );
  }
}
const experimentLedgerChecks = report.quant_results_validation.checks.filter((check) => check.experiment_ledger_provenance);
assert(
  experimentLedgerChecks.length === experimentLedgerFixtures.length,
  "quant validation reports experiment-ledger provenance checks",
);
for (const check of experimentLedgerChecks) {
  assert(!!check.experiment_record, `${check.scenario_id} report includes experiment record`);
  assert(!!check.run_record, `${check.scenario_id} report includes run record`);
  assert(!!check.experiment_command, `${check.scenario_id} report includes command`);
  assert(!!check.config_hash, `${check.scenario_id} report includes config hash`);
  assert(!!check.dataset_source_hash, `${check.scenario_id} report includes dataset/source hash`);
  assert(!!check.split_id, `${check.scenario_id} report includes split id`);
  assert(!!check.objective_version, `${check.scenario_id} report includes objective version`);
  assert(asArray(check.baseline_refs).length >= 1, `${check.scenario_id} report includes baseline refs`);
  assert(!!check.result_artifact, `${check.scenario_id} report includes result artifact`);
  assert(!!check.experiment_run_class, `${check.scenario_id} report includes run class`);
  assert(!!check.experiment_target_outcome, `${check.scenario_id} report includes experiment target outcome`);
  assert(!!check.experiment_data_lineage, `${check.scenario_id} report includes experiment data lineage`);
  assert(!!check.experiment_as_of, `${check.scenario_id} report includes experiment as-of timestamp`);
  assert(
    !!check.known_at_time_split_lineage,
    `${check.scenario_id} report includes known-at-time split lineage`,
  );
  assert(!!check.temporal_leakage_handling, `${check.scenario_id} report includes temporal leakage handling`);
  assert(
    asArray(check.experiment_controls_baselines).length >= 1,
    `${check.scenario_id} report includes experiment controls/baselines`,
  );
  assert(
    !!check.experiment_benchmark_comparison,
    `${check.scenario_id} report includes experiment benchmark comparison`,
  );
  assert(!!check.alpha_discovery_loop, `${check.scenario_id} report includes alpha discovery loop`);
  assert(check.diagnostic_only === true, `${check.scenario_id} experiment ledger report is diagnostic only`);
  assert(
    check.experiment_result_claim_validation?.promotion_allowed === false &&
      check.experiment_result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.experiment_result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} experiment ledger report blocks result claims`,
  );
  for (const diagnostic of requiredExperimentLedgerDiagnostics) {
    assert(
      asArray(check.experiment_required_diagnostics).includes(diagnostic),
      `${check.scenario_id} report carries experiment-ledger ${diagnostic}`,
    );
  }
}
const optimizerScaleChecks = report.quant_results_validation.checks.filter((check) => check.optimizer_scale_contract);
assert(
  optimizerScaleChecks.length === optimizerScaleFixtures.length,
  "quant validation reports optimizer-scale contract checks",
);
for (const check of optimizerScaleChecks) {
  assert(!!check.optimizer_run_class, `${check.scenario_id} report includes optimizer run class`);
  assert(Number.isFinite(Number(check.optimizer_trial_count)), `${check.scenario_id} report includes trial count`);
  assert(
    Number.isFinite(Number(check.optimizer_unique_param_count)),
    `${check.scenario_id} report includes unique parameter count`,
  );
  assert(
    Number.isFinite(Number(check.optimizer_active_param_count)),
    `${check.scenario_id} report includes active parameter count`,
  );
  assert(!!check.optimizer_search_surface_hash, `${check.scenario_id} report includes search surface hash`);
  assert(asArray(check.optimizer_search_surface).length >= 1, `${check.scenario_id} report includes search surface`);
  assert(!!check.optimizer_objective_version, `${check.scenario_id} report includes objective version`);
  assert(check.optimizer_objective_frozen === true, `${check.scenario_id} report includes frozen objective`);
  assert(check.optimizer_eval_feedback_tuning === false, `${check.scenario_id} report blocks eval-feedback tuning`);
  assert(!!check.optimizer_scale_verdict, `${check.scenario_id} report includes scale verdict`);
  assert(!!check.optimizer_target_outcome, `${check.scenario_id} report includes optimizer target outcome`);
  assert(!!check.optimizer_data_lineage, `${check.scenario_id} report includes optimizer data lineage`);
  assert(!!check.optimizer_as_of, `${check.scenario_id} report includes optimizer as-of timestamp`);
  assert(
    !!check.optimizer_known_at_time_split_lineage,
    `${check.scenario_id} report includes optimizer known-at-time split lineage`,
  );
  assert(
    !!check.optimizer_temporal_leakage_handling,
    `${check.scenario_id} report includes optimizer temporal leakage handling`,
  );
  assert(
    asArray(check.optimizer_controls_baselines).length >= 1,
    `${check.scenario_id} report includes optimizer controls/baselines`,
  );
  assert(!!check.optimizer_benchmark_comparison, `${check.scenario_id} report includes optimizer benchmark comparison`);
  assert(!!check.optimizer_alpha_discovery_loop, `${check.scenario_id} report includes optimizer alpha discovery loop`);
  assert(check.diagnostic_only === true, `${check.scenario_id} optimizer-scale report is diagnostic only`);
  assert(
    check.optimizer_result_claim_validation?.promotion_allowed === false &&
      check.optimizer_result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.optimizer_result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} optimizer-scale report blocks result claims`,
  );
  for (const diagnostic of requiredOptimizerScaleDiagnostics) {
    assert(
      asArray(check.optimizer_required_diagnostics).includes(diagnostic),
      `${check.scenario_id} report carries optimizer-scale ${diagnostic}`,
    );
  }
}
const softwareValidationPathChecks = report.quant_results_validation.checks.filter((check) => check.software_validation_path);
assert(
  softwareValidationPathChecks.length === softwareValidationPathFixtures.length,
  "quant validation reports software-validation path checks",
);
for (const check of softwareValidationPathChecks) {
  assert(!!check.software_validation_case, `${check.scenario_id} report includes software validation case`);
  assert(!!check.software_exercised_system_path, `${check.scenario_id} report includes exercised system path`);
  assert(!!check.software_contract_owner, `${check.scenario_id} report includes contract owner`);
  assert(
    !!check.software_direct_plus_conformance_parity,
    `${check.scenario_id} report includes direct plus conformance parity`,
  );
  assert(asArray(check.software_validation_layers).length >= 1, `${check.scenario_id} report includes validation layers`);
  assert(
    asArray(check.software_detected_failure_modes).length >= 1,
    `${check.scenario_id} report includes software failure modes`,
  );
  assert(
    asArray(check.software_detected_failure_modes).some((mode) => softwareValidationFailureModes.includes(mode)),
    `${check.scenario_id} report includes recognized software failure mode`,
  );
  assert(!!check.software_target_outcome, `${check.scenario_id} report includes software target outcome`);
  assert(!!check.software_data_lineage, `${check.scenario_id} report includes software data lineage`);
  assert(!!check.software_as_of, `${check.scenario_id} report includes software as-of timestamp`);
  assert(
    !!check.software_known_at_time_split_lineage,
    `${check.scenario_id} report includes software known-at-time lineage`,
  );
  assert(
    !!check.software_temporal_leakage_handling,
    `${check.scenario_id} report includes software temporal handling`,
  );
  assert(
    asArray(check.software_controls_baselines).length >= 1,
    `${check.scenario_id} report includes software controls/baselines`,
  );
  assert(!!check.software_alpha_discovery_loop, `${check.scenario_id} report includes software alpha loop`);
  assert(check.software_migration_smoke_required === true, `${check.scenario_id} report requires migration smoke`);
  assert(
    !!check.software_configuration_default_parity,
    `${check.scenario_id} report includes configuration/default parity`,
  );
  assert(
    check.software_quant_results_validation_required === true,
    `${check.scenario_id} report requires quant results validation`,
  );
  assert(
    check.software_wrapper_only_proof_detected ||
      check.software_adapter_bypass_detected ||
      check.software_duplicate_validation_detected ||
      check.software_brittle_migration_path_detected ||
      check.software_convoluted_implementation_route_detected,
    `${check.scenario_id} report exposes a software validation detection flag`,
  );
  assert(check.diagnostic_only === true, `${check.scenario_id} software validation report is diagnostic only`);
  assert(
    check.software_result_claim_validation?.promotion_allowed === false &&
      check.software_result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.software_result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} software validation report blocks result claims`,
  );
  for (const diagnostic of requiredSoftwareValidationPathDiagnostics) {
    assert(
      asArray(check.software_required_diagnostics).includes(diagnostic),
      `${check.scenario_id} report carries software-path ${diagnostic}`,
    );
  }
}
const controlsCalibrationChecks = report.quant_results_validation.checks.filter((check) => check.controls_calibration_replay);
assert(
  controlsCalibrationChecks.length === controlsCalibrationFixtures.length,
  "quant validation reports controls/calibration replay checks",
);
for (const check of controlsCalibrationChecks) {
  assert(
    !!check.controls_calibration_target_outcome,
    `${check.scenario_id} report includes controls/calibration target outcome`,
  );
  assert(
    !!check.controls_calibration_data_lineage,
    `${check.scenario_id} report includes controls/calibration data lineage`,
  );
  assert(
    !!check.controls_calibration_as_of,
    `${check.scenario_id} report includes controls/calibration as-of timestamp`,
  );
  assert(
    !!check.controls_calibration_known_at_time_evaluation_boundary,
    `${check.scenario_id} report includes controls/calibration known-at-time boundary`,
  );
  assert(
    !!check.controls_calibration_temporal_leakage_handling,
    `${check.scenario_id} report includes controls/calibration temporal handling`,
  );
  assert(
    asArray(check.controls_calibration_controls_baselines).length >= 1,
    `${check.scenario_id} report includes controls/calibration baselines`,
  );
  assert(
    !!check.controls_calibration_benchmark_comparison,
    `${check.scenario_id} report includes controls/calibration benchmark comparison`,
  );
  assert(
    !!check.controls_calibration_calibration_check,
    `${check.scenario_id} report includes calibration check`,
  );
  assert(
    !!check.controls_calibration_stability_confidence,
    `${check.scenario_id} report includes stability confidence`,
  );
  assert(
    !!check.controls_calibration_strongest_counterargument,
    `${check.scenario_id} report includes strongest counterargument`,
  );
  assert(
    !!check.controls_calibration_alpha_discovery_loop,
    `${check.scenario_id} report includes controls/calibration alpha loop`,
  );
  assert(
    !!check.controls_calibration_next_experiment,
    `${check.scenario_id} report includes controls/calibration next experiment`,
  );
  assert(
    asArray(check.controls_calibration_evidence_families).some((family) =>
      controlsCalibrationEvidenceFamilies.includes(family)
    ),
    `${check.scenario_id} report includes recognized controls/calibration evidence family`,
  );
  assert(check.diagnostic_only === true, `${check.scenario_id} controls/calibration report is diagnostic only`);
  assert(
    check.controls_calibration_result_claim_validation?.promotion_allowed === false &&
      check.controls_calibration_result_claim_validation?.promotion_verdict === "diagnostic_only" &&
      asArray(check.controls_calibration_result_claim_validation?.result_claims).length === 0,
    `${check.scenario_id} controls/calibration report blocks result claims`,
  );
  for (const diagnostic of requiredControlsCalibrationReplayDiagnostics) {
    assert(
      asArray(check.controls_calibration_required_diagnostics).includes(diagnostic),
      `${check.scenario_id} report carries controls/calibration ${diagnostic}`,
    );
  }
}

const missingTemporalProofFixture = JSON.parse(JSON.stringify(leakageFixtures[0]));
missingTemporalProofFixture.id = `${missingTemporalProofFixture.id}_missing_temporal_proof`;
missingTemporalProofFixture.leakage_recurrence.temporal_split = "";
const missingTemporalProofResult = runIveScenarioFixture(missingTemporalProofFixture);
const missingTemporalIssueCodes = asArray(missingTemporalProofResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingTemporalProofResult.ok, "missing temporal proof replay fails closed");
assert(missingTemporalProofResult.quant_guard.status === "FAIL", "missing temporal proof marks quant guard failed");
assert(
  missingTemporalIssueCodes.includes("leakage_recurrence_temporal_split_missing"),
  "missing temporal proof reports actionable leakage recurrence issue",
);
assert(missingTemporalProofResult.quant_guard.promotion_allowed === false, "missing temporal proof keeps promotion forbidden");
assert(
  missingTemporalProofResult.quant_guard.promotion_verdict === "diagnostic_only",
  "missing temporal proof remains diagnostic only",
);

const missingCalibrationCheckFixture = JSON.parse(JSON.stringify(controlsCalibrationFixtures[0]));
missingCalibrationCheckFixture.id = `${missingCalibrationCheckFixture.id}_missing_calibration_check`;
missingCalibrationCheckFixture.controls_calibration_replay.calibration_check = "";
const missingCalibrationCheckResult = runIveScenarioFixture(missingCalibrationCheckFixture);
const missingCalibrationCheckIssueCodes = asArray(missingCalibrationCheckResult.quant_guard?.issues)
  .map((issue) => issue.code);
assert(!missingCalibrationCheckResult.ok, "missing calibration check replay fails closed");
assert(
  missingCalibrationCheckResult.quant_guard.status === "FAIL",
  "missing calibration check marks quant guard failed",
);
assert(
  missingCalibrationCheckIssueCodes.includes("controls_calibration_calibration_check_missing"),
  "missing calibration check reports actionable controls/calibration issue",
);
assert(
  missingCalibrationCheckResult.quant_guard.promotion_allowed === false,
  "missing calibration check keeps promotion forbidden",
);
assert(
  missingCalibrationCheckResult.quant_guard.promotion_verdict === "diagnostic_only",
  "missing calibration check remains diagnostic only",
);

const missingControlsBaselineFixture = JSON.parse(JSON.stringify(controlsCalibrationFixtures[0]));
missingControlsBaselineFixture.id = `${missingControlsBaselineFixture.id}_missing_controls_baselines`;
missingControlsBaselineFixture.controls_calibration_replay.controls_baselines = [];
const missingControlsBaselineResult = runIveScenarioFixture(missingControlsBaselineFixture);
const missingControlsBaselineIssueCodes = asArray(missingControlsBaselineResult.quant_guard?.issues)
  .map((issue) => issue.code);
assert(!missingControlsBaselineResult.ok, "missing controls/calibration baseline replay fails closed");
assert(
  missingControlsBaselineIssueCodes.includes("controls_calibration_controls_baselines_missing"),
  "missing controls/calibration baseline reports actionable issue",
);
assert(
  missingControlsBaselineResult.quant_guard.promotion_allowed === false,
  "missing controls/calibration baseline keeps promotion forbidden",
);

const missingStabilityFixture = JSON.parse(JSON.stringify(controlsCalibrationFixtures[0]));
missingStabilityFixture.id = `${missingStabilityFixture.id}_missing_stability_confidence`;
missingStabilityFixture.controls_calibration_replay.stability_confidence = "";
const missingStabilityResult = runIveScenarioFixture(missingStabilityFixture);
const missingStabilityIssueCodes = asArray(missingStabilityResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingStabilityResult.ok, "missing stability confidence replay fails closed");
assert(
  missingStabilityIssueCodes.includes("controls_calibration_stability_confidence_missing"),
  "missing stability confidence reports actionable controls/calibration issue",
);
assert(missingStabilityResult.quant_guard.promotion_allowed === false, "missing stability keeps promotion forbidden");

const missingCounterargumentFixture = JSON.parse(JSON.stringify(controlsCalibrationFixtures[0]));
missingCounterargumentFixture.id = `${missingCounterargumentFixture.id}_missing_counterargument`;
missingCounterargumentFixture.controls_calibration_replay.strongest_counterargument = "";
const missingCounterargumentResult = runIveScenarioFixture(missingCounterargumentFixture);
const missingCounterargumentIssueCodes = asArray(missingCounterargumentResult.quant_guard?.issues)
  .map((issue) => issue.code);
assert(!missingCounterargumentResult.ok, "missing strongest counterargument replay fails closed");
assert(
  missingCounterargumentIssueCodes.includes("controls_calibration_strongest_counterargument_missing"),
  "missing strongest counterargument reports actionable controls/calibration issue",
);
assert(
  missingCounterargumentResult.quant_guard.promotion_allowed === false,
  "missing strongest counterargument keeps promotion forbidden",
);

const missingControlsClaimValidationFixture = JSON.parse(JSON.stringify(controlsCalibrationFixtures[0]));
missingControlsClaimValidationFixture.id = `${missingControlsClaimValidationFixture.id}_missing_claim_validation`;
delete missingControlsClaimValidationFixture.controls_calibration_replay.result_claim_validation;
const missingControlsClaimValidationResult = runIveScenarioFixture(missingControlsClaimValidationFixture);
const missingControlsClaimValidationIssueCodes = asArray(missingControlsClaimValidationResult.quant_guard?.issues)
  .map((issue) => issue.code);
assert(!missingControlsClaimValidationResult.ok, "missing controls/calibration claim validation fails closed");
assert(
  missingControlsClaimValidationIssueCodes.includes("controls_calibration_result_claim_validation_missing"),
  "missing controls/calibration claim validation reports explicit issue",
);
assert(
  missingControlsClaimValidationResult.quant_guard.promotion_allowed === false,
  "missing controls/calibration claim validation keeps promotion forbidden",
);

const missingExpectedMetricFixture = JSON.parse(JSON.stringify(missedFeatureFixtures[0]));
missingExpectedMetricFixture.id = `${missingExpectedMetricFixture.id}_missing_expected_metric`;
missingExpectedMetricFixture.missed_feature_replay.expected_metric = "";
const missingExpectedMetricResult = runIveScenarioFixture(missingExpectedMetricFixture);
const missingExpectedMetricIssueCodes = asArray(missingExpectedMetricResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingExpectedMetricResult.ok, "missing expected metric replay fails closed");
assert(
  missingExpectedMetricResult.quant_guard.status === "FAIL",
  "missing expected metric marks quant guard failed",
);
assert(
  missingExpectedMetricIssueCodes.includes("missed_feature_replay_expected_metric_missing"),
  "missing expected metric reports actionable missed-feature issue",
);
assert(
  missingExpectedMetricResult.quant_guard.promotion_allowed === false,
  "missing expected metric keeps promotion forbidden",
);
assert(
  missingExpectedMetricResult.quant_guard.promotion_verdict === "diagnostic_only",
  "missing expected metric remains diagnostic only",
);

const missingCommandFixture = JSON.parse(JSON.stringify(experimentLedgerFixtures[0]));
missingCommandFixture.id = `${missingCommandFixture.id}_missing_command`;
missingCommandFixture.experiment_ledger_provenance.command = "";
const missingCommandResult = runIveScenarioFixture(missingCommandFixture);
const missingCommandIssueCodes = asArray(missingCommandResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingCommandResult.ok, "missing experiment command replay fails closed");
assert(missingCommandResult.quant_guard.status === "FAIL", "missing experiment command marks quant guard failed");
assert(
  missingCommandIssueCodes.includes("experiment_ledger_command_missing"),
  "missing experiment command reports actionable ledger issue",
);
assert(missingCommandResult.quant_guard.promotion_allowed === false, "missing experiment command keeps promotion forbidden");
assert(
  missingCommandResult.quant_guard.promotion_verdict === "diagnostic_only",
  "missing experiment command remains diagnostic only",
);

const underpoweredSeriousSearchFixture = JSON.parse(JSON.stringify(optimizerScaleFixtures[0]));
underpoweredSeriousSearchFixture.id = `${underpoweredSeriousSearchFixture.id}_underpowered_serious_search`;
underpoweredSeriousSearchFixture.optimizer_scale_contract.run_class = "serious_search";
underpoweredSeriousSearchFixture.optimizer_scale_contract.scale_verdict = "underpowered";
underpoweredSeriousSearchFixture.optimizer_scale_contract.trial_count = 1;
underpoweredSeriousSearchFixture.optimizer_scale_contract.unique_param_count = 12;
underpoweredSeriousSearchFixture.optimizer_scale_contract.active_param_count = 3;
const underpoweredSeriousSearchResult = runIveScenarioFixture(underpoweredSeriousSearchFixture);
const underpoweredSeriousSearchIssueCodes = asArray(underpoweredSeriousSearchResult.quant_guard?.issues)
  .map((issue) => issue.code);
assert(!underpoweredSeriousSearchResult.ok, "underpowered serious-search replay fails closed");
assert(
  underpoweredSeriousSearchResult.quant_guard.status === "FAIL",
  "underpowered serious-search marks quant guard failed",
);
assert(
  underpoweredSeriousSearchIssueCodes.includes("optimizer_scale_underpowered_serious_search"),
  "underpowered serious-search reports actionable scale verdict issue",
);
assert(
  underpoweredSeriousSearchIssueCodes.includes("optimizer_scale_trial_budget_underpowered"),
  "underpowered serious-search reports actionable trial budget issue",
);
assert(
  underpoweredSeriousSearchResult.quant_guard.promotion_allowed === false,
  "underpowered serious-search keeps promotion forbidden",
);
assert(
  underpoweredSeriousSearchResult.quant_guard.promotion_verdict === "diagnostic_only",
  "underpowered serious-search remains diagnostic only",
);

const evalFeedbackFixture = JSON.parse(JSON.stringify(optimizerScaleFixtures[0]));
evalFeedbackFixture.id = `${evalFeedbackFixture.id}_eval_feedback_tuning`;
evalFeedbackFixture.optimizer_scale_contract.eval_feedback_tuning = true;
const evalFeedbackResult = runIveScenarioFixture(evalFeedbackFixture);
const evalFeedbackIssueCodes = asArray(evalFeedbackResult.quant_guard?.issues).map((issue) => issue.code);
assert(!evalFeedbackResult.ok, "eval-feedback tuning replay fails closed");
assert(evalFeedbackResult.quant_guard.status === "FAIL", "eval-feedback tuning marks quant guard failed");
assert(
  evalFeedbackIssueCodes.includes("optimizer_scale_eval_feedback_tuning_not_blocked"),
  "eval-feedback tuning reports actionable optimizer-scale issue",
);
assert(evalFeedbackResult.quant_guard.promotion_allowed === false, "eval-feedback tuning keeps promotion forbidden");
assert(
  evalFeedbackResult.quant_guard.promotion_verdict === "diagnostic_only",
  "eval-feedback tuning remains diagnostic only",
);

const missingSoftwarePathFixture = JSON.parse(JSON.stringify(softwareValidationPathFixtures[0]));
missingSoftwarePathFixture.id = `${missingSoftwarePathFixture.id}_missing_software_path`;
missingSoftwarePathFixture.software_validation_path.exercised_system_path = "";
const missingSoftwarePathResult = runIveScenarioFixture(missingSoftwarePathFixture);
const missingSoftwarePathIssueCodes = asArray(missingSoftwarePathResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingSoftwarePathResult.ok, "missing exercised-system path replay fails closed");
assert(
  missingSoftwarePathResult.quant_guard.status === "FAIL",
  "missing exercised-system path marks quant guard failed",
);
assert(
  missingSoftwarePathIssueCodes.includes("software_validation_path_exercised_system_path_missing"),
  "missing exercised-system path reports actionable software validation issue",
);
assert(
  missingSoftwarePathResult.quant_guard.promotion_allowed === false,
  "missing exercised-system path keeps promotion forbidden",
);
assert(
  missingSoftwarePathResult.quant_guard.promotion_verdict === "diagnostic_only",
  "missing exercised-system path remains diagnostic only",
);

const missingSoftwareOwnerFixture = JSON.parse(JSON.stringify(softwareValidationPathFixtures[0]));
missingSoftwareOwnerFixture.id = `${missingSoftwareOwnerFixture.id}_missing_software_owner`;
missingSoftwareOwnerFixture.software_validation_path.contract_owner = "";
const missingSoftwareOwnerResult = runIveScenarioFixture(missingSoftwareOwnerFixture);
const missingSoftwareOwnerIssueCodes = asArray(missingSoftwareOwnerResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingSoftwareOwnerResult.ok, "missing software contract owner replay fails closed");
assert(
  missingSoftwareOwnerIssueCodes.includes("software_validation_path_contract_owner_missing"),
  "missing software contract owner reports actionable software validation issue",
);
assert(missingSoftwareOwnerResult.quant_guard.promotion_allowed === false, "missing software owner keeps promotion forbidden");

const missingSoftwareParityFixture = JSON.parse(JSON.stringify(softwareValidationPathFixtures[0]));
missingSoftwareParityFixture.id = `${missingSoftwareParityFixture.id}_missing_software_parity`;
missingSoftwareParityFixture.software_validation_path.direct_plus_conformance_parity = "";
const missingSoftwareParityResult = runIveScenarioFixture(missingSoftwareParityFixture);
const missingSoftwareParityIssueCodes = asArray(missingSoftwareParityResult.quant_guard?.issues).map((issue) => issue.code);
assert(!missingSoftwareParityResult.ok, "missing direct-plus-conformance parity replay fails closed");
assert(
  missingSoftwareParityIssueCodes.includes("software_validation_path_direct_plus_conformance_parity_missing"),
  "missing direct-plus-conformance parity reports actionable software validation issue",
);
assert(missingSoftwareParityResult.quant_guard.promotion_allowed === false, "missing software parity keeps promotion forbidden");

const noSoftwareDetectionFixture = JSON.parse(JSON.stringify(softwareValidationPathFixtures[0]));
noSoftwareDetectionFixture.id = `${noSoftwareDetectionFixture.id}_no_software_detection`;
noSoftwareDetectionFixture.software_validation_path.detected_failure_modes = ["unknown_validation_smell"];
const noSoftwareDetectionResult = runIveScenarioFixture(noSoftwareDetectionFixture);
const noSoftwareDetectionIssueCodes = asArray(noSoftwareDetectionResult.quant_guard?.issues).map((issue) => issue.code);
assert(!noSoftwareDetectionResult.ok, "unrecognized software validation mode replay fails closed");
assert(
  noSoftwareDetectionIssueCodes.includes("software_validation_path_failure_mode_missing"),
  "unrecognized software validation mode reports actionable software validation issue",
);
assert(noSoftwareDetectionResult.quant_guard.promotion_allowed === false, "unrecognized software mode keeps promotion forbidden");

const scenarioActions = unique(report.scenarios.map((scenario) => scenario.user_verdict.valid_next_action));
for (const action of ["fix_now", "ticket_now", "run_experiment", "ask_user", "accept_limitation"]) {
  assert(scenarioActions.includes(action), `suite verdict action covered: ${action}`);
}

assert(written.scenarios_exists, "scenario proof report written");
assert(written.manifest_exists, "scenario proof manifest written");

console.log("\nReport:");
console.log(`  ${written.scenarios_relpath}`);
console.log(`  ${written.manifest_relpath}`);

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
