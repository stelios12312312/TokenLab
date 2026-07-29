import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";

import { buildTaskContext } from "../ontology_context.mjs";
import { evaluateThrashingDetector } from "../thrashing_detector.mjs";
import { checkPlanConventions } from "./convention_checks.mjs";
import { listPlanStructuredTestRuns, verifyPlanEvidence } from "./evidence_verifier.mjs";
import { loadOntologyRuntime } from "./ontology_runtime.mjs";
import {
  computeMistakeRegistrySignal,
  extractGoalText,
  loadPlanMatchContext,
} from "./mistake_registry.mjs";
import { extractFilesToModify, extractMarkdownSection } from "./plan_utils.mjs";
import { readEffectiveVerificationStrategy } from "./verification_strategy.mjs";

export const REFLECTION_GUIDE_FILENAME = "reflection_guide.yaml";
export const REFLECTION_GUIDE_VERSION = 1;

export const REFLECTION_GUIDE_SECTION_ORDER = Object.freeze([
  "plan_vs_progress",
  "applicable_kb",
  "relevant_retros",
  "edge_case_coverage",
  "pattern_application_check",
  "process_signals",
  "proof_weight_audit",
  "next_time_candidates",
  "convention_application_check",
]);

export const REFLECTION_GUIDE_SECTION_TITLES = Object.freeze({
  plan_vs_progress: "Plan vs Progress Divergence",
  applicable_kb: "Applicable KB Entries",
  relevant_retros: "Relevant Retros",
  edge_case_coverage: "Edge Case Coverage",
  pattern_application_check: "Pattern Application Check",
  process_signals: "Thrashing & Process Signals",
  proof_weight_audit: "Proof Weight Audit",
  next_time_candidates: "Next Time Candidates",
  convention_application_check: "Convention Application Check",
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(filePath) {
  return normalizeString(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((entry) => normalizeString(entry)).filter(Boolean))];
}

function uniquePaths(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((entry) => normalizePath(entry)).filter(Boolean))];
}

function safeReadText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  const text = safeReadText(filePath);
  if (!text) return { ok: false, present: false, value: null, error: "missing" };
  try {
    return { ok: true, present: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return {
      ok: false,
      present: true,
      value: null,
      error: error?.message || "invalid_json_compatible_yaml",
    };
  }
}

function renderJsonCompatibleYaml(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function normalizeRepoPath(cwd, filePath) {
  const raw = normalizeString(filePath);
  if (!raw) return null;
  const absolute = raw.startsWith("/") ? resolve(raw) : resolve(cwd, raw);
  const repoRelative = relative(cwd, absolute).replace(/\\/g, "/");
  if (!repoRelative || repoRelative.startsWith("..")) return normalizePath(raw);
  return normalizePath(repoRelative);
}

function looksLikePath(value) {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  return normalized.includes("/") || /\.[A-Za-z0-9_-]{1,12}$/.test(normalized);
}

function extractPathMentions(text, cwd) {
  const matches = [];
  const content = String(text || "");

  const codePattern = /`([^`\n]+)`/g;
  for (const match of content.matchAll(codePattern)) {
    if (looksLikePath(match[1])) matches.push(normalizeRepoPath(cwd, match[1]));
  }

  const pathPattern = /(?:^|[\s(])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s),:])/gm;
  for (const match of content.matchAll(pathPattern)) {
    if (looksLikePath(match[1])) matches.push(normalizeRepoPath(cwd, match[1]));
  }

  return uniquePaths(matches);
}

function readStoryRegistry(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const parsed = safeReadJson(registryPath);
  const stories = Array.isArray(parsed.value?.stories) ? parsed.value.stories : [];
  return {
    path: registryPath,
    present: parsed.present,
    usable: parsed.ok && stories.length >= 0,
    stories,
  };
}

function readPlanState(planDir) {
  const parsed = safeReadJson(join(planDir, "state.json"));
  return parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : {};
}

function extractPlanPatternIds(planContent) {
  return uniqueList((String(planContent || "").match(/\bP-\d+\b/g) || []).map((entry) => entry.toUpperCase()));
}

function collectQuestion(sectionId, title, prompt, extra = {}) {
  return {
    id: `${sectionId}:${normalizeString(extra.subject_id || title || "question").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "question"}`,
    title: title || null,
    prompt: normalizeString(prompt),
    required: extra.required !== false,
    subject_id: normalizeString(extra.subject_id) || null,
    evidence_hint: normalizeString(extra.evidence_hint) || null,
    answer_modes: Array.isArray(extra.answer_modes) ? extra.answer_modes : [],
  };
}

function collectGuideQuestions(document) {
  const sections = document?.reflection_guide?.sections || {};
  const questions = [];
  for (const sectionId of Object.keys(sections)) {
    const sectionQuestions = Array.isArray(sections?.[sectionId]?.questions) ? sections[sectionId].questions : [];
    for (const question of sectionQuestions) {
      if (question && typeof question === "object") questions.push({ section_id: sectionId, ...question });
    }
  }
  return questions;
}

const MAX_REQUIRED_REFLECTION_QUESTIONS = 8;
const REQUIRED_QUESTION_PRIORITY = Object.freeze({
  applicable_kb: 1,
  plan_vs_progress: 2,
  edge_case_coverage: 3,
  proof_weight_audit: 4,
  convention_application_check: 5,
  relevant_retros: 8,
  process_signals: 9,
  pattern_application_check: 10,
});

function capRequiredReflectionQuestions(questions) {
  const required = questions.filter((question) => question.required !== false);
  if (required.length <= MAX_REQUIRED_REFLECTION_QUESTIONS) return questions;

  const keepRequired = new Set(required
    .map((question, index) => ({
      question,
      index,
      priority: REQUIRED_QUESTION_PRIORITY[question.section_id] ?? 6,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, MAX_REQUIRED_REFLECTION_QUESTIONS)
    .map((entry) => entry.question.id));

  return questions.map((question) => {
    if (question.required === false || keepRequired.has(question.id)) return question;
    return {
      ...question,
      required: false,
      evidence_hint: firstNonEmpty(
        question.evidence_hint,
        "Optional because higher-confidence blocker-capable reflection questions already cover the closeout risk."
      ),
    };
  });
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeTokens(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function overlapScore(left, right) {
  const rightSet = new Set(normalizeTokens(right));
  return normalizeTokens(left).filter((token) => rightSet.has(token)).length;
}

function determineGuideDomains({ taskContext, plannedFiles }) {
  const inferred = Array.isArray(taskContext?.task_context?.inferred_tags?.domains)
    ? taskContext.task_context.inferred_tags.domains.map(normalizeString).filter(Boolean)
    : [];
  if (inferred.length > 0) return inferred;
  if (plannedFiles.some((filePath) => filePath.startsWith(".agent/skills/iterative-planner/") || filePath.startsWith(".agent/workflows/"))) {
    return ["planner_core"];
  }
  return [];
}

function determineGuideChangeClasses({ taskContext, taskDescription, plannedFiles }) {
  const inferred = Array.isArray(taskContext?.task_context?.inferred_tags?.change_classes)
    ? taskContext.task_context.inferred_tags.change_classes.map(normalizeString).filter(Boolean)
    : [];
  if (inferred.length > 0) return inferred;

  const haystack = `${taskDescription} ${plannedFiles.join(" ")}`.toLowerCase();
  const matches = [];
  if (/\bverify|validation|proof|test|evidence\b/.test(haystack)) matches.push("verification");
  if (/\bparser|reader|reflection|artifact|mirror\b/.test(haystack)) matches.push("parser_reader");
  if (/\bworkflow|route|dispatch|planner\b/.test(haystack)) matches.push("workflow");
  if (/\bontology|prolog|facts|query\b/.test(haystack)) matches.push("ontology");
  return uniqueList(matches);
}

function mapRetroMatchReason(retro) {
  const reasons = [];
  if (retro?.change_class_match) reasons.push("change_class match");
  if (retro?.domain_match) reasons.push("domain match");
  return reasons.join(", ") || "ontology overlap";
}

function matchRetros(runtime, domains, changeClasses) {
  return (runtime?.documents?.process?.retros || [])
    .map((retro) => {
      const domainMatches = (Array.isArray(retro?.domain_tags) ? retro.domain_tags : [])
        .filter((tag) => domains.map((entry) => entry.toLowerCase()).includes(normalizeString(tag).toLowerCase()));
      const changeMatches = (Array.isArray(retro?.change_classes) ? retro.change_classes : [])
        .filter((tag) => changeClasses.map((entry) => entry.toLowerCase()).includes(normalizeString(tag).toLowerCase()));
      const score = domainMatches.length * 3 + changeMatches.length * 2;
      return {
        id: normalizeString(retro?.id),
        title: normalizeString(retro?.title) || normalizeString(retro?.id),
        change_class_match: changeMatches.length > 0,
        domain_match: domainMatches.length > 0,
        score,
      };
    })
    .filter((retro) => retro.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 6);
}

function matchEdgeCases(runtime, domains) {
  return (runtime?.documents?.process?.edge_cases || [])
    .filter((record) => domains.includes(normalizeString(record?.domain)))
    .map((record) => ({
      domain: normalizeString(record?.domain),
      label: normalizeString(record?.label),
      description: normalizeString(record?.description) || null,
    }))
    .filter((record) => record.domain && record.label)
    .slice(0, 10);
}

function matchApplicablePatterns(runtime, changeClasses) {
  return (runtime?.documents?.process?.patterns || [])
    .filter((pattern) =>
      (Array.isArray(pattern?.applies_to) ? pattern.applies_to : [])
        .some((tag) => changeClasses.map((entry) => entry.toLowerCase()).includes(normalizeString(tag).toLowerCase()))
    )
    .map((pattern) => ({
      id: normalizeString(pattern?.id),
      title: normalizeString(pattern?.title) || normalizeString(pattern?.id),
      applies_to: Array.isArray(pattern?.applies_to) ? pattern.applies_to.map(normalizeString).filter(Boolean) : [],
    }))
    .filter((pattern) => pattern.id)
    .slice(0, 8);
}

function matchGotchas(runtime, domains) {
  return (runtime?.documents?.process?.gotchas || [])
    .filter((gotcha) => {
      const domain = normalizeString(gotcha?.domain).toLowerCase();
      return domains.length === 0 || !domain || domains.map((entry) => entry.toLowerCase()).includes(domain);
    })
    .slice(0, 6)
    .map((gotcha) => ({
      id: normalizeString(gotcha?.id),
      title: normalizeString(gotcha?.title) || normalizeString(gotcha?.id),
      domain: normalizeString(gotcha?.domain) || null,
    }));
}

function findPatternRecords(runtime, ids, fallbackPatterns = []) {
  const map = new Map((runtime?.documents?.process?.patterns || []).map((pattern) => [normalizeString(pattern?.id).toUpperCase(), pattern]));
  const results = [];
  for (const id of ids) {
    const record = map.get(normalizeString(id).toUpperCase());
    if (record) {
      results.push({
        id: normalizeString(record.id),
        title: normalizeString(record.title) || normalizeString(record.id),
        applies_to: Array.isArray(record.applies_to) ? record.applies_to.map(normalizeString).filter(Boolean) : [],
      });
    }
  }
  for (const entry of fallbackPatterns) {
    if (!entry?.id || results.some((record) => record.id === entry.id)) continue;
    results.push({
      id: normalizeString(entry.id),
      title: normalizeString(entry.title) || normalizeString(entry.id),
      applies_to: Array.isArray(entry.applies_to) ? entry.applies_to.map(normalizeString).filter(Boolean) : [],
    });
  }
  return results;
}

function buildPlanVsProgressSection({ plannedFiles, actualFiles, progressPaths }) {
  const actual = actualFiles.length > 0 ? actualFiles : progressPaths;
  const unplanned = actual.filter((filePath) => !plannedFiles.includes(filePath));
  const questions = [];

  if (unplanned.length > 0) {
    questions.push(collectQuestion(
      "plan_vs_progress",
      "Classify unplanned work",
      `Unplanned work was observed in ${unplanned.join(", ")}. For each path, classify it as intentional_scope_expansion, discovered_dependency, or scope_creep, and justify the decision.`,
      {
        subject_id: "unplanned_work",
        required: true,
        answer_modes: ["intentional_scope_expansion", "discovered_dependency", "scope_creep"],
      }
    ));
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.plan_vs_progress,
    planned_files: plannedFiles,
    actual_files_touched: actual,
    progress_mentioned_paths: progressPaths,
    unplanned_work: unplanned,
    questions,
  };
}

function buildApplicableKbSection({
  runtime,
  mistakeSignal,
  domains,
  declaredPatternIds,
  applicablePatterns,
}) {
  const questions = [];
  const mistakes = (mistakeSignal?.active_mistakes || []).map((mistake) => {
    const why = [];
    if (Array.isArray(mistake?.matched_declared_files) && mistake.matched_declared_files.length > 0) {
      why.push(`planned files matched ${mistake.matched_declared_files.join(", ")}`);
    }
    if (Array.isArray(mistake?.matched_terms) && mistake.matched_terms.length > 0) {
      why.push(`goal/plan terms matched ${mistake.matched_terms.join(", ")}`);
    }
    const requiredEvidence = Array.isArray(mistake?.required_evidence) ? mistake.required_evidence : [];
    const requiredGuards = Array.isArray(mistake?.required_guards) ? mistake.required_guards : [];
    const promptDetails = [
      requiredGuards.length > 0 ? `Required guards: ${requiredGuards.join(", ")}.` : null,
      requiredEvidence.length > 0 ? `Required evidence: ${requiredEvidence.join(", ")}.` : null,
      Array.isArray(mistake?.verification_hooks) && mistake.verification_hooks.length > 0
        ? `Verification hooks: ${mistake.verification_hooks.join(", ")}.`
        : null,
    ].filter(Boolean).join(" ");

    const prompt = `Mistake ${mistake.id} is active for this plan. Explain how the implementation and proof bundle prevent this failure mode from recurring. ${promptDetails}`.trim();
    questions.push(collectQuestion("applicable_kb", `Address ${mistake.id}`, prompt, {
      subject_id: mistake.id,
      required: true,
      evidence_hint: "Reference the concrete guard, test, artifact, or docs update that closes this mistake loop.",
    }));

    return {
      id: mistake.id,
      title: normalizeString(mistake?.title) || mistake.id,
      matches_because: why.join("; ") || "mistake registry activated this failure family for the current plan",
      required: true,
      required_question: prompt,
    };
  });

  const patternIds = uniqueList([
    ...declaredPatternIds,
    ...((applicablePatterns || []).slice(0, 3).map((pattern) => pattern.id)),
  ]);
  const patterns = findPatternRecords(runtime, patternIds, applicablePatterns).map((pattern) => {
    const declared = declaredPatternIds.includes(pattern.id);
    const prompt = declared
      ? `Pattern ${pattern.id} is declared or implied for this plan. Confirm how it was applied, where it appears in code/process, and what evidence proves it was followed.`
      : null;
    if (prompt) {
      questions.push(collectQuestion("applicable_kb", `Confirm ${pattern.id}`, prompt, {
        subject_id: pattern.id,
        required: true,
        evidence_hint: "Reference code paths, tests, or artifacts that demonstrate the pattern in use.",
      }));
    }
    return {
      id: pattern.id,
      title: pattern.title,
      declared_applied: declared,
      applies_to: pattern.applies_to,
      required_question: prompt,
    };
  });

  const gotchas = matchGotchas(runtime, domains).map((gotcha) => ({
    ...gotcha,
    required: false,
    required_question: `Consider ${gotcha.id}. If it applies here, explain the guard or evidence that keeps it from recurring; if not, justify why it is out of scope.`,
  }));

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.applicable_kb,
    mistakes,
    patterns,
    gotchas,
    questions,
  };
}

function buildRelevantRetrosSection(historicalIncidents) {
  const retros = [];
  const questions = [];
  for (const retro of historicalIncidents.slice(0, 4)) {
    const required = retro.change_class_match === true;
    const prompt = `Review ${retro.id}. Explain whether its failure mode is still relevant to this plan and what concrete evidence shows the same regression path is closed.`;
    if (required) {
      questions.push(collectQuestion("relevant_retros", `Address ${retro.id}`, prompt, {
        subject_id: retro.id,
        required: true,
        evidence_hint: "Reference the guard, reader inventory, proof artifact, or state-machine behavior that blocks the old regression.",
      }));
    }
    retros.push({
      id: retro.id,
      title: normalizeString(retro.title) || retro.id,
      matches_because: mapRetroMatchReason(retro),
      required,
      required_question: required ? prompt : null,
    });
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.relevant_retros,
    retros,
    questions,
  };
}

function inferEdgeCaseCoverage({ edgeCases, strategyDocument, testRuns }) {
  const criteria = Array.isArray(strategyDocument?.verification_strategy?.criteria)
    ? strategyDocument.verification_strategy.criteria
    : [];
  const searchable = [
    ...criteria.flatMap((criterion) => [
      criterion?.id,
      criterion?.criterion,
      criterion?.repo_system_context,
      ...(Array.isArray(criterion?.tests) ? criterion.tests.map((test) => test?.name) : []),
    ]),
    ...testRuns.flatMap((entry) => (entry?.run?.tests || []).map((test) => test?.name)),
  ].filter(Boolean);

  return edgeCases.map((edgeCase) => {
    let bestMatch = null;
    let bestScore = 0;
    const referenceText = `${edgeCase.label} ${edgeCase.description || ""}`;
    for (const candidate of searchable) {
      const score = overlapScore(referenceText, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = normalizeString(candidate);
      }
    }
    return {
      name: edgeCase.label,
      description: edgeCase.description || null,
      covered: bestScore >= 2,
      covered_by_test: bestScore >= 2 ? bestMatch : null,
    };
  });
}

function buildEdgeCaseCoverageSection({ domains, edgeCases, strategyDocument, testRuns }) {
  const expected = inferEdgeCaseCoverage({ edgeCases, strategyDocument, testRuns });
  const uncovered = expected.filter((entry) => entry.covered !== true);
  const questions = [];

  if (uncovered.length > 0) {
    questions.push(collectQuestion(
      "edge_case_coverage",
      "Resolve uncovered edge cases",
      `The following edge cases are currently uncovered: ${uncovered.map((entry) => entry.name).join(", ")}. For each, decide whether to add test and pivot back to EXECUTE, accept as a known limitation with follow-up, or justify why it is out of scope.`,
      {
        subject_id: "uncovered_edge_cases",
        required: true,
        answer_modes: ["pivot_back_to_execute", "accept_as_known_limitation", "out_of_scope"],
      }
    ));
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.edge_case_coverage,
    domain: domains[0] || null,
    expected_edge_cases: expected,
    uncovered_count: uncovered.length,
    questions,
  };
}

function buildPatternApplicationSection(patterns) {
  const questions = [];
  const items = patterns
    .filter((pattern) => pattern.declared_applied === true)
    .map((pattern) => {
      const prompt = `Walk through how ${pattern.id} was applied in this plan and reference the code, tests, or artifacts that prove the checklist was followed.`;
      questions.push(collectQuestion("pattern_application_check", `Verify ${pattern.id}`, prompt, {
        subject_id: pattern.id,
        required: true,
        evidence_hint: "Point at the exact proof that makes the pattern claim non-vacuous.",
      }));
      return {
        pattern_id: pattern.id,
        declared_applied: true,
        required_question: prompt,
      };
    });

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.pattern_application_check,
    items,
    questions,
  };
}

function buildProcessSignalsSection({ thrashingResult, metricsDocument }) {
  const activeSignals = Array.isArray(thrashingResult?.signals)
    ? thrashingResult.signals.filter((signal) => signal?.active === true)
    : [];
  const criteriaOverbudget = activeSignals
    .filter((signal) => signal?.id === "thrashing_criterion_overbudget")
    .map((signal) => normalizeString(signal?.context?.criterion_id))
    .filter(Boolean);
  const toolCallsAboveTypical = activeSignals.some((signal) => signal?.id === "thrashing_session_overbudget");
  const questions = [];

  if (activeSignals.length > 0 || thrashingResult?.response_level >= 2) {
    questions.push(collectQuestion(
      "process_signals",
      "Explain process signal handling",
      `Thrashing/process signals fired during this plan (${activeSignals.map((signal) => signal.id).join(", ") || "response escalation only"}). Explain the root cause, why the response level was sufficient, and what should change next time to avoid repeating the loop.`,
      {
        subject_id: "thrashing_signals",
        required: true,
        evidence_hint: "Reference the mini-reflection, cooldown, or concrete pivot evidence if any signal escalated beyond level 1.",
      }
    ));
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.process_signals,
    thrashing_events_during_execute: activeSignals.length,
    signals_that_fired: activeSignals.map((signal) => ({
      id: signal.id,
      severity: signal.severity || null,
      reason: normalizeString(signal.reason) || null,
      context: signal.context || {},
    })),
    mini_reflections_produced: Number(thrashingResult?.sources?.mini_reflections?.count || 0),
    level_3_blocks: thrashingResult?.response_level === 3 ? 1 : 0,
    response_level: Number.isFinite(Number(thrashingResult?.response_level)) ? Number(thrashingResult.response_level) : 0,
    recommended_action: normalizeString(thrashingResult?.recommended_action) || null,
    criteria_overbudget: criteriaOverbudget,
    tool_calls_above_typical: toolCallsAboveTypical,
    metrics: metricsDocument || null,
    questions,
  };
}

function buildProofWeightAuditSection(evidenceResult) {
  const criteria = Array.isArray(evidenceResult?.criteria)
    ? evidenceResult.criteria.map((criterion) => ({
      id: normalizeString(criterion?.criterion_id) || null,
      risk_level: normalizeString(criterion?.risk_level) || null,
      required_weight: Number.isFinite(Number(criterion?.required_proof_weight)) ? Number(criterion.required_proof_weight) : 0,
      accumulated_weight: Number.isFinite(Number(criterion?.accumulated_proof_weight)) ? Number(criterion.accumulated_proof_weight) : 0,
      margin: Number(((Number(criterion?.accumulated_proof_weight) || 0) - (Number(criterion?.required_proof_weight) || 0)).toFixed(6)),
      proof_sufficient: criterion?.proof_sufficient === true,
      primary_blocker: normalizeString(criterion?.primary_blocker) || null,
    }))
    : [];
  const atThreshold = criteria.filter((criterion) => criterion.margin === 0 && criterion.required_weight > 0);
  const questions = [];

  if (atThreshold.length > 0 || criteria.some((criterion) => criterion.proof_sufficient !== true)) {
    questions.push(collectQuestion(
      "proof_weight_audit",
      "Audit low-margin proof",
      `The proof bundle has low-confidence criteria: ${criteria.filter((criterion) => criterion.margin <= 0).map((criterion) => criterion.id).join(", ") || atThreshold.map((criterion) => criterion.id).join(", ")}. Explain whether more evidence is needed before close or why the current margin is still trustworthy.`,
      {
        subject_id: "proof_margin",
        required: true,
        evidence_hint: "Reference the additional artifact, risk rationale, or explicit limitation if the criterion only barely cleared the threshold.",
      }
    ));
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.proof_weight_audit,
    criteria,
    at_threshold_criteria: atThreshold.map((criterion) => criterion.id).filter(Boolean),
    questions,
  };
}

function buildConventionApplicationSection(conventionCheck) {
  const questions = [];
  const entries = Array.isArray(conventionCheck?.reflection_sections?.convention_application_check)
    ? conventionCheck.reflection_sections.convention_application_check
    : [];
  const items = entries.map((entry) => {
    if (normalizeString(entry?.required_question)) {
      questions.push(collectQuestion(
        "convention_application_check",
        `Resolve ${normalizeString(entry?.convention_id) || "convention"}`,
        entry.required_question,
        {
          subject_id: normalizeString(entry?.convention_id) || "convention",
          required: true,
          evidence_hint: normalizeString(entry?.evidence) || null,
        }
      ));
    }
    return {
      convention_id: normalizeString(entry?.convention_id) || null,
      title: normalizeString(entry?.title) || null,
      file: normalizeString(entry?.file) || null,
      applicable: entry?.applicable === true,
      satisfied: entry?.satisfied === true,
      evidence: normalizeString(entry?.evidence) || null,
      required_question: normalizeString(entry?.required_question) || null,
    };
  });

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.convention_application_check,
    items,
    questions,
  };
}

function buildNextTimeCandidatesSection({
  planVsProgress,
  edgeCaseCoverage,
  processSignals,
  proofWeightAudit,
  conventionApplication,
}) {
  const candidates = [];

  for (const filePath of planVsProgress.unplanned_work || []) {
    candidates.push({
      kind: "scope_guard",
      suggested: `Document or split unexpected work on ${filePath} earlier in future plans`,
      evidence: `${filePath} appeared outside Files To Modify`,
      action: "promote_to_gotcha_or_reject",
    });
  }

  for (const edgeCase of edgeCaseCoverage.expected_edge_cases || []) {
    if (edgeCase.covered === true) continue;
    candidates.push({
      kind: "edge_case_followup",
      suggested: edgeCase.name,
      evidence: `Edge case ${edgeCase.name} was not matched to a planned test or structured run`,
      action: "promote_to_kb_or_reject",
    });
  }

  if ((processSignals.signals_that_fired || []).length > 0) {
    candidates.push({
      kind: "process_guard",
      suggested: "Record earlier pivots when reflection-guide process signals escalate",
      evidence: `${processSignals.signals_that_fired.length} thrashing/process signal(s) fired`,
      action: "promote_to_pattern_or_reject",
    });
  }

  for (const criterion of proofWeightAudit.criteria || []) {
    if (criterion.margin > 0) continue;
    candidates.push({
      kind: "proof_upgrade",
      suggested: `Raise proof margin for ${criterion.id}`,
      evidence: `${criterion.id} closed with margin ${criterion.margin}`,
      action: "promote_to_pattern_or_reject",
    });
  }

  for (const item of conventionApplication.items || []) {
    if (item.applicable !== true || item.satisfied === true) continue;
    candidates.push({
      kind: "convention_followup",
      suggested: `Close or justify convention ${item.convention_id}`,
      evidence: item.evidence || `${item.convention_id} remained unsatisfied`,
      action: "promote_to_conventions_or_reject",
    });
  }

  return {
    title: REFLECTION_GUIDE_SECTION_TITLES.next_time_candidates,
    candidates: candidates.slice(0, 8),
    questions: [],
  };
}

export function getReflectionGuidePath(planDir) {
  return join(planDir, REFLECTION_GUIDE_FILENAME);
}

export function renderReflectionGuideDocument(document) {
  return renderJsonCompatibleYaml(document);
}

export function readReflectionGuideDocument(filePath) {
  const parsed = safeReadJson(filePath);
  if (!parsed.present) {
    return {
      ok: false,
      present: false,
      path: filePath,
      document: null,
      error: "missing",
    };
  }
  const root = parsed.value?.reflection_guide;
  if (!parsed.ok || !root || typeof root !== "object") {
    return {
      ok: false,
      present: true,
      path: filePath,
      document: null,
      error: parsed.error || "reflection_guide root object is required",
    };
  }
  return {
    ok: true,
    present: true,
    path: filePath,
    document: parsed.value,
    error: null,
  };
}

export function buildReflectionGuide({ cwd = process.cwd(), planDir, now = new Date().toISOString() } = {}) {
  const resolvedPlanDir = resolve(planDir);
  const planId = basename(resolvedPlanDir);
  const planContent = safeReadText(join(resolvedPlanDir, "plan.md"));
  if (!planContent) {
    return {
      ok: false,
      cwd,
      plan_id: planId,
      plan_dir: resolvedPlanDir,
      issues: ["plan.md missing or unreadable"],
      warnings: [],
      document: null,
      path: getReflectionGuidePath(resolvedPlanDir),
    };
  }

  const progressContent = safeReadText(join(resolvedPlanDir, "progress.md")) || "";
  const stateJson = readPlanState(resolvedPlanDir);
  const storyRegistry = readStoryRegistry(cwd);
  const taskDescription = firstNonEmpty(
    extractGoalText(stateJson, planContent),
    extractMarkdownSection(planContent, "Goal").split("\n")[0]
  );

  const runtime = loadOntologyRuntime({ cwd });
  const taskContext = buildTaskContext({ cwd, taskDescription });
  const matchContext = loadPlanMatchContext({
    cwd,
    planDir: resolvedPlanDir,
    stateJson,
    planContent,
    storyRegistry,
  });
  const mistakeSignal = computeMistakeRegistrySignal({
    cwd,
    planDir: resolvedPlanDir,
    stateJson,
    planContent,
    storyRegistry,
  });
  const strategyRead = readEffectiveVerificationStrategy({
    cwd,
    planDir: resolvedPlanDir,
    planContent,
  });
  const evidenceResult = strategyRead.ok
    ? verifyPlanEvidence({ projectRoot: cwd, planDir: resolvedPlanDir, strategyDocument: strategyRead.document })
    : { required: false, criteria: [], blockers: [], primary_blocker: null };
  const thrashingResult = evaluateThrashingDetector({
    cwd,
    planDir: resolvedPlanDir,
    planId,
    now,
  });
  const conventionCheck = checkPlanConventions({
    cwd,
    plan: resolvedPlanDir,
    write: false,
  });
  const metricsRead = safeReadJson(join(resolvedPlanDir, "metrics.json"));
  const metricsDocument = metricsRead.ok ? metricsRead.value : null;
  const plannedFiles = uniquePaths(extractFilesToModify(planContent));
  const progressPaths = extractPathMentions(progressContent, cwd);
  const actualFiles = uniquePaths([
    ...(matchContext?.observedFiles || []),
    ...progressPaths,
  ]);
  const declaredPatternIds = extractPlanPatternIds(planContent);
  const domains = determineGuideDomains({ taskContext, plannedFiles });
  const changeClasses = determineGuideChangeClasses({ taskContext, taskDescription, plannedFiles });
  const applicablePatterns = Array.isArray(taskContext?.task_context?.applicable_patterns) && taskContext.task_context.applicable_patterns.length > 0
    ? taskContext.task_context.applicable_patterns
    : matchApplicablePatterns(runtime, changeClasses);
  const historicalIncidents = Array.isArray(taskContext?.task_context?.historical_incidents) && taskContext.task_context.historical_incidents.length > 0
    ? taskContext.task_context.historical_incidents
    : matchRetros(runtime, domains, changeClasses);
  const edgeCases = Array.isArray(taskContext?.task_context?.edge_cases_to_consider) && taskContext.task_context.edge_cases_to_consider.length > 0
    ? taskContext.task_context.edge_cases_to_consider
    : matchEdgeCases(runtime, domains);
  const testRuns = listPlanStructuredTestRuns({ projectRoot: cwd, planId });

  const planVsProgress = buildPlanVsProgressSection({ plannedFiles, actualFiles, progressPaths });
  const applicableKb = buildApplicableKbSection({
    runtime,
    mistakeSignal,
    domains,
    declaredPatternIds,
    applicablePatterns,
  });
  const relevantRetros = buildRelevantRetrosSection(historicalIncidents);
  const edgeCaseCoverage = buildEdgeCaseCoverageSection({
    domains,
    edgeCases,
    strategyDocument: strategyRead.document,
    testRuns,
  });
  const patternApplicationCheck = buildPatternApplicationSection(applicableKb.patterns || []);
  const processSignals = buildProcessSignalsSection({ thrashingResult, metricsDocument });
  const proofWeightAudit = buildProofWeightAuditSection(evidenceResult);
  const conventionApplication = buildConventionApplicationSection(conventionCheck);
  const nextTimeCandidates = buildNextTimeCandidatesSection({
    planVsProgress,
    edgeCaseCoverage,
    processSignals,
    proofWeightAudit,
    conventionApplication,
  });

  const document = {
    reflection_guide: {
      version: REFLECTION_GUIDE_VERSION,
      plan_id: planId,
      generated_at: now,
      goal: taskDescription,
      generated_from: {
        plan_md: normalizeRepoPath(cwd, join(resolvedPlanDir, "plan.md")),
        progress_md: normalizeRepoPath(cwd, join(resolvedPlanDir, "progress.md")),
        state_json: normalizeRepoPath(cwd, join(resolvedPlanDir, "state.json")),
        verification_strategy: strategyRead.path ? normalizeRepoPath(cwd, strategyRead.path) : null,
        metrics_json: metricsRead.present ? normalizeRepoPath(cwd, join(resolvedPlanDir, "metrics.json")) : null,
        telemetry_summary: normalizeRepoPath(cwd, join(resolvedPlanDir, "telemetry", "summary.json")),
      },
      inferred_tags: taskContext?.task_context?.inferred_tags || {
        domains,
        change_class: changeClasses[0] || null,
        change_classes: changeClasses,
      },
      section_order: REFLECTION_GUIDE_SECTION_ORDER,
      sections: {
        plan_vs_progress: planVsProgress,
        applicable_kb: applicableKb,
        relevant_retros: relevantRetros,
        edge_case_coverage: edgeCaseCoverage,
        pattern_application_check: patternApplicationCheck,
        process_signals: processSignals,
        proof_weight_audit: proofWeightAudit,
        next_time_candidates: nextTimeCandidates,
        convention_application_check: conventionApplication,
      },
      questions: [],
      required_question_count: 0,
      summary: {
        planned_file_count: plannedFiles.length,
        actual_file_count: (planVsProgress.actual_files_touched || []).length,
        active_mistake_count: Array.isArray(mistakeSignal?.active_mistakes) ? mistakeSignal.active_mistakes.length : 0,
        relevant_retro_count: Array.isArray(relevantRetros.retros) ? relevantRetros.retros.length : 0,
        uncovered_edge_case_count: Number(edgeCaseCoverage.uncovered_count || 0),
        active_signal_count: Array.isArray(processSignals.signals_that_fired) ? processSignals.signals_that_fired.length : 0,
        low_margin_criterion_count: Array.isArray(proofWeightAudit.at_threshold_criteria) ? proofWeightAudit.at_threshold_criteria.length : 0,
        convention_question_count: Array.isArray(conventionApplication.questions) ? conventionApplication.questions.length : 0,
      },
    },
  };

  const questions = capRequiredReflectionQuestions(collectGuideQuestions(document));
  document.reflection_guide.questions = questions;
  document.reflection_guide.required_question_count = questions.filter((question) => question.required !== false).length;

  const warnings = [];
  if (!runtime.ok) warnings.push(...(runtime.issues || []));
  if (!taskContext.ok) warnings.push(...(taskContext.issues || []));
  if (!strategyRead.ok && strategyRead.source === "yaml") {
    warnings.push(...(strategyRead.errors || []).map((entry) => `verification_strategy: ${entry}`));
  }
  if (!conventionCheck.ok) warnings.push(...(conventionCheck.issues || []).map((entry) => `conventions: ${entry}`));

  return {
    ok: true,
    cwd,
    plan_id: planId,
    plan_dir: resolvedPlanDir,
    path: getReflectionGuidePath(resolvedPlanDir),
    document,
    warnings: uniqueList(warnings),
    issues: [],
    section_ids: REFLECTION_GUIDE_SECTION_ORDER,
    required_question_count: document.reflection_guide.required_question_count,
  };
}

export function writeReflectionGuide({ cwd = process.cwd(), planDir, now = new Date().toISOString() } = {}) {
  const built = buildReflectionGuide({ cwd, planDir, now });
  if (!built.ok) return { ...built, wrote: false };
  mkdirSync(dirname(built.path), { recursive: true });
  writeFileSync(built.path, renderReflectionGuideDocument(built.document));
  return {
    ...built,
    wrote: true,
  };
}

export function collectRequiredReflectionGuideQuestions(document) {
  return capRequiredReflectionQuestions(collectGuideQuestions(document)).filter((question) => question.required !== false);
}
