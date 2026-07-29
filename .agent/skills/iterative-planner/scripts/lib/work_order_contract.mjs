// work_order_contract.mjs - deterministic work-order contract validation.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const WORK_ORDER_SCHEMA_VERSION = 1;
const WORK_ORDER_PROJECTION_VERSION = 1;
const PLAN_WORK_ORDER_FILENAME = "work_order.json";

const PROOF_METHODS = new Set(["executed", "deterministic", "rubric"]);
const WORK_ORDER_PROFILE_TYPES = new Set(["recipe"]);

const REQUIRED_WORK_ORDER_FIELDS = [
  "schema_version",
  "goal",
  "inputs",
  "constraints",
  "claims_to_produce",
  "proof_obligations",
  "stop_conditions",
  "budget",
];

const REQUIRED_BUDGET_FIELDS = [
  "max_tokens",
  "max_cost_usd",
  "max_time_minutes",
];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

const AMBIGUOUS_GOAL_PATTERNS = [
  /^fix stuff$/,
  /^fix things$/,
  /^improve this$/,
  /^improve it$/,
  /^do it$/,
  /^handle this$/,
  /^make it better$/,
  /^clean up$/,
  /^update things$/,
  /^optimize it$/,
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function looksAmbiguousGoal(goal) {
  const text = normalizedText(goal);
  if (!text) return true;
  if (text.length < 16) return true;
  if (text.split(/\s+/).length < 3) return true;
  return AMBIGUOUS_GOAL_PATTERNS.some((pattern) => pattern.test(text));
}

function hasUsableCommand(value) {
  if (isNonEmptyString(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function validateId(value, path, label, errors) {
  if (!isNonEmptyString(value)) {
    addIssue(errors, `${label}_id_missing`, path, `${label} id must be non-empty`);
    return false;
  }
  if (!ID_PATTERN.test(value)) {
    addIssue(errors, `${label}_id_invalid`, path, `${label} id must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function validatePatternId(value, path, label, pattern, errors) {
  if (!isNonEmptyString(value)) {
    addIssue(errors, `${label}_missing`, path, `${label} must be non-empty`);
    return false;
  }
  if (!pattern.test(value)) {
    addIssue(errors, `${label}_invalid`, path, `${label} must match ${pattern}`);
    return false;
  }
  return true;
}

function validateStringArray(value, path, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(errors, `${label}_empty`, path, `${label} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      addIssue(errors, `${label}_entry_invalid`, `${path}[${index}]`, `${label} entries must be non-empty strings`);
    }
  });
}

function validateInputs(inputs, errors) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    addIssue(errors, "inputs_empty", "inputs", "inputs must be a non-empty array of artifact refs");
    return;
  }

  inputs.forEach((input, index) => {
    const basePath = `inputs[${index}]`;
    if (!isPlainObject(input)) {
      addIssue(errors, "input_not_object", basePath, "inputs entries must be objects");
      return;
    }
    validateId(input.id, `${basePath}.id`, "input", errors);
    if (!isNonEmptyString(input.ref)) {
      addIssue(errors, "input_ref_missing", `${basePath}.ref`, "inputs entries must include a non-empty artifact ref");
    }
  });
}

function validateClaims(claims, errors) {
  const claimIds = new Map();

  if (!Array.isArray(claims) || claims.length === 0) {
    addIssue(errors, "claims_empty", "claims_to_produce", "claims_to_produce must be a non-empty array");
    return claimIds;
  }

  claims.forEach((claim, index) => {
    const basePath = `claims_to_produce[${index}]`;
    if (!isPlainObject(claim)) {
      addIssue(errors, "claim_not_object", basePath, "claims_to_produce entries must be objects");
      return;
    }

    if (validateId(claim.id, `${basePath}.id`, "claim", errors)) {
      if (claimIds.has(claim.id)) {
        addIssue(
          errors,
          "duplicate_claim_id",
          `${basePath}.id`,
          `Duplicate claim id '${claim.id}' also appears at claims_to_produce[${claimIds.get(claim.id)}].id`,
        );
      } else {
        claimIds.set(claim.id, index);
      }
    }

    if (!isNonEmptyString(claim.statement)) {
      addIssue(errors, "claim_statement_missing", `${basePath}.statement`, "Claim must include a non-empty statement");
    }
  });

  return claimIds;
}

function validateProofObligationDetail(obligation, basePath, errors) {
  if (obligation.method === "executed" && !hasUsableCommand(obligation.command) && !isNonEmptyString(obligation.command_or_action)) {
    addIssue(
      errors,
      "executed_proof_missing_command",
      basePath,
      "executed proof obligations require command or command_or_action",
    );
  }

  if (obligation.method === "deterministic" && !isNonEmptyString(obligation.check) && !isNonEmptyString(obligation.predicate)) {
    addIssue(
      errors,
      "deterministic_proof_missing_check",
      basePath,
      "deterministic proof obligations require check or predicate",
    );
  }

  if (obligation.method === "rubric" && !isNonEmptyString(obligation.rubric_ref) && !isNonEmptyString(obligation.rubric)) {
    addIssue(errors, "rubric_proof_missing_rubric", basePath, "rubric proof obligations require rubric_ref or rubric");
  }
}

function validateProofObligations(obligations, claimIds, errors) {
  const obligationsByClaim = new Map();

  if (!Array.isArray(obligations) || obligations.length === 0) {
    addIssue(errors, "proof_obligations_empty", "proof_obligations", "proof_obligations must be a non-empty array");
    for (const claimId of claimIds.keys()) {
      addIssue(
        errors,
        "claim_missing_proof_obligation",
        `claims_to_produce[${claimIds.get(claimId)}].id`,
        `Claim '${claimId}' has no matching proof_obligations entry`,
      );
    }
    return obligationsByClaim;
  }

  obligations.forEach((obligation, index) => {
    const basePath = `proof_obligations[${index}]`;
    if (!isPlainObject(obligation)) {
      addIssue(errors, "proof_obligation_not_object", basePath, "proof_obligations entries must be objects");
      return;
    }

    if (!isNonEmptyString(obligation.claim_id)) {
      addIssue(errors, "proof_claim_id_missing", `${basePath}.claim_id`, "Proof obligation must name a claim_id");
    } else if (!claimIds.has(obligation.claim_id)) {
      addIssue(
        errors,
        "orphan_proof_obligation",
        `${basePath}.claim_id`,
        `Proof obligation references unknown claim_id '${obligation.claim_id}'`,
      );
    } else {
      const existing = obligationsByClaim.get(obligation.claim_id) || [];
      existing.push(index);
      obligationsByClaim.set(obligation.claim_id, existing);
    }

    if (!PROOF_METHODS.has(obligation.method)) {
      addIssue(
        errors,
        "unknown_proof_method",
        `${basePath}.method`,
        `Proof method must be one of: ${[...PROOF_METHODS].join(", ")}`,
      );
    } else {
      validateProofObligationDetail(obligation, basePath, errors);
    }
  });

  for (const claimId of claimIds.keys()) {
    if (!obligationsByClaim.has(claimId)) {
      addIssue(
        errors,
        "claim_missing_proof_obligation",
        `claims_to_produce[${claimIds.get(claimId)}].id`,
        `Claim '${claimId}' has no matching proof_obligations entry`,
      );
    }
  }

  return obligationsByClaim;
}

function isUnboundedBudgetValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    return /^(unbounded|unlimited|infinite|infinity|none|n\/a)$/i.test(value.trim());
  }
  return false;
}

function validateBudgetField(budget, field, errors) {
  const path = `budget.${field}`;
  if (!Object.prototype.hasOwnProperty.call(budget, field)) {
    addIssue(errors, "budget_field_missing", path, `budget must include ${field}`);
    return;
  }

  const value = budget[field];
  if (isUnboundedBudgetValue(value)) {
    addIssue(errors, "budget_field_unbounded", path, `${field} must be explicitly bounded`);
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(errors, "budget_field_invalid", path, `${field} must be a finite number`);
    return;
  }

  if (field === "max_tokens" && (!Number.isInteger(value) || value <= 0)) {
    addIssue(errors, "budget_field_invalid", path, "max_tokens must be a positive integer");
  }

  if (field === "max_cost_usd" && value < 0) {
    addIssue(errors, "budget_field_invalid", path, "max_cost_usd must be zero or greater");
  }

  if (field === "max_time_minutes" && value <= 0) {
    addIssue(errors, "budget_field_invalid", path, "max_time_minutes must be greater than zero");
  }
}

function validateBudget(budget, errors) {
  if (!isPlainObject(budget)) {
    addIssue(errors, "budget_not_object", "budget", "budget must be an object with finite token, cost, and time bounds");
    return;
  }

  for (const field of REQUIRED_BUDGET_FIELDS) {
    validateBudgetField(budget, field, errors);
  }
}

function validateRecipeProfileRunner(runner, errors) {
  const basePath = "profile.runner";
  if (!isPlainObject(runner)) {
    addIssue(errors, "recipe_profile_runner_missing", basePath, "recipe profile requires a runner object");
    return;
  }

  if (runner.type !== "command") {
    addIssue(errors, "recipe_profile_runner_type_invalid", `${basePath}.type`, "recipe profile runner.type must be 'command'");
  }

  if (!Array.isArray(runner.command) || runner.command.length === 0) {
    addIssue(errors, "recipe_profile_runner_command_missing", `${basePath}.command`, "recipe profile runner.command must be a non-empty command array");
  } else {
    runner.command.forEach((token, index) => {
      if (!isNonEmptyString(token)) {
        addIssue(errors, "recipe_profile_runner_command_invalid", `${basePath}.command[${index}]`, "recipe profile command entries must be non-empty strings");
      }
    });
  }

  if (!Array.isArray(runner.dry_run_flags) || runner.dry_run_flags.length === 0) {
    addIssue(
      errors,
      "recipe_profile_missing_dry_run_contract",
      `${basePath}.dry_run_flags`,
      "recipe profile runners must declare non-empty dry_run_flags so cheap-agent execution fails closed by default",
    );
  } else {
    runner.dry_run_flags.forEach((flag, index) => {
      if (!isNonEmptyString(flag)) {
        addIssue(errors, "recipe_profile_dry_run_flag_invalid", `${basePath}.dry_run_flags[${index}]`, "dry-run flags must be non-empty strings");
      }
    });
  }

  if ("live_flags" in runner && (!Array.isArray(runner.live_flags) || !runner.live_flags.every(isNonEmptyString))) {
    addIssue(errors, "recipe_profile_live_flags_invalid", `${basePath}.live_flags`, "live_flags must be an array of non-empty strings when provided");
  }

  if ("defaults" in runner && !isPlainObject(runner.defaults)) {
    addIssue(errors, "recipe_profile_defaults_invalid", `${basePath}.defaults`, "runner defaults must be an object when provided");
  }
}

function validateWorkOrderProfile(profile, errors) {
  if (profile === undefined) return;
  if (!isPlainObject(profile)) {
    addIssue(errors, "profile_not_object", "profile", "profile must be an object when provided");
    return;
  }

  if (!isNonEmptyString(profile.type)) {
    addIssue(errors, "profile_type_missing", "profile.type", "profile.type must be non-empty");
    return;
  }

  if (!WORK_ORDER_PROFILE_TYPES.has(profile.type)) {
    addIssue(errors, "unknown_profile_type", "profile.type", `profile.type must be one of: ${[...WORK_ORDER_PROFILE_TYPES].join(", ")}`);
    return;
  }

  if (profile.type !== "recipe") return;

  validatePatternId(profile.recipe_id, "profile.recipe_id", "recipe_profile_recipe_id", RECIPE_ID_PATTERN, errors);
  validatePatternId(profile.capability_id, "profile.capability_id", "recipe_profile_capability_id", CAPABILITY_ID_PATTERN, errors);
  if ("required_params" in profile && (!Array.isArray(profile.required_params) || !profile.required_params.every(isNonEmptyString))) {
    addIssue(errors, "recipe_profile_required_params_invalid", "profile.required_params", "required_params must be an array of non-empty strings when provided");
  }

  if (profile.dry_run_fail_closed !== true) {
    addIssue(
      errors,
      "recipe_profile_missing_dry_run_contract",
      "profile.dry_run_fail_closed",
      "recipe profiles must explicitly set dry_run_fail_closed=true",
    );
  }

  validateRecipeProfileRunner(profile.runner, errors);
}

function sanitizeWorkOrderIdPart(value, fallback = "recipe") {
  const text = String(value || "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/-+/g, "_").replace(/^_+|_+$/g, "");
  return text || fallback;
}

function cloneStringMap(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => isNonEmptyString(key) && isNonEmptyString(entryValue))
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
  );
}

function cloneStringList(value) {
  return (Array.isArray(value) ? value : [])
    .filter(isNonEmptyString)
    .map((entry) => entry.trim());
}

function cloneNullableString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function cloneStringOrStringList(value) {
  if (Array.isArray(value)) return cloneStringList(value).join(", ");
  return isNonEmptyString(value) ? value.trim() : "";
}

function normalizeIntentDeliverable(deliverable, index = 0) {
  const source = isPlainObject(deliverable) ? deliverable : {};
  return {
    id: cloneNullableString(source.id) || `deliverable_${index + 1}`,
    name: cloneNullableString(source.name) || cloneNullableString(source.title) || `Deliverable ${index + 1}`,
    kind: cloneNullableString(source.kind) || "artifact",
    required: source.required !== false,
    purpose: cloneNullableString(source.purpose),
    quality_bars: cloneStringList(source.quality_bars || source.qualityBars),
    required_sections: cloneStringList(source.required_sections || source.requiredSections),
    required_signals: cloneStringList(source.required_signals || source.requiredSignals),
    anti_goals: cloneStringList(source.anti_goals || source.antiGoals),
    evidence_mode: cloneNullableString(source.evidence_mode || source.evidenceMode),
  };
}

function normalizeIntentContractProjection(intentContract = {}) {
  const source = isPlainObject(intentContract) ? intentContract : {};
  return {
    version: WORK_ORDER_PROJECTION_VERSION,
    primary_user: cloneNullableString(source.primary_user || source.user || source.actor || source.intended_user),
    job_to_be_done: cloneNullableString(source.job_to_be_done || source.job || source.intent || source.user_need),
    desired_outcomes: cloneStringList(source.desired_outcomes || source.outcomes || source.success_outcomes),
    anti_goals: cloneStringList(source.anti_goals || source.false_green_patterns || source.must_not_happen),
    constraints: cloneStringList(source.constraints || source.guardrails || source.non_goals),
    deliverables: (Array.isArray(source.deliverables) ? source.deliverables : []).map(normalizeIntentDeliverable),
  };
}

function normalizeSuccessCriterionProjection(entry, index = 0) {
  const source = isPlainObject(entry) ? entry : { label: entry };
  const id = cloneNullableString(source.id || source.criterion_id || source.criterionId) || `sc_${index + 1}`;
  const label = cloneNullableString(source.label || source.description || source.criterion || source.text || source.statement) || id;
  return {
    id,
    label,
    story_refs: cloneStringList(source.story_refs || source.storyRefs || source.stories || source.story),
  };
}

function normalizeVerificationRowProjection(entry, index = 0) {
  const source = isPlainObject(entry) ? entry : {};
  return {
    criterion_id: cloneNullableString(source.criterion_id || source.criterionId || source.criterion || source.id) || `sc_${index + 1}`,
    story_linkage: cloneStringOrStringList(source.story_linkage || source.storyLinkage || source.story || source.story_refs || source.storyRefs),
    repo_context: cloneNullableString(source.repo_context || source.repoContext || source.system_context || source.systemContext || source.context) || "",
    required_proof_type: cloneNullableString(source.required_proof_type || source.requiredProofType || source.proof_type || source.proof) || "",
    command: cloneStringOrStringList(source.command || source.command_or_action || source.commandOrAction || source.action),
    pass_means: cloneNullableString(source.pass_means || source.passMeans || source.pass) || "",
    what_remains_unverified: cloneNullableString(source.what_remains_unverified || source.whatRemainsUnverified || source.unverified || source.remaining_unverified) || "None",
  };
}

function normalizeVerificationMatrixProjection(verificationMatrix = {}) {
  const source = isPlainObject(verificationMatrix) ? verificationMatrix : {};
  return {
    success_criteria: (Array.isArray(source.success_criteria) ? source.success_criteria : []).map(normalizeSuccessCriterionProjection),
    verification_strategy: (Array.isArray(source.verification_strategy) ? source.verification_strategy : []).map(normalizeVerificationRowProjection),
  };
}

function normalizePlanProjections({ intentContract = null, successCriteria = null, verificationRows = null } = {}) {
  return {
    version: WORK_ORDER_PROJECTION_VERSION,
    intent_contract: normalizeIntentContractProjection(intentContract || {}),
    verification_matrix: normalizeVerificationMatrixProjection({
      success_criteria: successCriteria || [],
      verification_strategy: verificationRows || [],
    }),
  };
}

function validatePlanProjections(projections, errors) {
  if (projections === undefined) return;
  if (!isPlainObject(projections)) {
    addIssue(errors, "projections_not_object", "projections", "projections must be an object when provided");
    return;
  }

  if ("version" in projections && projections.version !== WORK_ORDER_PROJECTION_VERSION) {
    addIssue(errors, "projection_version_invalid", "projections.version", `projections.version must be ${WORK_ORDER_PROJECTION_VERSION}`);
  }

  if ("intent_contract" in projections) {
    const intent = projections.intent_contract;
    if (!isPlainObject(intent)) {
      addIssue(errors, "intent_projection_not_object", "projections.intent_contract", "intent_contract projection must be an object");
    } else {
      for (const field of ["desired_outcomes", "anti_goals", "constraints", "deliverables"]) {
        if (field in intent && !Array.isArray(intent[field])) {
          addIssue(errors, "intent_projection_list_invalid", `projections.intent_contract.${field}`, `${field} must be an array`);
        }
      }
    }
  }

  if (!("verification_matrix" in projections)) return;
  const matrix = projections.verification_matrix;
  if (!isPlainObject(matrix)) {
    addIssue(errors, "verification_projection_not_object", "projections.verification_matrix", "verification_matrix projection must be an object");
    return;
  }

  const criteria = Array.isArray(matrix.success_criteria) ? matrix.success_criteria : [];
  const rows = Array.isArray(matrix.verification_strategy) ? matrix.verification_strategy : [];
  if ("success_criteria" in matrix && !Array.isArray(matrix.success_criteria)) {
    addIssue(errors, "success_criteria_projection_invalid", "projections.verification_matrix.success_criteria", "success_criteria must be an array");
  }
  if ("verification_strategy" in matrix && !Array.isArray(matrix.verification_strategy)) {
    addIssue(errors, "verification_strategy_projection_invalid", "projections.verification_matrix.verification_strategy", "verification_strategy must be an array");
  }

  const criterionIds = new Set();
  criteria.forEach((criterion, index) => {
    const path = `projections.verification_matrix.success_criteria[${index}]`;
    if (!isPlainObject(criterion)) {
      addIssue(errors, "success_criterion_projection_not_object", path, "success_criteria entries must be objects");
      return;
    }
    if (!isNonEmptyString(criterion.id)) {
      addIssue(errors, "success_criterion_projection_id_missing", `${path}.id`, "success criteria projection entries require id");
    } else if (criterionIds.has(criterion.id)) {
      addIssue(errors, "duplicate_success_criterion_projection_id", `${path}.id`, `Duplicate success criterion id '${criterion.id}'`);
    } else {
      criterionIds.add(criterion.id);
    }
    if (!isNonEmptyString(criterion.label)) {
      addIssue(errors, "success_criterion_projection_label_missing", `${path}.label`, "success criteria projection entries require label");
    }
  });

  rows.forEach((row, index) => {
    const path = `projections.verification_matrix.verification_strategy[${index}]`;
    if (!isPlainObject(row)) {
      addIssue(errors, "verification_row_projection_not_object", path, "verification_strategy entries must be objects");
      return;
    }
    if (!isNonEmptyString(row.criterion_id)) {
      addIssue(errors, "verification_row_projection_criterion_missing", `${path}.criterion_id`, "verification rows require criterion_id");
    } else if (criterionIds.size > 0 && !criterionIds.has(row.criterion_id)) {
      addIssue(
        errors,
        "verification_row_projection_orphan_criterion",
        `${path}.criterion_id`,
        `Verification row references unknown success criterion '${row.criterion_id}'`,
      );
    }
  });
}

function sanitizePlanWorkOrderId(planDirName = "plan") {
  const text = String(planDirName || "plan").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return text && /^[A-Za-z]/.test(text) ? text : `plan_${text || "work_order"}`;
}

function buildPlanWorkOrderProjection({
  goal = "",
  planDirName = "plan",
  intentContract = null,
  successCriteria = [],
  verificationRows = [],
} = {}) {
  const specificGoal = isNonEmptyString(goal)
    ? `Maintain planner work-order projections for ${goal.trim()}`
    : "Maintain planner work-order projections for this active plan.";
  return {
    schema_version: WORK_ORDER_SCHEMA_VERSION,
    id: `wo_${sanitizePlanWorkOrderId(planDirName)}`,
    goal: specificGoal,
    inputs: [
      { id: "plan_markdown", kind: "plan", ref: "plan.md" },
      { id: "intent_contract", kind: "intent_contract", ref: "intent_contract.json" },
    ],
    constraints: [
      "Preserve legacy plan compatibility when projection artifacts are absent.",
      "Treat intent and verification projections as read-only views of the plan contract.",
    ],
    claims_to_produce: [
      {
        id: "plan_projection_readable",
        statement: "Intent and verification matrix projections are available to planner readers through work_order.json.",
      },
    ],
    proof_obligations: [
      {
        claim_id: "plan_projection_readable",
        method: "deterministic",
        check: "validateWorkOrder(work_order).ok",
      },
    ],
    stop_conditions: [
      "Stop if projection validation reports malformed intent or verification rows.",
      "Stop if legacy plans without work_order.json no longer fall back to legacy artifacts.",
    ],
    budget: {
      max_tokens: 12000,
      max_cost_usd: 0,
      max_time_minutes: 20,
    },
    projections: normalizePlanProjections({ intentContract, successCriteria, verificationRows }),
  };
}

function loadPlanWorkOrder(planDir) {
  const workOrderPath = join(planDir, PLAN_WORK_ORDER_FILENAME);
  if (!existsSync(workOrderPath)) {
    return { path: workOrderPath, present: false, parsed: null, validation: null, error: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(workOrderPath, "utf-8"));
  } catch {
    return {
      path: workOrderPath,
      present: true,
      parsed: null,
      validation: null,
      error: "Malformed JSON in work_order.json",
    };
  }

  const validation = validateWorkOrder(parsed);
  return {
    path: workOrderPath,
    present: true,
    parsed,
    validation,
    error: validation.ok ? null : "Invalid work_order.json",
  };
}

function getIntentContractProjection(workOrder) {
  const projection = workOrder?.projections?.intent_contract;
  return isPlainObject(projection) ? normalizeIntentContractProjection(projection) : null;
}

function getVerificationMatrixProjection(workOrder) {
  const projection = workOrder?.projections?.verification_matrix;
  return isPlainObject(projection) ? normalizeVerificationMatrixProjection(projection) : null;
}

function getWorkOrderSuccessCriteria(workOrder) {
  return getVerificationMatrixProjection(workOrder)?.success_criteria || [];
}

function getWorkOrderVerificationRows(workOrder) {
  return getVerificationMatrixProjection(workOrder)?.verification_strategy || [];
}

function writePlanWorkOrderProjection(planDir, options = {}) {
  const planDirName = String(planDir || "").split("/").filter(Boolean).pop() || "plan";
  const workOrder = buildPlanWorkOrderProjection({ ...options, planDirName: options.planDirName || planDirName });
  const validation = validateWorkOrder(workOrder);
  if (!validation.ok) {
    const detail = validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ");
    throw new Error(`Generated work_order.json failed validation: ${detail}`);
  }
  const path = join(planDir, PLAN_WORK_ORDER_FILENAME);
  writeFileSync(path, JSON.stringify(workOrder, null, 2) + "\n");
  return { path, workOrder, validation };
}

function normalizeRecipeProfileRunner(recipe) {
  const runner = recipe?.runner && isPlainObject(recipe.runner) ? recipe.runner : {};
  const dryRunFlags = cloneStringList(runner.dry_run_flags);
  return {
    type: runner.type === "command" ? "command" : String(runner.type || "").trim(),
    cwd: isNonEmptyString(runner.cwd) ? runner.cwd.trim() : ".",
    command: cloneStringList(runner.command),
    defaults: cloneStringMap(runner.defaults),
    dry_run_flags: dryRunFlags,
    live_flags: cloneStringList(runner.live_flags),
  };
}

function buildRecipeWorkOrder(recipe, options = {}) {
  const recipeId = String(recipe?.recipe_id || recipe?.id || options.recipeId || "").trim();
  const capabilityId = String(recipe?.capability_id || options.capabilityId || "").trim();
  const runner = normalizeRecipeProfileRunner(recipe);
  const title = isNonEmptyString(recipe?.title) ? recipe.title.trim() : recipeId;
  const recipeRef = isNonEmptyString(recipe?.recipe_json_path)
    ? recipe.recipe_json_path
    : `${isNonEmptyString(recipe?.recipe_dir) ? recipe.recipe_dir : `recipes/${recipeId}`}/recipe.json`;
  const dryRunFailClosed = runner.type === "command" && runner.command.length > 0 && runner.dry_run_flags.length > 0;

  return {
    schema_version: WORK_ORDER_SCHEMA_VERSION,
    id: options.id || `wo_recipe_${sanitizeWorkOrderIdPart(recipeId)}`,
    goal: options.goal || `Promote ${title || "recipe"} recipe into a dry-run verified work-order profile.`,
    inputs: [
      {
        id: "recipe_definition",
        kind: "recipe",
        ref: recipeRef,
      },
    ],
    constraints: [
      "Execute the recipe through its declared runner contract only.",
      "Default execution mode must be dry-run unless the operator explicitly selects live execution.",
    ],
    claims_to_produce: [
      {
        id: "recipe_profile_valid",
        statement: `Recipe '${recipeId || "(missing)"}' is represented as a work-order profile with a fail-closed dry-run runner contract.`,
      },
    ],
    proof_obligations: [
      {
        claim_id: "recipe_profile_valid",
        method: "deterministic",
        check: "validateWorkOrder(work_order).ok",
      },
    ],
    stop_conditions: [
      "Stop if the recipe profile lacks dry-run flags.",
      "Stop if the runner command cannot be rendered deterministically.",
    ],
    budget: {
      max_tokens: Number.isFinite(Number(options.max_tokens)) ? Number(options.max_tokens) : 12000,
      max_cost_usd: Number.isFinite(Number(options.max_cost_usd)) ? Number(options.max_cost_usd) : 0,
      max_time_minutes: Number.isFinite(Number(options.max_time_minutes)) ? Number(options.max_time_minutes) : 20,
    },
    profile: {
      type: "recipe",
      recipe_id: recipeId,
      capability_id: capabilityId,
      required_params: cloneStringList(recipe?.required_params),
      dry_run_fail_closed: dryRunFailClosed,
      runner,
    },
  };
}

function validateWorkOrder(workOrder) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(workOrder)) {
    addIssue(errors, "work_order_not_object", "$", "Work order must be a JSON object");
    return { ok: false, status: "FAIL", errors, warnings };
  }

  for (const field of REQUIRED_WORK_ORDER_FIELDS) {
    if (!(field in workOrder)) {
      addIssue(errors, "required_field_missing", field, `Work order is missing ${field}`);
    }
  }

  if ("schema_version" in workOrder && workOrder.schema_version !== WORK_ORDER_SCHEMA_VERSION) {
    addIssue(
      errors,
      "unsupported_schema_version",
      "schema_version",
      `Expected schema_version ${WORK_ORDER_SCHEMA_VERSION}`,
    );
  }

  if (!isNonEmptyString(workOrder.goal)) {
    addIssue(errors, "goal_missing", "goal", "goal must be a non-empty string");
  } else if (looksAmbiguousGoal(workOrder.goal)) {
    addIssue(
      errors,
      "ambiguous_goal",
      "goal",
      "goal is too ambiguous for deterministic cheap-agent execution",
    );
  }

  validateInputs(workOrder.inputs, errors);
  validateStringArray(workOrder.constraints, "constraints", "constraints", errors);
  const claimIds = validateClaims(workOrder.claims_to_produce, errors);
  validateProofObligations(workOrder.proof_obligations, claimIds, errors);
  validateStringArray(workOrder.stop_conditions, "stop_conditions", "stop_conditions", errors);
  validateBudget(workOrder.budget, errors);
  validateWorkOrderProfile(workOrder.profile, errors);
  validatePlanProjections(workOrder.projections, errors);

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
  };
}

export {
  PROOF_METHODS,
  PLAN_WORK_ORDER_FILENAME,
  REQUIRED_BUDGET_FIELDS,
  REQUIRED_WORK_ORDER_FIELDS,
  WORK_ORDER_PROJECTION_VERSION,
  WORK_ORDER_PROFILE_TYPES,
  WORK_ORDER_SCHEMA_VERSION,
  buildPlanWorkOrderProjection,
  buildRecipeWorkOrder,
  getIntentContractProjection,
  getVerificationMatrixProjection,
  getWorkOrderSuccessCriteria,
  getWorkOrderVerificationRows,
  loadPlanWorkOrder,
  normalizeIntentContractProjection,
  normalizePlanProjections,
  normalizeVerificationMatrixProjection,
  validateWorkOrder,
  writePlanWorkOrderProjection,
};
