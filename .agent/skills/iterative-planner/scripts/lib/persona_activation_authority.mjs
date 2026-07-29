// persona_activation_authority.mjs - shared persona authority decisions.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { detectPlanShape } from "./plan_shape.mjs";
import { extractFilesToModify } from "./plan_utils.mjs";
import { deriveTaskFocusContract, taskFocusPackStatus } from "./task_focus_contract.mjs";

export const PERSONA_ACTIVATION_AUTHORITY_VERSION = "1.1.0";

const ALL_DOMAIN_PACKS = Object.freeze([
  "quant",
  "quant_research_protocol",
  "quant_target",
  "tokenomics",
  "ux_ui",
  "wiring_auditor",
  "assumptions_challenger",
  "config_integrity",
  "traceability",
]);

const RESULT_DOMAIN_PACKS = Object.freeze([
  "quant",
  "quant_research_protocol",
  "quant_target",
  "tokenomics",
  "ux_ui",
]);

const PACK_CLAIM_KEYS = Object.freeze({
  quant: "quant",
  quant_research_protocol: "quant",
  quant_target: "quant",
  tokenomics: "tokenomics",
  ux_ui: "ux_ui",
});

const PACK_FILE_PATTERNS = Object.freeze({
  quant: Object.freeze([/(^|\/)(models?|features?|backtests?|research)\//i, /\b(backtest|model|odds|quant|calibration)\b/i]),
  quant_research_protocol: Object.freeze([/(^|\/)(models?|features?|backtests?|research)\//i, /\b(backtest|model|odds|quant|calibration)\b/i]),
  quant_target: Object.freeze([/(^|\/)(models?|features?|backtests?|research)\//i, /\b(odds|clv|target|betting)\b/i]),
  tokenomics: Object.freeze([/\b(tokenomics|token|vesting|emissions|staking|treasury|governance|liquidity)\b/i]),
  ux_ui: Object.freeze([/\.(jsx?|tsx?|css|scss|html)$/i, /\b(ui|ux|frontend|browser|component|viewport|responsive)\b/i]),
});

const SUPPRESSED_BY_SHAPE = Object.freeze({
  "integration": Object.freeze(["quant", "quant_research_protocol", "quant_target", "ux_ui"]),
  "migration": Object.freeze(["quant", "quant_research_protocol", "quant_target", "ux_ui"]),
  "planner-core": Object.freeze(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui"]),
  "scientific": Object.freeze(["tokenomics", "ux_ui"]),
  "docs": Object.freeze(["quant", "quant_research_protocol", "quant_target", "ux_ui", "wiring_auditor"]),
  "chore": Object.freeze(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui", "wiring_auditor", "assumptions_challenger", "config_integrity"]),
  "analysis": Object.freeze(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui", "wiring_auditor", "assumptions_challenger", "config_integrity"]),
});

const DOMAIN_PROFILE_PACKS = Object.freeze({
  quant: Object.freeze(["quant", "quant_research_protocol"]),
  quant_betting: Object.freeze(["quant", "quant_research_protocol", "quant_target"]),
  tokenomics: Object.freeze(["tokenomics"]),
  frontend: Object.freeze(["ux_ui"]),
  automation: Object.freeze(["assumptions_challenger", "wiring_auditor"]),
  planner_infra: Object.freeze(["assumptions_challenger", "config_integrity", "traceability"]),
});

const PACK_RECOMMENDATION_COPY = Object.freeze({
  quant: Object.freeze({
    recommendation: "check leakage, temporal splits, calibration/stability, and promotion claims before trusting model output",
  }),
  quant_research_protocol: Object.freeze({
    recommendation: "require research-result assumptions, search scale, claim boundary, and promotion evidence only for authoritative research-result work",
  }),
  quant_target: Object.freeze({
    recommendation: "check odds snapshots, CLV/reference-price semantics, and target leakage before treating betting results as real edge",
  }),
  quant_research_protocol: Object.freeze({
    recommendation: "require assumption, optimizer-scale, claim-boundary, and promotion-evidence contracts only when quant research is authoritative for the active plan",
  }),
  tokenomics: Object.freeze({
    recommendation: "check token supply, emissions, vesting, liquidity, treasury, governance, incentive assumptions, and financial/legal claim boundaries before trusting tokenomics work",
  }),
  ux_ui: Object.freeze({
    recommendation: "exercise the rendered browser path and keep screenshot or captured-viewport proof for changed visible states",
  }),
  wiring_auditor: Object.freeze({
    recommendation: "exercise real wiring, callbacks, retries, and failure paths instead of trusting wrapper-only proof",
  }),
  assumptions_challenger: Object.freeze({
    recommendation: "record explicit assumptions, probes, and false-green cases before proceeding",
  }),
  config_integrity: Object.freeze({
    recommendation: "prove config, migration, and compatibility/parity surfaces stayed synchronized",
  }),
  traceability: Object.freeze({
    recommendation: "link the changed behavior to stories, annotations, and proof artifacts so drift is inspectable",
  }),
});

const OBLIGATION_PERSONA_PACKS = Object.freeze({
  api_integration: Object.freeze(["wiring_auditor", "assumptions_challenger"]),
  backend_service: Object.freeze(["wiring_auditor"]),
  browser_ui: Object.freeze(["ux_ui"]),
  cms_missing_content_diagnosis: Object.freeze(["assumptions_challenger"]),
  migration_parity: Object.freeze(["config_integrity", "traceability"]),
  quant_modeling: Object.freeze(["quant"]),
  recipe_orchestration: Object.freeze(["traceability", "wiring_auditor"]),
});

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function sourceRecord(type, id, detail = null, extra = {}) {
  return {
    type,
    id,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

function explicitClaimKeyForPack(packId) {
  return PACK_CLAIM_KEYS[packId] || null;
}

function matchingOwnedFilesForPack(packId, taskFocusContract) {
  const patterns = PACK_FILE_PATTERNS[packId] || [];
  if (patterns.length === 0) return [];
  return unique(asArray(taskFocusContract?.owned_scope?.files).filter((file) =>
    patterns.some((pattern) => pattern.test(String(file || "")))
  )).slice(0, 5);
}

function activationSourcesForPack({ id, taskFocusContract, baseEvidence = [], reason = null, forced = false, shapePrimary = null, focusStatus = null }) {
  const sources = [];
  if (forced) {
    sources.push(sourceRecord("force", "force_packs_override", "audit.config.json force_packs explicitly promoted this pack"));
  }
  if (focusStatus === "authoritative") {
    sources.push(sourceRecord("focus", "task_focus_authoritative_pack", "task-focus contract lists this pack as authoritative"));
  }
  if (focusStatus === "pending_support") {
    sources.push(sourceRecord("focus", "task_focus_pending_support_pack", "pending task focus still permits planner support packs"));
  }
  const claimKey = explicitClaimKeyForPack(id);
  if (claimKey && taskFocusContract?.explicit_domain_claims?.[claimKey] === true) {
    sources.push(sourceRecord("claim", `explicit_domain_claim.${claimKey}`, "task-focus contract detected an explicit domain result claim"));
  }
  for (const file of matchingOwnedFilesForPack(id, taskFocusContract)) {
    sources.push(sourceRecord("file", "owned_scope_file", `owned file matches ${id} domain pattern`, { path: file }));
  }
  if (reason && reason.startsWith("pack_authoritative_for_")) {
    sources.push(sourceRecord("shape", reason, shapePrimary ? `plan shape ${shapePrimary} authorizes this pack by default` : "no shape suppression applies"));
  }
  for (const evidenceId of unique(baseEvidence).filter((entry) => entry && !entry.startsWith("plan_shape:"))) {
    sources.push(sourceRecord("evidence", evidenceId, "caller-provided authority evidence"));
  }
  return sources;
}

function nARecordForPack({ id, shapePrimary = null, reason, taskFocusContract = null, baseEvidence = [], focusStatus = null }) {
  const claimKey = explicitClaimKeyForPack(id);
  const claimText = claimKey ? `${claimKey} explicit_domain_claim=false` : "no explicit domain claim";
  const focusText = focusStatus ? `focus_status=${focusStatus}` : "focus_status=unspecified";
  const rationale = reason === "task_focus_advisory_pack"
    ? "Task focus kept this pack advisory-only; it may inform operator thinking but cannot load contracts, block, or synthesize obligations."
    : `Pack is not applicable to this task focus (${claimText}; ${focusText}).`;
  return {
    type: "N/A",
    pack_id: id,
    reason,
    n_a_rationale: rationale,
    triggering_facts: unique([
      shapePrimary ? `plan_shape:${shapePrimary}` : null,
      taskFocusContract?.plan_shape?.primary ? `task_focus_shape:${taskFocusContract.plan_shape.primary}` : null,
      taskFocusContract?.zoom_level ? `zoom:${taskFocusContract.zoom_level}` : null,
      claimKey ? `explicit_domain_claim.${claimKey}:${taskFocusContract?.explicit_domain_claims?.[claimKey] === true}` : null,
      ...baseEvidence,
    ]),
    reactivation: "Make an explicit domain result claim, declare owned files for this domain, or use force_packs.",
    compact: true,
  };
}

function withActivationSources(decision, opts = {}) {
  return {
    ...decision,
    activation_sources: activationSourcesForPack({
      ...opts,
      id: decision.pack_id,
      reason: decision.reason,
      focusStatus: decision.focus_status || opts.focusStatus || null,
    }),
  };
}

function withNotApplicable(decision, opts = {}) {
  const nARecord = nARecordForPack({
    ...opts,
    id: decision.pack_id,
    reason: decision.reason,
    focusStatus: decision.focus_status || opts.focusStatus || null,
  });
  return {
    ...decision,
    applicability: "not_applicable",
    not_applicable: true,
    n_a_record: nARecord,
    activation_sources: [],
  };
}

function safeRead(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function shapeObject(shape) {
  if (!shape) return null;
  if (typeof shape === "string") return { primary: shape };
  if (typeof shape === "object" && typeof shape.primary === "string") return shape;
  return null;
}

function shapeSourceKind(shape) {
  const source = String(shape?.source || "").toLowerCase();
  if (shape?.declared === true || shape?.source_kind === "declared") return "declared";
  if (source.includes("policy") || source.includes("intent") || source.includes("state")) return "declared";
  if (source) return "inferred";
  return "unknown";
}

function shapeSourceLabel(shape) {
  const source = String(shape?.source || "").trim() || "unknown";
  return `${shapeSourceKind(shape)}:${source}`;
}

function forcePacksForDecision(forcePacks) {
  return normalizeForcePacks(forcePacks);
}

function annotateShapeDecision(decision, { shape = null, shapeWouldSuppress = false, forcePacks = [] } = {}) {
  const normalizedForcePacks = forcePacksForDecision(forcePacks);
  const forced = normalizedForcePacks.includes(decision?.pack_id);
  const mayLoad = decision?.may_load === true;
  return {
    ...decision,
    plan_shape_source: shape?.source || null,
    plan_shape_source_kind: shapeSourceKind(shape),
    plan_shape_source_label: shape ? shapeSourceLabel(shape) : null,
    shape_suppressed: Boolean(shapeWouldSuppress && !forced && !mayLoad),
    shape_would_suppress: Boolean(shapeWouldSuppress && !forced),
    shape_force_packs: normalizedForcePacks,
  };
}

function focusPackDecision({ id, taskFocusContract, shapePrimary, baseEvidence }) {
  if (!taskFocusContract || typeof taskFocusContract !== "object") return null;
  const status = taskFocusPackStatus(taskFocusContract, id);
  const focusEvidence = unique([
    ...baseEvidence,
    taskFocusContract.plan_shape?.primary ? `focus_shape:${taskFocusContract.plan_shape.primary}` : null,
    taskFocusContract.zoom_level ? `zoom:${taskFocusContract.zoom_level}` : null,
  ]);

  if (status === "authoritative") {
    return withActivationSources({
      pack_id: id,
      plan_shape: shapePrimary,
      focus_status: "authoritative",
      authority: "active",
      may_load: true,
      may_emit_guidance: true,
      may_block: true,
      may_synthesize_obligation: true,
      reason: "task_focus_authoritative_pack",
      evidence: focusEvidence,
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence: focusEvidence, shapePrimary, focusStatus: "authoritative" });
  }

  if (status === "advisory") {
    if (taskFocusContract.plan_shape?.primary === "pending_focus" && !RESULT_DOMAIN_PACKS.includes(id)) {
      return withActivationSources({
        pack_id: id,
        plan_shape: shapePrimary,
        focus_status: "pending_support",
        authority: "active",
        may_load: true,
        may_emit_guidance: true,
        may_block: true,
        may_synthesize_obligation: true,
        reason: "task_focus_pending_support_pack",
        evidence: focusEvidence,
        source: "persona_activation_authority",
      }, { taskFocusContract, baseEvidence: focusEvidence, shapePrimary, focusStatus: "pending_support" });
    }
    return withNotApplicable({
      pack_id: id,
      plan_shape: shapePrimary,
      focus_status: "advisory",
      authority: "advisory",
      may_load: false,
      may_emit_guidance: true,
      may_block: false,
      may_synthesize_obligation: false,
      reason: "task_focus_advisory_pack",
      evidence: focusEvidence,
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence: focusEvidence, shapePrimary, focusStatus: "advisory" });
  }

  if (taskFocusContract.plan_shape?.primary === "pending_focus") {
    return withNotApplicable({
      pack_id: id,
      plan_shape: shapePrimary,
      focus_status: "pending_focus",
      authority: "advisory",
      may_load: false,
      may_emit_guidance: true,
      may_block: false,
      may_synthesize_obligation: false,
      reason: "task_focus_pending_clarification",
      evidence: focusEvidence,
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence: focusEvidence, shapePrimary, focusStatus: "pending_focus" });
  }

  return null;
}

export function normalizeForcePacks(value) {
  if (Array.isArray(value)) return unique(value);
  if (value && typeof value === "object" && Array.isArray(value.force_packs)) return unique(value.force_packs);
  return [];
}

export function resolvePersonaAuthorityPlanContext({
  cwd = process.cwd(),
  planDir = null,
  stateJson = null,
  planContent = null,
  goalText = "",
  plannedFiles = null,
  planShape = null,
} = {}) {
  const state = stateJson || (planDir ? safeJson(join(planDir, "state.json")) : null) || {};
  const content = planContent ?? (planDir ? safeRead(join(planDir, "plan.md")) : "");
  const files = Array.isArray(plannedFiles)
    ? unique(plannedFiles)
    : extractFilesToModify(content || "");
  const goal = String(goalText || state.goal || "").trim();
  const stateShape = shapeObject(planShape || state.plan_shape);

  let detected = null;
  try {
    detected = detectPlanShape({
      goalText: goal,
      plannedFiles: files,
      intentContract: planDir ? safeJson(join(planDir, "intent_contract.json")) : null,
    });
  } catch {
    detected = null;
  }

  // Current plan files are fresher than state.json in several planner-core
  // repair paths; prefer their detected shape when they provide real scope.
  const effectiveShape = (files.length > 0 && detected?.primary && detected.primary !== "unknown")
    ? detected
    : (stateShape || detected || null);
  const intentContract = planDir ? safeJson(join(planDir, "intent_contract.json")) : null;
  const taskFocusContract = deriveTaskFocusContract({
    cwd,
    planDir,
    goalText: goal,
    intentContract,
    plannedFiles: files,
    planShape: effectiveShape,
  });

  return {
    cwd,
    plan_dir: planDir,
    plan_shape: effectiveShape,
    plan_shape_primary: effectiveShape?.primary || null,
    task_focus_contract: taskFocusContract,
    planned_files: files,
    goal,
    source: files.length > 0 ? "plan.md" : stateShape ? "state.json" : "detected",
  };
}

export function decidePersonaPackActivation(packId, {
  planShape = null,
  forcePacks = [],
  evidence = [],
  taskFocusContract = null,
  suppressUnspecifiedDomainPacks = false,
} = {}) {
  const id = String(packId || "").trim();
  const shape = shapeObject(planShape);
  const shapePrimary = shape?.primary || null;
  const forced = normalizeForcePacks(forcePacks).includes(id);
  const shapeWouldSuppress = Boolean(shapePrimary && SUPPRESSED_BY_SHAPE[shapePrimary]?.includes(id));
  const baseEvidence = unique([
    shapePrimary ? `plan_shape:${shapePrimary}` : null,
    ...asArray(evidence),
  ]);

  if (!id || id === "core") {
    return annotateShapeDecision({
      pack_id: id,
      plan_shape: shapePrimary,
      authority: "active",
      may_load: id !== "core",
      may_emit_guidance: true,
      may_block: true,
      may_synthesize_obligation: true,
      reason: id === "core" ? "core_role_not_a_pack" : "missing_pack_id",
      evidence: baseEvidence,
      source: "persona_activation_authority",
    }, { shape, shapeWouldSuppress: false, forcePacks });
  }

  if (forced) {
    return annotateShapeDecision(withActivationSources({
      pack_id: id,
      plan_shape: shapePrimary,
      authority: "forced",
      may_load: true,
      may_emit_guidance: true,
      may_block: true,
      may_synthesize_obligation: true,
      reason: "force_packs_override",
      evidence: unique([...baseEvidence, "force_packs"]),
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence: unique([...baseEvidence, "force_packs"]), shapePrimary, forced: true }), { shape, shapeWouldSuppress, forcePacks });
  }

  const focusDecision = focusPackDecision({
    id,
    taskFocusContract,
    shapePrimary,
    baseEvidence,
  });
  if (focusDecision) return annotateShapeDecision(focusDecision, { shape, shapeWouldSuppress, forcePacks });

  const suppressed = shapeWouldSuppress;
  if (suppressed) {
    return annotateShapeDecision(withNotApplicable({
      pack_id: id,
      plan_shape: shapePrimary,
      authority: "suppressed",
      may_load: false,
      may_emit_guidance: false,
      may_block: false,
      may_synthesize_obligation: false,
      reason: `pack_not_authoritative_for_${shapePrimary}`,
      evidence: baseEvidence,
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence, shapePrimary, focusStatus: taskFocusContract ? taskFocusPackStatus(taskFocusContract, id) : null }), { shape, shapeWouldSuppress, forcePacks });
  }

  const taskFocusStatus = taskFocusContract ? taskFocusPackStatus(taskFocusContract, id) : "unknown";
  if (suppressUnspecifiedDomainPacks && taskFocusContract && RESULT_DOMAIN_PACKS.includes(id) && taskFocusStatus === "unspecified") {
    return annotateShapeDecision(withNotApplicable({
      pack_id: id,
      plan_shape: shapePrimary,
      focus_status: "unspecified",
      authority: "suppressed",
      may_load: false,
      may_emit_guidance: false,
      may_block: false,
      may_synthesize_obligation: false,
      reason: "task_focus_no_domain_claim",
      evidence: baseEvidence,
      source: "persona_activation_authority",
    }, { taskFocusContract, baseEvidence, shapePrimary, focusStatus: "unspecified" }), { shape, shapeWouldSuppress, forcePacks });
  }

  const reason = shapePrimary ? `pack_authoritative_for_${shapePrimary}` : "no_shape_suppression";
  return annotateShapeDecision(withActivationSources({
    pack_id: id,
    plan_shape: shapePrimary,
    authority: "active",
    may_load: true,
    may_emit_guidance: true,
    may_block: true,
    may_synthesize_obligation: true,
    reason,
    evidence: baseEvidence,
    source: "persona_activation_authority",
  }, { taskFocusContract, baseEvidence, shapePrimary }), { shape, shapeWouldSuppress, forcePacks });
}

export function decideDomainProfileActivation(profile, opts = {}) {
  const profileId = String(profile || "").trim();
  const packIds = DOMAIN_PROFILE_PACKS[profileId] || [];
  const packDecisions = packIds.map((packId) => decidePersonaPackActivation(packId, opts));
  const activePacks = packDecisions.filter((decision) => decision.may_emit_guidance).map((decision) => decision.pack_id);
  const suppressedPacks = packDecisions.filter((decision) => !decision.may_emit_guidance).map((decision) => decision.pack_id);
  const forced = packDecisions.some((decision) => decision.authority === "forced");
  const active = activePacks.length > 0 || packIds.length === 0;

  return {
    profile: profileId,
    authority: forced ? "forced" : active ? "active" : "suppressed",
    may_emit_guidance: active,
    reason: active ? "profile_has_authoritative_pack" : "profile_not_authoritative_for_active_plan",
    pack_decisions: packDecisions,
    active_packs: unique(activePacks),
    suppressed_packs: unique(suppressedPacks),
    evidence: unique(asArray(opts.evidence)),
    source: "persona_activation_authority",
  };
}

export function filterAuthoritativeRoles(roles, opts = {}) {
  return unique(roles).filter((role) => decidePersonaPackActivation(role, opts).may_load);
}

export function summarizePersonaAuthority(decisions = []) {
  const rows = asArray(decisions).filter(Boolean);
  const notApplicableRows = rows.filter((row) => row.not_applicable || row.n_a_record);
  const shapeSuppressedRows = rows.filter((row) => row.shape_suppressed);
  const shapeSuppression = shapeSuppressedRows.length > 0 ? {
    dropped_packs: unique(shapeSuppressedRows.map((row) => row.pack_id)).filter((id) => id !== "core"),
    shape: shapeSuppressedRows.find((row) => row?.plan_shape)?.plan_shape || null,
    source: shapeSuppressedRows.find((row) => row?.plan_shape_source)?.plan_shape_source || "unknown",
    source_kind: shapeSuppressedRows.find((row) => row?.plan_shape_source_kind)?.plan_shape_source_kind || "unknown",
    source_label: shapeSuppressedRows.find((row) => row?.plan_shape_source_label)?.plan_shape_source_label || "unknown:unknown",
    force_packs: unique(shapeSuppressedRows.flatMap((row) => row.shape_force_packs || [])),
    override: "audit.config.json force_packs",
  } : null;
  return {
    version: PERSONA_ACTIVATION_AUTHORITY_VERSION,
    plan_shape: rows.find((row) => row?.plan_shape)?.plan_shape || null,
    plan_shape_source: rows.find((row) => row?.plan_shape_source)?.plan_shape_source || null,
    plan_shape_source_kind: rows.find((row) => row?.plan_shape_source_kind)?.plan_shape_source_kind || null,
    active_packs: unique(rows.filter((row) => row.authority === "active").map((row) => row.pack_id)).filter((id) => id !== "core"),
    advisory_packs: unique(rows.filter((row) => row.authority === "advisory").map((row) => row.pack_id)).filter((id) => id !== "core"),
    suppressed_packs: unique(rows.filter((row) => row.authority === "suppressed").map((row) => row.pack_id)).filter((id) => id !== "core"),
    forced_packs: unique(rows.filter((row) => row.authority === "forced").map((row) => row.pack_id)).filter((id) => id !== "core"),
    not_applicable_packs: unique(notApplicableRows.map((row) => row.pack_id)).filter((id) => id !== "core"),
    shape_suppression: shapeSuppression,
    active_sources: rows
      .filter((row) => row.may_load || row.authority === "forced" || row.authority === "active")
      .map((row) => ({
        pack_id: row.pack_id,
        authority: row.authority,
        sources: asArray(row.activation_sources),
      }))
      .filter((row) => row.pack_id !== "core" && row.sources.length > 0),
    n_a_decisions: notApplicableRows
      .filter((row) => row.pack_id !== "core")
      .map((row) => ({
        pack_id: row.pack_id,
        authority: row.authority,
        reason: row.reason,
        n_a_rationale: row.n_a_record?.n_a_rationale || "",
        triggering_facts: unique(row.n_a_record?.triggering_facts || []),
        reactivation: row.n_a_record?.reactivation || "",
        compact: row.n_a_record?.compact === true,
      })),
    decisions: rows,
  };
}

export function renderShapeSuppressionReceipt(summaryOrDecisions = [], opts = {}) {
  const summary = Array.isArray(summaryOrDecisions)
    ? summarizePersonaAuthority(summaryOrDecisions)
    : (summaryOrDecisions || {});
  const suppression = summary.shape_suppression || null;
  const dropped = unique(suppression?.dropped_packs || []);
  if (dropped.length === 0) return "";
  const indent = typeof opts.indent === "string" ? opts.indent : "";
  const forcePacks = unique(suppression.force_packs || []);
  return `${indent}Persona shape suppression: dropped_packs=${dropped.join(", ")}; shape=${suppression.shape || "unknown"}; source=${suppression.source_kind || "unknown"}:${suppression.source || "unknown"}; override=audit.config.json force_packs=[${forcePacks.join(", ")}]`;
}

export function personaShapeSuppressionConflicts(personaAdaptationReport = null, summaryOrDecisions = []) {
  const summary = Array.isArray(summaryOrDecisions)
    ? summarizePersonaAuthority(summaryOrDecisions)
    : (summaryOrDecisions || {});
  const suppression = summary.shape_suppression || null;
  const dropped = new Set(unique(suppression?.dropped_packs || []));
  if (dropped.size === 0 || personaAdaptationReport?.confidence !== "high") return [];

  const activeRoles = new Set(unique([
    ...(personaAdaptationReport.configured_roles || []),
    ...(personaAdaptationReport.recommended_seed_roles || []),
    ...(personaAdaptationReport.expected_companions || []),
    ...(personaAdaptationReport.profiles || []).flatMap((profile) => [
      ...(profile.seed_roles || []),
      ...(profile.expected_companions || []),
    ]),
  ]));
  const conflicting = [...dropped].filter((pack) => activeRoles.has(pack));
  if (conflicting.length === 0) return [];
  return [{
    packs: conflicting,
    shape: suppression.shape || summary.plan_shape || "unknown",
    shape_source: `${suppression.source_kind || "unknown"}:${suppression.source || "unknown"}`,
    persona_source: `persona_adapt:${personaAdaptationReport.confidence}`,
    persona_reasons: unique(personaAdaptationReport.reasons || []).slice(0, 6),
  }];
}

export function renderPersonaShapeSuppressionConflicts(personaAdaptationReport = null, summaryOrDecisions = [], opts = {}) {
  const conflicts = personaShapeSuppressionConflicts(personaAdaptationReport, summaryOrDecisions);
  if (conflicts.length === 0) return "";
  const indent = typeof opts.indent === "string" ? opts.indent : "";
  return conflicts.map((conflict) =>
    `${indent}Persona shape conflict: active/high persona_adapt role(s) ${conflict.packs.join(", ")} suppressed by shape=${conflict.shape} (${conflict.shape_source}); advisory only; override with audit.config.json force_packs when intentional.`
  ).join("\n");
}

export function renderPersonaAuthoritySummary(summaryOrDecisions = [], opts = {}) {
  const summary = Array.isArray(summaryOrDecisions)
    ? summarizePersonaAuthority(summaryOrDecisions)
    : (summaryOrDecisions || {});
  const indent = typeof opts.indent === "string" ? opts.indent : "";
  const active = unique([...(summary.active_packs || []), ...(summary.forced_packs || [])]);
  const advisory = unique(summary.advisory_packs || []);
  const suppressed = unique(summary.suppressed_packs || []);
  const notApplicable = unique(summary.not_applicable_packs || []);
  if (active.length === 0 && advisory.length === 0 && suppressed.length === 0 && notApplicable.length === 0) return "";

  const parts = [
    `active=${active.join(", ") || "none"}`,
    `advisory=${advisory.join(", ") || "none"}`,
    `suppressed=${suppressed.join(", ") || "none"}`,
    `n/a=${notApplicable.join(", ") || "none"}`,
  ];
  const lines = [`${indent}Persona authority: ${parts.join("; ")}`];
  const compactReasons = asArray(summary.n_a_decisions)
    .slice(0, opts.maxNADecisions || 4)
    .map((row) => `${row.pack_id}:${row.reason}`);
  if (compactReasons.length > 0) {
    lines.push(`${indent}Persona authority N/A: ${compactReasons.join(", ")}`);
  }
  const shapeReceipt = renderShapeSuppressionReceipt(summary, opts);
  if (shapeReceipt) lines.push(shapeReceipt);
  return lines.join("\n");
}

function personaSignalsForObligation(obligation) {
  return unique([
    ...asArray(obligation?.source_signals)
      .map((signal) => String(signal || "").trim())
      .filter((signal) => signal.startsWith("persona:"))
      .map((signal) => signal.slice("persona:".length)),
    ...asArray(obligation?.matched_persona_packs),
  ]);
}

function mergeProofIds(target, proofIds = []) {
  for (const proofId of asArray(proofIds)) {
    const id = String(proofId || "").trim();
    if (id && !target.includes(id)) target.push(id);
  }
}

function normalizeDisplayPackId(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function collectPersonaTriggeredRecommendations(obligations = []) {
  const byPack = new Map();
  for (const obligation of asArray(obligations)) {
    const packs = personaSignalsForObligation(obligation);
    const provisional = asArray(obligation?.source_signals).includes("persona_recommendation_candidate");
    for (const rawPackId of packs) {
      const packId = normalizeDisplayPackId(rawPackId);
      if (!packId) continue;
      if (!byPack.has(packId)) {
        byPack.set(packId, {
          pack_id: packId,
          recommendation: PACK_RECOMMENDATION_COPY[packId]?.recommendation ||
            "review the persona-owned proof obligation before treating the plan as sufficiently verified",
          obligations: [],
          suggested_proof_ids: [],
          provenance: [],
          provisional: false,
        });
      }
      const entry = byPack.get(packId);
      if (provisional) {
        entry.provisional = true;
        entry.provenance = unique([...entry.provenance, "provisional_active_plan_context"]);
      }
      entry.obligations.push({
        id: obligation?.id || "unknown",
        label: obligation?.label || obligation?.id || "unknown",
        required_proof_type: obligation?.required_proof_type || "",
        proof_ids: asArray(obligation?.proof_ids || obligation?.suggested_proof_ids),
      });
      mergeProofIds(entry.suggested_proof_ids, obligation?.suggested_proof_ids || obligation?.proof_ids);
    }
  }
  return [...byPack.values()].sort((a, b) => a.pack_id.localeCompare(b.pack_id));
}

export function collectProvisionalPersonaTriggeredRecommendations(obligations = [], {
  candidatePackIds = [],
  includeDefaultMappings = true,
} = {}) {
  const candidateSet = new Set(unique(candidatePackIds).map((packId) => packId.toLowerCase()));
  const provisionalObligations = [];

  for (const obligation of asArray(obligations)) {
    const mappedPacks = unique(OBLIGATION_PERSONA_PACKS[obligation?.id] || []);
    if (mappedPacks.length === 0) continue;
    let selectedPacks = candidateSet.size > 0
      ? mappedPacks.filter((packId) => candidateSet.has(packId.toLowerCase()))
      : mappedPacks;
    if (selectedPacks.length === 0 && includeDefaultMappings) selectedPacks = mappedPacks;
    if (selectedPacks.length === 0) continue;

    provisionalObligations.push({
      ...obligation,
      matched_persona_packs: unique([
        ...asArray(obligation?.matched_persona_packs),
        ...selectedPacks,
      ]),
      source_signals: unique([
        ...asArray(obligation?.source_signals),
        ...selectedPacks.map((packId) => `persona:${packId}`),
        "persona_recommendation_candidate",
      ]),
    });
  }

  return collectPersonaTriggeredRecommendations(provisionalObligations);
}

export function renderPersonaTriggeredRecommendations(obligationsOrRecommendations = [], opts = {}) {
  const recommendations = opts.precomputed === true
    ? asArray(obligationsOrRecommendations)
    : collectPersonaTriggeredRecommendations(obligationsOrRecommendations);
  if (recommendations.length === 0) return "";

  const indent = typeof opts.indent === "string" ? opts.indent : "";
  const maxProofIds = Number.isFinite(opts.maxProofIds) ? Math.max(1, opts.maxProofIds) : 6;
  const lines = [`${indent}Persona-triggered recommendations:`];
  for (const row of recommendations) {
    const obligationIds = unique(asArray(row.obligations).map((entry) => entry?.id || entry?.label)).join(", ");
    const proofIds = asArray(row.suggested_proof_ids).slice(0, maxProofIds).join(", ");
    const provenance = row.provisional ? " (provisional)" : "";
    lines.push(`${indent}- ${row.pack_id} triggered ${obligationIds || "verification"}${provenance}: ${row.recommendation}`);
    if (proofIds) lines.push(`${indent}  suggested proof: ${proofIds}`);
  }
  return lines.join("\n");
}

export function allKnownPersonaPacks() {
  return [...ALL_DOMAIN_PACKS];
}
