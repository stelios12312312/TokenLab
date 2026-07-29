#!/usr/bin/env node
// gate_prepare.mjs — Prepare deterministic gate-owned artifact structure.
//
// Usage:
//   node gate_prepare.mjs <gate> --plan <plan-dir> [--json] [--write]

import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import {
  analyzeRedTeamNotes,
  analyzeFindingsDepth,
  countIndexedFindings,
  extractMarkdownSection,
  extractFilesToModify,
  getPaths,
  loadFindingsLedger,
  readFile,
  resolveFindingsTruth,
  resolvePlanTarget,
  syncFindingsMarkdownFromLedger,
} from "./lib/plan_utils.mjs";
import { collectScopedAnnotationContext } from "./lib/semantic_substrate.mjs";
import { computeLearnedObligationsSignal } from "./lib/learned_obligations.mjs";
import { computeMistakeRegistrySignal } from "./lib/mistake_registry.mjs";
import { refreshPlanArtifacts } from "./lib/plan_refresh.mjs";
import { buildReflectionGuide, writeReflectionGuide } from "./lib/reflection_guide.mjs";
import {
  getVerificationStrategyPath,
  lintVerificationStrategy,
  scaffoldVerificationStrategy,
} from "./lib/verification_strategy.mjs";
import { computeVerificationObligationSynthesis } from "./lib/verification_obligations.mjs";
import { buildGuidanceReminder, renderGuidanceReminder } from "./lib/guidance_reminder.mjs";
import { deriveVerificationTruth } from "./lib/verification_truth.mjs";

const SUPPORTED_GATES = new Set([
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
]);

const STRUCTURAL_ONLY_NOTE = "Structural scaffold only; gate_prepare did not accept evidence, mark proof sufficient, or pass the gate.";

function parseArgs(argv) {
  const args = { gate: argv[2] || "help", plan: null, json: false, write: false };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--write") {
      args.write = true;
      continue;
    }
    if (token === "--plan") {
      args.plan = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/gate_prepare.mjs <gate> --plan <plan-dir> [--json] [--write]",
    "",
    "Supported gates:",
    "  explore-to-plan, plan-to-execute, execute-to-reflect, reflect-to-validate, validate-to-close",
    "",
    "Notes:",
    "  --json emits a deterministic semantic precompile report.",
    "  --write only creates or appends structural TODO/UNVERIFIED slots; it never records proof or accepts decisions.",
  ].join("\n");
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function writeTextIfChanged(path, content) {
  const next = String(content || "");
  const current = readFile(path);
  if (current === next) return { path, written: false, reason: "already_current" };
  writeFileSync(path, next);
  return { path, written: true, reason: current === null ? "created" : "updated" };
}

function loadStoryRegistry(cwd) {
  return readJson(join(cwd, "reports", "user_story_audit", "story_registry.json"));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueStrings(values) {
  return [...new Set(normalizeArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function sectionPresent(content, heading) {
  return Boolean(extractMarkdownSection(content || "", heading).trim());
}

function sectionHasToken(content, heading, token) {
  return extractMarkdownSection(content || "", heading).includes(token);
}

function countCompletedProgressItems(content) {
  return ((content || "").match(/^- \[x\] .+$/gim) || []).length;
}

function contentHasProofBlock(content) {
  const proof = extractMarkdownSection(content || "", "Proof of Work");
  return /```[\s\S]+?```/.test(proof) || /\bUNVERIFIED:/i.test(proof);
}

function findSectionRange(content, heading) {
  const text = String(content || "");
  const pattern = new RegExp(`(^##\\s+${escapeRegex(heading)}\\s*$)`, "im");
  const match = text.match(pattern);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const next = text.slice(afterHeading).search(/\n##\s+/);
  const end = next === -1 ? text.length : afterHeading + next;
  return { start, afterHeading, end };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureMarkdownSection(filePath, heading, body, actions) {
  const current = readFile(filePath) || "";
  if (sectionPresent(current, heading)) {
    actions.push({ id: `section:${heading}`, file: filePath, status: "already_present", truthfulness: "existing_content_preserved" });
    return current;
  }
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : "";
  const next = `${prefix}## ${heading}\n${String(body || "").trim()}\n`;
  const write = writeTextIfChanged(filePath, next);
  actions.push({
    id: `section:${heading}`,
    file: filePath,
    status: write.written ? write.reason : "already_present",
    truthfulness: STRUCTURAL_ONLY_NOTE,
  });
  return next;
}

function appendToSectionIfMissingTokens(filePath, heading, tokens, block, actions, actionId) {
  let current = readFile(filePath) || "";
  if (!sectionPresent(current, heading)) {
    current = ensureMarkdownSection(filePath, heading, "", actions);
  }
  const missingTokens = uniqueStrings(tokens).filter((token) => !sectionHasToken(current, heading, token));
  if (missingTokens.length === 0) {
    actions.push({ id: actionId, file: filePath, status: "already_present", tokens: uniqueStrings(tokens), truthfulness: "existing_content_preserved" });
    return;
  }

  const range = findSectionRange(current, heading);
  if (!range) return;
  const insertion = `\n${String(block || "").trim()}\n`;
  const next = `${current.slice(0, range.end).trimEnd()}${insertion}${current.slice(range.end)}`;
  const write = writeTextIfChanged(filePath, next);
  actions.push({
    id: actionId,
    file: filePath,
    status: write.written ? "appended_missing_tokens" : "already_present",
    tokens: missingTokens,
    truthfulness: STRUCTURAL_ONLY_NOTE,
  });
}

function upsertGeneratedBlock(filePath, blockId, body, actions, label = blockId) {
  const start = `<!-- gate_prepare:${blockId}:start -->`;
  const end = `<!-- gate_prepare:${blockId}:end -->`;
  const current = readFile(filePath) || "";
  const block = `${start}\n${String(body || "").trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`);
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  const write = writeTextIfChanged(filePath, next);
  actions.push({
    id: `generated_block:${label}`,
    file: filePath,
    status: write.written ? write.reason : "already_current",
    truthfulness: STRUCTURAL_ONLY_NOTE,
  });
}

function summarizeWriteActions(actions) {
  return actions.map((action) => ({
    id: action.id,
    file: action.file ? action.file.replace(process.cwd(), "").replace(/^\/+/, "") : null,
    status: action.status,
    truthfulness: action.truthfulness,
    tokens: action.tokens,
  }));
}

function resolvePlan(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  if (!planArg) {
    const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
    if (!target.planDirName) return { ok: false, error: "No active plan found" };
    return { ok: true, planDirName: target.planDirName, planDir: join(plansDir, target.planDirName), source: target.source || "pointer" };
  }
  const candidate = isAbsolute(planArg)
    ? planArg
    : planArg.includes("/") || planArg.includes("\\")
      ? resolve(cwd, planArg)
      : join(plansDir, planArg);
  return {
    ok: existsSync(candidate),
    planDirName: basename(candidate),
    planDir: candidate,
    source: planArg,
    error: existsSync(candidate) ? null : `Plan directory not found: ${candidate}`,
  };
}

function buildContext({ cwd, resolved, gate }) {
  const planDir = resolved.planDir;
  const planDirName = resolved.planDirName;
  const planContent = readFile(join(planDir, "plan.md")) || "";
  const progressContent = readFile(join(planDir, "progress.md")) || "";
  const verificationContent = readFile(join(planDir, "verification.md")) || "";
  const redTeamContent = readFile(join(planDir, "red_team_notes.md")) || "";
  const reflectionContent = readFile(join(planDir, "reflection.md")) || "";
  const stateJson = readJson(join(planDir, "state.json")) || {};
  const storyRegistry = loadStoryRegistry(cwd);
  const plannedFiles = extractFilesToModify(planContent);
  const annotationContext = collectScopedAnnotationContext({
    cwd,
    planDir,
    planContent,
    plannedFiles,
    scope: "planned_plus_nearby",
  });
  const strategyLint = lintVerificationStrategy({ cwd, planDir, planContent });
  const mistakeSignal = computeMistakeRegistrySignal({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry,
  });
  const learnedObligations = computeLearnedObligationsSignal({
    cwd,
    planDir,
    stateJson,
    planContent,
    verificationContent,
    verificationLedger: readJson(join(planDir, "verification_ledger.json")),
    storyRegistry,
    mistakeSignal,
  });
  const verificationSynthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry,
  });
  const refresh = refreshPlanArtifacts({
    cwd,
    planDirName,
    persistState: false,
    persistOntology: false,
    syncFindings: false,
  });
  const reflectionGuide = gate === "reflect-to-validate"
    ? buildReflectionGuide({ cwd, planDir })
    : null;

  return {
    cwd,
    gate,
    planDir,
    planDirName,
    planContent,
    progressContent,
    verificationContent,
    redTeamContent,
    reflectionContent,
    stateJson,
    storyRegistry,
    plannedFiles,
    annotationContext,
    strategyLint,
    mistakeSignal,
    learnedObligations,
    verificationSynthesis,
    refresh,
    reflectionGuide,
  };
}

function buildExtractedSignals(context) {
  const storyCount = Array.isArray(context.storyRegistry?.stories) ? context.storyRegistry.stories.length : 0;
  const ontologyFactCount = typeof context.refresh?.ontology?.facts === "string"
    ? context.refresh.ontology.facts.split("\n").filter((line) => line.trim() && !line.trim().startsWith("%")).length
    : 0;
  return [
    {
      id: "planned_files",
      source: "plan.md",
      relevance_tier: context.plannedFiles.length > 0 ? "trusted" : "none",
      count: context.plannedFiles.length,
      values: context.plannedFiles,
    },
    {
      id: "verification_strategy",
      source: context.strategyLint?.source || "unknown",
      relevance_tier: context.strategyLint?.ok ? "trusted" : "trusted",
      ok: !!context.strategyLint?.ok,
      criteria_count: Array.isArray(context.strategyLint?.strategy?.criteria) ? context.strategyLint.strategy.criteria.length : 0,
      issues: context.strategyLint?.issues || [],
      warnings: context.strategyLint?.warnings || [],
    },
    {
      id: "story_registry",
      source: "reports/user_story_audit/story_registry.json",
      relevance_tier: storyCount > 0 ? "trusted" : "none",
      present: !!context.storyRegistry,
      story_count: storyCount,
    },
    {
      id: "annotation_context",
      source: "collectScopedAnnotationContext",
      relevance_tier: context.annotationContext?.scope_degraded ? "derived" : "trusted",
      annotation_count: normalizeArray(context.annotationContext?.annotations).length,
      trusted_annotation_count: normalizeArray(context.annotationContext?.trusted_annotations).length,
      scope_used: context.annotationContext?.scope_used,
      scope_degraded: !!context.annotationContext?.scope_degraded,
      scope_degraded_reason: context.annotationContext?.scope_degraded_reason || null,
    },
    {
      id: "ontology_facts",
      source: "refreshPlanArtifacts(persist=false)",
      relevance_tier: context.refresh?.ontology?.refreshed ? "trusted" : "derived",
      refreshed: !!context.refresh?.ontology?.refreshed,
      fact_count: ontologyFactCount,
      persisted: !!context.refresh?.ontology?.persisted,
      error: context.refresh?.ontology?.error || null,
    },
    {
      id: "active_mistakes",
      source: "mistake_registry",
      relevance_tier: context.mistakeSignal?.active_count > 0 ? "trusted" : "none",
      status: context.mistakeSignal?.status,
      active_ids: context.mistakeSignal?.active_ids || [],
      kb_refs: uniqueStrings(normalizeArray(context.mistakeSignal?.active_mistakes).flatMap((mistake) => mistake.kb_refs || [])),
    },
    {
      id: "learned_obligations",
      source: "learned_obligations",
      relevance_tier: context.learnedObligations?.required ? "trusted" : "none",
      status: context.learnedObligations?.status,
      active_ids: context.learnedObligations?.active_ids || [],
    },
    {
      id: "verification_obligation_synthesis",
      source: "verification_obligations",
      relevance_tier: context.verificationSynthesis?.required ? "trusted" : "none",
      status: context.verificationSynthesis?.status,
      obligation_ids: normalizeArray(context.verificationSynthesis?.obligations).map((obligation) => obligation.id),
      required_reporting_sections: context.verificationSynthesis?.required_reporting_sections || [],
    },
    {
      id: "generated_close_signals",
      source: "refreshPlanArtifacts(persist=false)",
      relevance_tier: "trusted",
      persisted: false,
      progress_satisfied: context.refresh?.closeSignals?.progress?.satisfied ?? null,
      kb_satisfied: context.refresh?.closeSignals?.kb?.satisfied ?? null,
      planner_core_satisfied: context.refresh?.closeSignals?.planner_core?.satisfied ?? null,
      test_evidence_satisfied: context.refresh?.closeSignals?.test_evidence?.satisfied ?? null,
      semantic_substrate_satisfied: context.refresh?.closeSignals?.semantic_substrate?.satisfied ?? null,
    },
  ];
}

function buildCandidateObligations(context) {
  const candidates = [];
  for (const mistake of normalizeArray(context.mistakeSignal?.active_mistakes)) {
    candidates.push({
      id: `mistake:${mistake.id}`,
      kind: "active_mistake",
      title: mistake.title,
      relevance_tier: "trusted",
      provenance: {
        source: "mistake_registry",
        matched_trigger_families: mistake.matched_trigger_families || [],
        matched_files: mistake.matched_files || [],
        matched_terms: mistake.matched_terms || [],
        kb_refs: mistake.kb_refs || [],
      },
      required_guards: mistake.required_guards || [],
      verification_hooks: mistake.verification_hooks || [],
      default_decision: "TODO: accept, reject, waive, or mark out of scope with evidence",
    });
  }
  for (const obligation of normalizeArray(context.verificationSynthesis?.obligations)) {
    candidates.push({
      id: `verification_obligation:${obligation.id}`,
      kind: "verification_obligation",
      title: obligation.label,
      relevance_tier: "trusted",
      provenance: {
        source: "verification_obligation_synthesis",
        source_signals: obligation.source_signals || [],
        matched_files: obligation.matched_files || [],
        matched_goal_terms: obligation.matched_goal_terms || [],
      },
      required_proof_type: obligation.required_proof_type,
      proof_ids: obligation.proof_ids || [],
      default_decision: "TODO: choose proof path or record explicit non-applicability",
    });
  }
  for (const obligation of normalizeArray(context.learnedObligations?.active_obligations)) {
    candidates.push({
      id: `learned_obligation:${obligation.id}`,
      kind: "learned_obligation",
      title: obligation.subject_id,
      relevance_tier: "trusted",
      provenance: {
        source: "learned_obligations",
        activation_source: obligation.activation_source,
        source_mistake: obligation.source_mistake || null,
        matched_files: obligation.matched_files || [],
      },
      verification_hooks: obligation.verification_hooks || [],
      guard_types: obligation.guard_types || [],
      default_decision: "TODO: record evidence or approved waiver",
    });
  }
  return candidates;
}

function buildDecisionSlots(candidates) {
  return candidates.map((candidate) => ({
    id: `${candidate.id}:decision`,
    candidate_id: candidate.id,
    status: "TODO",
    accepted: false,
    evidence_recorded: false,
    note: candidate.default_decision,
  }));
}

function buildTruthfulnessNotes(context) {
  return [
    "gate_prepare reports are generated from workspace files, plan state, story registry, annotations, and deterministic refresh output.",
    "Generated decisions default to TODO and generated proof fields default to UNVERIFIED.",
    "Read-only refresh output is not persisted to state.json by this command.",
    `verification_strategy_path=${getVerificationStrategyPath(context.planDir)}`,
  ];
}

function analyzeExploreToPlan(planDir) {
  const truth = resolveFindingsTruth(planDir);
  const missing = [];
  const checks = {
    indexed_findings: (truth.effective?.findingCount || 0) >= 3,
  };
  for (const [id, ok] of Object.entries(checks)) {
    if (!ok) missing.push(id);
  }
  return { checks, missing, truth };
}

function scaffoldFindingsLedger(planDir, analysis) {
  const ledgerPath = join(planDir, "findings_ledger.json");
  const existing = readJson(ledgerPath) || {};
  const planContent = readFile(join(planDir, "plan.md")) || "";
  const plannedFiles = extractFilesToModify(planContent);
  const now = new Date().toISOString();
  const ledger = {
    version: existing.version || 1,
    ...existing,
  };

  if (!Array.isArray(ledger.findings) || ledger.findings.length < 3) {
    ledger.findings = [
      {
        id: "F-001",
        title: "The live EXPLORE contract still needs simplification",
        summary: "The authoring scaffold records that the active planner still contains older EXPLORE ceremony that this plan is about to replace.",
        content: [
          "This scaffold gives the plan a real finding block instead of an empty placeholder.",
          "It is intended as structural preparation only and still needs task-specific refinement.",
          "The EXPLORE gate should only trust actual findings, not untouched template prose.",
        ],
      },
      {
        id: "F-002",
        title: "Three concise findings remain the minimum gate contract",
        summary: "The simplified v7 EXPLORE contract still expects three concrete findings even after ceremony is removed.",
        content: [
          "The scaffold therefore adds the minimum indexed finding count directly to findings_ledger.json.",
          "Human review can then replace or refine the scaffolded points with real exploration.",
          "The intent is to unblock structure, not to fake semantic investigation.",
        ],
      },
      {
        id: "F-003",
        title: "KB-read evidence still has to come from actual reading",
        summary: "Structural scaffolding should not pretend the knowledge base was read or that proof work already happened.",
        content: [
          "After the scaffold runs, the operator still has to read plans/knowledge and add the [READ KB] marker.",
          "That keeps gate_prepare focused on structure instead of backfilling proof ceremony.",
          "Semantic or proof failures still need real investigation rather than scaffolded success.",
        ],
      },
    ];
  }

  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const sync = syncFindingsMarkdownFromLedger(planDir, { allowMetadataOnlyOverwrite: true });
  return { ledger_path: ledgerPath, sync };
}

function analyzePlanToExecute(context) {
  const matchedCriteria = normalizeArray(context.strategyLint?.criterion_matches);
  const unmatchedCriteria = matchedCriteria.filter((entry) => !entry.matched || !entry.story_id);
  const checks = {
    verification_strategy_readable: !!context.strategyLint?.ok,
    verification_strategy_has_criteria: normalizeArray(context.strategyLint?.strategy?.criteria).length > 0,
    verification_obligation_synthesis_present: sectionPresent(context.planContent, "Verification Obligation Synthesis"),
    semantic_upkeep_contract_present: sectionPresent(context.planContent, "Semantic Upkeep Contract"),
    story_linkage_declared: matchedCriteria.length === 0 ? true : unmatchedCriteria.length === 0,
  };
  return {
    checks,
    missing: Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id),
    diagnostics: {
      verification_strategy_issues: context.strategyLint?.issues || [],
      unmatched_criteria: unmatchedCriteria,
    },
  };
}

function analyzeExecuteToReflect(context) {
  const redTeam = analyzeRedTeamNotes(context.redTeamContent);
  const activeHooks = uniqueStrings(normalizeArray(context.mistakeSignal?.active_mistakes).flatMap((mistake) => mistake.verification_hooks || []));
  const missingHooks = activeHooks.filter((hook) => !context.verificationContent.includes(hook));
  const checks = {
    red_team_vectors: redTeam.vectorCount >= 3,
    red_team_vector_depth: redTeam.vectorCount >= 3 && redTeam.shallowVectors.length === 0,
    progress_has_completed_item: countCompletedProgressItems(context.progressContent) > 0,
    test_drift_section: sectionPresent(context.verificationContent, "Test Drift Scan"),
    proof_of_work_slot: sectionPresent(context.verificationContent, "Proof of Work"),
    active_mistake_hooks_exact: missingHooks.length === 0,
  };
  return {
    checks,
    missing: Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id),
    diagnostics: {
      red_team_vector_count: redTeam.vectorCount,
      shallow_vectors: redTeam.shallowVectors.map((vector) => vector.rawTitle || vector.title),
      active_hooks: activeHooks,
      missing_hooks: missingHooks,
    },
  };
}

function analyzeReflectToValidate(context) {
  const closeSignals = context.refresh?.closeSignals || {};
  const checks = {
    reflection_guide_buildable: !!context.reflectionGuide?.ok,
    reflection_md_present: !!context.reflectionContent,
    solution_verdict_section: sectionPresent(context.reflectionContent, "Solution Verdict"),
    semantic_verdict_section: sectionPresent(context.reflectionContent, "Semantic Verdict"),
    evidence_readiness_section: sectionPresent(context.reflectionContent, "Evidence-Readiness Verdict"),
    next_move_section: sectionPresent(context.reflectionContent, "Next Move"),
    progress_signal_satisfied: closeSignals.progress?.satisfied === true,
    kb_signal_satisfied: closeSignals.kb?.satisfied === true,
    semantic_substrate_signal_satisfied: closeSignals.semantic_substrate?.satisfied === true,
  };
  return {
    checks,
    missing: Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id),
    diagnostics: {
      reflection_guide_issues: context.reflectionGuide?.issues || [],
      reflection_guide_warnings: context.reflectionGuide?.warnings || [],
      close_signal_summary: {
        progress: closeSignals.progress?.satisfied ?? null,
        kb: closeSignals.kb?.satisfied ?? null,
        semantic_substrate: closeSignals.semantic_substrate?.satisfied ?? null,
      },
    },
  };
}

function analyzeValidateToClose(context) {
  const closeSignals = context.refresh?.closeSignals || {};
  const verificationTruth = deriveVerificationTruth({
    cwd: context.cwd,
    planDir: context.planDir,
    planContent: context.planContent,
    verificationContent: context.verificationContent,
  });
  const checks = {
    verification_has_pass: verificationTruth.resultsRecorded === true && verificationTruth.allVerificationPass === true,
    verification_not_template: !context.verificationContent.includes("To be populated during PLAN"),
    systems_exercised_section: sectionPresent(context.verificationContent, "Systems Exercised"),
    remaining_unverified_section: sectionPresent(context.verificationContent, "Remaining Unverified"),
    verification_sufficiency_section: sectionPresent(context.verificationContent, "Verification Sufficiency"),
    proof_of_work_slot: contentHasProofBlock(context.verificationContent),
    planner_core_signal_satisfied: closeSignals.planner_core?.satisfied === true,
    test_evidence_signal_satisfied: closeSignals.test_evidence?.satisfied === true,
    anti_recurrence_signal_satisfied: closeSignals.anti_recurrence?.satisfied === true,
    learned_obligations_signal_satisfied: closeSignals.learned_obligations?.satisfied === true,
  };
  return {
    checks,
    missing: Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id),
    diagnostics: {
      close_signal_summary: {
        planner_core: closeSignals.planner_core?.satisfied ?? null,
        test_evidence: closeSignals.test_evidence?.satisfied ?? null,
        anti_recurrence: closeSignals.anti_recurrence?.satisfied ?? null,
        learned_obligations: closeSignals.learned_obligations?.satisfied ?? null,
      },
    },
  };
}

function analyzeGate(context) {
  if (context.gate === "explore-to-plan") {
    return analyzeExploreToPlan(context.planDir);
  }
  if (context.gate === "plan-to-execute") return analyzePlanToExecute(context);
  if (context.gate === "execute-to-reflect") return analyzeExecuteToReflect(context);
  if (context.gate === "reflect-to-validate") return analyzeReflectToValidate(context);
  if (context.gate === "validate-to-close") return analyzeValidateToClose(context);
  return { checks: {}, missing: [`unsupported_gate:${context.gate}`], diagnostics: {} };
}

function activeMistakeEvidenceRows(context) {
  const rows = [];
  for (const mistake of normalizeArray(context.mistakeSignal?.active_mistakes)) {
    for (const hook of uniqueStrings(mistake.verification_hooks || [])) {
      rows.push(`| ${mistake.id} | ${hook} | PENDING | UNVERIFIED: run or document \`${hook}\` before close. |`);
    }
  }
  if (rows.length === 0) {
    rows.push("| N/A | N/A | N/A | No active mistake hooks detected at preparation time. |");
  }
  return [
    "| Mistake | Hook | Status | Evidence |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function ensureVerificationScaffold(context, actions, gate) {
  const verificationPath = join(context.planDir, "verification.md");
  if (!existsSync(verificationPath)) {
    writeTextIfChanged(verificationPath, "# Verification Results\n");
    actions.push({ id: "file:verification.md", file: verificationPath, status: "created", truthfulness: STRUCTURAL_ONLY_NOTE });
  }

  if (gate === "execute-to-reflect") {
    ensureMarkdownSection(verificationPath, "Test Drift Scan", "UNVERIFIED: TODO record changed-code/test drift scan, or write `N/A - no tests` when true.", actions);
    ensureMarkdownSection(verificationPath, "Regression Audit", "UNVERIFIED: TODO record regression audit or `N/A - no baseline captured` when true.", actions);
    ensureMarkdownSection(verificationPath, "Parity", "UNVERIFIED: TODO record parity result or `N/A - no parity-registry.md` when true.", actions);
    ensureMarkdownSection(verificationPath, "Proof of Work", "UNVERIFIED: Requires manual user validation until commands are run and pasted here.", actions);
    ensureMarkdownSection(verificationPath, "Active Mistake Evidence", activeMistakeEvidenceRows(context), actions);
    const hooks = uniqueStrings(normalizeArray(context.mistakeSignal?.active_mistakes).flatMap((mistake) => mistake.verification_hooks || []));
    if (hooks.length > 0) {
      appendToSectionIfMissingTokens(
        verificationPath,
        "Active Mistake Evidence",
        hooks,
        activeMistakeEvidenceRows(context),
        actions,
        "active_mistake_hooks"
      );
    }
  }

  if (gate === "validate-to-close") {
    ensureMarkdownSection(verificationPath, "Systems Exercised", "UNVERIFIED: TODO list real systems or execution paths exercised.", actions);
    ensureMarkdownSection(verificationPath, "Remaining Unverified", "UNVERIFIED: TODO list residual unknowns, or `None` with rationale.", actions);
    ensureMarkdownSection(verificationPath, "Verification Sufficiency", "UNVERIFIED: TODO explain why the evidence level fits the changed system.", actions);
    ensureMarkdownSection(verificationPath, "Proof of Work", "UNVERIFIED: Requires manual user validation until commands are run and pasted here.", actions);
  }
}

function ensureRedTeamScaffold(context, actions) {
  const redTeamPath = join(context.planDir, "red_team_notes.md");
  const analysis = analyzeRedTeamNotes(context.redTeamContent);
  const missingCount = Math.max(0, 3 - analysis.vectorCount);
  if (missingCount === 0 && context.redTeamContent) {
    actions.push({ id: "red_team_vectors", file: redTeamPath, status: "already_present", truthfulness: "existing_content_preserved" });
    return;
  }
  const startIndex = analysis.vectorCount + 1;
  const vectors = [];
  for (let offset = 0; offset < missingCount || (analysis.vectorCount === 0 && offset < 3); offset += 1) {
    const index = startIndex + offset;
    vectors.push([
      `## Vector ${index}: TODO gate preparation vector`,
      "Attack: UNVERIFIED TODO describe the failure mode with concrete code, data, or workflow references.",
      "Impact: UNVERIFIED TODO describe what user-facing or planner-state damage would occur.",
      "Mitigation: UNVERIFIED TODO describe the guard, test, or design constraint that handles this vector.",
    ].join("\n"));
  }
  const current = readFile(redTeamPath) || "";
  const next = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${vectors.join("\n\n")}\n`;
  const write = writeTextIfChanged(redTeamPath, next);
  actions.push({
    id: "red_team_vectors",
    file: redTeamPath,
    status: write.written ? write.reason : "already_current",
    truthfulness: STRUCTURAL_ONLY_NOTE,
  });
}

function ensureProgressPreparationBlock(context, actions, gate) {
  const progressPath = join(context.planDir, "progress.md");
  const block = [
    `## Gate Preparation: ${gate}`,
    "- [ ] Review candidate obligations from `prepare-gate --json`.",
    "- [ ] Replace TODO/UNVERIFIED scaffold slots with executed proof or explicit non-applicability.",
    "- [ ] Re-run the transition gate after artifact proof is updated.",
  ].join("\n");
  upsertGeneratedBlock(progressPath, `progress:${gate}`, block, actions, `progress:${gate}`);
}

function ensureReflectionScaffold(context, actions) {
  const guide = writeReflectionGuide({ cwd: context.cwd, planDir: context.planDir });
  actions.push({
    id: "reflection_guide",
    file: guide.path,
    status: guide.wrote ? "written" : "not_written",
    truthfulness: "Generated from deterministic reflection guide builders; no reflection answer accepted.",
  });

  const reflectionPath = join(context.planDir, "reflection.md");
  if (existsSync(reflectionPath) && (readFile(reflectionPath) || "").trim()) {
    actions.push({ id: "reflection.md", file: reflectionPath, status: "already_present", truthfulness: "existing_content_preserved" });
    return;
  }
  const requiredCount = Number(guide.required_question_count || 0);
  const scaffold = `---
plan_id: ${context.planDirName}
generated_from_guide: plans/${context.planDirName}/reflection_guide.yaml
guide_version: 1
answered_at: PENDING_UTC_TIMESTAMP
required_questions_answered: 0/${requiredCount}
---

# Reflection

## Solution Verdict
UNVERIFIED: TODO record PASS / FAIL / PARTIAL with evidence.

## Surprises
UNVERIFIED: TODO record execution surprises or write None with rationale.

## Plan vs Progress Divergence
UNVERIFIED: TODO answer required guide questions and record any drift.

## Applicable KB Entries
UNVERIFIED: TODO address required KB questions with evidence.

## Relevant Retros
UNVERIFIED: TODO address required retro questions with evidence.

## Edge Case Coverage
UNVERIFIED: TODO record uncovered edge-case disposition.

## Pattern Application Check
UNVERIFIED: TODO confirm pattern use with concrete proof.

## Thrashing & Process Signals
UNVERIFIED: TODO record process signals or write None with rationale.

## Proof Weight Audit
UNVERIFIED: TODO record low-margin evidence concerns.

## Next Time Candidates
UNVERIFIED: TODO list reusable candidates or write None.

## Convention Application Check
UNVERIFIED: TODO close convention questions or write not applicable with rationale.

## Lessons Learned
UNVERIFIED: TODO record lessons or write None.

## Semantic Verdict
UNVERIFIED: TODO record PASS / FAIL / PARTIAL for semantic coherence.

## Evidence-Readiness Verdict
UNVERIFIED: TODO record READY / NOT READY.

## Next Move
UNVERIFIED: TODO choose close path, re-plan, explore, or waiver path.
`;
  const write = writeTextIfChanged(reflectionPath, scaffold);
  actions.push({ id: "reflection.md", file: reflectionPath, status: write.reason, truthfulness: STRUCTURAL_ONLY_NOTE });
}

function applyGateWrite(context, analysis) {
  const actions = [];
  if (context.gate === "explore-to-plan") {
    if (analysis.missing.length > 0) {
      const writeResult = scaffoldFindingsLedger(context.planDir, analysis);
      actions.push({
        id: "findings_ledger",
        file: writeResult.ledger_path,
        status: "written",
        truthfulness: STRUCTURAL_ONLY_NOTE,
        detail: writeResult.sync?.reason || null,
      });
    }
    return actions;
  }

  if (context.gate === "plan-to-execute") {
    // Legacy Markdown can make lint report strategy_present even when the
    // canonical file is absent. Creation/preparation contracts are about the
    // canonical artifact, so check its path directly.
    const canonicalPresent = existsSync(getVerificationStrategyPath(context.planDir));
    if (!canonicalPresent || !context.strategyLint?.ok) {
      const strategy = scaffoldVerificationStrategy({ cwd: context.cwd, planDir: context.planDir, force: canonicalPresent });
      actions.push({
        id: "verification_strategy",
        file: strategy.path,
        status: strategy.wrote ? (canonicalPresent ? "updated" : "written") : "not_written",
        truthfulness: STRUCTURAL_ONLY_NOTE,
        errors: strategy.errors || [],
      });
    }
    return actions;
  }

  if (context.gate === "execute-to-reflect") {
    ensureRedTeamScaffold(context, actions);
    ensureProgressPreparationBlock(context, actions, context.gate);
    ensureVerificationScaffold(context, actions, context.gate);
    return actions;
  }

  if (context.gate === "reflect-to-validate") {
    ensureReflectionScaffold(context, actions);
    return actions;
  }

  if (context.gate === "validate-to-close") {
    ensureVerificationScaffold(context, actions, context.gate);
    return actions;
  }

  return actions;
}

function buildResult({ cwd, gate, planArg, write }) {
  const resolved = resolvePlan(cwd, planArg);
  if (!resolved.ok) {
    return { status: "fail", ok: false, error: resolved.error, plan: resolved };
  }
  if (!SUPPORTED_GATES.has(gate)) {
    return {
      status: "unsupported",
      ok: false,
      plan: resolved,
      gate,
      write,
      missing: [],
      message: `Supported gates: ${[...SUPPORTED_GATES].join(", ")}`,
    };
  }

  const beforeContext = buildContext({ cwd, resolved, gate });
  const before = analyzeGate(beforeContext);
  const writeActions = write ? applyGateWrite(beforeContext, before) : [];
  const afterContext = write ? buildContext({ cwd, resolved, gate }) : beforeContext;
  const after = write ? analyzeGate(afterContext) : before;
  const candidates = buildCandidateObligations(afterContext);
  const generatedArtifactActions = [
    ...normalizeArray(before.diagnostics?.generated_artifact_actions),
    ...summarizeWriteActions(writeActions),
  ];
  const report = {
    version: 1,
    gate,
    plan_id: resolved.planDirName,
    generated_at: new Date().toISOString(),
    write_requested: write,
    extracted_signals: buildExtractedSignals(afterContext),
    candidate_obligations: candidates,
    decision_slots: buildDecisionSlots(candidates),
    generated_artifact_actions: generatedArtifactActions,
    truthfulness_notes: buildTruthfulnessNotes(afterContext),
    diagnostics: after.diagnostics || {},
  };
  const command = `node .agent/skills/iterative-planner/scripts/gate_prepare.mjs ${gate} --plan ${resolved.planDirName} --write`;
  const missingCount = after.missing.length;
  const advisoryReminder = buildGuidanceReminder({
    triggered: !write && missingCount > 0,
    surface: "gate_preparation",
    reason: "unresolved_preparation_items",
    nextCommand: command,
    why: `${missingCount} deterministic preparation item${missingCount === 1 ? "" : "s"} remain${missingCount === 1 ? "s" : ""}.`,
  });
  return {
    status: after.missing.length === 0 ? "pass" : "needs_preparation",
    ok: after.missing.length === 0,
    plan: {
      plan_dir_name: resolved.planDirName,
      plan_dir: resolved.planDir,
      source: resolved.source,
    },
    gate,
    write,
    before: { checks: before.checks, missing: before.missing },
    after: { checks: after.checks, missing: after.missing },
    analysis: {
      checks: after.checks,
      missing: after.missing,
      diagnostics: after.diagnostics || {},
    },
    report,
    wrote: writeActions.some((action) => ["created", "updated", "written", "appended_missing_tokens", "synced_from_ledger"].includes(action.status) || action.written),
    write_actions: generatedArtifactActions,
    write_result: writeActions.length > 0 ? { actions: generatedArtifactActions } : null,
    command,
    advisory_reminder: advisoryReminder,
  };
}

function printHuman(result) {
  if (result.status === "unsupported") {
    console.log(`gate_prepare: unsupported gate ${result.gate}`);
    console.log(result.message);
    return;
  }
  if (!result.plan) {
    console.log(`gate_prepare: FAIL — ${result.error || "unknown error"}`);
    return;
  }
  console.log(`gate_prepare: ${result.gate} for ${result.plan.plan_dir_name}`);
  console.log(`  before missing: ${result.before?.missing?.join(", ") || "none"}`);
  console.log(`  after missing: ${result.after?.missing?.join(", ") || "none"}`);
  console.log(`  candidate obligations: ${result.report?.candidate_obligations?.length || 0}`);
  console.log(`  generated actions: ${result.report?.generated_artifact_actions?.length || 0}`);
  console.log(`  wrote: ${result.wrote ? "yes" : "no"}`);
  if (!result.ok && !result.write) console.log(`  repair: ${result.command}`);
  const reminder = renderGuidanceReminder(result.advisory_reminder, { indent: "  " });
  if (reminder) {
    console.log();
    console.log(reminder);
  }
}

// --- Public API for programmatic use (e.g. from transition.mjs) ---
export { buildResult };

// --- CLI entry point (only runs when executed directly) ---
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const argvFile = pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
    const thisFile = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return argvFile === thisFile;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const args = parseArgs(process.argv);
  if (args.gate === "help" || args.gate === "--help") {
    console.log(usage());
    process.exitCode = 0;
  } else {
    const result = buildResult({ cwd: process.cwd(), gate: args.gate, planArg: args.plan, write: args.write });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}
