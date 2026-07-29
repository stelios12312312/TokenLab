#!/usr/bin/env node
// knowledge_resolver.mjs — deterministic knowledge discovery and routing hints.
//
// Purpose:
//   Give workflows one compiled answer to "what matters here?" without forcing
//   agents to rediscover KB, workflows, recipes, stories, and recovery state.
//
// Usage:
//   node knowledge_resolver.mjs --goal "<goal>" --json
//   node knowledge_resolver.mjs --json
//   node knowledge_resolver.mjs --dir <path> --plan <plan_dir_name>
//   node knowledge_resolver.mjs --goal "<goal>" --file path/to/file --file another/file

import { existsSync, readFileSync } from "fs";
import { join, resolve, relative } from "path";
import { fileURLToPath } from "url";

import {
  analyzeIntentContract,
  classifyPlannerPreflight,
  detectPlannerDogfoodIncident,
  extractFilesToModify,
  getPaths,
  goalLooksLikeProgramIntakeRequest,
  goalLooksLikePlanningOnlyRequest,
  getSkillPath,
  loadIntentContract,
  readFile,
  resolvePlanTarget,
} from "./lib/plan_utils.mjs";
import {
  computeMistakeRegistrySignal,
  loadMistakeRegistry,
  loadPlanMatchContext,
  normalizeStringList,
} from "./lib/mistake_registry.mjs";
import { collectRelatedRetros, loadRetroRegistry } from "./lib/retro_registry.mjs";
import { computeLearnedObligationsSignal, loadLearnedObligationsRegistry } from "./lib/learned_obligations.mjs";
import { summarizePersonaArtifacts } from "./lib/persona_artifacts.mjs";
import { deriveManifestoAlignmentSignals, loadPlannerManifesto } from "./lib/planner_manifesto.mjs";
import {
  buildPhaseContract,
  collectSymmetryHunts,
  computeRecommendedPath,
  loadAntiPatternsArtifact,
  resolveAuthorityProfile,
  resolveProofPosture,
} from "./lib/planner_phase_routing.mjs";
import { resolvePrimaryRecipeCandidate, resolveRecipeRequest } from "./lib/recipe_utils.mjs";
import { computeAdversarialAuditProfile, computeVerificationObligationSynthesis } from "./lib/verification_obligations.mjs";
import { buildKnowledgeHub } from "./lib/knowledge_hub.mjs";
import { parseAnnotations } from "./annotation_parser.mjs";

const DEFAULT_MATCHER_THRESHOLDS = Object.freeze({
  entity_matching: 0.8,
  semantic_map_focus_selection: 0.7,
  story_adjacency: 0.7,
  workflow_hint_ranking: 0.72,
});

const DEFAULT_DISCOVERY_POLICY = Object.freeze({
  archetype: null,
  enabled_matchers: [],
  disabled_matchers: [],
  thresholds: DEFAULT_MATCHER_THRESHOLDS,
  search_policy: {
    allow_tier2: true,
    prefer_early_stop: true,
  },
  preferred_personas: [],
  preferred_workflows: [],
  preferred_recipes: [],
  required_secondary_signals: [],
});

const WORKFLOW_MATCHER_IDS = new Set([
  "entity_matching",
  "semantic_map_focus_selection",
  "story_adjacency",
  "workflow_hint_ranking",
]);

const WORKFLOW_ROUTE_MAP = Object.freeze({
  execute_known_recipe: "/recipe-tidy",
  recipe_tidy: "/recipe-tidy",
  recipe_discovery: "/recipe-discovery",
});
const INTERNAL_WORKFLOW_ROUTING_METADATA = Object.freeze({
  "/safe-change-power": Object.freeze({
    trigger_tags: [
      "planner core",
      "migration",
      "config migration",
      "plugin config",
      "cross system",
      "multi surface",
      "course generator",
      "user visible regression",
      "high risk",
    ],
    route_tags: [
      "planner core changes",
      "migration parity",
      "config migration risk",
      "user visible regression risk",
      "stronger guardrails",
    ],
    preferred_personas: ["config_integrity", "traceability", "wiring_auditor", "ux_ui", "assumptions_challenger"],
  }),
  "/sme-improvement": Object.freeze({
    trigger_tags: ["improvement", "upside", "strategy", "better strategies", "quant improvement", "quant upside"],
    route_tags: ["goal aligned improvement", "upside discovery", "strategic improvement", "quant improvement"],
    preferred_personas: ["quant", "quant_target", "assumptions_challenger", "traceability"],
  }),
  "/ticket-traceability-repair": Object.freeze({
    trigger_tags: ["needs story", "missing story refs", "ticket without traceability", "gap reference"],
    route_tags: ["story traceability repair", "ticket traceability repair", "needs_story"],
    preferred_personas: ["traceability"],
  }),
});
const DEFAULT_DRAFT_REVIEW_SURFACE = "plans/knowledge/draft_candidates.review.json";

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function readFlagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function normalizeId(value) {
  return normalizeString(value).replace(/\s+/g, "_");
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function uniqueNormalizedPaths(values) {
  return uniqueList((Array.isArray(values) ? values : []).map(normalizePath).filter(Boolean));
}

function normalizedIncludes(text, phrase) {
  const haystack = ` ${normalizeString(text)} `;
  const needle = normalizeString(phrase);
  return !!needle && haystack.includes(` ${needle} `);
}

function isUpsideGoal(goalText) {
  return /\b(improv(?:e|ement)?|better|strategy|validation|research|process|edge|thesis|capital allocation|trustworthiness|calibration)\b/i.test(String(goalText || ""));
}

function commonPrefixLength(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

function computeTokenSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  let best = 0;
  for (const source of leftTokens) {
    for (const candidate of rightTokens) {
      if (source === candidate) {
        best = Math.max(best, 1);
        continue;
      }
      const prefix = commonPrefixLength(source, candidate);
      const similarity = prefix >= 4 ? (prefix / Math.max(source.length, candidate.length)) : 0;
      best = Math.max(best, similarity);
    }
  }
  return best;
}

function tokenize(value) {
  return normalizeString(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function matchTags(goalText, tags) {
  const matches = [];
  for (const tag of normalizeStringList(tags)) {
    if (normalizedIncludes(goalText, tag)) matches.push(tag);
  }
  return matches;
}

function scorePhraseOverlap(goalText, values, weight = 10) {
  const matches = matchTags(goalText, values);
  return {
    matches,
    score: matches.length * weight,
  };
}

function toProjectRelative(cwd, filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return null;
  const resolvedPath = resolve(cwd, normalized);
  return normalizePath(relative(cwd, resolvedPath)) || normalizePath(normalized);
}

function loadStoryRegistry(cwd) {
  const path = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const parsed = safeReadJson(path);
  return {
    path,
    present: existsSync(path),
    usable: !!parsed && Array.isArray(parsed.stories),
    parsed: parsed && Array.isArray(parsed.stories) ? parsed : { stories: [] },
  };
}

function buildDraftPromotionContract({ cwd, gapCheckNeeded, gapCheckReason }) {
  const reviewSurfacePath = join(cwd, DEFAULT_DRAFT_REVIEW_SURFACE);
  return {
    active: gapCheckNeeded,
    review_surface: {
      relative_path: DEFAULT_DRAFT_REVIEW_SURFACE,
      path: reviewSurfacePath,
      present: existsSync(reviewSurfacePath),
    },
    promotion_command: `node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge "${cwd}" --draft-candidates "${DEFAULT_DRAFT_REVIEW_SURFACE}" --write --json`,
    activation_rule: "Draft candidates remain advisory until reviewed candidates are promoted into host-owned overlays. Promotion still writes overlay entries with status=draft, so runtime truth stays unchanged until separate approval or activation.",
    review_steps: [
      "Ask an outer LLM or reviewer for missed candidates only when deterministic retrieval is empty or weak.",
      "Record accepted candidates in the reviewed_candidates array at the review surface.",
      "Only mark reviewed candidates approved when the overlay_entry is concrete enough to scaffold deterministically.",
      "Run the promotion command to merge reviewed candidates additively into host-owned overlay drafts.",
    ],
    reviewed_candidate_required_fields: [
      "id",
      "kind",
      "title",
      "summary",
      "source_refs",
      "linked_ids",
      "matched_by",
      "score",
      "trust_level=draft",
      "blocking_capable=false",
      "review_status",
      "overlay_entry",
    ],
    gap_check_reason: gapCheckReason || null,
  };
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

const defaultWorkflowRegistryPath = join(getSkillPath(import.meta.url), "config", "workflow_registry.json");
const defaultWorkflowMigrationInventoryPath = join(getSkillPath(import.meta.url), "config", "workflow_migration_inventory.json");

function normalizeWorkflowEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
  if (!id) return null;
  return {
    id,
    purpose: typeof entry.purpose === "string" ? entry.purpose.trim() : "",
    trigger_tags: normalizeStringList(entry.trigger_tags),
    route_tags: normalizeStringList(entry.route_tags),
    search_tier: typeof entry.search_tier === "string" && entry.search_tier.trim() ? entry.search_tier.trim() : "tier1",
    dispatch_targets: normalizeStringList(entry.dispatch_targets),
    skill_hints: normalizeStringList(entry.skill_hints),
    preferred_personas: normalizeStringList(entry.preferred_personas),
    recipe_affinity: typeof entry.recipe_affinity === "string" && entry.recipe_affinity.trim() ? entry.recipe_affinity.trim() : "low",
    required_inputs: normalizeStringList(entry.required_inputs),
    canonical_outputs: normalizeStringList(entry.canonical_outputs),
    related_failure_codes: normalizeStringList(entry.related_failure_codes),
    internal: !!options.internal,
  };
}

function normalizeInventoryWorkflowEntry(entry, publicIds) {
  const id = typeof entry?.workflow === "string" && entry.workflow.trim() ? entry.workflow.trim() : "";
  if (!id || publicIds.has(id)) return null;
  const idTokens = id.replace(/^\//, "").replace(/-/g, " ");
  const routing = INTERNAL_WORKFLOW_ROUTING_METADATA[id] || {};
  const purpose = [entry.v6_purpose, entry.notes].filter(Boolean).join(" ");
  return normalizeWorkflowEntry({
    id,
    purpose,
    trigger_tags: [idTokens, entry.v6_purpose, entry.notes, ...normalizeStringList(routing.trigger_tags)],
    route_tags: [idTokens, entry.v6_purpose, entry.v7_action, entry.notes, ...normalizeStringList(routing.route_tags)],
    search_tier: "tier1",
    dispatch_targets: [],
    skill_hints: [id],
    preferred_personas: routing.preferred_personas || [],
    recipe_affinity: id.startsWith("/recipe-") ? "high" : "low",
    required_inputs: [],
    canonical_outputs: [],
    related_failure_codes: [],
  }, { internal: true });
}

export function loadWorkflowRegistry({
  registryPath = defaultWorkflowRegistryPath,
  inventoryPath = defaultWorkflowMigrationInventoryPath,
} = {}) {
  const parsed = safeReadJson(registryPath);
  const publicWorkflows = Array.isArray(parsed?.workflows)
    ? parsed.workflows.map(normalizeWorkflowEntry).filter(Boolean)
    : [];
  const publicIds = new Set(publicWorkflows.map((workflow) => workflow.id));
  const inventory = safeReadJson(inventoryPath);
  const internalWorkflows = Array.isArray(inventory?.entries)
    ? inventory.entries.map((entry) => normalizeInventoryWorkflowEntry(entry, publicIds)).filter(Boolean)
    : [];
  const workflows = [...publicWorkflows, ...internalWorkflows];
  return {
    path: registryPath,
    present: existsSync(registryPath),
    usable: !!parsed && publicWorkflows.length > 0,
    version: parsed?.version || 1,
    public_count: publicWorkflows.length,
    internal_inventory_path: inventoryPath,
    internal_inventory_present: existsSync(inventoryPath),
    internal_count: internalWorkflows.length,
    workflows,
  };
}

function normalizeDiscoveryPolicyValue(value, { list = false } = {}) {
  if (list) return normalizeStringList(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function loadDiscoveryPolicy({ cwd = process.cwd() } = {}) {
  const path = join(cwd, "planner.discovery.json");
  const parsed = safeReadJson(path);
  const usable = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const enabled = usable ? normalizeStringList(parsed.enabled_matchers).map(normalizeId) : [];
  const disabled = usable ? normalizeStringList(parsed.disabled_matchers).map(normalizeId) : [];
  const thresholds = {
    ...DEFAULT_MATCHER_THRESHOLDS,
    ...(usable && parsed.thresholds && typeof parsed.thresholds === "object" ? parsed.thresholds : {}),
  };

  for (const key of Object.keys(thresholds)) {
    const numeric = Number(thresholds[key]);
    thresholds[key] = Number.isFinite(numeric) ? numeric : DEFAULT_MATCHER_THRESHOLDS[key];
  }

  const policy = {
    archetype: usable ? normalizeDiscoveryPolicyValue(parsed.archetype) : DEFAULT_DISCOVERY_POLICY.archetype,
    enabled_matchers: enabled.filter((matcher) => WORKFLOW_MATCHER_IDS.has(matcher)),
    disabled_matchers: disabled.filter((matcher) => WORKFLOW_MATCHER_IDS.has(matcher)),
    thresholds,
    search_policy: {
      allow_tier2: usable && parsed.search_policy?.allow_tier2 === false ? false : DEFAULT_DISCOVERY_POLICY.search_policy.allow_tier2,
      prefer_early_stop: usable && parsed.search_policy?.prefer_early_stop === false ? false : DEFAULT_DISCOVERY_POLICY.search_policy.prefer_early_stop,
    },
    preferred_personas: usable ? normalizeStringList(parsed.preferred_personas) : [],
    preferred_workflows: usable ? normalizeStringList(parsed.preferred_workflows) : [],
    preferred_recipes: usable ? normalizeStringList(parsed.preferred_recipes) : [],
    required_secondary_signals: usable
      ? normalizeStringList(parsed.required_secondary_signals).map(normalizeId)
      : [],
  };

  return {
    path,
    present: existsSync(path),
    usable,
    error: existsSync(path) && !usable ? "invalid_json" : null,
    policy,
  };
}

function loadPersonaJson(planDir, basename) {
  if (!planDir) return { present: false, parsed: null };
  const path = join(planDir, basename);
  return {
    path,
    present: existsSync(path),
    parsed: safeReadJson(path),
  };
}

function loadSemanticMap(cwd) {
  const path = join(cwd, "reports", "stewardship", "semantic_map.json");
  const parsed = safeReadJson(path);
  return {
    path,
    present: existsSync(path),
    parsed: parsed && typeof parsed === "object" ? parsed : null,
  };
}

function matchStories(storyRegistry, { goalText, effectiveFiles = [], preferredStoryIds = [] }) {
  if (!storyRegistry?.usable) return [];
  const wanted = new Set(normalizeStringList(preferredStoryIds).map((id) => id.toUpperCase()));
  const goalTokens = tokenize(goalText);
  const effective = new Set(uniqueNormalizedPaths(effectiveFiles));
  const stories = Array.isArray(storyRegistry.parsed?.stories) ? storyRegistry.parsed.stories : [];

  return stories.map((story) => {
    const storyId = typeof story?.id === "string" ? story.id.trim().toUpperCase() : "";
    const refs = uniqueNormalizedPaths([
      ...(Array.isArray(story?.code_refs) ? story.code_refs : []),
      ...(Array.isArray(story?.test_refs) ? story.test_refs : []),
      ...(Array.isArray(story?.doc_refs) ? story.doc_refs : []),
      ...(Array.isArray(story?.validation_refs) ? story.validation_refs : []),
    ]);
    const matchedFiles = refs.filter((ref) => effective.has(normalizePath(ref)));
    const storyTerms = tokenize([
      story?.title,
      ...(Array.isArray(story?.tags) ? story.tags : []),
      ...(Array.isArray(story?.analytical_perspectives) ? story.analytical_perspectives : []),
    ].join(" "));
    const matchedTerms = goalTokens.filter((token) => storyTerms.includes(token));
    let score = 0;
    if (matchedFiles.length > 0) score += 40 + (matchedFiles.length * 5);
    if (matchedTerms.length > 0) score += matchedTerms.length * 4;
    if (wanted.has(storyId)) score += 15;
    if (String(story?.priority || "").toUpperCase() === "HIGH") score += 3;
    return {
      id: storyId || story?.id || "",
      title: typeof story?.title === "string" ? story.title.trim() : "",
      priority: typeof story?.priority === "string" ? story.priority.trim() : "",
      status: typeof story?.status === "string" ? story.status.trim() : "",
      matched_files: matchedFiles,
      matched_terms: matchedTerms,
      refs,
      score,
    };
  })
    .filter((story) => story.id && story.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function collectKbHeadingMatches(cwd, goalText) {
  const knowledgeDir = join(cwd, "plans", "knowledge");
  const goalTokens = tokenize(goalText);
  const files = ["mistakes.md", "patterns.md", "gotchas.md"];
  const matches = [];
  for (const fileName of files) {
    const path = join(knowledgeDir, fileName);
    const content = readFile(path) || "";
    if (!content) continue;
    const headings = content.match(/^##\s+.+$/gm) || [];
    for (const heading of headings) {
      const headingTokens = tokenize(heading);
      const overlap = goalTokens.filter((token) => headingTokens.includes(token));
      if (overlap.length === 0) continue;
      matches.push({
        source: fileName,
        heading: heading.replace(/^##\s+/, "").trim(),
        matched_terms: overlap,
        score: overlap.length,
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading));
}

function collectSecondarySignals({
  effectiveFiles,
  observedFiles,
  activeMistakes,
  activeObligations,
  storyMatches,
  recipeResolution,
  goalText,
  policy,
  personaSignals = null,
}) {
  const normalizedFiles = uniqueNormalizedPaths(effectiveFiles);
  const surfaces = new Set();
  for (const filePath of normalizedFiles) {
    if (filePath.startsWith(".agent/skills/iterative-planner/")) surfaces.add("planner_core_files");
    if (filePath.startsWith(".agent/workflows/")) surfaces.add("workflow_files");
    if (filePath.startsWith("reports/")) surfaces.add("reports");
    if (filePath.startsWith("recipes/")) surfaces.add("recipes");
    if (filePath.endsWith(".md")) surfaces.add("docs");
    if (filePath.endsWith(".json")) surfaces.add("config");
  }

  const primaryRecipeRoute = recipeResolution?.primary_resolution?.route || null;
  const personaPackIds = normalizeStringList(personaSignals?.pack_ids || []);
  return {
    active_mistakes: activeMistakes.length > 0,
    active_obligations: activeObligations.length > 0,
    config_migration_files: normalizedFiles.some((filePath) => /(config|settings|migration|migrate|hook|plugin|manifest|registry)/i.test(filePath)),
    deliverable_contract_files: normalizedFiles.some((filePath) => /(schema|template|prompt|output|deliverable)/i.test(filePath)),
    docs_files: surfaces.has("docs"),
    goal_requires_intent_contract: /\b(user|users|customer|client|dashboard|report|course|ui|page|screen)\b/i.test(String(goalText || "")),
    planning_only_goal: goalLooksLikePlanningOnlyRequest(goalText),
    program_intake_goal: goalLooksLikeProgramIntakeRequest(goalText),
    ticket_traceability_repair_goal: goalLooksLikeTicketTraceabilityRepairRequest(goalText),
    multi_surface_files: surfaces.size >= 2,
    observed_files: uniqueNormalizedPaths(observedFiles).length > 0,
    planner_core_files: surfaces.has("planner_core_files"),
    persona_pack_ids: personaPackIds,
    multiple_persona_packs: personaPackIds.length >= 2,
    persona_story_refs: Array.isArray(personaSignals?.story_refs) && personaSignals.story_refs.length > 0,
    reports_files: surfaces.has("reports"),
    recipe_resolution: !!primaryRecipeRoute && primaryRecipeRoute !== "plan_build" && primaryRecipeRoute !== "unconfigured",
    related_stories: storyMatches.length > 0,
    preferred_workflow: normalizeStringList(policy?.preferred_workflows).length > 0,
  };
}

function goalLooksLikeTicketTraceabilityRepairRequest(goalText) {
  const text = String(goalText || "").toLowerCase();
  if (!text.trim()) return false;
  const ticketContext = /\b(program packet|ticket|tickets|github issue|github issues|issue|issues|ticket intake receipt|advisory|acceptance criteria)\b/.test(text);
  const missingStoryTraceability = (
    /\bneeds_story\b/.test(text) ||
    /\bticket_without_traceability\b/.test(text) ||
    /\bstory_refs?\b/.test(text) ||
    /\bstory refs?\b/.test(text) ||
    /\bmissing (linked )?stor(y|ies|y refs?|ies refs?)\b/.test(text) ||
    /\bno linked stor(y|ies)\b/.test(text) ||
    /\bgap reference\b[\s\S]{0,80}\bno linked stor(y|ies)\b/.test(text) ||
    /\bstory linkage\b/.test(text)
  );
  return ticketContext && missingStoryTraceability;
}

function scoreWorkflow({
  workflow,
  goalText,
  effectiveFiles,
  recipeResolution,
  discoveryPolicy,
  secondarySignals,
  tier,
}) {
  let score = 0;
  const reasons = [];
  const matchedVia = [];

  const triggerOverlap = scorePhraseOverlap(goalText, workflow.trigger_tags, 12);
  if (triggerOverlap.score > 0) {
    score += triggerOverlap.score;
    matchedVia.push("exact_trigger_tag");
    reasons.push(`goal matched trigger tags: ${triggerOverlap.matches.join(", ")}`);
  }

  const routeOverlap = scorePhraseOverlap(goalText, workflow.route_tags, 9);
  if (routeOverlap.score > 0) {
    score += routeOverlap.score;
    matchedVia.push("exact_route_tag");
    reasons.push(`goal matched route tags: ${routeOverlap.matches.join(", ")}`);
  }

  const route = recipeResolution?.primary_resolution?.route || null;
  const preferredRecipes = new Set(normalizeStringList(discoveryPolicy?.preferred_recipes));
  if (workflow.id === WORKFLOW_ROUTE_MAP[route]) {
    score += 100;
    matchedVia.push("recipe_resolution");
    reasons.push(`recipe route '${route}' maps directly to ${workflow.id}`);
  }

  if (workflow.id === "/safe-change-power" && secondarySignals.planner_core_files) {
    score += 55;
    matchedVia.push("planner_core_files");
    reasons.push("planner-core or workflow files are in scope");
  }

  if (workflow.id === "/safe-plan" && secondarySignals.planning_only_goal) {
    score += 78;
    matchedVia.push("planning_only_goal");
    reasons.push("the request explicitly asks for planning without implementation");
  }

  if (workflow.id === "/program-manager" && secondarySignals.program_intake_goal) {
    score += secondarySignals.planning_only_goal ? 36 : 96;
    matchedVia.push("program_intake_goal");
    reasons.push("broad idea/backlog/ticket-generation intake should become a Program Packet before child workflow execution");
  }

  if (workflow.id === "/ticket-traceability-repair" && secondarySignals.ticket_traceability_repair_goal) {
    score += 118;
    matchedVia.push("ticket_traceability_repair_goal");
    reasons.push("existing Program Packet ticket traceability blockers should be repaired before child workflow execution");
  }

  if (workflow.id === "/steward" && secondarySignals.multi_surface_files) {
    score += 45;
    matchedVia.push("multi_surface_files");
    reasons.push("multiple planner surfaces drift together in the current file set");
  }

  if (workflow.id === "/advisor" && (secondarySignals.active_mistakes || secondarySignals.active_obligations)) {
    score += 30;
    matchedVia.push("recovery_state");
    reasons.push("active mistakes or obligations increase triage value");
  }

  if (workflow.id === "/safe-change" && effectiveFiles.some((filePath) => /\.(mjs|cjs|js|jsx|ts|tsx|py|rb|php|go|rs|css|scss|html)$/i.test(filePath))) {
    score += 20;
    matchedVia.push("code_file_scope");
    reasons.push("implementation files are already in scope");
  }

  if (secondarySignals.planning_only_goal && workflow.id === "/safe-change-power") {
    score -= 38;
    matchedVia.push("planning_only_debias");
    reasons.push("execution-first escalation is de-prioritized because the user explicitly asked for no-code planning");
  }

  if (secondarySignals.planning_only_goal && workflow.id === "/safe-change") {
    score -= 24;
    matchedVia.push("planning_only_debias");
    reasons.push("implementation routing is de-prioritized because the user explicitly asked for planning only");
  }

  if (normalizeStringList(discoveryPolicy?.preferred_workflows).includes(workflow.id)) {
    score += 12;
    matchedVia.push("preferred_workflow");
    reasons.push(`repo discovery policy prefers ${workflow.id}`);
  }

  const workflowPersonas = normalizeStringList(workflow.preferred_personas).map(normalizeId);
  const activePersonaIds = normalizeStringList(secondarySignals?.persona_pack_ids).map(normalizeId);
  const preferredPersonaIds = normalizeStringList(discoveryPolicy?.preferred_personas).map(normalizeId);
  const activePersonaMatches = workflowPersonas.filter((personaId) => activePersonaIds.includes(personaId));
  const preferredPersonaMatches = workflowPersonas.filter((personaId) => preferredPersonaIds.includes(personaId));
  const upsideGoal = isUpsideGoal(goalText);

  if (
    workflow.id === "/safe-change-power" &&
    secondarySignals.goal_requires_intent_contract &&
    (secondarySignals.deliverable_contract_files || secondarySignals.multi_surface_files) &&
    (activePersonaMatches.some((personaId) => ["ux_ui", "traceability", "wiring_auditor"].includes(personaId)) ||
      preferredPersonaMatches.some((personaId) => ["ux_ui", "traceability", "wiring_auditor"].includes(personaId)))
  ) {
    score += 28;
    matchedVia.push("user_visible_regression_risk");
    reasons.push("user-facing, intent-heavy deliverable surfaces favor stronger regression guardrails");
  }

  if (
    workflow.id === "/safe-change-power" &&
    secondarySignals.config_migration_files &&
    (activePersonaMatches.some((personaId) => ["config_integrity", "traceability", "wiring_auditor"].includes(personaId)) ||
      preferredPersonaMatches.some((personaId) => ["config_integrity", "traceability", "wiring_auditor"].includes(personaId)) ||
      ["cms_plugin", "plugin", "cms"].includes(normalizeId(discoveryPolicy?.archetype)))
  ) {
    score += 26;
    matchedVia.push("config_migration_risk");
    reasons.push("config, migration, or plugin surfaces plus aligned personas favor stronger guardrails");
  }

  if (activePersonaMatches.length > 0) {
    score += Math.min(10 + (activePersonaMatches.length * 6), 24);
    matchedVia.push("persona_pack_alignment");
    reasons.push(`persona packs align with ${workflow.id}: ${activePersonaMatches.join(", ")}`);
  }

  if (preferredPersonaMatches.length > 0) {
    score += Math.min(6 + (preferredPersonaMatches.length * 4), 14);
    matchedVia.push("preferred_persona_policy");
    reasons.push(`repo discovery policy prefers persona coverage aligned with ${workflow.id}: ${preferredPersonaMatches.join(", ")}`);
  }

  if (
    workflow.id === "/steward" &&
    secondarySignals.multiple_persona_packs &&
    (!upsideGoal || secondarySignals.active_mistakes || secondarySignals.active_obligations || secondarySignals.multi_surface_files)
  ) {
    score += 16;
    matchedVia.push("persona_cluster");
    reasons.push("multiple persona packs are active, suggesting clustered stewardship work");
  }

  if (
    workflow.id === "/steward" &&
    secondarySignals.persona_story_refs &&
    (!upsideGoal || secondarySignals.active_mistakes || secondarySignals.active_obligations || secondarySignals.multi_surface_files || secondarySignals.related_stories)
  ) {
    score += 10;
    matchedVia.push("persona_story_refs");
    reasons.push("persona outputs reference specific stories that merit cross-surface stewardship");
  }

  if (
    workflow.id === "/steward" &&
    secondarySignals.multi_surface_files &&
    secondarySignals.docs_files &&
    (secondarySignals.reports_files || secondarySignals.deliverable_contract_files) &&
    (activePersonaMatches.some((personaId) => ["traceability", "assumptions_challenger", "wiring_auditor"].includes(personaId)) ||
      preferredPersonaMatches.some((personaId) => ["traceability", "assumptions_challenger", "wiring_auditor"].includes(personaId)) ||
      ["content_automation", "agentic_content", "publishing"].includes(normalizeId(discoveryPolicy?.archetype)))
  ) {
    score += 22;
    matchedVia.push("content_automation_drift");
    reasons.push("content outputs, automation logic, and docs/reports drift together and need stewardship");
  }

  if (
    workflow.id === "/sme-improvement" &&
    upsideGoal &&
    (activePersonaMatches.length > 0 || preferredPersonaMatches.length > 0 || normalizeId(discoveryPolicy?.archetype) === "quant")
  ) {
    score += 18;
    matchedVia.push("upside_persona_alignment");
    reasons.push("improvement-shaped goal plus aligned personas/archetype favors /sme-improvement");
  }

  const matcherEnabled = discoveryPolicy?.enabled_matchers?.includes("workflow_hint_ranking");
  const threshold = Number(discoveryPolicy?.thresholds?.workflow_hint_ranking) || DEFAULT_MATCHER_THRESHOLDS.workflow_hint_ranking;
  const fuzzyCandidates = [...workflow.trigger_tags, ...workflow.route_tags, workflow.purpose].filter(Boolean);
  const fuzzyScores = fuzzyCandidates.map((candidate) => ({
    candidate,
    score: computeTokenSimilarity(goalText, candidate),
  })).sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));
  const bestFuzzy = fuzzyScores[0] || null;
  if (
    matcherEnabled &&
    bestFuzzy &&
    bestFuzzy.score >= threshold &&
    triggerOverlap.matches.length === 0 &&
    routeOverlap.matches.length === 0
  ) {
    const requiredSignals = normalizeStringList(discoveryPolicy?.required_secondary_signals).map(normalizeId);
    const secondarySatisfied = requiredSignals.length === 0
      ? Object.values(secondarySignals).some((value) => value === true)
      : requiredSignals.some((key) => secondarySignals[key] === true);
    if (secondarySatisfied) {
      score += Math.round(bestFuzzy.score * 10);
      matchedVia.push("fuzzy_workflow_hint");
      reasons.push(`fuzzy workflow hint '${bestFuzzy.candidate}' cleared threshold ${threshold.toFixed(2)} with score ${bestFuzzy.score.toFixed(2)}`);
    }
  }

  if (preferredRecipes.has(workflow.id) && route) {
    score += 4;
    reasons.push(`repo discovery policy prefers ${workflow.id} for recipe-shaped work`);
  }

  if (tier === "tier0" && workflow.search_tier === "tier0") score += 2;
  if (tier === "tier1" && (workflow.search_tier === "tier0" || workflow.search_tier === "tier1")) score += 2;
  if (tier === "tier2") score += 1;

  return {
    id: workflow.id,
    purpose: workflow.purpose,
    search_tier: workflow.search_tier,
    dispatch_targets: workflow.dispatch_targets,
    skill_hints: workflow.skill_hints,
    preferred_personas: workflow.preferred_personas,
    recipe_affinity: workflow.recipe_affinity,
    required_inputs: workflow.required_inputs,
    canonical_outputs: workflow.canonical_outputs,
    related_failure_codes: workflow.related_failure_codes,
    matched_via: matchedVia,
    reasons,
    score,
  };
}

function chooseEntryPoint(scoredWorkflows, classificationHints = {}) {
  const [best] = scoredWorkflows;
  const fallbackValue = classificationHints?.workflow?.recommended || "/advisor";
  if (!best || best.score <= 0) {
    return {
      kind: "workflow",
      value: fallbackValue,
      confidence: "low",
      reason: "No strong deterministic workflow signal was found; using the preflight fallback.",
    };
  }

  const confidence = best.score >= 100 ? "high" : best.score >= 40 ? "medium" : "low";
  return {
    kind: "workflow",
    value: best.id,
    confidence,
    reason: best.reasons[0] || `Highest-ranked workflow: ${best.id}`,
  };
}

function applyPlannerDogfoodRouting(scoredWorkflows, dogfoodIncident) {
  if (!dogfoodIncident?.active) return scoredWorkflows;
  return (Array.isArray(scoredWorkflows) ? scoredWorkflows : [])
    .map((workflow) => {
      if (workflow?.id !== "/steward") return workflow;
      return {
        ...workflow,
        score: Math.max(Number(workflow.score) || 0, 140),
        matched_via: uniqueList([...(workflow.matched_via || []), "planner_dogfood_false_green_incident"]),
        reasons: uniqueList([
          ...(workflow.reasons || []),
          "planner dogfood false-green incident requires cross-surface stewardship before ordinary continuation",
        ]),
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function buildRelevantRecipes(recipeResolution, discoveryPolicy) {
  const preferred = new Set(normalizeStringList(discoveryPolicy?.preferred_recipes));
  return (Array.isArray(recipeResolution?.recipe_candidates) ? recipeResolution.recipe_candidates : [])
    .slice(0, 5)
    .map((candidate) => ({
      recipe_id: candidate.recipe_id,
      recipe_dir: candidate.recipe_dir,
      capability_id: candidate.capability_id,
      entity_id: candidate.entity_id,
      entity_title: candidate.entity_title,
      missing_params: candidate.missing_params,
      runner_present: candidate.runner_present,
      skills: Array.isArray(candidate.skills) ? candidate.skills : [],
      preferred: preferred.has(candidate.recipe_id),
      score: candidate.score,
    }));
}

function buildRelevantFiles({
  effectiveFiles,
  storyMatches,
  recipeResolution,
  discoveryPolicy,
}) {
  const files = [...uniqueNormalizedPaths(effectiveFiles)];
  for (const story of storyMatches.slice(0, 3)) {
    files.push(...story.matched_files);
  }

  const primaryRecipe = resolvePrimaryRecipeCandidate(recipeResolution);
  if (primaryRecipe?.recipe_dir) files.push(join(primaryRecipe.recipe_dir, "recipe.json"));

  if (normalizeStringList(discoveryPolicy?.preferred_workflows).includes("/steward")) {
    files.push("reports/stewardship/semantic_map.json");
  }

  return uniqueNormalizedPaths(files).slice(0, 12);
}

function buildSemanticEntities({ recipeResolution, discoveryPolicy, storyMatches }) {
  const entities = [];
  const bestEntity = recipeResolution?.entities?.[0];
  const bestCapability = recipeResolution?.capabilities?.[0];
  if (bestEntity) {
    entities.push({
      type: "recipe_entity",
      id: bestEntity.id,
      title: bestEntity.title,
      matched_aliases: bestEntity.matched_aliases || [],
    });
  }
  if (bestCapability) {
    entities.push({
      type: "recipe_capability",
      id: bestCapability.id,
      title: bestCapability.title,
      matched_patterns: bestCapability.matched_patterns || [],
    });
  }
  if (discoveryPolicy?.archetype) {
    entities.push({
      type: "project_archetype",
      id: discoveryPolicy.archetype,
      title: discoveryPolicy.archetype,
    });
  }
  for (const personaId of normalizeStringList(discoveryPolicy?.preferred_personas).slice(0, 3)) {
    entities.push({
      type: "preferred_persona",
      id: personaId,
      title: personaId,
    });
  }
  for (const story of storyMatches.slice(0, 2)) {
    entities.push({
      type: "story",
      id: story.id,
      title: story.title,
    });
  }
  return entities;
}

function buildSearchPlan(finalTier) {
  const tierOrder = ["tier0", "tier1", "tier2"];
  const allowed = tierOrder.slice(0, tierOrder.indexOf(finalTier) + 1);
  const descriptions = {
    tier0: "Inspect workflow_registry.json, recipe registries, and KB headings for a deterministic front-door route.",
    tier1: "Inspect mistakes, obligations, story registry links, and file-change surfaces to refine the route.",
    tier2: "Inspect persona outputs, semantic map, and file-local annotations only when lower tiers remain ambiguous.",
  };
  return {
    recommended_tier: finalTier,
    steps: allowed.map((tier) => ({ tier, action: descriptions[tier] })),
  };
}

function loadTier2Signals({ cwd, planDir, effectiveFiles, traceProfile, ignoredSignals }) {
  const personaGuidance = loadPersonaJson(planDir, "persona_guidance.json");
  const personaConstraints = loadPersonaJson(planDir, "persona_constraints.json");
  const personaFindings = loadPersonaJson(planDir, "persona_findings.json");
  const semanticMap = loadSemanticMap(cwd);
  const personaSignals = summarizePersonaArtifacts({
    guidanceDoc: personaGuidance.parsed,
    constraintsDoc: personaConstraints.parsed,
    findingsDoc: personaFindings.parsed,
  });

  const annotationFiles = uniqueNormalizedPaths(effectiveFiles)
    .map((filePath) => resolve(cwd, filePath))
    .filter((filePath) => existsSync(filePath));

  const annotations = [];
  for (const filePath of annotationFiles) {
    try {
      annotations.push(...parseAnnotations(filePath, cwd));
    } catch {
      ignoredSignals.push(`tier2_annotation_parse_failed:${toProjectRelative(cwd, filePath)}`);
    }
  }

  traceProfile.sources_consulted.push("persona_guidance.json", "persona_constraints.json", "persona_findings.json", "reports/stewardship/semantic_map.json");
  if (annotationFiles.length > 0) traceProfile.sources_consulted.push("annotation_parser");

  return {
    personaGuidance,
    personaConstraints,
    personaFindings,
    personaSignals,
    semanticMap,
    annotations,
  };
}

export function resolveKnowledgeFromContext({
  cwd = process.cwd(),
  goalText = "",
  plannedFiles = [],
  stateJson = null,
  planDir = null,
  planDirName = null,
  planContent = "",
  verificationContent = "",
  storyRegistry = null,
  classificationHints = null,
} = {}) {
  const traceProfile = {
    tiers_visited: [],
    sources_consulted: [],
    deep_search_used: false,
    early_stop_reason: null,
    candidate_count: 0,
    route_decision_basis: [],
  };
  const ignoredSignals = [];
  const workflowRegistry = loadWorkflowRegistry();
  const discoveryPolicyInfo = loadDiscoveryPolicy({ cwd });
  const discoveryPolicy = discoveryPolicyInfo.policy;
  const manifestoInfo = loadPlannerManifesto();
  const registryStoryData = storyRegistry || loadStoryRegistry(cwd);
  const verificationLedger = planDir ? safeReadJson(join(planDir, "verification_ledger.json")) : null;
  const recipeResolution = resolveRecipeRequest({ cwd, goalText });
  const kbHeadingMatches = collectKbHeadingMatches(cwd, goalText);
  const rawPlanMatchContext = loadPlanMatchContext({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry: registryStoryData.parsed,
  });
  const planMatchContext = {
    ...rawPlanMatchContext,
    plannedFiles: uniqueNormalizedPaths([...(rawPlanMatchContext.plannedFiles || []), ...plannedFiles]),
    effectiveFiles: uniqueNormalizedPaths([...(rawPlanMatchContext.effectiveFiles || []), ...plannedFiles]),
  };
  const dogfoodIncident = detectPlannerDogfoodIncident(goalText || rawPlanMatchContext.goalText, planMatchContext.effectiveFiles);

  traceProfile.tiers_visited.push("tier0");
  traceProfile.sources_consulted.push("workflow_registry.json", "recipe_resolver", "plans/knowledge/index.md");
  if (kbHeadingMatches.length > 0) traceProfile.sources_consulted.push("plans/knowledge headings");
  if (discoveryPolicyInfo.present) traceProfile.sources_consulted.push("planner.discovery.json");

  const tier0SecondarySignals = collectSecondarySignals({
    effectiveFiles: planMatchContext.effectiveFiles,
    observedFiles: planMatchContext.observedFiles,
    activeMistakes: [],
    activeObligations: [],
    storyMatches: [],
    recipeResolution,
    goalText,
    policy: discoveryPolicy,
  });

  let scoredWorkflows = workflowRegistry.workflows
    .map((workflow) => scoreWorkflow({
      workflow,
      goalText,
      effectiveFiles: planMatchContext.effectiveFiles,
      recipeResolution,
      discoveryPolicy,
      secondarySignals: tier0SecondarySignals,
      tier: "tier0",
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  scoredWorkflows = applyPlannerDogfoodRouting(scoredWorkflows, dogfoodIncident);

  let searchTier = "tier0";
  let storyMatches = [];
  let mistakeSignal = {
    registry_present: false,
    registry_usable: false,
    active_count: 0,
    active_mistakes: [],
  };
  let obligationsSignal = {
    required: false,
    satisfied: true,
    active_obligations: [],
  };
  const retroRegistry = loadRetroRegistry({ cwd });
  if (retroRegistry.present) traceProfile.sources_consulted.push("retro_ledger.json");
  let tier2Signals = null;
  const recipePrimaryRoute = recipeResolution?.primary_resolution?.route || null;
  const recipeTier0Route = (
    recipePrimaryRoute === "execute_known_recipe" ||
    recipePrimaryRoute === "recipe_tidy" ||
    recipePrimaryRoute === "recipe_discovery"
  ) ? recipePrimaryRoute : null;

  const entryAfterTier0 = chooseEntryPoint(scoredWorkflows, classificationHints);
  const tier0CanStop = (
    recipeTier0Route ||
    entryAfterTier0.confidence === "high"
  ) && discoveryPolicy.search_policy.prefer_early_stop;

  if (tier0CanStop) {
    traceProfile.early_stop_reason = recipeTier0Route
      ? `tier0:${recipeTier0Route}`
      : `tier0:${entryAfterTier0.value}`;
    ignoredSignals.push("tier1:skipped_due_to_high_confidence_tier0_route");
    ignoredSignals.push("tier2:skipped_due_to_high_confidence_tier0_route");
  } else {
    traceProfile.tiers_visited.push("tier1");
    traceProfile.sources_consulted.push("mistake_registry.json", "learned_obligations.json", "story_registry.json");
    mistakeSignal = computeMistakeRegistrySignal({
      cwd,
      planDir,
      stateJson,
      planContent,
      storyRegistry: registryStoryData.parsed,
    });
    obligationsSignal = computeLearnedObligationsSignal({
      cwd,
      planDir,
      stateJson,
      planContent,
      verificationContent,
      verificationLedger,
      storyRegistry: registryStoryData.parsed,
      mistakeSignal,
    });
    storyMatches = matchStories(registryStoryData, {
      goalText,
      effectiveFiles: planMatchContext.effectiveFiles,
      preferredStoryIds: planMatchContext.storyIds,
    });
    searchTier = "tier1";

    const tier1SecondarySignals = collectSecondarySignals({
      effectiveFiles: planMatchContext.effectiveFiles,
      observedFiles: planMatchContext.observedFiles,
      activeMistakes: mistakeSignal.active_mistakes || [],
      activeObligations: obligationsSignal.active_obligations || [],
      storyMatches,
      recipeResolution,
      goalText,
      policy: discoveryPolicy,
      personaSignals: null,
    });

    scoredWorkflows = workflowRegistry.workflows
      .map((workflow) => {
        const scored = scoreWorkflow({
          workflow,
          goalText,
          effectiveFiles: planMatchContext.effectiveFiles,
          recipeResolution,
          discoveryPolicy,
          secondarySignals: tier1SecondarySignals,
          tier: "tier1",
        });
        if (workflow.id === "/steward" && storyMatches.length > 0 && (mistakeSignal.active_count > 0 || obligationsSignal.required)) {
          scored.score += 18;
          scored.matched_via.push("story_and_guard_cluster");
          scored.reasons.push("stories plus active guards suggest clustered stewardship rather than isolated fixes");
        }
        if (workflow.id === "/safe-change-power" && (mistakeSignal.active_count > 0 || obligationsSignal.required)) {
          scored.score += 14;
          scored.matched_via.push("active_guard_signal");
          scored.reasons.push("active learned safeguards increase execution-risk sensitivity");
        }
        return scored;
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    scoredWorkflows = applyPlannerDogfoodRouting(scoredWorkflows, dogfoodIncident);

    const entryAfterTier1 = chooseEntryPoint(scoredWorkflows, classificationHints);
    const tier1CanStop = (
      entryAfterTier1.confidence !== "low" ||
      mistakeSignal.active_count > 0 ||
      storyMatches.length > 0 ||
      obligationsSignal.required
    ) && discoveryPolicy.search_policy.prefer_early_stop;

    if (tier1CanStop || !discoveryPolicy.search_policy.allow_tier2) {
      traceProfile.early_stop_reason = tier1CanStop
        ? `tier1:${entryAfterTier1.value}`
        : "tier2_disabled_by_policy";
      if (!discoveryPolicy.search_policy.allow_tier2) {
        ignoredSignals.push("tier2:disabled_by_repo_policy");
      } else {
        ignoredSignals.push("tier2:skipped_due_to_sufficient_tier1_signal");
      }
    } else {
      traceProfile.tiers_visited.push("tier2");
      traceProfile.deep_search_used = true;
      searchTier = "tier2";
      tier2Signals = loadTier2Signals({
        cwd,
        planDir,
        effectiveFiles: planMatchContext.effectiveFiles,
        traceProfile,
        ignoredSignals,
      });

      scoredWorkflows = workflowRegistry.workflows
        .map((workflow) => {
          const scored = scoreWorkflow({
            workflow,
            goalText,
            effectiveFiles: planMatchContext.effectiveFiles,
            recipeResolution,
            discoveryPolicy,
            secondarySignals: {
              ...collectSecondarySignals({
                effectiveFiles: planMatchContext.effectiveFiles,
                observedFiles: planMatchContext.observedFiles,
                activeMistakes: mistakeSignal.active_mistakes || [],
                activeObligations: obligationsSignal.active_obligations || [],
                storyMatches,
              recipeResolution,
              goalText,
              policy: discoveryPolicy,
              personaSignals: tier2Signals?.personaSignals,
            }),
              related_stories: storyMatches.length > 0,
            },
            tier: "tier2",
          });
          if (workflow.id === "/steward") {
            const personaCount = tier2Signals?.personaSignals?.total_items || 0;
            const personaStoryCount = tier2Signals?.personaSignals?.story_refs?.length || 0;
            const semanticCount = Array.isArray(tier2Signals?.semanticMap?.parsed?.areas)
              ? tier2Signals.semanticMap.parsed.areas.length
              : 0;
            const annotationCount = Array.isArray(tier2Signals?.annotations) ? tier2Signals.annotations.length : 0;
            const allowStewardTier2Boost = !isUpsideGoal(goalText) ||
              storyMatches.length > 0 ||
              mistakeSignal.active_count > 0 ||
              obligationsSignal.required ||
              planMatchContext.effectiveFiles.length > 1;
            if ((personaCount > 0 || semanticCount > 0 || annotationCount > 0) && allowStewardTier2Boost) {
              scored.score += 12 + Math.min(personaCount + personaStoryCount + semanticCount + annotationCount, 8);
              scored.matched_via.push("tier2_semantic_signals");
              scored.reasons.push("persona, semantic-map, or annotation signals add clustered discovery context");
            }
          }
          return scored;
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
  }

  const recommendedEntryPoint = chooseEntryPoint(scoredWorkflows, classificationHints);
  const relevantRecipes = buildRelevantRecipes(recipeResolution, discoveryPolicy);
  const relatedRetros = collectRelatedRetros({
    registry: retroRegistry,
    activeMistakes: mistakeSignal.active_mistakes || [],
    goalText,
    plannedFiles: planMatchContext.effectiveFiles,
  });
  const mistakeRegistry = loadMistakeRegistry({ cwd });
  const learnedObligationsRegistry = loadLearnedObligationsRegistry({ cwd });
  const relevantFiles = buildRelevantFiles({
    effectiveFiles: planMatchContext.effectiveFiles,
    storyMatches,
    recipeResolution,
    discoveryPolicy,
  });
  const semanticEntities = buildSemanticEntities({
    recipeResolution,
    discoveryPolicy,
    storyMatches,
  });
  const verificationObligationSynthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry: registryStoryData.parsed,
  });
  const intentContractInfo = planDir ? loadIntentContract(planDir) : null;
  const intentAnalysis = intentContractInfo?.parsed
    ? analyzeIntentContract(intentContractInfo.parsed, { goalText })
    : null;
  const manifestoClassification = classificationHints || classifyPlannerPreflight(goalText, {
    plannedFiles: planMatchContext.effectiveFiles,
    hasActivePlan: !!planDirName,
    activePlanPoisoned: false,
    activePlanState: stateJson?.state || null,
    intentAnalysis,
  });
  const manifestoAlignmentSignals = uniqueList([
    ...deriveManifestoAlignmentSignals({
      classification: manifestoClassification,
      knowledgeResolution: {
        active_obligations: obligationsSignal.active_obligations || [],
      },
      activePlanPoisoned: !!manifestoClassification?.signals?.active_plan_poisoned,
    }),
    ...(recommendedEntryPoint.value === "/safe-change-power" ? ["semantic_risk_requires_strict_flow"] : []),
    ...((recommendedEntryPoint.value === "/safe-change-power" || storyMatches.length > 0 || (obligationsSignal.active_obligations || []).length > 0)
      ? ["ontology_should_challenge_semantics"]
      : []),
  ]);
  const antiPatternArtifact = loadAntiPatternsArtifact({ cwd });
  const symmetryHunts = collectSymmetryHunts({
    goalText,
    effectiveFiles: planMatchContext.effectiveFiles,
    activeMistakes: mistakeSignal.active_mistakes || [],
    antiPatternArtifact,
  });
  const authorityProfile = resolveAuthorityProfile({
    state: stateJson?.state || null,
  });
  const proofPosture = resolveProofPosture({
    state: authorityProfile.phase,
  });
  const phaseContract = buildPhaseContract({
    authorityProfile,
    proofPosture,
  });
  const personaSignals = tier2Signals?.personaSignals || summarizePersonaArtifacts();
  const postureRoute = computeRecommendedPath({
    workflow: recommendedEntryPoint.value,
    classification: manifestoClassification,
    symmetryHunts,
  });
  const knowledgeHub = buildKnowledgeHub({
    goalText,
    planMatchContext,
    kbHeadingMatches,
    mistakeRegistry,
    mistakeSignal,
    obligationsRegistry: learnedObligationsRegistry,
    obligationsSignal,
    retroRegistry,
    relatedRetros,
    verificationObligationSynthesis,
    symmetryHunts,
  });
  const draftPromotionContract = buildDraftPromotionContract({
    cwd,
    gapCheckNeeded: knowledgeHub.gap_check_needed,
    gapCheckReason: knowledgeHub.trust_summary?.gap_check_reason || null,
  });
  const draftCandidatePrompt = knowledgeHub.draft_candidate_prompt
    ? {
        ...knowledgeHub.draft_candidate_prompt,
        review_surface: draftPromotionContract.review_surface,
        promotion_command: draftPromotionContract.promotion_command,
        activation_rule: draftPromotionContract.activation_rule,
      }
    : null;
  const adversarialProfile = computeAdversarialAuditProfile({
    discoveryArchetype: discoveryPolicy.archetype,
    verificationObligationSynthesis,
    personaSummary: personaSignals,
    symmetryHunts,
  });
  const {
    suggested_attack_vectors: suggestedAttackVectors,
    ...adversarialProfileSummary
  } = adversarialProfile;

  traceProfile.candidate_count = scoredWorkflows.length +
    relevantRecipes.length +
    storyMatches.length +
    (mistakeSignal.active_count || 0) +
    ((obligationsSignal.active_obligations || []).length) +
    ((knowledgeHub.matches?.trusted || []).length) +
    ((knowledgeHub.matches?.derived || []).length) +
    (tier2Signals?.personaSignals?.total_items || 0) +
    (verificationObligationSynthesis.active_count || 0) +
    symmetryHunts.length;
  traceProfile.route_decision_basis = uniqueList(
    [
      ...(scoredWorkflows[0]?.reasons || []),
      ...((knowledgeHub.recommended_path_provenance?.trusted_match_ids || []).slice(0, 3).map((id) => `trusted_match:${id}`)),
      ...((knowledgeHub.recommended_path_provenance?.derived_match_ids || []).slice(0, 2).map((id) => `derived_match:${id}`)),
      knowledgeHub.gap_check_needed
        ? `draft_gap_check:${knowledgeHub.trust_summary?.gap_check_reason || "required"}`
        : null,
    ].filter(Boolean)
  );

  const reasons = uniqueList([
    manifestoInfo.manifesto.north_star ? `planner north star: ${manifestoInfo.manifesto.north_star}` : null,
    recommendedEntryPoint.reason,
    ...(scoredWorkflows[0]?.reasons || []),
    ...(mistakeSignal.active_mistakes || []).map((mistake) => `active mistake ${mistake.id}: ${mistake.summary || mistake.title}`),
    ...(obligationsSignal.active_obligations || []).map((obligation) => `active obligation ${obligation.id}: ${obligation.verification_mode}`),
    ...(storyMatches.slice(0, 2).map((story) => `story ${story.id} matched by ${story.matched_files.length > 0 ? "file refs" : "goal terms"}`)),
    ...(kbHeadingMatches.slice(0, 2).map((entry) => `${entry.source}: ${entry.heading}`)),
    ...((tier2Signals?.personaSignals?.pack_ids || []).slice(0, 2).map((packId) => `persona pack ${packId} supplied tier2 guidance`)),
    ...((tier2Signals?.personaSignals?.story_refs || []).slice(0, 2).map((storyId) => `persona signal references story ${storyId}`)),
    ...((verificationObligationSynthesis.obligations || []).slice(0, 3).map((obligation) =>
      `verification obligation synthesis ${obligation.id}: ${obligation.required_proof_type}`
    )),
    (knowledgeHub.matches?.trusted || []).length > 0
      ? `trusted knowledge matches: ${(knowledgeHub.matches.trusted || []).slice(0, 3).map((entry) => `${entry.kind}:${entry.id}`).join(", ")}`
      : null,
    (knowledgeHub.matches?.derived || []).length > 0
      ? `derived knowledge matches: ${(knowledgeHub.matches.derived || []).slice(0, 3).map((entry) => `${entry.kind}:${entry.id}`).join(", ")}`
      : null,
    knowledgeHub.gap_check_needed
      ? `draft gap-check requested: ${knowledgeHub.trust_summary?.gap_check_reason || "trusted retrieval is weak"}`
      : null,
    knowledgeHub.gap_check_needed
      ? `reviewed draft promotion surface: ${draftPromotionContract.review_surface.relative_path}`
      : null,
    adversarialProfileSummary.required && adversarialProfileSummary.profile_id
      ? `adversarial profile ${adversarialProfileSummary.profile_id}: ${adversarialProfileSummary.adversarial_objective}`
      : null,
    ...manifestoAlignmentSignals.map((signal) => `manifesto alignment: ${signal}`),
    ...symmetryHunts.slice(0, 3).map((hunt) => `symmetry hunt ${hunt.id}: ${hunt.label}`),
  ]);

  return {
    generated_at: new Date().toISOString(),
    cwd,
    goal: goalText,
    active_plan: {
      present: !!planDirName,
      plan_dir_name: planDirName || null,
      state: typeof stateJson?.state === "string" ? stateJson.state : null,
    },
    project_manifesto: {
      path: manifestoInfo.path,
      present: manifestoInfo.present,
      usable: manifestoInfo.usable,
      version: manifestoInfo.manifesto.version,
      hard_policies: (manifestoInfo.manifesto.hard_policies || []).map((policy) => policy.id),
      ontology_role: manifestoInfo.manifesto.ontology_role?.mode || null,
    },
    discovery_policy: {
      path: discoveryPolicyInfo.path,
      present: discoveryPolicyInfo.present,
      usable: discoveryPolicyInfo.usable,
      archetype: discoveryPolicy.archetype,
      enabled_matchers: discoveryPolicy.enabled_matchers,
      disabled_matchers: discoveryPolicy.disabled_matchers,
      thresholds: discoveryPolicy.thresholds,
      required_secondary_signals: discoveryPolicy.required_secondary_signals,
      preferred_personas: discoveryPolicy.preferred_personas,
      preferred_workflows: discoveryPolicy.preferred_workflows,
      preferred_recipes: discoveryPolicy.preferred_recipes,
    },
    recommended_entrypoint: recommendedEntryPoint,
    planner_dogfood_incident: dogfoodIncident,
    north_star: manifestoInfo.manifesto.north_star,
    hard_policy_mode: manifestoInfo.manifesto.hard_policy_mode,
    manifesto_alignment_signals: manifestoAlignmentSignals,
    authority_profile: authorityProfile,
    proof_posture: proofPosture,
    phase_contract: phaseContract,
    audit_posture: postureRoute.audit_posture,
    recommended_path: postureRoute.recommended_path,
    recommended_path_reason: postureRoute.reason,
    relevant_workflows: scoredWorkflows.slice(0, 5),
    relevant_recipes: relevantRecipes,
    relevant_skills: uniqueList([
      ...scoredWorkflows.slice(0, 3).flatMap((workflow) => workflow.skill_hints || []),
      ...relevantRecipes.flatMap((recipe) => Array.isArray(recipe.skills) ? recipe.skills : []),
    ]),
    relevant_files: relevantFiles,
    related_stories: storyMatches.slice(0, 6),
    related_mistakes: (mistakeSignal.active_mistakes || []).slice(0, 6),
    related_retros: relatedRetros.slice(0, 6),
    active_obligations: (obligationsSignal.active_obligations || []).slice(0, 6),
    matches: knowledgeHub.matches,
    gap_check_needed: knowledgeHub.gap_check_needed,
    draft_candidate_prompt: draftCandidatePrompt,
    draft_promotion_contract: draftPromotionContract,
    retrieval_trace: knowledgeHub.retrieval_trace,
    trust_summary: knowledgeHub.trust_summary,
    recommended_path_provenance: knowledgeHub.recommended_path_provenance,
    verification_obligation_synthesis: verificationObligationSynthesis,
    adversarial_profile: adversarialProfileSummary,
    suggested_attack_vectors: suggestedAttackVectors,
    symmetry_hunts: symmetryHunts,
    anti_patterns_artifact: {
      path: antiPatternArtifact.path,
      present: antiPatternArtifact.present,
      usable: antiPatternArtifact.usable,
      error: antiPatternArtifact.error,
      count: (antiPatternArtifact.patterns || []).length,
    },
    persona_signals: personaSignals,
    semantic_entities: semanticEntities,
    search_plan: buildSearchPlan(searchTier),
    search_tier: searchTier,
    confidence: recommendedEntryPoint.confidence,
    reasons,
    ignored_signals: ignoredSignals,
    trace_profile: {
      ...traceProfile,
      sources_consulted: uniqueList(traceProfile.sources_consulted),
      tiers_visited: uniqueList(traceProfile.tiers_visited),
    },
    workflow_registry: {
      path: workflowRegistry.path,
      present: workflowRegistry.present,
      usable: workflowRegistry.usable,
      version: workflowRegistry.version,
    },
    recipe_resolution: recipeResolution,
    mistake_signal: {
      status: mistakeSignal.status || "not_detected",
      active_count: mistakeSignal.active_count || 0,
    },
    obligations_signal: {
      required: !!obligationsSignal.required,
      satisfied: obligationsSignal.satisfied !== false,
      active_count: Array.isArray(obligationsSignal.active_obligations) ? obligationsSignal.active_obligations.length : 0,
    },
    retro_registry: {
      ...((retroRegistry && typeof retroRegistry === "object") ? {
        path: retroRegistry.path,
        present: retroRegistry.present,
        usable: retroRegistry.usable,
        version: retroRegistry.version,
        accepted_count: Array.isArray(retroRegistry.accepted_retros) ? retroRegistry.accepted_retros.length : 0,
        warning_count: Array.isArray(retroRegistry.warnings) ? retroRegistry.warnings.length : 0,
      } : {}),
    },
  };
}

export function resolveKnowledge({
  cwd = process.cwd(),
  explicitPlan = null,
  explicitGoal = null,
  explicitFiles = [],
  ignoreActivePlan = false,
} = {}) {
  const { plansDir } = getPaths(cwd);
  const target = (!ignoreActivePlan || explicitPlan)
    ? resolvePlanTarget(plansDir, {
      plan: explicitPlan,
      exitOnMissing: false,
    })
    : { planDir: null, planDirName: null };

  const hasResolvedPlan = !!target.planDir;
  const usePlanContext = hasResolvedPlan && !ignoreActivePlan && (!!explicitPlan || (!explicitGoal && explicitFiles.length === 0));
  const stateJson = usePlanContext ? safeReadJson(join(target.planDir, "state.json")) : null;
  const planContent = usePlanContext ? (readFile(join(target.planDir, "plan.md")) || "") : "";
  const verificationContent = usePlanContext ? (readFile(join(target.planDir, "verification.md")) || "") : "";
  const planGoal = extractGoalFromPlanContent(planContent);
  const goalText = uniqueList([
    explicitGoal,
    typeof stateJson?.goal === "string" ? stateJson.goal : "",
    planGoal,
  ])[0] || "";
  const plannedFilesFromPlan = extractFilesToModify(planContent);
  const plannedFiles = uniqueList([...plannedFilesFromPlan, ...explicitFiles]);
  const storyRegistry = loadStoryRegistry(cwd);
  return resolveKnowledgeFromContext({
    cwd,
    goalText,
    plannedFiles,
    stateJson,
    planDir: usePlanContext ? target.planDir : null,
    planDirName: usePlanContext ? target.planDirName : null,
    planContent,
    verificationContent,
    storyRegistry,
    classificationHints: {
      workflow: { recommended: null },
    },
  });
}

// summarizeKbRelevance — F-05 fix: surface a focused, ranked list of KB
// entries (mistakes, patterns, gotchas, kb_refs) relevant to the current goal.
// The full resolver payload contains many signals; agents at PLAN time only
// need to know "which KB entries should I read first?" — this is that view.
export function summarizeKbRelevance(payload, { limit = 10 } = {}) {
  const matches = payload?.matches || {};
  const trusted = Array.isArray(matches.trusted) ? matches.trusted : [];
  const derived = Array.isArray(matches.derived) ? matches.derived : [];
  const candidates = [...trusted, ...derived];

  const isKbBacked = (entry) => {
    if (!entry) return false;
    if (entry.kind === "kb_ref") return true;
    if (entry.kind === "mistake" || entry.kind === "pattern" || entry.kind === "gotcha") return true;
    const refs = Array.isArray(entry.source_refs) ? entry.source_refs : [];
    return refs.some((ref) => String(ref || "").startsWith("plans/knowledge/"));
  };

  const seen = new Set();
  const entries = [];
  const sorted = candidates
    .filter(isKbBacked)
    .sort((left, right) => (right.score || 0) - (left.score || 0));
  for (const entry of sorted) {
    const key = `${entry.kind || ""}:${entry.id || ""}`;
    if (!entry.id || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      kind: entry.kind || null,
      id: entry.id,
      title: entry.title || null,
      summary: entry.summary || null,
      source_refs: Array.isArray(entry.source_refs) ? entry.source_refs : [],
      trust_level: entry.trust_level || null,
      score: typeof entry.score === "number" ? entry.score : null,
      matched_by: Array.isArray(entry.matched_by) ? entry.matched_by : [],
    });
    if (entries.length >= limit) break;
  }
  return {
    goal: payload?.goal || "",
    count: entries.length,
    entries,
    advisory: entries.length > 0
      ? "Read these KB entries before writing the plan. Trusted entries are deterministic hits; derived entries are advisory and may not always apply."
      : "No KB entries matched this goal. The KB is read at EXPLORE-time anyway via the digest gate; this view is empty when no entry triggers on goal terms or planned files.",
  };
}

function printHelp() {
  console.log(`knowledge_resolver.mjs — Deterministic planner knowledge discovery

Usage:
  node knowledge_resolver.mjs --goal "<goal>" --json
  node knowledge_resolver.mjs --json
  node knowledge_resolver.mjs --dir <path> --plan <plan_dir_name>
  node knowledge_resolver.mjs --goal "<goal>" --file path/to/file --file another/file
  node knowledge_resolver.mjs --dir <path> --goal "<goal>" --no-plan-context --json
  node knowledge_resolver.mjs --goal "<goal>" --kb-relevant [--json]    Focused KB-entry surface only (F-05)

Behavior:
  - Reuses the active plan by default when one exists
  - '--no-plan-context' keeps discovery repo-first by ignoring any ambient active plan unless '--plan' is provided
  - Returns ranked workflows, recipes, files, stories, mistakes, and obligations
  - Emits trust-tiered retrieval groups via matches.trusted / matches.derived / matches.draft
  - '--kb-relevant' emits a compact view of KB entries (mistakes/patterns/gotchas/kb_refs) ranked for the current goal — use this at PLAN time so the KB sharpens as it grows instead of being dumped en masse
  - Emits gap_check_needed, draft_candidate_prompt, draft_promotion_contract, retrieval_trace, and trust_summary for advisory draft fallback
  - Applies repo-local discovery policy from planner.discovery.json when present
  - Emits a trace_profile so tests can prove early-stop behavior and avoid ritual rediscovery
`);
}

const isDirectExecution = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const flags = {
    json: args.includes("--json"),
    noPlanContext: args.includes("--no-plan-context"),
    kbRelevant: args.includes("--kb-relevant"),
  };

  const cwd = readFlagValue(args, "--dir") ? resolve(readFlagValue(args, "--dir")) : process.cwd();
  const explicitPlan = readFlagValue(args, "--plan");
  const explicitGoal = readFlagValue(args, "--goal");
  const explicitFiles = readFlagValues(args, "--file");

  const payload = resolveKnowledge({
    cwd,
    explicitPlan,
    explicitGoal,
    explicitFiles,
    ignoreActivePlan: flags.noPlanContext,
  });

  if (flags.kbRelevant) {
    const summary = summarizeKbRelevance(payload);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      console.log(`KB relevance for goal: ${summary.goal || "(not provided)"}`);
      console.log(`Matched ${summary.count} entry(ies):`);
      for (const entry of summary.entries) {
        const trust = entry.trust_level ? `[${entry.trust_level}]` : "";
        const kind = entry.kind ? `(${entry.kind})` : "";
        console.log(`  - ${entry.id} ${kind} ${trust}`);
        if (entry.title) console.log(`      ${entry.title}`);
        if (entry.summary) console.log(`      ${entry.summary.slice(0, 160)}`);
        if (entry.source_refs?.length) console.log(`      refs: ${entry.source_refs.join(", ")}`);
      }
      console.log(`\n${summary.advisory}`);
    }
    process.exit(0);
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log("Knowledge Resolver");
    console.log(`Goal: ${payload.goal || "(not provided)"}`);
    console.log(`Recommended entrypoint: ${payload.recommended_entrypoint.value} (${payload.recommended_entrypoint.confidence})`);
    console.log(`Audit posture / path: ${payload.audit_posture} / ${payload.recommended_path}`);
    console.log(`Search tier: ${payload.search_tier}`);
    console.log(`Relevant workflows: ${(payload.relevant_workflows || []).map((entry) => entry.id).join(", ") || "(none)"}`);
    console.log(`Relevant files: ${(payload.relevant_files || []).join(", ") || "(none)"}`);
    if ((payload.related_mistakes || []).length > 0) {
      console.log(`Active mistakes: ${payload.related_mistakes.map((entry) => entry.id).join(", ")}`);
    }
    if ((payload.related_retros || []).length > 0) {
      console.log(`Related retros: ${payload.related_retros.map((entry) => entry.id).join(", ")}`);
    }
    if ((payload.active_obligations || []).length > 0) {
      console.log(`Active obligations: ${payload.active_obligations.map((entry) => entry.id).join(", ")}`);
    }
    if ((payload.symmetry_hunts || []).length > 0) {
      console.log(`Symmetry hunts: ${payload.symmetry_hunts.map((entry) => entry.id).join(", ")}`);
    }
    if (payload.trust_summary) {
      console.log(`Knowledge matches: trusted=${payload.trust_summary.trusted_count} derived=${payload.trust_summary.derived_count} draft=${payload.trust_summary.draft_count}`);
      console.log(`Gap check needed: ${payload.gap_check_needed ? `yes (${payload.trust_summary.gap_check_reason || "weak trusted retrieval"})` : "no"}`);
      if (payload.draft_promotion_contract?.active) {
        console.log(`Reviewed draft surface: ${payload.draft_promotion_contract.review_surface.relative_path}`);
      }
    }
    if (payload.adversarial_profile?.required) {
      console.log(`Adversarial profile: ${payload.adversarial_profile.label}`);
      console.log(`Objective: ${payload.adversarial_profile.adversarial_objective}`);
      if ((payload.suggested_attack_vectors || []).length > 0) {
        console.log(`Suggested attack vectors: ${payload.suggested_attack_vectors.map((entry) => entry.id).join(", ")}`);
      }
    }
  }
}
