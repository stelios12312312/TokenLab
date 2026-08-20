// scientific_identity.mjs — exact cross-artifact experiment, ticket, story, plan, and hypothesis identity.
// @planner:module = scientific_identity
// @planner:capability = cross_artifact_scientific_identity_reconciliation
// @planner:story = US-003
// @planner:proves = crit:sc_2

import { ARTIFACT_ROLES, asObject, issue } from "./scientific_contract.mjs";

const IDENTITY_FIELDS = Object.freeze(["experiment_id", "title", "hypothesis_id", "ticket_id", "story_id", "plan_id"]);

export function evaluateScientificIdentity(artifacts, expectedIdentity) {
  const issues = [];
  const sources = [{ role: "request", identity: asObject(expectedIdentity) }];
  for (const role of ARTIFACT_ROLES) {
    if (artifacts[role]) sources.push({ role, identity: asObject(artifacts[role].identity) });
  }
  for (const field of IDENTITY_FIELDS) {
    const expected = String(asObject(expectedIdentity)[field] || "").trim();
    for (const source of sources.slice(1)) {
      const actual = String(source.identity[field] || "").trim();
      if (actual !== expected) issues.push(issue("cross_artifact_identity_mismatch", `${source.role}.${field}=${actual || "missing"}; expected ${expected || "missing"}`));
    }
  }
  return { valid: issues.length === 0, issues, expected_identity: asObject(expectedIdentity) };
}
