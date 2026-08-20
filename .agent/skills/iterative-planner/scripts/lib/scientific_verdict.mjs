// scientific_verdict.mjs — compose five independent axes without treating tests as evidence.
// @planner:module = scientific_verdict
// @planner:capability = independent_five_axis_scientific_decision_composition
// @planner:story = US-003
// @planner:proves = crit:sc_3, crit:sc_5

import { normalizeEnum } from "./scientific_contract.mjs";

export function composeScientificVerdict({
  blockers = [], warnings = [], power, provenance, resultArtifact, runClass, confirmationStage = false,
}) {
  const declaredExecution = normalizeEnum(resultArtifact?.payload?.execution_status);
  const executionStatus = declaredExecution === "failed"
    ? "failed"
    : power?.execution_observed && declaredExecution === "complete"
      ? "complete"
      : "not_run";
  const designValidity = blockers.length > 0 ? "invalid" : "valid";
  let evidenceGrade = "evidence";
  if (provenance?.smoke_fixture) evidenceGrade = "smoke_fixture";
  else if (power?.underpowered) evidenceGrade = "underpowered";
  else if (warnings.length > 0 || runClass === "exploratory") evidenceGrade = "exploratory";
  let scientificVerdict = "not_evaluated";
  if (executionStatus === "complete" && designValidity === "valid" && evidenceGrade === "evidence") {
    const outcome = normalizeEnum(resultArtifact?.payload?.outcome);
    scientificVerdict = outcome === "positive" ? "supported" : outcome === "negative" ? "falsified" : "inconclusive";
  } else if (executionStatus === "complete" && designValidity === "valid" && evidenceGrade === "exploratory") {
    scientificVerdict = "inconclusive";
  }
  let promotionStatus = "blocked";
  if (scientificVerdict === "supported" && evidenceGrade === "evidence") {
    promotionStatus = confirmationStage ? "eligible_for_integration_review" : "candidate_for_confirmation";
  } else if (designValidity === "valid" && executionStatus === "complete" && evidenceGrade === "exploratory") {
    promotionStatus = "research_only";
  }
  return {
    execution_status: executionStatus,
    design_validity: designValidity,
    evidence_grade: evidenceGrade,
    scientific_verdict: scientificVerdict,
    promotion_status: promotionStatus,
  };
}
