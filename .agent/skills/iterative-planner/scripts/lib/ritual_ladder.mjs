const LADDER_STEP_ORDER = Object.freeze([
  "reuse_existing_surface",
  "native_static_or_doc",
  "lightweight_flow",
  "full_planner",
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ");
}

function listFrom(values) {
  if (Array.isArray(values)) return values.filter(Boolean);
  if (values == null) return [];
  return [values].filter(Boolean);
}

function normalizePathText(values) {
  return listFrom(values)
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");
}

function makeStep(id, status, reason, evidence = []) {
  return {
    id,
    status,
    reason,
    evidence: listFrom(evidence).map((entry) => String(entry || "").trim()).filter(Boolean),
  };
}

function hasRecipeExecution(recipeResolution) {
  const primary = recipeResolution?.primary_resolution || {};
  return primary.route === "execute_known_recipe" && primary.recipe_id && primary.runner_present !== false;
}

function isDocOrStaticProof({ classification = null, plannedFiles = [] } = {}) {
  const signals = classification?.signals || {};
  const filesText = normalizePathText(plannedFiles);
  const docOnly = signals.planned_files_doc_only === true ||
    (signals.doc_contract_change === true && signals.planned_files_include_runtime !== true) ||
    (listFrom(plannedFiles).length > 0 && !signals.planned_files_include_runtime && (
      filesText.includes("readme") ||
      filesText.includes("docs") ||
      filesText.includes("documentation") ||
      filesText.includes("guide") ||
      filesText.includes("instructions")
    ));
  const staticOnly = signals.planned_files_static_ui_only === true && signals.cms_content_edit !== true;
  return docOnly || staticOnly;
}

function detectNonSkippableProof({
  goalText = "",
  plannedFiles = [],
  classification = null,
  ticketIntakeCompliance = null,
} = {}) {
  const text = normalizeText(goalText);
  const filesText = normalizePathText(plannedFiles);
  const combined = `${text} ${filesText}`.trim();
  const seen = new Set();
  const rules = [
    [
      /\bac mg 001\b|\bac-mg-001\b|\bmetrics gate\b|\bscoreboard\b|\bbehavior report\b|\bprogram packet metrics\b/.test(combined) ||
        (combined.includes("program packet") && combined.includes("evidence")),
      "program_metrics_gate",
      "Program Packet AC-MG-001 metrics evidence is a required close gate.",
    ],
    [
      ticketIntakeCompliance?.required === true || classification?.signals?.program_intake_request === true,
      "program_packet_traceability",
      "Ticket-shaped work must preserve the local Program Packet intake and receipt proof.",
    ],
    [
      /\btrust boundary\b|\bsecurity\b|\bauth\b|\bauthorization\b|\bauthentication\b|\bcredential\b|\bsecret\b|\bapi key\b|\btoken rotation\b|\bdelete data\b|\bdata loss\b|\bdestructive\b|\bdrop table\b/.test(combined),
      "safety_validation",
      "Security, trust-boundary, credential, or data-loss work must keep explicit validation.",
    ],
    [
      /\bconfig integrity\b|\brebaseline\b|\bmigration\b|\bparity\b/.test(combined),
      "config_integrity",
      "Config, migration, and parity changes must keep integrity proof.",
    ],
    [
      /\bfull planner\b|\bfull iterative planner\b|\bsafe change power\b|\bdo not skip planner\b|\bdon t skip planner\b|\bdo not bypass planner\b/.test(combined) ||
        combined.includes("safe-change-power") ||
        /\bdon't skip planner\b/.test(String(goalText || "").toLowerCase()),
      "explicit_full_flow_request",
      "The operator explicitly requested the full planner or asked not to bypass it.",
    ],
  ];

  return rules
    .filter(([active, id]) => active && !seen.has(id) && seen.add(id))
    .map(([, id, reason]) => ({ id, reason }));
}

function classifyLadderStep({
  classification = null,
  recipeResolution = null,
  plannedFiles = [],
  nonSkippable = [],
  activePlanPoisoned = false,
} = {}) {
  if (hasRecipeExecution(recipeResolution) && nonSkippable.length === 0) {
    return {
      selected_step: "reuse_existing_surface",
      status: "cheap_path_available",
      recommended_action: "execute_existing_surface",
      summary: "A ready recipe surface already exists, so reuse it before creating new planner work.",
    };
  }

  if (nonSkippable.length > 0) {
    return {
      selected_step: "full_planner",
      status: "safety_override",
      recommended_action: activePlanPoisoned ? "recover_then_full_plan" : "bootstrap_full_plan",
      summary: "A non-skippable safety or traceability proof is present, so the ladder stops at the full planner.",
    };
  }

  if (isDocOrStaticProof({ classification, plannedFiles })) {
    return {
      selected_step: "native_static_or_doc",
      status: "cheap_path_available",
      recommended_action: "use_native_surface",
      summary: "The work is documentation or static-artifact shaped, so a native edit/review surface is enough.",
    };
  }

  if (classification?.flow?.mode === "lightweight") {
    return {
      selected_step: "lightweight_flow",
      status: "cheap_path_available",
      recommended_action: "start_lightweight",
      summary: "The task is bounded and can use the lightweight planner flow.",
    };
  }

  return {
    selected_step: "full_planner",
    status: "full_flow_required",
    recommended_action: activePlanPoisoned ? "recover_then_full_plan" : "bootstrap_full_plan",
    summary: "The task shape still needs the full iterative planner flow.",
  };
}

function buildLadderSteps(selection, { recipeResolution, classification, plannedFiles, nonSkippable }) {
  return LADDER_STEP_ORDER.map((id) => {
    if (id === selection.selected_step) {
      return makeStep(id, "selected", selection.summary, [selection.recommended_action]);
    }

    if (nonSkippable.length > 0 && id !== "full_planner") {
      return makeStep(
        id,
        "blocked_by_non_skippable",
        "Cheaper rung is available only when no non-skippable safety or traceability proof is present.",
        nonSkippable.map((entry) => entry.id)
      );
    }

    if (id === "reuse_existing_surface") {
      return hasRecipeExecution(recipeResolution)
        ? makeStep(id, "available", "A deterministic recipe surface can execute this request.", ["execute_known_recipe"])
        : makeStep(id, "unavailable", "No ready recipe execution surface matched the request.");
    }

    if (id === "native_static_or_doc") {
      return isDocOrStaticProof({ classification, plannedFiles })
        ? makeStep(id, "available", "A native documentation or static-artifact surface matches the work.")
        : makeStep(id, "unavailable", "The work is not documentation-only or static-artifact-only.");
    }

    if (id === "lightweight_flow") {
      return classification?.flow?.mode === "lightweight"
        ? makeStep(id, "available", "The preflight classifier marks the task as lightweight.", [classification?.flow?.reason])
        : makeStep(id, "unavailable", "The preflight classifier does not mark the task as lightweight.", [classification?.flow?.reason]);
    }

    return makeStep(id, "available", "The full planner remains the fallback for ambiguous or risky work.");
  });
}

export function resolveRitualMinimizationLadder({
  goalText = "",
  plannedFiles = [],
  classification = null,
  recipeResolution = null,
  ticketIntakeCompliance = null,
  activePlanPoisoned = false,
} = {}) {
  const nonSkippable = detectNonSkippableProof({
    goalText,
    plannedFiles,
    classification,
    ticketIntakeCompliance,
  });
  const selection = classifyLadderStep({
    classification,
    recipeResolution,
    plannedFiles,
    nonSkippable,
    activePlanPoisoned,
  });
  return {
    version: 1,
    selected_step: selection.selected_step,
    status: selection.status,
    recommended_action: selection.recommended_action,
    summary: selection.summary,
    steps: buildLadderSteps(selection, {
      recipeResolution,
      classification,
      plannedFiles,
      nonSkippable,
    }),
    non_skippable: nonSkippable,
  };
}
