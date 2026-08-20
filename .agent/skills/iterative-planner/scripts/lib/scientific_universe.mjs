// scientific_universe.mjs — actual membership, ranking, exclusion, and survivorship checks.
// @planner:module = scientific_universe
// @planner:capability = artifact_backed_universe_membership_validation
// @planner:story = US-003
// @planner:proves = crit:sc_2

import { asObject, issue } from "./scientific_contract.mjs";

export function evaluateScientificUniverse(universeArtifact, executedConfig) {
  const issues = [];
  const warnings = [];
  const payload = asObject(universeArtifact?.payload);
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const eligible = assets.filter((row) => row?.eligible === true);
  const excluded = assets.filter((row) => row?.eligible !== true);
  const target = Number(asObject(executedConfig?.payload).universe_target_count);
  if (typeof payload.as_of !== "string" || !Number.isFinite(Date.parse(`${payload.as_of}T00:00:00Z`))) issues.push(issue("universe_as_of_missing", "universe as_of must be a date"));
  if (typeof payload.ranking_method !== "string" || !payload.ranking_method.trim()) issues.push(issue("universe_ranking_missing", "ranking method is required"));
  if (typeof payload.survivorship_policy !== "string" || !payload.survivorship_policy.trim()) issues.push(issue("universe_survivorship_policy_missing", "survivorship policy is required"));
  if (!Array.isArray(payload.sensitivity) || payload.sensitivity.length === 0) warnings.push(issue("universe_sensitivity_missing", "universe sensitivity analysis is required for promotion", "warning"));
  if (!Number.isInteger(target) || target < 1) issues.push(issue("universe_target_invalid", "executed universe_target_count must be positive"));
  else if (eligible.length !== target) issues.push(issue("universe_count_mismatch", `target ${target} but actual eligible membership ${eligible.length}`));
  const ids = new Set();
  const ranks = new Set();
  for (const row of assets) {
    if (typeof row?.asset_id !== "string" || !row.asset_id.trim() || ids.has(row.asset_id)) issues.push(issue("universe_asset_identity_invalid", String(row?.asset_id || "missing")));
    else ids.add(row.asset_id);
    if (!Number.isInteger(row?.rank) || row.rank < 1 || ranks.has(row.rank)) issues.push(issue("universe_rank_invalid", `${row?.asset_id || "unknown"}:${row?.rank}`));
    else ranks.add(row.rank);
  }
  for (const row of excluded) {
    if (typeof row?.exclusion_reason !== "string" || !row.exclusion_reason.trim()) issues.push(issue("universe_exclusion_reason_missing", row?.asset_id || "unknown"));
  }
  return { valid: issues.length === 0, exploratory: warnings.length > 0, issues, warnings, actual_asset_ids: eligible.map((row) => row.asset_id).sort(), eligible_count: eligible.length, excluded_count: excluded.length };
}
