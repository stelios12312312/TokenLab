// ive_ideation_operators.mjs - IVE Phase 3 anchor/operator/intent validation.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";

const VALID_BINDING_KINDS = new Set([
  "story",
  "epic",
  "anchor",
  "acceptance_criterion",
  "pre_mortem_risk",
  "advisory",
]);

const SUPPRESSED_PLAN_SHAPES = new Set(["chore", "analysis"]);
const SUPPRESSED_TRIAGE_PATHS = new Set(["skip_planner", "skip_planner_question"]);
const REQUIRED_OPERATORS = ["what_if", "pre_mortem", "how_does_this_help", "is_everything_connected"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function normalizeId(value) {
  return asString(value);
}

function normalizeEnum(value) {
  return asString(value).toLowerCase().replace(/[-\s]+/g, "_");
}

function stripLineSuffix(ref) {
  const text = asString(ref).replace(/\\/g, "/").replace(/^\.\//, "");
  const match = text.match(/^(.*):\d+$/);
  return match ? match[1] : text;
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function issue(code, subject, message, severity = "error", path = null) {
  return {
    code,
    subject: normalizeId(subject) || "unknown",
    severity,
    message,
    path,
  };
}

function normalizeStoryRegistry(registry = {}) {
  const stories = [
    ...asArray(registry?.stories),
    ...asArray(registry?.infrastructure_stories),
  ].filter((story) => story && typeof story === "object" && asString(story.id));

  const storyIds = new Set();
  const anchorIds = new Set();
  const anchors = [];

  for (const story of stories) {
    const storyId = normalizeId(story.id);
    storyIds.add(storyId);
    for (const anchor of asArray(story.anchors)) {
      if (!anchor || typeof anchor !== "object") continue;
      const anchorId = normalizeId(anchor.id);
      if (!anchorId) continue;
      anchorIds.add(anchorId);
      anchors.push({ ...anchor, id: anchorId, story_id: normalizeId(anchor.story_id || storyId), parent_story: story });
    }
  }

  return { stories, storyIds, anchorIds, anchors };
}

function collectParentRefs(story) {
  return new Set([
    ...asArray(story?.code_refs),
    ...asArray(story?.test_refs),
    ...asArray(story?.validation_refs),
  ].map(stripLineSuffix).filter(Boolean));
}

function collectAnchorRefs(anchor) {
  return [
    ...asArray(anchor?.code_refs),
    ...asArray(anchor?.test_refs),
    ...asArray(anchor?.validation_refs),
  ].map(stripLineSuffix).filter(Boolean);
}

function validateAnchorContainment(registryInfo) {
  const issues = [];
  for (const anchor of registryInfo.anchors) {
    const parentStory = anchor.parent_story;
    const parentId = normalizeId(parentStory?.id);
    const declaredStoryId = normalizeId(anchor.story_id || parentId);
    if (declaredStoryId && parentId && declaredStoryId !== parentId) {
      issues.push(issue(
        "anchor_story_mismatch",
        anchor.id,
        `Anchor ${anchor.id} declares story_id ${declaredStoryId} but is nested under ${parentId}.`,
      ));
    }

    const parentRefs = collectParentRefs(parentStory);
    const anchorRefs = collectAnchorRefs(anchor);
    if (anchorRefs.length === 0) {
      issues.push(issue("anchor_without_refs", anchor.id, `Anchor ${anchor.id} has no code/test/validation refs.`));
      continue;
    }
    for (const ref of anchorRefs) {
      if (!parentRefs.has(ref)) {
        issues.push(issue(
          "anchor_ref_not_in_story",
          anchor.id,
          `Anchor ${anchor.id} references ${ref}, which is not contained in parent story ${parentId}.`,
          "error",
          ref,
        ));
      }
    }
  }
  return issues;
}

function operatorsByKind(operatorLedger = {}) {
  const records = asArray(operatorLedger?.operators);
  const byKind = new Map();
  for (const record of records) {
    const kind = normalizeEnum(record?.operator || record?.kind || record?.name);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(record);
  }
  return byKind;
}

function isOperatorSuppressed(operatorLedger = {}, options = {}) {
  const planShape = normalizeEnum(operatorLedger?.plan_shape || options.planShape);
  const triagePath = normalizeEnum(operatorLedger?.triage_path || options.triagePath);
  return SUPPRESSED_PLAN_SHAPES.has(planShape) || SUPPRESSED_TRIAGE_PATHS.has(triagePath);
}

function minOperatorCount(operatorLedger = {}) {
  const complexity = Number(operatorLedger?.complexity_score || 0);
  const triagePath = normalizeEnum(operatorLedger?.triage_path);
  return complexity >= 6 || triagePath === "safe_change_power" ? 3 : 2;
}

function validateOperators(operatorLedger = {}, options = {}) {
  const issues = [];
  const suppressed = isOperatorSuppressed(operatorLedger, options);
  const suppressedOperators = [];
  if (suppressed) {
    for (const operator of REQUIRED_OPERATORS) suppressedOperators.push(operator);
    return { issues, suppressed: true, suppressedOperators };
  }

  const byKind = operatorsByKind(operatorLedger);
  for (const operator of REQUIRED_OPERATORS) {
    if (!byKind.has(operator)) {
      issues.push(issue("operator_record_missing", operator, `Required operator ${operator} is missing.`));
    }
  }

  const minimum = minOperatorCount(operatorLedger);
  for (const record of byKind.get("what_if") || []) {
    const alternatives = asArray(record.alternatives);
    if (alternatives.length < minimum) {
      issues.push(issue("what_if_alternatives_too_few", record.anchor_id || record.story_id || "what_if", `what_if requires at least ${minimum} alternatives.`));
    }
    const selected = asString(record.selected_alternative_id);
    if (!selected || !alternatives.some((alt) => asString(alt?.id) === selected)) {
      issues.push(issue("what_if_selected_missing", record.anchor_id || record.story_id || "what_if", "what_if must select one declared alternative."));
    }
    if (!asString(record.rationale)) {
      issues.push(issue("what_if_rationale_missing", record.anchor_id || record.story_id || "what_if", "what_if requires a rationale."));
    }
  }

  for (const record of byKind.get("pre_mortem") || []) {
    const risks = asArray(record.risks);
    if (risks.length < minimum) {
      issues.push(issue("pre_mortem_risks_too_few", record.story_id || "pre_mortem", `pre_mortem requires at least ${minimum} risks.`));
    }
    for (const risk of risks) {
      const riskId = asString(risk?.id) || "unknown_risk";
      const status = normalizeEnum(risk?.status);
      if (status === "accepted") continue;
      if (status !== "addressed") {
        issues.push(issue("pre_mortem_risk_unaddressed", riskId, `Pre-mortem risk ${riskId} is not addressed or accepted.`));
        continue;
      }
      if (!asString(risk?.mitigation_ref) || !asString(risk?.mitigation_kind)) {
        issues.push(issue("pre_mortem_risk_unaddressed", riskId, `Addressed risk ${riskId} needs mitigation_ref and mitigation_kind.`));
      }
    }
  }

  const metricIds = new Set([
    ...asArray(operatorLedger?.core_metrics).map((metric) => asString(metric?.id || metric)),
    ...asArray(operatorLedger?.north_star_metrics).map((metric) => asString(metric?.id || metric)),
    ...asArray(options.northStarMetrics).map((metric) => asString(metric?.id || metric)),
  ].filter(Boolean));
  for (const record of byKind.get("how_does_this_help") || []) {
    const metricId = asString(record.north_star_metric_id);
    if (!metricId || !metricIds.has(metricId)) {
      issues.push(issue("north_star_metric_unknown", record.anchor_id || record.story_id || "how_does_this_help", `Unknown north_star_metric_id ${metricId || "(missing)"}.`));
    }
    if (!asString(record.north_star_link)) {
      issues.push(issue("north_star_link_missing", record.anchor_id || record.story_id || "how_does_this_help", "north_star_link is required."));
    }
  }

  for (const record of byKind.get("is_everything_connected") || []) {
    const orphans = record.orphans && typeof record.orphans === "object" ? record.orphans : {};
    for (const [kind, values] of Object.entries(orphans)) {
      for (const orphan of asArray(values)) {
        issues.push(issue("traceability_orphan", asString(orphan) || kind, `Connectedness sweep found ${kind}: ${orphan}.`));
      }
    }
  }

  return { issues, suppressed: false, suppressedOperators };
}

function collectOperatorRiskIds(operatorLedger = {}) {
  const ids = new Set();
  for (const record of operatorsByKind(operatorLedger).get("pre_mortem") || []) {
    for (const risk of asArray(record.risks)) {
      const id = asString(risk?.id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function collectAcceptanceCriterionIds(options = {}) {
  return new Set([
    ...asArray(options.acceptanceCriteria).map((criterion) => asString(criterion?.id || criterion)),
    ...asArray(options.acceptance_criteria).map((criterion) => asString(criterion?.id || criterion)),
  ].filter(Boolean));
}

function bindingExists(binding, nodes) {
  const kind = normalizeEnum(binding?.kind);
  const refId = asString(binding?.ref_id || binding?.id || binding?.ref);
  if (kind === "advisory") return true;
  if (!VALID_BINDING_KINDS.has(kind) || !refId) return false;
  if (kind === "story") return nodes.storyIds.has(refId);
  if (kind === "anchor") return nodes.anchorIds.has(refId);
  if (kind === "acceptance_criterion") return nodes.acceptanceCriterionIds.has(refId);
  if (kind === "pre_mortem_risk") return nodes.riskIds.has(refId);
  if (kind === "epic") return nodes.epicIds.has(refId);
  return false;
}

function validateIntentContract(intentContract = {}, registryInfo, operatorLedger = {}, options = {}) {
  const issues = [];
  const warnings = [];
  const imperatives = asArray(intentContract?.imperatives);
  const extracted = [
    ...asArray(intentContract?.extracted_imperatives),
    ...asArray(options.extractedImperatives),
  ];
  const imperativeSources = new Set(imperatives.map((imp) => asString(imp?.source)).filter(Boolean));
  const imperativeIds = new Set(imperatives.map((imp) => asString(imp?.id)).filter(Boolean));
  const nodes = {
    storyIds: registryInfo.storyIds,
    anchorIds: registryInfo.anchorIds,
    riskIds: collectOperatorRiskIds(operatorLedger),
    acceptanceCriterionIds: collectAcceptanceCriterionIds(options),
    epicIds: new Set(asArray(options.epics).map((epic) => asString(epic?.id || epic)).filter(Boolean)),
  };

  for (const imperative of imperatives) {
    const id = asString(imperative?.id) || asString(imperative?.source) || "imperative";
    if (!bindingExists(imperative?.binding, nodes)) {
      issues.push(issue("imperative_unbound", id, `Imperative ${id} is not bound to an existing ontology node.`));
    }
  }

  for (const candidate of extracted) {
    const source = asString(candidate?.source || candidate?.id);
    if (source && !imperativeSources.has(source)) {
      issues.push(issue("imperative_missing_from_contract", source, `Extracted imperative ${source} is missing from intent_contract.imperatives.`));
    }
  }

  const advisoryCount = imperatives.filter((imp) => normalizeEnum(imp?.binding?.kind) === "advisory").length;
  if (imperatives.length > 0 && advisoryCount / imperatives.length >= 0.5) {
    warnings.push(issue("imperative_advisory_majority", "intent_contract", "At least half of imperatives are advisory bindings.", "warning"));
  }

  for (const addition of asArray(intentContract?.scope_additions)) {
    const id = asString(addition?.id || addition?.source) || "scope_addition";
    const source = asString(addition?.source);
    const matched = (source && imperativeSources.has(source)) || imperativeIds.has(id);
    const deferred = asString(addition?.decision_ref || addition?.deferral_decision_ref);
    if (!matched && !deferred) {
      issues.push(issue("scope_addition_unbound", id, `Scope addition ${id} is not bound or deferred.`));
    }
  }

  return { issues, warnings };
}

function phase3Required(intentContract = {}, operatorLedger = {}) {
  return intentContract?.ive_phase3_required === true ||
    operatorLedger?.ive_phase3_required === true ||
    asArray(operatorLedger?.operators).length > 0 ||
    asArray(intentContract?.imperatives).length > 0 ||
    asArray(intentContract?.extracted_imperatives).length > 0 ||
    asArray(intentContract?.scope_additions).length > 0;
}

function summarizeStatus(errors, warnings, required) {
  if (!required) return "NOT_APPLICABLE";
  if (errors.length > 0) return "FAIL";
  if (warnings.length > 0) return "WARN";
  return "PASS";
}

function evaluateIveIdeation({
  storyRegistry = {},
  intentContract = {},
  operatorLedger = {},
  acceptanceCriteria = [],
  epics = [],
  northStarMetrics = [],
  extractedImperatives = [],
  planShape = "",
  triagePath = "",
} = {}) {
  const registryInfo = normalizeStoryRegistry(storyRegistry);
  const required = phase3Required(intentContract, operatorLedger);
  const anchorIssues = required ? validateAnchorContainment(registryInfo) : [];
  const operatorResult = required
    ? validateOperators(operatorLedger, { planShape, triagePath, northStarMetrics })
    : { issues: [], suppressed: false, suppressedOperators: [] };
  const intentResult = required
    ? validateIntentContract(intentContract, registryInfo, operatorLedger, {
        acceptanceCriteria,
        epics,
        extractedImperatives,
      })
    : { issues: [], warnings: [] };

  const errors = [...anchorIssues, ...operatorResult.issues, ...intentResult.issues];
  const warnings = [...intentResult.warnings];

  return {
    version: 1,
    required,
    status: summarizeStatus(errors, warnings, required),
    anchor_count: registryInfo.anchors.length,
    imperative_count: asArray(intentContract?.imperatives).length,
    operator_count: asArray(operatorLedger?.operators).length,
    suppressed: operatorResult.suppressed,
    suppressed_operators: operatorResult.suppressedOperators,
    issues: errors,
    warnings,
  };
}

function loadIveIdeationInputs({ cwd = process.cwd(), planDir = null } = {}) {
  return {
    storyRegistry: readJson(join(cwd, "reports", "user_story_audit", "story_registry.json")) || {},
    intentContract: planDir ? (readJson(join(planDir, "intent_contract.json")) || {}) : {},
    operatorLedger: planDir ? (readJson(join(planDir, "operator_ledger.json")) || {}) : {},
  };
}

function factsForIssue(issueRow) {
  const subject = sanitizeStrictId(issueRow.subject);
  const facts = [`ive_ideation_issue(${sanitizeEnumAtom(issueRow.code)}, ${subject}).`];
  if (issueRow.code === "anchor_ref_not_in_story") facts.push(`anchor_ref_not_in_story(${subject}).`);
  if (issueRow.code === "imperative_unbound") facts.push(`imperative_unbound(${subject}).`);
  if (issueRow.code === "imperative_missing_from_contract") facts.push(`imperative_missing_from_contract(${subject}).`);
  if (issueRow.code === "scope_addition_unbound") facts.push(`scope_addition_unbound(${subject}).`);
  if (issueRow.code === "pre_mortem_risk_unaddressed") facts.push(`pre_mortem_risk_unaddressed(${subject}).`);
  return facts;
}

function compileIveIdeationFacts({ cwd = process.cwd(), planDir = null, inputs = null } = {}) {
  const loaded = inputs || loadIveIdeationInputs({ cwd, planDir });
  const report = evaluateIveIdeation(loaded);
  const facts = [
    `ive_phase3_required(${report.required ? "true" : "false"}).`,
    `ive_ideation_status(${sanitizeEnumAtom(report.status)}).`,
    `ive_ideation_anchor_count(${Number(report.anchor_count || 0)}).`,
    `ive_ideation_imperative_count(${Number(report.imperative_count || 0)}).`,
    `ive_ideation_operator_count(${Number(report.operator_count || 0)}).`,
  ];

  for (const operator of report.suppressed_operators || []) {
    facts.push(`operator_suppressed_by_triage(${sanitizeEnumAtom(operator)}).`);
  }
  for (const row of report.issues || []) facts.push(...factsForIssue(row));
  for (const row of report.warnings || []) {
    facts.push(`ive_ideation_warning(${sanitizeEnumAtom(row.code)}, ${sanitizeStrictId(row.subject)}).`);
  }
  return { report, facts };
}

export {
  REQUIRED_OPERATORS,
  VALID_BINDING_KINDS,
  compileIveIdeationFacts,
  evaluateIveIdeation,
  loadIveIdeationInputs,
  normalizeStoryRegistry,
  stripLineSuffix,
  validateAnchorContainment,
};
