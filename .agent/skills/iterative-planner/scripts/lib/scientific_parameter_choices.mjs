// scientific_parameter_choices.mjs — preregistered choice mechanism and sensitivity checks.
// @planner:module = scientific_parameter_choices
// @planner:capability = influential_choice_control_and_sensitivity_validation
// @planner:story = US-003
// @planner:proves = crit:sc_2, crit:sc_3

import { asObject, issue, stableJson } from "./scientific_contract.mjs";

const REQUIRED_DIMENSIONS = Object.freeze([
  "windows", "frequency", "universe", "strategy_families", "parameter_ranges",
  "weights", "thresholds", "trials", "folds",
]);

export function evaluateScientificParameterChoices(preregistration, executedConfig) {
  const issues = [];
  const warnings = [];
  const rows = Array.isArray(asObject(preregistration?.payload).parameter_choices) ? preregistration.payload.parameter_choices : [];
  const byDimension = new Map();
  for (const [index, row] of rows.entries()) {
    const dimension = String(row?.dimension || "").trim();
    if (!dimension || byDimension.has(dimension)) {
      issues.push(issue("parameter_choice_dimension_invalid", `parameter choice ${index} is missing or duplicates dimension ${dimension || "unknown"}`));
      continue;
    }
    byDimension.set(dimension, row);
    for (const key of ["mechanism", "prior", "basis"]) {
      if (typeof row?.[key] !== "string" || !row[key].trim()) issues.push(issue("parameter_choice_contract_missing", `${dimension}.${key} is required`));
    }
    if (!Array.isArray(row?.alternatives) || row.alternatives.length === 0) issues.push(issue("parameter_choice_contract_missing", `${dimension}.alternatives must be non-empty`));
    const sensitivity = asObject(row?.sensitivity);
    if (typeof sensitivity.description !== "string" || !sensitivity.description.trim() || !Array.isArray(sensitivity.outcomes) || sensitivity.outcomes.length === 0) {
      warnings.push(issue("parameter_sensitivity_missing", `${dimension} lacks a documented sensitivity outcome`, "warning"));
    }
    if (String(row?.mechanism || "").toLowerCase() === "arbitrary" && (typeof row?.rationale !== "string" || !row.rationale.trim())) {
      warnings.push(issue("arbitrary_parameter_without_rationale", `${dimension} is arbitrary without rationale`, "warning"));
    }
  }
  for (const dimension of REQUIRED_DIMENSIONS) {
    if (!byDimension.has(dimension)) issues.push(issue("parameter_choice_dimension_missing", dimension));
  }
  const selected = asObject(asObject(executedConfig?.payload).selected_parameters);
  for (const dimension of REQUIRED_DIMENSIONS) {
    if (!(dimension in selected)) issues.push(issue("executed_parameter_missing", dimension));
    else if (byDimension.has(dimension) && stableJson(selected[dimension]) !== stableJson(byDimension.get(dimension).value)) {
      issues.push(issue("executed_parameter_differs_from_preregistration", dimension));
    }
  }
  return {
    valid: issues.length === 0,
    exploratory: warnings.length > 0,
    issues,
    warnings,
    dimensions: [...byDimension.keys()].sort(),
  };
}
