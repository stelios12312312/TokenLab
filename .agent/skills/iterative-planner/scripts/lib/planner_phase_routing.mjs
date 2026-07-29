import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const AUTHORITY_PHASES = Object.freeze(["explore", "plan", "execute", "reflect", "validate", "close"]);
export const AGENT_AUTHORITY_ROLES = Object.freeze(["primary"]);
export const PERSONA_AUTHORITY_ROLES = Object.freeze([
  "discovery_widening",
  "challenge",
  "boundary_only",
  "proof_challenge",
]);
export const ONTOLOGY_AUTHORITY_ROLES = Object.freeze([
  "advisory",
  "contract_enforcement",
  "boundary_verification",
  "proof_consistency",
]);
export const AUDIT_POSTURES = Object.freeze(["normal", "adversarial"]);
export const RECOMMENDED_PATHS = Object.freeze([
  "continue",
  "cleanup",
  "bootstrap_semantics",
  "targeted_red_team",
  "full_review",
]);
export const SYMMETRY_GUARDS = Object.freeze(["advisory", "requires_red_team"]);

const DEFAULT_AUTHORITY_BY_PHASE = Object.freeze({
  explore: Object.freeze({
    phase: "explore",
    agent_role: "primary",
    persona_role: "discovery_widening",
    ontology_role: "advisory",
    continuous_execute_supervision: false,
  }),
  plan: Object.freeze({
    phase: "plan",
    agent_role: "primary",
    persona_role: "challenge",
    ontology_role: "contract_enforcement",
    continuous_execute_supervision: false,
  }),
  execute: Object.freeze({
    phase: "execute",
    agent_role: "primary",
    persona_role: "boundary_only",
    ontology_role: "boundary_verification",
    continuous_execute_supervision: false,
  }),
  reflect: Object.freeze({
    phase: "reflect",
    agent_role: "primary",
    persona_role: "challenge",
    ontology_role: "contract_enforcement",
    continuous_execute_supervision: false,
  }),
  validate: Object.freeze({
    phase: "validate",
    agent_role: "primary",
    persona_role: "proof_challenge",
    ontology_role: "proof_consistency",
    continuous_execute_supervision: false,
  }),
  close: Object.freeze({
    phase: "close",
    agent_role: "primary",
    persona_role: "challenge",
    ontology_role: "contract_enforcement",
    continuous_execute_supervision: false,
  }),
});

const PROOF_POSTURE_BY_PHASE = Object.freeze({
  explore: Object.freeze({
    id: "discovery_widening",
    label: "Discovery Widening",
    summary: "Use discovery and bounded challenge to widen the search space before making contracts.",
  }),
  plan: Object.freeze({
    id: "contract_enforcement",
    label: "Contract Enforcement",
    summary: "Turn discovery into explicit contracts, proof obligations, and bounded failure modes before execution.",
  }),
  execute: Object.freeze({
    id: "boundary_capture",
    label: "Boundary Capture",
    summary: "Keep execution agent-led, consume the written obligations, and record evidence without continuous second-guessing.",
  }),
  reflect: Object.freeze({
    id: "solution_semantic_challenge",
    label: "Solution And Semantic Challenge",
    summary: "Challenge whether the implemented solution improved the task and whether stories, ontology, and intended meaning still line up.",
  }),
  validate: Object.freeze({
    id: "proof_challenge",
    label: "Proof Challenge",
    summary: "Challenge whether the changed system was actually exercised and whether residual risk is honestly disclosed.",
  }),
  close: Object.freeze({
    id: "handoff_integrity",
    label: "Handoff Integrity",
    summary: "Require durable agreement between planner state, docs, and final handoff surfaces before the work is considered closed.",
  }),
});

const PHASE_CONTRACT_BY_PHASE = Object.freeze({
  explore: Object.freeze({
    summary: "EXPLORE should widen the search and surface hidden assumptions without prematurely turning them into execution work.",
    do_now: "Read, search, compare adjacent surfaces, and capture structured findings.",
    defer_until_reflect: "Do not overfit the solution or demand final proof while context is still incomplete.",
  }),
  plan: Object.freeze({
    summary: "PLAN should turn findings into explicit contracts, success criteria, and proof obligations.",
    do_now: "Name the files, risks, invariants, verification matrix, and failure modes before changing code.",
    defer_until_reflect: "Do not treat likely proof as actual proof; execution still needs to exercise the system.",
  }),
  execute: Object.freeze({
    summary: "EXECUTE stays agent-first; personas and ontology only pressure the work at boundaries, not continuously.",
    do_now: "Implement the planned change, keep evidence live, and avoid inventing new ritual mid-step.",
    defer_until_reflect: "Broader challenge, adversarial review, and sufficiency judgment belong at the execute-to-reflect, reflect-to-validate, or validate-to-close boundaries.",
  }),
  reflect: Object.freeze({
    summary: "REFLECT should challenge solution quality and semantic coherence before the planner starts arguing about proof sufficiency.",
    do_now: "Compare the result to the plan, intended outcome, ontology/story surfaces, and residual semantic drift.",
    defer_until_reflect: "Do not quietly close over unresolved solution or semantic gaps; redirect to re-plan or explore when the result is wrong.",
  }),
  validate: Object.freeze({
    summary: "VALIDATE should challenge proof sufficiency, evidence quality, and waiver honesty before close is allowed.",
    do_now: "Check exercised systems, verification sufficiency, and remaining unverified risk against the planned validation bundle.",
    defer_until_reflect: "Do not rediscover solution-shape or semantic upkeep issues that should already have been resolved in REFLECT.",
  }),
  close: Object.freeze({
    summary: "CLOSE is a handoff-integrity phase; the planner state, written artifacts, and final summary must agree with the validated result.",
    do_now: "Summarize the work, keep the handoff bundle honest, and leave behind reusable anti-recurrence signals.",
    defer_until_reflect: "Do not reopen design exploration unless new evidence proves the chosen path was wrong.",
  }),
});

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ");
}

function normalizePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function normalizeList(values) {
  if (Array.isArray(values)) {
    return values
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof values === "string" && values.trim()) return [values.trim()];
  return [];
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeText(value).replace(/[\s-]+/g, "_");
  return allowed.includes(normalized) ? normalized : fallback;
}

function slugify(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function dedupeById(items) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}

function textContainsAny(haystack, needles) {
  const normalized = normalizeText(haystack);
  return normalizeList(needles).some((needle) => normalized.includes(normalizeText(needle)));
}

function filePathMatchesAny(filePath, scopes) {
  const normalizedFile = normalizePath(filePath).toLowerCase();
  return normalizeList(scopes).some((scope) => {
    const normalizedScope = normalizePath(scope).toLowerCase();
    return normalizedScope && normalizedFile.includes(normalizedScope);
  });
}

function detectBroadAuditCluster({ symmetryHunts = [], classification = null, semanticBlocks = [], repairableVariances = [] } = {}) {
  const distinctSources = new Set((symmetryHunts || []).map((entry) => entry.source));
  const riskItemCount = (semanticBlocks?.length || 0) + (repairableVariances?.length || 0);
  const plannedFileCount = Number(classification?.signals?.planned_file_count || 0);
  return distinctSources.size >= 2 && symmetryHunts.length >= 2 && (plannedFileCount >= 3 || riskItemCount >= 3);
}

function detectSemanticBootstrapNeed({ workflow = null, classification = null, semanticBlocks = [], repairableVariances = [], semanticSubstrate = null } = {}) {
  if (workflow === "/story-bootstrap") return true;
  if (semanticSubstrate?.required === true && semanticSubstrate?.satisfied === false) return true;
  const bootstrapKinds = new Set([
    "story_registry_gap",
    "adjacency_gap",
    "domain_checklist_gap",
    "config_fact_gap",
    "story_semantic_gap",
  ]);
  const flowMode = String(classification?.flow_mode || "").trim().toLowerCase();
  const strictnessMode = String(classification?.strictness_mode || "").trim().toLowerCase();
  const includeRepairableVariances = flowMode === "full" || strictnessMode === "strict";
  const entries = includeRepairableVariances
    ? [...(semanticBlocks || []), ...(repairableVariances || [])]
    : [...(semanticBlocks || [])];
  return entries.some((entry) => bootstrapKinds.has(String(entry?.kind || "").trim()));
}

function deriveRecommendedPathReason(path, { hygieneSummary = null, workflow = null, symmetryHunts = [], semanticSubstrate = null } = {}) {
  if (path === "bootstrap_semantics") {
    return semanticSubstrate?.detail || "Task-relevant semantic substrate is missing or incomplete.";
  }
  if (path === "cleanup") {
    return `${Number(hygieneSummary?.auto_fix_count || 0)} deterministic cleanup repair(s) can land safely before broader review.`;
  }
  if (path === "targeted_red_team") {
    return workflow === "/red-team-audit"
      ? "Existing workflow routing already points at the targeted red-team path."
      : "Structured symmetry hunts or proof gaps suggest hidden-risk hunting before broader review.";
  }
  if (path === "full_review") {
    return workflow === "/full-review-and-fix"
      ? "Existing workflow routing already points at the full review path."
      : "Multiple structured risk clusters are active, so a narrow audit is likely to miss the real consolidation problem.";
  }
  return "Current planner state supports continuing the existing flow without extra ritual.";
}

function normalizeRecommendedGuard(value, fallback = "advisory") {
  const normalized = normalizeEnum(value, SYMMETRY_GUARDS, fallback);
  return SYMMETRY_GUARDS.includes(normalized) ? normalized : fallback;
}

function normalizeConfidence(value, fallback = "medium") {
  const normalized = normalizeText(value);
  return ["low", "medium", "high"].includes(normalized) ? normalized : fallback;
}

export function resolveAuthorityPhase({ phase = null, state = null, gateName = null, gateDef = null } = {}) {
  const normalizedPhase = normalizeEnum(phase, AUTHORITY_PHASES, "");
  if (normalizedPhase) return normalizedPhase;

  const gateProfilePhase = gateDef?.authority_profile?.phase;
  const normalizedGatePhase = normalizeEnum(gateProfilePhase, AUTHORITY_PHASES, "");
  if (normalizedGatePhase) return normalizedGatePhase;

  const gateTo = normalizeEnum(gateDef?.to, AUTHORITY_PHASES, "");
  if (gateTo) return gateTo;

  if (gateName === "notify-user") return "close";

  const normalizedState = normalizeEnum(state, AUTHORITY_PHASES, "");
  if (normalizedState) return normalizedState;
  return "explore";
}

export function resolveAuthorityProfile({ phase = null, state = null, gateName = null, gateDef = null, override = null } = {}) {
  const resolvedPhase = resolveAuthorityPhase({ phase, state, gateName, gateDef });
  const fallback = DEFAULT_AUTHORITY_BY_PHASE[resolvedPhase] || DEFAULT_AUTHORITY_BY_PHASE.explore;
  const source = override && typeof override === "object" ? override : gateDef?.authority_profile || {};
  return {
    phase: resolvedPhase,
    agent_role: normalizeEnum(source.agent_role, AGENT_AUTHORITY_ROLES, fallback.agent_role),
    persona_role: normalizeEnum(source.persona_role, PERSONA_AUTHORITY_ROLES, fallback.persona_role),
    ontology_role: normalizeEnum(source.ontology_role, ONTOLOGY_AUTHORITY_ROLES, fallback.ontology_role),
    continuous_execute_supervision: source.continuous_execute_supervision === true
      ? true
      : fallback.continuous_execute_supervision,
  };
}

export function resolveProofPosture({ phase = null, state = null, gateName = null, gateDef = null } = {}) {
  const resolvedPhase = resolveAuthorityPhase({ phase, state, gateName, gateDef });
  return PROOF_POSTURE_BY_PHASE[resolvedPhase] || PROOF_POSTURE_BY_PHASE.explore;
}

export function buildPhaseContract({ authorityProfile, proofPosture = null } = {}) {
  const profile = authorityProfile || resolveAuthorityProfile({});
  const posture = proofPosture || resolveProofPosture({ phase: profile.phase });
  const contract = PHASE_CONTRACT_BY_PHASE[profile.phase] || PHASE_CONTRACT_BY_PHASE.explore;
  return {
    phase: profile.phase,
    authority_profile: profile,
    proof_posture: posture,
    summary: contract.summary,
    do_now: contract.do_now,
    defer_until_reflect: contract.defer_until_reflect,
  };
}

export function loadAntiPatternsArtifact({ cwd = process.cwd() } = {}) {
  const path = join(cwd, "reports", "red_team_audit", "anti_patterns.json");
  if (!existsSync(path)) {
    return {
      path,
      present: false,
      usable: false,
      error: null,
      patterns: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const patterns = Array.isArray(parsed?.anti_patterns)
      ? parsed.anti_patterns
      : Array.isArray(parsed?.patterns)
        ? parsed.patterns
        : Array.isArray(parsed)
          ? parsed
          : [];
    return {
      path,
      present: true,
      usable: Array.isArray(patterns),
      error: Array.isArray(patterns) ? null : "invalid_shape",
      patterns: Array.isArray(patterns) ? patterns : [],
    };
  } catch {
    return {
      path,
      present: true,
      usable: false,
      error: "invalid_json",
      patterns: [],
    };
  }
}

function normalizeSymmetryCandidate({
  id,
  source,
  label,
  queries,
  scope,
  confidence,
  evidence_refs,
  recommended_guard,
}) {
  const normalizedQueries = normalizeList(queries);
  const normalizedScope = normalizeList(scope);
  if (!label || (normalizedQueries.length === 0 && normalizedScope.length === 0)) return null;

  return {
    id: String(id || `${source}:${slugify(label)}`).trim(),
    source,
    label: String(label).trim(),
    queries: normalizedQueries,
    scope: normalizedScope,
    confidence: normalizeConfidence(confidence),
    evidence_refs: normalizeList(evidence_refs),
    recommended_guard: normalizeRecommendedGuard(recommended_guard),
  };
}

function antiPatternMatchesContext(candidate, { goalText = "", effectiveFiles = [] } = {}) {
  if (candidate.source === "mistake_registry") return true;
  if (textContainsAny(goalText, candidate.queries)) return true;
  return (effectiveFiles || []).some((filePath) => filePathMatchesAny(filePath, candidate.scope));
}

export function collectSymmetryHunts({
  goalText = "",
  effectiveFiles = [],
  activeMistakes = [],
  antiPatternArtifact = null,
} = {}) {
  const items = [];

  for (const mistake of Array.isArray(activeMistakes) ? activeMistakes : []) {
    const symmetry = mistake?.symmetry_scan;
    if (!symmetry) continue;
    const normalized = normalizeSymmetryCandidate({
      id: `mistake:${mistake.id}`,
      source: "mistake_registry",
      label: mistake.title || mistake.id,
      queries: symmetry.queries,
      scope: symmetry.scope,
      confidence: "high",
      evidence_refs: [...normalizeList(mistake.kb_refs), ...normalizeList(mistake.matched_files)],
      recommended_guard: symmetry.guard,
    });
    if (normalized) items.push(normalized);
  }

  for (const pattern of Array.isArray(antiPatternArtifact?.patterns) ? antiPatternArtifact.patterns : []) {
    const normalized = normalizeSymmetryCandidate({
      id: pattern.id || pattern.pattern_id || pattern.key || `anti_pattern:${slugify(pattern.title || pattern.label)}`,
      source: "red_team_artifact",
      label: pattern.label || pattern.title || pattern.summary || pattern.description,
      queries: pattern.queries || pattern.grep_signatures || pattern.grep_patterns,
      scope: pattern.scope || pattern.paths || pattern.file_scope,
      confidence: pattern.confidence || "medium",
      evidence_refs: pattern.evidence_refs || pattern.source_finding_ids || pattern.finding_ids,
      recommended_guard: pattern.recommended_guard || pattern.guard,
    });
    if (!normalized) continue;
    if (!antiPatternMatchesContext(normalized, { goalText, effectiveFiles })) continue;
    items.push(normalized);
  }

  return dedupeById(items);
}

export function computeAuditPosture({
  workflow = null,
  symmetryHunts = [],
  semanticBlocks = [],
  repairableVariances = [],
} = {}) {
  const workflowRoute = String(workflow || "").trim();
  const symmetryRequiresRedTeam = (symmetryHunts || []).some((entry) => entry.recommended_guard === "requires_red_team");
  const riskFindingSignals = [...(semanticBlocks || []), ...(repairableVariances || [])]
    .some((entry) => /proof_gap|structural_token_renderer_gap|visual|telemetry/i.test(`${entry?.kind || ""} ${entry?.detail || ""}`));
  if (workflowRoute === "/red-team-audit" || workflowRoute === "/full-review-and-fix" || symmetryRequiresRedTeam || riskFindingSignals) {
    return "adversarial";
  }
  return "normal";
}

export function computeRecommendedPath({
  workflow = null,
  classification = null,
  semanticBlocks = [],
  repairableVariances = [],
  semanticSubstrate = null,
  symmetryHunts = [],
  hygieneSummary = null,
} = {}) {
  const auditPosture = computeAuditPosture({
    workflow,
    symmetryHunts,
    semanticBlocks,
    repairableVariances,
  });

  let recommendedPath = "continue";
  if (detectSemanticBootstrapNeed({ workflow, classification, semanticBlocks, repairableVariances, semanticSubstrate })) {
    recommendedPath = "bootstrap_semantics";
  } else if (Number(hygieneSummary?.auto_fix_count || 0) > 0) {
    recommendedPath = "cleanup";
  } else if (workflow === "/full-review-and-fix" || detectBroadAuditCluster({ symmetryHunts, classification, semanticBlocks, repairableVariances })) {
    recommendedPath = "full_review";
  } else if (workflow === "/red-team-audit" || auditPosture === "adversarial") {
    recommendedPath = "targeted_red_team";
  }

  return {
    audit_posture: auditPosture,
    recommended_path: recommendedPath,
    reason: deriveRecommendedPathReason(recommendedPath, {
      hygieneSummary,
      workflow,
      symmetryHunts,
      semanticSubstrate,
    }),
  };
}
