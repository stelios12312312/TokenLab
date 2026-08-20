// scientific_power.mjs — recompute usable execution and effective independent evidence.
// @planner:module = scientific_power
// @planner:capability = independently_recomputed_effective_evidence_power
// @planner:story = US-003
// @planner:proves = crit:sc_2, crit:sc_3

import { asObject, issue, normalizeEnum } from "./scientific_contract.mjs";

export function evaluateScientificPower(artifacts, minimums) {
  const issues = [];
  const warnings = [];
  const folds = Array.isArray(asObject(artifacts.folds?.payload).records) ? artifacts.folds.payload.records : [];
  const trials = Array.isArray(asObject(artifacts.trials?.payload).records) ? artifacts.trials.payload.records : [];
  const observations = Array.isArray(asObject(artifacts.observations?.payload).records) ? artifacts.observations.payload.records : [];
  const assets = Array.isArray(asObject(artifacts.universe?.payload).assets) ? artifacts.universe.payload.assets : [];
  const requestedFolds = Number(asObject(artifacts.executed_config?.payload).folds_requested);
  const requestedTrials = Number(asObject(artifacts.executed_config?.payload).trials_requested);
  const completedFolds = folds.filter((row) => normalizeEnum(row?.status) === "complete").length;
  const usableFolds = folds.filter((row) => normalizeEnum(row?.status) === "complete" && row?.usable === true).length;
  const completedTrials = trials.filter((row) => normalizeEnum(row?.status) === "complete").length;
  const eligibleObservations = observations.filter((row) => row?.eligible === true);
  const excludedObservations = observations.filter((row) => row?.eligible !== true);
  const eligibleAssets = assets.filter((row) => row?.eligible === true);
  const groups = new Set();
  for (const row of eligibleObservations) {
    if (![row?.asset_id, row?.period_id, row?.event_id].every((value) => typeof value === "string" && value.trim())) {
      issues.push(issue("observation_group_identity_missing", `eligible observation ${row?.observation_id || "unknown"} lacks asset/period/event identity`));
      continue;
    }
    groups.add(`${row.asset_id}\u0000${row.period_id}\u0000${row.event_id}`);
  }
  for (const row of excludedObservations) {
    if (typeof row?.exclusion_reason !== "string" || !row.exclusion_reason.trim()) {
      issues.push(issue("exclusion_reason_missing", `excluded observation ${row?.observation_id || "unknown"} lacks a reason`));
    }
  }
  const counts = {
    requested_folds: Number.isInteger(requestedFolds) ? requestedFolds : 0,
    completed_folds: completedFolds,
    usable_folds: usableFolds,
    requested_trials: Number.isInteger(requestedTrials) ? requestedTrials : 0,
    completed_trials: completedTrials,
    eligible_assets: eligibleAssets.length,
    total_observations: observations.length,
    eligible_observations: eligibleObservations.length,
    excluded_observations: excludedObservations.length,
    effective_groups: groups.size,
  };
  if (counts.requested_folds > 0 && counts.completed_folds === 0) issues.push(issue("execution_not_completed", "folds were requested but zero completed fold records exist"));
  if (counts.requested_trials > 0 && counts.completed_trials === 0) issues.push(issue("execution_not_completed", "trials were requested but zero completed trial records exist"));
  const thresholds = {
    assets: counts.eligible_assets,
    completed_folds: counts.usable_folds,
    completed_trials: counts.completed_trials,
    eligible_observations: counts.eligible_observations,
    effective_groups: counts.effective_groups,
  };
  const underpowered = [];
  for (const [key, actual] of Object.entries(thresholds)) {
    const required = Number(asObject(minimums)[key]);
    if (!Number.isInteger(required) || actual < required) underpowered.push({ key, actual, required: Number.isInteger(required) ? required : null });
  }
  if (underpowered.length) warnings.push(issue("underpowered", underpowered.map((row) => `${row.key}=${row.actual}<${row.required}`).join(", "), "warning"));
  return {
    valid: !issues.some((row) => row.severity === "blocker"),
    underpowered: underpowered.length > 0,
    execution_observed: completedFolds > 0 && completedTrials > 0,
    issues,
    warnings,
    counts,
    shortfalls: underpowered,
  };
}
