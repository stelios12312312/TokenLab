// ive_scenario_harness.mjs - deterministic IVE scenario fixture orchestration.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { validateIvePacket } from "./ive_packet_contract.mjs";
import { validateFactRouting } from "./ive_action_router.mjs";
import { buildIveUserVerdict } from "./ive_user_verdict.mjs";
import { mapIvePacketToProgramIntake } from "./ive_program_intake.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const IVE_SCENARIO_HARNESS_SCHEMA_VERSION = 1;
const MISSED_FEATURE_REPLAY_REQUIRED_DIAGNOSTICS = [
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
const EXPERIMENT_LEDGER_REQUIRED_DIAGNOSTICS = [
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
const OPTIMIZER_SCALE_REQUIRED_DIAGNOSTICS = [
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
const SOFTWARE_VALIDATION_PATH_REQUIRED_DIAGNOSTICS = [
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
const CONTROLS_CALIBRATION_REPLAY_REQUIRED_DIAGNOSTICS = [
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
const INTERPRETIVE_OPTIMIZER_RUN_CLASSES = new Set(["serious_search", "promotion_candidate"]);
const ADEQUATE_OPTIMIZER_SCALE_VERDICTS = new Set(["adequate", "promotion_ready"]);
const SOFTWARE_VALIDATION_FAILURE_MODES = new Set([
  "wrapper_only_proof",
  "adapter_bypass",
  "duplicate_validation",
  "brittle_migration_path",
  "convoluted_implementation_route",
]);
const CONTROLS_CALIBRATION_EVIDENCE_FAMILIES = new Set([
  "market_baseline",
  "naive_baseline",
  "current_production_baseline",
  "shuffled_baseline",
  "ablation_baseline",
  "calibration_curve",
  "brier_score",
  "log_loss",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueCodes(result) {
  return uniqueStrings(asArray(result?.errors).map((issue) => issue?.code));
}

function verdictBlockerCodes(verdict) {
  return uniqueStrings(asArray(verdict?.blockers).map((issue) => issue?.code));
}

function evidenceRefs(verdict) {
  return uniqueStrings(asArray(verdict?.evidence_links).map((entry) => entry?.ref));
}

function addAssertion(assertions, id, passed, expected, actual, message) {
  assertions.push({
    id,
    status: passed ? "PASS" : "FAIL",
    expected,
    actual,
    message,
  });
}

function expectEqual(assertions, id, actual, expected, message) {
  if (expected === undefined) return;
  addAssertion(assertions, id, actual === expected, expected, actual, message);
}

function expectIncludes(assertions, id, actualValues, expectedValues, message) {
  for (const expected of asArray(expectedValues)) {
    addAssertion(
      assertions,
      `${id}:${expected}`,
      actualValues.includes(expected),
      expected,
      actualValues,
      message,
    );
  }
}

function expectTextIncludes(assertions, id, actualValues, expectedValues, message) {
  const values = asArray(actualValues).map(asString);
  for (const expected of asArray(expectedValues)) {
    addAssertion(
      assertions,
      `${id}:${expected}`,
      values.some((value) => value.includes(expected)),
      expected,
      values,
      message,
    );
  }
}

function routeStatusCounts(routes = []) {
  const counts = {};
  for (const route of asArray(routes)) {
    const status = asString(route?.status) || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function evaluateExpectations({ fixture, packet, packetContract, routing, verdict, intake, quantGuard }) {
  const assertions = [];
  const expected = fixture.expected || {};
  const packetCodes = issueCodes(packetContract);
  const routingCodes = issueCodes(routing);
  const blockerCodes = verdictBlockerCodes(verdict);

  expectEqual(assertions, "packet.status", packetContract.status, expected.packet_status, "packet status matches");
  expectEqual(assertions, "routing.status", routing.status, expected.routing_status, "routing status matches");
  expectEqual(assertions, "verdict.status", verdict.status, expected.verdict_status, "verdict status matches");
  expectEqual(
    assertions,
    "verdict.fulfillment_status",
    verdict.fulfillment_status,
    expected.fulfillment_status,
    "fulfillment status matches",
  );
  expectEqual(
    assertions,
    "verdict.valid_next_action",
    verdict.valid_next_action,
    expected.valid_next_action,
    "next action matches",
  );
  expectEqual(
    assertions,
    "verdict.user_decision_required",
    verdict.user_decision_required,
    expected.user_decision_required,
    "user decision requirement matches",
  );
  expectEqual(assertions, "intake.status", intake.status, expected.intake_status, "intake mapping status matches");
  expectEqual(
    assertions,
    "intake.ticket_route_count",
    intake.ticket_route_count || 0,
    expected.ticket_route_count,
    "ticket route count matches",
  );

  expectIncludes(
    assertions,
    "packet.expected_error",
    packetCodes,
    expected.packet_error_codes,
    "expected packet error code is present",
  );
  expectIncludes(
    assertions,
    "routing.expected_error",
    routingCodes,
    expected.routing_error_codes,
    "expected routing error code is present",
  );
  expectIncludes(
    assertions,
    "verdict.expected_blocker",
    blockerCodes,
    expected.verdict_blocker_codes,
    "expected verdict blocker code is present",
  );
  expectTextIncludes(
    assertions,
    "verdict.non_claim",
    verdict.non_claims,
    expected.non_claims_include,
    "expected non-claim text is present",
  );
  expectIncludes(
    assertions,
    "verdict.evidence_ref",
    evidenceRefs(verdict),
    expected.evidence_refs,
    "expected evidence reference is present",
  );

  for (const [status, count] of Object.entries(expected.route_status_counts || {})) {
    expectEqual(
      assertions,
      `routes.status_count.${status}`,
      routeStatusCounts(packet.fact_routes)[status] || 0,
      count,
      `route status count for ${status} matches`,
    );
  }

  if (fixture.quant_guard) {
    expectEqual(
      assertions,
      "quant_guard.status",
      quantGuard.status,
      "PASS",
      "quant fixture guard validates",
    );
    expectEqual(
      assertions,
      "quant_guard.promotion_verdict",
      quantGuard.promotion_verdict,
      "diagnostic_only",
      "quant fixture does not promote result claims",
    );
    expectEqual(
      assertions,
      "quant_guard.promotion_allowed",
      quantGuard.promotion_allowed,
      false,
      "quant fixture forbids promotion",
    );
  }

  return assertions;
}

function validateQuantGuard(fixture) {
  if (!fixture.quant_guard) {
    return {
      applicable: false,
      status: "PASS",
      promotion_verdict: "not_applicable",
      promotion_allowed: false,
      issues: [],
    };
  }

  const guard = fixture.quant_guard;
  const requiredFields = [
    "target_outcome",
    "data_lineage",
    "as_of",
    "known_at_time",
    "leakage_boundary",
    "baseline",
    "calibration",
  ];
  const issues = [];
  for (const field of requiredFields) {
    if (!asString(guard[field])) {
      issues.push({
        code: "quant_guard_field_missing",
        field,
        message: `Quant fixture guard is missing ${field}`,
      });
    }
  }
  if (guard.promotion_allowed !== false) {
    issues.push({
      code: "quant_guard_promotion_not_forbidden",
      field: "promotion_allowed",
      message: "Quant fixture guard must explicitly forbid promotion",
    });
  }
  const recurrence = fixture.leakage_recurrence;
  const recurrenceResult = validateLeakageRecurrence(recurrence, guard);
  const missedFeatureResult = validateMissedFeatureReplay(fixture.missed_feature_replay);
  const experimentLedgerResult = validateExperimentLedgerProvenance(fixture.experiment_ledger_provenance);
  const optimizerScaleResult = validateOptimizerScaleContract(fixture.optimizer_scale_contract);
  const softwareValidationPathResult = validateSoftwareValidationPath(fixture.software_validation_path, fixture);
  const controlsCalibrationReplayResult = validateControlsCalibrationReplay(fixture.controls_calibration_replay);
  issues.push(...recurrenceResult.issues);
  issues.push(...missedFeatureResult.issues);
  issues.push(...experimentLedgerResult.issues);
  issues.push(...optimizerScaleResult.issues);
  issues.push(...softwareValidationPathResult.issues);
  issues.push(...controlsCalibrationReplayResult.issues);

  return {
    applicable: true,
    status: issues.length === 0 ? "PASS" : "FAIL",
    run_class: "fixture_guard",
    target_outcome: guard.target_outcome,
    data_lineage: guard.data_lineage,
    as_of: guard.as_of,
    known_at_time: guard.known_at_time,
    leakage_boundary: guard.leakage_boundary,
    baseline: guard.baseline,
    calibration: guard.calibration,
    leakage_recurrence: recurrenceResult.applicable,
    leakage_vector: recurrenceResult.leakage_vector,
    known_at_time_statement: recurrenceResult.known_at_time_statement,
    temporal_split: recurrenceResult.temporal_split,
    controls_baselines: recurrenceResult.controls_baselines,
    required_diagnostics: recurrenceResult.required_diagnostics,
    result_claim_validation: recurrenceResult.result_claim_validation ||
      missedFeatureResult.result_claim_validation ||
      experimentLedgerResult.result_claim_validation ||
      optimizerScaleResult.result_claim_validation ||
      softwareValidationPathResult.result_claim_validation ||
      controlsCalibrationReplayResult.result_claim_validation ||
      {
        promotion_allowed: false,
        promotion_verdict: "diagnostic_only",
        result_claims: [],
      },
    missed_feature_replay: missedFeatureResult.applicable,
    candidate_signal: missedFeatureResult.candidate_signal,
    edge_mechanism: missedFeatureResult.edge_mechanism,
    missed_feature_target_outcome: missedFeatureResult.target_outcome,
    expected_metric: missedFeatureResult.expected_metric,
    known_at_time_feature_availability: missedFeatureResult.known_at_time_feature_availability,
    leakage_check: missedFeatureResult.leakage_check,
    missed_feature_controls_baselines: missedFeatureResult.controls_baselines,
    benchmark_comparison: missedFeatureResult.benchmark_comparison,
    strongest_counterargument: missedFeatureResult.strongest_counterargument,
    next_experiment: missedFeatureResult.next_experiment,
    missed_feature_required_diagnostics: missedFeatureResult.required_diagnostics,
    missed_feature_result_claim_validation: missedFeatureResult.result_claim_validation,
    experiment_ledger_provenance: experimentLedgerResult.applicable,
    experiment_record: experimentLedgerResult.experiment_record,
    run_record: experimentLedgerResult.run_record,
    experiment_command: experimentLedgerResult.command,
    config_hash: experimentLedgerResult.config_hash,
    dataset_source_hash: experimentLedgerResult.dataset_source_hash,
    split_id: experimentLedgerResult.split_id,
    objective_version: experimentLedgerResult.objective_version,
    baseline_refs: experimentLedgerResult.baseline_refs,
    result_artifact: experimentLedgerResult.result_artifact,
    experiment_run_class: experimentLedgerResult.run_class,
    experiment_target_outcome: experimentLedgerResult.target_outcome,
    experiment_data_lineage: experimentLedgerResult.data_lineage,
    experiment_as_of: experimentLedgerResult.as_of,
    known_at_time_split_lineage: experimentLedgerResult.known_at_time_split_lineage,
    temporal_leakage_handling: experimentLedgerResult.temporal_leakage_handling,
    experiment_controls_baselines: experimentLedgerResult.controls_baselines,
    experiment_benchmark_comparison: experimentLedgerResult.benchmark_comparison,
    alpha_discovery_loop: experimentLedgerResult.alpha_discovery_loop,
    experiment_required_diagnostics: experimentLedgerResult.required_diagnostics,
    experiment_result_claim_validation: experimentLedgerResult.result_claim_validation,
    optimizer_scale_contract: optimizerScaleResult.applicable,
    optimizer_run_class: optimizerScaleResult.run_class,
    optimizer_trial_count: optimizerScaleResult.trial_count,
    optimizer_unique_param_count: optimizerScaleResult.unique_param_count,
    optimizer_active_param_count: optimizerScaleResult.active_param_count,
    optimizer_search_surface_hash: optimizerScaleResult.search_surface_hash,
    optimizer_search_surface: optimizerScaleResult.search_surface,
    optimizer_objective_version: optimizerScaleResult.objective_version,
    optimizer_objective_frozen: optimizerScaleResult.objective_frozen,
    optimizer_eval_feedback_tuning: optimizerScaleResult.eval_feedback_tuning,
    optimizer_scale_verdict: optimizerScaleResult.scale_verdict,
    optimizer_target_outcome: optimizerScaleResult.target_outcome,
    optimizer_data_lineage: optimizerScaleResult.data_lineage,
    optimizer_as_of: optimizerScaleResult.as_of,
    optimizer_known_at_time_split_lineage: optimizerScaleResult.known_at_time_split_lineage,
    optimizer_temporal_leakage_handling: optimizerScaleResult.temporal_leakage_handling,
    optimizer_controls_baselines: optimizerScaleResult.controls_baselines,
    optimizer_benchmark_comparison: optimizerScaleResult.benchmark_comparison,
    optimizer_alpha_discovery_loop: optimizerScaleResult.alpha_discovery_loop,
    optimizer_required_diagnostics: optimizerScaleResult.required_diagnostics,
    optimizer_result_claim_validation: optimizerScaleResult.result_claim_validation,
    software_validation_path: softwareValidationPathResult.applicable,
    software_validation_case: softwareValidationPathResult.validation_case,
    software_exercised_system_path: softwareValidationPathResult.exercised_system_path,
    software_contract_owner: softwareValidationPathResult.contract_owner,
    software_direct_plus_conformance_parity: softwareValidationPathResult.direct_plus_conformance_parity,
    software_validation_layers: softwareValidationPathResult.validation_layers,
    software_detected_failure_modes: softwareValidationPathResult.detected_failure_modes,
    software_wrapper_only_proof_detected: softwareValidationPathResult.wrapper_only_proof_detected,
    software_adapter_bypass_detected: softwareValidationPathResult.adapter_bypass_detected,
    software_duplicate_validation_detected: softwareValidationPathResult.duplicate_validation_detected,
    software_brittle_migration_path_detected: softwareValidationPathResult.brittle_migration_path_detected,
    software_convoluted_implementation_route_detected:
      softwareValidationPathResult.convoluted_implementation_route_detected,
    software_target_outcome: softwareValidationPathResult.target_outcome,
    software_data_lineage: softwareValidationPathResult.data_lineage,
    software_as_of: softwareValidationPathResult.as_of,
    software_known_at_time_split_lineage: softwareValidationPathResult.known_at_time_split_lineage,
    software_temporal_leakage_handling: softwareValidationPathResult.temporal_leakage_handling,
    software_controls_baselines: softwareValidationPathResult.controls_baselines,
    software_alpha_discovery_loop: softwareValidationPathResult.alpha_discovery_loop,
    software_migration_smoke_required: softwareValidationPathResult.migration_smoke_required,
    software_configuration_default_parity: softwareValidationPathResult.configuration_default_parity,
    software_quant_results_validation_required: softwareValidationPathResult.quant_results_validation_required,
    software_required_diagnostics: softwareValidationPathResult.required_diagnostics,
    software_result_claim_validation: softwareValidationPathResult.result_claim_validation,
    controls_calibration_replay: controlsCalibrationReplayResult.applicable,
    controls_calibration_target_outcome: controlsCalibrationReplayResult.target_outcome,
    controls_calibration_data_lineage: controlsCalibrationReplayResult.data_lineage,
    controls_calibration_as_of: controlsCalibrationReplayResult.as_of,
    controls_calibration_known_at_time_evaluation_boundary:
      controlsCalibrationReplayResult.known_at_time_evaluation_boundary,
    controls_calibration_temporal_leakage_handling: controlsCalibrationReplayResult.temporal_leakage_handling,
    controls_calibration_controls_baselines: controlsCalibrationReplayResult.controls_baselines,
    controls_calibration_benchmark_comparison: controlsCalibrationReplayResult.benchmark_comparison,
    controls_calibration_calibration_check: controlsCalibrationReplayResult.calibration_check,
    controls_calibration_stability_confidence: controlsCalibrationReplayResult.stability_confidence,
    controls_calibration_strongest_counterargument: controlsCalibrationReplayResult.strongest_counterargument,
    controls_calibration_alpha_discovery_loop: controlsCalibrationReplayResult.alpha_discovery_loop,
    controls_calibration_next_experiment: controlsCalibrationReplayResult.next_experiment,
    controls_calibration_evidence_families: controlsCalibrationReplayResult.evidence_families,
    controls_calibration_required_diagnostics: controlsCalibrationReplayResult.required_diagnostics,
    controls_calibration_result_claim_validation: controlsCalibrationReplayResult.result_claim_validation,
    promotion_allowed: false,
    promotion_verdict: "diagnostic_only",
    result_claims: [],
    issues,
  };
}

function validateControlsCalibrationReplay(replay) {
  if (!replay) {
    return {
      applicable: false,
      target_outcome: null,
      data_lineage: null,
      as_of: null,
      known_at_time_evaluation_boundary: null,
      temporal_leakage_handling: null,
      controls_baselines: [],
      benchmark_comparison: null,
      calibration_check: null,
      stability_confidence: null,
      strongest_counterargument: null,
      alpha_discovery_loop: null,
      next_experiment: null,
      evidence_families: [],
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const diagnostics = uniqueStrings(asArray(replay.required_diagnostics));
  const controlsBaselines = uniqueStrings(asArray(replay.controls_baselines));
  const evidenceFamilies = uniqueStrings(asArray(replay.evidence_families));
  const rawClaimValidation = replay.result_claim_validation;
  const claimValidation = isPlainObject(rawClaimValidation) ? rawClaimValidation : {};
  const issues = [];

  for (const field of [
    "target_outcome",
    "data_lineage",
    "as_of",
    "known_at_time_evaluation_boundary",
    "temporal_leakage_handling",
    "benchmark_comparison",
    "calibration_check",
    "stability_confidence",
    "strongest_counterargument",
    "alpha_discovery_loop",
    "next_experiment",
  ]) {
    if (!asString(replay[field])) {
      issues.push({
        code: `controls_calibration_${field}_missing`,
        field: `controls_calibration_replay.${field}`,
        message: `Controls/calibration replay fixture must include ${field}`,
      });
    }
  }
  if (controlsBaselines.length === 0) {
    issues.push({
      code: "controls_calibration_controls_baselines_missing",
      field: "controls_calibration_replay.controls_baselines",
      message: "Controls/calibration replay fixture requires at least one control or baseline",
    });
  }
  if (evidenceFamilies.length === 0) {
    issues.push({
      code: "controls_calibration_evidence_families_missing",
      field: "controls_calibration_replay.evidence_families",
      message: "Controls/calibration replay fixture requires at least one evidence family",
    });
  }
  if (!evidenceFamilies.some((family) => CONTROLS_CALIBRATION_EVIDENCE_FAMILIES.has(family))) {
    issues.push({
      code: "controls_calibration_evidence_family_missing",
      field: "controls_calibration_replay.evidence_families",
      message: "Controls/calibration replay fixture must include a recognized baseline or calibration evidence family",
    });
  }
  for (const diagnostic of CONTROLS_CALIBRATION_REPLAY_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "controls_calibration_required_diagnostic_missing",
        field: "controls_calibration_replay.required_diagnostics",
        message: `Controls/calibration replay fixture must require ${diagnostic}`,
      });
    }
  }
  if (!isPlainObject(rawClaimValidation)) {
    issues.push({
      code: "controls_calibration_result_claim_validation_missing",
      field: "controls_calibration_replay.result_claim_validation",
      message: "Controls/calibration replay fixture must include result_claim_validation",
    });
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "controls_calibration_promotion_not_forbidden",
      field: "controls_calibration_replay.result_claim_validation.promotion_allowed",
      message: "Controls/calibration result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "controls_calibration_promotion_verdict_invalid",
      field: "controls_calibration_replay.result_claim_validation.promotion_verdict",
      message: "Controls/calibration result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "controls_calibration_result_claims_not_empty",
      field: "controls_calibration_replay.result_claim_validation.result_claims",
      message: "Controls/calibration result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    target_outcome: replay.target_outcome,
    data_lineage: replay.data_lineage,
    as_of: replay.as_of,
    known_at_time_evaluation_boundary: replay.known_at_time_evaluation_boundary,
    temporal_leakage_handling: replay.temporal_leakage_handling,
    controls_baselines: controlsBaselines,
    benchmark_comparison: replay.benchmark_comparison,
    calibration_check: replay.calibration_check,
    stability_confidence: replay.stability_confidence,
    strongest_counterargument: replay.strongest_counterargument,
    alpha_discovery_loop: replay.alpha_discovery_loop,
    next_experiment: replay.next_experiment,
    evidence_families: evidenceFamilies,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function isObjectiveFrozen(value) {
  if (value === true) return true;
  return ["true", "frozen"].includes(asString(value).toLowerCase());
}

function isEvalFeedbackTuningBlocked(value) {
  if (value === false) return true;
  return ["false", "blocked", "none", "not_used", "not_applicable"].includes(asString(value).toLowerCase());
}

function validateOptimizerScaleContract(contract) {
  if (!contract) {
    return {
      applicable: false,
      run_class: null,
      trial_count: null,
      unique_param_count: null,
      active_param_count: null,
      search_surface_hash: null,
      search_surface: [],
      objective_version: null,
      objective_frozen: null,
      eval_feedback_tuning: null,
      scale_verdict: null,
      target_outcome: null,
      data_lineage: null,
      as_of: null,
      known_at_time_split_lineage: null,
      temporal_leakage_handling: null,
      controls_baselines: [],
      benchmark_comparison: null,
      alpha_discovery_loop: null,
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const diagnostics = uniqueStrings(asArray(contract.required_diagnostics));
  const controlsBaselines = uniqueStrings(asArray(contract.controls_baselines));
  const searchSurface = Array.isArray(contract.search_surface)
    ? uniqueStrings(contract.search_surface)
    : uniqueStrings([contract.search_surface]);
  const claimValidation = contract.result_claim_validation || {};
  const trialCount = asNumber(contract.trial_count);
  const uniqueParamCount = asNumber(contract.unique_param_count);
  const activeParamCount = asNumber(contract.active_param_count);
  const runClass = asString(contract.run_class);
  const scaleVerdict = asString(contract.scale_verdict);
  const issues = [];

  for (const field of [
    "run_class",
    "search_surface_hash",
    "objective_version",
    "target_outcome",
    "data_lineage",
    "as_of",
    "known_at_time_split_lineage",
    "temporal_leakage_handling",
    "benchmark_comparison",
    "alpha_discovery_loop",
    "scale_verdict",
  ]) {
    if (!asString(contract[field])) {
      issues.push({
        code: `optimizer_scale_${field}_missing`,
        field: `optimizer_scale_contract.${field}`,
        message: `Optimizer scale contract must include ${field}`,
      });
    }
  }
  for (const [field, value] of [
    ["trial_count", trialCount],
    ["unique_param_count", uniqueParamCount],
    ["active_param_count", activeParamCount],
  ]) {
    if (value === null || value < 0) {
      issues.push({
        code: `optimizer_scale_${field}_missing`,
        field: `optimizer_scale_contract.${field}`,
        message: `Optimizer scale contract must include a non-negative ${field}`,
      });
    }
  }
  if (searchSurface.length === 0) {
    issues.push({
      code: "optimizer_scale_search_surface_missing",
      field: "optimizer_scale_contract.search_surface",
      message: "Optimizer scale contract requires at least one search-surface dimension",
    });
  }
  if (controlsBaselines.length === 0) {
    issues.push({
      code: "optimizer_scale_controls_baselines_missing",
      field: "optimizer_scale_contract.controls_baselines",
      message: "Optimizer scale contract requires at least one control or baseline",
    });
  }
  if (!isObjectiveFrozen(contract.objective_frozen)) {
    issues.push({
      code: "optimizer_scale_objective_not_frozen",
      field: "optimizer_scale_contract.objective_frozen",
      message: "Optimizer scale contract must freeze the objective before result interpretation",
    });
  }
  if (!isEvalFeedbackTuningBlocked(contract.eval_feedback_tuning)) {
    issues.push({
      code: "optimizer_scale_eval_feedback_tuning_not_blocked",
      field: "optimizer_scale_contract.eval_feedback_tuning",
      message: "Optimizer scale contract must block evaluation-feedback tuning",
    });
  }
  for (const diagnostic of OPTIMIZER_SCALE_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "optimizer_scale_required_diagnostic_missing",
        field: "optimizer_scale_contract.required_diagnostics",
        message: `Optimizer scale contract must require ${diagnostic}`,
      });
    }
  }
  if (INTERPRETIVE_OPTIMIZER_RUN_CLASSES.has(runClass)) {
    if (!ADEQUATE_OPTIMIZER_SCALE_VERDICTS.has(scaleVerdict)) {
      issues.push({
        code: "optimizer_scale_underpowered_serious_search",
        field: "optimizer_scale_contract.scale_verdict",
        message: "Serious optimizer search requires an adequate scale verdict",
      });
    }
    if (
      trialCount !== null &&
      uniqueParamCount !== null &&
      activeParamCount !== null &&
      (trialCount < uniqueParamCount || trialCount < activeParamCount)
    ) {
      issues.push({
        code: "optimizer_scale_trial_budget_underpowered",
        field: "optimizer_scale_contract.trial_count",
        message: "Serious optimizer search requires trial_count to cover unique and active parameter counts",
      });
    }
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "optimizer_scale_promotion_not_forbidden",
      field: "optimizer_scale_contract.result_claim_validation.promotion_allowed",
      message: "Optimizer scale result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "optimizer_scale_promotion_verdict_invalid",
      field: "optimizer_scale_contract.result_claim_validation.promotion_verdict",
      message: "Optimizer scale result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "optimizer_scale_result_claims_not_empty",
      field: "optimizer_scale_contract.result_claim_validation.result_claims",
      message: "Optimizer scale result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    run_class: contract.run_class,
    trial_count: trialCount,
    unique_param_count: uniqueParamCount,
    active_param_count: activeParamCount,
    search_surface_hash: contract.search_surface_hash,
    search_surface: searchSurface,
    objective_version: contract.objective_version,
    objective_frozen: contract.objective_frozen,
    eval_feedback_tuning: contract.eval_feedback_tuning,
    scale_verdict: contract.scale_verdict,
    target_outcome: contract.target_outcome,
    data_lineage: contract.data_lineage,
    as_of: contract.as_of,
    known_at_time_split_lineage: contract.known_at_time_split_lineage,
    temporal_leakage_handling: contract.temporal_leakage_handling,
    controls_baselines: controlsBaselines,
    benchmark_comparison: contract.benchmark_comparison,
    alpha_discovery_loop: contract.alpha_discovery_loop,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function validateSoftwareValidationPath(contract, fixture) {
  if (!contract) {
    return {
      applicable: false,
      validation_case: null,
      exercised_system_path: null,
      contract_owner: null,
      direct_plus_conformance_parity: null,
      validation_layers: [],
      detected_failure_modes: [],
      wrapper_only_proof_detected: false,
      adapter_bypass_detected: false,
      duplicate_validation_detected: false,
      brittle_migration_path_detected: false,
      convoluted_implementation_route_detected: false,
      target_outcome: null,
      data_lineage: null,
      as_of: null,
      known_at_time_split_lineage: null,
      temporal_leakage_handling: null,
      controls_baselines: [],
      alpha_discovery_loop: null,
      migration_smoke_required: false,
      configuration_default_parity: null,
      quant_results_validation_required: false,
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const diagnostics = uniqueStrings(asArray(contract.required_diagnostics));
  const validationLayers = uniqueStrings(asArray(contract.validation_layers));
  const controlsBaselines = uniqueStrings(asArray(contract.controls_baselines));
  const detectedFailureModes = uniqueStrings(asArray(contract.detected_failure_modes));
  const claimValidation = contract.result_claim_validation || {};
  const issues = [];

  for (const field of [
    "validation_case",
    "exercised_system_path",
    "contract_owner",
    "direct_plus_conformance_parity",
    "target_outcome",
    "data_lineage",
    "as_of",
    "known_at_time_split_lineage",
    "temporal_leakage_handling",
    "alpha_discovery_loop",
    "configuration_default_parity",
  ]) {
    if (!asString(contract[field])) {
      issues.push({
        code: `software_validation_path_${field}_missing`,
        field: `software_validation_path.${field}`,
        message: `Software validation path fixture must include ${field}`,
      });
    }
  }
  for (const [field, values, label] of [
    ["validation_layers", validationLayers, "validation layer"],
    ["controls_baselines", controlsBaselines, "control or baseline"],
    ["detected_failure_modes", detectedFailureModes, "detected false-validation mode"],
  ]) {
    if (values.length === 0) {
      issues.push({
        code: `software_validation_path_${field}_missing`,
        field: `software_validation_path.${field}`,
        message: `Software validation path fixture requires at least one ${label}`,
      });
    }
  }
  if (!detectedFailureModes.some((mode) => SOFTWARE_VALIDATION_FAILURE_MODES.has(mode))) {
    issues.push({
      code: "software_validation_path_failure_mode_missing",
      field: "software_validation_path.detected_failure_modes",
      message: "Software validation path fixture must detect a recognized false-validation mode",
    });
  }
  if (contract.migration_smoke_required !== true) {
    issues.push({
      code: "software_validation_path_migration_smoke_not_required",
      field: "software_validation_path.migration_smoke_required",
      message: "Software validation path fixture must require migration smoke",
    });
  }
  if (fixture?.quant_guard && contract.quant_results_validation_required !== true) {
    issues.push({
      code: "software_validation_path_quant_results_validation_not_required",
      field: "software_validation_path.quant_results_validation_required",
      message: "Quant-adjacent software validation path fixture must require quant results validation",
    });
  }
  for (const diagnostic of SOFTWARE_VALIDATION_PATH_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "software_validation_path_required_diagnostic_missing",
        field: "software_validation_path.required_diagnostics",
        message: `Software validation path fixture must require ${diagnostic}`,
      });
    }
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "software_validation_path_promotion_not_forbidden",
      field: "software_validation_path.result_claim_validation.promotion_allowed",
      message: "Software validation path result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "software_validation_path_promotion_verdict_invalid",
      field: "software_validation_path.result_claim_validation.promotion_verdict",
      message: "Software validation path result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "software_validation_path_result_claims_not_empty",
      field: "software_validation_path.result_claim_validation.result_claims",
      message: "Software validation path result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    validation_case: contract.validation_case,
    exercised_system_path: contract.exercised_system_path,
    contract_owner: contract.contract_owner,
    direct_plus_conformance_parity: contract.direct_plus_conformance_parity,
    validation_layers: validationLayers,
    detected_failure_modes: detectedFailureModes,
    wrapper_only_proof_detected: detectedFailureModes.includes("wrapper_only_proof"),
    adapter_bypass_detected: detectedFailureModes.includes("adapter_bypass"),
    duplicate_validation_detected: detectedFailureModes.includes("duplicate_validation"),
    brittle_migration_path_detected: detectedFailureModes.includes("brittle_migration_path"),
    convoluted_implementation_route_detected: detectedFailureModes.includes("convoluted_implementation_route"),
    target_outcome: contract.target_outcome,
    data_lineage: contract.data_lineage,
    as_of: contract.as_of,
    known_at_time_split_lineage: contract.known_at_time_split_lineage,
    temporal_leakage_handling: contract.temporal_leakage_handling,
    controls_baselines: controlsBaselines,
    alpha_discovery_loop: contract.alpha_discovery_loop,
    migration_smoke_required: contract.migration_smoke_required === true,
    configuration_default_parity: contract.configuration_default_parity,
    quant_results_validation_required: contract.quant_results_validation_required === true,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function validateExperimentLedgerProvenance(ledger) {
  if (!ledger) {
    return {
      applicable: false,
      experiment_record: null,
      run_record: null,
      command: null,
      config_hash: null,
      dataset_source_hash: null,
      split_id: null,
      objective_version: null,
      baseline_refs: [],
      result_artifact: null,
      run_class: null,
      target_outcome: null,
      data_lineage: null,
      as_of: null,
      known_at_time_split_lineage: null,
      temporal_leakage_handling: null,
      controls_baselines: [],
      benchmark_comparison: null,
      alpha_discovery_loop: null,
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const diagnostics = uniqueStrings(asArray(ledger.required_diagnostics));
  const baselineRefs = uniqueStrings(asArray(ledger.baseline_refs));
  const controlsBaselines = uniqueStrings(asArray(ledger.controls_baselines));
  const claimValidation = ledger.result_claim_validation || {};
  const issues = [];

  for (const field of [
    "experiment_record",
    "run_record",
    "command",
    "config_hash",
    "dataset_source_hash",
    "split_id",
    "objective_version",
    "result_artifact",
    "run_class",
    "target_outcome",
    "data_lineage",
    "as_of",
    "known_at_time_split_lineage",
    "temporal_leakage_handling",
    "benchmark_comparison",
    "alpha_discovery_loop",
  ]) {
    if (!asString(ledger[field])) {
      issues.push({
        code: `experiment_ledger_${field}_missing`,
        field: `experiment_ledger_provenance.${field}`,
        message: `Experiment ledger provenance must include ${field}`,
      });
    }
  }
  if (baselineRefs.length === 0) {
    issues.push({
      code: "experiment_ledger_baseline_refs_missing",
      field: "experiment_ledger_provenance.baseline_refs",
      message: "Experiment ledger provenance requires at least one baseline reference",
    });
  }
  if (controlsBaselines.length === 0) {
    issues.push({
      code: "experiment_ledger_controls_baselines_missing",
      field: "experiment_ledger_provenance.controls_baselines",
      message: "Experiment ledger provenance requires at least one control or baseline",
    });
  }
  for (const diagnostic of EXPERIMENT_LEDGER_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "experiment_ledger_required_diagnostic_missing",
        field: "experiment_ledger_provenance.required_diagnostics",
        message: `Experiment ledger provenance must require ${diagnostic}`,
      });
    }
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "experiment_ledger_promotion_not_forbidden",
      field: "experiment_ledger_provenance.result_claim_validation.promotion_allowed",
      message: "Experiment ledger result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "experiment_ledger_promotion_verdict_invalid",
      field: "experiment_ledger_provenance.result_claim_validation.promotion_verdict",
      message: "Experiment ledger result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "experiment_ledger_result_claims_not_empty",
      field: "experiment_ledger_provenance.result_claim_validation.result_claims",
      message: "Experiment ledger result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    experiment_record: ledger.experiment_record,
    run_record: ledger.run_record,
    command: ledger.command,
    config_hash: ledger.config_hash,
    dataset_source_hash: ledger.dataset_source_hash,
    split_id: ledger.split_id,
    objective_version: ledger.objective_version,
    baseline_refs: baselineRefs,
    result_artifact: ledger.result_artifact,
    run_class: ledger.run_class,
    target_outcome: ledger.target_outcome,
    data_lineage: ledger.data_lineage,
    as_of: ledger.as_of,
    known_at_time_split_lineage: ledger.known_at_time_split_lineage,
    temporal_leakage_handling: ledger.temporal_leakage_handling,
    controls_baselines: controlsBaselines,
    benchmark_comparison: ledger.benchmark_comparison,
    alpha_discovery_loop: ledger.alpha_discovery_loop,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function validateMissedFeatureReplay(replay) {
  if (!replay) {
    return {
      applicable: false,
      candidate_signal: null,
      edge_mechanism: null,
      target_outcome: null,
      expected_metric: null,
      known_at_time_feature_availability: null,
      leakage_check: null,
      controls_baselines: [],
      benchmark_comparison: null,
      strongest_counterargument: null,
      next_experiment: null,
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const diagnostics = uniqueStrings(asArray(replay.required_diagnostics));
  const controlsBaselines = uniqueStrings(asArray(replay.controls_baselines));
  const claimValidation = replay.result_claim_validation || {};
  const issues = [];

  for (const field of [
    "candidate_signal",
    "edge_mechanism",
    "target_outcome",
    "expected_metric",
    "known_at_time_feature_availability",
    "leakage_check",
    "benchmark_comparison",
    "strongest_counterargument",
    "next_experiment",
  ]) {
    if (!asString(replay[field])) {
      issues.push({
        code: `missed_feature_replay_${field}_missing`,
        field: `missed_feature_replay.${field}`,
        message: `Missed-feature replay fixture must include ${field}`,
      });
    }
  }
  if (controlsBaselines.length === 0) {
    issues.push({
      code: "missed_feature_replay_controls_baselines_missing",
      field: "missed_feature_replay.controls_baselines",
      message: "Missed-feature replay fixture requires at least one control or baseline",
    });
  }
  for (const diagnostic of MISSED_FEATURE_REPLAY_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "missed_feature_replay_required_diagnostic_missing",
        field: "missed_feature_replay.required_diagnostics",
        message: `Missed-feature replay fixture must require ${diagnostic}`,
      });
    }
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "missed_feature_replay_promotion_not_forbidden",
      field: "missed_feature_replay.result_claim_validation.promotion_allowed",
      message: "Missed-feature replay result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "missed_feature_replay_promotion_verdict_invalid",
      field: "missed_feature_replay.result_claim_validation.promotion_verdict",
      message: "Missed-feature replay result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "missed_feature_replay_result_claims_not_empty",
      field: "missed_feature_replay.result_claim_validation.result_claims",
      message: "Missed-feature replay result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    candidate_signal: replay.candidate_signal,
    edge_mechanism: replay.edge_mechanism,
    target_outcome: replay.target_outcome,
    expected_metric: replay.expected_metric,
    known_at_time_feature_availability: replay.known_at_time_feature_availability,
    leakage_check: replay.leakage_check,
    controls_baselines: controlsBaselines,
    benchmark_comparison: replay.benchmark_comparison,
    strongest_counterargument: replay.strongest_counterargument,
    next_experiment: replay.next_experiment,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function validateLeakageRecurrence(recurrence, guard) {
  if (!recurrence) {
    return {
      applicable: false,
      leakage_vector: null,
      known_at_time_statement: null,
      temporal_split: null,
      controls_baselines: [],
      required_diagnostics: [],
      result_claim_validation: null,
      issues: [],
    };
  }

  const requiredDiagnostics = [
    "leakage_boundary",
    "data_lineage",
    "controls_baselines",
    "diagnostic_only",
    "result_claim_validation",
  ];
  const diagnostics = uniqueStrings(asArray(recurrence.required_diagnostics));
  const controlsBaselines = uniqueStrings(asArray(recurrence.controls_baselines));
  const claimValidation = recurrence.result_claim_validation || {};
  const issues = [];

  if (!asString(recurrence.leakage_vector)) {
    issues.push({
      code: "leakage_recurrence_leakage_vector_missing",
      field: "leakage_recurrence.leakage_vector",
      message: "Leakage recurrence fixture must name a leakage vector",
    });
  }
  if (!asString(recurrence.known_at_time_statement)) {
    issues.push({
      code: "leakage_recurrence_known_at_time_statement_missing",
      field: "leakage_recurrence.known_at_time_statement",
      message: "Leakage recurrence fixture must state what was known at the time",
    });
  }
  if (!asString(recurrence.temporal_split)) {
    issues.push({
      code: "leakage_recurrence_temporal_split_missing",
      field: "leakage_recurrence.temporal_split",
      message: "Leakage recurrence fixture must state the train/eval temporal split story",
    });
  }
  if (!asString(guard?.leakage_boundary)) {
    issues.push({
      code: "leakage_recurrence_leakage_boundary_missing",
      field: "quant_guard.leakage_boundary",
      message: "Leakage recurrence fixture requires quant_guard.leakage_boundary",
    });
  }
  if (!asString(guard?.data_lineage)) {
    issues.push({
      code: "leakage_recurrence_data_lineage_missing",
      field: "quant_guard.data_lineage",
      message: "Leakage recurrence fixture requires quant_guard.data_lineage",
    });
  }
  if (controlsBaselines.length === 0) {
    issues.push({
      code: "leakage_recurrence_controls_baselines_missing",
      field: "leakage_recurrence.controls_baselines",
      message: "Leakage recurrence fixture requires at least one control or baseline",
    });
  }
  for (const diagnostic of requiredDiagnostics) {
    if (!diagnostics.includes(diagnostic)) {
      issues.push({
        code: "leakage_recurrence_required_diagnostic_missing",
        field: "leakage_recurrence.required_diagnostics",
        message: `Leakage recurrence fixture must require ${diagnostic}`,
      });
    }
  }
  if (claimValidation.promotion_allowed !== false) {
    issues.push({
      code: "leakage_recurrence_promotion_not_forbidden",
      field: "leakage_recurrence.result_claim_validation.promotion_allowed",
      message: "Leakage recurrence result claim validation must forbid promotion",
    });
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    issues.push({
      code: "leakage_recurrence_promotion_verdict_invalid",
      field: "leakage_recurrence.result_claim_validation.promotion_verdict",
      message: "Leakage recurrence result claim validation must be diagnostic_only",
    });
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    issues.push({
      code: "leakage_recurrence_result_claims_not_empty",
      field: "leakage_recurrence.result_claim_validation.result_claims",
      message: "Leakage recurrence result claim validation must not carry result claims",
    });
  }

  return {
    applicable: true,
    leakage_vector: recurrence.leakage_vector,
    known_at_time_statement: recurrence.known_at_time_statement,
    temporal_split: recurrence.temporal_split,
    controls_baselines: controlsBaselines,
    required_diagnostics: diagnostics,
    result_claim_validation: {
      promotion_allowed: false,
      promotion_verdict: "diagnostic_only",
      result_claims: [],
    },
    issues,
  };
}

function runIveScenarioFixture(fixture, options = {}) {
  const packet = deepClone(fixture.packet);
  const packetContract = validateIvePacket(packet);
  const routing = validateFactRouting(packet, options.routing || fixture.routing_options || {});
  const verdict = buildIveUserVerdict(packet, options.verdict || fixture.verdict_options || {});
  const intake = fixture.skip_program_intake
    ? {
        ok: true,
        status: "SKIP",
        ticket_route_count: 0,
        program_manager_called: false,
        intake_items: [],
        mappings: [],
        mapping_errors: [],
      }
    : mapIvePacketToProgramIntake(packet, options.intake || fixture.intake_options || {});
  const quantGuard = validateQuantGuard(fixture);
  const assertions = evaluateExpectations({
    fixture,
    packet,
    packetContract,
    routing,
    verdict,
    intake,
    quantGuard,
  });
  const failedAssertions = assertions.filter((assertion) => !verificationStatusIsPass(assertion.status, "execution"));

  return {
    id: fixture.id,
    title: fixture.title,
    family: fixture.family,
    status: failedAssertions.length === 0 ? "PASS" : "FAIL",
    ok: failedAssertions.length === 0,
    expectation_count: assertions.length,
    failed_expectation_count: failedAssertions.length,
    packet_contract: {
      status: packetContract.status,
      error_codes: issueCodes(packetContract),
    },
    routing: {
      status: routing.status,
      error_codes: issueCodes(routing),
      summary: routing.summary || {},
    },
    user_verdict: {
      status: verdict.status,
      verdict: verdict.verdict,
      fulfillment_status: verdict.fulfillment_status,
      valid_next_action: verdict.valid_next_action,
      user_decision_required: verdict.user_decision_required,
      blocker_codes: verdictBlockerCodes(verdict),
      non_claims: verdict.non_claims || [],
      evidence_refs: evidenceRefs(verdict),
    },
    program_intake: {
      status: intake.status,
      ticket_route_count: intake.ticket_route_count || 0,
      program_manager_called: intake.program_manager_called === true,
      direct_github_creation_allowed: intake.direct_github_creation_allowed === true,
      mapping_error_codes: uniqueStrings(asArray(intake.mapping_errors).map((issue) => issue?.code)),
    },
    quant_guard: quantGuard,
    assertions,
  };
}

function buildScenarioQuantResultsValidation(results) {
  const checks = results
    .filter((result) => result.quant_guard?.applicable)
    .map((result) => ({
      scenario_id: result.id,
      status: result.quant_guard.status,
      target_outcome: result.quant_guard.target_outcome,
      data_lineage: result.quant_guard.data_lineage,
      as_of: result.quant_guard.as_of,
      known_at_time: result.quant_guard.known_at_time,
      leakage_boundary: result.quant_guard.leakage_boundary,
      leakage_recurrence: result.quant_guard.leakage_recurrence === true,
      leakage_vector: result.quant_guard.leakage_vector,
      known_at_time_statement: result.quant_guard.known_at_time_statement,
      temporal_split: result.quant_guard.temporal_split,
      controls_baselines: result.quant_guard.controls_baselines || [],
      required_diagnostics: result.quant_guard.required_diagnostics || [],
      missed_feature_replay: result.quant_guard.missed_feature_replay === true,
      candidate_signal: result.quant_guard.candidate_signal,
      edge_mechanism: result.quant_guard.edge_mechanism,
      missed_feature_target_outcome: result.quant_guard.missed_feature_target_outcome,
      expected_metric: result.quant_guard.expected_metric,
      known_at_time_feature_availability: result.quant_guard.known_at_time_feature_availability,
      leakage_check: result.quant_guard.leakage_check,
      missed_feature_controls_baselines: result.quant_guard.missed_feature_controls_baselines || [],
      benchmark_comparison: result.quant_guard.benchmark_comparison,
      strongest_counterargument: result.quant_guard.strongest_counterargument,
      next_experiment: result.quant_guard.next_experiment,
      missed_feature_required_diagnostics: result.quant_guard.missed_feature_required_diagnostics || [],
      missed_feature_result_claim_validation: result.quant_guard.missed_feature_result_claim_validation,
      experiment_ledger_provenance: result.quant_guard.experiment_ledger_provenance === true,
      experiment_record: result.quant_guard.experiment_record,
      run_record: result.quant_guard.run_record,
      experiment_command: result.quant_guard.experiment_command,
      config_hash: result.quant_guard.config_hash,
      dataset_source_hash: result.quant_guard.dataset_source_hash,
      split_id: result.quant_guard.split_id,
      objective_version: result.quant_guard.objective_version,
      baseline_refs: result.quant_guard.baseline_refs || [],
      result_artifact: result.quant_guard.result_artifact,
      experiment_run_class: result.quant_guard.experiment_run_class,
      experiment_target_outcome: result.quant_guard.experiment_target_outcome,
      experiment_data_lineage: result.quant_guard.experiment_data_lineage,
      experiment_as_of: result.quant_guard.experiment_as_of,
      known_at_time_split_lineage: result.quant_guard.known_at_time_split_lineage,
      temporal_leakage_handling: result.quant_guard.temporal_leakage_handling,
      experiment_controls_baselines: result.quant_guard.experiment_controls_baselines || [],
      experiment_benchmark_comparison: result.quant_guard.experiment_benchmark_comparison,
      alpha_discovery_loop: result.quant_guard.alpha_discovery_loop,
      experiment_required_diagnostics: result.quant_guard.experiment_required_diagnostics || [],
      experiment_result_claim_validation: result.quant_guard.experiment_result_claim_validation,
      optimizer_scale_contract: result.quant_guard.optimizer_scale_contract === true,
      optimizer_run_class: result.quant_guard.optimizer_run_class,
      optimizer_trial_count: result.quant_guard.optimizer_trial_count,
      optimizer_unique_param_count: result.quant_guard.optimizer_unique_param_count,
      optimizer_active_param_count: result.quant_guard.optimizer_active_param_count,
      optimizer_search_surface_hash: result.quant_guard.optimizer_search_surface_hash,
      optimizer_search_surface: result.quant_guard.optimizer_search_surface || [],
      optimizer_objective_version: result.quant_guard.optimizer_objective_version,
      optimizer_objective_frozen: result.quant_guard.optimizer_objective_frozen,
      optimizer_eval_feedback_tuning: result.quant_guard.optimizer_eval_feedback_tuning,
      optimizer_scale_verdict: result.quant_guard.optimizer_scale_verdict,
      optimizer_target_outcome: result.quant_guard.optimizer_target_outcome,
      optimizer_data_lineage: result.quant_guard.optimizer_data_lineage,
      optimizer_as_of: result.quant_guard.optimizer_as_of,
      optimizer_known_at_time_split_lineage: result.quant_guard.optimizer_known_at_time_split_lineage,
      optimizer_temporal_leakage_handling: result.quant_guard.optimizer_temporal_leakage_handling,
      optimizer_controls_baselines: result.quant_guard.optimizer_controls_baselines || [],
      optimizer_benchmark_comparison: result.quant_guard.optimizer_benchmark_comparison,
      optimizer_alpha_discovery_loop: result.quant_guard.optimizer_alpha_discovery_loop,
      optimizer_required_diagnostics: result.quant_guard.optimizer_required_diagnostics || [],
      optimizer_result_claim_validation: result.quant_guard.optimizer_result_claim_validation,
      software_validation_path: result.quant_guard.software_validation_path === true,
      software_validation_case: result.quant_guard.software_validation_case,
      software_exercised_system_path: result.quant_guard.software_exercised_system_path,
      software_contract_owner: result.quant_guard.software_contract_owner,
      software_direct_plus_conformance_parity: result.quant_guard.software_direct_plus_conformance_parity,
      software_validation_layers: result.quant_guard.software_validation_layers || [],
      software_detected_failure_modes: result.quant_guard.software_detected_failure_modes || [],
      software_wrapper_only_proof_detected: result.quant_guard.software_wrapper_only_proof_detected === true,
      software_adapter_bypass_detected: result.quant_guard.software_adapter_bypass_detected === true,
      software_duplicate_validation_detected: result.quant_guard.software_duplicate_validation_detected === true,
      software_brittle_migration_path_detected: result.quant_guard.software_brittle_migration_path_detected === true,
      software_convoluted_implementation_route_detected:
        result.quant_guard.software_convoluted_implementation_route_detected === true,
      software_target_outcome: result.quant_guard.software_target_outcome,
      software_data_lineage: result.quant_guard.software_data_lineage,
      software_as_of: result.quant_guard.software_as_of,
      software_known_at_time_split_lineage: result.quant_guard.software_known_at_time_split_lineage,
      software_temporal_leakage_handling: result.quant_guard.software_temporal_leakage_handling,
      software_controls_baselines: result.quant_guard.software_controls_baselines || [],
      software_alpha_discovery_loop: result.quant_guard.software_alpha_discovery_loop,
      software_migration_smoke_required: result.quant_guard.software_migration_smoke_required === true,
      software_configuration_default_parity: result.quant_guard.software_configuration_default_parity,
      software_quant_results_validation_required:
        result.quant_guard.software_quant_results_validation_required === true,
      software_required_diagnostics: result.quant_guard.software_required_diagnostics || [],
      software_result_claim_validation: result.quant_guard.software_result_claim_validation,
      controls_calibration_replay: result.quant_guard.controls_calibration_replay === true,
      controls_calibration_target_outcome: result.quant_guard.controls_calibration_target_outcome,
      controls_calibration_data_lineage: result.quant_guard.controls_calibration_data_lineage,
      controls_calibration_as_of: result.quant_guard.controls_calibration_as_of,
      controls_calibration_known_at_time_evaluation_boundary:
        result.quant_guard.controls_calibration_known_at_time_evaluation_boundary,
      controls_calibration_temporal_leakage_handling:
        result.quant_guard.controls_calibration_temporal_leakage_handling,
      controls_calibration_controls_baselines: result.quant_guard.controls_calibration_controls_baselines || [],
      controls_calibration_benchmark_comparison: result.quant_guard.controls_calibration_benchmark_comparison,
      controls_calibration_calibration_check: result.quant_guard.controls_calibration_calibration_check,
      controls_calibration_stability_confidence: result.quant_guard.controls_calibration_stability_confidence,
      controls_calibration_strongest_counterargument: result.quant_guard.controls_calibration_strongest_counterargument,
      controls_calibration_alpha_discovery_loop: result.quant_guard.controls_calibration_alpha_discovery_loop,
      controls_calibration_next_experiment: result.quant_guard.controls_calibration_next_experiment,
      controls_calibration_evidence_families: result.quant_guard.controls_calibration_evidence_families || [],
      controls_calibration_required_diagnostics: result.quant_guard.controls_calibration_required_diagnostics || [],
      controls_calibration_result_claim_validation: result.quant_guard.controls_calibration_result_claim_validation,
      baseline: result.quant_guard.baseline,
      calibration: result.quant_guard.calibration,
      diagnostic_only: result.quant_guard.promotion_verdict === "diagnostic_only" &&
        result.quant_guard.promotion_allowed === false,
      result_claim_validation: result.quant_guard.result_claim_validation || {
        promotion_allowed: false,
        promotion_verdict: "diagnostic_only",
        result_claims: [],
      },
      promotion_verdict: result.quant_guard.promotion_verdict,
      promotion_allowed: result.quant_guard.promotion_allowed,
      issues: result.quant_guard.issues,
    }));
  const failed = checks.filter((check) => !verificationStatusIsPass(check.status, "execution"));
  return {
    schema_version: 1,
    applicable: checks.length > 0,
    status: failed.length === 0 ? "PASS" : "FAIL",
    run_class: "fixture_guard",
    target_outcome: "honest IVE routing and user fulfillment clarity",
    promotion_verdict: "diagnostic_only",
    promotion_allowed: false,
    result_claims: [],
    checks,
    failed_count: failed.length,
  };
}

function runIveScenarioSuite(fixtures = [], options = {}) {
  const startedAt = (options.clock || (() => new Date()))().toISOString();
  const results = fixtures.map((fixture) => runIveScenarioFixture(fixture, options));
  const failed = results.filter((result) => !result.ok);
  const quantResultsValidation = buildScenarioQuantResultsValidation(results);
  const report = {
    schema_version: IVE_SCENARIO_HARNESS_SCHEMA_VERSION,
    run_started_at: startedAt,
    run_finished_at: (options.clock || (() => new Date()))().toISOString(),
    status: failed.length === 0 && verificationStatusIsPass(quantResultsValidation.status, "execution") ? "PASS" : "FAIL",
    ok: failed.length === 0 && verificationStatusIsPass(quantResultsValidation.status, "execution"),
    summary: {
      total: results.length,
      passed: results.filter((result) => result.ok).length,
      failed: failed.length,
      families: uniqueStrings(results.map((result) => result.family)),
      assertion_count: results.reduce((sum, result) => sum + result.expectation_count, 0),
    },
    quant_results_validation: quantResultsValidation,
    scenarios: results,
  };
  return report;
}

function writeIveScenarioReport(report, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const runId = asString(options.runId) || `ive-scenarios-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const root = resolve(options.reportRoot || join(cwd, "reports", "ive", "test_runs", runId));
  mkdirSync(root, { recursive: true });
  const scenariosPath = join(root, "scenarios.json");
  const manifestPath = join(root, "manifest.json");
  writeFileSync(scenariosPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    overall_status: report.status,
    proof_artifact: relative(cwd, scenariosPath),
    scenario_count: report.summary.total,
    quant_results_validation_status: report.quant_results_validation.status,
  }, null, 2)}\n`, "utf-8");
  return {
    run_id: runId,
    report_dir: root,
    scenarios_path: scenariosPath,
    manifest_path: manifestPath,
    scenarios_relpath: relative(cwd, scenariosPath),
    manifest_relpath: relative(cwd, manifestPath),
    scenarios_exists: existsSync(scenariosPath),
    manifest_exists: existsSync(manifestPath),
  };
}

export {
  IVE_SCENARIO_HARNESS_SCHEMA_VERSION,
  buildScenarioQuantResultsValidation,
  runIveScenarioFixture,
  runIveScenarioSuite,
  validateQuantGuard,
  writeIveScenarioReport,
};
