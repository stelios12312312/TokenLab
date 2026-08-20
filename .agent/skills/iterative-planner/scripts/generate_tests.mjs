#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { fileURLToPath } from "url";

import { buildTaskContext } from "./ontology_context.mjs";
import { nowISO, readStateJson } from "./lib/determinism.mjs";
import { buildConventionArtifactsForCriterion } from "./lib/convention_checks.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { loadOntologyRuntime } from "./lib/ontology_runtime.mjs";
import { getPaths, normalizePlanDirName } from "./lib/plan_utils.mjs";
import {
  readEffectiveVerificationStrategy,
  renderVerificationStrategyDocument,
} from "./lib/verification_strategy.mjs";

export const TEST_SPECIFICATION_FILENAME = "test_specification.yaml";

const DEFAULT_PROOF_TYPE = "integration_test";
const DEFAULT_TEST_TYPE = "integration";
const HIGHER_RISK_LEVELS = new Set(["high", "critical"]);

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/generate_tests.mjs --plan <plan-dir> [--json] [--update-strategy]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    plan: null,
    json: false,
    updateStrategy: false,
    help: false,
    invalid: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--plan":
        options.plan = args.shift() || null;
        break;
      case "--json":
        options.json = true;
        break;
      case "--update-strategy":
        options.updateStrategy = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        options.invalid = token;
        break;
    }
  }

  return options;
}

function readText(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function parseJsonCompatibleYaml(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function normalizeArtifactList(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function slugify(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function uniqueList(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function resolvePlanArg(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  const normalizedPlanDirName = normalizePlanDirName(planArg, plansDir);
  if (normalizedPlanDirName) {
    const candidate = join(plansDir, normalizedPlanDirName);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(cwd, planArg || "");
}

function extractGoalFromPlanContent(planContent) {
  const match = String(planContent || "").match(/\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/);
  if (!match) return "";
  return normalizeString(match[1].split("\n")[0]);
}

function readPlanGoal(planDir, planContent) {
  const stateJson = readStateJson(planDir);
  return normalizeString(stateJson?.goal) || extractGoalFromPlanContent(planContent) || basename(planDir);
}

function getProofWeights(runtime) {
  return runtime?.documents?.proof_weights || {
    proof_types: {},
    risk_levels: {},
    domain_defaults: {},
  };
}

function getProofTypeRecord(proofWeights, proofType) {
  return proofWeights?.proof_types?.[proofType] || null;
}

function getProofTypeBaseWeight(proofWeights, proofType) {
  const record = getProofTypeRecord(proofWeights, proofType);
  return Number.isFinite(Number(record?.base_weight)) ? Number(record.base_weight) : 0;
}

function proofTypeToTestType(proofType) {
  if (proofType === "unit_test") return "unit";
  if (proofType === "e2e_test") return "e2e";
  return "integration";
}

function mapStrategyTestTypeToProofType(testType) {
  const normalized = normalizeString(testType);
  if (normalized === "unit") return "unit_test";
  if (normalized === "e2e") return "e2e_test";
  return "integration_test";
}

function selectFirstAvailableProofType(proofWeights, candidates) {
  for (const candidate of candidates) {
    if (getProofTypeRecord(proofWeights, candidate)) return candidate;
  }
  const declared = Object.keys(proofWeights?.proof_types || {}).sort((left, right) => left.localeCompare(right));
  return declared[0] || DEFAULT_PROOF_TYPE;
}

function determinePrimaryProofShape({ criterion, domain, changeClasses, proofWeights }) {
  const requiredProofText = normalizeString(criterion?.required_proof_type).toLowerCase();
  let proofType = DEFAULT_PROOF_TYPE;
  let type = DEFAULT_TEST_TYPE;

  if (/(^|[^a-z])e2e([^a-z]|$)|end.?to.?end/.test(requiredProofText)) {
    proofType = selectFirstAvailableProofType(proofWeights, ["e2e_test", "integration_test", "unit_test"]);
  } else if (/(^|[^a-z])unit([^a-z]|$)/.test(requiredProofText) && !/integration/.test(requiredProofText)) {
    proofType = selectFirstAvailableProofType(proofWeights, ["unit_test", "integration_test"]);
  } else if (/command_smoke|manual_smoke|smoke/.test(requiredProofText)) {
    proofType = selectFirstAvailableProofType(proofWeights, ["integration_test", "unit_test"]);
    type = "smoke";
  } else if (
    /integration|parity/.test(requiredProofText) ||
    ["planner_core", "verification", "migration", "traceability"].includes(domain) ||
    changeClasses.some((entry) => ["parser_reader", "workflow", "migration", "verification", "interface"].includes(entry))
  ) {
    proofType = selectFirstAvailableProofType(proofWeights, ["integration_test", "unit_test"]);
  } else if (normalizeString(criterion?.implementation?.function)) {
    proofType = selectFirstAvailableProofType(proofWeights, ["unit_test", "integration_test"]);
  }

  if (type !== "smoke") {
    type = proofTypeToTestType(proofType);
  }

  return { proofType, type };
}

function applicableProofModifiers({ proofWeights, proofType, context, riskLevel }) {
  const declaredModifiers = Array.isArray(getProofTypeRecord(proofWeights, proofType)?.modifiers)
    ? getProofTypeRecord(proofWeights, proofType).modifiers
    : [];
  const modifierConditions = new Set(declaredModifiers.map((entry) => normalizeString(entry?.condition)).filter(Boolean));
  const modifiers = [];

  if (
    modifierConditions.has("cross_module") &&
    (
      (context?.likely_affected_files || []).length > 1 ||
      (context?.mirror_readers_to_consider || []).length > 0
    )
  ) {
    modifiers.push("cross_module");
  }

  if (modifierConditions.has("critical_path") && HIGHER_RISK_LEVELS.has(normalizeString(riskLevel).toLowerCase())) {
    modifiers.push("critical_path");
  }

  return modifiers;
}

function estimateProofWeight({ proofWeights, proofType, modifiers = [] }) {
  const record = getProofTypeRecord(proofWeights, proofType);
  if (!record) return 0;
  const modifierIndex = new Map(
    (Array.isArray(record.modifiers) ? record.modifiers : [])
      .map((entry) => [normalizeString(entry?.condition), Number(entry?.delta) || 0])
  );
  return getProofTypeBaseWeight(proofWeights, proofType)
    + modifiers.reduce((total, modifier) => total + (modifierIndex.get(modifier) || 0), 0);
}

function getDefaultGeneratedTestFile(planId, criterionId) {
  return `tests/generated/${planId}/${normalizeString(criterionId).toLowerCase()}.spec.mjs`;
}

function determineTestFile(planId, criterionId, existingTests) {
  const declaredFiles = uniqueList(
    (Array.isArray(existingTests) ? existingTests : [])
      .map((test) => normalizeString(test?.file))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  );
  if (declaredFiles.length > 0) return declaredFiles[0];
  return getDefaultGeneratedTestFile(planId, criterionId);
}

function isDeclaredTestFilePresent(cwd, filePath) {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) return false;
  return existsSync(resolve(cwd, normalizedPath));
}

function buildExistingTestEntry({ cwd, criterion, planId, proofWeights, existingTest, defaultFile, context, riskLevel }) {
  const proofType = selectFirstAvailableProofType(
    proofWeights,
    [mapStrategyTestTypeToProofType(existingTest?.type), DEFAULT_PROOF_TYPE, "unit_test"]
  );
  const modifiers = applicableProofModifiers({
    proofWeights,
    proofType,
    context,
    riskLevel,
  });

  return {
    id: `${criterion.id}:${slugify(existingTest?.name || `${existingTest?.type || "integration"}_slot`)}`,
    name: normalizeString(existingTest?.name) || `generated_${slugify(criterion.id)}_planned_test`,
    intent: "planned_test",
    proof_type: proofType,
    type: normalizeString(existingTest?.type) || proofTypeToTestType(proofType),
    file: normalizeString(existingTest?.file) || defaultFile,
    target_file: normalizeString(criterion?.implementation?.file) || (context?.likely_affected_files || [])[0] || null,
    target_function: normalizeString(criterion?.implementation?.function) || null,
    description: `Existing planned test slot carried forward from verification_strategy.yaml (${normalizeString(existingTest?.name) || "unnamed test"}).`,
    estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
    modifiers,
    source: "verification_strategy",
    already_present: isDeclaredTestFilePresent(cwd, normalizeString(existingTest?.file) || defaultFile),
  };
}

function buildPrimaryTestEntry({ criterion, planId, proofWeights, defaultFile, context, domain, riskLevel }) {
  const { proofType, type } = determinePrimaryProofShape({
    criterion,
    domain,
    changeClasses: context?.inferred_tags?.change_classes || [],
    proofWeights,
  });
  const modifiers = applicableProofModifiers({
    proofWeights,
    proofType,
    context,
    riskLevel,
  });

  return {
    id: `${criterion.id}:happy_path`,
    name: `generated_${slugify(criterion.id)}_happy_path`,
    intent: "happy_path",
    proof_type: proofType,
    type,
    file: defaultFile,
    target_file: normalizeString(criterion?.implementation?.file) || (context?.likely_affected_files || [])[0] || null,
    target_function: proofType === "unit_test" ? normalizeString(criterion?.implementation?.function) || null : null,
    description: normalizeString(criterion?.criterion) || "Happy-path coverage for the declared criterion.",
    estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
    modifiers,
    source: "criterion_primary",
    already_present: false,
  };
}

function buildConventionTestEntries({
  criterion,
  planId,
  defaultFile,
  proofWeights,
  changeClasses,
  conventionArtifacts,
}) {
  return conventionArtifacts.map((artifact) => {
    const conventionId = normalizeString(artifact?.convention_id) || "convention";
    const proofType = "integration_test";
    return {
      id: `${criterion.id}:convention:${slugify(conventionId)}`,
      name: `generated_${slugify(criterion.id)}_convention_${slugify(conventionId)}`,
      intent: "convention_application",
      convention_id: conventionId,
      proof_type: proofType,
      type: proofTypeToTestType(proofType),
      file: defaultFile || getDefaultGeneratedTestFile(planId, criterion?.id),
      target_file: normalizeString(artifact?.target_file) || normalizeString(criterion?.implementation?.file) || null,
      target_function: null,
      description: `Prove ${conventionId} is applied for ${normalizeString(artifact?.target_file) || normalizeString(criterion?.implementation?.file) || "the implementation file"}.`,
      estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers: [] }),
      modifiers: [],
      source: `convention:${conventionId}`,
      already_present: false,
      change_classes: normalizeStringArray(changeClasses),
    };
  });
}

function buildConventionEvidenceSummary({ proofWeights, artifacts }) {
  return normalizeArtifactList(artifacts).map((artifact) => ({
    ...artifact,
    estimated_weight: estimateProofWeight({
      proofWeights,
      proofType: normalizeString(artifact?.proof_type),
      modifiers: [],
    }),
  }));
}

function buildEdgeCaseEntries({ criterion, defaultFile, proofWeights, context, riskLevel }) {
  const changeClasses = context?.inferred_tags?.change_classes || [];
  const unitFriendly = normalizeString(criterion?.implementation?.function)
    && !changeClasses.some((entry) => ["parser_reader", "workflow", "migration", "verification", "interface"].includes(entry));

  return (context?.edge_cases_to_consider || [])
    .slice()
    .sort((left, right) => `${left.domain}:${left.label}`.localeCompare(`${right.domain}:${right.label}`))
    .map((edgeCase) => {
      const proofType = selectFirstAvailableProofType(
        proofWeights,
        [unitFriendly ? "unit_test" : "integration_test", "integration_test", "unit_test"]
      );
      const modifiers = applicableProofModifiers({
        proofWeights,
        proofType,
        context,
        riskLevel,
      });
      return {
        id: `${criterion.id}:edge_case:${slugify(edgeCase.label)}`,
        name: `generated_${slugify(criterion.id)}_edge_case_${slugify(edgeCase.label)}`,
        intent: "edge_case",
        edge_case: edgeCase.label,
        proof_type: proofType,
        type: proofTypeToTestType(proofType),
        file: defaultFile,
        target_file: normalizeString(criterion?.implementation?.file) || null,
        target_function: proofType === "unit_test" ? normalizeString(criterion?.implementation?.function) || null : null,
        description: normalizeString(edgeCase.description) || `Cover edge case ${edgeCase.label}.`,
        estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
        modifiers,
        source: `edge_case:${edgeCase.domain}/${edgeCase.label}`,
        already_present: false,
      };
    });
}

function buildPatternEntries({ criterion, defaultFile, proofWeights, context, riskLevel }) {
  return (context?.applicable_patterns || [])
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((pattern) => {
      const proofType = selectFirstAvailableProofType(proofWeights, ["integration_test", "unit_test"]);
      const modifiers = applicableProofModifiers({
        proofWeights,
        proofType,
        context,
        riskLevel,
      });
      return {
        id: `${criterion.id}:pattern:${slugify(pattern.id)}`,
        name: `generated_${slugify(criterion.id)}_pattern_${slugify(pattern.id)}`,
        intent: "pattern_application",
        pattern: pattern.id,
        proof_type: proofType,
        type: proofTypeToTestType(proofType),
        file: defaultFile,
        target_file: normalizeString(criterion?.implementation?.file) || null,
        target_function: null,
        description: `Apply ontology pattern ${pattern.id}: ${normalizeString(pattern.title) || pattern.id}.`,
        estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
        modifiers,
        source: `pattern:${pattern.id}`,
        already_present: false,
      };
    });
}

function buildHistoricalIncidentEntries({ criterion, defaultFile, proofWeights, context, riskLevel }) {
  return (context?.historical_incidents || [])
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((incident) => {
      const proofType = selectFirstAvailableProofType(proofWeights, ["integration_test", "unit_test"]);
      const modifiers = applicableProofModifiers({
        proofWeights,
        proofType,
        context,
        riskLevel,
      });
      return {
        id: `${criterion.id}:historical_incident:${slugify(incident.id)}`,
        name: `generated_${slugify(criterion.id)}_incident_${slugify(incident.id)}`,
        intent: "historical_incident_guard",
        historical_incident: incident.id,
        proof_type: proofType,
        type: proofTypeToTestType(proofType),
        file: defaultFile,
        target_file: normalizeString(criterion?.implementation?.file) || null,
        target_function: null,
        description: `Guard against historical incident ${incident.id}: ${normalizeString(incident.title) || incident.id}.`,
        estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
        modifiers,
        source: `historical_incident:${incident.id}`,
        already_present: false,
      };
    });
}

function buildMirrorReaderEntries({ criterion, defaultFile, proofWeights, context, riskLevel }) {
  return (context?.mirror_readers_to_consider || [])
    .slice()
    .sort((left, right) => `${left.artifact}:${left.reader}`.localeCompare(`${right.artifact}:${right.reader}`))
    .map((mirror) => {
      const proofType = selectFirstAvailableProofType(proofWeights, ["integration_test", "unit_test"]);
      const modifiers = applicableProofModifiers({
        proofWeights,
        proofType,
        context,
        riskLevel,
      });
      return {
        id: `${criterion.id}:mirror_reader:${slugify(mirror.reader)}`,
        name: `generated_${slugify(criterion.id)}_mirror_reader_${slugify(mirror.artifact)}`,
        intent: "mirror_reader",
        proof_type: proofType,
        type: proofTypeToTestType(proofType),
        file: defaultFile,
        target_file: normalizeString(criterion?.implementation?.file) || normalizeString(mirror.reader) || null,
        target_function: null,
        description: `Keep ${normalizeString(mirror.artifact)} aligned with mirror reader ${normalizeString(mirror.reader)}.`,
        estimated_weight: estimateProofWeight({ proofWeights, proofType, modifiers }),
        modifiers,
        reader: normalizeString(mirror.reader),
        artifact: normalizeString(mirror.artifact),
        source: `mirror_reader:${normalizeString(mirror.reader)}->${normalizeString(mirror.artifact)}`,
        already_present: false,
      };
    });
}

function dedupeRequiredTests(requiredTests) {
  const seen = new Set();
  const deduped = [];

  for (const test of requiredTests) {
    const key = [
      normalizeString(test?.name).toLowerCase(),
      normalizeString(test?.file).toLowerCase(),
      normalizeString(test?.type).toLowerCase(),
    ].join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(test);
  }

  return deduped;
}

function compareProofTypeCandidate(left, right, proofWeights) {
  const weightDelta = getProofTypeBaseWeight(proofWeights, right) - getProofTypeBaseWeight(proofWeights, left);
  if (weightDelta !== 0) return weightDelta;
  return left.localeCompare(right);
}

function buildAdditionalEvidencePool({ domain, changeClasses, riskLevel, proofWeights }) {
  const preferred = [];
  if (HIGHER_RISK_LEVELS.has(riskLevel)) preferred.push("mutation_testing_pass");
  if (changeClasses.includes("interface")) preferred.push("network_trace_expected");
  if (changeClasses.includes("ui")) preferred.push("screenshot_baseline", "accessibility_audit_pass");
  if (changeClasses.includes("workflow")) preferred.push("console_log_clean");
  if (domain === "payment") preferred.push("coverage_threshold_met");
  if (domain === "verification") preferred.push("coverage_threshold_met");

  const rest = Object.keys(proofWeights?.proof_types || {}).sort((left, right) =>
    compareProofTypeCandidate(left, right, proofWeights)
  );
  return uniqueList([...preferred, ...rest]);
}

function explainAdditionalEvidenceReason(proofType, proofWeights, { domain, changeClasses, riskLevel }) {
  if (proofType === "mutation_testing_pass") return "Higher-risk criteria benefit from proof that kills superficial coverage.";
  if (proofType === "network_trace_expected") return "Interface-heavy changes benefit from a recorded transport contract.";
  if (proofType === "screenshot_baseline") return "UI-adjacent changes benefit from a visual regression artifact.";
  if (proofType === "accessibility_audit_pass") return "UI-adjacent changes benefit from a focused accessibility audit.";
  if (proofType === "console_log_clean") return "Smoke-oriented workflows benefit from a clean runtime transcript.";
  if (proofType === "coverage_threshold_met" && (domain === "payment" || domain === "verification")) {
    return "Coverage helps verify the higher-risk path is not only exercised narrowly.";
  }
  if (HIGHER_RISK_LEVELS.has(riskLevel) && changeClasses.includes("migration")) {
    return "Migration work benefits from layered proof beyond a single integration path.";
  }
  return normalizeString(getProofTypeRecord(proofWeights, proofType)?.description) || `Additional evidence candidate: ${proofType}`;
}

function recommendAdditionalEvidence({ gap, usedProofTypes, domain, changeClasses, riskLevel, proofWeights }) {
  if (gap <= 0) return [];

  let remainingGap = gap;
  const recommendations = [];

  for (const proofType of buildAdditionalEvidencePool({ domain, changeClasses, riskLevel, proofWeights })) {
    if (usedProofTypes.has(proofType)) continue;
    const baseWeight = getProofTypeBaseWeight(proofWeights, proofType);
    if (baseWeight <= 0) continue;
    recommendations.push({
      proof_type: proofType,
      reason: explainAdditionalEvidenceReason(proofType, proofWeights, { domain, changeClasses, riskLevel }),
      estimated_weight: baseWeight,
    });
    remainingGap -= baseWeight;
    if (remainingGap <= 0 || recommendations.length >= 3) break;
  }

  return recommendations;
}

function buildCriterionTaskDescription({ goal, criterion, story }) {
  return [
    goal,
    normalizeString(criterion?.criterion),
    story ? `Story ${normalizeString(story.title)} (${normalizeString(story.id)})` : "",
    normalizeString(criterion?.domain) ? `Domain ${normalizeString(criterion.domain)}` : "",
    normalizeString(criterion?.repo_system_context),
    normalizeString(criterion?.implementation?.file),
    normalizeString(criterion?.implementation?.function),
  ].filter(Boolean).join("; ");
}

function buildCriterionSpecification({
  cwd,
  criterion,
  planId,
  goal,
  story,
  proofWeights,
  context,
}) {
  const domain = normalizeString(criterion?.domain) || normalizeString(story?.domain) || null;
  const riskLevel = normalizeString(criterion?.risk_level) || "medium";
  const requiredProofWeight = Number.isFinite(Number(criterion?.required_proof_weight))
    ? Number(criterion.required_proof_weight)
    : 0;
  const defaultFile = determineTestFile(planId, criterion.id, criterion?.tests);
  const existingTests = Array.isArray(criterion?.tests)
    ? criterion.tests.map((test) =>
      buildExistingTestEntry({
        cwd,
        criterion,
        planId,
        proofWeights,
        existingTest: test,
        defaultFile,
        context,
        riskLevel,
      }))
    : [];
  const generatedTests = [];
  const conventionArtifacts = buildConventionEvidenceSummary({
    proofWeights,
    artifacts: buildConventionArtifactsForCriterion({
      cwd,
      planDir: join(getPaths(cwd).plansDir, planId),
      implementationFile: criterion?.implementation?.file,
      changeClasses: normalizeStringArray(context?.inferred_tags?.change_classes),
    }),
  });

  if (existingTests.length === 0) {
    generatedTests.push(buildPrimaryTestEntry({
      criterion,
      planId,
      proofWeights,
      defaultFile,
      context,
      domain,
      riskLevel,
    }));
  }

  generatedTests.push(
    ...buildConventionTestEntries({
      criterion,
      planId,
      defaultFile,
      proofWeights,
      changeClasses: context?.inferred_tags?.change_classes || [],
      conventionArtifacts,
    }),
    ...buildEdgeCaseEntries({ criterion, defaultFile, proofWeights, context, riskLevel }),
    ...buildPatternEntries({ criterion, defaultFile, proofWeights, context, riskLevel }),
    ...buildHistoricalIncidentEntries({ criterion, defaultFile, proofWeights, context, riskLevel }),
    ...buildMirrorReaderEntries({ criterion, defaultFile, proofWeights, context, riskLevel }),
  );

  const requiredTests = dedupeRequiredTests([...existingTests, ...generatedTests]);
  const estimatedTestWeight = requiredTests.reduce(
    (total, test) => total + (Number.isFinite(Number(test?.estimated_weight)) ? Number(test.estimated_weight) : 0),
    0
  );
  const estimatedArtifactWeight = conventionArtifacts.reduce(
    (total, artifact) => total + (Number.isFinite(Number(artifact?.estimated_weight)) ? Number(artifact.estimated_weight) : 0),
    0
  );
  const estimatedProofWeight = estimatedTestWeight + estimatedArtifactWeight;
  const usedProofTypes = new Set(requiredTests.map((test) => normalizeString(test?.proof_type)).filter(Boolean));
  for (const artifact of conventionArtifacts) {
    if (normalizeString(artifact?.proof_type)) usedProofTypes.add(normalizeString(artifact.proof_type));
  }
  const additionalEvidenceRecommended = recommendAdditionalEvidence({
    gap: requiredProofWeight - estimatedProofWeight,
    usedProofTypes,
    domain,
    changeClasses: context?.inferred_tags?.change_classes || [],
    riskLevel,
    proofWeights,
  });

  return {
    criterion_id: normalizeString(criterion?.id) || null,
    story_id: normalizeString(criterion?.story_id) || normalizeString(story?.id) || null,
    story_title: normalizeString(story?.title) || null,
    domain,
    risk_level: riskLevel,
    required_proof_weight: requiredProofWeight,
    change_classes: normalizeStringArray(context?.inferred_tags?.change_classes),
    likely_affected_files: normalizeStringArray(context?.likely_affected_files),
    required_tests: requiredTests,
    required_evidence_artifacts: conventionArtifacts,
    estimated_proof_weight: estimatedProofWeight,
    proof_sufficient_estimate: estimatedProofWeight >= requiredProofWeight,
    additional_evidence_recommended: additionalEvidenceRecommended,
  };
}

function narrowTaskContextForCriterion(context, criterion, story) {
  const domain = normalizeString(criterion?.domain) || normalizeString(story?.domain) || null;
  const implementationFile = normalizeString(criterion?.implementation?.file);
  const changeClasses = normalizeStringArray(context?.inferred_tags?.change_classes);
  const narrowedChangeClasses = uniqueList(
    changeClasses.filter((entry) =>
      entry === domain
      || (domain === "parser_reader" && entry === "parser_reader")
      || ["verification", "migration", "workflow", "traceability", "parser_reader"].includes(entry)
    )
  );

  const edgeCases = domain
    ? (context?.edge_cases_to_consider || []).filter((entry) => normalizeString(entry?.domain) === domain)
    : (context?.edge_cases_to_consider || []);
  const patterns = (context?.applicable_patterns || []).filter((pattern) => {
    const appliesTo = normalizeStringArray(pattern?.applies_to);
    if (!domain && narrowedChangeClasses.length === 0) return true;
    return appliesTo.some((entry) => entry === domain || narrowedChangeClasses.includes(entry));
  });
  const incidents = (() => {
    const all = context?.historical_incidents || [];
    if (!domain) return all;
    const domainMatches = all.filter((entry) => entry?.domain_match === true);
    if (domainMatches.length > 0) return domainMatches;
    return all.filter((entry) => entry?.change_class_match === true);
  })();
  const mirrorReaders = (
    domain === "parser_reader" || narrowedChangeClasses.includes("parser_reader")
      ? (context?.mirror_readers_to_consider || [])
      : []
  );
  const likelyAffectedFiles = (() => {
    const inferred = normalizeStringArray(context?.likely_affected_files);
    if (!implementationFile) return inferred;
    const matched = inferred.filter((filePath) =>
      filePath === implementationFile
      || basename(filePath) === basename(implementationFile)
      || basename(implementationFile).includes(basename(filePath))
      || filePath.includes(basename(implementationFile))
    );
    return uniqueList([implementationFile, ...matched]).slice(0, 10);
  })();

  return {
    ...(context || {}),
    inferred_tags: {
      ...(context?.inferred_tags || {}),
      change_class: narrowedChangeClasses[0] || context?.inferred_tags?.change_class || null,
      change_classes: narrowedChangeClasses,
      domains: domain ? [domain] : normalizeStringArray(context?.inferred_tags?.domains),
    },
    likely_affected_files: likelyAffectedFiles,
    edge_cases_to_consider: edgeCases,
    historical_incidents: incidents,
    applicable_patterns: patterns,
    mirror_readers_to_consider: mirrorReaders,
  };
}

function summarizeSpecification(perCriterion) {
  const requiredTests = perCriterion.flatMap((criterion) => criterion.required_tests || []);
  const requiredArtifacts = perCriterion.flatMap((criterion) => criterion.required_evidence_artifacts || []);
  const alreadyPresent = requiredTests.filter((test) => test.already_present === true).length;
  const additionalEvidenceCount = perCriterion.reduce(
    (total, criterion) => total + (criterion.additional_evidence_recommended || []).length,
    0
  );
  const criteriaWithProofGap = perCriterion
    .filter((criterion) => criterion.proof_sufficient_estimate === false)
    .map((criterion) => criterion.criterion_id);

  return {
    total_criteria: perCriterion.length,
    total_tests_required: requiredTests.length,
    total_evidence_artifacts_required: requiredArtifacts.length,
    tests_to_implement: requiredTests.length - alreadyPresent,
    tests_already_present: alreadyPresent,
    additional_evidence_candidates: additionalEvidenceCount,
    criteria_with_proof_gap: criteriaWithProofGap,
  };
}

export function getTestSpecificationPath(planDir) {
  return join(planDir, TEST_SPECIFICATION_FILENAME);
}

export function readTestSpecificationDocument({ planDir } = {}) {
  const path = getTestSpecificationPath(resolve(planDir || process.cwd()));
  const raw = readText(path);
  if (!raw) {
    return {
      ok: false,
      path,
      document: null,
      specification: null,
      errors: [`Missing ${TEST_SPECIFICATION_FILENAME}`],
    };
  }

  const document = parseJsonCompatibleYaml(raw);
  if (!document) {
    return {
      ok: false,
      path,
      document: null,
      specification: null,
      errors: [`${TEST_SPECIFICATION_FILENAME} must be valid JSON-compatible YAML`],
    };
  }

  if (!document.test_specification || typeof document.test_specification !== "object") {
    return {
      ok: false,
      path,
      document,
      specification: null,
      errors: [`${TEST_SPECIFICATION_FILENAME} must contain a test_specification object`],
    };
  }

  return {
    ok: true,
    path,
    document,
    specification: document.test_specification,
    errors: [],
  };
}

export function renderTestSpecificationDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function toStrategyTestEntry(test) {
  return {
    name: normalizeString(test?.name) || null,
    file: normalizeString(test?.file) || null,
    type: normalizeString(test?.type) || null,
  };
}

function mergeStrategyTests(existingTests, requiredTests) {
  const merged = [];
  const seen = new Set();
  for (const candidate of [...(Array.isArray(existingTests) ? existingTests : []), ...requiredTests.map(toStrategyTestEntry)]) {
    const normalized = toStrategyTestEntry(candidate);
    const key = [
      normalizeString(normalized?.name).toLowerCase(),
      normalizeString(normalized?.file).toLowerCase(),
      normalizeString(normalized?.type).toLowerCase(),
    ].join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

export function buildTestSpecification({
  cwd = process.cwd(),
  planDir,
  strategyResult,
  runtime,
  planContent = null,
} = {}) {
  const resolvedPlanContent = typeof planContent === "string"
    ? planContent
    : readText(join(planDir, "plan.md")) || "";
  const goal = readPlanGoal(planDir, resolvedPlanContent);
  const planId = basename(planDir);
  const proofWeights = getProofWeights(runtime);
  const stories = Array.isArray(runtime?.documents?.specification?.stories)
    ? runtime.documents.specification.stories
    : [];
  const storyById = new Map(stories.map((story) => [story.id, story]));
  const warnings = [...(runtime?.warnings || [])];

  const perCriterion = (strategyResult?.strategy?.criteria || []).map((criterion) => {
    const story = storyById.get(normalizeString(criterion?.story_id)) || null;
    const taskDescription = buildCriterionTaskDescription({ goal, criterion, story });
    const contextResult = buildTaskContext({ cwd, taskDescription });
    if (!contextResult.ok) warnings.push(...(contextResult.issues || []));
    const baseContext = contextResult.ok ? contextResult.task_context : {
      inferred_tags: { change_classes: [] },
      likely_affected_files: [],
      edge_cases_to_consider: [],
      historical_incidents: [],
      applicable_patterns: [],
      mirror_readers_to_consider: [],
    };

    return buildCriterionSpecification({
      cwd,
      criterion,
      planId,
      goal,
      story,
      proofWeights,
      context: narrowTaskContextForCriterion(baseContext, criterion, story),
    });
  });

  return {
    test_specification: {
      version: 1,
      plan_id: planId,
      generated_at: nowISO(),
      goal,
      per_criterion: perCriterion,
      summary: summarizeSpecification(perCriterion),
    },
    warnings,
  };
}

export function generateTestsForPlan({
  cwd = process.cwd(),
  planDir,
  updateStrategy = false,
} = {}) {
  const resolvedPlanDir = resolve(planDir || cwd);
  const planContent = readText(join(resolvedPlanDir, "plan.md")) || "";
  const strategyResult = readEffectiveVerificationStrategy({
    cwd,
    planDir: resolvedPlanDir,
    planContent,
  });
  if (!strategyResult.ok) {
    return {
      ok: false,
      command: "generate-tests",
      plan_id: basename(resolvedPlanDir),
      plan_path: resolvedPlanDir,
      strategy_path: strategyResult.path,
      test_specification_path: getTestSpecificationPath(resolvedPlanDir),
      warnings: strategyResult.warnings || [],
      issues: strategyResult.errors || ["verification strategy unavailable"],
    };
  }

  if (updateStrategy && strategyResult.source !== "yaml") {
    return {
      ok: false,
      command: "generate-tests",
      plan_id: basename(resolvedPlanDir),
      plan_path: resolvedPlanDir,
      strategy_path: strategyResult.path,
      test_specification_path: getTestSpecificationPath(resolvedPlanDir),
      warnings: strategyResult.warnings || [],
      issues: ["--update-strategy requires a canonical verification_strategy.yaml file"],
    };
  }

  const runtime = loadOntologyRuntime({ cwd });
  if (!runtime.ok) {
    return {
      ok: false,
      command: "generate-tests",
      plan_id: basename(resolvedPlanDir),
      plan_path: resolvedPlanDir,
      strategy_path: strategyResult.path,
      test_specification_path: getTestSpecificationPath(resolvedPlanDir),
      warnings: runtime.warnings || [],
      issues: runtime.issues || ["ontology runtime unavailable"],
    };
  }

  const specificationDoc = buildTestSpecification({
    cwd,
    planDir: resolvedPlanDir,
    strategyResult,
    runtime,
    planContent,
  });
  const testSpecificationPath = getTestSpecificationPath(resolvedPlanDir);
  writeFileSync(
    testSpecificationPath,
    renderTestSpecificationDocument({ test_specification: specificationDoc.test_specification })
  );

  let strategyUpdated = false;
  if (updateStrategy) {
    const updatedDocument = {
      verification_strategy: {
        ...strategyResult.document.verification_strategy,
        updated_at: nowISO(),
        criteria: (strategyResult.document.verification_strategy.criteria || []).map((criterion) => {
          const generatedCriterion = specificationDoc.test_specification.per_criterion
            .find((entry) => entry.criterion_id === criterion.id);
          if (!generatedCriterion) return criterion;
          return {
            ...criterion,
            tests: mergeStrategyTests(criterion.tests, generatedCriterion.required_tests || []),
          };
        }),
      },
    };
    writeFileSync(strategyResult.path, renderVerificationStrategyDocument(updatedDocument));
    strategyUpdated = true;
  }

  return {
    ok: true,
    command: "generate-tests",
    plan_id: basename(resolvedPlanDir),
    plan_path: resolvedPlanDir,
    strategy_path: strategyResult.path,
    strategy_source: strategyResult.source,
    strategy_updated: strategyUpdated,
    test_specification_path: testSpecificationPath,
    test_specification: specificationDoc.test_specification,
    warnings: uniqueList([...(strategyResult.warnings || []), ...(specificationDoc.warnings || [])]),
    issues: [],
  };
}

function renderHuman(result) {
  if (!result.ok) {
    const lines = ["Test specification generation: FAIL"];
    if (result.plan_id) lines.push(`Plan: ${result.plan_id}`);
    if (result.strategy_path) lines.push(`Strategy: ${result.strategy_path}`);
    if (result.test_specification_path) lines.push(`Test specification: ${result.test_specification_path}`);
    if ((result.warnings || []).length > 0) {
      lines.push("Warnings:");
      for (const warning of result.warnings) lines.push(`- ${warning}`);
    }
    if ((result.issues || []).length > 0) {
      lines.push("Issues:");
      for (const issue of result.issues) lines.push(`- ${issue}`);
    }
    return lines.join("\n");
  }

  const lines = [
    `Generated test specification for ${result.plan_id}`,
    `- strategy: ${result.strategy_path} (${result.strategy_source})`,
    `- test_specification: ${result.test_specification_path}`,
    `- total_criteria: ${result.test_specification.summary.total_criteria}`,
    `- total_tests_required: ${result.test_specification.summary.total_tests_required}`,
    `- total_evidence_artifacts_required: ${result.test_specification.summary.total_evidence_artifacts_required}`,
    `- tests_to_implement: ${result.test_specification.summary.tests_to_implement}`,
    `- tests_already_present: ${result.test_specification.summary.tests_already_present}`,
    `- strategy_updated: ${result.strategy_updated ? "yes" : "no"}`,
    "Per criterion:",
  ];

  for (const criterion of result.test_specification.per_criterion || []) {
    lines.push(
      `- ${criterion.criterion_id} (${criterion.story_id || "no-story"} / ${criterion.domain || "no-domain"}): `
      + `${criterion.required_tests.length} tests, estimated ${criterion.estimated_proof_weight}/${criterion.required_proof_weight}`
    );
  }

  if ((result.warnings || []).length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (options.invalid || !options.plan) {
    if (options.invalid) console.error(`Unknown argument: ${options.invalid}`);
    console.error(usage());
    process.exit(2);
  }

  const result = generateTestsForPlan({
    cwd: process.cwd(),
    planDir: resolvePlanArg(process.cwd(), options.plan),
    updateStrategy: options.updateStrategy,
  });
  if (options.json) {
    emitJson(result, { exitCode: result.ok ? 0 : 1 });
  } else {
    console.log(renderHuman(result));
    process.exit(result.ok ? 0 : 1);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main();
}
