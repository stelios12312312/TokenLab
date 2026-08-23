import { existsSync } from "fs";
import { basename, resolve } from "path";

import { detectTautologicalTest, validateEvidenceArtifact } from "../../iterative-planner/scripts/lib/evidence_verifier.mjs";

const IMPLEMENTED_STATUSES = new Set(["implemented", "FULLY_COVERED"]);
const ACTIVE_STATUSES = new Set(["active", "PARTIALLY_COVERED"]);
const PROPOSED_STATUSES = new Set(["proposed", "NOT_IMPLEMENTED"]);
const RETIRED_STATUSES = new Set(["retired", "deprecated", "RETIRED"]);
const ADEQUACY_TYPES = {
  COVERAGE_ARTIFACT_MISSING: "COVERAGE_ARTIFACT_MISSING",
  COVERAGE_THRESHOLD_UNMET: "COVERAGE_THRESHOLD_UNMET",
  TAUTOLOGICAL_ASSERTION: "TAUTOLOGICAL_ASSERTION",
  NO_ASSERTION_BODY: "NO_ASSERTION_BODY",
  GENERIC_TEST_NAME: "GENERIC_TEST_NAME",
  TEST_NAME_MISMATCH: "TEST_NAME_MISMATCH",
};
const TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "for",
  "with",
  "without",
  "of",
  "in",
  "on",
  "by",
  "from",
  "is",
  "are",
  "be",
  "can",
  "must",
  "should",
  "user",
  "users",
  "valid",
  "invalid",
  "state",
  "flow",
  "path",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
]);
const TEST_NAME_STOP_WORDS = new Set([
  ...TEXT_STOP_WORDS,
  "test",
  "tests",
  "spec",
  "specs",
  "suite",
  "integration",
  "unit",
  "e2e",
  "smoke",
  "regression",
  "case",
  "cases",
  "check",
  "checks",
  "happy",
  "error",
  "edge",
  "component",
]);

export function normalizeStoryStatus(status) {
  const value = String(status || "").trim();
  if (IMPLEMENTED_STATUSES.has(value)) return "implemented";
  if (ACTIVE_STATUSES.has(value)) return "active";
  if (PROPOSED_STATUSES.has(value)) return "proposed";
  if (RETIRED_STATUSES.has(value)) return "retired";
  return "unknown";
}

function listStories(registryDocument) {
  return Array.isArray(registryDocument?.stories) ? registryDocument.stories : [];
}

function collectStoryRecords(annotations) {
  const byStory = new Map();
  const testSymbols = new Set();

  for (const record of Array.isArray(annotations?.records) ? annotations.records : []) {
    if (record.scope === "test" && record.symbol) testSymbols.add(record.symbol);
    const storyIds = Array.isArray(record?.tags?.story_id) ? record.tags.story_id : [];
    for (const storyId of storyIds) {
      if (!byStory.has(storyId)) byStory.set(storyId, []);
      byStory.get(storyId).push(record);
    }
  }

  return { byStory, testSymbols };
}

function buildFinding(type, storyId, description, { file = null, severity = "MEDIUM" } = {}) {
  return {
    type,
    story_id: storyId,
    file,
    description,
    severity,
  };
}

function normalizeText(value) {
  return String(value || "").trim();
}

function splitIdentifierWords(value) {
  return normalizeText(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ");
}

function normalizeToken(token) {
  const value = String(token || "").trim().toLowerCase();
  if (!value) return "";
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && value.length > 3) return value.slice(0, -1);
  return value;
}

function tokenize(value, { stopWords = TEXT_STOP_WORDS } = {}) {
  return [...new Set(
    splitIdentifierWords(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => normalizeToken(token))
      .filter((token) => token && token.length > 1 && !stopWords.has(token))
  )];
}

function listCriteria(strategyDocument) {
  return Array.isArray(strategyDocument?.verification_strategy?.criteria)
    ? strategyDocument.verification_strategy.criteria
    : [];
}

function resolvedTestFile(projectRoot, declaredTest) {
  const file = normalizeText(declaredTest?.file);
  return file ? resolve(projectRoot, file) : null;
}

function mapAdequacySeverity(type) {
  if (type === ADEQUACY_TYPES.TEST_NAME_MISMATCH) return "LOW";
  if (type === ADEQUACY_TYPES.GENERIC_TEST_NAME) return "MEDIUM";
  return "HIGH";
}

function buildAdequacyFinding(type, criterion, description, {
  planId = null,
  file = null,
  testName = null,
} = {}) {
  return {
    type,
    criterion_id: normalizeText(criterion?.id) || null,
    plan_id: normalizeText(planId) || null,
    story_id: normalizeText(criterion?.story_id) || null,
    severity: mapAdequacySeverity(type),
    description,
    test_name: normalizeText(testName) || null,
    file: normalizeText(file) || null,
  };
}

function classifyTautology(detail) {
  const text = String(detail || "").toLowerCase();
  if (text.includes("generic test name")) return ADEQUACY_TYPES.GENERIC_TEST_NAME;
  if (text.includes("no assertion-like call")) return ADEQUACY_TYPES.NO_ASSERTION_BODY;
  return ADEQUACY_TYPES.TAUTOLOGICAL_ASSERTION;
}

function criterionTokens(criterion) {
  return new Set([
    ...tokenize(criterion?.criterion),
    ...(Array.isArray(criterion?.acceptance) ? criterion.acceptance.flatMap((item) => tokenize(item)) : []),
    ...tokenize(criterion?.pass_means),
    ...tokenize(criterion?.implementation?.function),
    ...tokenize(basename(normalizeText(criterion?.implementation?.file))),
  ]);
}

function testTokens(declaredTest) {
  return new Set([
    ...tokenize(declaredTest?.name, { stopWords: TEST_NAME_STOP_WORDS }),
    ...tokenize(basename(normalizeText(declaredTest?.file)), { stopWords: TEST_NAME_STOP_WORDS }),
  ]);
}

function testNameLooksAligned(criterion, declaredTest) {
  const expected = criterionTokens(criterion);
  const actual = testTokens(declaredTest);
  if (expected.size === 0 || actual.size === 0) return true;
  return [...actual].some((token) => expected.has(token));
}

function evaluateCoverageAdequacy({ projectRoot, criterion, planId }) {
  const findings = [];
  for (const artifact of Array.isArray(criterion?.evidence_artifacts) ? criterion.evidence_artifacts : []) {
    if (normalizeText(artifact?.type) !== "coverage_report") continue;
    const result = validateEvidenceArtifact({ projectRoot, artifact });
    if (result.ok) continue;
    const type = result.blocker === "evidence_artifact_missing"
      ? ADEQUACY_TYPES.COVERAGE_ARTIFACT_MISSING
      : ADEQUACY_TYPES.COVERAGE_THRESHOLD_UNMET;
    findings.push(buildAdequacyFinding(
      type,
      criterion,
      result.detail,
      {
        planId,
        file: artifact?.path || result.path || null,
      }
    ));
  }
  return findings;
}

function evaluateTestAdequacy({ projectRoot, criterion, planId }) {
  const findings = [];
  for (const declaredTest of Array.isArray(criterion?.tests) ? criterion.tests : []) {
    const filePath = resolvedTestFile(projectRoot, declaredTest);
    if (!filePath || !existsSync(filePath)) continue;

    const tautology = detectTautologicalTest({
      projectRoot,
      testFile: declaredTest.file,
      testName: declaredTest.name,
    });
    if (tautology.found) {
      findings.push(buildAdequacyFinding(
        classifyTautology(tautology.detail),
        criterion,
        tautology.detail,
        {
          planId,
          file: declaredTest.file || null,
          testName: declaredTest.name || null,
        }
      ));
      continue;
    }

    if (!testNameLooksAligned(criterion, declaredTest)) {
      findings.push(buildAdequacyFinding(
        ADEQUACY_TYPES.TEST_NAME_MISMATCH,
        criterion,
        `${declaredTest.name || "<unnamed test>"} does not overlap the criterion's behavioral language`,
        {
          planId,
          file: declaredTest.file || null,
          testName: declaredTest.name || null,
        }
      ));
    }
  }
  return findings;
}

export function verifyCoverage({ registryDocument, annotations }) {
  const stories = listStories(registryDocument);
  const registryById = new Map(stories.map((story) => [story.id, story]));
  const { byStory, testSymbols } = collectStoryRecords(annotations);
  const findings = [];

  for (const [storyId, records] of byStory.entries()) {
    if (!registryById.has(storyId)) {
      findings.push(buildFinding(
        "ORPHANED_ANNOTATION",
        storyId,
        `${storyId} is annotated in code but missing from reports/user_story_audit/story_registry.json`,
        { file: records[0]?.file || null, severity: "HIGH" }
      ));
    }
  }

  for (const story of stories) {
    const normalizedStatus = normalizeStoryStatus(story?.status);
    const records = byStory.get(story.id) || [];
    const acceptanceCriteria = Array.isArray(story?.acceptance_criteria) ? story.acceptance_criteria : [];

    if ((normalizedStatus === "implemented" || normalizedStatus === "active") && records.length === 0) {
      findings.push(buildFinding(
        "MISSING_IMPLEMENTATION",
        story.id,
        `${story.id} is ${normalizedStatus} but has no @planner:story_id annotations in the scanned code/test surface`,
        { severity: "HIGH" }
      ));
      continue;
    }

    if (normalizedStatus === "retired" && records.length > 0) {
      findings.push(buildFinding(
        "STALE_RETIRED_ANNOTATION",
        story.id,
        `${story.id} is retired/deprecated but still has live @planner:story_id annotations`,
        { file: records[0]?.file || null, severity: "MEDIUM" }
      ));
    }

    if (normalizedStatus !== "implemented" && normalizedStatus !== "active") continue;

    for (const record of records) {
      for (const testName of Array.isArray(record?.tags?.tested_by) ? record.tags.tested_by : []) {
        if (!testSymbols.has(testName)) {
          findings.push(buildFinding(
            "STALE_TEST_REFERENCE",
            story.id,
            `${story.id} references missing test symbol ${testName}`,
            { file: record.file, severity: "MEDIUM" }
          ));
        }
      }
    }

    const coveredAcceptance = new Set(
      records.flatMap((record) => Array.isArray(record?.tags?.accepts) ? record.tags.accepts : [])
    );
    const missingAcceptance = acceptanceCriteria.filter((criterion) => !coveredAcceptance.has(criterion));
    if (missingAcceptance.length > 0) {
      findings.push(buildFinding(
        "INCOMPLETE_ACCEPTANCE",
        story.id,
        `${story.id} is missing acceptance annotations for: ${missingAcceptance.join(", ")}`,
        { severity: normalizedStatus === "implemented" ? "MEDIUM" : "LOW" }
      ));
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    summary: {
      total_findings: findings.length,
      orphaned_annotations: findings.filter((finding) => finding.type === "ORPHANED_ANNOTATION").length,
      missing_implementation: findings.filter((finding) => finding.type === "MISSING_IMPLEMENTATION").length,
      stale_test_references: findings.filter((finding) => finding.type === "STALE_TEST_REFERENCE").length,
      stale_retired_annotations: findings.filter((finding) => finding.type === "STALE_RETIRED_ANNOTATION").length,
      incomplete_acceptance: findings.filter((finding) => finding.type === "INCOMPLETE_ACCEPTANCE").length,
    },
  };
}

export function verifyAdequacy({
  projectRoot = process.cwd(),
  strategyDocument,
} = {}) {
  const planId = normalizeText(strategyDocument?.verification_strategy?.plan_id) || null;
  const findings = [];

  for (const criterion of listCriteria(strategyDocument)) {
    findings.push(...evaluateCoverageAdequacy({ projectRoot, criterion, planId }));
    findings.push(...evaluateTestAdequacy({ projectRoot, criterion, planId }));
  }

  return {
    ok: findings.length === 0,
    findings,
    summary: {
      total_findings: findings.length,
      coverage_artifact_missing: findings.filter((finding) => finding.type === ADEQUACY_TYPES.COVERAGE_ARTIFACT_MISSING).length,
      coverage_threshold_unmet: findings.filter((finding) => finding.type === ADEQUACY_TYPES.COVERAGE_THRESHOLD_UNMET).length,
      tautological_assertions: findings.filter((finding) => finding.type === ADEQUACY_TYPES.TAUTOLOGICAL_ASSERTION).length,
      missing_assertions: findings.filter((finding) => finding.type === ADEQUACY_TYPES.NO_ASSERTION_BODY).length,
      generic_test_names: findings.filter((finding) => finding.type === ADEQUACY_TYPES.GENERIC_TEST_NAME).length,
      test_name_mismatch: findings.filter((finding) => finding.type === ADEQUACY_TYPES.TEST_NAME_MISMATCH).length,
    },
  };
}
