import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";

import { parseAnnotations, walkDir } from "../annotation_parser.mjs";
import { createSession } from "./prolog.mjs";
import {
  loadCapabilityFacts,
  loadGateHistoryFacts,
  loadGateRippleFacts,
  loadProofTelemetryFacts,
  loadProjectMetaFacts,
  loadReflectionFacts,
  loadSemanticHygieneFacts,
  loadSpotCheckFacts,
  loadRemediationFacts,
  loadRules,
  loadStateFacts,
  loadStoryFacts,
} from "./fact_loader.mjs";
import {
  debugLog,
  extractFilesToModify,
  loadFindingsLedger,
  readFindingsMarkdown,
  resolveFindingsTruth,
} from "./plan_utils.mjs";
import { summarizePersonaArtifacts } from "./persona_artifacts.mjs";
import { formatInvariantDiagnostic } from "./rule_commands.mjs";
import { formatReason, sanitizeAtom, sanitizeEnumAtom } from "./sanitize.mjs";

const DOMAIN_CHECKLIST_ARCHETYPES = new Set([
  "quant",
  "workflow_automation",
  "content_automation",
  "cms_plugin",
  "ux_ui_course",
]);

const DOMAIN_CHECKLIST_KEYWORDS = Object.freeze({
  quant: ["temporal split", "leakage", "out-of-sample", "calibration", "benchmark", "backtest"],
  workflow_automation: ["dry-run", "runner smoke", "retry", "webhook", "queue", "orchestration"],
  content_automation: ["output review", "fixture", "prompt", "generation regression", "output quality"],
  cms_plugin: ["redirect", "cta", "capability", "nonce", "hook", "wordpress"],
  ux_ui_course: ["browser journey", "visual proof", "renderer", "responsive", "course review"],
});

const BLOCKING_SEMANTIC_SUBSTRATE_GAPS = new Set([
  "missing_mutually_exclusive_facts",
  "missing_story_postconditions",
  "missing_story_conflict_facts",
]);

const GAP_METADATA = Object.freeze({
  missing_mutually_exclusive_facts: { domain: "config" },
  missing_story_postconditions: { domain: "story_semantics" },
  missing_story_conflict_facts: { domain: "story_semantics" },
});

const RELEVANCE_NONE = "none";
const RELEVANCE_WEAK = "weak";
const RELEVANCE_STRONG = "strong";

function safeRead(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    const content = safeRead(filePath);
    return content ? JSON.parse(content) : null;
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

function normalizePath(value) {
  let normalized = String(value || "").trim();
  const codeWrapped = normalized.match(/^`+(.*)`+$/);
  if (codeWrapped) normalized = codeWrapped[1].trim();
  normalized = normalized.replace(/^['"]+|['"]+$/g, "");
  return normalized.replace(/\\/g, "/");
}

function uniqueNormalizedPaths(values) {
  return uniqueList((Array.isArray(values) ? values : [])
    .map((value) => normalizePath(value))
    .filter(Boolean));
}

function classifyRelevance({ strong = false, weak = false } = {}) {
  if (strong) return RELEVANCE_STRONG;
  if (weak) return RELEVANCE_WEAK;
  return RELEVANCE_NONE;
}

function listHostProductSurfaceFiles(plannedFiles) {
  return uniqueNormalizedPaths(plannedFiles).filter((filePath) => {
    if (!filePath) return false;
    if (/^(?:\.agent|plans|reports|docs)(?:\/|$)/i.test(filePath)) return false;
    if (/^(?:readme|changelog|migration)\b/i.test(basename(filePath))) return false;
    return true;
  });
}

function includesAnyPhrase(text, phrases) {
  const normalized = normalizeText(text);
  return (Array.isArray(phrases) ? phrases : []).some((phrase) => normalized.includes(normalizeText(phrase)));
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length === 0) return null;
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return cells;
}

function computeAgeDays(dateText) {
  if (!dateText) return null;
  const parsed = Date.parse(String(dateText).trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function normalizeArchetype(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function isLikelySiblingCandidate(entryName, originalPath) {
  const extension = extname(entryName).toLowerCase();
  const originalExt = extname(originalPath).toLowerCase();
  if (!extension || extension !== originalExt) return false;
  if (/\.(md|json|txt|lock)$/i.test(entryName)) return false;
  if (/\.(test|spec)\./i.test(entryName)) return false;
  return /\.(mjs|js|ts|tsx|jsx|py|rb|php|go|rs|java|kt|swift)$/i.test(entryName);
}

export function collectAdjacencyCandidates(cwd, plannedFiles) {
  const candidates = new Set();
  for (const filePath of uniqueNormalizedPaths(plannedFiles)) {
    const absolute = resolve(cwd, filePath);
    const directory = dirname(absolute);
    if (!existsSync(directory)) continue;
    let siblings = [];
    try {
      siblings = readdirSync(directory);
    } catch {
      continue;
    }
    for (const sibling of siblings) {
      if (sibling === basename(absolute)) continue;
      if (!isLikelySiblingCandidate(sibling, filePath)) continue;
      const relativePath = relative(cwd, join(directory, sibling)).replace(/\\/g, "/");
      candidates.add(relativePath);
    }
  }
  return [...candidates];
}

export function collectScopedAnnotationContext({
  cwd = process.cwd(),
  planDir = null,
  planContent = "",
  plannedFiles = [],
  scope = "planned_plus_nearby",
  fallbackToRepoWide = true,
} = {}) {
  const effectivePlannedFiles = uniqueNormalizedPaths([
    ...extractFilesToModify(planContent),
    ...plannedFiles,
  ]);
  const existingPlannedFiles = effectivePlannedFiles.filter((filePath) => existsSync(resolve(cwd, filePath)));
  const missingPlannedFiles = effectivePlannedFiles.filter((filePath) => !existsSync(resolve(cwd, filePath)));

  let scopeUsed = scope;
  let candidateFiles = [];
  let trustedCandidateFiles = [];
  let scopeDegraded = false;
  let scopeDegradedReason = null;
  if (scope === "planned_plus_nearby" && effectivePlannedFiles.length > 0) {
    trustedCandidateFiles = uniqueNormalizedPaths([
      ...effectivePlannedFiles,
      ...collectAdjacencyCandidates(cwd, effectivePlannedFiles),
    ]).filter((filePath) => existsSync(resolve(cwd, filePath)));
    candidateFiles = trustedCandidateFiles;
  }

  let usedRepoWideFallback = false;
  if (candidateFiles.length === 0 && fallbackToRepoWide) {
    candidateFiles = walkDir(cwd, cwd);
    scopeUsed = "repo_wide_fallback";
    usedRepoWideFallback = true;
    if (scope === "planned_plus_nearby" && effectivePlannedFiles.length > 0) {
      scopeDegraded = true;
      scopeDegradedReason = missingPlannedFiles.length > 0 ? "missing_planned_files" : "no_scoped_candidates";
      trustedCandidateFiles = [];
    } else if (scope === "planned_plus_nearby" && effectivePlannedFiles.length === 0) {
      scopeDegradedReason = "no_planned_files";
      trustedCandidateFiles = candidateFiles;
    } else {
      trustedCandidateFiles = candidateFiles;
    }
  }

  const annotations = [];
  for (const filePath of candidateFiles) {
    annotations.push(...parseAnnotations(filePath, cwd));
  }
  const trustedAnnotations = scopeDegraded ? [] : annotations;

  const personaSummary = planDir
    ? summarizePersonaArtifacts({
        guidanceDoc: safeReadJson(join(planDir, "persona_guidance.json")),
        constraintsDoc: safeReadJson(join(planDir, "persona_constraints.json")),
        findingsDoc: safeReadJson(join(planDir, "persona_findings.json")),
      })
    : summarizePersonaArtifacts();

  return {
    annotations,
    trusted_annotations: trustedAnnotations,
    candidate_files: candidateFiles,
    trusted_candidate_files: trustedCandidateFiles,
    scope_policy: scope,
    scope_used: scopeUsed,
    used_repo_wide_fallback: usedRepoWideFallback,
    scope_degraded: scopeDegraded,
    scope_degraded_reason: scopeDegradedReason,
    has_usable_planned_files: effectivePlannedFiles.length > 0,
    planned_files: effectivePlannedFiles,
    existing_planned_files: existingPlannedFiles,
    missing_planned_files: missingPlannedFiles,
    sources_present: {
      annotations: trustedAnnotations.some((annotation) => !annotation.error),
      story_registry: existsSync(join(cwd, "reports", "user_story_audit", "story_registry.json")),
      persona_artifacts: personaSummary.present,
    },
  };
}

export function analyzeRemediationBacklog({ cwd }) {
  const queuePath = join(cwd, "reports", "remediation_queue.md");
  if (!existsSync(queuePath)) {
    return {
      present: false,
      pendingCount: 0,
      pendingHighCount: 0,
      ageDays: null,
      staleHighBacklog: false,
    };
  }

  const content = safeRead(queuePath) || "";
  const generatedMatch = content.match(/^Generated:\s*(.+)$/m);
  const ageDays = computeAgeDays(generatedMatch?.[1] || null);
  let pendingCount = 0;
  let pendingHighCount = 0;

  for (const line of content.split("\n")) {
    const cells = parseMarkdownTableRow(line);
    if (!cells || cells.length < 8) continue;
    if (/^#$/i.test(cells[0]) || /^id$/i.test(cells[1])) continue;
    const severity = normalizeText(cells[3]);
    const status = normalizeText(cells[7]);
    if (status.includes("pending")) {
      pendingCount++;
      if (severity === "high") pendingHighCount++;
    }
  }

  return {
    present: true,
    pendingCount,
    pendingHighCount,
    ageDays,
    staleHighBacklog: pendingHighCount >= 3 && Number.isFinite(ageDays) && ageDays >= 14,
  };
}

export function analyzeAdjacencySubstrate({ cwd, planDir, plannedFiles }) {
  const normalizedFiles = uniqueNormalizedPaths(plannedFiles);
  const siblingCandidates = collectAdjacencyCandidates(cwd, normalizedFiles);
  const findingsTruth = planDir ? resolveFindingsTruth(planDir) : null;
  const findingsContent = planDir ? (readFindingsMarkdown(planDir, { sync: false }) || "") : "";
  const ledgerInfo = planDir ? loadFindingsLedger(planDir) : { parsed: null };
  const adjacencyText = [
    findingsContent.match(/##\s+Adjacency[\s\S]*?(?=\n## |\n# |$)/i)?.[0] || "",
    JSON.stringify(ledgerInfo?.parsed?.adjacency || ledgerInfo?.parsed?.blast_radius || ledgerInfo?.parsed?.blastRadius || ""),
  ].join("\n");
  const explicitNa = /\b(?:n\/a|none|single[- ]file|single file change)\b/i.test(adjacencyText);
  const required = normalizedFiles.length > 1 || siblingCandidates.length > 0;
  const populated = !!findingsTruth?.effective?.hasAdjacency && !explicitNa;

  return {
    required,
    populated,
    explicitNa,
    siblingCandidateCount: siblingCandidates.length,
    siblingCandidates: siblingCandidates.slice(0, 8),
  };
}

export function analyzeDomainChecklistSubstrate({
  goal,
  planContent,
  verificationContent,
  findingsContent,
  archetype,
}) {
  const normalizedArchetype = normalizeArchetype(archetype);
  const required = DOMAIN_CHECKLIST_ARCHETYPES.has(normalizedArchetype);
  const combined = [goal, planContent, verificationContent, findingsContent].filter(Boolean).join("\n");
  const section = combined.match(/(?:^|\n)##?\s*(?:Domain (?:EXPLORE )?Checklist|Explore Checklist)[\s\S]*?(?=\n## |\n# |$)/i)?.[0] ||
    (/\bdomain checklist\b/i.test(combined) ? combined : "");
  const present = !!section;
  const placeholderTokens = /\b(example|generic|placeholder|todo|tbd|to be defined|api\.example\.com)\b/i.test(section);
  const keywordMatches = (DOMAIN_CHECKLIST_KEYWORDS[normalizedArchetype] || [])
    .filter((keyword) => includesAnyPhrase(section, [keyword]));
  const placeholder = required && present && (placeholderTokens || keywordMatches.length === 0);

  return {
    required,
    present,
    placeholder,
    archetype: normalizedArchetype || null,
  };
}

export function analyzeMutuallyExclusiveSubstrate({
  goal,
  planContent,
  plannedFiles,
  proofTelemetry,
  annotationContext = null,
}) {
  const combined = [goal, planContent, ...(plannedFiles || [])].filter(Boolean).join("\n");
  const hostSurfaceFiles = listHostProductSurfaceFiles(plannedFiles);
  const touchesHostSurface = hostSurfaceFiles.length > 0;
  const configSurfaceTouched = hostSurfaceFiles.some((filePath) => /(^|\/)(config|configs|settings|env)\//i.test(filePath) || /\.env(\.|$)/i.test(filePath));
  const trustedAnnotations = Array.isArray(annotationContext?.trusted_annotations) ? annotationContext.trusted_annotations : [];
  const strongConfigAnnotation = trustedAnnotations.some((annotation) => !annotation.error && annotation.key === "config_flag");
  const strongTelemetry = (proofTelemetry?.task_signals || []).includes("config_flags_changed");
  const strongPhrases = /\b(mutually exclusive|contradictory runtime mode|contradictory runtime modes|llm_mode|mock mode|provider selection aligned)\b/i.test(combined);
  const weakPhrases = /\b(flag|flags|toggle|provider|environment variable|env var)\b/i.test(combined);
  const relevance = classifyRelevance({
    strong: configSurfaceTouched || strongConfigAnnotation || (touchesHostSurface && (strongTelemetry || strongPhrases)),
    weak: touchesHostSurface && weakPhrases,
  });
  const required = relevance === RELEVANCE_STRONG;

  if (!required) {
    return { required: false, relevance, declared: false, scannedFiles: 0 };
  }

  const annotations = trustedAnnotations;
  const declared = annotations.some((annotation) => !annotation.error && annotation.key === "mutually_exclusive");

  return {
    required: true,
    relevance,
    declared,
    scannedFiles: Array.isArray(annotationContext?.trusted_candidate_files) ? annotationContext.trusted_candidate_files.length : 0,
  };
}

export function analyzeStorySemanticSubstrate({
  goal,
  planContent,
  plannedFiles,
  proofTelemetry,
}) {
  const combined = [goal, planContent, ...(plannedFiles || [])].filter(Boolean).join("\n");
  const hostSurfaceFiles = listHostProductSurfaceFiles(plannedFiles);
  const touchesHostSurface = hostSurfaceFiles.length > 0;
  const strongPathSignals = hostSurfaceFiles.some((filePath) => /wizard|checkout|onboarding|approval|toast|navigation|journey|funnel/i.test(filePath));
  const strongTelemetry = (proofTelemetry?.task_signals || []).includes("stateful_user_flow");
  const strongPhrases = /\b(wizard|approval flow|after navigation|persist after navigation|success toast|browser journey|user flow|stateful user flow|multi-step)\b/i.test(combined);
  const weakPhrases = /\b(flow|state|review|session)\b/i.test(combined);
  const relevance = classifyRelevance({
    strong: strongPathSignals || (touchesHostSurface && (strongTelemetry || strongPhrases)),
    weak: touchesHostSurface && weakPhrases,
  });

  return { required: relevance === RELEVANCE_STRONG, relevance };
}

export function collectSubstrateSignals({
  cwd = process.cwd(),
  planDir = null,
  goal = "",
  planContent = "",
  verificationContent = "",
  plannedFiles = [],
  proofTelemetry = null,
  archetype = null,
  annotationContext = null,
} = {}) {
  const findingsContent = planDir ? (readFindingsMarkdown(planDir, { sync: false }) || "") : "";
  const effectiveAnnotationContext = annotationContext || collectScopedAnnotationContext({
    cwd,
    planDir,
    planContent,
    plannedFiles,
  });

  return {
    remediationBacklog: analyzeRemediationBacklog({ cwd }),
    adjacency: analyzeAdjacencySubstrate({
      cwd,
      planDir,
      plannedFiles,
    }),
    domainChecklist: analyzeDomainChecklistSubstrate({
      goal,
      planContent,
      verificationContent,
      findingsContent,
      archetype,
    }),
    mutuallyExclusive: analyzeMutuallyExclusiveSubstrate({
      goal,
      planContent,
      plannedFiles,
      proofTelemetry,
      annotationContext: effectiveAnnotationContext,
    }),
    storySemantics: analyzeStorySemanticSubstrate({
      goal,
      planContent,
      plannedFiles,
      proofTelemetry,
    }),
    annotationContext: effectiveAnnotationContext,
  };
}

export function createDiagnosticsSession({
  cwd = process.cwd(),
  skillPath,
  transientCloseSignals = null,
  transientOntologyFacts = "",
  transientRegistryRefresh = false,
} = {}) {
  const ctx = { cwd, skillPath, transientCloseSignals, transientOntologyFacts, transientRegistryRefresh };
  const session = createSession();
  const rules = loadRules(session, ctx);
  loadCapabilityFacts(session, ctx);
  loadSemanticHygieneFacts(session, ctx);
  loadGateRippleFacts(session, ctx);
  loadGateHistoryFacts(session, ctx);
  const storyInfo = loadStoryFacts(session, ctx);
  const stateInfo = loadStateFacts(session, ctx);
  const proofTelemetry = loadProofTelemetryFacts(session, ctx);
  loadProjectMetaFacts(session, ctx);
  loadRemediationFacts(session, ctx);
  loadReflectionFacts(session, ctx);
  loadSpotCheckFacts(session, ctx);

  return {
    session,
    rules,
    degradedCoverage: rules?.degraded_coverage || null,
    storyInfo,
    stateInfo,
    proofTelemetry,
  };
}

function serializeDiagnosticEntry(kind, detail) {
  return {
    kind: formatReason(kind),
    detail: formatReason(detail),
  };
}

export function querySemanticDiagnostics({
  session,
  gateName = null,
  gateRegistry = {},
  classification = null,
  canonicalization = { applied: [] },
  structuralTokenRendering = null,
  substrateSignals = null,
} = {}) {
  const gateDef = gateName ? gateRegistry?.[gateName] : null;
  if (gateDef) {
    const from = Array.isArray(gateDef.from) ? gateDef.from[0] : gateDef.from;
    if (from && gateDef.to) {
      session.consult(`diagnostics_gate(${sanitizeEnumAtom(String(from).replace(/-/g, "_"))}, ${sanitizeEnumAtom(String(gateDef.to).replace(/-/g, "_"))}).`);
    }
  }

  session.consult(`diagnostics_active_plan_poisoned(${classification?.signals?.active_plan_poisoned ? "true" : "false"}).`);
  session.consult(`diagnostics_simple_task(${classification?.flow?.mode === "lightweight" ? "true" : "false"}).`);
  session.consult(`diagnostics_full_flow(${classification?.flow?.mode === "full" ? "true" : "false"}).`);
  session.consult(`diagnostics_structural_token_feature(${structuralTokenRendering?.active ? "true" : "false"}).`);
  session.consult(`diagnostics_ui_renderer_surface(${structuralTokenRendering?.rendererSignals?.length ? "true" : "false"}).`);
  session.consult(`diagnostics_renderer_contract_explicit(${structuralTokenRendering?.rendererContractExplicit ? "true" : "false"}).`);
  session.consult(`diagnostics_visual_render_proof(${structuralTokenRendering?.visualProofExplicit ? "true" : "false"}).`);
  session.consult(`diagnostics_pending_high_remediation_count(${Number(substrateSignals?.remediationBacklog?.pendingHighCount) || 0}).`);
  if (Number.isFinite(substrateSignals?.remediationBacklog?.ageDays)) {
    session.consult(`diagnostics_remediation_age_days(${Number(substrateSignals.remediationBacklog.ageDays)}).`);
  } else {
    session.consult("diagnostics_remediation_age_days(0).");
  }
  session.consult(`diagnostics_adjacency_required(${substrateSignals?.adjacency?.required ? "true" : "false"}).`);
  session.consult(`diagnostics_adjacency_populated(${substrateSignals?.adjacency?.populated ? "true" : "false"}).`);
  session.consult(`diagnostics_adjacency_explicit_na(${substrateSignals?.adjacency?.explicitNa ? "true" : "false"}).`);
  session.consult(`diagnostics_adjacency_candidate_count(${Number(substrateSignals?.adjacency?.siblingCandidateCount) || 0}).`);
  session.consult(`diagnostics_domain_checklist_required(${substrateSignals?.domainChecklist?.required ? "true" : "false"}).`);
  session.consult(`diagnostics_domain_checklist_present(${substrateSignals?.domainChecklist?.present ? "true" : "false"}).`);
  session.consult(`diagnostics_domain_checklist_placeholder(${substrateSignals?.domainChecklist?.placeholder ? "true" : "false"}).`);
  session.consult(`diagnostics_config_flag_context(${substrateSignals?.mutuallyExclusive?.required ? "true" : "false"}).`);
  session.consult(`diagnostics_config_relevance(${sanitizeEnumAtom(substrateSignals?.mutuallyExclusive?.relevance || RELEVANCE_NONE)}).`);
  session.consult(`diagnostics_mutually_exclusive_declared(${substrateSignals?.mutuallyExclusive?.declared ? "true" : "false"}).`);
  session.consult(`diagnostics_stateful_flow_context(${substrateSignals?.storySemantics?.required ? "true" : "false"}).`);
  session.consult(`diagnostics_story_relevance(${sanitizeEnumAtom(substrateSignals?.storySemantics?.relevance || RELEVANCE_NONE)}).`);
  session.consult(`diagnostics_scope_degraded(${substrateSignals?.annotationContext?.scope_degraded ? "true" : "false"}).`);
  session.consult(`diagnostics_scope_degraded_reason(${sanitizeEnumAtom(substrateSignals?.annotationContext?.scope_degraded_reason || "none")}).`);

  for (const correction of canonicalization?.applied || []) {
    session.consult(
      `canonicalization_applied(${sanitizeEnumAtom(correction.type)}, ${sanitizeAtom(correction.from)}, ${sanitizeAtom(correction.to)}).`
    );
  }

  return {
    semanticBlocks: session.queryAll("semantic_block(Type, Detail)")
      .map((entry) => serializeDiagnosticEntry(entry.Type, entry.Detail)),
    repairableVariances: session.queryAll("repairable_variance(Type, Detail)")
      .map((entry) => serializeDiagnosticEntry(entry.Type, entry.Detail)),
    recommendedRecoveryModes: uniqueList(session.queryAll("recommended_recovery(Mode)").map((entry) => String(entry.Mode))),
    minimalRepairSet: session.queryAll("minimal_repair_item(Type, Detail)")
      .map((entry) => serializeDiagnosticEntry(entry.Type, entry.Detail)),
    nextBestActions: uniqueList(session.queryAll("next_best_action(Action)").map((entry) => String(entry.Action))),
    invariantViolations: session.queryAll("invariant_violated(Name, Detail)")
      .map((entry) => formatInvariantDiagnostic(session, entry)),
    invariantWarnings: session.queryAll("invariant_warning(Name, Detail)")
      .map((entry) => formatInvariantDiagnostic(session, entry)),
  };
}

export function extractSemanticSubstrateGapIds(repairableVariances = []) {
  const gapIds = [];
  for (const entry of Array.isArray(repairableVariances) ? repairableVariances : []) {
    const detail = String(entry?.detail || "");
    if (detail.includes("missing_mutually_exclusive_facts")) gapIds.push("missing_mutually_exclusive_facts");
    if (detail.includes("missing_story_postconditions")) gapIds.push("missing_story_postconditions");
    if (detail.includes("missing_story_conflict_facts")) gapIds.push("missing_story_conflict_facts");
  }
  return uniqueList(gapIds);
}

export function summarizeSemanticSubstrate({
  substrateSignals = null,
  repairableVariances = [],
  annotationContext = null,
} = {}) {
  const domainEvidence = {
    config: substrateSignals?.mutuallyExclusive?.relevance || RELEVANCE_NONE,
    story_semantics: substrateSignals?.storySemantics?.relevance || RELEVANCE_NONE,
  };
  const relevantDomains = [];
  if (domainEvidence.config === RELEVANCE_STRONG) relevantDomains.push("config");
  if (domainEvidence.story_semantics === RELEVANCE_STRONG) relevantDomains.push("story_semantics");

  const advisoryGapIds = extractSemanticSubstrateGapIds(repairableVariances);
  const blockingGapIds = advisoryGapIds.filter((gapId) => {
    if (!BLOCKING_SEMANTIC_SUBSTRATE_GAPS.has(gapId)) return false;
    const metadata = GAP_METADATA[gapId];
    return metadata?.domain ? relevantDomains.includes(metadata.domain) : false;
  });

  const required = relevantDomains.length > 0;
  const satisfied = !required || blockingGapIds.length === 0;
  const status = !required
    ? "not_required"
    : satisfied
      ? "satisfied"
      : "missing_relevant_gaps";

  const detail = !required
    ? "Semantic substrate not required for this plan shape"
    : blockingGapIds.length === 0
      ? `Relevant semantic substrate present for ${relevantDomains.join(", ")}`
      : `Relevant semantic substrate gaps: ${blockingGapIds.join(", ")}`;

  if (annotationContext?.used_repo_wide_fallback && annotationContext?.scope_degraded) {
    debugLog("semantic_substrate", "Scoped annotation refresh fell back to repo-wide scanning because no usable planned-file set was available.");
  }

  const detailSuffix = annotationContext?.scope_degraded && annotationContext?.scope_degraded_reason
    ? `; scope degraded via ${annotationContext.scope_degraded_reason}`
    : "";

  return {
    required,
    satisfied,
    status,
    scan_scope: annotationContext?.scope_policy || "planned_plus_nearby",
    scan_scope_used: annotationContext?.scope_used || "planned_plus_nearby",
    scope_degraded: annotationContext?.scope_degraded === true,
    scope_degraded_reason: annotationContext?.scope_degraded_reason || null,
    relevant_domains: uniqueList(relevantDomains),
    relevance_evidence: domainEvidence,
    advisory_gap_ids: advisoryGapIds,
    blocking_gap_ids: blockingGapIds,
    sources_present: {
      annotations: annotationContext?.sources_present?.annotations === true,
      story_registry: annotationContext?.sources_present?.story_registry === true,
      persona_artifacts: annotationContext?.sources_present?.persona_artifacts === true,
    },
    detail: `${detail || ""}${detailSuffix}`.trim() || null,
  };
}
