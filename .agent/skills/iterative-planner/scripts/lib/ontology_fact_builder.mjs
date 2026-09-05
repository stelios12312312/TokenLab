import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  ONTOLOGY_ENTITY_CLASSES,
  ONTOLOGY_VERSION,
  getOntologyCompiledFactPath,
  getOntologyFactPath,
  loadOntologyDocuments,
  renderOntologyDocument,
} from "./ontology_schema.mjs";
import { sanitizeAtom, sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";
import { gitRevision, induceOntologyDocuments, repositorySourceDigest } from "../ontology_inducer.mjs";

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim());
}

function documentRootsFromLoadResult(loadResult) {
  const documents = {};
  for (const entry of loadResult.documents || []) {
    if (!entry?.document || !entry.entity_class) continue;
    documents[entry.entity_class] = entry.document[entry.entity_class];
  }
  return documents;
}

function stableDocumentString(document) {
  return JSON.stringify(document, null, 2);
}

function readPlannerVersion(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, ".agent/skills/iterative-planner/config/version.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export function buildAuthorityReceipt({ cwd, documents, facts = null }) {
  const sources = ONTOLOGY_ENTITY_CLASSES.map((entityClass) => {
    const path = getOntologyFactPath(entityClass, cwd);
    const content = renderOntologyDocument({ [entityClass]: documents[entityClass] });
    return {
      entity_class: entityClass,
      path: `.agent/ontology/facts/${entityClass}.yaml`,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      modified_at: existsSync(path) ? statSync(path).mtime.toISOString() : null,
    };
  });
  const sourceDigest = `sha256:${createHash("sha256")
    .update(sources.map((source) => `${source.path}\0${source.sha256}`).join("\n"))
    .digest("hex")}`;
  const generatedAt = sources.map((source) => source.modified_at).filter(Boolean).sort().at(-1) || null;
  const compiledPath = getOntologyCompiledFactPath(cwd);
  const persisted = existsSync(compiledPath) ? readFileSync(compiledPath, "utf-8") : null;
  const projectionStatus = persisted === null ? "missing" : (facts === null ? "unchecked" : persisted === facts ? "current" : "stale_or_tampered");
  return {
    authority: "canonical_yaml",
    source_digest: sourceDigest,
    schema_version: ONTOLOGY_VERSION,
    engine_version: readPlannerVersion(cwd),
    generated_at: generatedAt,
    provenance: "project_owned_canonical_yaml",
    sources,
    projections: {
      canonical_yaml: { role: "authoritative", status: "current" },
      compiled_prolog: { role: "derived", status: projectionStatus, path: ".agent/ontology/facts.pl" },
      runtime_overlay: { role: "derived_ephemeral", status: "session_scoped" },
      ttl_export: { role: "export_only", status: "non_authoritative" },
    },
  };
}

function compareDocuments(left, right) {
  return stableDocumentString(left) === stableDocumentString(right);
}

const COLLECTION_ID_FIELDS = Object.freeze({
  code: { modules: ["id"], files: ["path"], classes: ["file", "name"], functions: ["file", "name"], file_dependencies: ["source", "target"] },
  specification: { domains: ["name"], stories: ["id"], plans: ["id"] },
  verification: { criteria: ["plan_id", "id"], tests: ["name"], artifacts: ["path"], test_runs: ["id"], coverage_reports: ["id", "file"] },
  process: { mistakes: ["id"], patterns: ["id"], gotchas: ["id"], retros: ["id"], adrs: ["id"], workflows: ["name"], mirror_readers: ["reader", "artifact"], edge_cases: ["domain", "label"], invariants: ["id"] },
});

function recordIdentity(record, fields) {
  return fields.map((field) => String(record?.[field] || "")).join("\0");
}

function loadOntologyExclusions(cwd) {
  const path = join(cwd, ".agent/ontology/exclusions.json");
  if (!existsSync(path)) return { ok: true, path, exclusions: {} };
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document.schema_version !== 1 || !document.exclusions || typeof document.exclusions !== "object" || Array.isArray(document.exclusions)) {
      return { ok: false, path, exclusions: {}, issues: ["ontology exclusions require schema_version=1 and an exclusions object"] };
    }
    for (const [collection, identities] of Object.entries(document.exclusions)) {
      if (!Array.isArray(identities) || identities.some((identity) => typeof identity !== "string" || !identity.trim())) {
        return { ok: false, path, exclusions: {}, issues: [`ontology exclusion '${collection}' must be an array of non-empty identities`] };
      }
    }
    return { ok: true, path, exclusions: document.exclusions };
  } catch (error) {
    return { ok: false, path, exclusions: {}, issues: [`ontology exclusions unreadable: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function mergeProjectOwnedDocuments(current, induced, exclusions = {}) {
  const merged = { ...induced };
  for (const [entityClass, collections] of Object.entries(COLLECTION_ID_FIELDS)) {
    merged[entityClass] = { ...induced[entityClass] };
    for (const [collection, fields] of Object.entries(collections)) {
      const excluded = new Set(exclusions[`${entityClass}.${collection}`] || []);
      const records = new Map();
      for (const record of current?.[entityClass]?.[collection] || []) records.set(recordIdentity(record, fields), record);
      for (const record of induced?.[entityClass]?.[collection] || []) records.set(recordIdentity(record, fields), record);
      for (const identity of excluded) records.delete(identity);
      merged[entityClass][collection] = [...records.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, record]) => record);
    }
  }
  return merged;
}

function emitFact(lines, seen, predicate, args) {
  const key = `${predicate}|${args.join("|")}`;
  if (seen.has(key)) return;
  seen.add(key);
  lines.push(`${predicate}(${args.join(", ")}).`);
}

function quotedId(value) {
  return sanitizeStrictId(value);
}

function quotedText(value) {
  return sanitizeAtom(value);
}

function quotedEnum(value) {
  return sanitizeEnumAtom(firstNonEmptyString(value, "unknown"));
}

function quotedPattern(value) {
  const clean = String(firstNonEmptyString(value, "unknown"))
    .replace(/[^a-zA-Z0-9_./:@*?[\]{}+-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 300);
  return `'${clean || "unknown"}'`;
}

function numericOrAtom(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return String(number);
  return quotedEnum(value);
}

function scalarOrPattern(value) {
  if (typeof value === "boolean") return quotedEnum(value ? "true" : "false");
  const number = Number(value);
  if (Number.isFinite(number)) return String(number);
  return quotedPattern(value);
}

function sortBy(items, keyFn) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) =>
    String(keyFn(left)).localeCompare(String(keyFn(right)))
  );
}

function sortObjectEntries(record) {
  return Object.entries(record || {}).sort(([left], [right]) => String(left).localeCompare(String(right)));
}

function summarizeConventionsDocument(document) {
  const conventions = Array.isArray(document?.conventions) ? document.conventions : [];
  return {
    total: conventions.length,
    active: conventions.filter((record) => String(record?.status || "").trim() === "active").length,
    candidate: conventions.filter((record) => String(record?.status || "").trim() === "candidate").length,
    deprecated: conventions.filter((record) => String(record?.status || "").trim() === "deprecated").length,
  };
}

function emitConventionRequirementFacts(lines, seen, conventionId, requirement) {
  if (typeof requirement === "string" && requirement.trim()) {
    emitFact(lines, seen, "convention_requires", [quotedId(conventionId), quotedText(requirement)]);
    return;
  }
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return;

  for (const [key, rawValue] of sortObjectEntries(requirement)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      emitFact(lines, seen, "convention_requirement", [quotedId(conventionId), quotedEnum(key), scalarOrPattern(value)]);
      emitFact(lines, seen, "convention_requires", [quotedId(conventionId), quotedText(`${key}:${String(value)}`)]);
    }
  }
}

function collectDocumentCounts(documents) {
  return {
    code: {
      modules: documents.code?.modules?.length || 0,
      files: documents.code?.files?.length || 0,
      classes: documents.code?.classes?.length || 0,
      functions: documents.code?.functions?.length || 0,
      file_dependencies: documents.code?.file_dependencies?.length || 0,
    },
    specification: {
      stories: documents.specification?.stories?.length || 0,
      domains: documents.specification?.domains?.length || 0,
      plans: documents.specification?.plans?.length || 0,
    },
    verification: {
      criteria: documents.verification?.criteria?.length || 0,
      tests: documents.verification?.tests?.length || 0,
      artifacts: documents.verification?.artifacts?.length || 0,
      test_runs: documents.verification?.test_runs?.length || 0,
      coverage_reports: documents.verification?.coverage_reports?.length || 0,
    },
    process: {
      mistakes: documents.process?.mistakes?.length || 0,
      patterns: documents.process?.patterns?.length || 0,
      gotchas: documents.process?.gotchas?.length || 0,
      retros: documents.process?.retros?.length || 0,
      adrs: documents.process?.adrs?.length || 0,
      workflows: documents.process?.workflows?.length || 0,
      mirror_readers: documents.process?.mirror_readers?.length || 0,
      edge_cases: documents.process?.edge_cases?.length || 0,
      invariants: documents.process?.invariants?.length || 0,
    },
    proof_weights: {
      proof_types: Object.keys(documents.proof_weights?.proof_types || {}).length,
      modifiers: Object.values(documents.proof_weights?.proof_types || {})
        .reduce((total, record) => total + (Array.isArray(record?.modifiers) ? record.modifiers.length : 0), 0),
      risk_levels: Object.keys(documents.proof_weights?.risk_levels || {}).length,
      domain_defaults: Object.keys(documents.proof_weights?.domain_defaults || {}).length,
    },
    conventions: summarizeConventionsDocument(documents.conventions),
  };
}

function writeCanonicalOntologyDocuments({ cwd, documents, changedEntityClasses }) {
  const wrote = [];
  for (const entityClass of changedEntityClasses) {
    const filePath = getOntologyFactPath(entityClass, cwd);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, renderOntologyDocument({ [entityClass]: documents[entityClass] }));
    wrote.push(entityClass);
  }
  return wrote;
}

export function resolveOntologyDocuments({
  cwd = process.cwd(),
  induce = false,
  dryRun = false,
} = {}) {
  if (induce) {
    const induced = induceOntologyDocuments({ cwd });
    if (!induced.ok) {
      return {
        ok: false,
        cwd,
        documents: null,
        warnings: induced.warnings || [],
        issues: induced.issues || ["ontology induction failed"],
        changed_fact_documents: [],
        wrote_fact_documents: [],
        document_source: "induced",
        counts: induced.counts || null,
      };
    }

    const current = loadOntologyDocuments({ cwd, allowMissing: true });
    const currentRoots = documentRootsFromLoadResult(current);
    const exclusionPolicy = loadOntologyExclusions(cwd);
    if (!exclusionPolicy.ok) {
      return {
        ok: false,
        cwd,
        documents: null,
        warnings: induced.warnings || [],
        issues: exclusionPolicy.issues,
        changed_fact_documents: [],
        wrote_fact_documents: [],
        document_source: "induced",
        counts: induced.counts || null,
      };
    }
    const projectOwnedDocuments = mergeProjectOwnedDocuments(currentRoots, induced.documents, exclusionPolicy.exclusions);
    const changedEntityClasses = ONTOLOGY_ENTITY_CLASSES.filter((entityClass) =>
      !compareDocuments(currentRoots[entityClass] || null, projectOwnedDocuments[entityClass])
    );
    const wroteEntityClasses = dryRun
      ? []
      : writeCanonicalOntologyDocuments({
          cwd,
          documents: projectOwnedDocuments,
          changedEntityClasses,
        });

    return {
      ok: true,
      cwd,
      documents: projectOwnedDocuments,
      warnings: [
        ...(induced.warnings || []),
        ...(Object.keys(exclusionPolicy.exclusions).length ? [`Applied project-owned ontology exclusions from ${exclusionPolicy.path}`] : []),
      ],
      issues: [],
      changed_fact_documents: changedEntityClasses,
      wrote_fact_documents: wroteEntityClasses,
      document_source: "induced",
      counts: collectDocumentCounts(projectOwnedDocuments),
    };
  }

  const loaded = loadOntologyDocuments({ cwd, allowMissing: false });
  if (!loaded.ok) {
    return {
      ok: false,
      cwd,
      documents: null,
      warnings: loaded.warnings || [],
      issues: loaded.issues || ["ontology fact documents failed validation"],
      changed_fact_documents: [],
      wrote_fact_documents: [],
      document_source: "yaml",
      counts: null,
    };
  }

  const documents = documentRootsFromLoadResult(loaded);
  return {
    ok: true,
    cwd,
    documents,
    warnings: loaded.warnings || [],
    issues: [],
    changed_fact_documents: [],
    wrote_fact_documents: [],
    document_source: "yaml",
    counts: collectDocumentCounts(documents),
  };
}

export function renderOntologyProlog(documents, authorityReceipt = null, { profile = "full" } = {}) {
  const lines = [
    "% Generated by planner ontology build",
    "% Source of truth: .agent/ontology/facts/*.yaml",
    "% Do not edit manually; regenerate from YAML facts.",
    "",
    "% Code entities",
  ];
  const seen = new Set();
  if (authorityReceipt) {
    emitFact(lines, seen, "ontology_authority", [quotedEnum(authorityReceipt.authority)]);
    emitFact(lines, seen, "ontology_source_digest", [quotedText(authorityReceipt.source_digest)]);
    emitFact(lines, seen, "ontology_schema_version", [numericOrAtom(authorityReceipt.schema_version)]);
    emitFact(lines, seen, "ontology_engine_version", [quotedText(authorityReceipt.engine_version)]);
    emitFact(lines, seen, "ontology_provenance", [quotedEnum(authorityReceipt.provenance)]);
    for (const [projection, disposition] of sortObjectEntries(authorityReceipt.projections)) {
      emitFact(lines, seen, "ontology_projection_role", [quotedEnum(projection), quotedEnum(disposition.role)]);
    }
    lines.push("");
  }
  const allStories = documents.specification?.stories || [];
  const allPlans = documents.specification?.plans || [];
  const gateRelevantPlanIds = new Set(
    allPlans
      .filter((record) => !["close", "closed", "abandoned"].includes(String(record.phase || "").toLowerCase()))
      .map((record) => record.id)
  );
  const gateObservedPlans = new Set(
    (documents.verification?.test_runs || [])
      .map((record) => record.plan_id)
      .filter((planId) => planId && gateRelevantPlanIds.has(planId))
  );
  const gateStoryIds = new Set([
    ...allPlans
      .filter((record) => gateObservedPlans.has(record.id))
      .flatMap((record) => Array.isArray(record.story_ids) ? record.story_ids : []),
    ...(documents.verification?.criteria || [])
      .filter((record) => gateObservedPlans.has(record.plan_id))
      .map((record) => record.story_id)
      .filter(Boolean),
  ]);
  const projectedStories = allStories.filter((record) => profile === "full" || gateStoryIds.has(record.id));
  const projectedPlans = allPlans.filter((record) => profile === "full" || gateObservedPlans.has(record.id));
  const storyCriterionIds = new Set(
    projectedStories
      .flatMap((storyRecord) => Array.isArray(storyRecord.acceptance_criteria) ? storyRecord.acceptance_criteria : [])
      .map((criterionRecord) => criterionRecord?.id)
      .filter(Boolean)
  );

  if (profile === "full") {
  for (const moduleRecord of sortBy(documents.code?.modules, (record) => record.id)) {
    emitFact(lines, seen, "module", [quotedId(moduleRecord.id)]);
    if (moduleRecord.path) emitFact(lines, seen, "module_path", [quotedId(moduleRecord.id), quotedId(moduleRecord.path)]);
    if (moduleRecord.description) emitFact(lines, seen, "module_description", [quotedId(moduleRecord.id), quotedText(moduleRecord.description)]);
    for (const alias of sortBy(moduleRecord.aliases, (value) => value)) {
      emitFact(lines, seen, "module_alias", [quotedId(moduleRecord.id), quotedId(alias)]);
    }
  }

  for (const fileRecord of sortBy(documents.code?.files, (record) => record.path)) {
    emitFact(lines, seen, "file", [quotedId(fileRecord.path)]);
    if (fileRecord.module) emitFact(lines, seen, "file_in_module", [quotedId(fileRecord.path), quotedId(fileRecord.module)]);
    if (fileRecord.language) emitFact(lines, seen, "file_language", [quotedId(fileRecord.path), quotedEnum(fileRecord.language)]);
  }

  for (const classRecord of sortBy(documents.code?.classes, (record) => `${record.file}:${record.name}`)) {
    emitFact(lines, seen, "class", [quotedId(classRecord.name), quotedId(classRecord.file)]);
    emitFact(lines, seen, "class_in_file", [quotedId(classRecord.name), quotedId(classRecord.file)]);
  }

  for (const functionRecord of sortBy(documents.code?.functions, (record) => `${record.file}:${record.name}`)) {
    emitFact(lines, seen, "function", [quotedId(functionRecord.name), quotedId(functionRecord.file)]);
    emitFact(lines, seen, "function_in_file", [quotedId(functionRecord.name), quotedId(functionRecord.file)]);
  }

  for (const dependencyRecord of sortBy(documents.code?.file_dependencies, (record) => `${record.source}:${record.target}`)) {
    emitFact(lines, seen, "file_depends_on", [quotedId(dependencyRecord.source), quotedId(dependencyRecord.target)]);
    if (dependencyRecord.type) {
      emitFact(lines, seen, "file_dependency_type", [quotedId(dependencyRecord.source), quotedId(dependencyRecord.target), quotedEnum(dependencyRecord.type)]);
    }
  }
  }

  lines.push("", "% Specification entities");
  for (const domainRecord of sortBy(documents.specification?.domains, (record) => record.name)) {
    emitFact(lines, seen, "domain", [quotedEnum(domainRecord.name)]);
    if (domainRecord.description) emitFact(lines, seen, "domain_description", [quotedEnum(domainRecord.name), quotedText(domainRecord.description)]);
  }

  for (const storyRecord of sortBy(projectedStories, (record) => record.id)) {
    emitFact(lines, seen, "story", [quotedId(storyRecord.id)]);
    emitFact(lines, seen, "story_title", [quotedId(storyRecord.id), quotedText(storyRecord.title)]);
    emitFact(lines, seen, "story_status", [quotedId(storyRecord.id), quotedEnum(storyRecord.status)]);
    if (storyRecord.domain) emitFact(lines, seen, "story_in_domain", [quotedId(storyRecord.id), quotedEnum(storyRecord.domain)]);
    for (const criterionRecord of sortBy(storyRecord.acceptance_criteria, (record) => record.id)) {
      emitFact(lines, seen, "acceptance_criterion", [quotedId(criterionRecord.id), quotedText(criterionRecord.text)]);
      emitFact(lines, seen, "story_has_criterion", [quotedId(storyRecord.id), quotedId(criterionRecord.id)]);
    }
  }

  for (const planRecord of sortBy(projectedPlans, (record) => record.id)) {
    emitFact(lines, seen, "plan", [quotedId(planRecord.id)]);
    if (planRecord.phase) emitFact(lines, seen, "plan_phase", [quotedId(planRecord.id), quotedEnum(planRecord.phase)]);
    for (const storyId of sortBy(planRecord.story_ids, (value) => value)) {
      emitFact(lines, seen, "plan_addresses_story", [quotedId(planRecord.id), quotedId(storyId)]);
    }
  }

  lines.push("", "% Verification entities");
  const projectedTestRuns = (documents.verification?.test_runs || []).filter((record) => profile === "full" || gateObservedPlans.has(record.plan_id));
  const observedPlanIds = new Set(projectedTestRuns.map((record) => record.plan_id).filter(Boolean));
  const currentPassingTestsByPlan = new Map();
  for (const runRecord of projectedTestRuns) {
    if (runRecord.current !== true || !runRecord.plan_id) continue;
    if (!currentPassingTestsByPlan.has(runRecord.plan_id)) currentPassingTestsByPlan.set(runRecord.plan_id, new Set());
    const passingTests = currentPassingTestsByPlan.get(runRecord.plan_id);
    for (const resultRecord of runRecord.results || []) {
      if (["pass", "passed"].includes(String(resultRecord.outcome || "").toLowerCase())) passingTests.add(resultRecord.test_name);
    }
  }
  const projectedCriteria = (documents.verification?.criteria || []).filter((record) => profile === "full" || gateObservedPlans.has(record.plan_id));
  for (const criterionRecord of sortBy(projectedCriteria, (record) => `${record.plan_id}:${record.id}`)) {
    emitFact(lines, seen, "verification_criterion", [quotedId(criterionRecord.id), quotedId(criterionRecord.plan_id)]);
    if (criterionRecord.story_id) {
      emitFact(lines, seen, "plan_criterion_story", [quotedId(criterionRecord.plan_id), quotedId(criterionRecord.id), quotedId(criterionRecord.story_id)]);
      emitFact(lines, seen, "story_plan_criterion", [quotedId(criterionRecord.story_id), quotedId(criterionRecord.plan_id), quotedId(criterionRecord.id)]);
      if (observedPlanIds.has(criterionRecord.plan_id)) {
        emitFact(lines, seen, "canonical_story_observation_tracking", [quotedId(criterionRecord.story_id)]);
        emitFact(lines, seen, "canonical_criterion_observation_tracking", [quotedId(criterionRecord.story_id), quotedId(criterionRecord.id)]);
      }
      const passingTests = currentPassingTestsByPlan.get(criterionRecord.plan_id);
      if (passingTests && (criterionRecord.test_refs || []).some((testRef) => passingTests.has(testRef))) {
        emitFact(lines, seen, "canonical_story_observation_pass", [quotedId(criterionRecord.story_id)]);
        emitFact(lines, seen, "canonical_criterion_observation_pass", [quotedId(criterionRecord.story_id), quotedId(criterionRecord.id)]);
      }
    }
    if (criterionRecord.story_criterion_id) {
      emitFact(lines, seen, "plan_criterion_verifies_story_criterion", [
        quotedId(criterionRecord.plan_id),
        quotedId(criterionRecord.id),
        quotedId(criterionRecord.story_criterion_id),
      ]);
    }
    for (const testRef of sortBy(criterionRecord.test_refs, (value) => value)) {
      emitFact(lines, seen, "test_verifies_plan_criterion", [
        quotedId(testRef),
        quotedId(criterionRecord.plan_id),
        quotedId(criterionRecord.id),
      ]);
      emitFact(lines, seen, "plan_criterion_test", [quotedId(criterionRecord.plan_id), quotedId(criterionRecord.id), quotedId(testRef)]);
    }
    for (const artifactRef of sortBy(criterionRecord.artifact_refs, (value) => value)) {
      emitFact(lines, seen, "artifact_proves_plan_criterion", [
        quotedId(artifactRef),
        quotedId(criterionRecord.plan_id),
        quotedId(criterionRecord.id),
      ]);
    }
  }

  if (profile === "full") {
  for (const testRecord of sortBy(documents.verification?.tests, (record) => `${record.file}:${record.name}`)) {
    emitFact(lines, seen, "test", [quotedId(testRecord.name)]);
    emitFact(lines, seen, "test_in_file", [quotedId(testRecord.name), quotedId(testRecord.file)]);
    emitFact(lines, seen, "test_type", [quotedId(testRecord.name), quotedEnum(testRecord.type)]);
    for (const criterionId of sortBy(testRecord.criterion_ids, (value) => value)) {
      if (storyCriterionIds.has(criterionId)) {
        emitFact(lines, seen, "test_verifies_criterion", [quotedId(testRecord.name), quotedId(criterionId)]);
      }
    }
    for (const coveredFile of sortBy(testRecord.covered_files, (value) => value)) {
      emitFact(lines, seen, "test_covers_file", [quotedId(testRecord.name), quotedId(coveredFile)]);
    }
  }

  for (const artifactRecord of sortBy(documents.verification?.artifacts, (record) => record.path)) {
    emitFact(lines, seen, "evidence_artifact", [quotedId(artifactRecord.path)]);
    emitFact(lines, seen, "artifact_type", [quotedId(artifactRecord.path), quotedEnum(artifactRecord.type)]);
    for (const criterionId of sortBy(artifactRecord.criterion_ids, (value) => value)) {
      if (storyCriterionIds.has(criterionId)) {
        emitFact(lines, seen, "artifact_proves_criterion", [quotedId(artifactRecord.path), quotedId(criterionId)]);
      }
    }
  }
  }

  for (const testRunRecord of sortBy(projectedTestRuns, (record) => record.id)) {
    emitFact(lines, seen, "test_run", [quotedId(testRunRecord.id)]);
    if (testRunRecord.plan_id) emitFact(lines, seen, "test_run_plan", [quotedId(testRunRecord.id), quotedId(testRunRecord.plan_id)]);
    if (testRunRecord.plan_id) emitFact(lines, seen, "plan_observed_run", [quotedId(testRunRecord.plan_id), quotedId(testRunRecord.id)]);
    if (profile === "full") {
    if (testRunRecord.generated_at) emitFact(lines, seen, "test_run_generated_at", [quotedId(testRunRecord.id), quotedText(testRunRecord.generated_at)]);
    if (testRunRecord.command) emitFact(lines, seen, "test_run_command", [quotedId(testRunRecord.id), quotedText(testRunRecord.command)]);
    if (testRunRecord.revision) emitFact(lines, seen, "test_run_revision", [quotedId(testRunRecord.id), quotedText(testRunRecord.revision)]);
    if (testRunRecord.source_digest) emitFact(lines, seen, "test_run_source_digest", [quotedId(testRunRecord.id), quotedText(testRunRecord.source_digest)]);
    if (testRunRecord.tool_version) emitFact(lines, seen, "test_run_tool_version", [quotedId(testRunRecord.id), quotedText(testRunRecord.tool_version)]);
    if (testRunRecord.provenance) emitFact(lines, seen, "test_run_provenance", [quotedId(testRunRecord.id), quotedEnum(testRunRecord.provenance)]);
    }
    if (testRunRecord.current !== undefined) emitFact(lines, seen, "test_run_current", [quotedId(testRunRecord.id), quotedEnum(testRunRecord.current ? "true" : "false")]);
    if (profile === "full" || testRunRecord.current === true) {
    for (const resultRecord of sortBy(testRunRecord.results, (record) => record.test_name)) {
      emitFact(lines, seen, "test_run_result", [quotedId(testRunRecord.id), quotedId(resultRecord.test_name), quotedEnum(resultRecord.outcome)]);
    }
    }
  }

  if (profile === "full") {
  for (const coverageRecord of sortBy(documents.verification?.coverage_reports, (record) => record.id)) {
    emitFact(lines, seen, "coverage_report", [
      quotedId(coverageRecord.id),
      quotedId(coverageRecord.file),
      numericOrAtom(coverageRecord.line_pct),
      numericOrAtom(coverageRecord.branch_pct),
    ]);
    if (coverageRecord.generated_at) emitFact(lines, seen, "coverage_generated_at", [quotedId(coverageRecord.id), quotedText(coverageRecord.generated_at)]);
    if (coverageRecord.revision) emitFact(lines, seen, "coverage_revision", [quotedId(coverageRecord.id), quotedText(coverageRecord.revision)]);
    if (coverageRecord.source_digest) emitFact(lines, seen, "coverage_source_digest", [quotedId(coverageRecord.id), quotedText(coverageRecord.source_digest)]);
    if (coverageRecord.tool_version) emitFact(lines, seen, "coverage_tool_version", [quotedId(coverageRecord.id), quotedText(coverageRecord.tool_version)]);
    if (coverageRecord.provenance) emitFact(lines, seen, "coverage_provenance", [quotedId(coverageRecord.id), quotedEnum(coverageRecord.provenance)]);
    if (coverageRecord.current !== undefined) emitFact(lines, seen, "coverage_current", [quotedId(coverageRecord.id), quotedEnum(coverageRecord.current ? "true" : "false")]);
  }
  }

  lines.push("", "% Proof weight entities");
  for (const [proofTypeId, proofTypeRecord] of sortObjectEntries(documents.proof_weights?.proof_types)) {
    emitFact(lines, seen, "proof_weight_type", [quotedId(proofTypeId)]);
    if (proofTypeRecord.label) emitFact(lines, seen, "proof_weight_label", [quotedId(proofTypeId), quotedText(proofTypeRecord.label)]);
    if (proofTypeRecord.category) emitFact(lines, seen, "proof_weight_category", [quotedId(proofTypeId), quotedEnum(proofTypeRecord.category)]);
    if (proofTypeRecord.base_weight !== undefined) emitFact(lines, seen, "proof_weight_base", [quotedId(proofTypeId), numericOrAtom(proofTypeRecord.base_weight)]);
    if (proofTypeRecord.description) emitFact(lines, seen, "proof_weight_description", [quotedId(proofTypeId), quotedText(proofTypeRecord.description)]);
    for (const modifier of sortBy(proofTypeRecord.modifiers, (record) => record.condition)) {
      emitFact(lines, seen, "proof_weight_modifier", [quotedId(proofTypeId), quotedEnum(modifier.condition), numericOrAtom(modifier.delta)]);
    }
  }

  for (const [riskLevel, riskRecord] of sortObjectEntries(documents.proof_weights?.risk_levels)) {
    emitFact(lines, seen, "proof_weight_risk_level", [quotedEnum(riskLevel)]);
    if (riskRecord.required_weight !== undefined) emitFact(lines, seen, "proof_weight_required_weight", [quotedEnum(riskLevel), numericOrAtom(riskRecord.required_weight)]);
    if (riskRecord.description) emitFact(lines, seen, "proof_weight_risk_description", [quotedEnum(riskLevel), quotedText(riskRecord.description)]);
  }

  for (const [domain, riskLevel] of sortObjectEntries(documents.proof_weights?.domain_defaults)) {
    emitFact(lines, seen, "proof_weight_domain_default", [quotedEnum(domain), quotedEnum(riskLevel)]);
  }

  lines.push("", "% Convention entities");
  for (const conventionRecord of sortBy(documents.conventions?.conventions, (record) => record.id)) {
    emitFact(lines, seen, "convention", [quotedId(conventionRecord.id)]);
    if (conventionRecord.title) emitFact(lines, seen, "convention_title", [quotedId(conventionRecord.id), quotedText(conventionRecord.title)]);
    if (conventionRecord.description) emitFact(lines, seen, "convention_description", [quotedId(conventionRecord.id), quotedText(conventionRecord.description)]);
    if (conventionRecord.domain) emitFact(lines, seen, "convention_domain", [quotedId(conventionRecord.id), quotedEnum(conventionRecord.domain)]);
    if (conventionRecord.scope) emitFact(lines, seen, "convention_scope", [quotedId(conventionRecord.id), quotedEnum(conventionRecord.scope)]);
    if (conventionRecord.evidence_type) emitFact(lines, seen, "convention_evidence_type", [quotedId(conventionRecord.id), quotedEnum(conventionRecord.evidence_type)]);
    if (conventionRecord.status) emitFact(lines, seen, "convention_status", [quotedId(conventionRecord.id), quotedEnum(conventionRecord.status)]);
    if (conventionRecord.confidence !== undefined) emitFact(lines, seen, "convention_confidence", [quotedId(conventionRecord.id), numericOrAtom(conventionRecord.confidence)]);
    if (conventionRecord.detected_from) emitFact(lines, seen, "convention_detected_from", [quotedId(conventionRecord.id), quotedEnum(conventionRecord.detected_from)]);
    if (conventionRecord.detected_at) emitFact(lines, seen, "convention_detected_at", [quotedId(conventionRecord.id), quotedText(conventionRecord.detected_at)]);
    if (conventionRecord.detected_in_instances !== undefined) {
      emitFact(lines, seen, "convention_detected_in_instances", [quotedId(conventionRecord.id), numericOrAtom(conventionRecord.detected_in_instances)]);
    }
    if (conventionRecord.total_instances !== undefined) {
      emitFact(lines, seen, "convention_total_instances", [quotedId(conventionRecord.id), numericOrAtom(conventionRecord.total_instances)]);
    }
    for (const filePattern of sortBy(conventionRecord.applies_to?.file_patterns, (value) => value)) {
      emitFact(lines, seen, "convention_applies_to_file", [quotedId(conventionRecord.id), quotedPattern(filePattern)]);
    }
    for (const classPattern of sortBy(conventionRecord.applies_to?.class_patterns, (value) => value)) {
      emitFact(lines, seen, "convention_applies_to_class", [quotedId(conventionRecord.id), quotedPattern(classPattern)]);
    }
    for (const changeClass of sortBy(conventionRecord.applies_to?.change_classes, (value) => value)) {
      emitFact(lines, seen, "convention_applies_to_change_class", [quotedId(conventionRecord.id), quotedEnum(changeClass)]);
    }
    for (const requirement of conventionRecord.requires || []) {
      emitConventionRequirementFacts(lines, seen, conventionRecord.id, requirement);
    }
  }

  lines.push("", "% Process entities");
  for (const mistakeRecord of sortBy(documents.process?.mistakes, (record) => record.id)) {
    emitFact(lines, seen, "mistake", [quotedId(mistakeRecord.id)]);
    if (mistakeRecord.title) emitFact(lines, seen, "mistake_title", [quotedId(mistakeRecord.id), quotedText(mistakeRecord.title)]);
    if (mistakeRecord.domain) emitFact(lines, seen, "mistake_domain", [quotedId(mistakeRecord.id), quotedEnum(mistakeRecord.domain)]);
    if (mistakeRecord.frequency !== undefined) emitFact(lines, seen, "mistake_frequency", [quotedId(mistakeRecord.id), numericOrAtom(mistakeRecord.frequency)]);
  }

  for (const patternRecord of sortBy(documents.process?.patterns, (record) => record.id)) {
    emitFact(lines, seen, "pattern", [quotedId(patternRecord.id)]);
    if (patternRecord.title) emitFact(lines, seen, "pattern_title", [quotedId(patternRecord.id), quotedText(patternRecord.title)]);
    for (const appliesTo of sortBy(patternRecord.applies_to, (value) => value)) {
      emitFact(lines, seen, "pattern_applies_to", [quotedId(patternRecord.id), quotedEnum(appliesTo)]);
    }
  }

  for (const gotchaRecord of sortBy(documents.process?.gotchas, (record) => record.id)) {
    emitFact(lines, seen, "gotcha", [quotedId(gotchaRecord.id)]);
    if (gotchaRecord.title) emitFact(lines, seen, "gotcha_title", [quotedId(gotchaRecord.id), quotedText(gotchaRecord.title)]);
    if (gotchaRecord.domain) emitFact(lines, seen, "gotcha_in_domain", [quotedId(gotchaRecord.id), quotedEnum(gotchaRecord.domain)]);
  }

  for (const retroRecord of sortBy(documents.process?.retros, (record) => record.id)) {
    emitFact(lines, seen, "retro", [quotedId(retroRecord.id)]);
    if (retroRecord.title) emitFact(lines, seen, "retro_title", [quotedId(retroRecord.id), quotedText(retroRecord.title)]);
    for (const mistakeId of sortBy(retroRecord.mistake_ids, (value) => value)) {
      emitFact(lines, seen, "retro_mentions_mistake", [quotedId(retroRecord.id), quotedId(mistakeId)]);
    }
    for (const domainTag of sortBy(retroRecord.domain_tags, (value) => value)) {
      emitFact(lines, seen, "retro_affects_domain", [quotedId(retroRecord.id), quotedEnum(domainTag)]);
    }
    for (const changeClass of sortBy(retroRecord.change_classes, (value) => value)) {
      emitFact(lines, seen, "retro_change_class", [quotedId(retroRecord.id), quotedEnum(changeClass)]);
    }
    if (retroRecord.recurrence_count !== undefined) {
      emitFact(lines, seen, "retro_recurrence_count", [quotedId(retroRecord.id), numericOrAtom(retroRecord.recurrence_count)]);
    }
  }

  for (const adrRecord of sortBy(documents.process?.adrs, (record) => record.id)) {
    emitFact(lines, seen, "adr", [quotedId(adrRecord.id)]);
    if (adrRecord.title) emitFact(lines, seen, "adr_title", [quotedId(adrRecord.id), quotedText(adrRecord.title)]);
    if (adrRecord.topic) emitFact(lines, seen, "adr_decides", [quotedId(adrRecord.id), quotedText(adrRecord.topic)]);
  }

  for (const workflowRecord of sortBy(documents.process?.workflows, (record) => record.name)) {
    emitFact(lines, seen, "workflow", [quotedId(workflowRecord.name)]);
    if (workflowRecord.recipe_affinity) {
      emitFact(lines, seen, "recipe_affinity", [quotedId(workflowRecord.name), quotedEnum(workflowRecord.recipe_affinity)]);
    }
  }

  for (const mirrorRecord of sortBy(documents.process?.mirror_readers, (record) => `${record.reader}:${record.artifact}`)) {
    emitFact(lines, seen, "mirror_reader_of", [quotedId(mirrorRecord.reader), quotedId(mirrorRecord.artifact)]);
    emitFact(lines, seen, "artifact_consumed_by", [quotedId(mirrorRecord.artifact), quotedId(mirrorRecord.reader)]);
  }

  for (const edgeCaseRecord of sortBy(documents.process?.edge_cases, (record) => `${record.domain}:${record.label}`)) {
    emitFact(lines, seen, "edge_case", [quotedEnum(edgeCaseRecord.domain), quotedId(edgeCaseRecord.label)]);
    if (edgeCaseRecord.description) {
      emitFact(lines, seen, "edge_case_description", [quotedId(edgeCaseRecord.label), quotedText(edgeCaseRecord.description)]);
    }
  }

  for (const invariantRecord of sortBy(documents.process?.invariants, (record) => record.id)) {
    emitFact(lines, seen, "invariant", [quotedId(invariantRecord.id), quotedEnum(invariantRecord.agent)]);
  }

  return `${lines.join("\n")}\n`;
}

export function buildOntologyFacts({
  cwd = process.cwd(),
  induce = false,
  incremental = false,
  dryRun = false,
  projectionProfile = "full",
} = {}) {
  const resolved = resolveOntologyDocuments({ cwd, induce, dryRun });
  if (!resolved.ok) {
    return {
      ...resolved,
      facts: "",
      path: getOntologyCompiledFactPath(cwd),
      total_fact_count: 0,
      changed_generated_facts: false,
      wrote_generated_facts: false,
    };
  }

  const authoritySeed = buildAuthorityReceipt({ cwd, documents: resolved.documents });
  let projectionDocuments = resolved.documents;
  if (projectionProfile === "gate") {
    const liveRevision = gitRevision(cwd);
    const liveSourceDigest = repositorySourceDigest(cwd);
    projectionDocuments = {
      ...resolved.documents,
      verification: {
        ...resolved.documents.verification,
        test_runs: (resolved.documents.verification?.test_runs || []).map((record) => ({
          ...record,
          // Currentness is an ephemeral gate judgment. Re-evaluate it against
          // the live code tree so a source edit cannot leave persisted YAML
          // observations falsely current until the next induction.
          current: Boolean(
            record.provenance === "test_run_record" &&
            record.revision && liveRevision && record.revision === liveRevision &&
            record.source_digest && liveSourceDigest && record.source_digest === liveSourceDigest
          ),
        })),
      },
    };
  }
  const facts = renderOntologyProlog(projectionDocuments, authoritySeed, { profile: projectionProfile });
  const factsPath = getOntologyCompiledFactPath(cwd);
  const previous = existsSync(factsPath) ? readFileSync(factsPath, "utf-8") : null;
  const changedGeneratedFacts = projectionProfile === "full" && previous !== facts;
  const shouldWriteGeneratedFacts = projectionProfile === "full" && !dryRun && changedGeneratedFacts;

  const authorityReceipt = buildAuthorityReceipt({ cwd, documents: resolved.documents, facts });

  if (shouldWriteGeneratedFacts) {
    mkdirSync(dirname(factsPath), { recursive: true });
    writeFileSync(factsPath, facts);
  }

  return {
    ...resolved,
    facts,
    path: factsPath,
    total_fact_count: facts
      .split("\n")
      .filter((line) => line.trim().endsWith(".") && !line.trim().startsWith("%"))
      .length,
    incremental,
    dryRun,
    projection_profile: projectionProfile,
    changed_generated_facts: changedGeneratedFacts,
    wrote_generated_facts: shouldWriteGeneratedFacts,
    authority_receipt: shouldWriteGeneratedFacts
      ? { ...authorityReceipt, projections: { ...authorityReceipt.projections, compiled_prolog: { ...authorityReceipt.projections.compiled_prolog, status: "current" } } }
      : authorityReceipt,
  };
}
