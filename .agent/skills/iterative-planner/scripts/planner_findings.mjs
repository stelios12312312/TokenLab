#!/usr/bin/env node
// planner_findings.mjs — deterministic semantic findings for planner state and task shape.
//
// Purpose:
//   Give operators and LLMs one compact, read-only script that explains the
//   planner's north star, likely route, semantic blockers, repairable variance,
//   recovery path, and next best actions without any AI calls.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import {
  analyzeIntentContract,
  classifyPlannerPreflight,
  extractFilesToModify,
  findPoisonedGateHistories,
  getPaths,
  getSkillPath,
  loadIntentContract,
  readFile,
  resolvePlanTarget,
} from "./lib/plan_utils.mjs";
import { collectPlannerCanonicalization } from "./lib/planner_canonicalizer.mjs";
import { deriveManifestoAlignmentSignals, loadPlannerManifesto } from "./lib/planner_manifesto.mjs";
import {
  buildPhaseContract,
  computeRecommendedPath,
  resolveAuthorityProfile,
  resolveProofPosture,
} from "./lib/planner_phase_routing.mjs";
import { resolveAntiRitualAssessment } from "./lib/anti_ritual_contract.mjs";
import { summarizeProofTelemetry } from "./lib/proof_telemetry.mjs";
import { applyRecipeResolutionToClassification, resolveRecipeRequest } from "./lib/recipe_utils.mjs";
import { createSemanticEngine } from "./lib/semantic_engine.mjs";
import {
  collectScopedAnnotationContext,
  collectSubstrateSignals,
  querySemanticDiagnostics,
  summarizeSemanticSubstrate,
} from "./lib/semantic_substrate.mjs";
import { computeAdversarialAuditProfile } from "./lib/verification_obligations.mjs";
import { resolveKnowledgeFromContext } from "./knowledge_resolver.mjs";
import { deriveTaskProfileContract, evaluateSemanticUpkeepContract } from "./lib/task_profile_contracts.mjs";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function readFlagValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function safeReadJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueNormalizedPaths(values) {
  return uniqueList((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().replace(/\\/g, "/"))
    .filter(Boolean));
}

const VALID_STORY_STATUSES = new Set(["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"]);

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function analyzeStoryRegistryHealth(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) {
    return {
      present: false,
      usable: false,
      blocking: false,
      errors: [],
      warnings: [],
      story_count: 0,
      detail: "No story_registry.json found",
    };
  }

  const parsed = safeReadJson(registryPath);
  if (!parsed) {
    return {
      present: true,
      usable: false,
      blocking: true,
      errors: ["story_registry.json is invalid JSON"],
      warnings: [],
      story_count: 0,
      detail: "story_registry.json is invalid JSON",
    };
  }

  const stories = [
    ...(Array.isArray(parsed?.stories) ? parsed.stories : []),
    ...(Array.isArray(parsed?.infrastructure_stories) ? parsed.infrastructure_stories : []),
  ];
  const seen = new Set();
  const errors = [];
  const warnings = [];

  for (const story of stories) {
    const id = typeof story?.id === "string" && story.id.trim() ? story.id.trim() : null;
    if (!id) {
      errors.push("story missing id");
      continue;
    }
    if (seen.has(id)) errors.push(`${id}: duplicate story ID`);
    seen.add(id);

    const status = typeof story?.status === "string" ? story.status.trim() : "";
    if (!status) errors.push(`${id}: missing status`);
    else if (!VALID_STORY_STATUSES.has(status)) errors.push(`${id}: invalid status '${status}'`);

    if (!story.title) warnings.push(`${id}: missing title`);
    if (status === "FULLY_COVERED") {
      const missingEvidence = [];
      if (!hasNonEmptyArray(story.code_refs)) missingEvidence.push("code_refs");
      if (!hasNonEmptyArray(story.test_refs)) missingEvidence.push("test_refs");
      if (!hasNonEmptyArray(story.validation_refs)) missingEvidence.push("validation_refs");
      if (missingEvidence.length > 0) {
        errors.push(`${id}: FULLY_COVERED story missing ${missingEvidence.join(", ")}`);
      }
    }
  }

  return {
    present: true,
    usable: true,
    blocking: errors.length > 0,
    errors,
    warnings,
    story_count: stories.length,
    detail: errors.length > 0
      ? `${errors.length} story registry issue(s): ${errors.slice(0, 4).join("; ")}`
      : warnings.length > 0
        ? `${warnings.length} story registry warning(s): ${warnings.slice(0, 4).join("; ")}`
        : `${stories.length} story registry stories look structurally valid`,
  };
}

function includesAnyPhrase(text, phrases) {
  const normalized = normalizeText(text);
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function withPlannerTarget(planDirName, fn) {
  const previous = process.env._PLANNER_PLAN_TARGET;
  if (planDirName) process.env._PLANNER_PLAN_TARGET = planDirName;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env._PLANNER_PLAN_TARGET;
    else process.env._PLANNER_PLAN_TARGET = previous;
  }
}

function resolveGateDefinition(gateName, gateRegistry) {
  if (!gateName) return null;
  const gateDef = gateRegistry[gateName];
  if (gateDef) {
    const from = Array.isArray(gateDef.from) ? gateDef.from[0] : gateDef.from;
    return {
      from: String(from || "").replace(/[-]/g, "_"),
      to: String(gateDef.to || "").replace(/[-]/g, "_"),
    };
  }
  const [from, to] = String(gateName || "")
    .replace(/-to-|_to_/, " ")
    .split(" ")
    .map((value) => value.replace(/[-]/g, "_"));
  return { from, to };
}

function buildRecommendedRecovery({
  prologModes,
  classification,
}) {
  const [mode] = prologModes;
  if (mode) {
    return {
      mode,
      command: classification?.recovery?.command || null,
      reason: mode === "continue_current_flow"
        ? "No semantic blocker or history-poisoned recovery path is currently active."
        : `Deterministic diagnostics recommend ${mode}.`,
    };
  }

  return {
    mode: classification?.recovery?.mode || "none",
    command: classification?.recovery?.command || null,
    reason: classification?.recovery?.reason || "No explicit recovery path was derived.",
  };
}

function analyzeStructuralTokenRendering({
  goal,
  planContent,
  verificationContent,
  plannedFiles,
  knowledgeResolution,
}) {
  const combinedText = [goal, planContent, verificationContent].filter(Boolean).join("\n");
  const normalizedText = normalizeText(combinedText);
  const normalizedPaths = uniqueNormalizedPaths(plannedFiles);
  const obligations = knowledgeResolution?.verification_obligation_synthesis?.obligations || [];
  const browserUiObligation = obligations.some((entry) => entry?.id === "browser_ui");

  const tokenSignals = uniqueList([
    /\{\{\s*[A-Z0-9_-]+\s*:/i.test(combinedText) ? "double_curly_marker" : null,
    includesAnyPhrase(normalizedText, ["structural token"]) ? "structural_token" : null,
    includesAnyPhrase(normalizedText, ["marker token"]) ? "marker_token" : null,
    includesAnyPhrase(normalizedText, ["synthetic token"]) ? "synthetic_token" : null,
    includesAnyPhrase(normalizedText, ["placeholder", "placeholders"]) ? "placeholder" : null,
    includesAnyPhrase(normalizedText, ["media extender", "media-extender"]) ? "media_extender" : null,
  ]);

  const rendererSignals = uniqueList([
    browserUiObligation ? "browser_ui_obligation" : null,
    includesAnyPhrase(normalizedText, ["renderer", "rendered", "preview", "change review", "frontend", "ui component", "review card"]) ? "ui_render_surface" : null,
    includesAnyPhrase(normalizedText, ["dompurify", "dangerouslysetinnerhtml", "html sanitizer", "sanitizer"]) ? "html_sanitizer_surface" : null,
    ...normalizedPaths
      .filter((filePath) => /\.(tsx|jsx|vue|svelte|html|css)$/i.test(filePath) || /component|preview|review|render/i.test(filePath))
      .map((filePath) => `file:${filePath}`),
  ]);

  const rendererContractExplicit =
    (/\b(intercept|style|parse|convert|replace|decorate|render(?:er)? contract|frontend renderer)\b/i.test(combinedText) &&
      /\b(token|tokens|placeholder|placeholders|marker|markers)\b/i.test(combinedText)) ||
    /\b(before sanitization|before the html renderer|before dangerouslysetinnerhtml)\b/i.test(combinedText);

  const visualProofExplicit = /\b(browser journey|browser e2e|visual proof|manual observation|playwright|selenium|end[- ]to[- ]end)\b/i.test(combinedText);
  const active = tokenSignals.length > 0 && rendererSignals.length > 0;

  return {
    active,
    tokenSignals,
    rendererSignals,
    browserUiObligation,
    rendererContractExplicit,
    visualProofExplicit,
    needsRendererContract: active && !rendererContractExplicit,
    needsVisualProof: active && !visualProofExplicit,
  };
}

const CMS_MISSING_CONTENT_TURBULENCE_QUESTION = "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?";

function analyzeCmsMissingContentDiagnosis({
  goal,
  planContent,
  verificationContent,
  classification,
  knowledgeResolution,
}) {
  const combinedText = [goal, planContent, verificationContent].filter(Boolean).join("\n");
  const normalizedText = normalizeText(combinedText);
  const active = classification?.signals?.cms_missing_content_incident === true ||
    (knowledgeResolution?.verification_obligation_synthesis?.obligations || []).some((entry) => entry?.id === "cms_missing_content_diagnosis");

  if (!active) {
    return {
      active: false,
      turbulenceQuestionRecorded: false,
      rawHtmlProbeRecorded: false,
      branchLogicRecorded: false,
      entityPreservationRecorded: false,
      warningActive: false,
      repairableVariances: [],
    };
  }

  const turbulenceQuestionRecorded = combinedText.includes(CMS_MISSING_CONTENT_TURBULENCE_QUESTION);
  const rawHtmlProbeRecorded = includesAnyPhrase(normalizedText, [
    "probe the exact broken url via curl",
    "probe the exact broken url via browser/raw html",
    "raw html/dom probe",
    "raw html",
    "curl",
    "browser/raw html",
    "browser journey",
    "dom probe",
  ]);
  const zeroByteBranchRecorded = includesAnyPhrase(normalizedText, [
    "0 bytes",
    "0 byte",
    "zero-byte",
    "zero byte",
    "frontend/theme/page-builder/render crash",
    "theme/page-builder/render crash",
    "ui/theme crash",
  ]);
  const backendBranchRecorded = includesAnyPhrase(normalizedText, [
    "query-driven collections are empty",
    "arrays are empty",
    "database/query failure",
    "backend/query investigation is allowed",
    "backend/query investigation",
  ]);
  const entityPreservationRecorded = includesAnyPhrase(normalizedText, [
    "do not migrate custom post types",
    "do not migrate cpts",
    "block cpt migrations",
    "entity preservation",
    "direct db proof",
    "direct database query",
    "existing structure is the failing node",
  ]);
  const branchLogicRecorded = zeroByteBranchRecorded && backendBranchRecorded;

  const repairableVariances = [];
  if (!turbulenceQuestionRecorded) {
    repairableVariances.push({
      kind: "cms_missing_content_diagnosis_gap",
      detail: "missing_turbulence_question",
    });
  }
  if (!rawHtmlProbeRecorded) {
    repairableVariances.push({
      kind: "cms_missing_content_diagnosis_gap",
      detail: "missing_raw_html_dom_probe",
    });
  }
  if (!branchLogicRecorded) {
    repairableVariances.push({
      kind: "cms_missing_content_diagnosis_gap",
      detail: "missing_render_vs_query_branch",
    });
  }
  if (!entityPreservationRecorded) {
    repairableVariances.push({
      kind: "cms_missing_content_diagnosis_gap",
      detail: "missing_entity_preservation",
    });
  }

  return {
    active,
    turbulenceQuestionRecorded,
    rawHtmlProbeRecorded,
    branchLogicRecorded,
    entityPreservationRecorded,
    warningActive: repairableVariances.length > 0,
    repairableVariances,
  };
}

function buildNextBestActions({
  classification,
  cmsMissingContentDiagnosis,
  knowledgeResolution,
  semanticBlocks,
  storyRegistryHealth,
  recommendedRecovery,
  prologActions,
  gateName,
}) {
  const actions = [];
  const seen = new Set();

  function pushAction(id, command, reason) {
    if (seen.has(id)) return;
    seen.add(id);
    actions.push({ id, command: command || null, reason });
  }

  for (const action of prologActions) {
    if (action === "run_recover_poison") {
      pushAction("run_recover_poison", recommendedRecovery.command, "Recover the poisoned plan tail before taking another planner step.");
    } else if (action === "run_story_bootstrap") {
      pushAction("run_story_bootstrap", "/story-bootstrap", "Bootstrap the story registry so adjacency, evidence-chain, and conflict checks can fire on real project behavior.");
    } else if (action === "resolve_semantic_blocks") {
      pushAction("resolve_semantic_blocks", null, gateName
        ? `Fix the semantic blockers before re-running ${gateName}.`
        : "Fix the semantic blockers before proceeding.");
    } else if (action === "verify_structural_token_renderer") {
      pushAction("verify_structural_token_renderer", null, "Add explicit renderer handling and browser-visible proof for structural token output before trusting raw HTML rendering.");
    } else if (action === "record_visual_evidence") {
      pushAction("record_visual_evidence", null, "Record browser-visible proof or a structured manual observation for the touched UI surface before closing the change.");
    } else if (action === "run_integration_probe") {
      pushAction("run_integration_probe", null, "Run a dry-run, API probe, or integration smoke against the touched integration surface.");
    } else if (action === "verify_mutually_exclusive_flags") {
      pushAction("verify_mutually_exclusive_flags", null, "Add contradiction proof for changed config flags, including any @planner:mutually_exclusive facts that keep runtime modes honest.");
    } else if (action === "verify_postconditions") {
      pushAction("verify_postconditions", null, "Record the expected postcondition or state-transition proof for the touched flow before closing.");
    } else if (action === "verify_quant_temporal_split") {
      pushAction("verify_quant_temporal_split", null, "Add temporal split or walk-forward evidence for the quant model/signal change.");
    } else if (action === "verify_quant_leakage_check") {
      pushAction("verify_quant_leakage_check", null, "Run a leakage check for the quant prediction path before trusting the new signal.");
    } else if (action === "verify_quant_calibration") {
      pushAction("verify_quant_calibration", null, "Add calibration or benchmark evidence for the changed quant output surface.");
    } else if (action === "verify_quant_backtest_or_parity") {
      pushAction("verify_quant_backtest_or_parity", null, "Run a backtest or live-parity proof for the changed quant execution logic.");
    } else if (action === "review_stale_high_remediation") {
      pushAction("review_stale_high_remediation", null, "Drain, re-rank, or explicitly waive stale HIGH remediation items before treating the planner surface as healthy.");
    } else if (action === "populate_adjacency") {
      pushAction("populate_adjacency", null, "Record sibling/importer/adjacent-module coverage so the planner can prove the bug was generalized beyond the first touched file.");
    } else if (action === "fill_domain_checklist") {
      pushAction("fill_domain_checklist", null, "Replace generic domain-checklist examples with repo-specific checks that match the active archetype and workflow risk.");
    } else if (action === "declare_mutually_exclusive_facts") {
      pushAction("declare_mutually_exclusive_facts", null, "Add `@planner:config_flag` and `@planner:mutually_exclusive` annotations for contradictory runtime modes before relying on config-integrity reasoning.");
    } else if (action === "add_story_postconditions") {
      pushAction("add_story_postconditions", null, "Add postconditions for the affected stateful stories so the ontology can reason about the expected end state.");
    } else if (action === "declare_story_conflicts") {
      pushAction("declare_story_conflicts", null, "Declare conflicting story outcomes for the touched stateful flow so contradiction checks can fire deterministically.");
    } else if (action === "proceed_lightweight") {
      pushAction("proceed_lightweight", "Use task.md + implementation_plan.md + walkthrough.md via /safe-change", "The current task shape is better served by the lightweight flow.");
    } else if (action === "proceed_full_flow") {
      pushAction("proceed_full_flow", "node .agent/skills/iterative-planner/scripts/bootstrap.mjs new \"<goal>\"", "The current task shape should remain in the full iterative planner.");
    }
  }

  if (semanticBlocks.length > 0) {
    pushAction("inspect_semantic_blocks", null, "Review the semantic blockers first; they represent real proof or integrity gaps.");
  }

  if (storyRegistryHealth?.blocking) {
    pushAction(
      "repair_story_registry",
      "node .agent/skills/iterative-planner/scripts/story_registry.mjs check --json",
      storyRegistryHealth.detail || "Repair invalid story registry state before trusting story-guided planning."
    );
  }

  if (cmsMissingContentDiagnosis?.active) {
    if (!cmsMissingContentDiagnosis.turbulenceQuestionRecorded) {
      pushAction(
        "ask_cms_turbulence_question",
        null,
        `Ask exactly: "${CMS_MISSING_CONTENT_TURBULENCE_QUESTION}"`
      );
    }
    if (!cmsMissingContentDiagnosis.rawHtmlProbeRecorded) {
      pushAction(
        "probe_cms_raw_html_dom",
        null,
        "Probe the exact broken URL via curl or browser/raw HTML before backend speculation."
      );
    }
    if (!cmsMissingContentDiagnosis.branchLogicRecorded) {
      pushAction(
        "classify_cms_render_vs_query_branch",
        null,
        "If the expected content block is missing or 0 bytes, treat it as a frontend/theme/page-builder/render crash; if the HTML shell exists but query-driven collections are empty, backend/query investigation is allowed."
      );
    }
    if (!cmsMissingContentDiagnosis.entityPreservationRecorded) {
      pushAction(
        "preserve_cms_entities_until_db_proof",
        null,
        "Do not migrate custom post types, rewrite sync scripts, or alter the data structure until direct DB proof shows the current structure is the failing node."
      );
    }
  }

  if (classification?.workflow?.recommended) {
    pushAction(
      `workflow:${classification.workflow.recommended}`,
      classification.workflow.recommended,
      `Recommended workflow route: ${classification.workflow.recommended}.`
    );
  }

  if (knowledgeResolution?.recommended_entrypoint?.value && knowledgeResolution.recommended_entrypoint.value !== classification?.workflow?.recommended) {
    pushAction(
      `knowledge:${knowledgeResolution.recommended_entrypoint.value}`,
      knowledgeResolution.recommended_entrypoint.value,
      `Knowledge resolver suggests ${knowledgeResolution.recommended_entrypoint.value}.`
    );
  }

  if (knowledgeResolution?.gap_check_needed && knowledgeResolution?.draft_promotion_contract?.review_surface?.relative_path) {
    pushAction(
      "review_draft_knowledge_candidates",
      knowledgeResolution?.draft_promotion_contract?.promotion_command || null,
      `Trusted retrieval is weak; reviewed draft candidates can be staged in ${knowledgeResolution.draft_promotion_contract.review_surface.relative_path} and promoted additively without changing planner truth until a later approval step.`
    );
  }

  return actions;
}

if (flags.help) {
  console.log(`planner_findings.mjs — deterministic semantic findings

Usage:
  node planner_findings.mjs --goal "<goal>" --json
  node planner_findings.mjs --json
  node planner_findings.mjs --dir <path> --plan <plan_dir_name> --gate <gate> --json
  node planner_findings.mjs --goal "<goal>" --file path/to/file --file another/file --gate plan-to-execute --json

Behavior:
  - Reuses the active plan by default when one exists
  - Composes planner preflight, knowledge resolution, canonicalization, and ontology-backed diagnostics
  - Stays read-only and deterministic — no AI calls and no plan mutation
`);
  process.exit(0);
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const explicitPlan = readFlagValue("--plan");
const explicitGoal = readFlagValue("--goal");
const explicitFiles = readFlagValues("--file");
const gateName = readFlagValue("--gate") || readFlagValue("--include-transition");
const { plansDir } = getPaths(cwd);
const skillPath = getSkillPath(import.meta.url);
const gatesJsonPath = join(skillPath, "config", "gates.json");
const gateRegistry = existsSync(gatesJsonPath)
  ? (safeReadJson(gatesJsonPath)?.gates || {})
  : {};

const target = resolvePlanTarget(plansDir, {
  plan: explicitPlan,
  exitOnMissing: false,
});
const hasResolvedPlan = !!target.planDir;
const usePlanContext = hasResolvedPlan && (!!explicitPlan || (!explicitGoal && explicitFiles.length === 0));
const stateJson = usePlanContext ? safeReadJson(join(target.planDir, "state.json")) : null;
const planContent = usePlanContext ? (readFile(join(target.planDir, "plan.md")) || "") : "";
const verificationContent = usePlanContext ? (readFile(join(target.planDir, "verification.md")) || "") : "";
const planGoal = extractGoalFromPlanContent(planContent);
const goal = uniqueList([
  explicitGoal,
  typeof stateJson?.goal === "string" ? stateJson.goal : "",
  planGoal,
])[0] || "";
const plannedFilesFromPlan = extractFilesToModify(planContent);
const plannedFiles = uniqueList([...plannedFilesFromPlan, ...explicitFiles]);
const intentContractInfo = usePlanContext ? loadIntentContract(target.planDir) : null;
const intentAnalysis = intentContractInfo?.parsed
  ? analyzeIntentContract(intentContractInfo.parsed, { goalText: goal })
  : null;
const recipeResolution = resolveRecipeRequest({ cwd, goalText: goal });
const poisonedEntries = usePlanContext
  ? findPoisonedGateHistories(stateJson?.transitions || [], gateRegistry)
  : [];
const activePlanPoisoned = poisonedEntries.length > 0;
const classification = applyRecipeResolutionToClassification(
  classifyPlannerPreflight(goal, {
    plannedFiles,
    hasActivePlan: usePlanContext,
    activePlanPoisoned,
    activePlanState: stateJson?.state || null,
    intentAnalysis,
  }),
  recipeResolution
);
const knowledgeResolution = resolveKnowledgeFromContext({
  cwd,
  goalText: goal,
  plannedFiles,
  stateJson,
  planDir: usePlanContext ? target.planDir : null,
  planDirName: usePlanContext ? target.planDirName : null,
  planContent,
  verificationContent,
  classificationHints: classification,
});
const manifestoInfo = loadPlannerManifesto({ skillPath });
const canonicalization = collectPlannerCanonicalization({
  planContent,
  verificationContent,
});
const structuralTokenRendering = analyzeStructuralTokenRendering({
  goal,
  planContent,
  verificationContent,
  plannedFiles,
  knowledgeResolution,
});
const cmsMissingContentDiagnosis = analyzeCmsMissingContentDiagnosis({
  goal,
  planContent,
  verificationContent,
  classification,
  knowledgeResolution,
});
const storyRegistryHealth = analyzeStoryRegistryHealth(cwd);
const proofTelemetry = summarizeProofTelemetry({
  cwd,
  planDir: usePlanContext ? target.planDir : null,
  planDirName: usePlanContext ? target.planDirName : null,
  goalText: goal,
  planContent,
  plannedFiles,
  archetype: knowledgeResolution.discovery_policy?.archetype || null,
  persist: true,
});
const annotationContext = collectScopedAnnotationContext({
  cwd,
  planDir: usePlanContext ? target.planDir : null,
  planContent,
  plannedFiles,
  scope: usePlanContext ? "planned_plus_nearby" : "repo_wide_fallback",
});
const substrateSignals = collectSubstrateSignals({
  cwd,
  planDir: usePlanContext ? target.planDir : null,
  goal,
  planContent,
  verificationContent,
  plannedFiles,
  proofTelemetry,
  archetype: knowledgeResolution.discovery_policy?.archetype || null,
  annotationContext,
});
const semanticEngine = withPlannerTarget(target.planDirName, () => createSemanticEngine({
  cwd,
  skillPath,
  refreshOntology: true,
}));
const semanticDiagnostics = querySemanticDiagnostics({
  session: semanticEngine.session,
  gateName,
  gateRegistry,
  classification,
  canonicalization,
  structuralTokenRendering,
  substrateSignals,
});
const storyRegistrySemanticBlocks = storyRegistryHealth.blocking
  ? [{ kind: "story_registry_invalid", detail: storyRegistryHealth.detail }]
  : [];
const semanticBlocks = [
  ...semanticDiagnostics.semanticBlocks,
  ...storyRegistrySemanticBlocks,
];
const minimalRepairSet = [
  ...semanticDiagnostics.minimalRepairSet,
  ...storyRegistrySemanticBlocks,
];
const combinedRepairableVariances = uniqueList([
  ...semanticDiagnostics.repairableVariances.map((entry) => JSON.stringify(entry)),
  ...cmsMissingContentDiagnosis.repairableVariances.map((entry) => JSON.stringify(entry)),
]).map((entry) => JSON.parse(entry));
const semanticSubstrate = summarizeSemanticSubstrate({
  substrateSignals,
  repairableVariances: combinedRepairableVariances,
  annotationContext,
});
const authorityProfile = resolveAuthorityProfile({
  state: usePlanContext ? stateJson?.state : "explore",
  gateName,
  gateDef: gateRegistry[gateName],
});
const proofPosture = resolveProofPosture({
  state: authorityProfile.phase,
  gateName,
  gateDef: gateRegistry[gateName],
});
const phaseContract = buildPhaseContract({
  authorityProfile,
  proofPosture,
});
const manifestoAlignmentSignals = uniqueList([
  ...(knowledgeResolution.manifesto_alignment_signals || []),
  ...deriveManifestoAlignmentSignals({
    classification,
    knowledgeResolution,
    activePlanPoisoned,
  }),
]);
const recommendedRecovery = buildRecommendedRecovery({
  prologModes: semanticDiagnostics.recommendedRecoveryModes,
  classification,
});
const nextBestActions = buildNextBestActions({
  classification,
  cmsMissingContentDiagnosis,
  knowledgeResolution,
  semanticBlocks,
  storyRegistryHealth,
  recommendedRecovery,
  prologActions: semanticDiagnostics.nextBestActions,
  gateName,
});
const postureRoute = computeRecommendedPath({
  workflow: knowledgeResolution?.recommended_entrypoint?.value || classification.workflow.recommended,
  classification,
  semanticBlocks,
  repairableVariances: combinedRepairableVariances,
  semanticSubstrate,
  symmetryHunts: knowledgeResolution?.symmetry_hunts || [],
});

const taskProfileContract = deriveTaskProfileContract({
  goalText: goal,
  classification,
  plannedFiles,
  recipeResolution,
});
const semanticUpkeepContract = evaluateSemanticUpkeepContract({
  planContent,
  goalText: goal,
  classification,
  plannedFiles,
  recipeResolution,
});
const adversarialProfile = computeAdversarialAuditProfile({
  discoveryArchetype: knowledgeResolution?.discovery_policy?.archetype || null,
  verificationObligationSynthesis: knowledgeResolution?.verification_obligation_synthesis || null,
  personaSummary: knowledgeResolution?.persona_signals || null,
  repairableVariances: combinedRepairableVariances,
  semanticBlocks,
  symmetryHunts: knowledgeResolution?.symmetry_hunts || [],
});
const {
  suggested_attack_vectors: suggestedAttackVectors,
  ...adversarialProfileSummary
} = adversarialProfile;
const antiRitual = resolveAntiRitualAssessment({
  classification,
  recovery: recommendedRecovery,
  workflow: knowledgeResolution?.recommended_entrypoint?.value || classification.workflow.recommended,
  recommendedPath: postureRoute.recommended_path,
  authorityProfile,
  phaseContract,
  semanticBlocks,
  repairableVariances: combinedRepairableVariances,
  semanticSubstrate,
  validation: {
    validation_bundle: taskProfileContract.validation_bundle,
    proof_posture: proofPosture,
  },
  activePlanPoisoned,
  canonicalization,
});

const payload = {
  generated_at: new Date().toISOString(),
  cwd,
  goal,
  gate: gateName || null,
  active_plan: {
    present: hasResolvedPlan,
    used_for_findings: usePlanContext,
    source: target.source || null,
    plan_dir_name: target.planDirName || null,
    state: typeof stateJson?.state === "string" ? stateJson.state : null,
    poisoned: activePlanPoisoned,
    poisoned_gates: poisonedEntries.map((entry) => ({
      gate: entry.gate,
      consecutive_fails: entry.consecutiveFails,
      failure_codes: entry.failureCodes,
    })),
  },
  project_manifesto: {
    path: manifestoInfo.path,
    present: manifestoInfo.present,
    usable: manifestoInfo.usable,
    version: manifestoInfo.manifesto.version,
    hard_policies: (manifestoInfo.manifesto.hard_policies || []).map((policy) => policy.id),
    ontology_role: manifestoInfo.manifesto.ontology_role?.mode || null,
  },
  north_star: manifestoInfo.manifesto.north_star,
  hard_policy_mode: manifestoInfo.manifesto.hard_policy_mode,
  manifesto_alignment_signals: manifestoAlignmentSignals,
  authority_profile: authorityProfile,
  proof_posture: proofPosture,
  phase_contract: phaseContract,
  phase_profiles: {
    reflect: buildPhaseContract({
      authorityProfile: resolveAuthorityProfile({ phase: "reflect" }),
      proofPosture: resolveProofPosture({ phase: "reflect" }),
    }),
    validate: buildPhaseContract({
      authorityProfile: resolveAuthorityProfile({ phase: "validate" }),
      proofPosture: resolveProofPosture({ phase: "validate" }),
    }),
    close: buildPhaseContract({
      authorityProfile: resolveAuthorityProfile({ phase: "close" }),
      proofPosture: resolveProofPosture({ phase: "close" }),
    }),
  },
  audit_posture: postureRoute.audit_posture,
  recommended_path: (
    antiRitual.recommended_action === "downgrade_to_lightweight" ||
    antiRitual.recommended_action === "recover_then_lightweight"
  ) ? "continue" : postureRoute.recommended_path,
  recommended_path_reason: (
    antiRitual.recommended_action === "downgrade_to_lightweight" ||
    antiRitual.recommended_action === "recover_then_lightweight"
  ) ? `Anti-ritual contract: ${antiRitual.detail}` : postureRoute.reason,
  task_profile_id: taskProfileContract.task_profile.id,
  task_profile: taskProfileContract.task_profile,
  semantic_upkeep: semanticUpkeepContract.semantic_upkeep,
  validation_bundle: taskProfileContract.validation_bundle,
  strictness_mode: taskProfileContract.strictness_mode,
  semantic_upkeep_contract: {
    required: semanticUpkeepContract.required,
    present: semanticUpkeepContract.present,
    complete: semanticUpkeepContract.complete,
    detail: semanticUpkeepContract.detail,
    missing_fields: semanticUpkeepContract.missing_fields,
  },
  flow_mode: classification.flow.mode,
  evidence_mode: classification.evidence.mode,
  workflow: classification.workflow.recommended,
  canonicalization_summary: canonicalization,
  proof_telemetry: semanticEngine.proofTelemetry || proofTelemetry,
  structural_token_rendering: {
    active: structuralTokenRendering.active,
    token_signals: structuralTokenRendering.tokenSignals,
    renderer_signals: structuralTokenRendering.rendererSignals,
    browser_ui_obligation: structuralTokenRendering.browserUiObligation,
    renderer_contract_explicit: structuralTokenRendering.rendererContractExplicit,
    visual_proof_explicit: structuralTokenRendering.visualProofExplicit,
  },
  cms_missing_content_diagnosis: {
    active: cmsMissingContentDiagnosis.active,
    turbulence_question_recorded: cmsMissingContentDiagnosis.turbulenceQuestionRecorded,
    raw_html_dom_probe_recorded: cmsMissingContentDiagnosis.rawHtmlProbeRecorded,
    branch_logic_recorded: cmsMissingContentDiagnosis.branchLogicRecorded,
    entity_preservation_recorded: cmsMissingContentDiagnosis.entityPreservationRecorded,
    warning_active: cmsMissingContentDiagnosis.warningActive,
  },
  story_registry_health: storyRegistryHealth,
  semantic_blocks: semanticBlocks,
  semantic_substrate: semanticSubstrate,
  adversarial_profile: adversarialProfileSummary,
  suggested_attack_vectors: suggestedAttackVectors,
  knowledge_trust_summary: knowledgeResolution?.trust_summary || null,
  knowledge_match_summary: {
    trusted_match_ids: knowledgeResolution?.recommended_path_provenance?.trusted_match_ids || [],
    derived_match_ids: knowledgeResolution?.recommended_path_provenance?.derived_match_ids || [],
    blocker_capable_match_ids: knowledgeResolution?.recommended_path_provenance?.blocker_capable_match_ids || [],
    gap_check_needed: knowledgeResolution?.gap_check_needed === true,
  },
  draft_promotion_contract: knowledgeResolution?.draft_promotion_contract || null,
  symmetry_hunts: knowledgeResolution?.symmetry_hunts || [],
  repairable_variances: uniqueList([
    ...combinedRepairableVariances.map((entry) => JSON.stringify(entry)),
  ]).map((entry) => JSON.parse(entry)),
  recommended_recovery: recommendedRecovery,
  minimal_repair_set: minimalRepairSet,
  verification_obligations: (knowledgeResolution.verification_obligation_synthesis?.obligations || []).map((obligation) => ({
    id: obligation.id,
    label: obligation.label,
    verification_mode: obligation.verification_mode,
    required_proof_type: obligation.required_proof_type,
  })),
  related_stories: (knowledgeResolution.related_stories || []).slice(0, 6),
  related_retros: (knowledgeResolution.related_retros || []).slice(0, 6),
  invariant_violations: semanticDiagnostics.invariantViolations,
  invariant_warnings: semanticDiagnostics.invariantWarnings,
  next_best_actions: nextBestActions,
  anti_ritual: antiRitual,
};

if (flags.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  console.log("Planner Findings");
  console.log(`Goal: ${payload.goal || "(not provided)"}`);
  console.log(`North star: ${payload.north_star}`);
  console.log(`Task profile: ${payload.task_profile_id}`);
  console.log(`Flow/Evidence: ${payload.flow_mode} / ${payload.evidence_mode}`);
  console.log(`Validation bundle / strictness: ${payload.validation_bundle.id} / ${payload.strictness_mode}`);
  console.log(`Authority / posture / path: ${payload.authority_profile.phase} / ${payload.audit_posture} / ${payload.recommended_path}`);
  if (payload.gate) console.log(`Gate: ${payload.gate}`);
  console.log(`Proof posture: ${payload.proof_posture.label}`);
  console.log(`Recovery: ${payload.recommended_recovery.mode}${payload.recommended_recovery.command ? ` -> ${payload.recommended_recovery.command}` : ""}`);
  if (payload.knowledge_trust_summary) {
    console.log(
      `Knowledge trust: trusted=${payload.knowledge_trust_summary.trusted_count} derived=${payload.knowledge_trust_summary.derived_count} draft=${payload.knowledge_trust_summary.draft_count}`
    );
    if (payload.knowledge_trust_summary.gap_check_needed) {
      console.log(`Draft gap check: ${payload.knowledge_trust_summary.gap_check_reason || "trusted retrieval is weak"}`);
    }
  }
  if (payload.anti_ritual?.status !== "clean") {
    console.log(`Anti-ritual: ${payload.anti_ritual.status} (${payload.anti_ritual.recommended_action})`);
    console.log(`Detail: ${payload.anti_ritual.detail}`);
  }
  if (payload.manifesto_alignment_signals.length > 0) {
    console.log(`Manifesto alignment: ${payload.manifesto_alignment_signals.join(", ")}`);
  }
  if (payload.semantic_blocks.length > 0) {
    console.log(`Semantic blocks: ${payload.semantic_blocks.map((entry) => `${entry.kind}: ${entry.detail}`).join("; ")}`);
  }
  if (payload.related_retros.length > 0) {
    console.log(`Related retros: ${payload.related_retros.map((entry) => entry.id).join(", ")}`);
  }
  if (payload.adversarial_profile?.required) {
    console.log(`Adversarial profile: ${payload.adversarial_profile.label}`);
    console.log(`Objective: ${payload.adversarial_profile.adversarial_objective}`);
    if (payload.suggested_attack_vectors.length > 0) {
      console.log(`Suggested attack vectors: ${payload.suggested_attack_vectors.map((entry) => entry.id).join(", ")}`);
    }
  }
  if (payload.repairable_variances.length > 0) {
    console.log(`Repairable variance: ${payload.repairable_variances.map((entry) => `${entry.kind}: ${entry.detail}`).join("; ")}`);
  }
  if (payload.next_best_actions.length > 0) {
    console.log("Next best actions:");
    for (const action of payload.next_best_actions) {
      console.log(`- ${action.id}: ${action.reason}${action.command ? ` (${action.command})` : ""}`);
    }
  }
}
