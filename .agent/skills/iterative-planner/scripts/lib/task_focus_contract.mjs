// task_focus_contract.mjs - front-loaded zoom/focus authority for planner expansion.

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  detectPlanShape,
  hasPositiveEngineeringIntent,
  looksLikeAnalysisGoal,
} from "./plan_shape.mjs";
import { readScopeContract } from "./scope_contract.mjs";

export const TASK_FOCUS_CONTRACT_VERSION = 1;

const GUIDANCE_PACKET_PATH = join("plans", "guidance_packet.json");
const GUIDANCE_PACKET_TYPE = "guidance_packet";
const GUIDANCE_PACKET_SCHEMA_VERSION = 1;

const PLANNER_CORE_AUTHORITATIVE_PACKS = Object.freeze([
  "assumptions_challenger",
  "wiring_auditor",
  "config_integrity",
  "traceability",
]);

const DOMAIN_PACKS = Object.freeze([
  "quant",
  "quant_target",
  "quant_research_protocol",
  "tokenomics",
  "ux_ui",
]);

const PLANNER_CORE_PROOF_FAMILIES = Object.freeze([
  "planner_contract_unit",
  "planner_scaffold_smoke",
  "artifact_reader_parity",
  "migration_parity",
  "ripple_check",
  "ontology_invariants",
  "story_traceability",
]);

const DOMAIN_CLAIM_PROOF_FAMILIES = Object.freeze({
  quant: Object.freeze([
    "optimization_scale_contract",
    "data_lineage",
    "temporal_split",
    "leakage_check",
    "controls_baseline",
    "result_claim_validation",
  ]),
  ux_ui: Object.freeze([
    "rendered_journey",
    "browser_screenshot",
    "responsive_coverage",
    "loading_error_empty_states",
  ]),
  tokenomics: Object.freeze([
    "supply_emissions",
    "vesting_unlocks",
    "liquidity_treasury_governance",
    "financial_legal_boundary",
  ]),
});

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeId(value) {
  return String(value || "").trim();
}

function unique(values) {
  return [...new Set(asArray(values).map(normalizeId).filter(Boolean))];
}

function text(value) {
  return String(value || "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function normalizeWorkIntent(value, fallback) {
  const normalized = lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const allowed = new Set(["analysis_only", "planning_only", "implementation", "repair", "operational", "release", "program_intake"]);
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeZoomLevel(value, fallback) {
  const normalized = lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = {
    shared_planner_core_design: "shared_planner_core",
    planner_core_design: "shared_planner_core",
    planner_core: "shared_planner_core",
  };
  const candidate = aliases[normalized] || normalized;
  const allowed = new Set(["read_only", "design_plan", "focused_change", "shared_planner_core", "domain_result", "program_level"]);
  return allowed.has(candidate) ? candidate : fallback;
}

function shapeObject(shape) {
  if (!shape) return null;
  if (typeof shape === "string") return { primary: shape };
  if (typeof shape === "object" && typeof shape.primary === "string") return shape;
  return null;
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function deepCopy(value) {
  return value == null ? value : structuredClone(value);
}

function guidancePacketHash(packet) {
  const clone = deepCopy(packet);
  delete clone.generated_at;
  delete clone.packet_hash;
  delete clone.artifacts;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex").slice(0, 32);
}

function validGuidancePacketForGoal(packet, goalText) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return false;
  if (packet.packet_type !== GUIDANCE_PACKET_TYPE || packet.schema_version !== GUIDANCE_PACKET_SCHEMA_VERSION) return false;
  if (!text(goalText) || text(packet.goal) !== text(goalText)) return false;
  if (!text(packet.packet_hash) || guidancePacketHash(packet) !== text(packet.packet_hash)) return false;
  return packet.persona_guardrails && typeof packet.persona_guardrails === "object" &&
    packet.program_context && typeof packet.program_context === "object";
}

function validPersistedIntakeContext(context, goalText) {
  return !!(
    context &&
    typeof context === "object" &&
    !Array.isArray(context) &&
    context.packet_type === GUIDANCE_PACKET_TYPE &&
    context.schema_version === GUIDANCE_PACKET_SCHEMA_VERSION &&
    text(context.goal) === text(goalText) &&
    text(context.packet_hash) &&
    context.persona_guardrails &&
    typeof context.persona_guardrails === "object" &&
    context.program_context &&
    typeof context.program_context === "object"
  );
}

function emptyIntakeAmbientScope() {
  return {
    dirty_files: [],
    dirty_count: 0,
    observed_dirty_count: 0,
    examples: [],
    quarantined: false,
    large: false,
    warning: null,
  };
}

function resolveIntakeContext({ cwd, planDir, goalText }) {
  const persistedFocus = planDir ? safeJson(join(planDir, "focus_contract.json")) : null;
  if (validPersistedIntakeContext(persistedFocus?.intake_context, goalText)) {
    return {
      context: deepCopy(persistedFocus.intake_context),
      ambientScope: persistedFocus.ambient_scope && typeof persistedFocus.ambient_scope === "object"
        ? deepCopy(persistedFocus.ambient_scope)
        : emptyIntakeAmbientScope(),
    };
  }

  const packet = safeJson(join(cwd, GUIDANCE_PACKET_PATH));
  if (!validGuidancePacketForGoal(packet, goalText)) return null;
  return {
    context: {
      source: "task_intake_guidance_packet",
      source_path: GUIDANCE_PACKET_PATH.replace(/\\/g, "/"),
      packet_type: packet.packet_type,
      schema_version: packet.schema_version,
      packet_hash: packet.packet_hash,
      goal: packet.goal,
      persona_guardrails: deepCopy(packet.persona_guardrails),
      program_context: deepCopy(packet.program_context),
    },
    // task_intake does not publish a dirty-file scope. Do not let files dirtied
    // after intake silently become authoritative ambient context at bootstrap.
    ambientScope: emptyIntakeAmbientScope(),
  };
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function compactExamples(values, limit = 5) {
  return unique(values).slice(0, limit);
}

function scopeFromInput(scopeContract, plannedFiles = []) {
  const declared = unique([
    ...asArray(scopeContract?.declared_files),
    ...asArray(plannedFiles),
  ].map(normalizePath));
  const owned = unique((scopeContract?.owned_files || declared).map(normalizePath));
  const ambient = unique(asArray(scopeContract?.ambient_dirty_files).map(normalizePath));
  const observed = unique(asArray(scopeContract?.observed_dirty_files_at_start).map(normalizePath));
  const largeAmbient = scopeContract?.summary?.large_ambient_dirty === true || ambient.length >= 20;

  return {
    declared,
    owned,
    ambient,
    observed,
    largeAmbient,
  };
}

function detectExplicitClaims(goalText = "", intentContract = null, plannedFiles = []) {
  const haystack = lower([
    goalText,
    intentContract?.job_to_be_done,
    ...asArray(intentContract?.desired_outcomes),
    ...asArray(intentContract?.allowed_claims),
    ...asArray(plannedFiles),
  ].join("\n"));

  const antiGoals = lower([
    ...asArray(intentContract?.anti_goals),
    ...asArray(intentContract?.forbidden_claims),
  ].join("\n"));

  const quant = (
    /\b(backtest|walk[\s-]?forward|temporal split|leakage|calibration|odds|clv|trading|betting|alpha|model target|optimizer|hyperparameter|trueskill|markov|elo|forecast|prediction)\b/i.test(haystack) &&
    !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(backtest|odds|trading|model|quant|ui|browser)\b/i.test(haystack)
  ) || /(^|[\s/])(models?|features?|strateg(y|ies)|backtests?|quant|research)\//i.test(haystack);

  const ux = (
    /\b(frontend|browser|rendered|screenshot|responsive|accessibility|a11y|viewport|ui|ux|component|visual state|landing page|web page|website|static html|static page)\b/i.test(haystack) &&
    !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(browser|ui|ux|rendering|screenshot)\b/i.test(haystack)
  ) || /\.(jsx?|tsx?|css|scss|html)\b/i.test(haystack);

  const tokenomics = (
    /\b(tokenomics|token economics|token supply|emissions|vesting|unlocks|staking|airdrop|fdv|treasury|governance|liquidity)\b/i.test(haystack) &&
    !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(tokenomics|token|vesting|staking)\b/i.test(haystack)
  );

  return {
    quant: quant && !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(backtest|odds|trading|model|quant)\b/i.test(antiGoals),
    ux_ui: ux && !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(browser|ui|ux|rendering|screenshot)\b/i.test(antiGoals),
    tokenomics: tokenomics && !/\b(do not|forbidden|anti[-\s]?goal|no )\b.{0,80}\b(tokenomics|token|vesting|staking)\b/i.test(antiGoals),
  };
}

function looksLikePlannerFocusGoal(goalText = "", intentContract = null) {
  const haystack = lower([
    goalText,
    intentContract?.job_to_be_done,
    ...asArray(intentContract?.desired_outcomes),
  ].join("\n"));
  if (!/\b(planner|persona|gate|scaffold|verification obligation|bootstrap|preflight)\b/.test(haystack)) return false;
  return /\b(task focus|focus contract|steering controller|right zoom|zoom level|obligation expansion|persona expansion)\b/.test(haystack);
}

function inferWorkIntent(goalText = "", triage = null, intentContract = null) {
  const goal = lower(goalText || intentContract?.job_to_be_done || "");
  if (triage?.recommended_path === "skip_planner_question" || /\?\s*$/.test(goal)) return "analysis_only";
  if (triage?.recommended_path === "skip_planner" && (triage?.shape?.primary === "analysis" || looksLikeAnalysisGoal(goal))) return "analysis_only";
  if (triage?.recommended_path === "skip_planner") return "operational";
  if (/\b(plan|design|roadmap|strategy|proposal|review|analy[sz]e|audit)\b/.test(goal) && !hasPositiveEngineeringIntent(goal)) return "planning_only";
  if (/\b(release|cut release|ship)\b/.test(goal)) return "release";
  if (/\b(program|roadmap|ticket|backlog|epic)\b/.test(goal)) return "program_intake";
  if (/\b(fix|repair|bug|regression|incident)\b/.test(goal)) return "repair";
  return "implementation";
}

function inferZoomLevel({ workIntent, shapePrimary, claims, ownedFiles }) {
  if (workIntent === "analysis_only") return "read_only";
  if (workIntent === "planning_only") return shapePrimary === "planner-core" ? "shared_planner_core" : "design_plan";
  if (workIntent === "program_intake") return "program_level";
  if (claims.quant || claims.ux_ui || claims.tokenomics) return "domain_result";
  if (shapePrimary === "planner-core") return "shared_planner_core";
  if (ownedFiles.length > 0) return "focused_change";
  return "design_plan";
}

function addDomainAuthority({ authoritative, proofFamilies, allowedClaims, forbiddenClaims, claims }) {
  if (claims.quant) {
    authoritative.push("quant", "quant_research_protocol", "quant_target");
    proofFamilies.push(...DOMAIN_CLAIM_PROOF_FAMILIES.quant);
    allowedClaims.push("quant/model result claims only with data lineage, leakage, temporal split, controls, and validation proof");
  } else {
    forbiddenClaims.push("trading, odds, model, backtest, optimizer, or calibration result quality");
  }

  if (claims.ux_ui) {
    authoritative.push("ux_ui");
    proofFamilies.push(...DOMAIN_CLAIM_PROOF_FAMILIES.ux_ui);
    allowedClaims.push("browser/UI behavior claims only with rendered journey and visual proof");
  } else {
    forbiddenClaims.push("browser rendering, responsive layout, accessibility, or visual-state quality");
  }

  if (claims.tokenomics) {
    authoritative.push("tokenomics");
    proofFamilies.push(...DOMAIN_CLAIM_PROOF_FAMILIES.tokenomics);
    allowedClaims.push("tokenomics design claims only with supply, vesting, liquidity, governance, and advisory-boundary proof");
  } else {
    forbiddenClaims.push("token supply, vesting, staking, FDV, liquidity, or governance quality");
  }
}

function explicitIntentTaskFocus(intentContract) {
  const focus = intentContract?.task_focus_contract;
  return focus && typeof focus === "object" && !Array.isArray(focus) ? focus : null;
}

function normalizePackListFromIntent(value) {
  return unique(asArray(value).map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") return entry.pack_id || entry.id || entry.pack;
    return null;
  }));
}

export function deriveTaskFocusContract({
  cwd = process.cwd(),
  planDir = null,
  goalText = "",
  intentContract = null,
  scopeContract = null,
  plannerPolicy = null,
  planShape = null,
  triage = null,
  taskProfile = null,
  programContext = null,
  forcedPacks = [],
  plannedFiles = [],
} = {}) {
  const intent = intentContract || (planDir ? safeJson(join(planDir, "intent_contract.json")) : null) || {};
  const effectiveGoalText = goalText || intent?.job_to_be_done || "";
  const intakeResolution = resolveIntakeContext({ cwd, planDir, goalText: effectiveGoalText });
  const intakeContext = intakeResolution?.context || null;
  const intakePersona = intakeContext?.persona_guardrails || null;
  const focusFromIntent = explicitIntentTaskFocus(intent);
  const effectiveScope = scopeContract || (planDir ? readScopeContract(planDir) : null);
  const scope = scopeFromInput(effectiveScope, plannedFiles);
  const shapeInput = shapeObject(planShape);
  const detectedShape = shapeInput || detectPlanShape({
    goalText: goalText || intent?.job_to_be_done || "",
    plannedFiles: scope.owned,
    intentContract: intent,
  });
  const plannerFocusGoal = looksLikePlannerFocusGoal(goalText, intent);
  const shapePrimary = (detectedShape?.primary === "unknown" && plannerFocusGoal)
    ? "planner-core"
    : (detectedShape?.primary || "unknown");
  const shapeSource = (detectedShape?.primary === "unknown" && plannerFocusGoal)
    ? "task_focus_goal"
    : (detectedShape?.source || "unknown");
  const noOwnedScope = scope.owned.length === 0;
  const pendingFocus = !focusFromIntent && noOwnedScope && (!shapePrimary || shapePrimary === "unknown");
  const effectiveShapePrimary = pendingFocus ? "pending_focus" : shapePrimary;
  const explicitClaims = detectExplicitClaims(goalText, intent, scope.owned);
  const authoritative = [];
  const proofFamilies = [];
  const allowedClaims = [
    ...asArray(focusFromIntent?.allowed_claims),
  ];
  const forbiddenClaims = [
    ...asArray(focusFromIntent?.forbidden_claims),
  ];
  const advisory = [];
  const suppressed = [];
  const blockers = [];
  const notes = [];

  const inferredWorkIntent = inferWorkIntent(goalText, triage, intent);
  const workIntent = normalizeWorkIntent(focusFromIntent?.work_intent, inferredWorkIntent);
  const inferredZoomLevel = inferZoomLevel({
    workIntent,
    shapePrimary: effectiveShapePrimary,
    claims: explicitClaims,
    ownedFiles: scope.owned,
  });
  const zoomLevel = normalizeZoomLevel(focusFromIntent?.zoom_level, inferredZoomLevel);

  if (pendingFocus) {
    blockers.push({
      id: "focus_scope_missing",
      severity: "blocker",
      message: "No explicit shape or owned scope exists; clarify the task focus before adding blocking domain obligations.",
    });
    advisory.push(...DOMAIN_PACKS, ...PLANNER_CORE_AUTHORITATIVE_PACKS);
    proofFamilies.push("focus_clarification");
  } else if (effectiveShapePrimary === "planner-core" || zoomLevel === "shared_planner_core") {
    authoritative.push(...PLANNER_CORE_AUTHORITATIVE_PACKS);
    proofFamilies.push(...PLANNER_CORE_PROOF_FAMILIES);
    allowedClaims.push("planner-core focus, routing, scaffold, and verification behavior");
    notes.push("planner-core scope activates shared-surface proof and quarantines unrelated domain packs");
  }

  addDomainAuthority({
    authoritative,
    proofFamilies,
    allowedClaims,
    forbiddenClaims,
    claims: explicitClaims,
  });

  const shouldDefaultDomainAdvisory = pendingFocus || effectiveShapePrimary === "planner-core" || !!focusFromIntent;
  if (shouldDefaultDomainAdvisory) {
    for (const pack of DOMAIN_PACKS) {
      if (!authoritative.includes(pack)) advisory.push(pack);
    }
  }

  const forced = unique(forcedPacks);
  for (const pack of forced) {
    authoritative.push(pack);
    notes.push(`forced pack override: ${pack}`);
  }

  const intentAuthoritative = normalizePackListFromIntent(focusFromIntent?.authoritative_packs);
  const intentAdvisory = normalizePackListFromIntent(focusFromIntent?.advisory_packs);
  authoritative.push(...intentAuthoritative);
  advisory.push(...intentAdvisory);

  const intakeAuthoritative = normalizePackListFromIntent(intakePersona?.active_packs);
  const intakeSuppressed = asArray(intakePersona?.suppressed_or_advisory_packs);
  const intakeAdvisory = normalizePackListFromIntent(intakeSuppressed);
  const authoritativeUnique = intakeContext
    ? unique([...intakeAuthoritative, ...forced, ...intentAuthoritative])
    : unique(authoritative);
  const advisoryUnique = (intakeContext ? intakeAdvisory : unique(advisory))
    .filter((pack) => !authoritativeUnique.includes(pack));
  if (intakeContext) {
    suppressed.push(...deepCopy(intakeSuppressed).filter((entry) =>
      !authoritativeUnique.includes(normalizeId(entry?.pack_id || entry?.id || entry))));
  } else {
    suppressed.push(...advisoryUnique.map((pack) => ({
      pack_id: pack,
      authority: "advisory",
      rationale: focusFromIntent?.suppression_rationale ||
        "Not authoritative for this task focus; may warn but cannot inject blocking contracts.",
      reactivation: "Make an explicit domain result claim, declare owned files for this domain, or use force_packs.",
    })));
  }

  const confidence = pendingFocus
    ? "low"
    : (effectiveShapePrimary === "unknown" ? "medium" : "high");
  const ambientWarning = scope.ambient.length > 0
    ? `Ambient dirty scope quarantined: ${scope.ambient.length} file(s) are not owned by this task.`
    : null;
  const derivedAmbientScope = {
    dirty_files: scope.ambient,
    dirty_count: scope.ambient.length,
    observed_dirty_count: scope.observed.length || scope.ambient.length,
    examples: compactExamples(scope.ambient),
    quarantined: scope.ambient.length > 0,
    large: scope.largeAmbient,
    warning: ambientWarning,
  };

  return {
    version: TASK_FOCUS_CONTRACT_VERSION,
    operator_question: focusFromIntent?.operator_question || text(goalText || intent?.job_to_be_done || "Clarify the task focus before expansion."),
    work_intent: workIntent,
    zoom_level: zoomLevel,
    plan_shape: {
      primary: effectiveShapePrimary,
      detected_primary: shapePrimary,
      source: pendingFocus ? "pending_focus" : shapeSource,
      confidence,
    },
    owned_scope: {
      files: scope.owned,
      declared_files: scope.declared,
      source: effectiveScope ? "scope_contract" : "planned_files",
      sufficient_for_blocking_obligations: scope.owned.length > 0 || explicitClaims.quant || explicitClaims.ux_ui || explicitClaims.tokenomics,
      confidence: scope.owned.length > 0 ? "high" : "low",
    },
    ambient_scope: intakeResolution?.ambientScope || derivedAmbientScope,
    allowed_claims: unique(allowedClaims),
    forbidden_claims: unique(forbiddenClaims),
    authoritative_packs: authoritativeUnique,
    advisory_packs: advisoryUnique,
    suppressed_packs: suppressed,
    required_proof_families: unique([
      ...asArray(intakePersona?.required_proof_families),
      ...asArray(focusFromIntent?.required_proof_families),
      ...proofFamilies,
    ]),
    explicit_domain_claims: explicitClaims,
    escalation: {
      workflow: focusFromIntent?.future_workflow || (effectiveShapePrimary === "planner-core" ? "/safe-change-power" : null),
      reason: effectiveShapePrimary === "planner-core"
        ? "Shared planner-core behavior changes need ripple, migration, story, and invariant proof."
        : null,
    },
    confidence,
    blockers,
    notes,
    planner_policy: plannerPolicy ? { present: true } : { present: false },
    task_profile: taskProfile?.id || taskProfile?.task_profile?.id || null,
    program_context: intakeContext ? deepCopy(intakeContext.program_context) : (programContext || null),
    ...(intakeContext ? { intake_context: deepCopy(intakeContext) } : {}),
  };
}

export function readTaskFocusContract(planDir, opts = {}) {
  if (!planDir) return deriveTaskFocusContract(opts);
  return deriveTaskFocusContract({
    ...opts,
    planDir,
    intentContract: opts.intentContract || safeJson(join(planDir, "intent_contract.json")),
    scopeContract: opts.scopeContract || readScopeContract(planDir),
  });
}

export function taskFocusPackStatus(contract, packId) {
  const id = normalizeId(packId);
  if (!id) return "unknown";
  if (unique(contract?.authoritative_packs).includes(id)) return "authoritative";
  if (unique(contract?.advisory_packs).includes(id)) return "advisory";
  if (asArray(contract?.suppressed_packs).some((entry) => normalizeId(entry?.pack_id || entry?.id || entry) === id)) return "advisory";
  return "unspecified";
}

export function summarizeTaskFocusContract(contract) {
  if (!contract || typeof contract !== "object") return "Focus: unavailable";
  const shape = contract.plan_shape?.primary || "unknown";
  const zoom = contract.zoom_level || "unknown";
  const authoritative = unique(contract.authoritative_packs).join(", ") || "none";
  const advisory = unique(contract.advisory_packs).join(", ") || "none";
  const ambient = Number(contract.ambient_scope?.dirty_count || 0);
  const blockerCount = asArray(contract.blockers).length;
  return `Focus: ${shape}/${zoom}; authoritative=${authoritative}; advisory-only=${advisory}; ambient_quarantined=${ambient}; blockers=${blockerCount}`;
}
