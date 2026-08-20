// scientific_counterarguments.mjs — require independent challenge coverage before promotion.
// @planner:module = scientific_counterarguments
// @planner:capability = scientific_claim_boundary_and_counterargument_validation
// @planner:story = US-003
// @planner:proves = crit:sc_3

import { asObject, issue } from "./scientific_contract.mjs";

export const REQUIRED_COUNTERARGUMENTS = Object.freeze([
  "temporal_leakage", "dependence_power", "parameter_arbitrariness",
  "universe_bias", "provenance_integrity", "identity_consistency",
]);

export function evaluateScientificCounterarguments(resultArtifact) {
  const issues = [];
  const warnings = [];
  const rows = Array.isArray(asObject(resultArtifact?.payload).counterarguments) ? resultArtifact.payload.counterarguments : [];
  const byType = new Map();
  for (const [index, row] of rows.entries()) {
    const type = String(row?.type || "").trim();
    if (!type || byType.has(type)) issues.push(issue("counterargument_type_invalid", `counterargument ${index} is missing or duplicates ${type || "unknown"}`));
    else byType.set(type, row);
    if (typeof row?.assessment !== "string" || !row.assessment.trim()) issues.push(issue("counterargument_assessment_missing", type || String(index)));
    if (!["addressed", "material_gap"].includes(row?.status)) issues.push(issue("counterargument_status_invalid", type || String(index)));
    if (row?.status === "material_gap") warnings.push(issue("counterargument_material_gap", type, "warning"));
  }
  for (const type of REQUIRED_COUNTERARGUMENTS) {
    if (!byType.has(type)) issues.push(issue("counterargument_missing", type));
  }
  return { valid: issues.length === 0, exploratory: warnings.length > 0, issues, warnings, types: [...byType.keys()].sort() };
}
