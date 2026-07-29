// @planner:module = semantic_divergence
// @planner:capability = fail_closed_javascript_prolog_divergence_explanation
// @planner:story = US-084

import { verificationStatusIsHardFailure } from "./verification_status_vocabulary.mjs";

export const ORDINARY_STORY_INVARIANT_EXPLANATIONS = Object.freeze([
  "active_mistake_missing_declared_guard",
  "active_mistake_missing_verification_hook",
  "broken_evidence_chain",
  "deliverable_missing_purpose",
  "high_priority_untested",
]);

const ORDINARY_STORY_INVARIANT_SET = new Set(ORDINARY_STORY_INVARIANT_EXPLANATIONS);

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function blockingSemanticRows(semanticResults) {
  return (Array.isArray(semanticResults) ? semanticResults : [])
    .filter((row) => verificationStatusIsHardFailure(row?.status, "gate"));
}

function explainedStoryInvariantDivergence(rows) {
  if (rows.length === 0) return null;
  const violationNames = [];
  for (const row of rows) {
    if (row?.code !== "GATE-SEM-002" || !Array.isArray(row?.violations) || row.violations.length === 0) {
      return null;
    }
    for (const violation of row.violations) {
      const name = typeof violation?.name === "string" ? violation.name.trim() : "";
      if (!name || !ORDINARY_STORY_INVARIANT_SET.has(name)) return null;
      violationNames.push(name);
    }
  }
  return {
    status: "explained",
    direction: "prolog_only",
    explaining_check_ids: uniqueSorted(rows.map((row) => row.code)),
    violation_names: uniqueSorted(violationNames),
  };
}

export function classifySemanticDivergence({
  jsGateBlocked = false,
  semanticResults = [],
  enforcePrologDivergence = true,
} = {}) {
  const blockers = blockingSemanticRows(semanticResults);
  const prologBlocked = blockers.length > 0;

  if (Boolean(jsGateBlocked) === prologBlocked) return [];

  if (jsGateBlocked && !prologBlocked) {
    return [{
      name: "Prolog/JS diagnostic (RT5-M1)",
      status: "WARN",
      code: "GATE-SEM-004",
      detail: "Prolog semantic checks PASS while JS gate checks FAIL. Treating this as a normal JS gate failure unless the normalized semantic facts disagree.",
    }];
  }

  if (!enforcePrologDivergence) return [];

  const explanation = explainedStoryInvariantDivergence(blockers);
  if (explanation) {
    return [{
      name: "Prolog/JS divergence explained",
      status: "PASS",
      detail: `Prolog-only blocking is fully explained by ${explanation.explaining_check_ids.join(", ")}: ${explanation.violation_names.join(", ")}.`,
      semantic_divergence: explanation,
    }];
  }

  return [{
    name: "Prolog/JS divergence (M4-FIX)",
    status: "FAIL",
    code: "GATE-SEM-003",
    detail: "Prolog semantic checks FAIL while JS gate checks PASS, and the difference is not fully explained by the closed ordinary story-invariant contract. Possible JS gate tampering; transition blocked.",
  }];
}
