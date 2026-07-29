import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { normalizeVerificationStatus, verificationStatusAcceptedForms } from "./verification_status_vocabulary.mjs";

export const ONTOLOGY_VERSION = 1;
export const ONTOLOGY_ENTITY_CLASSES = Object.freeze(["code", "specification", "verification", "process", "proof_weights", "conventions"]);
export const ONTOLOGY_ROOT_RELATIVE_PATH = join(".agent", "ontology");
export const ONTOLOGY_FACTS_RELATIVE_PATH = join(ONTOLOGY_ROOT_RELATIVE_PATH, "facts");
export const ONTOLOGY_SCHEMAS_RELATIVE_PATH = join(ONTOLOGY_ROOT_RELATIVE_PATH, "schemas");

const TEST_TYPES = new Set(["unit", "integration", "e2e", "smoke"]);
const ARTIFACT_TYPES = new Set(["screenshot", "console_log", "network_trace", "coverage_report", "test_output"]);
const CONVENTION_STATUSES = new Set(["candidate", "active", "deprecated"]);
const IMPLICIT_EMPTY_ENTITY_CLASSES = new Set(["conventions"]);

const ONTOLOGY_ROOT_KEYS = Object.freeze({
  code: "code",
  specification: "specification",
  verification: "verification",
  process: "process",
  proof_weights: "proof_weights",
  conventions: "conventions",
});

const DEFAULT_PROOF_WEIGHT_FACTS = Object.freeze({
  proof_types: {
    accessibility_audit_pass: {
      label: "Accessibility audit pass",
      category: "audit",
      base_weight: 5,
      description: "Accessibility verification passes the declared audit contract.",
    },
    console_log_clean: {
      label: "Console log clean",
      category: "artifact",
      base_weight: 1,
      description: "No unexpected console noise or runtime warnings remain.",
    },
    coverage_threshold_met: {
      label: "Coverage threshold met",
      category: "metric",
      base_weight: 3,
      description: "Coverage meets the declared threshold for the change scope.",
    },
    e2e_test: {
      label: "End-to-end test",
      category: "test",
      base_weight: 6,
      description: "An end-to-end flow proves the integrated user path.",
      modifiers: [
        {
          condition: "critical_path",
          delta: 2,
        },
      ],
    },
    integration_test: {
      label: "Integration test",
      category: "test",
      base_weight: 4,
      description: "An integration seam is exercised across collaborating components.",
      modifiers: [
        {
          condition: "cross_module",
          delta: 1,
        },
      ],
    },
    mutation_testing_pass: {
      label: "Mutation testing pass",
      category: "test",
      base_weight: 7,
      description: "Mutation analysis confirms the proof catches behavior changes.",
    },
    network_trace_expected: {
      label: "Network trace expected",
      category: "artifact",
      base_weight: 4,
      description: "Recorded network behavior matches the expected contract.",
      modifiers: [
        {
          condition: "external_io",
          delta: 2,
        },
      ],
    },
    performance_budget_met: {
      label: "Performance budget met",
      category: "metric",
      base_weight: 5,
      description: "The declared performance budget remains satisfied.",
    },
    persona_audit_pass: {
      label: "Persona audit pass",
      category: "audit",
      base_weight: 2,
      description: "A persona or stakeholder audit confirms the intended behavior.",
    },
    screenshot_baseline: {
      label: "Screenshot baseline",
      category: "artifact",
      base_weight: 2,
      description: "A visual baseline proves the rendered surface stayed aligned.",
    },
    static_analysis_result: {
      label: "Static analysis result",
      category: "artifact",
      base_weight: 1,
      description: "A deterministic static analysis report confirms a structural convention or invariant.",
    },
    unit_test: {
      label: "Unit test",
      category: "test",
      base_weight: 2,
      description: "A focused unit test proves the isolated behavior.",
    },
    user_confirmation: {
      label: "User confirmation",
      category: "human",
      base_weight: 3,
      description: "The user explicitly confirmed the observed behavior.",
    },
    waiver_approved: {
      label: "Waiver approved",
      category: "exception",
      base_weight: 0,
      description: "A named waiver explicitly accepts residual risk.",
      modifiers: [
        {
          condition: "explicit_risk_acceptance",
          delta: -2,
        },
      ],
    },
  },
  risk_levels: {
    critical: {
      required_weight: 10,
      description: "Critical surfaces require the strongest proof bundle before acceptance.",
    },
    high: {
      required_weight: 7,
      description: "High-risk surfaces require layered proof beyond a single test.",
    },
    low: {
      required_weight: 2,
      description: "Low-risk surfaces still need at least one concrete proof artifact.",
    },
    medium: {
      required_weight: 4,
      description: "Medium-risk surfaces need more than a minimal smoke proof.",
    },
  },
  domain_defaults: {
    auth: "high",
    interface: "medium",
    knowledge_base: "low",
    migration: "high",
    payment: "critical",
    planner_core: "high",
    recipe: "medium",
    roadmap: "low",
    traceability: "medium",
    verification: "medium",
  },
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObjectEntries(value, normalizeValue = (entry) => entry) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => isNonEmptyString(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key.trim(), normalizeValue(entry)])
  );
}

function normalizeProofWeightModifiers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => isPlainObject(entry) && isNonEmptyString(entry.condition) && isFiniteNumber(entry.delta))
    .map((entry) => ({
      condition: entry.condition.trim(),
      delta: Number(entry.delta),
    }))
    .sort((left, right) => left.condition.localeCompare(right.condition));
}

function normalizeProofWeightTypeRecord(value) {
  if (!isPlainObject(value)) return {};
  const record = {};
  if (isNonEmptyString(value.label)) record.label = value.label.trim();
  if (isNonEmptyString(value.category)) record.category = value.category.trim();
  if (isFiniteNumber(value.base_weight)) record.base_weight = Number(value.base_weight);
  if (isNonEmptyString(value.description)) record.description = value.description.trim();
  const modifiers = normalizeProofWeightModifiers(value.modifiers);
  if (modifiers.length > 0) record.modifiers = modifiers;
  return record;
}

function normalizeProofWeightRiskLevelRecord(value) {
  if (!isPlainObject(value)) return {};
  const record = {};
  if (isFiniteNumber(value.required_weight)) record.required_weight = Number(value.required_weight);
  if (isNonEmptyString(value.description)) record.description = value.description.trim();
  return record;
}

function normalizeProofWeightDomainDefaults(value) {
  return Object.fromEntries(
    Object.entries(isPlainObject(value) ? value : {})
      .filter(([key, riskLevel]) => isNonEmptyString(key) && isNonEmptyString(riskLevel))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, riskLevel]) => [key.trim(), riskLevel.trim()])
  );
}

function mergeRecordMaps(defaults, overrides, normalizer) {
  const merged = {};
  const keys = new Set([
    ...Object.keys(isPlainObject(defaults) ? defaults : {}),
    ...Object.keys(isPlainObject(overrides) ? overrides : {}),
  ]);
  for (const key of [...keys].filter((entry) => isNonEmptyString(entry)).sort((left, right) => left.localeCompare(right))) {
    merged[key] = normalizer({
      ...(isPlainObject(defaults?.[key]) ? defaults[key] : {}),
      ...(isPlainObject(overrides?.[key]) ? overrides[key] : {}),
    });
  }
  return merged;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => isNonEmptyString(entry))
    .map((entry) => entry.trim());
}

function readJsonCompatibleYaml(filePath) {
  try {
    if (!existsSync(filePath)) {
      return {
        ok: false,
        present: false,
        document: null,
        error: "missing",
      };
    }

    return {
      ok: true,
      present: true,
      document: JSON.parse(readFileSync(filePath, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      present: true,
      document: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

function validateArrayField(root, key, issues, label) {
  if (!Array.isArray(root?.[key])) {
    issues.push(`${label}.${key} must be an array`);
    return false;
  }
  return true;
}

function validateObjectField(root, key, issues, label) {
  if (!isPlainObject(root?.[key])) {
    issues.push(`${label}.${key} must be an object`);
    return false;
  }
  return true;
}

function validateOptionalStringArray(value, label, issues) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array of strings when present`);
    return;
  }
  if (value.some((entry) => !isNonEmptyString(entry))) {
    issues.push(`${label} must contain only non-empty strings`);
  }
}

function validateScalarArray(value, label, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array when present`);
    return;
  }
  if (value.some((entry) => !isNonEmptyString(entry) && !isFiniteNumber(entry) && !isBoolean(entry))) {
    issues.push(`${label} arrays must contain only non-empty strings, numbers, or booleans`);
  }
}

function validateConventionRequirement(requirement, label, issues) {
  if (isNonEmptyString(requirement)) return;

  if (!isPlainObject(requirement)) {
    issues.push(`${label} must be a non-empty string or an object`);
    return;
  }

  const entries = Object.entries(requirement);
  if (entries.length === 0) {
    issues.push(`${label} must declare at least one requirement field`);
    return;
  }

  for (const [key, value] of entries) {
    const fieldLabel = `${label}.${key || "<empty>"}`;
    if (!isNonEmptyString(key)) {
      issues.push(`${label} requirement keys must be non-empty strings`);
      continue;
    }
    if (Array.isArray(value)) {
      validateScalarArray(value, fieldLabel, issues);
      continue;
    }
    if (!isNonEmptyString(value) && !isFiniteNumber(value) && !isBoolean(value)) {
      issues.push(`${fieldLabel} must be a non-empty string, number, boolean, or array of them`);
    }
  }
}

function validateCodeDocument(root, issues) {
  if (!validateArrayField(root, "modules", issues, "code")) return;
  if (!validateArrayField(root, "files", issues, "code")) return;
  if (!validateArrayField(root, "classes", issues, "code")) return;
  if (!validateArrayField(root, "functions", issues, "code")) return;
  if (!validateArrayField(root, "file_dependencies", issues, "code")) return;

  for (const [index, moduleRecord] of root.modules.entries()) {
    const label = `code.modules[${index}]`;
    if (!isPlainObject(moduleRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(moduleRecord.id)) issues.push(`${label}.id is required`);
    if (moduleRecord.path !== undefined && !isNonEmptyString(moduleRecord.path)) issues.push(`${label}.path must be a non-empty string when present`);
    if (moduleRecord.description !== undefined && !isNonEmptyString(moduleRecord.description)) issues.push(`${label}.description must be a non-empty string when present`);
    validateOptionalStringArray(moduleRecord.aliases, `${label}.aliases`, issues);
  }

  for (const [index, fileRecord] of root.files.entries()) {
    const label = `code.files[${index}]`;
    if (!isPlainObject(fileRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(fileRecord.path)) issues.push(`${label}.path is required`);
    if (fileRecord.module !== undefined && !isNonEmptyString(fileRecord.module)) issues.push(`${label}.module must be a non-empty string when present`);
    if (fileRecord.language !== undefined && !isNonEmptyString(fileRecord.language)) issues.push(`${label}.language must be a non-empty string when present`);
  }

  for (const [index, classRecord] of root.classes.entries()) {
    const label = `code.classes[${index}]`;
    if (!isPlainObject(classRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(classRecord.name)) issues.push(`${label}.name is required`);
    if (!isNonEmptyString(classRecord.file)) issues.push(`${label}.file is required`);
  }

  for (const [index, functionRecord] of root.functions.entries()) {
    const label = `code.functions[${index}]`;
    if (!isPlainObject(functionRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(functionRecord.name)) issues.push(`${label}.name is required`);
    if (!isNonEmptyString(functionRecord.file)) issues.push(`${label}.file is required`);
  }

  for (const [index, dependencyRecord] of root.file_dependencies.entries()) {
    const label = `code.file_dependencies[${index}]`;
    if (!isPlainObject(dependencyRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(dependencyRecord.source)) issues.push(`${label}.source is required`);
    if (!isNonEmptyString(dependencyRecord.target)) issues.push(`${label}.target is required`);
    if (dependencyRecord.type !== undefined && !isNonEmptyString(dependencyRecord.type)) issues.push(`${label}.type must be a non-empty string when present`);
  }
}

function validateSpecificationDocument(root, issues) {
  if (!validateArrayField(root, "stories", issues, "specification")) return;
  if (!validateArrayField(root, "domains", issues, "specification")) return;
  if (!validateArrayField(root, "plans", issues, "specification")) return;

  for (const [index, storyRecord] of root.stories.entries()) {
    const label = `specification.stories[${index}]`;
    if (!isPlainObject(storyRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(storyRecord.id)) issues.push(`${label}.id is required`);
    if (!isNonEmptyString(storyRecord.title)) issues.push(`${label}.title is required`);
    if (!isNonEmptyString(storyRecord.status)) issues.push(`${label}.status is required`);
    if (storyRecord.domain !== undefined && !isNonEmptyString(storyRecord.domain)) issues.push(`${label}.domain must be a non-empty string when present`);
    if (!Array.isArray(storyRecord.acceptance_criteria)) {
      issues.push(`${label}.acceptance_criteria must be an array`);
      continue;
    }
    if (storyRecord.acceptance_criteria.length === 0) {
      issues.push(`${label}.acceptance_criteria must contain at least one item`);
    }
    for (const [criterionIndex, criterionRecord] of storyRecord.acceptance_criteria.entries()) {
      const criterionLabel = `${label}.acceptance_criteria[${criterionIndex}]`;
      if (!isPlainObject(criterionRecord)) {
        issues.push(`${criterionLabel} must be an object`);
        continue;
      }
      if (!isNonEmptyString(criterionRecord.id)) issues.push(`${criterionLabel}.id is required`);
      if (!isNonEmptyString(criterionRecord.text)) issues.push(`${criterionLabel}.text is required`);
    }
  }

  for (const [index, domainRecord] of root.domains.entries()) {
    const label = `specification.domains[${index}]`;
    if (!isPlainObject(domainRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(domainRecord.name)) issues.push(`${label}.name is required`);
    if (domainRecord.description !== undefined && !isNonEmptyString(domainRecord.description)) issues.push(`${label}.description must be a non-empty string when present`);
  }

  for (const [index, planRecord] of root.plans.entries()) {
    const label = `specification.plans[${index}]`;
    if (!isPlainObject(planRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(planRecord.id)) issues.push(`${label}.id is required`);
    if (planRecord.phase !== undefined && !isNonEmptyString(planRecord.phase)) issues.push(`${label}.phase must be a non-empty string when present`);
    validateOptionalStringArray(planRecord.story_ids, `${label}.story_ids`, issues);
  }
}

function validateVerificationDocument(root, issues) {
  if (!validateArrayField(root, "criteria", issues, "verification")) return;
  if (!validateArrayField(root, "tests", issues, "verification")) return;
  if (!validateArrayField(root, "artifacts", issues, "verification")) return;
  if (!validateArrayField(root, "test_runs", issues, "verification")) return;
  if (!validateArrayField(root, "coverage_reports", issues, "verification")) return;

  for (const [index, criterionRecord] of root.criteria.entries()) {
    const label = `verification.criteria[${index}]`;
    if (!isPlainObject(criterionRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(criterionRecord.id)) issues.push(`${label}.id is required`);
    if (!isNonEmptyString(criterionRecord.plan_id)) issues.push(`${label}.plan_id is required`);
    if (criterionRecord.story_criterion_id !== undefined && !isNonEmptyString(criterionRecord.story_criterion_id)) issues.push(`${label}.story_criterion_id must be a non-empty string when present`);
    validateOptionalStringArray(criterionRecord.test_refs, `${label}.test_refs`, issues);
    validateOptionalStringArray(criterionRecord.artifact_refs, `${label}.artifact_refs`, issues);
  }

  for (const [index, testRecord] of root.tests.entries()) {
    const label = `verification.tests[${index}]`;
    if (!isPlainObject(testRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(testRecord.name)) issues.push(`${label}.name is required`);
    if (!isNonEmptyString(testRecord.file)) issues.push(`${label}.file is required`);
    if (!TEST_TYPES.has(String(testRecord.type || "").trim())) issues.push(`${label}.type must be one of ${[...TEST_TYPES].join(", ")}`);
    validateOptionalStringArray(testRecord.criterion_ids, `${label}.criterion_ids`, issues);
    validateOptionalStringArray(testRecord.covered_files, `${label}.covered_files`, issues);
  }

  for (const [index, artifactRecord] of root.artifacts.entries()) {
    const label = `verification.artifacts[${index}]`;
    if (!isPlainObject(artifactRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(artifactRecord.path)) issues.push(`${label}.path is required`);
    if (!ARTIFACT_TYPES.has(String(artifactRecord.type || "").trim())) issues.push(`${label}.type must be one of ${[...ARTIFACT_TYPES].join(", ")}`);
    validateOptionalStringArray(artifactRecord.criterion_ids, `${label}.criterion_ids`, issues);
  }

  for (const [index, runRecord] of root.test_runs.entries()) {
    const label = `verification.test_runs[${index}]`;
    if (!isPlainObject(runRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(runRecord.id)) issues.push(`${label}.id is required`);
    if (runRecord.plan_id !== undefined && !isNonEmptyString(runRecord.plan_id)) issues.push(`${label}.plan_id must be a non-empty string when present`);
    if (!Array.isArray(runRecord.results)) {
      issues.push(`${label}.results must be an array`);
      continue;
    }
    for (const [resultIndex, resultRecord] of runRecord.results.entries()) {
      const resultLabel = `${label}.results[${resultIndex}]`;
      if (!isPlainObject(resultRecord)) {
        issues.push(`${resultLabel} must be an object`);
        continue;
      }
      if (!isNonEmptyString(resultRecord.test_name)) issues.push(`${resultLabel}.test_name is required`);
      if (!normalizeVerificationStatus(resultRecord.outcome, "execution").valid) {
        issues.push(`${resultLabel}.outcome must be one of ${verificationStatusAcceptedForms("execution").join(", ")}`);
      }
    }
  }

  for (const [index, coverageRecord] of root.coverage_reports.entries()) {
    const label = `verification.coverage_reports[${index}]`;
    if (!isPlainObject(coverageRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(coverageRecord.id)) issues.push(`${label}.id is required`);
    if (!isNonEmptyString(coverageRecord.file)) issues.push(`${label}.file is required`);
    if (coverageRecord.line_pct !== undefined && !Number.isFinite(Number(coverageRecord.line_pct))) issues.push(`${label}.line_pct must be numeric when present`);
    if (coverageRecord.branch_pct !== undefined && !Number.isFinite(Number(coverageRecord.branch_pct))) issues.push(`${label}.branch_pct must be numeric when present`);
  }
}

function validateProcessDocument(root, issues) {
  if (!validateArrayField(root, "mistakes", issues, "process")) return;
  if (!validateArrayField(root, "patterns", issues, "process")) return;
  if (!validateArrayField(root, "gotchas", issues, "process")) return;
  if (!validateArrayField(root, "retros", issues, "process")) return;
  if (!validateArrayField(root, "adrs", issues, "process")) return;
  if (!validateArrayField(root, "workflows", issues, "process")) return;
  if (!validateArrayField(root, "mirror_readers", issues, "process")) return;
  if (!validateArrayField(root, "edge_cases", issues, "process")) return;
  if (!validateArrayField(root, "invariants", issues, "process")) return;

  const validators = {
    mistakes(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (record.title !== undefined && !isNonEmptyString(record.title)) issues.push(`${label}.title must be a non-empty string when present`);
      if (record.domain !== undefined && !isNonEmptyString(record.domain)) issues.push(`${label}.domain must be a non-empty string when present`);
      if (record.frequency !== undefined && !Number.isFinite(Number(record.frequency))) issues.push(`${label}.frequency must be numeric when present`);
    },
    patterns(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (record.title !== undefined && !isNonEmptyString(record.title)) issues.push(`${label}.title must be a non-empty string when present`);
      validateOptionalStringArray(record.applies_to, `${label}.applies_to`, issues);
    },
    gotchas(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (record.title !== undefined && !isNonEmptyString(record.title)) issues.push(`${label}.title must be a non-empty string when present`);
      if (record.domain !== undefined && !isNonEmptyString(record.domain)) issues.push(`${label}.domain must be a non-empty string when present`);
    },
    retros(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (record.title !== undefined && !isNonEmptyString(record.title)) issues.push(`${label}.title must be a non-empty string when present`);
      validateOptionalStringArray(record.mistake_ids, `${label}.mistake_ids`, issues);
      validateOptionalStringArray(record.domain_tags, `${label}.domain_tags`, issues);
      validateOptionalStringArray(record.change_classes, `${label}.change_classes`, issues);
      if (record.recurrence_count !== undefined && !Number.isFinite(Number(record.recurrence_count))) issues.push(`${label}.recurrence_count must be numeric when present`);
    },
    adrs(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (record.title !== undefined && !isNonEmptyString(record.title)) issues.push(`${label}.title must be a non-empty string when present`);
      if (record.topic !== undefined && !isNonEmptyString(record.topic)) issues.push(`${label}.topic must be a non-empty string when present`);
    },
    workflows(record, label) {
      if (!isNonEmptyString(record.name)) issues.push(`${label}.name is required`);
      if (record.recipe_affinity !== undefined && !isNonEmptyString(record.recipe_affinity)) issues.push(`${label}.recipe_affinity must be a non-empty string when present`);
    },
    mirror_readers(record, label) {
      if (!isNonEmptyString(record.reader)) issues.push(`${label}.reader is required`);
      if (!isNonEmptyString(record.artifact)) issues.push(`${label}.artifact is required`);
    },
    edge_cases(record, label) {
      if (!isNonEmptyString(record.domain)) issues.push(`${label}.domain is required`);
      if (!isNonEmptyString(record.label)) issues.push(`${label}.label is required`);
      if (record.description !== undefined && !isNonEmptyString(record.description)) issues.push(`${label}.description must be a non-empty string when present`);
    },
    invariants(record, label) {
      if (!isNonEmptyString(record.id)) issues.push(`${label}.id is required`);
      if (!isNonEmptyString(record.agent)) issues.push(`${label}.agent is required`);
    },
  };

  for (const [collectionName, validator] of Object.entries(validators)) {
    for (const [index, record] of root[collectionName].entries()) {
      const label = `process.${collectionName}[${index}]`;
      if (!isPlainObject(record)) {
        issues.push(`${label} must be an object`);
        continue;
      }
      validator(record, label);
    }
  }
}

function validateProofWeightsDocument(root, issues) {
  if (!validateObjectField(root, "proof_types", issues, "proof_weights")) return;
  if (!validateObjectField(root, "risk_levels", issues, "proof_weights")) return;
  if (!validateObjectField(root, "domain_defaults", issues, "proof_weights")) return;

  for (const [typeId, typeRecord] of Object.entries(root.proof_types)) {
    const label = `proof_weights.proof_types.${typeId || "<empty>"}`;
    if (!isNonEmptyString(typeId)) {
      issues.push(`${label}: proof type id must be a non-empty string`);
      continue;
    }
    if (!isPlainObject(typeRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isNonEmptyString(typeRecord.label)) issues.push(`${label}.label is required`);
    if (!isNonEmptyString(typeRecord.category)) issues.push(`${label}.category is required`);
    if (!isFiniteNumber(typeRecord.base_weight)) issues.push(`${label}.base_weight must be numeric`);
    if (typeRecord.description !== undefined && !isNonEmptyString(typeRecord.description)) {
      issues.push(`${label}.description must be a non-empty string when present`);
    }
    if (typeRecord.modifiers !== undefined) {
      if (!Array.isArray(typeRecord.modifiers)) {
        issues.push(`${label}.modifiers must be an array when present`);
      } else {
        for (const [index, modifier] of typeRecord.modifiers.entries()) {
          const modifierLabel = `${label}.modifiers[${index}]`;
          if (!isPlainObject(modifier)) {
            issues.push(`${modifierLabel} must be an object`);
            continue;
          }
          if (!isNonEmptyString(modifier.condition)) issues.push(`${modifierLabel}.condition is required`);
          if (!isFiniteNumber(modifier.delta)) issues.push(`${modifierLabel}.delta must be numeric`);
        }
      }
    }
  }

  for (const [riskLevel, riskRecord] of Object.entries(root.risk_levels)) {
    const label = `proof_weights.risk_levels.${riskLevel || "<empty>"}`;
    if (!isNonEmptyString(riskLevel)) {
      issues.push(`${label}: risk level id must be a non-empty string`);
      continue;
    }
    if (!isPlainObject(riskRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (!isFiniteNumber(riskRecord.required_weight)) issues.push(`${label}.required_weight must be numeric`);
    if (riskRecord.description !== undefined && !isNonEmptyString(riskRecord.description)) {
      issues.push(`${label}.description must be a non-empty string when present`);
    }
  }

  const declaredRiskLevels = new Set(Object.keys(root.risk_levels));
  for (const [domain, riskLevel] of Object.entries(root.domain_defaults)) {
    const label = `proof_weights.domain_defaults.${domain || "<empty>"}`;
    if (!isNonEmptyString(domain)) {
      issues.push(`${label}: domain id must be a non-empty string`);
      continue;
    }
    if (!isNonEmptyString(riskLevel)) {
      issues.push(`${label} must point to a non-empty risk level id`);
      continue;
    }
    if (!declaredRiskLevels.has(riskLevel.trim())) {
      issues.push(`${label} must reference a declared proof_weights.risk_levels entry`);
    }
  }
}

function validateConventionsDocument(root, issues) {
  if (!validateArrayField(root, "conventions", issues, "conventions")) return;

  for (const [index, conventionRecord] of root.conventions.entries()) {
    const label = `conventions.conventions[${index}]`;
    if (!isPlainObject(conventionRecord)) {
      issues.push(`${label} must be an object`);
      continue;
    }

    if (!isNonEmptyString(conventionRecord.id)) issues.push(`${label}.id is required`);
    if (!isNonEmptyString(conventionRecord.title)) issues.push(`${label}.title is required`);
    if (!isNonEmptyString(conventionRecord.status)) {
      issues.push(`${label}.status is required`);
    } else if (!CONVENTION_STATUSES.has(conventionRecord.status.trim())) {
      issues.push(`${label}.status must be one of ${[...CONVENTION_STATUSES].join(", ")}`);
    }
    if (!isNonEmptyString(conventionRecord.domain)) issues.push(`${label}.domain is required`);
    if (!isNonEmptyString(conventionRecord.scope)) issues.push(`${label}.scope is required`);
    if (!isFiniteNumber(conventionRecord.confidence)) {
      issues.push(`${label}.confidence must be numeric`);
    } else {
      const confidence = Number(conventionRecord.confidence);
      if (confidence < 0 || confidence > 1) issues.push(`${label}.confidence must be between 0 and 1`);
    }
    if (!isNonEmptyString(conventionRecord.evidence_type)) issues.push(`${label}.evidence_type is required`);
    if (!isNonEmptyString(conventionRecord.detected_from)) issues.push(`${label}.detected_from is required`);
    if (conventionRecord.description !== undefined && !isNonEmptyString(conventionRecord.description)) {
      issues.push(`${label}.description must be a non-empty string when present`);
    }
    if (conventionRecord.detected_at !== undefined && !isNonEmptyString(conventionRecord.detected_at)) {
      issues.push(`${label}.detected_at must be a non-empty string when present`);
    }
    if (conventionRecord.detected_in_instances !== undefined && !isFiniteNumber(conventionRecord.detected_in_instances)) {
      issues.push(`${label}.detected_in_instances must be numeric when present`);
    }
    if (conventionRecord.total_instances !== undefined && !isFiniteNumber(conventionRecord.total_instances)) {
      issues.push(`${label}.total_instances must be numeric when present`);
    }
    if (
      isFiniteNumber(conventionRecord.detected_in_instances)
      && isFiniteNumber(conventionRecord.total_instances)
      && Number(conventionRecord.detected_in_instances) > Number(conventionRecord.total_instances)
    ) {
      issues.push(`${label}.detected_in_instances cannot exceed total_instances`);
    }

    if (!isPlainObject(conventionRecord.applies_to)) {
      issues.push(`${label}.applies_to is required`);
    } else {
      validateOptionalStringArray(conventionRecord.applies_to.file_patterns, `${label}.applies_to.file_patterns`, issues);
      validateOptionalStringArray(conventionRecord.applies_to.class_patterns, `${label}.applies_to.class_patterns`, issues);
      validateOptionalStringArray(conventionRecord.applies_to.change_classes, `${label}.applies_to.change_classes`, issues);

      const applicabilityCount = [
        ...(Array.isArray(conventionRecord.applies_to.file_patterns) ? conventionRecord.applies_to.file_patterns : []),
        ...(Array.isArray(conventionRecord.applies_to.class_patterns) ? conventionRecord.applies_to.class_patterns : []),
        ...(Array.isArray(conventionRecord.applies_to.change_classes) ? conventionRecord.applies_to.change_classes : []),
      ].filter((entry) => isNonEmptyString(entry)).length;
      if (applicabilityCount === 0) {
        issues.push(`${label}.applies_to must declare at least one file_patterns, class_patterns, or change_classes entry`);
      }
    }

    if (!Array.isArray(conventionRecord.requires)) {
      issues.push(`${label}.requires must be an array`);
    } else if (conventionRecord.requires.length === 0) {
      issues.push(`${label}.requires must contain at least one requirement`);
    } else {
      for (const [requirementIndex, requirement] of conventionRecord.requires.entries()) {
        validateConventionRequirement(requirement, `${label}.requires[${requirementIndex}]`, issues);
      }
    }
  }
}

const ENTITY_VALIDATORS = Object.freeze({
  code: validateCodeDocument,
  specification: validateSpecificationDocument,
  verification: validateVerificationDocument,
  process: validateProcessDocument,
  proof_weights: validateProofWeightsDocument,
  conventions: validateConventionsDocument,
});

function assertKnownEntityClass(entityClass) {
  if (!ONTOLOGY_ENTITY_CLASSES.includes(entityClass)) {
    throw new Error(`Unknown ontology entity class: ${entityClass}`);
  }
}

export function getOntologyPaths(cwd = process.cwd()) {
  return {
    root: join(cwd, ONTOLOGY_ROOT_RELATIVE_PATH),
    facts_dir: join(cwd, ONTOLOGY_FACTS_RELATIVE_PATH),
    schemas_dir: join(cwd, ONTOLOGY_SCHEMAS_RELATIVE_PATH),
  };
}

export function getOntologyFactPath(entityClass, cwd = process.cwd()) {
  assertKnownEntityClass(entityClass);
  return join(cwd, ONTOLOGY_FACTS_RELATIVE_PATH, `${entityClass}.yaml`);
}

export function getOntologyCompiledFactPath(cwd = process.cwd()) {
  return join(cwd, ONTOLOGY_ROOT_RELATIVE_PATH, "facts.pl");
}

export function getOntologySchemaPath(entityClass, cwd = process.cwd()) {
  assertKnownEntityClass(entityClass);
  return join(cwd, ONTOLOGY_SCHEMAS_RELATIVE_PATH, `${entityClass}.schema.json`);
}

export function buildEmptyOntologyDocument(entityClass) {
  assertKnownEntityClass(entityClass);

  if (entityClass === "code") {
    return {
      code: {
        version: ONTOLOGY_VERSION,
        modules: [],
        files: [],
        classes: [],
        functions: [],
        file_dependencies: [],
      },
    };
  }

  if (entityClass === "specification") {
    return {
      specification: {
        version: ONTOLOGY_VERSION,
        stories: [],
        domains: [],
        plans: [],
      },
    };
  }

  if (entityClass === "verification") {
    return {
      verification: {
        version: ONTOLOGY_VERSION,
        criteria: [],
        tests: [],
        artifacts: [],
        test_runs: [],
        coverage_reports: [],
      },
    };
  }

  if (entityClass === "proof_weights") {
    return {
      proof_weights: {
        version: ONTOLOGY_VERSION,
        proof_types: {},
        risk_levels: {},
        domain_defaults: {},
      },
    };
  }

  if (entityClass === "conventions") {
    return {
      conventions: {
        version: ONTOLOGY_VERSION,
        conventions: [],
      },
    };
  }

  return {
    process: {
      version: ONTOLOGY_VERSION,
      mistakes: [],
      patterns: [],
      gotchas: [],
      retros: [],
      adrs: [],
      workflows: [],
      mirror_readers: [],
      edge_cases: [],
      invariants: [],
    },
  };
}

export function buildDefaultProofWeightsDocument() {
  const defaults = cloneJson(DEFAULT_PROOF_WEIGHT_FACTS);
  return {
    proof_weights: {
      version: ONTOLOGY_VERSION,
      proof_types: sortObjectEntries(defaults.proof_types, normalizeProofWeightTypeRecord),
      risk_levels: sortObjectEntries(defaults.risk_levels, normalizeProofWeightRiskLevelRecord),
      domain_defaults: normalizeProofWeightDomainDefaults(defaults.domain_defaults),
    },
  };
}

export function mergeProofWeightsDocument(document = null) {
  const root = isPlainObject(document?.proof_weights)
    ? document.proof_weights
    : (isPlainObject(document) ? document : {});
  const defaults = buildDefaultProofWeightsDocument().proof_weights;

  return {
    proof_weights: {
      version: ONTOLOGY_VERSION,
      proof_types: mergeRecordMaps(defaults.proof_types, root.proof_types, normalizeProofWeightTypeRecord),
      risk_levels: mergeRecordMaps(defaults.risk_levels, root.risk_levels, normalizeProofWeightRiskLevelRecord),
      domain_defaults: normalizeProofWeightDomainDefaults({
        ...defaults.domain_defaults,
        ...(isPlainObject(root.domain_defaults) ? root.domain_defaults : {}),
      }),
    },
  };
}

export function renderOntologyDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function validateOntologyDocument(entityClass, document) {
  assertKnownEntityClass(entityClass);

  const issues = [];
  const warnings = [];
  const rootKey = ONTOLOGY_ROOT_KEYS[entityClass];
  const root = document?.[rootKey];

  if (!isPlainObject(document)) {
    issues.push(`${entityClass}: document must be an object`);
    return { ok: false, issues, warnings, rootKey };
  }

  if (!isPlainObject(root)) {
    issues.push(`${entityClass}: top-level '${rootKey}' object is required`);
    return { ok: false, issues, warnings, rootKey };
  }

  if (Number(root.version) !== ONTOLOGY_VERSION) {
    issues.push(`${entityClass}: ${rootKey}.version must be ${ONTOLOGY_VERSION}`);
  }

  ENTITY_VALIDATORS[entityClass](root, issues);

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    rootKey,
  };
}

export function loadOntologyFactDocument({ cwd = process.cwd(), entityClass, allowMissing = true } = {}) {
  assertKnownEntityClass(entityClass);
  const filePath = getOntologyFactPath(entityClass, cwd);
  const readResult = readJsonCompatibleYaml(filePath);

  if (!readResult.present) {
    if (!allowMissing && IMPLICIT_EMPTY_ENTITY_CLASSES.has(entityClass)) {
      return {
        ok: true,
        present: false,
        entity_class: entityClass,
        path: filePath,
        document: buildEmptyOntologyDocument(entityClass),
        issues: [],
        warnings: [`${entityClass}: missing ontology fact file at ${filePath}; using implicit empty scaffold`],
      };
    }
    if (allowMissing) {
      return {
        ok: true,
        present: false,
        entity_class: entityClass,
        path: filePath,
        document: null,
        issues: [],
        warnings: [],
      };
    }
    return {
      ok: false,
      present: false,
      entity_class: entityClass,
      path: filePath,
      document: null,
      issues: [`${entityClass}: missing ontology fact file at ${filePath}`],
      warnings: [],
    };
  }

  if (!readResult.ok) {
    return {
      ok: false,
      present: true,
      entity_class: entityClass,
      path: filePath,
      document: null,
      issues: [`${entityClass}: ${readResult.error}`],
      warnings: [],
    };
  }

  const validation = validateOntologyDocument(entityClass, readResult.document);
  return {
    ok: validation.ok,
    present: true,
    entity_class: entityClass,
    path: filePath,
    document: readResult.document,
    issues: validation.issues,
    warnings: validation.warnings,
  };
}

export function loadOntologyDocuments({ cwd = process.cwd(), allowMissing = true } = {}) {
  const documents = ONTOLOGY_ENTITY_CLASSES.map((entityClass) =>
    loadOntologyFactDocument({ cwd, entityClass, allowMissing })
  );

  return {
    ok: documents.every((entry) => entry.ok),
    documents,
    issues: documents.flatMap((entry) => entry.issues || []),
    warnings: documents.flatMap((entry) => entry.warnings || []),
    missing: documents.filter((entry) => entry.present === false).map((entry) => entry.entity_class),
  };
}
