// scientific_review.mjs — read-only semantic scientific reviewer composition.
// @planner:module = scientific_review
// @planner:capability = deterministic_artifact_backed_scientific_review_orchestration
// @planner:story = US-003
// @planner:proves = crit:sc_1, crit:sc_2, crit:sc_3, crit:sc_5

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import {
  SCIENTIFIC_REVIEW_RECEIPT_SCHEMA, asObject, issue, readScientificArtifactSet,
  resolveDeclaredPath, sha256File, uniqueIssues, validateScientificReviewRequest,
} from "./scientific_contract.mjs";
import { evaluateScientificTimeWindows } from "./scientific_time_windows.mjs";
import { evaluateScientificPower } from "./scientific_power.mjs";
import { evaluateScientificParameterChoices } from "./scientific_parameter_choices.mjs";
import { evaluateScientificUniverse } from "./scientific_universe.mjs";
import { evaluateScientificProvenance } from "./scientific_provenance.mjs";
import { evaluateScientificIdentity } from "./scientific_identity.mjs";
import { evaluateScientificCounterarguments } from "./scientific_counterarguments.mjs";
import { composeScientificVerdict } from "./scientific_verdict.mjs";

export function legacyScientificReviewReceipt(reason = "scientific review request is absent") {
  return {
    schema_version: SCIENTIFIC_REVIEW_RECEIPT_SCHEMA,
    execution_status: "not_run",
    design_validity: "unresolved",
    evidence_grade: "legacy_unknown",
    scientific_verdict: "not_evaluated",
    promotion_status: "blocked",
    satisfied: false,
    blockers: [{ code: "legacy_scientific_evidence_unknown", detail: reason, severity: "blocker" }],
    warnings: [],
    recomputed: {},
    checks: {},
  };
}

function invalidScientificReviewReceipt(code, detail) {
  return {
    schema_version: SCIENTIFIC_REVIEW_RECEIPT_SCHEMA,
    execution_status: "not_run",
    design_validity: "invalid",
    evidence_grade: "legacy_unknown",
    scientific_verdict: "not_evaluated",
    promotion_status: "blocked",
    satisfied: false,
    blockers: [{ code, detail, severity: "blocker" }],
    warnings: [],
    recomputed: {},
    checks: {},
  };
}

export function reviewScientificEvidence(referenceInput, { qrvPath, projectRoot }) {
  const reference = typeof referenceInput === "string" ? { path: referenceInput } : asObject(referenceInput);
  const resolved = resolveDeclaredPath(reference, { requestPath: qrvPath, projectRoot });
  if (resolved.issue || !resolved.path || !existsSync(resolved.path)) return invalidScientificReviewReceipt("scientific_review_request_unreadable", `scientific review request ${resolved.issue || "is missing"}`);
  if (reference.sha256 && sha256File(resolved.path) !== reference.sha256) {
    return invalidScientificReviewReceipt("scientific_review_request_hash_mismatch", "scientific review request hash mismatch");
  }
  let request;
  try { request = JSON.parse(readFileSync(resolved.path, "utf8")); }
  catch { return invalidScientificReviewReceipt("scientific_review_request_invalid_json", "scientific review request is invalid JSON"); }
  const contract = validateScientificReviewRequest(request);
  const loaded = readScientificArtifactSet(request, { requestPath: resolved.path, projectRoot });
  const artifacts = loaded.artifacts;
  const time = evaluateScientificTimeWindows(artifacts.preregistration, artifacts.executed_config);
  const power = evaluateScientificPower(artifacts, request.minimums);
  const parameters = evaluateScientificParameterChoices(artifacts.preregistration, artifacts.executed_config);
  const universe = evaluateScientificUniverse(artifacts.universe, artifacts.executed_config);
  const identity = evaluateScientificIdentity(artifacts, request.expected_identity);
  const counterarguments = evaluateScientificCounterarguments(artifacts.result);
  const provenance = evaluateScientificProvenance(request, artifacts, loaded.paths, { requestPath: resolved.path, projectRoot });
  const resultOutcome = asObject(artifacts.result?.payload).outcome;
  const claimDirectionIssues = resultOutcome && request.claim_direction !== resultOutcome
    ? [issue("result_direction_differs_from_request", `result outcome ${resultOutcome} != requested ${request.claim_direction}`)]
    : [];
  const structural = [
    ...contract.issues.map((detail) => issue("scientific_request_contract_invalid", detail)),
    ...loaded.issues.map((detail) => issue("scientific_artifact_invalid", detail)),
    ...time.issues, ...power.issues, ...parameters.issues, ...universe.issues,
    ...identity.issues, ...counterarguments.issues, ...provenance.issues,
    ...claimDirectionIssues,
  ];
  const warnings = uniqueIssues([
    ...power.warnings, ...parameters.warnings, ...universe.warnings,
    ...counterarguments.warnings, ...provenance.warnings,
  ]);
  const blockers = uniqueIssues(structural.filter((row) => row.severity !== "warning"));
  const axes = composeScientificVerdict({
    blockers, warnings, power, provenance, resultArtifact: artifacts.result,
    runClass: asObject(request.run_metadata).run_class,
    confirmationStage: request.confirmation_stage === true,
  });
  return {
    schema_version: SCIENTIFIC_REVIEW_RECEIPT_SCHEMA,
    ...axes,
    satisfied: blockers.length === 0 && axes.execution_status === "complete" && !["smoke_fixture", "underpowered", "legacy_unknown"].includes(axes.evidence_grade),
    blockers,
    warnings,
    recomputed: {
      counts: power.counts,
      actual_assets: universe.actual_asset_ids,
      actual_windows: time.actual_windows,
      fixture_reasons: provenance.fixture_reasons,
      code_revision: provenance.code_revision,
      request_sha256: sha256File(resolved.path),
      artifact_sha256: Object.fromEntries(Object.entries(loaded.paths).map(([role, path]) => [role, sha256File(path)])),
    },
    checks: { time, power, parameters, universe, identity, counterarguments, provenance },
  };
}
