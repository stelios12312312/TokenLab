// ive_real_episode_corpus.mjs - adapt real Mac mini episode fixtures to IVE scenarios.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REAL_EPISODE_CORPUS_SCHEMA_VERSION = 1;
const DEFAULT_REAL_EPISODE_CORPUS_PATH = resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "fixtures",
  "real_episodes",
  "mac_mini_quant_episodes.json",
);

const ROUTE_STATUSES = new Set(["routed", "accepted", "deferred_with_ticket", "blocked", "unrouted"]);
const NEXT_ACTIONS = new Set(["fix_now", "ticket_now", "run_experiment", "ask_user", "accept_limitation"]);
const FORBIDDEN_SOURCE_KEYS = new Set([
  "raw_excerpt",
  "raw_source_excerpt",
  "source_text",
  "raw_source_text",
  "copied_excerpt",
  "quote",
]);
const QUANT_GUARD_FIELDS = [
  "target_outcome",
  "data_lineage",
  "as_of",
  "known_at_time",
  "leakage_boundary",
  "baseline",
  "calibration",
];
const LEAKAGE_RECURRENCE_REQUIRED_DIAGNOSTICS = [
  "leakage_boundary",
  "data_lineage",
  "controls_baselines",
  "diagnostic_only",
  "result_claim_validation",
];
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

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pushIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function walkObject(value, visit, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkObject(entry, visit, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    visit({ key, value: entry, path: entryPath });
    walkObject(entry, visit, entryPath);
  }
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(asString(value));
}

function isProjectRelativePath(value) {
  const text = asString(value);
  return !!text && !text.startsWith("/") && !text.includes("..") && !text.includes("\\");
}

function sourceRefLabel(ref) {
  return [
    asString(ref?.project),
    asString(ref?.source_path),
    asString(ref?.evidence_id),
  ].filter(Boolean).join(":");
}

function sanitizeFactAtom(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "real_episode";
}

function sourceFindingId(episode, index) {
  return `F-REAL-${String(index + 1).padStart(3, "0")}-${sanitizeFactAtom(episode.id).toUpperCase()}`;
}

function ontologyFactForEpisode(episode, findingId) {
  return `ive_fact(${sanitizeFactAtom(episode.failure_mode || episode.id)},${findingId})`;
}

function routeStatusCount(status) {
  return { [status]: 1 };
}

function ticketRouteCount(route) {
  return route?.status === "deferred_with_ticket" || route?.valid_next_action === "ticket_now" ? 1 : 0;
}

function expectedForRoute(route, episode) {
  const status = asString(route?.status);
  const action = asString(route?.valid_next_action);
  const bounded = status === "accepted" || status === "deferred_with_ticket";
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Converts a fixture route lifecycle state into an expected scenario outcome.
  const blocking = status === "blocked" || status === "unrouted";
  return {
    packet_status: blocking ? "FAIL" : "PASS",
    routing_status: blocking ? "FAIL" : "PASS",
    verdict_status: blocking ? "FAIL" : bounded ? "WARN" : "PASS",
    fulfillment_status: blocking ? "not_satisfied" : bounded ? "partially_satisfied" : "satisfied",
    valid_next_action: blocking ? "ask_user" : action,
    user_decision_required: action === "ask_user" || blocking ? true : undefined,
    intake_status: blocking ? "FAIL" : "PASS",
    ticket_route_count: ticketRouteCount(route),
    non_claims_include: asArray(episode.non_claims).length > 0
      ? [asString(episode.non_claims[0]).slice(0, 80)]
      : undefined,
    evidence_refs: route?.ticket_ref ? [route.ticket_ref] : undefined,
    route_status_counts: routeStatusCount(status),
  };
}

function validateQuantGuard(episode, issues, path) {
  if (!episode.quant_guard) return;
  const guard = episode.quant_guard;
  if (!isPlainObject(guard)) {
    pushIssue(issues, "quant_guard_not_object", `${path}.quant_guard`, "quant_guard must be an object");
    return;
  }
  for (const field of QUANT_GUARD_FIELDS) {
    if (!asString(guard[field])) {
      pushIssue(issues, "quant_guard_field_missing", `${path}.quant_guard.${field}`, `quant_guard.${field} is required`);
    }
  }
  if (guard.promotion_allowed !== false) {
    pushIssue(
      issues,
      "quant_guard_promotion_not_forbidden",
      `${path}.quant_guard.promotion_allowed`,
      "quant_guard.promotion_allowed must be false",
    );
  }
}

function validateLeakageRecurrence(episode, issues, path) {
  if (!episode.leakage_recurrence) return;
  const recurrence = episode.leakage_recurrence;
  if (!isPlainObject(recurrence)) {
    pushIssue(
      issues,
      "leakage_recurrence_not_object",
      `${path}.leakage_recurrence`,
      "leakage_recurrence must be an object",
    );
    return;
  }

  for (const field of ["leakage_vector", "known_at_time_statement", "temporal_split"]) {
    if (!asString(recurrence[field])) {
      pushIssue(
        issues,
        "leakage_recurrence_field_missing",
        `${path}.leakage_recurrence.${field}`,
        `leakage_recurrence.${field} is required`,
      );
    }
  }
  if (asArray(recurrence.controls_baselines).length === 0) {
    pushIssue(
      issues,
      "leakage_recurrence_controls_baselines_missing",
      `${path}.leakage_recurrence.controls_baselines`,
      "leakage_recurrence.controls_baselines requires at least one control or baseline",
    );
  }
  const diagnostics = new Set(uniqueStrings(asArray(recurrence.required_diagnostics)));
  for (const diagnostic of LEAKAGE_RECURRENCE_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "leakage_recurrence_required_diagnostic_missing",
        `${path}.leakage_recurrence.required_diagnostics`,
        `leakage recurrence diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const claimValidation = recurrence.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "leakage_recurrence_result_claim_validation_missing",
      `${path}.leakage_recurrence.result_claim_validation`,
      "leakage_recurrence.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "leakage_recurrence_promotion_not_forbidden",
      `${path}.leakage_recurrence.result_claim_validation.promotion_allowed`,
      "leakage recurrence result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "leakage_recurrence_promotion_verdict_invalid",
      `${path}.leakage_recurrence.result_claim_validation.promotion_verdict`,
      "leakage recurrence result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "leakage_recurrence_result_claims_not_empty",
      `${path}.leakage_recurrence.result_claim_validation.result_claims`,
      "leakage recurrence fixtures must not emit result claims",
    );
  }
}

function validateMissedFeatureReplay(episode, issues, path) {
  if (!episode.missed_feature_replay) return;
  const replay = episode.missed_feature_replay;
  if (!isPlainObject(replay)) {
    pushIssue(
      issues,
      "missed_feature_replay_not_object",
      `${path}.missed_feature_replay`,
      "missed_feature_replay must be an object",
    );
    return;
  }

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
      pushIssue(
        issues,
        "missed_feature_replay_field_missing",
        `${path}.missed_feature_replay.${field}`,
        `missed_feature_replay.${field} is required`,
      );
    }
  }
  if (asArray(replay.controls_baselines).length === 0) {
    pushIssue(
      issues,
      "missed_feature_replay_controls_baselines_missing",
      `${path}.missed_feature_replay.controls_baselines`,
      "missed_feature_replay.controls_baselines requires at least one control or baseline",
    );
  }
  const diagnostics = new Set(uniqueStrings(asArray(replay.required_diagnostics)));
  for (const diagnostic of MISSED_FEATURE_REPLAY_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "missed_feature_replay_required_diagnostic_missing",
        `${path}.missed_feature_replay.required_diagnostics`,
        `missed feature replay diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const claimValidation = replay.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "missed_feature_replay_result_claim_validation_missing",
      `${path}.missed_feature_replay.result_claim_validation`,
      "missed_feature_replay.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "missed_feature_replay_promotion_not_forbidden",
      `${path}.missed_feature_replay.result_claim_validation.promotion_allowed`,
      "missed feature replay result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "missed_feature_replay_promotion_verdict_invalid",
      `${path}.missed_feature_replay.result_claim_validation.promotion_verdict`,
      "missed feature replay result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "missed_feature_replay_result_claims_not_empty",
      `${path}.missed_feature_replay.result_claim_validation.result_claims`,
      "missed feature replay fixtures must not emit result claims",
    );
  }
}

function validateExperimentLedgerProvenance(episode, issues, path) {
  if (!episode.experiment_ledger_provenance) return;
  const ledger = episode.experiment_ledger_provenance;
  if (!isPlainObject(ledger)) {
    pushIssue(
      issues,
      "experiment_ledger_provenance_not_object",
      `${path}.experiment_ledger_provenance`,
      "experiment_ledger_provenance must be an object",
    );
    return;
  }

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
      pushIssue(
        issues,
        "experiment_ledger_field_missing",
        `${path}.experiment_ledger_provenance.${field}`,
        `experiment_ledger_provenance.${field} is required`,
      );
    }
  }
  for (const [field, label] of [
    ["baseline_refs", "baseline reference"],
    ["controls_baselines", "control or baseline"],
  ]) {
    if (asArray(ledger[field]).length === 0) {
      pushIssue(
        issues,
        `experiment_ledger_${field}_missing`,
        `${path}.experiment_ledger_provenance.${field}`,
        `experiment_ledger_provenance.${field} requires at least one ${label}`,
      );
    }
  }
  const diagnostics = new Set(uniqueStrings(asArray(ledger.required_diagnostics)));
  for (const diagnostic of EXPERIMENT_LEDGER_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "experiment_ledger_required_diagnostic_missing",
        `${path}.experiment_ledger_provenance.required_diagnostics`,
        `experiment ledger diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const claimValidation = ledger.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "experiment_ledger_result_claim_validation_missing",
      `${path}.experiment_ledger_provenance.result_claim_validation`,
      "experiment_ledger_provenance.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "experiment_ledger_promotion_not_forbidden",
      `${path}.experiment_ledger_provenance.result_claim_validation.promotion_allowed`,
      "experiment ledger result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "experiment_ledger_promotion_verdict_invalid",
      `${path}.experiment_ledger_provenance.result_claim_validation.promotion_verdict`,
      "experiment ledger result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "experiment_ledger_result_claims_not_empty",
      `${path}.experiment_ledger_provenance.result_claim_validation.result_claims`,
      "experiment ledger fixtures must not emit result claims",
    );
  }
}

function isObjectiveFrozen(value) {
  if (value === true) return true;
  return ["true", "frozen"].includes(asString(value).toLowerCase());
}

function isEvalFeedbackTuningBlocked(value) {
  if (value === false) return true;
  return ["false", "blocked", "none", "not_used", "not_applicable"].includes(asString(value).toLowerCase());
}

function validateOptimizerScaleContract(episode, issues, path) {
  if (!episode.optimizer_scale_contract) return;
  const contract = episode.optimizer_scale_contract;
  if (!isPlainObject(contract)) {
    pushIssue(
      issues,
      "optimizer_scale_contract_not_object",
      `${path}.optimizer_scale_contract`,
      "optimizer_scale_contract must be an object",
    );
    return;
  }

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
      pushIssue(
        issues,
        "optimizer_scale_field_missing",
        `${path}.optimizer_scale_contract.${field}`,
        `optimizer_scale_contract.${field} is required`,
      );
    }
  }
  for (const field of ["trial_count", "unique_param_count", "active_param_count"]) {
    const value = asNumber(contract[field]);
    if (value === null || value < 0) {
      pushIssue(
        issues,
        `optimizer_scale_${field}_missing`,
        `${path}.optimizer_scale_contract.${field}`,
        `optimizer_scale_contract.${field} must be a non-negative number`,
      );
    }
  }
  if (asArray(contract.search_surface).length === 0 && !asString(contract.search_surface)) {
    pushIssue(
      issues,
      "optimizer_scale_search_surface_missing",
      `${path}.optimizer_scale_contract.search_surface`,
      "optimizer_scale_contract.search_surface requires at least one search-surface dimension",
    );
  }
  if (asArray(contract.controls_baselines).length === 0) {
    pushIssue(
      issues,
      "optimizer_scale_controls_baselines_missing",
      `${path}.optimizer_scale_contract.controls_baselines`,
      "optimizer_scale_contract.controls_baselines requires at least one control or baseline",
    );
  }
  if (!isObjectiveFrozen(contract.objective_frozen)) {
    pushIssue(
      issues,
      "optimizer_scale_objective_not_frozen",
      `${path}.optimizer_scale_contract.objective_frozen`,
      "optimizer_scale_contract.objective_frozen must be true/frozen",
    );
  }
  if (!isEvalFeedbackTuningBlocked(contract.eval_feedback_tuning)) {
    pushIssue(
      issues,
      "optimizer_scale_eval_feedback_tuning_not_blocked",
      `${path}.optimizer_scale_contract.eval_feedback_tuning`,
      "optimizer_scale_contract.eval_feedback_tuning must be false/blocked",
    );
  }
  const diagnostics = new Set(uniqueStrings(asArray(contract.required_diagnostics)));
  for (const diagnostic of OPTIMIZER_SCALE_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "optimizer_scale_required_diagnostic_missing",
        `${path}.optimizer_scale_contract.required_diagnostics`,
        `optimizer scale diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const runClass = asString(contract.run_class);
  const trialCount = asNumber(contract.trial_count);
  const uniqueParamCount = asNumber(contract.unique_param_count);
  const activeParamCount = asNumber(contract.active_param_count);
  const scaleVerdict = asString(contract.scale_verdict);
  if (INTERPRETIVE_OPTIMIZER_RUN_CLASSES.has(runClass)) {
    if (!ADEQUATE_OPTIMIZER_SCALE_VERDICTS.has(scaleVerdict)) {
      pushIssue(
        issues,
        "optimizer_scale_underpowered_serious_search",
        `${path}.optimizer_scale_contract.scale_verdict`,
        "serious optimizer search requires an adequate scale verdict",
      );
    }
    if (
      trialCount !== null &&
      uniqueParamCount !== null &&
      activeParamCount !== null &&
      (trialCount < uniqueParamCount || trialCount < activeParamCount)
    ) {
      pushIssue(
        issues,
        "optimizer_scale_trial_budget_underpowered",
        `${path}.optimizer_scale_contract.trial_count`,
        "serious optimizer search requires trial_count to cover unique and active parameter counts",
      );
    }
  }
  const claimValidation = contract.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "optimizer_scale_result_claim_validation_missing",
      `${path}.optimizer_scale_contract.result_claim_validation`,
      "optimizer_scale_contract.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "optimizer_scale_promotion_not_forbidden",
      `${path}.optimizer_scale_contract.result_claim_validation.promotion_allowed`,
      "optimizer scale result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "optimizer_scale_promotion_verdict_invalid",
      `${path}.optimizer_scale_contract.result_claim_validation.promotion_verdict`,
      "optimizer scale result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "optimizer_scale_result_claims_not_empty",
      `${path}.optimizer_scale_contract.result_claim_validation.result_claims`,
      "optimizer scale fixtures must not emit result claims",
    );
  }
}

function validateSoftwareValidationPath(episode, issues, path) {
  if (!episode.software_validation_path) return;
  const contract = episode.software_validation_path;
  if (!isPlainObject(contract)) {
    pushIssue(
      issues,
      "software_validation_path_not_object",
      `${path}.software_validation_path`,
      "software_validation_path must be an object",
    );
    return;
  }

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
      pushIssue(
        issues,
        "software_validation_path_field_missing",
        `${path}.software_validation_path.${field}`,
        `software_validation_path.${field} is required`,
      );
    }
  }
  for (const [field, label] of [
    ["validation_layers", "validation layer"],
    ["controls_baselines", "control or baseline"],
    ["detected_failure_modes", "detected false-validation mode"],
  ]) {
    if (asArray(contract[field]).length === 0) {
      pushIssue(
        issues,
        `software_validation_path_${field}_missing`,
        `${path}.software_validation_path.${field}`,
        `software_validation_path.${field} requires at least one ${label}`,
      );
    }
  }
  const detectedFailureModes = new Set(uniqueStrings(asArray(contract.detected_failure_modes)));
  if (![...detectedFailureModes].some((mode) => SOFTWARE_VALIDATION_FAILURE_MODES.has(mode))) {
    pushIssue(
      issues,
      "software_validation_path_failure_mode_missing",
      `${path}.software_validation_path.detected_failure_modes`,
      "software_validation_path.detected_failure_modes must include a recognized false-validation mode",
    );
  }
  if (contract.migration_smoke_required !== true) {
    pushIssue(
      issues,
      "software_validation_path_migration_smoke_not_required",
      `${path}.software_validation_path.migration_smoke_required`,
      "software_validation_path.migration_smoke_required must be true",
    );
  }
  if (episode.quant_guard && contract.quant_results_validation_required !== true) {
    pushIssue(
      issues,
      "software_validation_path_quant_results_validation_not_required",
      `${path}.software_validation_path.quant_results_validation_required`,
      "software_validation_path.quant_results_validation_required must be true for quant-adjacent fixtures",
    );
  }
  const diagnostics = new Set(uniqueStrings(asArray(contract.required_diagnostics)));
  for (const diagnostic of SOFTWARE_VALIDATION_PATH_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "software_validation_path_required_diagnostic_missing",
        `${path}.software_validation_path.required_diagnostics`,
        `software validation path diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const claimValidation = contract.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "software_validation_path_result_claim_validation_missing",
      `${path}.software_validation_path.result_claim_validation`,
      "software_validation_path.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "software_validation_path_promotion_not_forbidden",
      `${path}.software_validation_path.result_claim_validation.promotion_allowed`,
      "software validation path result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "software_validation_path_promotion_verdict_invalid",
      `${path}.software_validation_path.result_claim_validation.promotion_verdict`,
      "software validation path result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "software_validation_path_result_claims_not_empty",
      `${path}.software_validation_path.result_claim_validation.result_claims`,
      "software validation path fixtures must not emit result claims",
    );
  }
}

function validateControlsCalibrationReplay(episode, issues, path) {
  if (!episode.controls_calibration_replay) return;
  const replay = episode.controls_calibration_replay;
  if (!isPlainObject(replay)) {
    pushIssue(
      issues,
      "controls_calibration_replay_not_object",
      `${path}.controls_calibration_replay`,
      "controls_calibration_replay must be an object",
    );
    return;
  }

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
      pushIssue(
        issues,
        `controls_calibration_${field}_missing`,
        `${path}.controls_calibration_replay.${field}`,
        `controls_calibration_replay.${field} is required`,
      );
    }
  }
  for (const [field, label] of [
    ["controls_baselines", "control or baseline"],
    ["evidence_families", "evidence family"],
  ]) {
    if (asArray(replay[field]).length === 0) {
      pushIssue(
        issues,
        `controls_calibration_${field}_missing`,
        `${path}.controls_calibration_replay.${field}`,
        `controls_calibration_replay.${field} requires at least one ${label}`,
      );
    }
  }
  const evidenceFamilies = new Set(uniqueStrings(asArray(replay.evidence_families)));
  if (![...evidenceFamilies].some((family) => CONTROLS_CALIBRATION_EVIDENCE_FAMILIES.has(family))) {
    pushIssue(
      issues,
      "controls_calibration_evidence_family_missing",
      `${path}.controls_calibration_replay.evidence_families`,
      "controls_calibration_replay.evidence_families must include a recognized baseline or calibration evidence family",
    );
  }
  const diagnostics = new Set(uniqueStrings(asArray(replay.required_diagnostics)));
  for (const diagnostic of CONTROLS_CALIBRATION_REPLAY_REQUIRED_DIAGNOSTICS) {
    if (!diagnostics.has(diagnostic)) {
      pushIssue(
        issues,
        "controls_calibration_required_diagnostic_missing",
        `${path}.controls_calibration_replay.required_diagnostics`,
        `controls/calibration diagnostic '${diagnostic}' is required`,
      );
    }
  }
  const claimValidation = replay.result_claim_validation;
  if (!isPlainObject(claimValidation)) {
    pushIssue(
      issues,
      "controls_calibration_result_claim_validation_missing",
      `${path}.controls_calibration_replay.result_claim_validation`,
      "controls_calibration_replay.result_claim_validation is required",
    );
    return;
  }
  if (claimValidation.promotion_allowed !== false) {
    pushIssue(
      issues,
      "controls_calibration_promotion_not_forbidden",
      `${path}.controls_calibration_replay.result_claim_validation.promotion_allowed`,
      "controls/calibration result_claim_validation.promotion_allowed must be false",
    );
  }
  if (asString(claimValidation.promotion_verdict) !== "diagnostic_only") {
    pushIssue(
      issues,
      "controls_calibration_promotion_verdict_invalid",
      `${path}.controls_calibration_replay.result_claim_validation.promotion_verdict`,
      "controls/calibration result_claim_validation.promotion_verdict must be diagnostic_only",
    );
  }
  if (asArray(claimValidation.result_claims).length !== 0) {
    pushIssue(
      issues,
      "controls_calibration_result_claims_not_empty",
      `${path}.controls_calibration_replay.result_claim_validation.result_claims`,
      "controls/calibration fixtures must not emit result claims",
    );
  }
}

function validateRoute(episode, issues, path) {
  const route = episode.route;
  if (!isPlainObject(route)) {
    pushIssue(issues, "route_missing", `${path}.route`, "episode.route is required");
    return;
  }
  if (!ROUTE_STATUSES.has(asString(route.status))) {
    pushIssue(issues, "route_status_invalid", `${path}.route.status`, "route.status is not supported by IVE routing");
  }
  if (!NEXT_ACTIONS.has(asString(route.valid_next_action))) {
    pushIssue(
      issues,
      "route_action_invalid",
      `${path}.route.valid_next_action`,
      "route.valid_next_action is not supported by IVE verdict rendering",
    );
  }
  if (route.status === "deferred_with_ticket" && !asString(route.ticket_ref)) {
    pushIssue(issues, "ticket_ref_missing", `${path}.route.ticket_ref`, "deferred routes require ticket_ref");
  }
  if (route.status === "deferred_with_ticket" && asArray(route.acceptance_criteria).length === 0) {
    pushIssue(
      issues,
      "acceptance_criteria_missing",
      `${path}.route.acceptance_criteria`,
      "deferred routes require acceptance criteria",
    );
  }
  if (route.status === "accepted" && !asString(route.claim_boundary)) {
    pushIssue(issues, "claim_boundary_missing", `${path}.route.claim_boundary`, "accepted routes require claim_boundary");
  }
}

function validateSourceRefs(episode, issues, path) {
  if (asArray(episode.source_refs).length === 0) {
    pushIssue(issues, "source_refs_missing", `${path}.source_refs`, "each real episode requires source_refs");
  }
  asArray(episode.source_refs).forEach((ref, index) => {
    const refPath = `${path}.source_refs[${index}]`;
    if (!asString(ref?.project)) pushIssue(issues, "source_project_missing", `${refPath}.project`, "source project is required");
    if (!isProjectRelativePath(ref?.source_path)) {
      pushIssue(
        issues,
        "source_path_not_project_relative",
        `${refPath}.source_path`,
        "source_path must be project-relative and not absolute",
      );
    }
    if (!validSha256(ref?.source_sha256)) {
      pushIssue(issues, "source_sha256_invalid", `${refPath}.source_sha256`, "source_sha256 must be a 64-char sha256");
    }
    if (!asString(ref?.evidence_kind)) {
      pushIssue(issues, "evidence_kind_missing", `${refPath}.evidence_kind`, "evidence kind is required");
    }
    if (!asString(ref?.evidence_id)) {
      pushIssue(issues, "evidence_id_missing", `${refPath}.evidence_id`, "evidence id is required");
    }
  });
}

function validateRealEpisodeCorpus(corpus) {
  const issues = [];
  if (!isPlainObject(corpus)) {
    return { ok: false, status: "FAIL", issues: [{ code: "corpus_not_object", path: "$", message: "corpus must be an object" }] };
  }
  if (corpus.schema_version !== REAL_EPISODE_CORPUS_SCHEMA_VERSION) {
    pushIssue(issues, "schema_version_invalid", "$.schema_version", "unsupported real episode corpus schema version");
  }
  if (corpus?.source_policy?.source_excerpt_included !== false) {
    pushIssue(
      issues,
      "source_excerpt_policy_invalid",
      "$.source_policy.source_excerpt_included",
      "corpus must explicitly record that source excerpts are not included",
    );
  }

  walkObject(corpus, ({ key, path }) => {
    if (FORBIDDEN_SOURCE_KEYS.has(key)) {
      pushIssue(issues, "forbidden_source_text_key", path, `forbidden raw source key '${key}' is not allowed`);
    }
  });

  const episodes = asArray(corpus.episodes);
  if (episodes.length === 0) pushIssue(issues, "episodes_missing", "$.episodes", "corpus requires at least one episode");
  const ids = new Set();
  episodes.forEach((episode, index) => {
    const path = `$.episodes[${index}]`;
    if (!isPlainObject(episode)) {
      pushIssue(issues, "episode_not_object", path, "episode must be an object");
      return;
    }
    const id = asString(episode.id);
    if (!id) pushIssue(issues, "episode_id_missing", `${path}.id`, "episode id is required");
    if (ids.has(id)) pushIssue(issues, "episode_id_duplicate", `${path}.id`, `duplicate episode id ${id}`);
    ids.add(id);
    if (!asString(episode.title)) pushIssue(issues, "episode_title_missing", `${path}.title`, "episode title is required");
    if (!asString(episode.family)) pushIssue(issues, "episode_family_missing", `${path}.family`, "episode family is required");
    if (!asString(episode.finding_summary)) {
      pushIssue(issues, "finding_summary_missing", `${path}.finding_summary`, "finding summary is required");
    }
    if (!isPlainObject(episode.knowledge_trigger)) {
      pushIssue(issues, "knowledge_trigger_missing", `${path}.knowledge_trigger`, "knowledge_trigger is required");
    }
    validateSourceRefs(episode, issues, path);
    validateRoute(episode, issues, path);
    validateQuantGuard(episode, issues, path);
    validateLeakageRecurrence(episode, issues, path);
    validateMissedFeatureReplay(episode, issues, path);
    validateExperimentLedgerProvenance(episode, issues, path);
    validateOptimizerScaleContract(episode, issues, path);
    validateSoftwareValidationPath(episode, issues, path);
    validateControlsCalibrationReplay(episode, issues, path);
  });

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "PASS" : "FAIL",
    issues,
    summary: {
      episode_count: episodes.length,
      families: uniqueStrings(episodes.map((episode) => episode?.family)),
      quant_guard_count: episodes.filter((episode) => !!episode?.quant_guard).length,
      leakage_recurrence_count: episodes.filter((episode) => !!episode?.leakage_recurrence).length,
      missed_feature_replay_count: episodes.filter((episode) => !!episode?.missed_feature_replay).length,
      experiment_ledger_provenance_count: episodes.filter((episode) => !!episode?.experiment_ledger_provenance).length,
      optimizer_scale_contract_count: episodes.filter((episode) => !!episode?.optimizer_scale_contract).length,
      software_validation_path_count: episodes.filter((episode) => !!episode?.software_validation_path).length,
      controls_calibration_replay_count: episodes.filter((episode) => !!episode?.controls_calibration_replay).length,
      knowledge_trigger_count: episodes.filter((episode) => !!episode?.knowledge_trigger).length,
    },
  };
}

function loadRealEpisodeCorpus(filePath = DEFAULT_REAL_EPISODE_CORPUS_PATH) {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Real episode corpus not found: ${resolved}`);
  }
  const corpus = JSON.parse(readFileSync(resolved, "utf-8"));
  return {
    path: resolved,
    corpus,
    validation: validateRealEpisodeCorpus(corpus),
  };
}

function buildRoute(episode, findingId) {
  const route = deepClone(episode.route);
  return {
    source_finding: findingId,
    ontology_fact: ontologyFactForEpisode(episode, findingId),
    material: true,
    evidence_refs: asArray(episode.source_refs).map(sourceRefLabel),
    story_refs: ["US-077", "US-079", "US-PM-AUTO-069", "US-PM-AUTO-070"],
    ...route,
  };
}

function buildPacket({ episode, route, findingId, corpus }) {
  const sourceLabels = asArray(episode.source_refs).map(sourceRefLabel);
  const nonClaims = uniqueStrings([
    "No ROI, alpha, betting, investment, model-performance, or live-trading claim is made by this fixture.",
    ...asArray(episode.non_claims),
  ]);
  return {
    schema_version: 1,
    intent: {
      goal: `Replay real Mac mini episode ${episode.id} through IVE fact routing.`,
      what_ran: [
        "Real episode corpus schema validation",
        "IVE packet contract validation",
        "IVE fact routing validation",
        "IVE user verdict rendering",
        "IVE Program Manager intake mapping",
      ],
      what_did_not_run: [
        "Live market data pull",
        "Model training",
        "Backtest execution",
        "External GitHub ticket publication",
      ],
      story_refs: asArray(corpus.story_refs),
    },
    source_findings: [
      {
        id: findingId,
        summary: episode.finding_summary,
        source_refs: sourceLabels,
      },
    ],
    ontology_facts: [
      {
        ontology_fact: route.ontology_fact,
        source_finding: findingId,
        material: true,
      },
    ],
    concept_dictionary: {
      real_episode_replay: "A hashed local project episode routed through IVE without copying raw source excerpts.",
      autocode_loop: "An autonomous coding loop must stop, repair, experiment, ask, or accept a limitation instead of closing with prose.",
    },
    fact_routes: [route],
    closure_status: ["blocked", "unrouted"].includes(route.status) ? "blocked" : "closeable",
    closure_reason: ["blocked", "unrouted"].includes(route.status)
      ? "A material real-episode fact still needs the stated next action."
      : "The material real-episode fact has an explicit deterministic route.",
    evidence_refs: sourceLabels,
    non_claims: nonClaims,
    false_green_risk: `Autocode could repeat ${episode.failure_mode} if this route is hidden in prose.`,
    strongest_counterargument: episode.aha_pattern,
    advisory_review: {
      status: "not_run",
      false_green_risk: `Autocode could repeat ${episode.failure_mode} without the route guard.`,
      strongest_counterargument: episode.aha_pattern,
    },
  };
}

function buildRealEpisodeScenarioFixtures(corpus) {
  const validation = validateRealEpisodeCorpus(corpus);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new Error(`Real episode corpus is invalid: ${first.code} at ${first.path}: ${first.message}`);
  }
  return asArray(corpus.episodes).map((episode, index) => {
    const findingId = sourceFindingId(episode, index);
    const route = buildRoute(episode, findingId);
    return {
      id: episode.id,
      title: episode.title,
      family: episode.family,
      source_refs: deepClone(episode.source_refs),
      knowledge_trigger: deepClone(episode.knowledge_trigger),
      packet: buildPacket({ episode, route, findingId, corpus }),
      quant_guard: episode.quant_guard ? deepClone(episode.quant_guard) : undefined,
      leakage_recurrence: episode.leakage_recurrence ? deepClone(episode.leakage_recurrence) : undefined,
      missed_feature_replay: episode.missed_feature_replay ? deepClone(episode.missed_feature_replay) : undefined,
      experiment_ledger_provenance: episode.experiment_ledger_provenance
        ? deepClone(episode.experiment_ledger_provenance)
        : undefined,
      optimizer_scale_contract: episode.optimizer_scale_contract
        ? deepClone(episode.optimizer_scale_contract)
        : undefined,
      software_validation_path: episode.software_validation_path
        ? deepClone(episode.software_validation_path)
        : undefined,
      controls_calibration_replay: episode.controls_calibration_replay
        ? deepClone(episode.controls_calibration_replay)
        : undefined,
      expected: expectedForRoute(route, episode),
    };
  });
}

export {
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  REAL_EPISODE_CORPUS_SCHEMA_VERSION,
  buildRealEpisodeScenarioFixtures,
  loadRealEpisodeCorpus,
  validateRealEpisodeCorpus,
};
