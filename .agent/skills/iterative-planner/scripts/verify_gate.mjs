#!/usr/bin/env node
// verify_gate.mjs — Programmatic gate-check library and planning-only diagnostic.
//
// Usage:
//   node verify_gate.mjs explore-to-plan [--plan <plan-dir>]    Check EXPLORE → PLAN gate requirements
//   node verify_gate.mjs plan-to-execute [--plan <plan-dir>] [--planning-only] Check PLAN → EXECUTE gate requirements
//   node verify_gate.mjs execute-to-reflect [--plan <plan-dir>]  Check EXECUTE → REFLECT gate requirements (red-team)
//   node verify_gate.mjs reflect-to-validate [--plan <plan-dir>] Check REFLECT → VALIDATE gate requirements
//   node verify_gate.mjs validate-to-close [--plan <plan-dir>]   Check VALIDATE → CLOSE gate requirements
//   node verify_gate.mjs notify-user [--plan <plan-dir>]         Check KB Notification Gate before presenting results
//
// Reads plan files from an explicit target plan, thread-local target, or plans/.current_plan.
// Outputs structured PASS/FAIL per check. Exit code 0 = all pass, 1 = any fail.
//
// Zero dependencies — requires Node.js 18+.

import {
  classifyPlannerPreflight,
  extractFilesToModify,
  getPaths, readPointer, resolvePlanTarget, readFile, fileExists, fileNotEmpty,
  countH2Headings, containsString, analyzeRedTeamNotes,
  analyzeIntentContract, loadIntentContract, resolveFindingsTruth, debugLog,
  PASS, WARN, FAIL, check
} from "./lib/plan_utils.mjs";
import { detectPlanShape, shapeRequiresField, shapeMinFindings } from "./lib/plan_shape.mjs";
import { basename, join } from "path";
import { readFileSync, existsSync, statSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { withFailureCode, readStateJson, KB_SALT_HEX_LEN, isFeatureEnabled } from "./lib/determinism.mjs";
import { captureEnvValues, restoreEnvValues } from "./lib/env_scope.mjs";
import { refreshPlanArtifacts } from "./lib/plan_refresh.mjs";
import { loadGateRegistry } from "./lib/gate_registry.mjs";
import {
  deriveVerificationTruth,
  deriveVerificationPresentationTruth,
  presentationResultGuidance,
} from "./lib/verification_truth.mjs";
import {
  loadGateRepairTemplate,
  renderEvidenceGuidanceLines,
  renderRepairSurface,
} from "./lib/repair_packet.mjs";
import { analyzeAnnotationDiscipline } from "./lib/annotation_discipline.mjs";
import { extractNormalizedStoryIdsFromText } from "./lib/planner_canonicalizer.mjs";
import {
  canonicalizeVerificationProofText,
  computeVerificationObligationSynthesis,
  VERIFICATION_OBLIGATION_FAMILIES,
} from "./lib/verification_obligations.mjs";
import {
  analyzeCompactLowRiskVerification,
  analyzeVerificationMatrix,
  buildVerificationEvidenceGuidance,
  CONTEXT_MATRIX_COLUMNS,
  criterionMatchesVerificationRow as matrixCriterionMatchesVerificationRow,
  extractSuccessCriteria as extractMatrixSuccessCriteria,
  getTableCell as getVerificationTableCell,
  normalizeMatrixText,
  selectCriterionStoryTable,
  summarizeVerificationMatrixDiagnostics,
} from "./lib/verification_matrix.mjs";
import {
  buildScopeContract,
  planHasAmbientDirtyScopeAcknowledgement,
  scopeContractRequiresAmbientAcknowledgement,
  summarizeScopeContract,
} from "./lib/scope_contract.mjs";
import { loadPlanWorkOrder } from "./lib/work_order_contract.mjs";
import { evaluateSemanticUpkeepContract } from "./lib/task_profile_contracts.mjs";
import { resolveAntiRitualAssessment } from "./lib/anti_ritual_contract.mjs";
import { buildPhaseContract, resolveAuthorityProfile, resolveProofPosture } from "./lib/planner_phase_routing.mjs";
import { resolveKnowledgeFromContext } from "./knowledge_resolver.mjs";
import { analyzeKbTagObligation, resolveKbTagKnowledgeContext } from "./lib/kb_plan_tags.mjs";
import { collectKbSignoff } from "./lib/kb_signoff.mjs";
import { evaluateQuantPersonaGate, summarizeQuantPersonaGate } from "./lib/quant_persona_gate.mjs";
import { computePlanLearnedObligationsSignal } from "./lib/learned_obligations.mjs";
import { loadMistakeRegistry } from "./lib/mistake_registry.mjs";
import { evaluateDirtyInputProofArtifacts } from "./lib/repo_state_stamp.mjs";
import {
  evaluateLeakageProofArtifactRequirements,
  evaluateOptimizationScaleContract,
  evaluateRunClassInflation,
  quantGateCompatibilityStatus,
  resolveQuantGatePlanContext,
  summarizeLeakageProofArtifactGate,
  summarizeOptimizationScaleContractGate,
  summarizeRunClassInflationGate,
} from "./lib/quant_gate_hardening.mjs";
import { formatSessionAssumptionBlockers, loadSessionObligations } from "./lib/session_obligations.mjs";
import { resolveExecutedTestEvidenceSignal } from "./lib/autonomous_driver.mjs";
import { runSemanticChecks } from "./rule_engine.mjs";
import {
  normalizeVerificationStatus,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";
import { evaluateAvaGate } from "./lib/autonomous_verification_agents.mjs";
import {
  evaluateReuseBeforeCreateGate,
  summarizeReuseBeforeCreateGate,
} from "./lib/reuse_before_create_gate.mjs";
import { evaluateNovelInsightFloor } from "./lib/novel_insight_floor.mjs";
import {
  evaluateIncidentCloseout,
  summarizeIncidentCloseout,
} from "./lib/incident_contract.mjs";
import { classifySemanticDivergence } from "./lib/semantic_divergence.mjs";

const cwd = process.cwd();
const { plansDir, knowledgeDir } = getPaths(cwd);

// RT7-H3: Max file size for plan artifact reads (1 MB). Prevents memory exhaustion
// if an LLM inflates decisions.md or findings.md to unreasonable sizes.
const MAX_ARTIFACT_BYTES = 1_048_576;

function safeReadFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > MAX_ARTIFACT_BYTES) {
      console.error(`  WARN: ${filePath} exceeds ${MAX_ARTIFACT_BYTES} bytes (${st.size}) — skipping read`);
      return null;
    }
    return readFileSync(filePath, "utf-8");
  } catch { return null; }
}

let transientCloseSignals = null;

function getCloseSignals(planDir) {
  return transientCloseSignals || readStateJson(planDir)?.close_signals;
}

function normalizeVerdict(value) {
  const firstLine = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  const withoutLabel = firstLine
    .replace(/^[-*]\s*/, "")
    .replace(/^(?:status|verdict)\s*:\s*/i, "");
  const leadingDecision = withoutLabel.match(
    /^([A-Za-z][A-Za-z_-]*(?:\s+[A-Za-z][A-Za-z_-]*)?)(?:[.!?:;]\s*|\s+[—–-]\s+|$)/,
  ) || withoutLabel.match(/^([A-Za-z][A-Za-z_-]*)\s+for\s+[^,.;:]{1,80},\s+/i);
  const boundedToken = leadingDecision?.[1]?.trim() || "";
  const normalized = normalizeVerificationStatus(boundedToken, "decision");
  if (!normalized.valid) return null;
  if (normalized.kind === "pass") return "pass";
  if (normalized.kind === "fail") return "fail";
  return "warn";
}

function gateResultBlocks(result) {
  const normalized = normalizeVerificationStatus(result?.status, "gate");
  return !normalized.valid || normalized.kind === "fail";
}

function requiredExecutionOutcomeBlocks(outcome) {
  if (outcome?.required === false) return false;
  const normalized = normalizeVerificationStatus(outcome?.status, "execution");
  return !normalized.valid || normalized.kind !== "pass";
}

function requiredExecutionOutcomeGateStatus(outcome, { waiverPasses = false } = {}) {
  if (outcome?.required === false || (waiverPasses && outcome?.waived === true)) return PASS;
  const normalized = normalizeVerificationStatus(outcome?.status, "execution");
  if (!normalized.valid || normalized.kind === "fail") return FAIL;
  if (normalized.kind === "pass") return PASS;
  return WARN;
}

function canonicalGateStatus(value) {
  const normalized = normalizeVerificationStatus(value, "gate");
  if (!normalized.valid || normalized.kind === "fail") return FAIL;
  if (normalized.kind === "pass") return PASS;
  return WARN;
}

function resolveReflectionSignal(planDir) {
  const reflectionPath = join(planDir, "reflection.md");
  const reflectionContent = readFile(reflectionPath);
  if (!reflectionContent) {
    return {
      present: false,
      satisfied: false,
      detail: "reflection.md missing — REFLECT must record solution, semantic, evidence-readiness, and next-move verdicts before VALIDATE",
    };
  }

  if (containsString(reflectionContent, "To be populated during REFLECT")) {
    return {
      present: true,
      satisfied: false,
      detail: "reflection.md is still template content",
    };
  }

  const headings = {
    solution: extractMarkdownSection(reflectionContent, "Solution Verdict"),
    semantic: extractMarkdownSection(reflectionContent, "Semantic Verdict"),
    evidenceReadiness: extractMarkdownSection(reflectionContent, "Evidence-Readiness Verdict"),
    nextMove: extractMarkdownSection(reflectionContent, "Next Move"),
  };
  const missingHeadings = Object.entries(headings)
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key);
  if (missingHeadings.length > 0) {
    return {
      present: true,
      satisfied: false,
      detail: `reflection.md is missing required section(s): ${missingHeadings.join(", ")}`,
    };
  }

  const solutionVerdict = normalizeVerdict(headings.solution);
  const semanticVerdict = normalizeVerdict(headings.semantic);
  const evidenceVerdict = normalizeVerdict(headings.evidenceReadiness);
  const nextMoveText = String(headings.nextMove || "").trim().split("\n")[0].trim();
  const nextMove = normalizeVerdict(nextMoveText) || normalizeVerdict(nextMoveText.replace(/\bnext move[:\s-]*/i, ""));

  // Granular verdict routing — substance over ritual.
  // - fail   → hard block with explicit "return to PLAN" guidance
  // - warn   → block unless reflection.md acknowledges the warning explicitly
  // - pass   → proceed
  // - null   → treat as missing-content fail
  const verdictEntries = [
    { name: "solution", verdict: solutionVerdict },
    { name: "semantic", verdict: semanticVerdict },
    { name: "evidence_readiness", verdict: evidenceVerdict },
  ];
  const failVerdicts = verdictEntries.filter((entry) =>
    normalizeVerificationStatus(entry.verdict, "decision").kind === "fail"
  ).map((entry) => entry.name);
  const nullVerdicts = verdictEntries.filter((entry) => entry.verdict === null).map((entry) => entry.name);
  const warnVerdicts = verdictEntries.filter((entry) => entry.verdict === "warn").map((entry) => entry.name);
  const acknowledgesWarnings = !/\b(?:do|does|did)?\s*not\s+acknowledg\w*\b/i.test(reflectionContent)
    && /(^|\n)\s*(##+\s*)?(warning[s]?\s+acknowledged|warnings?\s*:\s*acknowledged|acknowledged\s+warnings?)\b/i.test(reflectionContent);
  const nextMoveAllowsValidation = !/\b(re_?plan|re-plan|explore)\b/i.test(nextMoveText) && nextMove !== "fail";

  let routingAction = "proceed_to_validate";
  let detail;
  let satisfied;
  if (failVerdicts.length > 0) {
    routingAction = "return_to_plan";
    satisfied = false;
    detail = `Reflection verdicts include FAIL: ${failVerdicts.join(", ")}. Return to PLAN — re-state the problem, revise the approach, then re-enter REFLECT. Do not transition to VALIDATE with a known failing verdict.`;
  } else if (nullVerdicts.length > 0) {
    routingAction = "fix_reflection_md";
    satisfied = false;
    detail = `Reflection verdicts unparseable for: ${nullVerdicts.join(", ")}. Each verdict heading needs a clear pass/warn/fail outcome.`;
  } else if (warnVerdicts.length > 0 && !acknowledgesWarnings) {
    routingAction = "acknowledge_warnings";
    satisfied = false;
    detail = `Reflection verdicts include WARN: ${warnVerdicts.join(", ")}. Add an explicit "Warnings Acknowledged" line in reflection.md naming the residual risk you are accepting, then retry the transition.`;
  } else if (!nextMoveAllowsValidation) {
    routingAction = "return_to_plan";
    satisfied = false;
    detail = `Reflection next move does not allow VALIDATE: "${nextMoveText}". Either revise the next-move line to point forward, or return to PLAN.`;
  } else {
    satisfied = true;
    detail = warnVerdicts.length > 0
      ? `reflection.md verdicts: ${warnVerdicts.length} warn(s) acknowledged, no failures, next move allows VALIDATE`
      : "reflection.md records pass verdicts and a forward next move";
  }

  return {
    present: true,
    satisfied,
    routingAction,
    solutionVerdict,
    semanticVerdict,
    evidenceVerdict,
    nextMoveText,
    failVerdicts,
    warnVerdicts,
    nullVerdicts,
    acknowledgesWarnings,
    detail,
  };
}

function resolveProgressSignal(planDir, progressContent) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.progress?.satisfied === "boolean") {
    const openItems = Number(closeSignals.progress.open_items || 0);
    const blockingOpenItems = Array.isArray(closeSignals.progress.blocking_open_items)
      ? closeSignals.progress.blocking_open_items
      : [];
    const blockingSatisfied = typeof closeSignals.progress.blocking_satisfied === "boolean"
      ? closeSignals.progress.blocking_satisfied
      : closeSignals.progress.satisfied;
    return {
      satisfied: closeSignals.progress.satisfied,
      blockingSatisfied,
      blockingOpenItems,
      detail: closeSignals.progress.detail || (closeSignals.progress.satisfied
        ? "Structured close signal: all progress items completed"
        : `${openItems} open progress item(s) remain`),
    };
  }

  const remainingItems = progressContent ? (progressContent.match(/^- \[ \] .+$/gm) || []) : [];
  return {
    satisfied: remainingItems.length === 0,
    blockingSatisfied: remainingItems.length === 0,
    blockingOpenItems: remainingItems,
    detail: remainingItems.length === 0
      ? "All items completed or accounted for"
      : `${remainingItems.length} uncompleted item(s) remaining`,
  };
}

function countCompletedProgressItems(progressContent) {
  if (!progressContent) return 0;
  const checkedBoxes = (progressContent.match(/^- \[[xX]\] .+$/gm) || []).length;
  const completedSection = extractMarkdownSection(progressContent, "Completed");
  const legacyCompletedBullets = completedSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^[-*] /.test(line) &&
      !/^[-*] \[[xX ]\]/.test(line) &&
      !/^\*Nothing yet\.\*$/.test(line) &&
      !/^[-*] Nothing yet\.?$/i.test(line)
    ).length;
  return checkedBoxes + legacyCompletedBullets;
}

function checkKBUpdatedLegacy(planDir) {
  const mistakesPath = join(knowledgeDir, "mistakes.md");
  const patternsPath = join(knowledgeDir, "patterns.md");
  const gotchasPath = join(knowledgeDir, "gotchas.md");

  for (const path of [mistakesPath, patternsPath, gotchasPath]) {
    const content = readFile(path);
    if (content) {
      const entries = content.match(/^## [MPG]-\d+/gm);
      if (entries && entries.length > 0) {
        return { satisfied: true, detail: "Legacy KB evidence found via knowledge-base entries" };
      }
    }
  }

  const decisionsPath = join(planDir, "decisions.md");
  const reflectionPath = join(planDir, "reflection.md");
  const summaryPath = join(planDir, "summary.md");
  const walkthroughPath = join(cwd, "walkthrough.md");
  const geminiWalkthroughPath = join(cwd, ".gemini", "walkthrough.md");
  const kbSignoff = collectKbSignoff([
    { source: "decisions.md", content: readFile(decisionsPath) || "" },
    { source: "reflection.md", content: readFile(reflectionPath) || "" },
    { source: "summary.md", content: readFile(summaryPath) || "" },
    { source: "walkthrough.md", content: readFile(walkthroughPath) || readFile(geminiWalkthroughPath) || "" },
  ]);
  if (kbSignoff.no_new_learnings) {
    return {
      satisfied: true,
      detail: `KB no-new-learnings sign-off found via ${kbSignoff.sources.join(", ")}${kbSignoff.reason ? ` (${kbSignoff.reason})` : ""}`,
    };
  }
  if (kbSignoff.updated) {
    return {
      satisfied: true,
      detail: `KB update sign-off found via ${kbSignoff.sources.join(", ")}`,
    };
  }

  // Phase 4 of ritual elimination: walkthrough.md retired as a KB-evidence
  // fallback. Existing plans that wrote one still close because the gate looks
  // at structured close signals + summary.md before falling through to here.
  // The retirement is "absent is fine" — no negative requirement; in-flight
  // plans with walkthrough.md still close cleanly via the upstream signals.

  return { satisfied: false, detail: "No KB update evidence — update mistakes/patterns/gotchas or note 'no new learnings'" };
}

function resolveKBSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.kb?.satisfied === "boolean") {
    const status = closeSignals.kb.status || "unknown";
    const sourceDetail = Array.isArray(closeSignals.kb.signoff_sources) && closeSignals.kb.signoff_sources.length > 0
      ? ` via ${closeSignals.kb.signoff_sources.join(", ")}`
      : "";
    const reasonDetail = closeSignals.kb.signoff_reason ? ` (${closeSignals.kb.signoff_reason})` : "";
    return {
      satisfied: closeSignals.kb.satisfied,
      detail: closeSignals.kb.satisfied
        ? `Structured close signal: KB status = ${status}${sourceDetail}${reasonDetail}`
        : `Structured close signal: KB status = ${status}. Do not edit state.json; update plans/knowledge or set reflection.md -> Knowledge Base Sign-Off -> Decision: no_new_learnings with a specific Reason.`,
    };
  }
  return checkKBUpdatedLegacy(planDir);
}

function resolvePlannerCoreSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.planner_core?.satisfied === "boolean") {
    const required = closeSignals.planner_core.required === true;
    const verified = closeSignals.planner_core.migration_smoke_verified === true;
    const journeyVerified = closeSignals.planner_core.planner_journey_verified === true;
    const proofBundleRequired = closeSignals.planner_core.proof_bundle_required === true;
    const proofBundleVerified = closeSignals.planner_core.proof_bundle_verified === true;
    const missingProofCommands = Array.isArray(closeSignals.planner_core.proof_bundle_missing_commands)
      ? closeSignals.planner_core.proof_bundle_missing_commands
      : [];
    return {
      required,
      satisfied: closeSignals.planner_core.satisfied,
      detail: required
        ? (verified && journeyVerified && (!proofBundleRequired || proofBundleVerified)
            ? "Planner-core self-proof verified via migration smoke + planner journey close signals"
            : !verified
              ? "Planner-core change detected but governed `migration-bootstrap` IVE PASS was not recorded"
              : !journeyVerified
                ? "Planner-core change detected but governed `transition-gate-flows` IVE PASS was not recorded"
                : `Sensitive planner-core surface changed but the required proof bundle PASS was not recorded: ${missingProofCommands.join(", ")}`)
        : "Planner-core self-proof not required for this plan",
    };
  }
  return {
    required: false,
    satisfied: true,
    detail: "Legacy plan without structured planner-core self-proof signal",
  };
}

function resolveTestEvidenceSignal(planDir, gateName = null, currentGateEvidence = null) {
  if (gateName) {
    const executed = resolveExecutedTestEvidenceSignal(planDir, gateName, currentGateEvidence);
    if (executed.present) {
      return {
        required: executed.required,
        satisfied: executed.satisfied,
        detail: `${executed.detail}; structured close_signals.test_evidence is advisory when executed gate evidence exists`,
      };
    }
  }

  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.test_evidence?.satisfied === "boolean") {
    const required = closeSignals.test_evidence.required === true;
    const status = closeSignals.test_evidence.status || "unknown";
    const codePaths = Array.isArray(closeSignals.test_evidence.code_paths) ? closeSignals.test_evidence.code_paths : [];
    const testPaths = Array.isArray(closeSignals.test_evidence.test_paths) ? closeSignals.test_evidence.test_paths : [];
    return {
      required,
      satisfied: closeSignals.test_evidence.satisfied,
      detail: required
        ? closeSignals.test_evidence.satisfied
          ? normalizeVerificationStatus(status, "execution").kind === "waived"
            ? `Structured close signal: test evidence waived by ${closeSignals.test_evidence.waiver_approved_by || "unknown"}`
            : `Structured close signal: ${testPaths.length} planned test file(s) + passing test command recorded (advisory unless executed gate evidence exists)`
          : `Code changes require test evidence — status=${status}; code paths=${codePaths.length}, test paths=${testPaths.length}`
        : status === "static_ui_intent_manual_observation"
          ? "Structured close signal: static UI deliverable uses intent/manual evidence instead of test-file coverage"
          : "Structured close signal: no code-path test evidence required for this plan",
    };
  }
  return {
    required: false,
    satisfied: true,
    detail: "Legacy plan without structured test-evidence signal",
  };
}

function resolveAntiRecurrenceSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.anti_recurrence?.satisfied === "boolean") {
    const signal = closeSignals.anti_recurrence;
    const required = signal.required === true;
    const status = signal.status || "unknown";
    const guardTypes = Array.isArray(signal.guard_types) ? signal.guard_types : [];
    const triggerTerms = Array.isArray(signal.trigger_terms) ? signal.trigger_terms : [];
    const typeDetail = guardTypes.length > 0 ? `; guard types=${guardTypes.join(", ")}` : "";
    const triggerDetail = triggerTerms.length > 0 ? `triggered by ${triggerTerms.join(", ")}` : "remediation detector not triggered";

    return {
      required,
      satisfied: signal.satisfied,
      detail: !required
        ? "Structured close signal: anti-recurrence guard not required for this plan"
        : signal.satisfied
          ? normalizeVerificationStatus(status, "execution").kind === "waived"
            ? `Structured close signal: anti-recurrence guard waived by ${signal.waiver_approved_by || "unknown"}`
            : `Structured close signal: anti-recurrence guard satisfied via ${status}${typeDetail}`
          : status === "section_without_guard_type"
            ? `Remediation-style work detected (${triggerDetail}) but the Anti-Recurrence Guard section is missing a valid Guard Type: test, ontology, annotation, or kb`
            : status === "section_without_pass"
              ? `Remediation-style work detected (${triggerDetail}) but the Anti-Recurrence Guard section does not record PASS`
              : `Remediation-style work detected (${triggerDetail}) but no anti-recurrence guard evidence or waiver was recorded`,
    };
  }

  return {
    required: false,
    satisfied: true,
    detail: "Legacy plan without structured anti-recurrence close signal",
  };
}

export function summarizeLearnedObligationsSignal(signal, { phase = "close" } = {}) {
  const obligations = Array.isArray(signal.active_obligations) ? signal.active_obligations : [];
  const missing = obligations.filter((obligation) => !obligation.satisfied);
  const degraded = obligations.filter((obligation) => obligation.source_registry_degraded);
  const degradedDetail = degraded
    .map((obligation) => `source mistake registry degraded for ${obligation.id} (source=${obligation.source_mistake}, registry=${obligation.source_registry_status})`)
    .join("; ");
  const missingDetail = missing
    .map((obligation) => `${obligation.id} (${obligation.subject_id}, mode=${obligation.verification_mode})`)
    .join("; ");
  const unsatisfiedDetail = [degradedDetail, missingDetail].filter(Boolean).join(". ");
  return {
    ...signal,
    detail: signal.required !== true
      ? `No learned verification obligations are due by ${phase.toUpperCase()} for this plan`
      : signal.satisfied
        ? `${signal.satisfied_count || 0}/${signal.active_count || obligations.length} learned obligation(s) due by ${phase.toUpperCase()} satisfied from the live plan evidence surface`
        : `Active learned obligations due by ${phase.toUpperCase()} are unsatisfied: ${unsatisfiedDetail}`,
  };
}

function resolveLearnedObligationsSignal(planDir, { phase = "close" } = {}) {
  const signal = computePlanLearnedObligationsSignal({
    cwd,
    planDir,
    requiredAtOrBefore: phase,
  });
  return summarizeLearnedObligationsSignal(signal, { phase });
}

function resolveSessionObligationsSignal(planDir) {
  const obligations = loadSessionObligations(planDir);
  if (!obligations.present || obligations.assumptions.length === 0) {
    return {
      required: false,
      satisfied: true,
      detail: "No structured session assumptions recorded",
    };
  }
  return {
    required: obligations.blockers.length > 0,
    satisfied: obligations.blockers.length === 0,
    detail: obligations.blockers.length === 0
      ? `${obligations.assumptions.length} structured session assumption(s) resolved or retired`
      : `Unresolved support assumptions: ${formatSessionAssumptionBlockers(obligations.blockers)}`,
  };
}

function resolveVerificationObligationSynthesisSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.verification_obligation_synthesis?.satisfied === "boolean") {
    const signal = closeSignals.verification_obligation_synthesis;
    const required = signal.required === true;
    return {
      required,
      satisfied: signal.satisfied,
      detail: !required
        ? "Structured close signal: verification-obligation synthesis not required for this plan"
        : signal.satisfied
          ? `Structured close signal: synthesized obligations reported for ${(signal.active_count || 0)} obligation(s)`
          : signal.detail || "Synthesized verification obligations are missing required closeout reporting",
    };
  }

  return {
    required: false,
    satisfied: true,
    detail: "Legacy plan without structured verification-obligation synthesis signal",
  };
}

function resolveQuantResultsValidationSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.quant_results_validation?.satisfied === "boolean") {
    const signal = closeSignals.quant_results_validation;
    const required = signal.required === true;
    const issues = Array.isArray(signal.blocking_issues) ? signal.blocking_issues : [];
    const warnings = Array.isArray(signal.warnings) ? signal.warnings : [];
    return {
      required,
      satisfied: signal.satisfied,
      status: signal.status || "unknown",
      blocking_issues: issues,
      warnings,
      detail: !required
        ? "Structured close signal: quant results validation not required for this plan"
        : signal.satisfied
          ? `Structured close signal: quant results validation ${signal.status || "satisfied"}`
          : signal.detail || `Quant results validation failed: ${issues.join(", ") || "unknown issue"}`,
    };
  }

  return {
    required: false,
    satisfied: true,
    status: "legacy",
    blocking_issues: [],
    warnings: [],
    detail: "Legacy plan without structured quant results validation signal",
  };
}

function resolveReviewIntakeSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.review_intake?.satisfied === "boolean") {
    const signal = closeSignals.review_intake;
    const unresolved = Array.isArray(signal.unresolved_required) ? signal.unresolved_required : [];
    return {
      required: signal.required === true,
      satisfied: signal.satisfied === true,
      status: signal.status || "unknown",
      required_count: signal.required_count || 0,
      unresolved_required_count: signal.unresolved_required_count || unresolved.length,
      advisory_count: signal.advisory_count || 0,
      unresolved_required: unresolved,
      detail: signal.required !== true
        ? `Structured close signal: review intake not required (${signal.advisory_count || 0} advisory item(s))`
        : signal.satisfied
          ? `Structured close signal: ${signal.required_count || 0} required review-intake item(s) have valid dispositions`
          : `Review-intake items still need disposition: ${unresolved.map((item) => item.id).join(", ") || "unknown item"}`,
    };
  }

  return {
    required: false,
    satisfied: true,
    status: "legacy",
    required_count: 0,
    unresolved_required_count: 0,
    advisory_count: 0,
    unresolved_required: [],
    detail: "Legacy plan without structured review-intake close signal",
  };
}

function resolveRecipePromotionSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.recipe_promotion?.satisfied === "boolean") {
    const signal = closeSignals.recipe_promotion;
    const candidates = Array.isArray(signal.candidates) ? signal.candidates : [];
    const unacknowledged = candidates.filter((candidate) => candidate.status !== "acknowledged");
    return {
      required: signal.required === true,
      satisfied: signal.satisfied === true,
      status: signal.status || "unknown",
      candidate_count: signal.candidate_count || candidates.length,
      unacknowledged_count: signal.unacknowledged_count || unacknowledged.length,
      candidates,
      detail: signal.required !== true
        ? "Structured close signal: recipe promotion not required"
        : signal.satisfied
          ? `Structured close signal: ${signal.candidate_count || candidates.length} recipe-promotion candidate(s) have explicit disposition`
          : signal.detail || `Recipe-promotion candidates need disposition: ${unacknowledged.map((candidate) => candidate.id).join(", ") || "unknown candidate"}`,
    };
  }

  return {
    required: false,
    satisfied: true,
    status: "legacy",
    candidate_count: 0,
    unacknowledged_count: 0,
    candidates: [],
    detail: "Legacy plan without structured recipe-promotion close signal",
  };
}

function resolveAvaGateSignal(planDir) {
  const signal = evaluateAvaGate({ planDir, repoRoot: cwd });
  return {
    required: signal.required,
    satisfied: signal.satisfied,
    blocking_issues: signal.blocking_issues || [],
    detail: signal.detail,
  };
}

function resolveQuantPersonaGateSignal(planDir, {
  planContent = null,
  stateJson = null,
  verificationContent = null,
  redTeamContent = null,
  reflectionContent = null,
} = {}) {
  const effectivePlanContent = planContent ?? readFile(join(planDir, "plan.md")) ?? "";
  const effectiveStateJson = stateJson || readStateJson(planDir) || {};
  const findingsContent = readFile(join(planDir, "findings.md")) || "";
  const effectiveVerificationContent = verificationContent ?? readFile(join(planDir, "verification.md")) ?? "";
  const effectiveRedTeamContent = redTeamContent ?? readFile(join(planDir, "red_team_notes.md")) ?? "";
  const effectiveReflectionContent = reflectionContent ?? readFile(join(planDir, "reflection.md")) ?? "";
  const context = resolveQuantGatePlanContext({
    cwd,
    planDir,
    planContent: effectivePlanContent,
    findingsContent,
    verificationContent: effectiveVerificationContent,
    stateJson: effectiveStateJson,
  });

  return evaluateQuantPersonaGate({
    sourceText: [context.goalText, findingsContent, effectivePlanContent].filter(Boolean).join("\n\n"),
    planContent: [effectivePlanContent, effectiveRedTeamContent, effectiveReflectionContent].filter(Boolean).join("\n\n"),
    verificationContent: [effectivePlanContent, effectiveVerificationContent].filter(Boolean).join("\n\n"),
    changedFiles: context.plannedFiles,
    planShape: context.planShape,
  });
}

function resolveSemanticSubstrateSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.semantic_substrate?.satisfied === "boolean") {
    const signal = closeSignals.semantic_substrate;
    const relevantDomains = Array.isArray(signal.relevant_domains) ? signal.relevant_domains : [];
    const advisoryGapIds = Array.isArray(signal.advisory_gap_ids) ? signal.advisory_gap_ids : [];
    const blockingGapIds = Array.isArray(signal.blocking_gap_ids) ? signal.blocking_gap_ids : [];
    const relevanceEvidence = signal?.relevance_evidence && typeof signal.relevance_evidence === "object"
      ? signal.relevance_evidence
      : {};
    return {
      required: signal.required === true,
      satisfied: signal.satisfied === true,
      status: signal.status || "unknown",
      scan_scope: signal.scan_scope || "planned_plus_nearby",
      scan_scope_used: signal.scan_scope_used || signal.scan_scope || "planned_plus_nearby",
      scope_degraded: signal.scope_degraded === true,
      scope_degraded_reason: signal.scope_degraded_reason || null,
      relevant_domains: relevantDomains,
      relevance_evidence: relevanceEvidence,
      advisory_gap_ids: advisoryGapIds,
      blocking_gap_ids: blockingGapIds,
      detail: signal.required !== true
        ? "Structured close signal: semantic substrate not required for this plan"
        : signal.satisfied
          ? `Structured close signal: relevant semantic substrate present for ${relevantDomains.join(", ") || "the active plan"}`
          : signal.detail || `Relevant semantic substrate gaps remain: ${blockingGapIds.join(", ") || advisoryGapIds.join(", ")}`,
    };
  }

  return {
    required: false,
    satisfied: true,
    status: "legacy",
    scan_scope: "planned_plus_nearby",
    scan_scope_used: "planned_plus_nearby",
    scope_degraded: false,
    scope_degraded_reason: null,
    relevant_domains: [],
    relevance_evidence: {},
    advisory_gap_ids: [],
    blocking_gap_ids: [],
    detail: "Legacy plan without structured semantic-substrate close signal",
  };
}

function resolveWeakSemanticSubstrateDomains(signal) {
  if (!signal?.relevance_evidence || typeof signal.relevance_evidence !== "object") return [];
  return Object.entries(signal.relevance_evidence)
    .filter(([, value]) => value === "weak")
    .map(([domain]) => domain);
}

function formatSemanticSubstrateAdvisoryDetail(signal) {
  const parts = [];
  if (signal.required && signal.advisory_gap_ids.length > 0) {
    parts.push(`Relevant semantic substrate gaps remain: ${signal.advisory_gap_ids.join(", ")}`);
  }
  if (signal.scope_degraded) {
    const degradedReason = signal.scope_degraded_reason || "unknown_reason";
    parts.push(`Semantic substrate scope degraded via ${degradedReason} (${signal.scan_scope_used}); fallback discovery is advisory only`);
  }
  const weakDomains = resolveWeakSemanticSubstrateDomains(signal);
  if (weakDomains.length > 0) {
    parts.push(`Weak semantic-substrate relevance hints detected: ${weakDomains.join(", ")}`);
  }
  return parts.join(" | ") || signal.detail;
}

const LATE_PHASE_GATES = new Set([
  "reflect-to-validate",
  "validate-to-close",
  "reflect-to-close",
]);

function resolveLatePhaseAntiRitualAssessment(planDir, gateName) {
  if (!LATE_PHASE_GATES.has(gateName)) return null;

  const stateJson = readStateJson(planDir) || {};
  const semanticSubstrate = resolveSemanticSubstrateSignal(planDir);
  const plannerCore = resolvePlannerCoreSignal(planDir);
  const testEvidence = resolveTestEvidenceSignal(planDir);
  const intentEvidence = resolveIntentEvidenceSignal(planDir);
  const antiRecurrence = resolveAntiRecurrenceSignal(planDir);
  const learnedObligations = resolveLearnedObligationsSignal(planDir);
  const verificationObligationSynthesis = resolveVerificationObligationSynthesisSignal(planDir);
  const reviewIntake = resolveReviewIntakeSignal(planDir);
  const kbSignal = resolveKBSignal(planDir);

  const semanticBlocks = (semanticSubstrate.blocking_gap_ids || []).map((gapId) => ({
    kind: "semantic_substrate_gap",
    detail: gapId,
  }));
  const repairableVariances = [
    ...(semanticSubstrate.advisory_gap_ids || []).map((gapId) => ({
      kind: "semantic_substrate_gap",
      detail: gapId,
    })),
    ...(resolveWeakSemanticSubstrateDomains(semanticSubstrate).map((domain) => ({
      kind: "semantic_substrate_hint",
      detail: `weak_relevance_hint:${domain}`,
    }))),
  ];
  if (semanticSubstrate.scope_degraded) {
    repairableVariances.push({
      kind: "semantic_substrate_hint",
      detail: `repo_wide_fallback:${semanticSubstrate.scope_degraded_reason || "unknown_reason"}`,
    });
  }

  const requiredProofGaps = [];
  for (const signal of [testEvidence, intentEvidence, antiRecurrence, learnedObligations, verificationObligationSynthesis, reviewIntake]) {
    if (signal?.required === true && signal?.satisfied !== true) {
      requiredProofGaps.push(signal.detail || "required proof signal missing");
    }
  }

  const integritySignals = [];
  if (kbSignal?.satisfied === false) {
    integritySignals.push(kbSignal.detail || "knowledge-base close signal missing");
  }

  const stateForAuthority = String(stateJson?.state || "").trim().toLowerCase();
  const authorityProfile = resolveAuthorityProfile({ state: stateForAuthority });
  const proofPosture = resolveProofPosture({ phase: authorityProfile.phase });
  const phaseContract = buildPhaseContract({ authorityProfile, proofPosture });

  return resolveAntiRitualAssessment({
    classification: {
      flow_mode: "full",
      strictness_mode: "full",
    },
    workflow: null,
    recommendedPath: "continue",
    authorityProfile,
    phaseContract,
    semanticBlocks,
    repairableVariances,
    semanticSubstrate,
    validation: {
      integrity_signals: integritySignals,
      required_proof_gaps: requiredProofGaps,
      planner_core_self_proof: {
        required: plannerCore?.required === true,
        satisfied: plannerCore?.satisfied === true,
      },
      proof_posture: proofPosture,
    },
    activePlanPoisoned: false,
  });
}

function normalizeLatePhaseGateResults(results, antiRitual) {
  return Array.isArray(results) ? results : [];
}

function extractGoalFromPlanContent(planContent) {
  const match = String(planContent || "").match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

const PLAN_SECTION_ALIASES = new Map([
  ["Steps", ["Steps", "Execution Steps"]],
]);

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(planContent, heading) {
  const content = String(planContent || "");
  const candidates = Array.isArray(heading)
    ? heading
    : (PLAN_SECTION_ALIASES.get(heading) || [heading]);

  let headingMatch = null;
  for (const candidate of candidates) {
    headingMatch = content.match(new RegExp(`^## ${escapeRegex(candidate)}\\s*$`, "m"));
    if (headingMatch?.index !== undefined) break;
  }
  if (!headingMatch || headingMatch.index === undefined) return "";

  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

function extractMarkdownTable(sectionContent) {
  const section = String(sectionContent || "");
  if (!section) return { header: null, rows: [] };

  const rawRows = section
    .split("\n")
    .filter((line) => line.includes("|") && !line.match(/^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/));
  if (rawRows.length === 0) return { header: null, rows: [] };

  const rows = rawRows.map((row) => row.split("|").map((cell) => cell.trim()).filter(Boolean));
  return {
    header: rows[0] || null,
    rows: rows.slice(1),
  };
}

function normalizeTraceabilityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VALID_ACTIVE_STORY_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED"]);
const NON_LINKABLE_DRAFT_STORY_STATUSES = new Set(["DRAFT", "PROPOSED", "PLANNED"]);

function loadStoryRegistryIndex() {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return { ids: [], invalidById: new Map(), entries: [] };

  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    const stories = [
      ...(Array.isArray(parsed?.stories) ? parsed.stories : []),
      ...(Array.isArray(parsed?.infrastructure_stories) ? parsed.infrastructure_stories : []),
    ];
    const ids = [];
    const invalidById = new Map();
    const entries = [];
    for (const story of stories) {
      const id = typeof story?.id === "string" ? story.id.trim() : "";
      if (!id) continue;
      const status = typeof story?.status === "string" ? story.status.trim() : "";
      if (VALID_ACTIVE_STORY_STATUSES.has(status)) {
        ids.push(id);
        entries.push(story);
      } else if (!NON_LINKABLE_DRAFT_STORY_STATUSES.has(status)) {
        invalidById.set(id, status ? `invalid status '${status}'` : "missing status");
      }
    }
    return { ids, invalidById, entries };
  } catch {
    return { ids: [], invalidById: new Map([["story_registry.json", "invalid JSON"]]), entries: [] };
  }
}

function loadStoryRegistryIds() {
  return loadStoryRegistryIndex().ids;
}

function tokenizeForStoryMatch(text) {
  if (!text) return new Set();
  const normalized = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\/._ -]/g, " ")
    .split(/[\s\/_\.\-]+/)
    .filter((t) => t.length >= 2 && !new Set(["the", "and", "for", "with", "from", "into", "that", "this", "are", "will", "must", "should", "can", "use", "using", "via", "per", "all", "each", "any", "new", "add", "fix", "refactor", "update", "doc", "docs", "test", "tests", "script", "scripts"]).has(t));
  return new Set(normalized);
}

function scoreStoryRelevance(story, criterionTokens, fileTokens) {
  const storyTokens = new Set([
    ...tokenizeForStoryMatch(story.title),
    ...tokenizeForStoryMatch(story.summary),
    ...tokenizeForStoryMatch(story.description),
    ...tokenizeForStoryMatch(story.keywords),
    ...tokenizeForStoryMatch(story.code_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.test_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.validation_refs?.join(" ")),
    ...tokenizeForStoryMatch(story.doc_refs?.join(" ")),
  ]);
  let score = 0;
  for (const token of criterionTokens) {
    if (storyTokens.has(token)) score += 1;
  }
  if (fileTokens.size > 0 && story.code_refs?.length) {
    for (const ref of story.code_refs) {
      const refTokens = tokenizeForStoryMatch(ref);
      for (const token of fileTokens) {
        if (refTokens.has(token)) score += 2;
      }
    }
  }
  if (fileTokens.size > 0 && story.test_refs?.length) {
    for (const ref of story.test_refs) {
      const refTokens = tokenizeForStoryMatch(ref);
      for (const token of fileTokens) {
        if (refTokens.has(token)) score += 1;
      }
    }
  }
  return score;
}

function suggestStoryIdsForCriterion(criterion, stories, filesToModify) {
  const criterionTokens = tokenizeForStoryMatch(criterion.label);
  const fileTokens = tokenizeForStoryMatch(filesToModify.join(" "));
  const scored = stories
    .map((story) => ({ story, score: scoreStoryRelevance(story, criterionTokens, fileTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.story.id);
  return scored;
}

function storyLinkageSuggestionText(criterion, stories, filesToModify) {
  const suggestions = suggestStoryIdsForCriterion(criterion, stories, filesToModify);
  const label = `${criterion.id} (${criterion.label})`;
  if (suggestions.length === 0) {
    return `${label} — no candidate story IDs found; add a matching story to story_registry.json or explicitly mark as N/A`;
  }
  return `${label} — suggested story ID(s): ${suggestions.join(", ")}`;
}

function analyzeCriterionStoryTraceability(planContent, { workOrder = null, planDir = null, stateJson = null } = {}) {
  const storyRegistry = loadStoryRegistryIndex();
  const storyIds = storyRegistry.ids;
  const invalidById = storyRegistry.invalidById;
  const criteria = extractMatrixSuccessCriteria(planContent, { workOrder });
  const filesToModify = extractFilesToModify(planContent);

  if (storyIds.length === 0 && invalidById.size === 0) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Explicit criterion/story linkage not required — no story_registry.json found",
    };
  }

  if (criteria.length === 0) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Explicit criterion/story linkage not required — no success criteria listed",
    };
  }

  const table = selectCriterionStoryTable(planContent, { workOrder });
  if (!table?.header) {
    const synthesis = computeVerificationObligationSynthesis({
      cwd,
      planDir,
      stateJson,
      planContent,
    });
    const compact = analyzeCompactLowRiskVerification({ planContent, criteria, synthesis });
    if (compact.applicable && compact.satisfied) {
      if (criteria.length !== 1) {
        return {
          applicable: true,
          satisfied: false,
          detail: "Compact low-risk verification story linkage is only accepted for single-criterion plans; use the full Verification Strategy table for multiple criteria",
        };
      }
      const normalizedStoryIds = extractNormalizedStoryIdsFromText(compact.compact_obligation?.text || "");
      const matchedStoryIds = storyIds.filter((storyId) => normalizedStoryIds.includes(storyId));
      const invalidStoryIds = [...invalidById.entries()]
        .filter(([storyId]) => normalizedStoryIds.includes(storyId))
        .map(([storyId, reason]) => `${storyId} ${reason}`);
      if (invalidStoryIds.length > 0) {
        return {
          applicable: true,
          satisfied: false,
          detail: `Compact low-risk verification obligation references invalid story IDs: ${invalidStoryIds.join(", ")}`,
        };
      }
      if (matchedStoryIds.length > 0) {
        return {
          applicable: true,
          satisfied: true,
          detail: `Compact low-risk verification obligation links ${criteria[0].id} to ${matchedStoryIds.join(", ")}`,
        };
      }
      return {
        applicable: true,
        satisfied: false,
        detail: `Compact low-risk verification obligation must name an active story ID from story_registry.json for ${storyLinkageSuggestionText(criteria[0], storyRegistry.entries, filesToModify)}`,
      };
    }
    const suggestions = criteria
      .map((criterion) => storyLinkageSuggestionText(criterion, storyRegistry.entries, filesToModify))
      .join("; ");
    return {
      applicable: true,
      satisfied: false,
      detail: `Verification Strategy must use a markdown table with 'Criterion' and 'Story linkage' columns when story_registry.json exists. ${suggestions}`,
    };
  }

  const headerCells = table.header.map((cell) => normalizeMatrixText(cell));
  const criterionColumn = headerCells.findIndex((cell) => cell.includes("criterion"));
  const storyColumn = headerCells.findIndex((cell) => cell.includes("story linkage"));

  if (criterionColumn === -1 || storyColumn === -1) {
    const suggestions = criteria
      .map((criterion) => storyLinkageSuggestionText(criterion, storyRegistry.entries, filesToModify))
      .join("; ");
    return {
      applicable: true,
      satisfied: false,
      detail: `Verification Strategy must include explicit 'Criterion' and 'Story linkage' columns when story_registry.json exists. ${suggestions}`,
    };
  }

  const missing = [];
  const invalid = [];
  for (const criterion of criteria) {
    const matchedRow = table.rows.find((row) =>
      matrixCriterionMatchesVerificationRow(criterion, getVerificationTableCell(row, criterionColumn) || getVerificationTableCell(row, 0))
    );

    if (!matchedRow) {
      const suggestions = suggestStoryIdsForCriterion(criterion, storyRegistry.entries, filesToModify);
      missing.push({ label: `${criterion.id} (${criterion.label})`, suggestions });
      continue;
    }

    const normalizedStoryIds = extractNormalizedStoryIdsFromText(matchedRow.cells.join(" "));
    const matchedStoryIds = storyIds.filter((storyId) => normalizedStoryIds.includes(storyId));
    const invalidStoryIds = [...invalidById.entries()]
      .filter(([storyId]) => normalizedStoryIds.includes(storyId))
      .map(([storyId, reason]) => `${storyId} ${reason}`);
    if (invalidStoryIds.length > 0) {
      invalid.push(`${criterion.id} (${criterion.label}) references ${invalidStoryIds.join(", ")}`);
      continue;
    }
    if (matchedStoryIds.length === 0) {
      const suggestions = suggestStoryIdsForCriterion(criterion, storyRegistry.entries, filesToModify);
      missing.push({ label: `${criterion.id} (${criterion.label})`, suggestions });
    }
  }

  const issues = [];
  if (missing.length > 0) {
    const lines = missing.map((entry) => {
      const suggestionText = entry.suggestions.length > 0
        ? ` — suggested story ID(s): ${entry.suggestions.join(", ")}`
        : " — no candidate story IDs found; add a matching story to story_registry.json or explicitly mark as N/A";
      return `${entry.label}${suggestionText}`;
    });
    issues.push(`Verification Strategy missing explicit story linkage for: ${lines.join("; ")}`);
  }
  if (invalid.length > 0) issues.push(`Verification Strategy references invalid story IDs: ${invalid.join("; ")}`);

  return {
    applicable: true,
    satisfied: issues.length === 0,
    detail: issues.length === 0
      ? `${criteria.length} success criterion row(s) map explicitly to story_registry.json entries`
      : issues.join("; "),
  };
}

const CONTEXT_SENSITIVE_VERIFICATION_FAMILIES = VERIFICATION_OBLIGATION_FAMILIES;

const WEAK_PROOF_ONLY_PATTERN = /\b(unit|wrapper)\b/;
const HEADER_CONTEXT_PATTERNS = ["repo/system context", "system context", "repo context", "context"];
const HEADER_PROOF_PATTERNS = ["required proof type", "proof type", "proof"];
const HEADER_ACTION_PATTERNS = ["concrete command or action", "command/action", "command or action", "action", "command"];
const HEADER_UNVERIFIED_PATTERNS = ["what remains unverified", "remains unverified", "unverified", "residual risk", "residual unknown"];

function findVerificationColumn(headerCells, candidates) {
  return headerCells.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function isMeaningfulVerificationCell(value, { allowExplicitNone = false } = {}) {
  const normalized = normalizeTraceabilityText(value);
  if (!normalized) return false;
  if (["-", "tbd", "todo", "pending"].includes(normalized)) return false;
  if (normalized.startsWith("to be defined") || normalized.startsWith("to be populated")) return false;
  if (!allowExplicitNone && (normalized === "n/a" || normalized === "none")) return false;
  return true;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function formatRequiredColumnList(columns) {
  return columns.map((column) => `'${column.label}'`).join(", ");
}

function analyzePlanningOnlyTableSection(planContent, heading, {
  requiredColumns,
  minRows = 1,
  allowExplicitNoneColumns = [],
} = {}) {
  const section = extractMarkdownSection(planContent, heading);
  if (!section.trim()) {
    return {
      applicable: true,
      satisfied: false,
      detail: `${heading} section is missing`,
    };
  }

  const { header, rows } = extractMarkdownTable(section);
  if (!header) {
    return {
      applicable: true,
      satisfied: false,
      detail: `${heading} must use a markdown table with columns ${formatRequiredColumnList(requiredColumns)}`,
    };
  }

  const headerCells = header.map((cell) => normalizeTraceabilityText(cell));
  const resolvedColumns = requiredColumns.map((column) => ({
    ...column,
    index: findVerificationColumn(
      headerCells,
      normalizeStringList(column.aliases).length > 0 ? column.aliases : [column.label]
    ),
  }));
  const missingColumns = resolvedColumns.filter((column) => column.index === -1);
  if (missingColumns.length > 0) {
    return {
      applicable: true,
      satisfied: false,
      detail: `${heading} must include columns ${formatRequiredColumnList(requiredColumns)}`,
    };
  }

  if (rows.length < minRows) {
    return {
      applicable: true,
      satisfied: false,
      detail: `${heading} needs at least ${minRows} row(s)`,
    };
  }

  const issues = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const column of resolvedColumns) {
      const value = row[column.index] || "";
      const allowExplicitNone = allowExplicitNoneColumns.includes(column.label);
      if (!isMeaningfulVerificationCell(value, { allowExplicitNone })) {
        issues.push(`row ${rowIndex + 1} is missing ${column.label}`);
      }
    }
  }

  return {
    applicable: true,
    satisfied: issues.length === 0,
    detail: issues.length === 0
      ? `${heading} records ${rows.length} row(s) with the required planning fields`
      : `${heading}: ${issues.join("; ")}`,
  };
}

const PLANNING_ONLY_RETRO_COLUMNS = [
  { label: "Source", aliases: ["source"] },
  { label: "Risk to this plan", aliases: ["risk to this plan"] },
  { label: "Guard in plan", aliases: ["guard in plan"] },
  { label: "Future proof/test required", aliases: ["future proof/test required", "future proof or test required"] },
];

const PLANNING_ONLY_TEST_COLUMNS = [
  { label: "Test or test group", aliases: ["test or test group", "test group", "planned test"] },
  { label: "What it proves", aliases: ["what it proves", "proves"] },
  { label: "Prevents", aliases: ["prevents", "failure prevented", "failures prevented"] },
];

const PLANNING_ONLY_RED_TEAM_COLUMNS = [
  { label: "Attack", aliases: ["attack"] },
  { label: "Why this plan is vulnerable", aliases: ["why this plan is vulnerable", "why vulnerable", "vulnerability"] },
  { label: "Guard added to the plan", aliases: ["guard added to the plan", "guard added", "guard"] },
];

const PLANNING_ONLY_STORY_COLUMNS = [
  { label: "Story", aliases: ["story"] },
  { label: "Criteria touched", aliases: ["criteria touched", "criterion touched"] },
  { label: "Planned proof", aliases: ["planned proof", "proof"] },
  { label: "Gap/conflict", aliases: ["gap/conflict", "gap", "conflict"] },
  { label: "Required follow-up", aliases: ["required follow-up", "follow-up"] },
];

const PLANNING_ONLY_PERSONA_CHALLENGE_COLUMNS = [
  { label: "Persona", aliases: ["persona"] },
  { label: "Concern", aliases: ["concern"] },
  { label: "Change made to plan", aliases: ["change made to plan", "change to plan"] },
];

const PLANNING_ONLY_PERSONA_EXPANSION_COLUMNS = [
  { label: "Persona", aliases: ["persona"] },
  { label: "Opportunity", aliases: ["opportunity"] },
  { label: "Why it is not in current scope", aliases: ["why it is not in current scope", "not in current scope"] },
];

function analyzePlanningOnlyRetrosSection(planContent) {
  return analyzePlanningOnlyTableSection(planContent, "Active Retros And Mistake Guards", {
    requiredColumns: PLANNING_ONLY_RETRO_COLUMNS,
  });
}

function analyzePlanningOnlyExactTestInventory(planContent) {
  return analyzePlanningOnlyTableSection(planContent, "Exact Test Inventory", {
    requiredColumns: PLANNING_ONLY_TEST_COLUMNS,
  });
}

function analyzePlanningOnlyRedTeamReview(planContent) {
  return analyzePlanningOnlyTableSection(planContent, "Plan Red-Team Review", {
    requiredColumns: PLANNING_ONLY_RED_TEAM_COLUMNS,
    minRows: 3,
  });
}

function analyzePlanningOnlyStoryAudit(planContent) {
  const storyRegistryIds = loadStoryRegistryIds();
  const linkedStoryIds = extractNormalizedStoryIdsFromText(planContent);
  const required = storyRegistryIds.length > 0 || linkedStoryIds.length > 0;
  if (!required) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Story And Traceability Audit not required — no story registry or linked story ids were found",
    };
  }

  return analyzePlanningOnlyTableSection(planContent, "Story And Traceability Audit", {
    requiredColumns: PLANNING_ONLY_STORY_COLUMNS,
    allowExplicitNoneColumns: ["Gap/conflict"],
  });
}

function analyzePlanningOnlyPersonaChallenges(planContent) {
  return analyzePlanningOnlyTableSection(planContent, "Persona Challenges", {
    requiredColumns: PLANNING_ONLY_PERSONA_CHALLENGE_COLUMNS,
  });
}

function analyzePlanningOnlyPersonaExpansion(planContent) {
  return analyzePlanningOnlyTableSection(planContent, "Persona Expansion Opportunities", {
    requiredColumns: PLANNING_ONLY_PERSONA_EXPANSION_COLUMNS,
  });
}

function readPlanningOnlyTableRows(planContent, heading, requiredColumns) {
  const section = extractMarkdownSection(planContent, heading);
  const { header, rows } = extractMarkdownTable(section);
  if (!header) return [];
  const headerCells = header.map((cell) => normalizeTraceabilityText(cell));
  const indices = Object.fromEntries(requiredColumns.map((column) => [
    column.label,
    findVerificationColumn(
      headerCells,
      normalizeStringList(column.aliases).length > 0 ? column.aliases : [column.label]
    ),
  ]));
  if (Object.values(indices).some((index) => index === -1)) return [];
  return rows.map((row) => {
    const entry = {};
    for (const column of requiredColumns) entry[column.label] = row[indices[column.label]] || "";
    return entry;
  });
}

function normalizeWordSet(value) {
  return new Set(
    normalizeTraceabilityText(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4)
      .filter((token) => !["this", "that", "with", "from", "into", "plan", "review", "story", "proof", "guard", "added", "required"].includes(token))
  );
}

function textsHaveMeaningfulOverlap(left, right, { minShared = 2 } = {}) {
  const leftWords = normalizeWordSet(left);
  const rightWords = normalizeWordSet(right);
  if (leftWords.size === 0 || rightWords.size === 0) return false;
  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) shared += 1;
    if (shared >= minShared) return true;
  }
  return false;
}

function resolvePlanningOnlyKnowledgeContext({ planDir = null, stateJson = null, planContent = "", goalText = "" } = {}) {
  try {
    return resolveKnowledgeFromContext({
      cwd,
      goalText,
      planDir,
      planDirName: planDir ? planDir.split("/").pop() : null,
      stateJson,
      planContent,
      verificationContent: planDir ? (readFile(join(planDir, "verification.md")) || "") : "",
      classificationHints: classifyPlannerPreflight(goalText, {
        plannedFiles: extractFilesToModify(planContent),
        hasActivePlan: !!planDir,
        activePlanPoisoned: false,
        activePlanState: stateJson?.state || null,
      }),
    });
  } catch {
    return null;
  }
}

function analyzePlanningOnlyRetroProvenance(planContent, knowledgeContext) {
  const rows = readPlanningOnlyTableRows(planContent, "Active Retros And Mistake Guards", PLANNING_ONLY_RETRO_COLUMNS);
  if (rows.length === 0) {
    return { applicable: false, satisfied: true, detail: "Retro provenance check skipped — section structure failed earlier" };
  }

  const expectedIds = new Set([
    ...(knowledgeContext?.related_retros || []).map((entry) => entry.id),
    ...(knowledgeContext?.related_mistakes || []).map((entry) => entry.id),
    ...((knowledgeContext?.matches?.trusted || [])
      .filter((entry) => ["retro", "mistake"].includes(entry.kind))
      .map((entry) => entry.id)),
  ]);

  if (expectedIds.size === 0) {
    const concreteSource = rows.some((row) => /(retro_ledger\.json|mistakes\.md|patterns\.md|gotchas\.md|R-\d{4}-\d{2}-\d{2}-\d+|M-[A-Z0-9-]+)/i.test(row["Source"] || ""));
    return {
      applicable: true,
      satisfied: concreteSource,
      detail: concreteSource
        ? "Retro source rows cite concrete KB or retro artifacts"
        : "Active Retros And Mistake Guards should cite concrete sources such as retro ids, mistake ids, or KB artifacts",
    };
  }

  const matchedIds = [...expectedIds].filter((id) => rows.some((row) => normalizeTraceabilityText(row["Source"]).includes(normalizeTraceabilityText(id))));
  return {
    applicable: true,
    satisfied: matchedIds.length > 0,
    detail: matchedIds.length > 0
      ? `Retro/mistake guard table references matched source(s): ${matchedIds.join(", ")}`
      : `Active Retros And Mistake Guards must reference at least one matched retro or mistake id: ${[...expectedIds].slice(0, 5).join(", ")}`,
  };
}

function analyzePlanningOnlyTestInventorySpecificity(planContent) {
  const rows = readPlanningOnlyTableRows(planContent, "Exact Test Inventory", PLANNING_ONLY_TEST_COLUMNS);
  if (rows.length === 0) {
    return { applicable: false, satisfied: true, detail: "Exact test specificity check skipped — section structure failed earlier" };
  }

  const preciseRows = rows.filter((row) => /(`.+`|\.test\.|\.spec\.|pytest|cargo test|go test|npm test|pnpm test|vitest|jest|mocha|node\s+)/i.test(row["Test or test group"] || ""));
  return {
    applicable: true,
    satisfied: preciseRows.length === rows.length,
    detail: preciseRows.length === rows.length
      ? `${rows.length} exact test inventory row(s) name concrete commands, files, or suites`
      : "Exact Test Inventory must name concrete test commands, files, or suites rather than generic future testing",
  };
}

function analyzePlanningOnlyRedTeamProvenance(planContent, knowledgeContext) {
  const rows = readPlanningOnlyTableRows(planContent, "Plan Red-Team Review", PLANNING_ONLY_RED_TEAM_COLUMNS);
  if (rows.length === 0) {
    return { applicable: false, satisfied: true, detail: "Red-team provenance check skipped — section structure failed earlier" };
  }

  const expectedVectors = Array.isArray(knowledgeContext?.suggested_attack_vectors)
    ? knowledgeContext.suggested_attack_vectors
    : [];
  if (expectedVectors.length === 0) {
    const substantiveRows = rows.filter((row) =>
      String(row["Attack"] || "").trim().length >= 20 &&
      String(row["Why this plan is vulnerable"] || "").trim().length >= 20 &&
      String(row["Guard added to the plan"] || "").trim().length >= 20
    );
    return {
      applicable: true,
      satisfied: substantiveRows.length >= 3,
      detail: substantiveRows.length >= 3
        ? "Plan red-team review is substantive even without synthesized attack vectors"
        : "Plan Red-Team Review needs substantive attack, vulnerability, and guard detail",
    };
  }

  const alignedVectors = expectedVectors.filter((vector) =>
    rows.some((row) =>
      normalizeTraceabilityText(row["Attack"]).includes(normalizeTraceabilityText(vector.id)) ||
      textsHaveMeaningfulOverlap(row["Attack"], vector.title) ||
      textsHaveMeaningfulOverlap(row["Attack"], vector.prompt)
    )
  );
  return {
    applicable: true,
    satisfied: alignedVectors.length > 0,
    detail: alignedVectors.length > 0
      ? `Plan red-team review aligns with synthesized attack vectors: ${alignedVectors.slice(0, 3).map((vector) => vector.id).join(", ")}`
      : `Plan Red-Team Review should align with at least one synthesized attack vector such as ${expectedVectors.slice(0, 3).map((vector) => vector.id).join(", ")}`,
  };
}

function analyzePlanningOnlyStoryAuditProvenance(planContent) {
  const rows = readPlanningOnlyTableRows(planContent, "Story And Traceability Audit", PLANNING_ONLY_STORY_COLUMNS);
  if (rows.length === 0) {
    return { applicable: false, satisfied: true, detail: "Story-audit provenance check skipped — section structure failed earlier" };
  }

  const storyIds = loadStoryRegistryIds();
  const linkedStoryIds = extractNormalizedStoryIdsFromText(planContent);
  const expectedIds = [...new Set([...storyIds, ...linkedStoryIds])];
  if (expectedIds.length === 0) {
    return { applicable: false, satisfied: true, detail: "No story ids available for provenance cross-check" };
  }

  const matchedIds = expectedIds.filter((storyId) =>
    rows.some((row) => extractNormalizedStoryIdsFromText(row["Story"]).includes(storyId))
  );
  return {
    applicable: true,
    satisfied: matchedIds.length > 0,
    detail: matchedIds.length > 0
      ? `Story audit references actual story id(s): ${matchedIds.join(", ")}`
      : `Story And Traceability Audit must cite actual story id(s): ${expectedIds.slice(0, 5).join(", ")}`,
  };
}

function analyzePlanningOnlyPersonaProvenance(planContent, knowledgeContext) {
  const challengeRows = readPlanningOnlyTableRows(planContent, "Persona Challenges", PLANNING_ONLY_PERSONA_CHALLENGE_COLUMNS);
  const expansionRows = readPlanningOnlyTableRows(planContent, "Persona Expansion Opportunities", PLANNING_ONLY_PERSONA_EXPANSION_COLUMNS);
  const rows = [...challengeRows, ...expansionRows];
  if (rows.length === 0) {
    return { applicable: false, satisfied: true, detail: "Persona provenance check skipped — section structure failed earlier" };
  }

  const personaIds = normalizeStringList(knowledgeContext?.persona_signals?.pack_ids || []);
  if (personaIds.length === 0) {
    const concretePersonas = rows.filter((row) => String(row["Persona"] || "").trim().length >= 3);
    return {
      applicable: true,
      satisfied: concretePersonas.length === rows.length,
      detail: "No persona artifacts were detected; persona sections remain structurally present for forward planning",
    };
  }

  const matchedPersonas = personaIds.filter((personaId) =>
    rows.some((row) => normalizeTraceabilityText(row["Persona"]).includes(normalizeTraceabilityText(personaId)))
  );
  return {
    applicable: true,
    satisfied: matchedPersonas.length > 0,
    detail: matchedPersonas.length > 0
      ? `Persona sections reference active persona pack(s): ${matchedPersonas.join(", ")}`
      : `Persona sections should reference active persona pack(s): ${personaIds.join(", ")}`,
  };
}

const SYNTHESIS_SECTION_REQUIREMENTS = [
  { label: "Repo/system context", aliases: ["Repo/system context", "Repo context", "System context"] },
  { label: "Task shape", aliases: ["Task shape"] },
  { label: "Ontology signals", aliases: ["Ontology signals", "Ontology signal"] },
  { label: "Persona signals", aliases: ["Persona signals", "Persona signal"] },
  { label: "System boundaries touched", aliases: ["System boundaries touched", "System boundaries", "Boundaries touched"] },
  { label: "Derived verification obligations", aliases: ["Derived verification obligations", "Verification obligations", "Derived obligations"] },
];

const INTENT_LIST_FIELD_GROUPS = [
  { canonical: "desired_outcomes", keys: ["desired_outcomes", "outcomes", "success_outcomes"] },
  { canonical: "anti_goals", keys: ["anti_goals", "false_green_patterns", "must_not_happen"] },
  { canonical: "constraints", keys: ["constraints", "guardrails", "non_goals"] },
];

const DELIVERABLE_LIST_FIELD_GROUPS = [
  { canonical: "quality_bars", keys: ["quality_bars", "qualityBars", "acceptance_bars"] },
  { canonical: "required_sections", keys: ["required_sections", "sections", "required_fields"] },
  { canonical: "required_signals", keys: ["required_signals", "required_metrics", "required_evidence"] },
  { canonical: "anti_goals", keys: ["anti_goals", "false_green_patterns", "must_not_happen"] },
];

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()))];
}

function collectScalarListLikeFieldsFromObject(object, groups, basePath = "") {
  if (!object || typeof object !== "object") return [];
  const paths = [];
  for (const group of groups) {
    for (const key of group.keys) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      const value = object[key];
      if (Array.isArray(value) || value == null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        paths.push(`${basePath}${key}`);
      }
    }
  }
  return paths;
}

function collectIntentContractScalarListFields(intentContract) {
  const parsed = intentContract && typeof intentContract === "object" ? intentContract : null;
  if (!parsed) return [];
  const paths = collectScalarListLikeFieldsFromObject(parsed, INTENT_LIST_FIELD_GROUPS);
  if (Object.prototype.hasOwnProperty.call(parsed, "deliverables") && !Array.isArray(parsed.deliverables)) {
    paths.push("deliverables");
  }
  if (Array.isArray(parsed.deliverables)) {
    for (const [index, deliverable] of parsed.deliverables.entries()) {
      paths.push(...collectScalarListLikeFieldsFromObject(
        deliverable,
        DELIVERABLE_LIST_FIELD_GROUPS,
        `deliverables[${index}].`
      ));
    }
  }
  return uniqueStrings(paths);
}

function collectStoryRegistryLinkageIssues(planContent) {
  const registry = loadStoryRegistryIndex();
  const verificationSection = extractMarkdownSection(planContent, "Verification Strategy");
  const storyRefs = uniqueStrings(extractNormalizedStoryIdsFromText(verificationSection || planContent));
  const activeIds = new Set(registry.ids || []);
  const missing = storyRefs.filter((storyId) => !activeIds.has(storyId) && !registry.invalidById.has(storyId));
  const invalid = storyRefs
    .filter((storyId) => registry.invalidById.has(storyId))
    .map((storyId) => `${storyId} ${registry.invalidById.get(storyId)}`);
  return {
    storyRefs,
    registryPresent: activeIds.size > 0 || registry.invalidById.size > 0,
    missing,
    invalid,
  };
}

function collectMissingSynthesisLabels(planContent) {
  const section = extractMarkdownSection(planContent, "Verification Obligation Synthesis");
  if (!section.trim()) return SYNTHESIS_SECTION_REQUIREMENTS.map((requirement) => requirement.label);
  return SYNTHESIS_SECTION_REQUIREMENTS
    .filter((requirement) => {
      const value = extractLabeledSectionValue(section, requirement.aliases);
      return !isMeaningfulVerificationCell(value, { allowExplicitNone: requirement.label === "Ontology signals" || requirement.label === "Persona signals" });
    })
    .map((requirement) => requirement.label);
}

function targetHotspotRepairGuidance(codes, { planArg = "<plan-dir>" } = {}) {
  const codeSet = codes instanceof Set ? codes : new Set(Array.isArray(codes) ? codes : []);
  const lines = [];
  if (codeSet.has("GATE-EXP-010")) {
    lines.push("GATE-EXP-010 KB-digest repair:");
    lines.push("- Add the transition-printed KB digest salt to `findings_ledger.json` as `kb_digest_salt`, or to `findings.md` as `[KB_DIGEST:<salt>]`.");
    lines.push("- Do not invent the salt; it is printed by the first successful explore-to-plan bootstrap run and verified against `state.json.kb_digest_hash`.");
    lines.push(`- Preflight before retry: node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${planArg} --gate GATE-EXP-010 --json`);
  }
  if (codeSet.has("GATE-REF-003")) {
    lines.push("GATE-REF-003 progress repair:");
    lines.push("- Do not edit `state.json.close_signals`; it is generated by the planner.");
    lines.push("- In `progress.md`, complete evidence-backed administrative items or move substantive unfinished work back to EXECUTE.");
    lines.push(`- Inspect generated progress signals: node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${planArg} --json`);
  }
  if (codeSet.has("GATE-REF-004")) {
    lines.push("GATE-REF-004 KB repair:");
    lines.push("- Do not edit `state.json.close_signals`; it is generated by the planner.");
    lines.push("- In `reflection.md`, complete `## Knowledge Base Sign-Off` with `Decision: no_new_learnings` plus a specific reason, or update `plans/knowledge/mistakes.md`, `patterns.md`, or `gotchas.md` for durable learnings.");
    lines.push(`- Inspect generated KB signals: node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${planArg} --json`);
  }
  if (codeSet.has("GATE-PLN-016")) {
    lines.push("GATE-PLN-016 story-linkage repair:");
    lines.push("- Every Success Criteria row needs an active `Story linkage` value from `reports/user_story_audit/story_registry.json`, or `N/A` only when no registry exists.");
    lines.push("- Use stable `sc_N` criterion IDs in the Criterion column so the matrix maps each success criterion without copying full prose.");
  }
  if (codeSet.has("GATE-PLN-017")) {
    lines.push("GATE-PLN-017 verification-matrix repair:");
    lines.push("- In `plan.md -> ## Verification Strategy`, use the context-sensitive matrix columns exactly: Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified.");
    lines.push("- Use recognized proof IDs such as `proof:dry_run`, `proof:planner_smoke`, `proof:integration_smoke`, `proof:artifact_review`, or `proof:migration_parity` when the synthesized obligation requires them.");
    lines.push(`- Lint before retry: node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planArg} --json`);
  }
  if (codeSet.has("GATE-PLN-020")) {
    lines.push("GATE-PLN-020 semantic-upkeep repair:");
    lines.push("- Complete `plan.md -> ## Semantic Upkeep Contract` with concrete values for Profile, Ontology action, Story action, Validation bundle, Strictness mode, and Close blocker if skipped.");
    lines.push("- Replace placeholders such as `choose one`, `to be`, or generic template prose with task-specific values.");
    lines.push(`- Preflight before retry: node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${planArg} --gate GATE-PLN-020 --json`);
  }
  if (codeSet.has("GATE-PLN-021")) {
    lines.push("GATE-PLN-021 KB-tag repair:");
    lines.push("- Add a concrete knowledge application marker to `plan.md`: `[KB_APPLIED:<id>]` for relevant prior learning, or `[KB_NOT_APPLICABLE:<reason>]` when no prior learning applies.");
    lines.push("- Keep the reason substantive; placeholder `TBD`, `N/A`, or empty tags do not prove KB review.");
    lines.push(`- Preflight before retry: node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${planArg} --gate GATE-PLN-021 --json`);
  }
  if (codeSet.has("GATE-VAL-012")) {
    lines.push("GATE-VAL-012 deliverable-evidence repair:");
    lines.push("- For each required deliverable, record a PASS command or output block in `verification.md` that names the deliverable by id or name.");
    lines.push("- Or add a structured waiver entry to `verification.md` for deliverables that cannot be exercised directly.");
    lines.push(`- Inspect generated intent-evidence signals: node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${planArg} --json`);
  }
  if (codeSet.has("GATE-VAL-013")) {
    lines.push("GATE-VAL-013 anti-recurrence repair:");
    lines.push("- Add an `## Anti-Recurrence Guard` section to `verification.md` with a Guard Type (test, ontology, annotation, or kb) and a PASS/FAIL verdict.");
    lines.push("- Or add a structured waiver entry to `verification.md` for this guard.");
    lines.push(`- Inspect generated anti-recurrence signals: node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${planArg} --json`);
  }
  if (codeSet.has("GATE-VAL-022")) {
    lines.push("GATE-VAL-022 incident-closeout repair:");
    lines.push("- Ensure `incident_contract.json` exists for incident-shaped plans and keep it generated from `incident_contract.mjs`.");
    lines.push("- In `verification.md -> ## Incident Closeout`, record PASS evidence for every `closeout_gates[].id` and every required `required_preflights[].id` from the contract.");
    lines.push("- Include advisor/persona consumption, rerun command, artifact lineage, residual risk, and accepted-risk waivers when any proof is deferred.");
    lines.push(`- Preflight before retry: node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --plan ${planArg} --gate GATE-VAL-022 --json`);
  }
  if (codeSet.has("GATE-SEM-001")) {
    lines.push("GATE-SEM-001 semantic-substrate repair:");
    lines.push("- Run `node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants` and resolve invariant violations.");
    lines.push("- Run `node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories` and repair story-registry coverage gaps.");
    lines.push("- If `story_registry.json` changed after the last signed transition, run a planner transition to refresh `state.json.registry_hash` rather than editing the hash by hand.");
    lines.push(`- Inspect generated semantic substrate signals: node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan ${planArg} --json`);
  }
  return lines;
}

function buildPlanToExecuteRepairSurface({ planDirName, planContent, intentContract, workOrder = null, results = [] }) {
  const planArg = planDirName || "<plan-dir>";
  const scalarFields = collectIntentContractScalarListFields(intentContract);
  const storyIssues = collectStoryRegistryLinkageIssues(planContent);
  const synthesisLabels = SYNTHESIS_SECTION_REQUIREMENTS.map((requirement) => requirement.label);
  const missingSynthesisLabels = collectMissingSynthesisLabels(planContent);
  const matrixColumns = CONTEXT_MATRIX_COLUMNS.map((column) => column.label);
  let evidenceGuidanceLines = [];

  try {
    const planDir = planDirName ? join(plansDir, planDirName) : null;
    const synthesis = computeVerificationObligationSynthesis({
      cwd,
      planDir,
      stateJson: planDir && existsSync(planDir) ? readStateJson(planDir) : null,
      planContent,
    });
    const criteria = extractMatrixSuccessCriteria(planContent, { workOrder });
    const analysis = analyzeVerificationMatrix({ planContent, workOrder, criteria, synthesis });
    const guidance = buildVerificationEvidenceGuidance({
      analysis,
      synthesis,
      criteria,
      planArg,
      forceRequired: true,
    });
    evidenceGuidanceLines = renderEvidenceGuidanceLines(guidance, { compact: true });
  } catch {
    evidenceGuidanceLines = [];
  }

  const storyDetail = !storyIssues.registryPresent
    ? "No story registry detected; use Story linkage: N/A - no story registry."
    : storyIssues.missing.length > 0 || storyIssues.invalid.length > 0
      ? `Current unresolved story refs: ${[...storyIssues.missing, ...storyIssues.invalid].join(", ")}`
      : storyIssues.storyRefs.length > 0
        ? `Current story refs detected: ${storyIssues.storyRefs.join(", ")}`
        : "No story refs detected in Verification Strategy.";

  return renderRepairSurface({
    gateId: "plan-to-execute",
    title: "Plan is not EXECUTE-ready",
    primaryArtifact: `plans/${planArg}/plan.md`,
    missing: [
      `Do not say EXECUTE-ready until this passes: node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute --dry-run --plan ${planArg}`,
      `Deep diagnostics: node .agent/skills/iterative-planner/scripts/planner_findings.mjs --dir . --plan ${planArg} --gate plan-to-execute --json`,
    ],
    actions: [
    ...targetHotspotRepairGuidance(failedGateCodes(results), { planArg }),
    "intent_contract.json list-like fields must be arrays: desired_outcomes, anti_goals, constraints, deliverables[].quality_bars, deliverables[].required_sections, deliverables[].required_signals, deliverables[].anti_goals.",
    scalarFields.length > 0
      ? `Current scalar list-like fields: ${scalarFields.join(", ")}`
      : "Current scalar list-like fields: none detected.",
    `Intent draft/repair helper: node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --plan ${planArg} --dry-run --json`,
    "Story linkage IDs must exist in reports/user_story_audit/story_registry.json with active status before PLAN -> EXECUTE.",
    storyDetail,
    "Verification Strategy Criterion cells may use stable Success Criteria IDs like sc_1/sc_2; do not waste tokens copying full criterion prose when IDs are present.",
    `Verification Obligation Synthesis labels: ${synthesisLabels.join(" | ")}`,
    missingSynthesisLabels.length > 0
      ? `Missing/empty synthesis labels now: ${missingSynthesisLabels.join(", ")}`
      : "Missing/empty synthesis labels now: none detected.",
    `Context-sensitive Verification Strategy columns: ${matrixColumns.join(" | ")}`,
    ],
    diagnostics: [
      ...evidenceGuidanceLines,
    `Matrix parser truth: node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planArg} --json`,
    ],
    retry: `node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute`,
  });
}

function compactPacketText(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function failedGateResults(results) {
  return (Array.isArray(results) ? results : []).filter(gateResultBlocks);
}

function failedGateCodes(results) {
  return new Set(failedGateResults(results).map((result) => result.code).filter(Boolean));
}

function failedResultText(results) {
  return failedGateResults(results)
    .map((result) => `${result.code || ""} ${result.name || ""} ${result.detail || ""}`)
    .join(" ")
    .toLowerCase();
}

function formatFailedResultForPacket(result) {
  const code = result?.code ? `[${result.code}] ` : "";
  const name = compactPacketText(result?.name || "Unnamed check");
  const detail = compactPacketText(result?.detail || "", 180);
  return detail ? `${code}${name} - ${detail}` : `${code}${name}`;
}

function buildExploreToPlanRepairLines({ planDirName, results }) {
  const planArg = planDirName || "<plan-dir>";
  const codes = failedGateCodes(results);
  const failedText = failedResultText(results);
  const needsFindings = codes.has("GATE-EXP-001") || codes.has("GATE-EXP-009") || /finding/.test(failedText);
  const needsRootCause = codes.has("GATE-EXP-002") || /root cause/.test(failedText);
  const needsKb = codes.has("GATE-EXP-010") || /kb read|kb digest|knowledge base/.test(failedText);
  const needsAdjacency = codes.has("GATE-EXP-004") || /adjacency/.test(failedText);
  const needsIntent = codes.has("GATE-EXP-014") || /intent contract/.test(failedText);
  const needsAssumptions = /assumption ledger|assumption probe|verified or violated/.test(failedText);

  const checklist = [];
  if (needsFindings) checklist.push("Add at least three indexed `## F-00N` findings with evidence and content depth.");
  if (needsRootCause) checklist.push("Add `## Root Cause` with the causal chain, not just the symptom.");
  if (needsAdjacency) checklist.push("Add `## Adjacency` listing sibling files, importers, and adjacent modules.");
  if (needsAssumptions) checklist.push("Add `## Assumption Ledger` with at least one `VERIFIED:` or `VIOLATED:` probe result.");
  if (needsKb) checklist.push("Add the printed `[KB_DIGEST:<salt>]` to findings.md or findings_ledger.json after other FAIL items clear.");
  if (needsIntent) checklist.push(`Run intent repair: node .agent/skills/iterative-planner/scripts/intent_contract_bootstrap.mjs --plan ${planArg} --dry-run --json`);
  if (checklist.length === 0) checklist.push("Fix the failed checks listed below, then retry the transition once.");

  return renderRepairSurface({
    gateId: "explore-to-plan",
    title: "Findings are not PLAN-ready",
    primaryArtifact: `plans/${planArg}/findings.md (or findings_ledger.json for structured findings)`,
    missing: checklist.map((item) => `- ${item}`),
    sections: [{
      heading: "Suggested minimum findings.md shape",
      lines: [
        "```markdown",
        "## Index",
        "- F-001: Observed failure and direct evidence.",
        "- F-002: Root cause or contract gap.",
        "- F-003: Blast radius or adjacency finding.",
        "",
        "## F-001 - Observed failure and direct evidence",
        "- Symptom: ...",
        "- Evidence: ...",
        "",
        "## F-002 - Root cause or contract gap",
        "- Cause: ...",
        "- Why current behavior allowed it: ...",
        "",
        "## F-003 - Blast radius or adjacency finding",
        "- Adjacent files: ...",
        "- Risk if missed: ...",
        "",
        "## Root Cause",
        "Describe the causal chain from user-visible failure to code/process gap.",
        "",
        "## Assumption Ledger",
        "- VERIFIED: ...",
        "- VIOLATED: ...",
        "",
        "## Adjacency",
        "- path/to/file: why it is adjacent",
        "```",
      ],
    }],
  });
}

function buildGenericGateRepairLines({ planDirName, gateName, results, planningOnly = false }) {
  const planArg = planDirName || "<plan-dir>";
  const gateArg = gateName || "<gate>";
  const planningFlag = planningOnly ? " --planning-only" : "";
  const failed = failedGateResults(results);
  const codes = failedGateCodes(results);
  const primaryCode = [...codes].find((code) => loadGateRepairTemplate(code)) || failed[0]?.code || gateArg;
  const template = loadGateRepairTemplate(primaryCode);
  const truthCommand = planningOnly
    ? `node .agent/skills/iterative-planner/scripts/verify_gate.mjs ${gateArg} --plan ${planArg}${planningFlag}`
    : `node .agent/skills/iterative-planner/scripts/transition.mjs ${gateArg} --dry-run --plan ${planArg}`;
  return renderRepairSurface({
    template,
    gateId: primaryCode,
    title: template?.title || `${gateArg} failed`,
    primaryArtifact: `plans/${planArg}`,
    missing: [
      ...failed.slice(0, 8).map((result) => `- ${formatFailedResultForPacket(result)}`),
      failed.length > 8 ? `- ... ${failed.length - 8} more failed check(s) omitted from the compact surface.` : null,
    ].filter(Boolean),
    actions: targetHotspotRepairGuidance(codes, { planArg }),
    diagnostics: [
      `Truth command: ${truthCommand}`,
      `Deep diagnostics: node .agent/skills/iterative-planner/scripts/planner_findings.mjs --dir . --plan ${planArg} --gate ${gateArg} --json`,
      "Loop recovery: node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck --json",
    ],
    retry: `node .agent/skills/iterative-planner/scripts/transition.mjs ${gateArg}`,
  });
}

function buildGateRepairPacket({ planDir, planDirName, gateName, results, planningOnly = false } = {}) {
  const failed = failedGateResults(results);
  if (failed.length === 0) return [];

  const planArg = planDirName || "<plan-dir>";
  const resolvedPlanDir = planDir || (planDirName ? join(plansDir, planDirName) : null);
  if (gateName === "plan-to-execute" && !planningOnly && resolvedPlanDir) {
    const planContentForPacket = readFile(join(resolvedPlanDir, "plan.md"));
    const intentInfoForPacket = loadIntentContract(resolvedPlanDir);
    const workOrderInfoForPacket = loadPlanWorkOrder(resolvedPlanDir);
    return [
      ...buildPlanToExecuteRepairSurface({
        planDirName: planArg,
        planContent: planContentForPacket,
        intentContract: intentInfoForPacket.parsed,
        workOrder: workOrderInfoForPacket.error ? null : workOrderInfoForPacket.parsed,
        results,
      }),
      "Loop recovery: node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck --json",
    ];
  }

  if (gateName !== "explore-to-plan") {
    return buildGenericGateRepairLines({ planDirName: planArg, gateName, results, planningOnly });
  }

  return [
    ...buildExploreToPlanRepairLines({ planDirName: planArg, results }),
    "Diagnostics:",
    `Truth command: ${planningOnly
      ? `node .agent/skills/iterative-planner/scripts/verify_gate.mjs ${gateName} --plan ${planArg} --planning-only`
      : `node .agent/skills/iterative-planner/scripts/transition.mjs ${gateName} --dry-run --plan ${planArg}`}`,
    `Deep diagnostics: node .agent/skills/iterative-planner/scripts/planner_findings.mjs --dir . --plan ${planArg} --gate ${gateName} --json`,
    "Loop recovery: node .agent/skills/iterative-planner/scripts/bootstrap.mjs fix-stuck --json",
    `Retry after edits: node .agent/skills/iterative-planner/scripts/transition.mjs ${gateName}`,
  ];
}

function extractLabeledSectionValue(section, aliases) {
  const lines = String(section || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const withoutBullet = line.replace(/^[-*]\s*/, "").trim();
    const normalizedLine = normalizeTraceabilityText(withoutBullet);
    for (const alias of aliases) {
      const normalizedAlias = normalizeTraceabilityText(alias);
      if (!new RegExp(`^${escapeRegex(normalizedAlias)}\\s*:`).test(normalizedLine)) continue;
      const colonIndex = withoutBullet.indexOf(":");
      return colonIndex === -1 ? "" : withoutBullet.slice(colonIndex + 1).trim();
    }
  }
  return "";
}

function analyzeVerificationObligationSynthesisSection(planContent, synthesis) {
  if (!synthesis.required) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Verification obligation synthesis section not required for this plan shape",
    };
  }

  const section = extractMarkdownSection(planContent, "Verification Obligation Synthesis");
  if (!section.trim()) {
    return {
      applicable: true,
      satisfied: false,
      detail: "Relevant plans must include a 'Verification Obligation Synthesis' section describing repo/system context, task shape, ontology signals, persona signals, touched boundaries, and derived obligations",
    };
  }

  const issues = [];
  const values = {};
  for (const requirement of SYNTHESIS_SECTION_REQUIREMENTS) {
    const value = extractLabeledSectionValue(section, requirement.aliases);
    values[requirement.label] = value;
    if (!isMeaningfulVerificationCell(value, { allowExplicitNone: requirement.label === "Ontology signals" || requirement.label === "Persona signals" })) {
      issues.push(`Verification Obligation Synthesis is missing ${requirement.label}`);
    }
  }

  const personaSignalsPresent = (synthesis.source_summary?.persona_signals || []).length > 0;
  const ontologySignalsPresent = (synthesis.source_summary?.ontology_signals || []).length > 0;
  if (personaSignalsPresent && ["n/a", "none"].includes(normalizeTraceabilityText(values["Persona signals"]))) {
    issues.push("Verification Obligation Synthesis cannot mark persona signals as N/A when persona artifacts contributed to the synthesized obligations");
  }
  if (ontologySignalsPresent && ["n/a", "none"].includes(normalizeTraceabilityText(values["Ontology signals"]))) {
    issues.push("Verification Obligation Synthesis cannot mark ontology signals as N/A when story or recipe signals contributed to the synthesized obligations");
  }

  return {
    applicable: true,
    satisfied: issues.length === 0,
    detail: issues.length === 0
      ? `Verification Obligation Synthesis section records ${SYNTHESIS_SECTION_REQUIREMENTS.length} required context fields`
      : issues.join("; "),
  };
}

function detectContextSensitiveVerificationNeed(planContent, goalText, planDir, stateJson) {
  const synthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson,
    planContent,
  });
  return {
    required: synthesis.required,
    matchedFamilies: synthesis.obligations || [],
    synthesis,
  };
}

function analyzeContextSensitiveVerificationMatrix(planContent, goalText, planDir, stateJson, { workOrder = null } = {}) {
  const trigger = detectContextSensitiveVerificationNeed(planContent, goalText, planDir, stateJson);
  if (!trigger.required) {
    return {
      applicable: false,
      satisfied: true,
      detail: "Context-sensitive verification matrix not required for this plan shape",
    };
  }

  const analysis = analyzeVerificationMatrix({
    planContent,
    workOrder,
    criteria: extractMatrixSuccessCriteria(planContent, { workOrder }),
    synthesis: trigger.synthesis,
  });
  return {
    applicable: true,
    satisfied: analysis.satisfied,
    detail: summarizeVerificationMatrixDiagnostics(analysis),
    diagnostics: analysis,
  };
}

function readIntentAnalysis(planDir, planContent = null) {
  const stateJson = readStateJson(planDir);
  const goalText = stateJson?.goal || extractGoalFromPlanContent(planContent || readFile(join(planDir, "plan.md")));
  const intentInfo = loadIntentContract(planDir);
  const analysis = analyzeIntentContract(intentInfo.parsed, { goalText });
  return { stateJson, goalText, intentInfo, analysis };
}

function resolveIntentEvidenceSignal(planDir) {
  const closeSignals = getCloseSignals(planDir);
  if (typeof closeSignals?.intent_evidence?.satisfied === "boolean") {
    const signal = closeSignals.intent_evidence;
    const required = signal.required === true;
    const missing = Array.isArray(signal.missing_deliverables) ? signal.missing_deliverables : [];
    return {
      required,
      satisfied: signal.satisfied,
      detail: !required
        ? "Structured close signal: intent-driven deliverable evidence not required for this plan"
        : signal.satisfied
          ? `Structured close signal: ${signal.satisfied_deliverables || 0}/${signal.required_deliverables || 0} required deliverable(s) have evidence or waiver`
          : missing.length > 0
            ? `Intent-driven deliverables still missing evidence or waiver: ${missing.join(", ")}`
            : `Intent-driven deliverable evidence not satisfied (status=${signal.status || "unknown"})`,
    };
  }

  return {
    required: false,
    satisfied: true,
    detail: "Legacy plan without structured intent-evidence signal",
  };
}

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

function gateExploreToPlan(planDir) {
  const results = [];
  const findingsTruth = resolveFindingsTruth(planDir);
  const findingsContent = findingsTruth.findingsContent || "";
  const planContentForShape = readFile(join(planDir, "plan.md")) || "";
  const { intentInfo, analysis: intentAnalysis, stateJson: gateStateJson, goalText } = readIntentAnalysis(planDir, planContentForShape);
  // v7.3.0: detect plan shape so EXPLORE requirements scale to task type.
  // bug-fix / regression / migration / planner-core need root cause + adjacency.
  // feature / integration / refactor / docs do not — demanding "Root Cause: N/A"
  // padding from them is pure ritual.
  const planShape = detectPlanShape({
    goalText: goalText || gateStateJson?.goal || "",
    plannedFiles: extractFilesToModify(planContentForShape) || [],
    intentContract: intentInfo?.parsed || null,
  });
  const effectiveFindings = findingsTruth.effective || {
    source: "none",
    findingCount: 0,
    hasRootCause: false,
    hasAdjacency: false,
    kbDigestSalt: null,
    searchText: "",
    depth: {
      fastTrack: false,
      hasDepth: false,
      findingWords: 0,
      minWordsPerFinding: 50,
      shallowSections: [],
      missingDetailedSections: false,
    },
  };
  const findingsSourceLabel = findingsTruth.source === "json" ? "findings_ledger.json" : "findings.md";

  // 1. Minimum N indexed findings — shape-conditional (v7.3.0).
  // bug-fix / regression / migration / planner-core / unknown → ≥3
  // feature / integration / refactor / docs → ≥1
  const findingCount = effectiveFindings.findingCount;
  const minFindings = shapeMinFindings(planShape);
  results.push(withFailureCode(check(
    `Minimum ${minFindings} indexed finding(s) in the effective findings source [shape: ${planShape.primary}]`,
    findingCount >= minFindings ? PASS : FAIL,
    `Found ${findingCount} indexed finding(s) in ${findingsSourceLabel} (shape '${planShape.primary}' requires ≥${minFindings})`
  ), "GATE-EXP-001"));

  // 1b. RT-005: Content depth — findings must have substance, not just headings
  // Fast-track mode: relaxed depth for bug-fix plans / audit-driven plans where findings are pre-known.
  // Activate via: _PLANNER_FAST_TRACK=1 environment variable, [FAST_TRACK] in findings.md, or fast_track in findings_ledger.json.
  if (effectiveFindings && findingCount >= 3) {
    const depth = effectiveFindings.depth;
    const modeLabel = depth.fastTrack ? " [FAST_TRACK]" : "";
    results.push(withFailureCode(check(
      "Findings have content depth (not just headings)",
      depth.hasDepth ? PASS : FAIL,
      depth.hasDepth
        ? `${depth.findingWords} words across ${findingCount} indexed findings — sufficient depth${modeLabel}`
        : depth.missingDetailedSections
          ? `No self-contained indexed finding sections found${modeLabel} — expand each finding entry with real analysis in ${findingsSourceLabel}`
          : `${depth.shallowSections.length} shallow section(s) or <${depth.minWordsPerFinding} words/finding${modeLabel} in ${findingsSourceLabel}`
    ), "GATE-EXP-009"));
  }

  if (findingsTruth.issues.length > 0) {
    results.push(withFailureCode(check(
      "Structured findings sources are aligned",
      WARN,
      findingsTruth.issues.join("; ")
    ), "GATE-EXP-013"));
  }

  // 2. Root Cause Chain present — shape-conditional (v7.3.0).
  // Required for shapes that imply a known bad state to diagnose: bug-fix,
  // regression, migration, planner-core, unknown. Feature / integration /
  // refactor / docs plans skip this entirely — demanding "Root Cause: N/A"
  // padding from them was pure ritual.
  const hasRootCause = effectiveFindings.hasRootCause;
  const rootCauseRequired = shapeRequiresField(planShape, "root_cause");
  if (rootCauseRequired) {
    results.push(withFailureCode(check(
      `Root cause analysis present in findings [shape: ${planShape.primary}]`,
      hasRootCause ? PASS : FAIL,
      hasRootCause
        ? `Root cause documentation found in ${findingsSourceLabel}`
        : `Shape '${planShape.primary}' requires a root cause — add it to findings_ledger.json or findings.md`
    ), "GATE-EXP-002"));
  } else {
    results.push(withFailureCode(check(
      `Root cause analysis present in findings [shape: ${planShape.primary}]`,
      PASS,
      `Not required for shape '${planShape.primary}' (no diagnosis target)`
    ), "GATE-EXP-002"));
  }

  // 3. KB read proof — RT2-003: hash-based. Salt printed by transition command,
  // hash stored in state.json. LLM writes [KB_DIGEST:<salt>] in findings.md.
  // Gate recomputes hash(salt + KB_content) and verifies.
  const kbFiles = ["index.md", "mistakes.md", "patterns.md", "gotchas.md"];
  const kbIndexPath = join(knowledgeDir, "index.md");
  const kbStateJson = readStateJson(planDir);
  const kbDigestHash = kbStateJson?.kb_digest_hash;

  if (kbDigestHash && fileExists(kbIndexPath)) {
    // Extract salt from findings.md: [KB_DIGEST:<salt>]
    // H2-FIX + RT8-H2 + RT9-M2: Use centralized KB_SALT_HEX_LEN constant
    const kbDigestSalt = findingsTruth.json?.kbDigestSalt || findingsTruth.markdown?.kbDigestSalt || null;
    let kbVerified = false;
    if (kbDigestSalt && new RegExp(`^[0-9a-f]{${KB_SALT_HEX_LEN}}$`).test(kbDigestSalt)) {
      let kbContent = "";
      for (const kbFile of kbFiles) {
        const kbPath = join(knowledgeDir, kbFile);
        if (existsSync(kbPath)) kbContent += readFileSync(kbPath, "utf-8");
      }
      const candidateHash = createHash("sha256").update(kbDigestSalt + kbContent).digest("hex").slice(0, 32);
      kbVerified = candidateHash === kbDigestHash;
    }
    results.push(withFailureCode(check(
      "KB read proof ([KB_DIGEST] hash verified)",
      kbVerified ? PASS : FAIL,
      kbVerified
        ? "KB digest salt verified — KB was read"
        : "Missing or incorrect KB digest salt in findings_ledger.json or findings.md — salt was printed by explore-to-plan transition"
    ), "GATE-EXP-010"));
  } else if (!kbDigestHash && fileExists(kbIndexPath)) {
    // Bootstrap case: new plan has no kb_digest_hash yet. The hash is generated by the
    // transition AFTER all checks pass (totalFail === 0), creating a catch-22 on first run.
    // Resolved as WARN so the first transition can succeed, write the hash, and reveal
    // the salt — then the LLM writes [KB_DIGEST:<salt>] and the next run fully verifies.
    // (BUG-5: Previously removed as FAIL to fix hash-length mismatch from legacy path.
    //  That fix was correct but over-corrected — bootstrap case should be WARN, not FAIL.)
    results.push(withFailureCode(check(
      "KB read proof (first run — hash not yet generated)",
      WARN,
      "No kb_digest_hash in state.json yet — this transition will generate it. Next run will require the KB digest salt in findings_ledger.json or findings.md."
    ), "GATE-EXP-010"));
  } else {
    // No KB yet — first plan
    results.push(withFailureCode(check(
      "KB read proof (first plan — no KB yet)",
      PASS,
      "Knowledge base does not exist yet — will be created at CLOSE"
    ), "GATE-EXP-010"));
  }

  // 4. Adjacency discovery markers — shape-conditional (v7.3.0).
  // Required for shapes where ripple-through is plausible: bug-fix, regression,
  // migration, planner-core, refactor, unknown. Feature / integration / docs
  // plans skip this — single-file work doesn't need an adjacency enumeration.
  const hasAdjacency = effectiveFindings.hasAdjacency;
  const adjacencyRequired = shapeRequiresField(planShape, "adjacency");
  if (adjacencyRequired) {
    results.push(withFailureCode(check(
      `Adjacency discovery performed [shape: ${planShape.primary}]`,
      hasAdjacency ? PASS : FAIL,
      hasAdjacency
        ? `Adjacency markers found in ${findingsSourceLabel}`
        : `Shape '${planShape.primary}' requires adjacency — list importers/sibling files in findings_ledger.json or findings.md`
    ), "GATE-EXP-004"));
  } else {
    results.push(withFailureCode(check(
      `Adjacency discovery performed [shape: ${planShape.primary}]`,
      PASS,
      `Not required for shape '${planShape.primary}' (no plausible ripple)`
    ), "GATE-EXP-004"));
  }

  const intentRequired = intentAnalysis.requiredByGoal;
  const missingIntentFields = intentAnalysis.missingCoreFields.join(", ");
  results.push(withFailureCode(check(
    "Intent contract captured for user-facing or deliverable-heavy goals",
    !intentRequired
      ? PASS
      : intentInfo.error
        ? FAIL
        : intentAnalysis.meaningful
          ? PASS
          : FAIL,
    !intentRequired
      ? "Intent contract not required for this goal"
      : intentInfo.error
        ? intentInfo.error
        : intentAnalysis.meaningful
          ? `intent_contract.json captures user, job, outcomes, and ${intentAnalysis.requiredDeliverables.length} required deliverable(s)`
          : `intent_contract.json missing required intent fields: ${missingIntentFields || "meaningful deliverable contract"}`
  ), "GATE-EXP-014"));

  // 5. Goal-relevance check (GATE-EXP-012) — findings must address the plan goal
  try {
    const stateContent = readFile(join(planDir, "state.json"));
    const stateObj = JSON.parse(stateContent);
    const goalText = (stateObj.goal || "").toLowerCase();
    const STOP_WORDS = new Set(["the","a","an","in","of","to","for","with","and","or","is","are","be","by","from","that","this","its","it","on","at","as","was","has","have","which","not","but","we","use"]);
    const goalWords = goalText.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w));
    const uniqueGoalWords = [...new Set(goalWords)].slice(0, 5);
    if (uniqueGoalWords.length > 0) {
      const findingsLower = (effectiveFindings.searchText || findingsContent || "").toLowerCase();
      const matched = uniqueGoalWords.filter(w => findingsLower.includes(w));
      const goalRelevant = matched.length >= Math.min(2, uniqueGoalWords.length);
      results.push(withFailureCode(check(
        "Findings reference the plan goal",
        goalRelevant ? PASS : WARN,
        goalRelevant
          ? `Goal keywords found in findings (${matched.length}/${uniqueGoalWords.length} matched)`
          : `Findings may not address the plan goal — only ${matched.length}/${uniqueGoalWords.length} goal keywords found. Verify findings relate to: "${stateObj.goal}"`
      ), "GATE-EXP-012"));
    }
  } catch (_) {
    // state.json unreadable or no goal field — skip check
  }

  const quantScaleContract = evaluateOptimizationScaleContract({
    cwd,
    planDir,
    planContent: planContentForShape,
    findingsContent,
    stateJson: gateStateJson,
  });
  const quantScaleCompatibility = quantGateCompatibilityStatus("GATE-EXP-020", requiredExecutionOutcomeBlocks(quantScaleContract), { cwd });
  results.push(withFailureCode(check(
    "Quant Optimization Scale Contract has numeric scope content before PLAN",
    quantScaleCompatibility.status,
    `${summarizeOptimizationScaleContractGate(quantScaleContract)}${quantScaleCompatibility.detail_suffix}`
  ), "GATE-EXP-020"));

  const quantRunClassInflation = evaluateRunClassInflation({
    cwd,
    planDir,
    planContent: planContentForShape,
    findingsContent,
    stateJson: gateStateJson,
  });
  const quantRunClassCompatibility = quantGateCompatibilityStatus("GATE-EXP-021", requiredExecutionOutcomeBlocks(quantRunClassInflation), { cwd });
  results.push(withFailureCode(check(
    "Quant run class matches discovered search scale before PLAN",
    quantRunClassCompatibility.status,
    `${summarizeRunClassInflationGate(quantRunClassInflation)}${quantRunClassCompatibility.detail_suffix}`
  ), "GATE-EXP-021"));

  const quantLeakageArtifacts = evaluateLeakageProofArtifactRequirements({
    cwd,
    planDir,
    planContent: planContentForShape,
    findingsContent,
    stateJson: gateStateJson,
  });
  results.push(withFailureCode(check(
    "Quant leakage/temporal proof rows link firing negative fixtures before PLAN",
    requiredExecutionOutcomeGateStatus(quantLeakageArtifacts),
    summarizeLeakageProofArtifactGate(quantLeakageArtifacts)
  ), "GATE-EXP-022"));

  return results;
}

function evaluateOpportunityStagnation(planDir) {
  // Locate opportunity queue
  const pathsToTry = [
    join(cwd, "reports", "stewardship", "opportunity_queue.json"),
    join(cwd, "reports", "knowledge_steward", "opportunity_queue.json"),
  ];
  let queuePath = null;
  for (const p of pathsToTry) {
    if (existsSync(p)) {
      queuePath = p;
      break;
    }
  }

  if (!queuePath) {
    return { satisfied: true, detail: "No opportunity queue found — stagnation check passed" };
  }

  let queueDoc = null;
  try {
    queueDoc = JSON.parse(readFileSync(queuePath, "utf-8"));
  } catch (e) {
    return { satisfied: true, detail: `Failed to parse opportunity queue: ${e.message} — ignoring` };
  }

  let opportunities = [];
  if (Array.isArray(queueDoc)) {
    opportunities = queueDoc;
  } else if (Array.isArray(queueDoc?.opportunities)) {
    opportunities = queueDoc.opportunities;
  } else if (Array.isArray(queueDoc?.actions)) {
    opportunities = queueDoc.actions;
  } else if (Array.isArray(queueDoc?.proposals)) {
    opportunities = queueDoc.proposals;
  }

  const highConfEscalate = opportunities.filter((op) => {
    const isEscalate = String(op?.action_tier || "").toLowerCase() === "escalate";
    const isHighConf = String(op?.confidence || "").toLowerCase() === "high";
    return isEscalate || isHighConf;
  });

  if (highConfEscalate.length === 0) {
    return { satisfied: true, detail: "No high-confidence or escalate opportunities found in queue" };
  }

  const decisionsPath = join(planDir, "decisions.md");
  const decisionsContent = safeReadFile(decisionsPath) || "";

  const planPath = join(planDir, "plan.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";

  const findingsPath = join(planDir, "findings.md");
  const findingsContent = existsSync(findingsPath) ? readFileSync(findingsPath, "utf-8") : "";

  const globalDecisionsPath = join(cwd, "plans", "DECISIONS.md");
  const globalDecisionsContent = existsSync(globalDecisionsPath) ? readFileSync(globalDecisionsPath, "utf-8") : "";

  const unaddressed = [];
  for (const op of highConfEscalate) {
    const opId = op.id;
    if (!opId) continue;

    const regex = new RegExp(`\\b${opId}\\b`, "i");
    const inLocalDecisions = regex.test(decisionsContent);
    const inGlobalDecisions = regex.test(globalDecisionsContent);
    const inPlan = regex.test(planContent);
    const inFindings = regex.test(findingsContent);

    if (!inLocalDecisions && !inGlobalDecisions && !inPlan && !inFindings) {
      unaddressed.push(op);
    }
  }

  if (unaddressed.length > 0) {
    const ids = unaddressed.map((op) => `${op.id} ("${op.title}")`).join(", ");
    return {
      satisfied: false,
      detail: `Stagnation block: high-confidence/escalate opportunity queue items must be addressed by this plan or deferred via a decision ledger entry in decisions.md. Unaddressed/un-decided: ${ids}`,
      unaddressedIds: unaddressed.map((op) => op.id),
    };
  }

  return {
    satisfied: true,
    detail: `All ${highConfEscalate.length} high-confidence/escalate opportunities are addressed or deferred in decision ledger`,
  };
}

function gatePlanToExecute(planDir, options = {}) {
  const results = [];
  const planningOnly = options?.planningOnly === true;
  const planPath = join(planDir, "plan.md");
  const planContent = readFile(planPath);
  const stateJson = readStateJson(planDir);
  const workOrderInfo = loadPlanWorkOrder(planDir);
  const workOrder = workOrderInfo.error ? null : workOrderInfo.parsed;
  const { intentInfo, analysis: intentAnalysis } = readIntentAnalysis(planDir, planContent);
  const decisionsPath = join(planDir, "decisions.md");
  // RT7-H3: Use size-capped read for decisions.md (nonce regex target)
  const decisionsContent = safeReadFile(decisionsPath);
  const verificationPath = join(planDir, "verification.md");
  const verificationContent = readFile(verificationPath);

  // 1. Problem Statement present
  const hasProblemStatement = containsString(planContent, "## Problem Statement");
  const problemNotTemplate = !containsString(planContent, "To be defined during PLAN");
  results.push(withFailureCode(check(
    "Problem Statement defined in plan.md",
    hasProblemStatement && problemNotTemplate ? PASS : FAIL,
    hasProblemStatement && problemNotTemplate ? "Problem statement found" : "Problem statement missing or still template"
  ), "GATE-PLN-001"));

  // 2. Files To Modify listed
  const plannedFiles = extractFilesToModify(planContent);
  const hasFileList = plannedFiles.length > 0;
  const filesNotTemplate = !containsString(planContent, "To be determined after EXPLORE");
  results.push(withFailureCode(check(
    "Files to modify listed in plan.md",
    hasFileList && filesNotTemplate ? PASS : FAIL,
    hasFileList && filesNotTemplate ? `File list found (${plannedFiles.length} owned file(s))` : "File list missing or still template"
  ), "GATE-PLN-002"));

  // GATE-PLN-ANN-001: annotation traceability for owned files. Every existing
  // annotation-worthy file listed in `## Files To Modify` must carry a minimum
  // identity annotation (`@planner:module` or `@planner:capability`) unless the
  // plan declares an exact, substantive waiver:
  // [KB_NOT_APPLICABLE: annotation: <file>: <reason>].
  {
    if (planningOnly) {
      results.push(withFailureCode(check(
        "Annotation-worthy owned files declare @planner:module/capability or exact waiver",
        PASS,
        "Planning-only handoff does not enter EXECUTE; annotation discipline is enforced when running plan-to-execute for implementation."
      ), "GATE-PLN-ANN-001"));
    } else {
      const annotationDiscipline = analyzeAnnotationDiscipline({ planContent, cwd, env: process.env });
      const annGaps = annotationDiscipline.violations || [];
      const status = !annotationDiscipline.enabled && annotationDiscipline.required
        ? WARN
        : annGaps.length === 0
          ? PASS
          : FAIL;
      const violationDetail = annGaps
        .slice(0, 5)
        .map((entry) => `${entry.path} (${entry.kind})`)
        .join(", ");
      results.push(withFailureCode(check(
        "Annotation-worthy owned files declare @planner:module/capability or exact waiver",
        status,
        status === WARN
          ? "Annotation discipline is disabled by PLANNER_ANNOTATION_DISCIPLINE=off; worthy files are advisory only"
          : annGaps.length === 0
            ? "All existing annotation-worthy owned files declare @planner:module/capability or are exactly waived"
            : `Annotation discipline violation(s) — add @planner:module or @planner:capability, or declare an exact substantive [KB_NOT_APPLICABLE: annotation: <file>: <reason>] waiver: ${violationDetail}`
      ), "GATE-PLN-ANN-001"));
    }
  }

  const scopeContract = buildScopeContract({ cwd, planDir, planContent });
  const ambientAck = planHasAmbientDirtyScopeAcknowledgement(planContent);
  if (scopeContractRequiresAmbientAcknowledgement(scopeContract)) {
    results.push(withFailureCode(check(
      "Ambient dirty scope acknowledged",
      ambientAck ? PASS : WARN,
      ambientAck
        ? `Ambient dirty scope acknowledged (${summarizeScopeContract(scopeContract)})`
        : `Large unrelated dirty diff is already deterministically quarantined. Optional clarity: add "## Ambient Dirty Scope" with "Unowned changes exist and are not part of this plan." (${summarizeScopeContract(scopeContract)})`
    ), "GATE-PLN-018"));
  }

  // 3. Steps defined
  const stepsSection = extractMarkdownSection(planContent, "Steps");
  const hasSteps = !!stepsSection.trim();
  const stepsNotTemplate = !/^\*To be determined/i.test(stepsSection.trim());
  results.push(withFailureCode(check(
    "Execution steps defined in plan.md",
    hasSteps && stepsNotTemplate ? PASS : FAIL,
    hasSteps && stepsNotTemplate ? "Steps found" : "Steps missing or still template"
  ), "GATE-PLN-003"));

  // 4. Verification Strategy section required (not just Success Criteria)
  const hasVerificationStrategy = containsString(planContent, "## Verification Strategy");
  const verificationNotTemplate = planContent ? !planContent.match(/## Verification Strategy\s*\n\*To be defined/) : true;
  results.push(withFailureCode(check(
    "Verification Strategy section present in plan.md",
    hasVerificationStrategy && verificationNotTemplate ? PASS : FAIL,
    hasVerificationStrategy && verificationNotTemplate
      ? "## Verification Strategy section found"
      : "## Verification Strategy section missing or still template (## Success Criteria alone is not sufficient)"
  ), "GATE-PLN-004"));
  // 4b. Success Criteria section (separate advisory check)
  const hasSuccessCriteria = containsString(planContent, "## Success Criteria");
  results.push(withFailureCode(check(
    "Success Criteria section present (recommended)",
    hasSuccessCriteria ? PASS : WARN,
    hasSuccessCriteria ? "## Success Criteria found" : "## Success Criteria missing (recommended for clarity)"
  ), "GATE-PLN-005"));

  // 5. Fix Classification present (for bug fixes)
  const hasFixClass = containsString(planContent, "Root-cause fix") ||
                      containsString(planContent, "Symptom suppression") ||
                      containsString(planContent, "Defense in depth") ||
                      containsString(planContent, "## Fix Classification");
  results.push(withFailureCode(check(
    "Fix classification present",
    hasFixClass ? PASS : WARN,
    hasFixClass ? "Fix classification found" : "No fix classification (required for bug fixes, optional for features)"
  ), "GATE-PLN-006"));

  // 6. Decision logged
  const decisionCount = decisionsContent ? (decisionsContent.match(/^## D-\d+/gm) || []).length : 0;
  // Also check for any non-boilerplate ## heading as a decision
  const hasAnyDecision = decisionCount > 0 || countH2Headings(decisionsContent) > 1;
  results.push(withFailureCode(check(
    "At least one decision logged in decisions.md",
    hasAnyDecision ? PASS : WARN,
    hasAnyDecision ? `${Math.max(decisionCount, countH2Headings(decisionsContent) - 1)} decision(s) logged` : "No decisions logged (recommended: log chosen approach)"
  ), "GATE-PLN-007"));

  const intentRequired = intentAnalysis.requiredByGoal;
  const planLower = String(planContent || "").toLowerCase();
  const missingDeliverableMappings = intentAnalysis.requiredDeliverables.filter((deliverable) => {
    const needles = [deliverable.name, deliverable.id]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.toLowerCase());
    return !needles.some((needle) => planLower.includes(needle));
  });
  const hasAntiGoalCoverage = intentAnalysis.antiGoals.length > 0 ||
    intentAnalysis.requiredDeliverables.some((deliverable) => deliverable.antiGoals.length > 0);

  results.push(withFailureCode(check(
    "Intent contract remains valid for required goals",
    !intentRequired
      ? PASS
      : intentInfo.error
        ? FAIL
        : intentAnalysis.meaningful
          ? PASS
          : FAIL,
    !intentRequired
      ? "Intent contract not required for this goal"
      : intentInfo.error
        ? intentInfo.error
        : intentAnalysis.meaningful
          ? `intent_contract.json remains valid with ${intentAnalysis.requiredDeliverables.length} required deliverable(s)`
          : `intent_contract.json missing: ${intentAnalysis.missingCoreFields.join(", ")}`
  ), "GATE-PLN-012"));

  results.push(withFailureCode(check(
    "Required deliverables have explicit quality contracts",
    intentAnalysis.missingDeliverableContracts.length === 0 ? PASS : FAIL,
    intentAnalysis.missingDeliverableContracts.length === 0
      ? `${intentAnalysis.requiredDeliverables.length} required deliverable(s) have purpose + quality contract`
      : `Incomplete deliverable contract(s): ${intentAnalysis.missingDeliverableContracts.map((deliverable) => deliverable.id).join(", ")}`
  ), "GATE-PLN-013"));

  results.push(withFailureCode(check(
    "Required deliverables are mapped into the plan verification story",
    missingDeliverableMappings.length === 0 ? PASS : FAIL,
    missingDeliverableMappings.length === 0
      ? `${intentAnalysis.requiredDeliverables.length} required deliverable(s) referenced in plan.md`
      : `Plan does not reference deliverable(s): ${missingDeliverableMappings.map((deliverable) => deliverable.id).join(", ")}`
  ), "GATE-PLN-014"));

  results.push(withFailureCode(check(
    "Intent contract records false-green / anti-goal coverage",
    !intentRequired || hasAntiGoalCoverage ? PASS : FAIL,
    !intentRequired
      ? "Anti-goal coverage not required for this goal"
      : hasAntiGoalCoverage
        ? "Intent contract includes plan-level or deliverable-level anti-goals"
        : "Intent contract missing false-green / anti-goal coverage"
  ), "GATE-PLN-015"));

  const criterionTraceability = analyzeCriterionStoryTraceability(planContent, { workOrder, planDir, stateJson });
  results.push(withFailureCode(check(
    "Success criteria have explicit story linkage when story registry exists",
    criterionTraceability.satisfied ? PASS : FAIL,
    criterionTraceability.detail
  ), "GATE-PLN-016"));

  const goalText = stateJson?.goal || extractGoalFromPlanContent(planContent);
  const verificationObligationSynthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson,
    planContent,
  });
  const synthesisSection = analyzeVerificationObligationSynthesisSection(planContent, verificationObligationSynthesis);
  results.push(withFailureCode(check(
    "Verification Obligation Synthesis is documented for relevant plan shapes",
    synthesisSection.satisfied ? PASS : FAIL,
    synthesisSection.detail
  ), "GATE-PLN-018"));

  const verificationMatrix = analyzeContextSensitiveVerificationMatrix(planContent, goalText, planDir, stateJson, { workOrder });
  results.push(withFailureCode(check(
    "Context-sensitive verification matrix is defined for recipe/orchestration/integration-style work",
    verificationMatrix.satisfied ? PASS : FAIL,
    verificationMatrix.detail
  ), "GATE-PLN-017"));

  const semanticUpkeepContract = evaluateSemanticUpkeepContract({
    planContent,
    goalText,
    classification: classifyPlannerPreflight(goalText, {
      plannedFiles: extractFilesToModify(planContent),
      hasActivePlan: true,
      activePlanPoisoned: false,
      activePlanState: stateJson?.state || null,
      intentAnalysis: intentInfo?.parsed ? analyzeIntentContract(intentInfo.parsed, { goalText }) : null,
    }),
    plannedFiles: extractFilesToModify(planContent),
  });
  results.push(withFailureCode(check(
    "Semantic Upkeep Contract section is present in plan.md",
    semanticUpkeepContract.present ? PASS : FAIL,
    semanticUpkeepContract.present ? "Semantic Upkeep Contract section found" : semanticUpkeepContract.detail
  ), "GATE-PLN-019"));
  results.push(withFailureCode(check(
    "Task profile and semantic upkeep contract are fully documented",
    semanticUpkeepContract.complete ? PASS : FAIL,
    semanticUpkeepContract.complete
      ? `Task profile=${semanticUpkeepContract.task_profile.value}; validation bundle=${semanticUpkeepContract.validation_bundle.value}; strictness=${semanticUpkeepContract.strictness_mode}`
      : semanticUpkeepContract.detail
  ), "GATE-PLN-020"));

  if (!planningOnly) {
    const knowledgeContext = resolveKbTagKnowledgeContext({
      cwd,
      planDir,
      stateJson,
      planContent,
      goalText,
      plannedFiles: extractFilesToModify(planContent),
    });
    const kbTagObligation = analyzeKbTagObligation(planContent, knowledgeContext);
    results.push(withFailureCode(check(
      "Plan references relevant KB learnings only when a deterministic KB hit exists",
      kbTagObligation.satisfied ? PASS : FAIL,
      kbTagObligation.satisfied
        ? kbTagObligation.detail
        : `${kbTagObligation.detail}. ${kbTagObligation.guidance?.join("; ") || "Add a concrete [KB_APPLIED:<id>] marker."}`
    ), "GATE-PLN-021"));
  }

  const planLearnedObligations = resolveLearnedObligationsSignal(planDir, { phase: "plan" });
  results.push(withFailureCode(check(
    "Active PLAN-phase learned verification obligations have live structured evidence or approved waiver",
    planLearnedObligations.satisfied ? PASS : FAIL,
    planLearnedObligations.detail
  ), "GATE-PLN-038"));

  const quantPersonaGate = resolveQuantPersonaGateSignal(planDir, {
    planContent,
    stateJson,
    verificationContent,
  });
  results.push(withFailureCode(check(
    "Quant-shaped work satisfies the hard quant persona gate before EXECUTE",
    requiredExecutionOutcomeGateStatus(quantPersonaGate),
    summarizeQuantPersonaGate(quantPersonaGate)
  ), "GATE-PLN-032"));

  const quantScaleContract = evaluateOptimizationScaleContract({
    cwd,
    planDir,
    planContent,
    findingsContent: readFile(join(planDir, "findings.md")) || "",
    verificationContent,
    stateJson,
  });
  const quantScaleCompatibility = quantGateCompatibilityStatus("GATE-PLN-035", requiredExecutionOutcomeBlocks(quantScaleContract), { cwd });
  results.push(withFailureCode(check(
    "Quant Optimization Scale Contract has numeric scope content before EXECUTE",
    quantScaleCompatibility.status,
    `${summarizeOptimizationScaleContractGate(quantScaleContract)}${quantScaleCompatibility.detail_suffix}`
  ), "GATE-PLN-035"));

  const quantRunClassInflation = evaluateRunClassInflation({
    cwd,
    planDir,
    planContent,
    findingsContent: readFile(join(planDir, "findings.md")) || "",
    verificationContent,
    stateJson,
  });
  const quantRunClassCompatibility = quantGateCompatibilityStatus("GATE-PLN-036", requiredExecutionOutcomeBlocks(quantRunClassInflation), { cwd });
  results.push(withFailureCode(check(
    "Quant run class matches discovered search scale before EXECUTE",
    quantRunClassCompatibility.status,
    `${summarizeRunClassInflationGate(quantRunClassInflation)}${quantRunClassCompatibility.detail_suffix}`
  ), "GATE-PLN-036"));

  const quantLeakageArtifacts = evaluateLeakageProofArtifactRequirements({
    cwd,
    planDir,
    planContent,
    findingsContent: readFile(join(planDir, "findings.md")) || "",
    verificationContent,
    stateJson,
  });
  results.push(withFailureCode(check(
    "Quant leakage/temporal proof rows link firing negative fixtures before EXECUTE",
    requiredExecutionOutcomeGateStatus(quantLeakageArtifacts),
    summarizeLeakageProofArtifactGate(quantLeakageArtifacts)
  ), "GATE-PLN-037"));

  if (planningOnly) {
    results.push(withFailureCode(check(
      "Reuse-before-create gate checks proposed script creations",
      PASS,
      "Planning-only handoff does not enter EXECUTE; reuse-before-create is enforced for implementation plans."
    ), "GATE-PLN-033"));
  } else {
    const reuseBeforeCreate = evaluateReuseBeforeCreateGate({
      cwd,
      planDir,
      planContent,
      workOrder,
    });
    results.push(withFailureCode(check(
      "Reuse-before-create gate checks proposed script creations",
      canonicalGateStatus(reuseBeforeCreate.status),
      summarizeReuseBeforeCreateGate(reuseBeforeCreate)
    ), "GATE-PLN-033"));
  }

  if (planningOnly) {
    const knowledgeContext = resolvePlanningOnlyKnowledgeContext({
      planDir,
      stateJson,
      planContent,
      goalText,
    });

    const retroGuards = analyzePlanningOnlyRetrosSection(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans document active retros and mistake guards",
      retroGuards.satisfied ? PASS : FAIL,
      retroGuards.detail
    ), "GATE-PLN-021"));

    const retroProvenance = analyzePlanningOnlyRetroProvenance(planContent, knowledgeContext);
    results.push(withFailureCode(check(
      "Planning-only retro guards cite concrete matched sources",
      retroProvenance.satisfied ? PASS : FAIL,
      retroProvenance.detail
    ), "GATE-PLN-027"));

    const exactTestInventory = analyzePlanningOnlyExactTestInventory(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans document the exact future test inventory",
      exactTestInventory.satisfied ? PASS : FAIL,
      exactTestInventory.detail
    ), "GATE-PLN-022"));

    const exactTestSpecificity = analyzePlanningOnlyTestInventorySpecificity(planContent);
    results.push(withFailureCode(check(
      "Planning-only exact test inventory names concrete tests",
      exactTestSpecificity.satisfied ? PASS : FAIL,
      exactTestSpecificity.detail
    ), "GATE-PLN-028"));

    const redTeamReview = analyzePlanningOnlyRedTeamReview(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans include a substantive red-team review",
      redTeamReview.satisfied ? PASS : FAIL,
      redTeamReview.detail
    ), "GATE-PLN-023"));

    const redTeamProvenance = analyzePlanningOnlyRedTeamProvenance(planContent, knowledgeContext);
    results.push(withFailureCode(check(
      "Planning-only red-team review aligns with deterministic attack vectors",
      redTeamProvenance.satisfied ? PASS : FAIL,
      redTeamProvenance.detail
    ), "GATE-PLN-029"));

    const storyAudit = analyzePlanningOnlyStoryAudit(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans include a targeted story and traceability audit when stories are in play",
      storyAudit.satisfied ? PASS : FAIL,
      storyAudit.detail
    ), "GATE-PLN-024"));

    const storyAuditProvenance = analyzePlanningOnlyStoryAuditProvenance(planContent);
    results.push(withFailureCode(check(
      "Planning-only story audit cites real story ids when stories are in play",
      storyAuditProvenance.satisfied ? PASS : FAIL,
      storyAuditProvenance.detail
    ), "GATE-PLN-030"));

    const personaChallenges = analyzePlanningOnlyPersonaChallenges(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans record persona-driven challenges",
      personaChallenges.satisfied ? PASS : FAIL,
      personaChallenges.detail
    ), "GATE-PLN-025"));

    const personaExpansion = analyzePlanningOnlyPersonaExpansion(planContent);
    results.push(withFailureCode(check(
      "Planning-only plans record persona-driven expansion opportunities",
      personaExpansion.satisfied ? PASS : FAIL,
      personaExpansion.detail
    ), "GATE-PLN-026"));

    const personaProvenance = analyzePlanningOnlyPersonaProvenance(planContent, knowledgeContext);
    results.push(withFailureCode(check(
      "Planning-only persona sections stay grounded in available persona context",
      personaProvenance.satisfied ? PASS : FAIL,
      personaProvenance.detail
    ), "GATE-PLN-031"));
  }

  const stagnation = evaluateOpportunityStagnation(planDir);
  results.push(withFailureCode(check(
    "High-confidence/escalate opportunities addressed or deferred",
    stagnation.satisfied ? PASS : FAIL,
    stagnation.detail
  ), "GATE-PLN-034"));

  return results;
}

function gateExecuteToReflect(planDir, options = {}) {
  const results = [];
  const redTeamPath = join(planDir, "red_team_notes.md");
  const redTeamContent = readFile(redTeamPath);
  const redTeamAnalysis = analyzeRedTeamNotes(redTeamContent);
  const progressPath = join(planDir, "progress.md");
  const progressContent = readFile(progressPath);

  // 1. Red-team notes artifact exists
  const exists = fileExists(redTeamPath);
  results.push(withFailureCode(check(
    "Adversarial red-team notes artifact exists",
    exists ? PASS : FAIL,
    exists ? "red_team_notes.md found" : "red_team_notes.md missing — document 3 attack vectors before transitioning to REFLECT"
  ), "GATE-ETR-001"));

  // 2. Red-team notes not empty
  const notEmpty = exists && fileNotEmpty(redTeamPath);
  results.push(withFailureCode(check(
    "Red-team notes contain analysis",
    notEmpty ? PASS : FAIL,
    notEmpty ? "Red-team notes have content" : "red_team_notes.md is empty or missing"
  ), "GATE-ETR-002"));

  // 3. At least 3 attack vectors (## headings)
  const vectorCount = redTeamAnalysis.vectorCount;
  results.push(withFailureCode(check(
    "At least 3 attack vectors documented",
    vectorCount >= 3 ? PASS : FAIL,
    `Found ${vectorCount} attack vector heading(s) — minimum 3 required`
  ), "GATE-ETR-003"));

  // 4. Mitigations documented (promoted to FAIL)
  const missingMitigationVectors = redTeamAnalysis.vectors
    .map((vector, index) => ({ vector, index }))
    .filter(({ vector }) => !vector.hasMitigation);
  const hasMitigations = vectorCount > 0 && missingMitigationVectors.length === 0;
  results.push(withFailureCode(check(
    "Mitigations documented for attack vectors",
    hasMitigations ? PASS : FAIL,
    hasMitigations
      ? `Mitigation section found in all ${vectorCount} vector(s)`
      : `Missing Mitigation section in ${missingMitigationVectors.map(({ vector, index }) => vector.rawTitle || `Vector ${index + 1}`).join(", ")}`
  ), "GATE-ETR-004"));

  // 4b. RT-006: Red-team content depth — vectors must have substance, not just headings
  if (redTeamContent && vectorCount >= 3) {
    const shallowVectors = redTeamAnalysis.vectors
      .map((vector, index) => ({ vector, index }))
      .filter(({ vector }) => !vector.substantive);
    const hasVectorDepth = shallowVectors.length === 0;
    const shallowDetail = shallowVectors
      .slice(0, 3)
      .map(({ vector, index }) => {
        const name = vector.rawTitle || `Vector ${index + 1}`;
        const reason = vector.issues.length > 0
          ? vector.issues.join("; ")
          : "needs more substantive Attack/Impact/Mitigation content";
        return `${name}: ${reason}`;
      })
      .join(" | ");
    results.push(withFailureCode(check(
      "Red-team vectors have content depth (Attack + Impact + Mitigation)",
      hasVectorDepth ? PASS : FAIL,
      hasVectorDepth
        ? `${redTeamAnalysis.substantiveVectors} vectors with substantive analysis`
        : `${shallowVectors.length} shallow vector(s) — ${shallowDetail}. Accepted labels: Attack:, **Attack**:, or heading-style Attack sections.`
    ), "GATE-ETR-008"));
  }

  // 5. Progress has completed work
  const completedCount = countCompletedProgressItems(progressContent);
  const hasCompleted = completedCount > 0;
  results.push(withFailureCode(check(
    "At least one completed item in progress.md",
    hasCompleted ? PASS : WARN,
    hasCompleted ? `${completedCount} completed item(s) found` : "No completed items in progress.md"
  ), "GATE-ETR-005"));

  // 6. Test drift scan documented (Rule 2 — added v3.8.0)
  // Agents must document a test-drift scan in verification.md before transitioning to REFLECT.
  // Projects without a test suite should write "N/A — no tests" to satisfy this check.
  const verificationPath = join(planDir, "verification.md");
  const verificationContent = readFile(verificationPath);
  const hasTestDrift = containsString(verificationContent, "Test Drift") ||
                       containsString(verificationContent, "test drift");
  results.push(withFailureCode(check(
    "Test drift scan documented in verification.md",
    hasTestDrift ? PASS : WARN,
    hasTestDrift
      ? "Test drift scan found"
      : "No test drift scan documented — add '## Test Drift Scan' to verification.md or write 'N/A — no tests'"
  ), "GATE-ETR-009"));

  const semanticSubstrate = resolveSemanticSubstrateSignal(planDir);
  const semanticSubstrateWarn = (semanticSubstrate.required && semanticSubstrate.advisory_gap_ids.length > 0) ||
    semanticSubstrate.scope_degraded ||
    resolveWeakSemanticSubstrateDomains(semanticSubstrate).length > 0;
  results.push(withFailureCode(check(
    "Task-relevant semantic substrate gaps are surfaced before REFLECT",
    semanticSubstrateWarn ? WARN : PASS,
    semanticSubstrateWarn
      ? formatSemanticSubstrateAdvisoryDetail(semanticSubstrate)
      : semanticSubstrate.detail
  ), "GATE-ETR-010"));

  const quantPersonaGate = resolveQuantPersonaGateSignal(planDir, {
    verificationContent,
    redTeamContent,
  });
  results.push(withFailureCode(check(
    "Quant-shaped work preserves the hard quant persona gate before REFLECT",
    requiredExecutionOutcomeGateStatus(quantPersonaGate),
    summarizeQuantPersonaGate(quantPersonaGate)
  ), "GATE-ETR-011"));

  const executedTestEvidence = resolveExecutedTestEvidenceSignal(
    planDir,
    "execute-to-reflect",
    options.executedTestEvidence,
  );
  if (executedTestEvidence.present) {
    results.push(withFailureCode(check(
      "Executed test baseline gate passed before REFLECT",
      executedTestEvidence.satisfied ? PASS : FAIL,
      executedTestEvidence.detail
    ), "GATE-ETR-012"));
  }

  return results;
}

function gateReflectToValidate(planDir) {
  const results = [];
  const reflectionSignal = resolveReflectionSignal(planDir);
  const progressPath = join(planDir, "progress.md");
  const progressContent = readFile(progressPath);

  results.push(withFailureCode(check(
    "Reflection verdicts are recorded",
    reflectionSignal.present ? PASS : FAIL,
    reflectionSignal.present ? "reflection.md found" : reflectionSignal.detail
  ), "GATE-REF-001"));

  results.push(withFailureCode(check(
    "Reflection verdicts support moving into VALIDATE",
    reflectionSignal.satisfied ? PASS : FAIL,
    reflectionSignal.detail
  ), "GATE-REF-002"));

  const progressSignal = resolveProgressSignal(planDir, progressContent);
  results.push(withFailureCode(check(
    "No uncompleted items remain before VALIDATE",
    progressSignal.satisfied ? PASS : FAIL,
    progressSignal.detail
  ), "GATE-REF-003"));

  results.push(withFailureCode(check(
    "No substantive unfinished work remains before VALIDATE",
    progressSignal.blockingSatisfied ? PASS : FAIL,
    progressSignal.blockingSatisfied
      ? "No blocking progress items remain"
      : `${progressSignal.blockingOpenItems.length || 1} substantive blocking progress item(s) remain`
  ), "GATE-REF-021"));

  const kbSignal = resolveKBSignal(planDir);
  results.push(withFailureCode(check(
    "Knowledge base/semantic record is updated before VALIDATE",
    kbSignal.satisfied ? PASS : FAIL,
    kbSignal.detail
  ), "GATE-REF-004"));

  const semanticSubstrate = resolveSemanticSubstrateSignal(planDir);
  results.push(withFailureCode(check(
    "Task-relevant semantic substrate is complete enough for VALIDATE",
    semanticSubstrate.satisfied ? PASS : FAIL,
    semanticSubstrate.satisfied
      ? semanticSubstrate.detail
      : (semanticSubstrate.detail || `Relevant semantic substrate gaps remain: ${semanticSubstrate.blocking_gap_ids.join(", ")}`)
  ), "GATE-REF-016"));

  const quantResultsValidation = resolveQuantResultsValidationSignal(planDir);
  results.push(withFailureCode(check(
    "Quant/model/betting result claims have machine-readable validation before VALIDATE",
    quantResultsValidation.satisfied ? PASS : FAIL,
    quantResultsValidation.detail
  ), "GATE-REF-017"));

  const quantPersonaGate = resolveQuantPersonaGateSignal(planDir, {
    reflectionContent: readFile(join(planDir, "reflection.md")),
  });
  results.push(withFailureCode(check(
    "Quant-shaped work preserves the hard quant persona gate before VALIDATE",
    requiredExecutionOutcomeGateStatus(quantPersonaGate),
    summarizeQuantPersonaGate(quantPersonaGate)
  ), "GATE-REF-018"));

  const recipePromotion = resolveRecipePromotionSignal(planDir);
  results.push(withFailureCode(check(
    "Repeatable operational flows have recipe-promotion disposition before VALIDATE",
    recipePromotion.satisfied ? PASS : WARN,
    recipePromotion.detail
  ), "GATE-REF-019"));

  const novelInsightFloor = evaluateNovelInsightFloor({ planDir, cwd });
  results.push(withFailureCode(check(
    "Novel insight floor is satisfied or waived before VALIDATE",
    requiredExecutionOutcomeGateStatus(novelInsightFloor, { waiverPasses: true }),
    novelInsightFloor.detail
  ), "GATE-REF-020"));

  return results;
}

function gateValidateToClose(planDir, options = {}) {
  const results = [];
  const verificationPath = join(planDir, "verification.md");
  const verificationContent = readFile(verificationPath);
  const planContent = readFile(join(planDir, "plan.md"));

  const presentationTruth = deriveVerificationPresentationTruth(verificationContent || "");
  const verificationTruth = deriveVerificationTruth({
    cwd,
    planDir,
    planContent,
    verificationContent,
  });
  const hasResults = verificationContent &&
    !containsString(verificationContent, "To be populated during PLAN") &&
    presentationTruth.structuredResultsRecorded &&
    verificationTruth.resultsRecorded;
  const verificationPasses = hasResults && verificationTruth.allVerificationPass;
  const presentationDetails = presentationTruth.details;
  const unsupportedModeDetails = Array.isArray(verificationTruth.unsupportedModes) && verificationTruth.unsupportedModes.length > 0
    ? [`unsupported_verification_modes:${verificationTruth.unsupportedModes.join(",")}`]
    : [];
  results.push(withFailureCode(check(
    "Verification results recorded",
    verificationPasses ? PASS : FAIL,
    verificationPasses
      ? "Structured verification results use configured passing forms"
      : [
          hasResults ? "Structured verification results include invalid or non-passing truth" : "Verification still template or has no structured results",
          ...presentationDetails,
          ...unsupportedModeDetails,
          presentationResultGuidance(),
        ].join("; ")
  ), "GATE-VAL-001"));

  const hasUnverified = containsString(verificationContent, "UNVERIFIED: Requires manual user validation");
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = verificationContent ? verificationContent.match(codeBlockRegex) || [] : [];
  const nonEmptyCodeBlocks = codeBlocks.filter((block) => {
    const inner = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    return inner.length > 10;
  });
  const hasProof = hasUnverified || nonEmptyCodeBlocks.length > 0;
  results.push(withFailureCode(check(
    "Proof of Work present",
    hasProof ? PASS : FAIL,
    hasProof
      ? (hasUnverified ? "Explicitly marked unverified (User Action Required)" : `${nonEmptyCodeBlocks.length} non-empty code block(s) with command output`)
      : "No command outputs pasted (empty code blocks don't count) and not explicitly marked UNVERIFIED"
  ), "GATE-VAL-002"));

  const baselinePath = join(planDir, "baseline.json");
  if (fileExists(baselinePath)) {
    results.push(withFailureCode(check(
      "Test baseline captured",
      PASS,
      "baseline.json exists — run test_baseline.mjs verify to check delta"
    ), "GATE-VAL-005"));
  }

  const hasRegressionAudit = containsString(verificationContent, "Regression") ||
    containsString(verificationContent, "regression");
  results.push(withFailureCode(check(
    "Regression audit documented in verification.md",
    hasRegressionAudit ? PASS : WARN,
    hasRegressionAudit
      ? "Regression audit evidence found"
      : "No regression audit documented — add '## Regression Audit' to verification.md or write 'N/A — no baseline'"
  ), "GATE-VAL-009"));

  const plannerCoreMigration = resolvePlannerCoreSignal(planDir);
  results.push(withFailureCode(check(
    "Planner-core self-proof satisfied",
    plannerCoreMigration.satisfied ? PASS : FAIL,
    plannerCoreMigration.detail
  ), "GATE-VAL-010"));

  const testEvidence = resolveTestEvidenceSignal(
    planDir,
    "validate-to-close",
    options.executedTestEvidence,
  );
  results.push(withFailureCode(check(
    "Code changes have test evidence or approved waiver",
    testEvidence.satisfied ? PASS : FAIL,
    testEvidence.detail
  ), "GATE-VAL-011"));

  const dirtyProofArtifacts = evaluateDirtyInputProofArtifacts({
    cwd: process.cwd(),
    verificationContent,
    scopeFiles: extractFilesToModify(planContent),
  });
  const dirtyArtifactStatus = dirtyProofArtifacts.dirty_input_artifact_count > 0 ? WARN : PASS;
  const dirtyArtifactDetail = dirtyProofArtifacts.dirty_input_artifact_count > 0
    ? `${dirtyProofArtifacts.dirty_input_artifact_count} stamped proof artifact(s) cite dirty files intersecting plan scope: ${dirtyProofArtifacts.intersections.map((entry) => `${entry.artifact_path}${entry.line ? `:${entry.line}` : ""} -> ${entry.dirty_files.slice(0, 5).join(", ")}`).join("; ")}`
    : dirtyProofArtifacts.stamped_artifact_count > 0
      ? `${dirtyProofArtifacts.stamped_artifact_count} stamped proof artifact(s) cited; none intersect declared plan scope dirty files.`
      : "No stamped proof artifacts cited in verification.md.";
  results.push(check(
    "Stamped proof artifacts dirty-input advisory",
    dirtyArtifactStatus,
    dirtyArtifactDetail
  ));

  const intentEvidence = resolveIntentEvidenceSignal(planDir);
  results.push(withFailureCode(check(
    "Required deliverables have substantive evidence or approved waiver",
    intentEvidence.satisfied ? PASS : FAIL,
    intentEvidence.detail
  ), "GATE-VAL-012"));

  const antiRecurrence = resolveAntiRecurrenceSignal(planDir);
  results.push(withFailureCode(check(
    "Remediation work records an anti-recurrence guard or approved waiver",
    antiRecurrence.satisfied ? PASS : FAIL,
    antiRecurrence.detail
  ), "GATE-VAL-013"));

  const learnedObligations = resolveLearnedObligationsSignal(planDir);
  results.push(withFailureCode(check(
    "Active learned verification obligations have evidence or approved waiver",
    learnedObligations.satisfied ? PASS : FAIL,
    learnedObligations.detail
  ), "GATE-VAL-014"));

  const sessionObligations = resolveSessionObligationsSignal(planDir);
  results.push(withFailureCode(check(
    "Load-bearing assumptions resolved",
    sessionObligations.satisfied ? PASS : FAIL,
    sessionObligations.detail
  ), "GATE-VAL-019"));

  const verificationObligationSynthesis = resolveVerificationObligationSynthesisSignal(planDir);
  results.push(withFailureCode(check(
    "Synthesized verification obligations have required systems-exercised, residual-risk, and sufficiency reporting",
    verificationObligationSynthesis.satisfied ? PASS : FAIL,
    verificationObligationSynthesis.detail
  ), "GATE-VAL-015"));

  const quantResultsValidation = resolveQuantResultsValidationSignal(planDir);
  results.push(withFailureCode(check(
    "Quant/model/betting result claims have machine-readable validation before close",
    quantResultsValidation.satisfied ? PASS : FAIL,
    quantResultsValidation.detail
  ), "GATE-VAL-016"));

  const quantPersonaGate = resolveQuantPersonaGateSignal(planDir, {
    verificationContent,
  });
  results.push(withFailureCode(check(
    "Quant-shaped work preserves the hard quant persona gate before close",
    requiredExecutionOutcomeGateStatus(quantPersonaGate),
    summarizeQuantPersonaGate(quantPersonaGate)
  ), "GATE-VAL-017"));

  const reviewIntake = resolveReviewIntakeSignal(planDir);
  results.push(withFailureCode(check(
    "Required review-intake findings have a valid disposition before close",
    reviewIntake.satisfied ? PASS : FAIL,
    reviewIntake.detail
  ), "GATE-VAL-018"));

  const recipePromotion = resolveRecipePromotionSignal(planDir);
  results.push(withFailureCode(check(
    "Repeatable operational flows have recipe-promotion disposition before close",
    recipePromotion.satisfied ? PASS : WARN,
    recipePromotion.detail
  ), "GATE-VAL-021"));

  const incidentCloseout = evaluateIncidentCloseout({ cwd, planDir, verificationContent });
  results.push(withFailureCode(check(
    "Incident repair closeout is fail-closed when an incident contract is required",
    incidentCloseout.satisfied ? PASS : FAIL,
    summarizeIncidentCloseout(incidentCloseout)
  ), "GATE-VAL-022"));

  const avaGate = resolveAvaGateSignal(planDir);
  results.push(withFailureCode(check(
    "AVA-discovered defects are resolved and anchored before close",
    avaGate.satisfied ? PASS : FAIL,
    avaGate.required
      ? avaGate.detail
      : "No AVA defect artifact present"
  ), "GATE-VAL-020"));

  const stagnation = evaluateOpportunityStagnation(planDir);
  results.push(withFailureCode(check(
    "High-confidence/escalate opportunities addressed or deferred before close",
    stagnation.satisfied ? PASS : FAIL,
    stagnation.detail
  ), "GATE-VAL-023"));

  return results;
}

function gateReflectToCloseLegacy(planDir) {
  const results = [];
  const verificationPath = join(planDir, "verification.md");
  const verificationContent = readFile(verificationPath);
  const progressPath = join(planDir, "progress.md");
  const progressContent = readFile(progressPath);

  const presentationTruth = deriveVerificationPresentationTruth(verificationContent || "");
  const verificationTruth = deriveVerificationTruth({
    cwd,
    planDir,
    planContent: readFile(join(planDir, "plan.md")),
    verificationContent,
  });
  const hasResults = verificationContent &&
    !containsString(verificationContent, "To be populated during PLAN") &&
    presentationTruth.structuredResultsRecorded &&
    verificationTruth.resultsRecorded;
  const verificationPasses = hasResults && verificationTruth.allVerificationPass;
  results.push(withFailureCode(check(
    "Verification results recorded",
    verificationPasses ? PASS : FAIL,
    verificationPasses
      ? "Structured verification results use configured passing forms"
      : "Verification still template, has no structured results, or contains invalid/non-passing truth"
  ), "GATE-VAL-001"));

  const hasUnverified = containsString(verificationContent, "UNVERIFIED: Requires manual user validation");
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = verificationContent ? verificationContent.match(codeBlockRegex) || [] : [];
  const nonEmptyCodeBlocks = codeBlocks.filter((block) => {
    const inner = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    return inner.length > 10;
  });
  const hasProof = hasUnverified || nonEmptyCodeBlocks.length > 0;
  results.push(withFailureCode(check(
    "Proof of Work present",
    hasProof ? PASS : FAIL,
    hasProof
      ? (hasUnverified ? "Explicitly marked unverified (User Action Required)" : `${nonEmptyCodeBlocks.length} non-empty code block(s) with command output`)
      : "No command outputs pasted (empty code blocks don't count) and not explicitly marked UNVERIFIED"
  ), "GATE-VAL-002"));

  const progressSignal = resolveProgressSignal(planDir, progressContent);
  results.push(withFailureCode(check(
    "No uncompleted items in progress.md",
    progressSignal.satisfied ? PASS : WARN,
    progressSignal.detail
  ), "GATE-REF-003"));

  const kbSignal = resolveKBSignal(planDir);
  results.push(withFailureCode(check(
    "Knowledge base updated (or 'no new learnings' noted)",
    kbSignal.satisfied ? PASS : FAIL,
    kbSignal.detail
  ), "GATE-REF-004"));

  const baselinePath = join(planDir, "baseline.json");
  if (fileExists(baselinePath)) {
    results.push(withFailureCode(check(
      "Test baseline captured",
      PASS,
      "baseline.json exists — run test_baseline.mjs verify to check delta"
    ), "GATE-VAL-005"));
  }

  const hasRegressionAudit = containsString(verificationContent, "Regression") ||
    containsString(verificationContent, "regression");
  results.push(withFailureCode(check(
    "Regression audit documented in verification.md",
    hasRegressionAudit ? PASS : WARN,
    hasRegressionAudit
      ? "Regression audit evidence found"
      : "No regression audit documented — add '## Regression Audit' to verification.md or write 'N/A — no baseline'"
  ), "GATE-VAL-009"));

  const plannerCoreMigration = resolvePlannerCoreSignal(planDir);
  results.push(withFailureCode(check(
    "Planner-core self-proof satisfied",
    plannerCoreMigration.satisfied ? PASS : FAIL,
    plannerCoreMigration.detail
  ), "GATE-VAL-010"));

  const testEvidence = resolveTestEvidenceSignal(planDir);
  results.push(withFailureCode(check(
    "Code changes have test evidence or approved waiver",
    testEvidence.satisfied ? PASS : FAIL,
    testEvidence.detail
  ), "GATE-VAL-011"));

  const intentEvidence = resolveIntentEvidenceSignal(planDir);
  results.push(withFailureCode(check(
    "Required deliverables have substantive evidence or approved waiver",
    intentEvidence.satisfied ? PASS : FAIL,
    intentEvidence.detail
  ), "GATE-VAL-012"));

  const antiRecurrence = resolveAntiRecurrenceSignal(planDir);
  results.push(withFailureCode(check(
    "Remediation work records an anti-recurrence guard or approved waiver",
    antiRecurrence.satisfied ? PASS : FAIL,
    antiRecurrence.detail
  ), "GATE-VAL-013"));

  const learnedObligations = resolveLearnedObligationsSignal(planDir);
  results.push(withFailureCode(check(
    "Active learned verification obligations have evidence or approved waiver",
    learnedObligations.satisfied ? PASS : FAIL,
    learnedObligations.detail
  ), "GATE-VAL-014"));

  const verificationObligationSynthesis = resolveVerificationObligationSynthesisSignal(planDir);
  results.push(withFailureCode(check(
    "Synthesized verification obligations have required systems-exercised, residual-risk, and sufficiency reporting",
    verificationObligationSynthesis.satisfied ? PASS : FAIL,
    verificationObligationSynthesis.detail
  ), "GATE-VAL-015"));

  const quantResultsValidation = resolveQuantResultsValidationSignal(planDir);
  results.push(withFailureCode(check(
    "Quant/model/betting result claims have machine-readable validation before close",
    quantResultsValidation.satisfied ? PASS : FAIL,
    quantResultsValidation.detail
  ), "GATE-VAL-016"));

  const quantPersonaGate = resolveQuantPersonaGateSignal(planDir, {
    verificationContent,
  });
  results.push(withFailureCode(check(
    "Quant-shaped work preserves the hard quant persona gate before close",
    requiredExecutionOutcomeGateStatus(quantPersonaGate),
    summarizeQuantPersonaGate(quantPersonaGate)
  ), "GATE-VAL-017"));

  const reviewIntake = resolveReviewIntakeSignal(planDir);
  results.push(withFailureCode(check(
    "Required review-intake findings have a valid disposition before close",
    reviewIntake.satisfied ? PASS : FAIL,
    reviewIntake.detail
  ), "GATE-VAL-018"));

  const semanticSubstrate = resolveSemanticSubstrateSignal(planDir);
  results.push(withFailureCode(check(
    "Task-relevant semantic substrate is complete enough to close",
    semanticSubstrate.satisfied ? PASS : FAIL,
    semanticSubstrate.satisfied
      ? semanticSubstrate.detail
      : (semanticSubstrate.detail || `Relevant semantic substrate gaps remain: ${semanticSubstrate.blocking_gap_ids.join(", ")}`)
  ), "GATE-REF-016"));

  return results;
}

function gateNotifyUser(planDir) {
  const results = [];

  // 1. KB Notification Gate
  const kbSignal = resolveKBSignal(planDir);
  results.push(withFailureCode(check(
    "Knowledge Base Notification Gate satisfied",
    kbSignal.satisfied ? PASS : FAIL,
    kbSignal.detail
  ), "GATE-NTF-001"));

  // 2. Summary exists (walkthrough.md retired in phase 4 of ritual elimination)
  const summaryPath = join(planDir, "summary.md");
  const hasSummary = fileExists(summaryPath) && fileNotEmpty(summaryPath);
  results.push(withFailureCode(check(
    "Summary written",
    hasSummary ? PASS : WARN,
    hasSummary ? "summary.md found" : "No summary.md — write one before closing"
  ), "GATE-NTF-002"));

  // 3. State is CLOSE or VALIDATE — AV-10: state.md fallback REMOVED.
  // LLMs can edit state.md to fake current state, bypassing source-state checks (AV-6).
  // Only state.json is trusted as canonical state source.
  let currentState = null;
  const stateJson = readStateJson(planDir);
  if (stateJson?.state) {
    currentState = stateJson.state;
  }
  const validState = currentState && (currentState.includes("CLOSE") || currentState.includes("VALIDATE"));
  results.push(withFailureCode(check(
    "Plan state is CLOSE or VALIDATE",
    validState ? PASS : WARN,
    validState ? `State: ${currentState}` : `State: ${currentState || "UNKNOWN"} — expected CLOSE or VALIDATE`
  ), "GATE-NTF-003"));

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const GATES = {
  "explore-to-plan": gateExploreToPlan,
  "plan-to-execute": gatePlanToExecute,
  "execute-to-reflect": gateExecuteToReflect,
  "reflect-to-validate": gateReflectToValidate,
  "validate-to-close": gateValidateToClose,
  "reflect-to-close": gateReflectToCloseLegacy,
  "notify-user": gateNotifyUser,
};

export function mistakeHookTargetIntegrityResult(missingHookTargets = []) {
  const missing = Array.isArray(missingHookTargets) ? missingHookTargets : [];
  return withFailureCode(check(
    "Active mistake verification hooks resolve to existing test targets",
    missing.length === 0 ? PASS : FAIL,
    missing.length === 0
      ? "All test-shaped hooks in the base registry and active/approved overlays resolve"
      : missing
          .map((entry) => `mistake_verification_hook_target_missing(${entry.mistake_id}, ${entry.hook}) -> ${entry.target_path}`)
          .join("; "),
  ), "GATE-MST-001");
}

function evaluateGateResults(planDir, gateName, options = {}) {
  const gateFn = GATES[gateName];
  const previousCloseSignals = transientCloseSignals;
  transientCloseSignals = options.refreshSnapshot?.closeSignals || null;
  try {
    const registry = loadMistakeRegistry({ cwd });
    const hookTargetIntegrity = mistakeHookTargetIntegrityResult(registry.missing_hook_targets);
    const baseResults = [hookTargetIntegrity, ...(gateFn ? gateFn(planDir, options) : [])];
    const antiRitual = resolveLatePhaseAntiRitualAssessment(planDir, gateName);
    const results = normalizeLatePhaseGateResults(baseResults, antiRitual);
    return {
      results,
      anti_ritual: antiRitual,
    };
  } finally {
    transientCloseSignals = previousCloseSignals;
  }
}

// Export for programmatic use by transition.mjs
export { GATES, evaluateGateResults, buildGateRepairPacket, gateExploreToPlan, gatePlanToExecute, gateExecuteToReflect, gateReflectToValidate, gateValidateToClose, gateReflectToCloseLegacy, gateNotifyUser };

function printUsage() {
  console.log(`Usage: node verify_gate.mjs <gate> [--plan <plan-dir>] [--planning-only]

Ordinary CLI use delegates to transition.mjs <gate> --dry-run, the authoritative
transition preflight. --planning-only retains the scoped plan-content diagnostic.

Gates:
  explore-to-plan     Check EXPLORE → PLAN transition requirements
  plan-to-execute     Check PLAN → EXECUTE transition requirements (use --planning-only with --plan for /safe-plan quality validation)
  execute-to-reflect  Check EXECUTE → REFLECT transition requirements (red-team gate)
  reflect-to-validate Check REFLECT → VALIDATE transition requirements
  validate-to-close   Check VALIDATE → CLOSE transition requirements
  reflect-to-close    Legacy compatibility close-readiness check (not part of the canonical transition chain)
  notify-user         Check KB Notification Gate before presenting results

Reads from an explicit target plan, thread-local target, or plans/.current_plan.
Exit code 0 = all checks PASS, 1 = any FAIL.
WARN items do not cause failure.`);
}

// CLI entry point — only runs when executed directly (not when imported)
import { resolve as _resolve } from "path";
import { fileURLToPath as _fileURLToPath } from "url";
const __verify_gate_file = _resolve(process.argv[1] || "");
const __this_file = _fileURLToPath(import.meta.url);
const __verify_gate_entry = existsSync(__verify_gate_file) ? realpathSync(__verify_gate_file) : __verify_gate_file;
const __verify_gate_target = existsSync(__this_file) ? realpathSync(__this_file) : __this_file;
if (__verify_gate_entry === __verify_gate_target) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printUsage();
    process.exit(0);
  }

  const gateName = args[0];
  let planOverride = null;
  let planningOnly = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--plan") {
      planOverride = args[i + 1] || null;
      i++;
      continue;
    }
    if (args[i] === "--planning-only") planningOnly = true;
  }
  if (!GATES[gateName]) {
    console.error(`ERROR: Unknown gate "${gateName}". Use --help for available gates.`);
    process.exit(1);
  }

  const legacyDiagnostic = gateName === "reflect-to-close";
  if (!planningOnly && !legacyDiagnostic) {
    const transitionScript = _fileURLToPath(new URL("./transition.mjs", import.meta.url));
    const delegatedArgs = [transitionScript, gateName, "--dry-run"];
    if (planOverride) delegatedArgs.push("--plan", planOverride);
    console.log(`Delegating authoritative preflight: node ${delegatedArgs.join(" ")}\n`);
    const delegated = spawnSync(process.execPath, delegatedArgs, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    process.exit(delegated.status ?? 2);
  }
  if (legacyDiagnostic) {
    console.log("DIAGNOSTIC ONLY — reflect-to-close is a legacy compatibility check, not a transition predictor.\n");
  }

  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planOverride });
  const { planDirName, planDir } = target;
  if (!planDirName) {
    console.error("ERROR: No target plan. Create one with bootstrap.mjs first or pass --plan.");
    if (planningOnly && gateName === "plan-to-execute") {
      console.error("  planning-only validation now requires a plan spine; root-level task.md + implementation_plan.md is no longer accepted.");
    }
    process.exit(1);
  }

  const plannerEnvScope = captureEnvValues(["_PLANNER_PLAN_TARGET"]);
  process.env._PLANNER_PLAN_TARGET = planDirName;
  try {
  // Build a transient same-invocation snapshot for both JavaScript and Prolog.
  // Standalone verification is a preflight and must not rewrite planner evidence.
  let refreshSnapshot = null;
  if (!process.env._PLANNER_FAST_VERIFY) {
    try {
      refreshSnapshot = refreshPlanArtifacts({
        cwd,
        planDirName,
        gateName,
        persistState: false,
        persistOntology: false,
        syncFindings: false,
        backfillScaffold: false,
      });
    } catch (e) {
      debugLog("verify_gate", `Plan refresh failed before ${gateName}: ${e.message}`);
    }
  }
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  const gateLabel = planningOnly && gateName === "plan-to-execute"
    ? `${gateName} [planning-only]`
    : gateName;
  console.log(`║  GATE CHECK: ${gateLabel.padEnd(40)}║`);
  console.log(`║  Plan: ${planDirName.padEnd(45)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  if (target.source && target.source !== "pointer") {
    console.log(`  Target source: ${target.source}`);
    const pointerPlanDirName = readPointer(plansDir);
    if (pointerPlanDirName && pointerPlanDirName !== planDirName) {
      console.log(`  Pointer: plans/.current_plan → ${pointerPlanDirName}`);
    }
    console.log();
  }

  // RT-AUDIT-M3: Source-state validation in standalone mode.
  // Without this, an LLM could run verify_gate.mjs for any gate regardless of
  // actual plan state. We warn (not block) since verify_gate is read-only.
  const GATE_SOURCE_STATES = {
    "explore-to-plan": ["EXPLORE"],
    "plan-to-execute": ["PLAN"],
    "execute-to-reflect": ["EXECUTE"],
    "reflect-to-validate": ["REFLECT"],
    "validate-to-close": ["VALIDATE"],
    "reflect-to-close": ["REFLECT", "VALIDATE"],
    "notify-user": ["CLOSE", "VALIDATE"],
  };
  const GATE_TARGET_STATES = {
    "explore-to-plan": "PLAN",
    "plan-to-execute": "EXECUTE",
    "execute-to-reflect": "REFLECT",
    "reflect-to-validate": "VALIDATE",
    "validate-to-close": "CLOSE",
    "reflect-to-close": "CLOSE",
  };
  let staleGateAlreadyPassed = false;
  const expectedStates = GATE_SOURCE_STATES[gateName];
  if (expectedStates) {
    const stateJsonStandalone = readStateJson(planDir);
    const currentState = stateJsonStandalone?.state;
    if (currentState && !expectedStates.includes(currentState)) {
      console.log(`  ⚠️  [WARN] Current state is ${currentState}, but ${gateName} expects [${expectedStates.join("|")}]`);
      const targetState = GATE_TARGET_STATES[gateName];
      const passedTransition = (stateJsonStandalone?.transitions || [])
        .slice()
        .reverse()
        .find((entry) =>
          verificationStatusIsPass(entry?.gate_result, "gate") &&
          expectedStates.includes(entry?.from) &&
          (!targetState || entry?.to === targetState)
      );
      if (passedTransition) {
        staleGateAlreadyPassed = true;
        console.log(`          This gate already passed at ${passedTransition.timestamp}; use the current phase's next gate for transition readiness.`);
        if (gateName === "plan-to-execute") {
          console.log(`          For plan-content diagnostics, run: node .agent/skills/iterative-planner/scripts/verification_matrix.mjs lint --plan ${planDirName} --json`);
        }
      } else {
        console.log(`          Results may not reflect actual transition readiness.`);
      }
      console.log();
    }
  }

  const evaluation = evaluateGateResults(planDir, gateName, { planningOnly, refreshSnapshot });
  const jsResults = evaluation.results;
  const registeredGates = new Set(Object.keys(loadGateRegistry().gates));
  const semanticResults = !planningOnly && registeredGates.has(gateName)
    ? runSemanticChecks(gateName, planDir, { refreshSnapshot, transientRegistryRefresh: true })
    : [];
  const jsGateBlocked = jsResults.some(gateResultBlocks);
  const parityResults = classifySemanticDivergence({
    jsGateBlocked,
    semanticResults,
    enforcePrologDivergence: isFeatureEnabled("prolog_enforce_mode"),
  });
  const results = [...jsResults, ...semanticResults, ...parityResults];
  let hasFail = false;

  for (const r of results) {
    const icon = verificationStatusIsPass(r.status, "gate") ? "✅" : gateResultBlocks(r) ? "❌" : "⚠️";
    const codeStr = r.code ? ` [${r.code}]` : "";
    console.log(`  ${icon} [${r.status}]${codeStr} ${r.name}`);
    if (r.detail) {
      console.log(`          ${r.detail}`);
    }
    if (gateResultBlocks(r)) hasFail = true;
  }

  if (evaluation.anti_ritual?.status && evaluation.anti_ritual.status !== "clean") {
    console.log();
    console.log(`  ↳ anti_ritual: ${evaluation.anti_ritual.status} (${evaluation.anti_ritual.recommended_action})`);
    console.log(`          ${evaluation.anti_ritual.detail}`);
  }

  console.log();
  if (hasFail || staleGateAlreadyPassed) {
    const repairPacket = buildGateRepairPacket({ planDir, planDirName, gateName, results, planningOnly });
    if (repairPacket.length > 0) {
      console.log(`  -- Repair Surface --`);
      for (const line of repairPacket) {
        console.log(`  ${line}`);
      }
      console.log();
    }
    if (staleGateAlreadyPassed && !hasFail) {
      console.log(`  ══ RESULT: ⚠️ STALE GATE — this gate already passed; use the current phase's next gate for transition readiness ══`);
    } else {
      console.log(`  ══ RESULT: ❌ BLOCKED — fix FAIL items before transitioning ══`);
    }
    process.exitCode = 1;
  } else {
    console.log(`  ══ RESULT: ✅ GATE PASSED — transition allowed ══`);
    process.exitCode = 0;
  }
  } finally {
    restoreEnvValues(plannerEnvScope);
  }
}
