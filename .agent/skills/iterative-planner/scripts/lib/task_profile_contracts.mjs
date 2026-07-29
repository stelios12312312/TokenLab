import {
  goalLooksLikeCmsContentEdit,
  goalLooksLikeOperationalIntegrationChange,
  goalLooksLikePlannerCoreChange,
  goalLooksLikeStaticUiDeliverable,
  looksLikeStaticUiPath,
} from "./plan_utils.mjs";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMarkdownSection(content, heading) {
  const text = String(content || "");
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRegex = new RegExp(`^## ${escaped}\\s*$`, "m");
  const match = headingRegex.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = text.indexOf("\n## ", start);
  return (nextHeading >= 0 ? text.slice(start, nextHeading) : text.slice(start)).trim();
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isPlaceholderValue(value) {
  const text = normalizeText(value);
  if (!text) return true;
  return [
    "to be",
    "choose one",
    "required for non trivial work",
    "required for non-trivial work",
    "say what semantic surfaces must stay in sync",
    "explain what becomes incoherent",
  ].some((needle) => text.includes(needle));
}

function parseSemanticUpkeepSection(planContent) {
  const section = extractMarkdownSection(planContent, "Semantic Upkeep Contract");
  if (!section) {
    return {
      present: false,
      complete: false,
      fields: {},
      missing_fields: ["profile", "ontology_action", "story_action", "validation_bundle", "strictness_mode", "close_blocker_if_skipped"],
      detail: "Semantic Upkeep Contract section missing from plan.md",
    };
  }

  const fields = {};
  const labels = new Map([
    ["profile", "profile"],
    ["ontology action", "ontology_action"],
    ["story action", "story_action"],
    ["validation bundle", "validation_bundle"],
    ["strictness mode", "strictness_mode"],
    ["close blocker if skipped", "close_blocker_if_skipped"],
  ]);

  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^-\s*([^:]+):\s*(.+)$/);
    if (!match) continue;
    const key = labels.get(normalizeText(match[1]));
    if (!key) continue;
    fields[key] = match[2].trim();
  }

  const missingFields = Array.from(labels.values()).filter((key) => isPlaceholderValue(fields[key]));
  return {
    present: true,
    complete: missingFields.length === 0,
    fields,
    missing_fields: missingFields,
    detail: missingFields.length === 0
      ? "Semantic Upkeep Contract documented"
      : `Semantic Upkeep Contract missing concrete values for: ${missingFields.join(", ")}`,
  };
}

function inferScientificProfile(goalText, plannedFiles) {
  const text = normalizeText(goalText);
  if (/\b(train|training|model|dataset|feature|quant|alpha|backtest|walk forward|walk-forward|temporal split|leakage|calibration|signal|strategy|forecast)\b/.test(text)) {
    return true;
  }
  return plannedFiles.some((filePath) =>
    /\b(model|dataset|feature|quant|alpha|signal|strategy|backtest|calibration|forecast|train)\b/i.test(filePath)
  );
}

function inferWebsiteSemanticChange(goalText) {
  return /\b(cta|information architecture|ia|funnel|journey|navigation|route|routing|entity|entities|taxonomy|promise|capability|signup|checkout)\b/i.test(goalText);
}

export function deriveTaskProfileContract({
  goalText = "",
  classification = null,
  plannedFiles = [],
  recipeResolution = null,
  taskFocusContract = null,
} = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const signals = classification?.signals || {};
  const text = String(goalText || "");
  const recipeRoute = recipeResolution?.primary_resolution?.route || null;
  const focusShape = taskFocusContract?.plan_shape?.primary || null;
  const focusZoom = taskFocusContract?.zoom_level || null;
  const focusIntent = taskFocusContract?.work_intent || null;

  if (focusShape === "planner-core" || focusZoom === "shared_planner_core") {
    return {
      task_profile: {
        id: "planner_core_focus_contract",
        label: "Planner Core Focus Contract",
        reason: "The Task Focus Contract classifies this as shared planner-core steering work.",
      },
      semantic_upkeep: {
        required: true,
        ontology_action: "update_relationships",
        story_action: "link_existing",
        close_blocker_if_skipped: "Planner routing, persona authority, or verification semantics would drift from the implementation.",
        reason: "Shared planner-core changes alter how future plans choose proof obligations.",
      },
      validation_bundle: {
        id: "planner_core_contract",
        reason: "Planner-core focus changes need contract unit proof, scaffold/preflight smoke, migration parity, ripple, invariants, and story traceability.",
      },
      strictness_mode: "full",
    };
  }

  if (focusIntent === "analysis_only" || focusZoom === "read_only") {
    return {
      task_profile: {
        id: "analysis_only",
        label: "Analysis Only",
        reason: "The Task Focus Contract classifies this as read-only analysis rather than an implementation change.",
      },
      semantic_upkeep: {
        required: false,
        ontology_action: "none",
        story_action: "none",
        close_blocker_if_skipped: "Only becomes a blocker if the analysis changes tracked project truth or user-facing promises.",
        reason: "Read-only analysis should not synthesize implementation upkeep.",
      },
      validation_bundle: {
        id: "artifact_review",
        reason: "Analysis-only work is verified by cited artifacts and claim boundaries.",
      },
      strictness_mode: "lightweight",
    };
  }

  const scientific = inferScientificProfile(text, files);
  const website = !scientific && (
    signals.cms_content_edit === true ||
    signals.static_ui_deliverable === true ||
    (files.length > 0 && files.every((filePath) => looksLikeStaticUiPath(filePath))) ||
    goalLooksLikeCmsContentEdit(text, files) ||
    goalLooksLikeStaticUiDeliverable(text, files)
  );
  const integration = !scientific && !website && (
    recipeRoute === "execute_known_recipe" ||
    recipeRoute === "recipe_tidy" ||
    recipeRoute === "recipe_discovery" ||
    goalLooksLikeOperationalIntegrationChange(text, files) ||
    goalLooksLikePlannerCoreChange(text, files) ||
    signals.planned_files_include_runtime === true
  );

  if (scientific) {
    const capabilityPromiseChange = /\b(user|customer|client|operator|dashboard|report|screen|workflow|promise|capability|deliverable)\b/i.test(text);
    return {
      task_profile: {
        id: "scientific_training_quant",
        label: "Scientific / Training / Quant",
        reason: "The goal or planned files look like model, quant, strategy, or scientific-validation work.",
      },
      semantic_upkeep: {
        required: true,
        ontology_action: "update_entities",
        story_action: capabilityPromiseChange ? "revise_existing" : "none",
        close_blocker_if_skipped: capabilityPromiseChange
          ? "Model or signal semantics would drift from the user-facing capability promise."
          : "Model/data semantics would drift from the tracked ontology even if story changes remain optional.",
        reason: "Scientific changes usually shift model/data semantics, even when user-story updates are limited.",
      },
      validation_bundle: {
        id: "benchmark",
        reason: "Scientific validity needs benchmark, leakage, temporal-split, calibration, or parity-style proof rather than wrapper-only tests.",
      },
      strictness_mode: "scientific",
    };
  }

  if (website) {
    const semanticChange = inferWebsiteSemanticChange(text);
    const ontologyAction = semanticChange && /\b(funnel|journey|information architecture|ia|navigation|route|routing)\b/i.test(text)
      ? "update_relationships"
      : semanticChange
        ? "update_entities"
        : "none";
    return {
      task_profile: {
        id: "website_ui_content",
        label: "Website / UI / Content",
        reason: "The task shape looks like UI, website, copy, or static content work.",
      },
      semantic_upkeep: {
        required: semanticChange,
        ontology_action: ontologyAction,
        story_action: semanticChange ? "revise_existing" : "none",
        close_blocker_if_skipped: semanticChange
          ? "User-journey meaning, tracked entities, or funnel semantics would drift from the implementation."
          : "Purely cosmetic or copy-only website work usually does not block close on ontology/story upkeep.",
        reason: semanticChange
          ? "The request appears to touch information architecture, CTA, funnel, navigation, or journey meaning."
          : "The request appears mostly cosmetic or presentational.",
      },
      validation_bundle: {
        id: signals.planned_files_include_runtime === true ? "mixed" : "manual_ui",
        reason: signals.planned_files_include_runtime === true
          ? "UI work with runtime logic should keep manual/visual proof plus a bounded behavioral check."
          : "Artifact-backed manual observation or visual proof is sufficient when runtime logic is unchanged.",
      },
      strictness_mode: classification?.strictness?.mode || "lightweight",
    };
  }

  if (integration) {
    return {
      task_profile: {
        id: "integration_backend_orchestration",
        label: "Integration / Backend / Orchestration",
        reason: "The task shape touches runtime workflows, integration boundaries, or shared execution paths.",
      },
      semantic_upkeep: {
        required: true,
        ontology_action: "update_relationships",
        story_action: "revise_existing",
        close_blocker_if_skipped: "Capability boundaries, workflow semantics, or system relationships would drift from the implementation.",
        reason: "Integration-style changes alter boundary behavior and usually affect real workflow meaning.",
      },
      validation_bundle: {
        id: "integration",
        reason: "Dry-runs, probes, smoke tests, or exercised-system evidence are needed for integration-style work.",
      },
      strictness_mode: classification?.strictness?.mode || "full",
    };
  }

  return {
    task_profile: {
      id: "other",
      label: "Other",
      reason: "The task did not clearly match the website, integration, or scientific profiles.",
    },
    semantic_upkeep: {
      required: false,
      ontology_action: "none",
      story_action: "none",
      close_blocker_if_skipped: "Only becomes a close blocker if the work changes tracked meaning, workflow semantics, or user promises.",
      reason: "No strong profile-specific semantic upkeep requirement was inferred.",
    },
    validation_bundle: {
      id: classification?.evidence?.mode || "behavioral",
      reason: "Use the repo/task-specific verification matrix to choose the final proof bundle.",
    },
    strictness_mode: classification?.strictness?.mode || "lightweight",
  };
}

export function evaluateSemanticUpkeepContract({
  planContent = "",
  goalText = "",
  classification = null,
  plannedFiles = [],
  recipeResolution = null,
  taskFocusContract = null,
} = {}) {
  const derived = deriveTaskProfileContract({ goalText, classification, plannedFiles, recipeResolution, taskFocusContract });
  const parsed = parseSemanticUpkeepSection(planContent);
  const profile = firstNonEmptyString(parsed.fields.profile, derived.task_profile.id);
  const ontologyAction = firstNonEmptyString(parsed.fields.ontology_action, derived.semantic_upkeep.ontology_action);
  const storyAction = firstNonEmptyString(parsed.fields.story_action, derived.semantic_upkeep.story_action);
  const validationBundle = firstNonEmptyString(parsed.fields.validation_bundle, derived.validation_bundle.id);
  const strictnessMode = firstNonEmptyString(parsed.fields.strictness_mode, derived.strictness_mode);
  const closeBlocker = firstNonEmptyString(parsed.fields.close_blocker_if_skipped, derived.semantic_upkeep.close_blocker_if_skipped);

  return {
    required: true,
    present: parsed.present,
    complete: parsed.complete,
    detail: parsed.detail,
    task_profile: {
      ...derived.task_profile,
      documented: parsed.fields.profile || null,
      value: profile,
    },
    semantic_upkeep: {
      ...derived.semantic_upkeep,
      ontology_action: ontologyAction,
      story_action: storyAction,
      close_blocker_if_skipped: closeBlocker,
      documented: {
        ontology_action: parsed.fields.ontology_action || null,
        story_action: parsed.fields.story_action || null,
        close_blocker_if_skipped: parsed.fields.close_blocker_if_skipped || null,
      },
    },
    validation_bundle: {
      ...derived.validation_bundle,
      value: validationBundle,
      documented: parsed.fields.validation_bundle || null,
    },
    strictness_mode: strictnessMode,
    documented_fields: parsed.fields,
    missing_fields: parsed.missing_fields,
  };
}
