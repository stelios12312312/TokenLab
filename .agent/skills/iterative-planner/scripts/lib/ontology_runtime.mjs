import { basename, join } from "path";
import { existsSync } from "fs";

import { renderOntologyProlog, resolveOntologyDocuments } from "./ontology_fact_builder.mjs";
import { getOntologyCompiledFactPath } from "./ontology_schema.mjs";
import { collectIssueHistoryFactBundle } from "./issue_history_facts.mjs";
import { createSession } from "./prolog.mjs";

function mapEntries(value) {
  return Object.entries(value || {});
}

function buildProofWeightTypeRecords(documents) {
  return mapEntries(documents.proof_weights?.proof_types).map(([id, record]) => ({
    id,
    ...record,
  }));
}

function buildProofWeightRiskLevelRecords(documents) {
  return mapEntries(documents.proof_weights?.risk_levels).map(([risk_level, record]) => ({
    risk_level,
    ...record,
  }));
}

function buildProofWeightDomainDefaultRecords(documents) {
  return mapEntries(documents.proof_weights?.domain_defaults).map(([domain, risk_level]) => ({
    domain,
    risk_level,
  }));
}

const FACT_ENTITY_CONFIG = Object.freeze({
  module: { entity_class: "code", collection: "modules", id_fields: ["id"] },
  file: { entity_class: "code", collection: "files", id_fields: ["path"] },
  class: { entity_class: "code", collection: "classes", id_fields: ["name", "file"] },
  function: { entity_class: "code", collection: "functions", id_fields: ["name", "file"] },
  file_dependency: { entity_class: "code", collection: "file_dependencies", id_fields: ["source", "target"] },
  file_depends_on: { entity_class: "code", collection: "file_dependencies", id_fields: ["source", "target"] },
  domain: { entity_class: "specification", collection: "domains", id_fields: ["name"] },
  story: { entity_class: "specification", collection: "stories", id_fields: ["id"] },
  plan: { entity_class: "specification", collection: "plans", id_fields: ["id"] },
  criterion: { entity_class: "verification", collection: "criteria", id_fields: ["id", "plan_id"] },
  verification_criterion: { entity_class: "verification", collection: "criteria", id_fields: ["id", "plan_id"] },
  test: { entity_class: "verification", collection: "tests", id_fields: ["name"] },
  artifact: { entity_class: "verification", collection: "artifacts", id_fields: ["path"] },
  evidence_artifact: { entity_class: "verification", collection: "artifacts", id_fields: ["path"] },
  test_run: { entity_class: "verification", collection: "test_runs", id_fields: ["id"] },
  coverage_report: { entity_class: "verification", collection: "coverage_reports", id_fields: ["id", "file"] },
  mistake: { entity_class: "process", collection: "mistakes", id_fields: ["id"] },
  pattern: { entity_class: "process", collection: "patterns", id_fields: ["id"] },
  gotcha: { entity_class: "process", collection: "gotchas", id_fields: ["id"] },
  retro: { entity_class: "process", collection: "retros", id_fields: ["id"] },
  adr: { entity_class: "process", collection: "adrs", id_fields: ["id"] },
  workflow: { entity_class: "process", collection: "workflows", id_fields: ["name"] },
  mirror_reader: { entity_class: "process", collection: "mirror_readers", id_fields: ["reader", "artifact"] },
  mirror_reader_of: { entity_class: "process", collection: "mirror_readers", id_fields: ["reader", "artifact"] },
  edge_case: { entity_class: "process", collection: "edge_cases", id_fields: ["domain", "label"] },
  invariant: { entity_class: "process", collection: "invariants", id_fields: ["id"] },
  proof_weight: { entity_class: "proof_weights", id_fields: ["id"], records_from: buildProofWeightTypeRecords },
  proof_weight_type: { entity_class: "proof_weights", id_fields: ["id"], records_from: buildProofWeightTypeRecords },
  proof_weight_risk_level: { entity_class: "proof_weights", id_fields: ["risk_level"], records_from: buildProofWeightRiskLevelRecords },
  proof_weight_domain_default: { entity_class: "proof_weights", id_fields: ["domain"], records_from: buildProofWeightDomainDefaultRecords },
  convention: { entity_class: "conventions", collection: "conventions", id_fields: ["id"] },
});

const CANONICAL_PLAN_ARTIFACTS = new Set([
  "plan.md",
  "progress.md",
  "verification.md",
  "findings.md",
  "red_team_notes.md",
  "state.json",
]);
const COMMON_REFERENCE_ROOTS = Object.freeze([
  ".agent/skills/iterative-planner/scripts",
  ".agent/skills/iterative-planner/scripts/lib",
  ".agent/skills/iterative-planner/tests",
  ".agent/skills/knowledge-steward/scripts",
  ".agent/skills/knowledge-steward/tests",
  ".agent/skills/planner-mcp/tests",
  ".agent/skills/story-verification/tests",
]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVerificationIdentity(value) {
  return normalizeString(value).replace(/\s+/g, " ").toUpperCase();
}

function normalizeQueryText(queryText) {
  return normalizeString(queryText).replace(/\.\s*$/, "");
}

function normalizeEntityName(entity) {
  const normalized = normalizeString(entity).toLowerCase();
  return normalized || null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function identifierForRecord(record, idFields) {
  const values = [];
  for (const field of idFields || []) {
    const raw = record?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    values.push(String(raw));
  }
  return values.join(" :: ");
}

function sortRecords(records, idFields) {
  return [...records].sort((left, right) =>
    identifierForRecord(left, idFields).localeCompare(identifierForRecord(right, idFields))
  );
}

function domainMatches(record, entityName, domain) {
  if (!domain) return true;
  const normalizedDomain = normalizeString(domain).toLowerCase();
  if (!normalizedDomain) return true;

  if (entityName === "story") return normalizeString(record?.domain).toLowerCase() === normalizedDomain;
  if (entityName === "domain") return normalizeString(record?.name).toLowerCase() === normalizedDomain;
  if (entityName === "mistake" || entityName === "gotcha" || entityName === "edge_case") {
    return normalizeString(record?.domain).toLowerCase() === normalizedDomain;
  }
  if (entityName === "convention") {
    return normalizeString(record?.domain).toLowerCase() === normalizedDomain;
  }
  if (entityName === "retro") {
    return (Array.isArray(record?.domain_tags) ? record.domain_tags : [])
      .some((entry) => normalizeString(entry).toLowerCase() === normalizedDomain);
  }
  if (entityName === "proof_weight_domain_default") {
    return normalizeString(record?.domain).toLowerCase() === normalizedDomain;
  }
  return true;
}

function buildKnownFileRefs(cwd, documents) {
  const filePaths = new Set((documents.code?.files || []).map((record) => record.path).filter(Boolean));
  const fileBasenames = new Set([...filePaths].map((path) => basename(path)));
  return { filePaths, fileBasenames, cwd };
}

function referenceLooksResolvable(reference, { cwd, filePaths, fileBasenames, artifactPaths }) {
  const value = normalizeString(reference);
  if (!value) return false;
  if (artifactPaths.has(value) || filePaths.has(value) || fileBasenames.has(value)) return true;
  if (CANONICAL_PLAN_ARTIFACTS.has(value)) return true;
  if (existsSync(join(cwd, value))) return true;
  for (const root of COMMON_REFERENCE_ROOTS) {
    if (existsSync(join(cwd, root, value))) return true;
  }
  if (value.includes("*")) {
    const prefix = value.split("*")[0].replace(/\/+$/, "");
    if (prefix && existsSync(join(cwd, prefix))) return true;
    const suffix = basename(value);
    if (CANONICAL_PLAN_ARTIFACTS.has(suffix) || fileBasenames.has(suffix)) return true;
  }
  return false;
}

export function loadOntologyRuntime({ cwd = process.cwd() } = {}) {
  const compiledPath = getOntologyCompiledFactPath(cwd);
  const resolved = resolveOntologyDocuments({ cwd, induce: false });

  if (!resolved.ok) {
    return {
      ok: false,
      cwd,
      compiled_path: compiledPath,
      compiled_facts_present: existsSync(compiledPath),
      documents: null,
      facts_text: "",
      session: null,
      counts: resolved.counts || null,
      warnings: resolved.warnings || [],
      issues: resolved.issues || ["ontology documents failed validation"],
    };
  }

  const factsText = renderOntologyProlog(resolved.documents);
  const session = createSession();
  session.consult(factsText);
  const issueHistory = collectIssueHistoryFactBundle({ cwd });
  if (issueHistory.facts.length > 0) {
    session.consult(issueHistory.facts.join("\n"));
  }

  return {
    ok: true,
    cwd,
    compiled_path: compiledPath,
    compiled_facts_present: existsSync(compiledPath),
    documents: resolved.documents,
    facts_text: factsText,
    session,
    counts: resolved.counts || null,
    issue_history: issueHistory.meta,
    warnings: [
      ...(resolved.warnings || []),
      ...(issueHistory.meta.invalid_caches > 0 ? [`${issueHistory.meta.invalid_caches} invalid issue-history cache(s) skipped`] : []),
    ],
    issues: [],
  };
}

export function runOntologyQuery({ cwd = process.cwd(), queryText }) {
  const runtime = loadOntologyRuntime({ cwd });
  const normalizedQuery = normalizeQueryText(queryText);

  if (!runtime.ok) {
    return {
      ok: false,
      command: "query",
      cwd,
      query: normalizedQuery,
      solution_count: 0,
      solutions: [],
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      issue_history: runtime.issue_history || null,
      warnings: runtime.warnings,
      issues: runtime.issues,
    };
  }

  if (!normalizedQuery) {
    return {
      ok: false,
      command: "query",
      cwd,
      query: "",
      solution_count: 0,
      solutions: [],
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      warnings: runtime.warnings,
      issues: ["query text is required"],
    };
  }

  try {
    const solutions = runtime.session.queryAll(normalizedQuery);
    return {
      ok: true,
      command: "query",
      cwd,
      query: normalizedQuery,
      solution_count: solutions.length,
      solutions,
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      issue_history: runtime.issue_history || null,
      warnings: runtime.warnings,
      issues: [],
    };
  } catch (error) {
    return {
      ok: false,
      command: "query",
      cwd,
      query: normalizedQuery,
      solution_count: 0,
      solutions: [],
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      issue_history: runtime.issue_history || null,
      warnings: runtime.warnings,
      issues: [error.message || "query failed"],
    };
  }
}

export function listOntologyFacts({ cwd = process.cwd(), entity, domain = null } = {}) {
  const runtime = loadOntologyRuntime({ cwd });
  const normalizedEntity = normalizeEntityName(entity);

  if (!runtime.ok) {
    return {
      ok: false,
      command: "facts",
      cwd,
      entity: normalizedEntity,
      domain,
      count: 0,
      records: [],
      available_entities: Object.keys(FACT_ENTITY_CONFIG).sort(),
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      warnings: runtime.warnings,
      issues: runtime.issues,
    };
  }

  const config = normalizedEntity ? FACT_ENTITY_CONFIG[normalizedEntity] : null;
  if (!config) {
    return {
      ok: false,
      command: "facts",
      cwd,
      entity: normalizedEntity,
      domain,
      count: 0,
      records: [],
      available_entities: Object.keys(FACT_ENTITY_CONFIG).sort(),
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      warnings: runtime.warnings,
      issues: ["--entity is required and must match a supported ontology entity type"],
    };
  }

  const collection = typeof config.records_from === "function"
    ? config.records_from(runtime.documents || {})
    : (runtime.documents?.[config.entity_class]?.[config.collection] || []);
  const records = sortRecords(
    collection.filter((record) => domainMatches(record, normalizedEntity, domain)),
    config.id_fields
  );

  return {
    ok: true,
    command: "facts",
    cwd,
    entity: normalizedEntity,
    domain: normalizeString(domain) || null,
    count: records.length,
    records,
    id_fields: config.id_fields,
    compiled_path: runtime.compiled_path,
    compiled_facts_present: runtime.compiled_facts_present,
    warnings: runtime.warnings,
    issues: [],
  };
}

export function validateOntologyGraph({ cwd = process.cwd() } = {}) {
  const runtime = loadOntologyRuntime({ cwd });

  if (!runtime.ok) {
    return {
      ok: false,
      command: "validate",
      cwd,
      compiled_path: runtime.compiled_path,
      compiled_facts_present: runtime.compiled_facts_present,
      warnings: runtime.warnings,
      schema_issues: runtime.issues,
      orphan_stories: [],
      broken_story_domains: [],
      dangling_plan_stories: [],
      dangling_story_criteria: [],
      missing_test_refs: [],
      missing_artifact_refs: [],
      dangling_test_criteria: [],
      dangling_artifact_criteria: [],
      dangling_test_run_tests: [],
      dangling_retro_mistakes: [],
      broken_mirror_reader: [],
      duplicate_verification_criteria: [],
      issues: runtime.issues,
      issue_count: runtime.issues.length,
    };
  }

  const documents = runtime.documents;
  const storyIds = new Set((documents.specification?.stories || []).map((record) => record.id).filter(Boolean));
  const domainNames = new Set((documents.specification?.domains || []).map((record) => record.name).filter(Boolean));
  const storyCriterionIds = new Set(
    (documents.specification?.stories || [])
      .flatMap((story) => Array.isArray(story.acceptance_criteria) ? story.acceptance_criteria : [])
      .map((criterion) => criterion.id)
      .filter(Boolean)
  );
  const storyCriterionOwners = new Map();
  for (const story of documents.specification?.stories || []) {
    for (const criterion of Array.isArray(story.acceptance_criteria) ? story.acceptance_criteria : []) {
      if (!criterion?.id) continue;
      const owners = storyCriterionOwners.get(criterion.id) || new Set();
      owners.add(story.id);
      storyCriterionOwners.set(criterion.id, owners);
    }
  }
  const planStoryIds = new Map(
    (documents.specification?.plans || []).map((record) => [
      record.id,
      new Set(uniqueStrings(record.story_ids || [])),
    ])
  );
  const testNames = new Set((documents.verification?.tests || []).map((record) => record.name).filter(Boolean));
  const artifactPaths = new Set((documents.verification?.artifacts || []).map((record) => record.path).filter(Boolean));
  const { filePaths, fileBasenames } = buildKnownFileRefs(cwd, documents);

  const issues = {
    schema_issues: [],
    orphan_stories: [],
    broken_story_domains: [],
    dangling_plan_stories: [],
    dangling_story_criteria: [],
    missing_test_refs: [],
    missing_artifact_refs: [],
    dangling_test_criteria: [],
    dangling_artifact_criteria: [],
    dangling_test_run_tests: [],
    dangling_retro_mistakes: [],
    broken_mirror_reader: [],
    duplicate_verification_criteria: [],
  };

  for (const story of documents.specification?.stories || []) {
    if (story.domain && !domainNames.has(story.domain)) {
      issues.broken_story_domains.push(`${story.id}: domain '${story.domain}' is not declared in specification.domains`);
    }
  }

  for (const plan of documents.specification?.plans || []) {
    for (const storyId of uniqueStrings(plan.story_ids || [])) {
      if (!storyIds.has(storyId)) {
        issues.dangling_plan_stories.push(`${plan.id}: references missing story '${storyId}'`);
      }
    }
  }

  for (const [criterionId, owners] of storyCriterionOwners.entries()) {
    if (owners.size > 1) {
      issues.dangling_story_criteria.push(
        `story criterion '${criterionId}' is declared by multiple stories: ${[...owners].sort().join(", ")}`
      );
    }
  }

  const verificationCriterionIdentities = new Map();
  for (const [index, criterion] of (documents.verification?.criteria || []).entries()) {
    const normalizedPlanId = normalizeVerificationIdentity(criterion?.plan_id);
    const normalizedCriterionId = normalizeVerificationIdentity(criterion?.id);
    if (!normalizedPlanId || !normalizedCriterionId) continue;
    const identityKey = `${normalizedPlanId}:${normalizedCriterionId}`;
    const first = verificationCriterionIdentities.get(identityKey);
    if (first) {
      issues.duplicate_verification_criteria.push(
        `duplicate verification criterion identity ${first.plan_id}:${normalizedCriterionId} (verification.criteria[${first.index}] and verification.criteria[${index}])`
      );
      continue;
    }
    verificationCriterionIdentities.set(identityKey, {
      index,
      plan_id: normalizeString(criterion.plan_id),
    });
  }

  for (const criterion of documents.verification?.criteria || []) {
    const criterionLabel = `${criterion.plan_id}:${criterion.id}`;
    const addressedStories = planStoryIds.get(criterion.plan_id) || new Set();
    if (criterion.story_id) {
      if (!storyIds.has(criterion.story_id)) {
        issues.dangling_story_criteria.push(
          `${criterionLabel}: story_id '${criterion.story_id}' is not declared`
        );
      } else if (!addressedStories.has(criterion.story_id)) {
        issues.dangling_story_criteria.push(
          `${criterionLabel}: story_id '${criterion.story_id}' is not addressed by plan '${criterion.plan_id}'`
        );
      }
    }
    if (criterion.story_criterion_id) {
      const owners = storyCriterionOwners.get(criterion.story_criterion_id);
      if (!owners || owners.size === 0) {
        issues.dangling_story_criteria.push(
          `${criterionLabel}: story criterion '${criterion.story_criterion_id}' is not declared`
        );
      } else if (!criterion.story_id) {
        issues.dangling_story_criteria.push(
          `${criterionLabel}: story criterion '${criterion.story_criterion_id}' requires an exact story_id owner`
        );
      } else {
        if (!owners.has(criterion.story_id)) {
          issues.dangling_story_criteria.push(
            `${criterionLabel}: story criterion '${criterion.story_criterion_id}' does not belong to story_id '${criterion.story_id}'`
          );
        }
      }
    }
    for (const testRef of uniqueStrings(criterion.test_refs || [])) {
      if (!testNames.has(testRef)) {
        issues.missing_test_refs.push(`${criterionLabel}: test_ref '${testRef}' does not resolve to verification.tests`);
      }
    }
    for (const artifactRef of uniqueStrings(criterion.artifact_refs || [])) {
      if (!artifactPaths.has(artifactRef)) {
        issues.missing_artifact_refs.push(
          `${criterionLabel}: artifact_ref '${artifactRef}' does not resolve to verification.artifacts`
        );
      }
    }
  }

  for (const testRecord of documents.verification?.tests || []) {
    for (const criterionId of uniqueStrings(testRecord.criterion_ids || [])) {
      if (!storyCriterionIds.has(criterionId)) {
        issues.dangling_test_criteria.push(
          `${testRecord.name}: criterion_id '${criterionId}' does not resolve to a declared story acceptance criterion; plan-local criteria must use verification.criteria[].test_refs`
        );
      }
    }
  }

  for (const artifactRecord of documents.verification?.artifacts || []) {
    for (const criterionId of uniqueStrings(artifactRecord.criterion_ids || [])) {
      if (!storyCriterionIds.has(criterionId)) {
        issues.dangling_artifact_criteria.push(
          `${artifactRecord.path}: criterion_id '${criterionId}' does not resolve to a declared story acceptance criterion; plan-local criteria must use verification.criteria[].artifact_refs`
        );
      }
    }
  }

  for (const runRecord of documents.verification?.test_runs || []) {
    for (const resultRecord of runRecord.results || []) {
      if (!testNames.has(resultRecord.test_name)) {
        issues.dangling_test_run_tests.push(
          `${runRecord.id}: test '${resultRecord.test_name}' does not resolve to verification.tests`
        );
      }
    }
  }

  for (const mirrorRecord of documents.process?.mirror_readers || []) {
    const readerOk = referenceLooksResolvable(mirrorRecord.reader, {
      cwd,
      filePaths,
      fileBasenames,
      artifactPaths,
    });
    const artifactOk = referenceLooksResolvable(mirrorRecord.artifact, {
      cwd,
      filePaths,
      fileBasenames,
      artifactPaths,
    });
    if (!readerOk || !artifactOk) {
      const missingParts = [];
      if (!readerOk) missingParts.push(`reader '${mirrorRecord.reader}'`);
      if (!artifactOk) missingParts.push(`artifact '${mirrorRecord.artifact}'`);
      issues.broken_mirror_reader.push(`mirror_reader_of(${missingParts.join(", ")})`);
    }
  }

  const flatIssues = Object.values(issues).flat();

  return {
    ok: flatIssues.length === 0,
    command: "validate",
    cwd,
    compiled_path: runtime.compiled_path,
    compiled_facts_present: runtime.compiled_facts_present,
    warnings: runtime.warnings,
    ...issues,
    issues: flatIssues,
    issue_count: flatIssues.length,
  };
}
