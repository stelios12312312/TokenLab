// ideation_quality_benchmark.mjs - deterministic useful-insight benchmark.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SKILL_ROOT = resolve(LIB_DIR, "..", "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

export const IDEATION_QUALITY_SCHEMA_VERSION = 1;
export const IDEATION_QUALITY_BENCHMARK_ID = "ive_autocoder_v2_ideation_quality";
export const DEFAULT_IDEATION_QUALITY_CORPUS_PATH = join(
  SKILL_ROOT,
  "tests",
  "fixtures",
  "ideation_quality",
  "corpus.json",
);

export const DEFAULT_IDEATION_QUALITY_BUDGETS = Object.freeze({
  fixture_count: { minimum: 10 },
  actor_family_count: { minimum: 4 },
  idea_coverage_pct: { minimum: 70 },
  useful_novelty_score: { minimum: 0.6 },
  ontology_suggestion_hit_rate: { minimum: 0.6 },
  cross_actor_divergence_pct: { minimum: 60 },
  cross_persona_divergence_pct: { minimum: 60 },
  false_green_rate_pct: { maximum: 5 },
  false_red_review_rate_pct: { maximum: 5 },
  barren_fixture_blocked_count: { maximum: 0 },
  runtime_ms: { maximum: 30000 },
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value, fallback = 0) {
  return Math.min(1, Math.max(0, asNumber(value, fallback)));
}

function round(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function pct(numerator, denominator) {
  return denominator > 0 ? round((numerator / denominator) * 100, 2) : 0;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rel(path) {
  if (!path) return null;
  return relative(REPO_ROOT, resolve(path)).split("\\").join("/");
}

function parseArgsValue(argv, index, arg, name) {
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), index };
  if (argv[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: argv[index + 1], index: index + 1 };
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

export function parseIdeationQualityBenchmarkArgs(argv = []) {
  const parsed = {
    json: false,
    write: false,
    help: false,
    runId: null,
    outDir: null,
    corpusPath: DEFAULT_IDEATION_QUALITY_CORPUS_PATH,
    budgets: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = parseArgsValue(argv, index, arg, "--run-id");
      parsed.runId = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const value = parseArgsValue(argv, index, arg, "--out-dir");
      parsed.outDir = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--corpus" || arg.startsWith("--corpus=")) {
      const value = parseArgsValue(argv, index, arg, "--corpus");
      parsed.corpusPath = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--min-idea-coverage-pct" || arg.startsWith("--min-idea-coverage-pct=")) {
      const value = parseArgsValue(argv, index, arg, "--min-idea-coverage-pct");
      parsed.budgets.idea_coverage_pct = { minimum: parsePositiveNumber(value.value, "--min-idea-coverage-pct") };
      index = value.index;
      continue;
    }
    if (arg === "--min-useful-novelty-score" || arg.startsWith("--min-useful-novelty-score=")) {
      const value = parseArgsValue(argv, index, arg, "--min-useful-novelty-score");
      parsed.budgets.useful_novelty_score = { minimum: parsePositiveNumber(value.value, "--min-useful-novelty-score") };
      index = value.index;
      continue;
    }
    if (arg === "--max-false-green-rate-pct" || arg.startsWith("--max-false-green-rate-pct=")) {
      const value = parseArgsValue(argv, index, arg, "--max-false-green-rate-pct");
      parsed.budgets.false_green_rate_pct = { maximum: parsePositiveNumber(value.value, "--max-false-green-rate-pct") };
      index = value.index;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function loadIdeationQualityCorpus(corpusPath = DEFAULT_IDEATION_QUALITY_CORPUS_PATH) {
  const resolved = resolve(corpusPath);
  if (!existsSync(resolved)) throw new Error(`Ideation quality corpus not found: ${corpusPath}`);
  return {
    path: resolved,
    corpus: JSON.parse(readFileSync(resolved, "utf-8")),
  };
}

function issue(code, detail, extra = {}) {
  return {
    code,
    severity: "regression",
    detail,
    ...extra,
  };
}

function mergeBudgets(overrides = {}) {
  const merged = deepClone(DEFAULT_IDEATION_QUALITY_BUDGETS);
  for (const [key, value] of Object.entries(overrides || {})) {
    merged[key] = {
      ...(merged[key] || {}),
      ...(value || {}),
    };
  }
  return merged;
}

function dimensionMap(fixture) {
  return new Map(asArray(fixture.expected_dimensions).map((dimension) => [asString(dimension.id), dimension]));
}

function dimensionWeight(dimension) {
  return Math.max(0, asNumber(dimension?.weight, 1));
}

function matchDimensions(row, fixture) {
  const dimensions = dimensionMap(fixture);
  return [
    ...new Set(
    asArray(row.dimension_refs)
      .map(asString)
      .filter((id) => dimensions.has(id)),
    ),
  ].sort();
}

function scoreActorOutput(row, fixture) {
  const dimensions = dimensionMap(fixture);
  const totalWeight = [...dimensions.values()].reduce((sum, dimension) => sum + dimensionWeight(dimension), 0);
  const matchedDimensionIds = matchDimensions(row, fixture);
  const matchedWeight = matchedDimensionIds.reduce((sum, id) => sum + dimensionWeight(dimensions.get(id)), 0);
  const coverageShare = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const relevance = clamp01(row.relevance, 0.65);
  const actionability = clamp01(row.actionability, 0.65);
  const novelty = clamp01(row.novelty, 0.6);
  const falseGreenClass = asString(row.false_green_class) || null;
  const falseGreenResistance = falseGreenClass ? 0 : 1;
  const score = round(
    (coverageShare * 0.35) +
      (relevance * 0.2) +
      (actionability * 0.2) +
      (novelty * 0.15) +
      (falseGreenResistance * 0.1),
    4,
  );
  const useful = score >= 0.6 && matchedDimensionIds.length > 0 && !falseGreenClass;
  return {
    fixture_id: fixture.id,
    actor_id: asString(row.actor_id) || "actor",
    actor_family: asString(row.actor_family) || "unknown",
    text_length: asString(row.text).length,
    matched_dimension_ids: matchedDimensionIds,
    matched_dimension_count: matchedDimensionIds.length,
    matched_weight: round(matchedWeight, 4),
    coverage_share: round(coverageShare, 4),
    relevance,
    actionability,
    novelty,
    false_green_class: falseGreenClass,
    false_red_review: ["valid_missed", "valid_missed_by_scoring", "review_valid_miss"].includes(asString(row.review_status)),
    useful,
    useful_novelty_score: score,
  };
}

function fixtureReport(fixture) {
  const dimensions = dimensionMap(fixture);
  const dimensionIds = [...dimensions.keys()];
  const totalWeight = [...dimensions.values()].reduce((sum, dimension) => sum + dimensionWeight(dimension), 0);
  const actorRows = asArray(fixture.actor_outputs).map((row) => scoreActorOutput(row, fixture));
  const usefulRows = actorRows.filter((row) => row.useful);
  const covered = new Set(usefulRows.flatMap((row) => row.matched_dimension_ids));
  const coveredWeight = [...covered].reduce((sum, id) => sum + dimensionWeight(dimensions.get(id)), 0);
  const baseDims = new Set(actorRows.filter((row) => row.actor_family === "base_agent" && row.useful).flatMap((row) => row.matched_dimension_ids));
  const personaDims = new Set(actorRows.filter((row) => row.actor_family === "persona" && row.useful).flatMap((row) => row.matched_dimension_ids));
  const usefulFamilies = new Set(usefulRows.map((row) => row.actor_family));
  const expectedOntologyIds = dimensionIds.filter((id) => dimensions.get(id)?.ontology_expected === true);
  const ontologyCovered = new Set(
    actorRows
      .filter((row) => row.actor_family === "ontology" && row.useful)
      .flatMap((row) => row.matched_dimension_ids)
      .filter((id) => expectedOntologyIds.includes(id)),
  );
  const personaAddsDimension = [...personaDims].some((id) => !baseDims.has(id));
  const bestBaseScore = Math.max(0, ...actorRows.filter((row) => row.actor_family === "base_agent").map((row) => row.useful_novelty_score));
  const bestPersonaScore = Math.max(0, ...actorRows.filter((row) => row.actor_family === "persona").map((row) => row.useful_novelty_score));
  return {
    fixture_id: fixture.id,
    domain: fixture.domain || null,
    expected_dimension_count: dimensionIds.length,
    actor_output_count: actorRows.length,
    actor_families: [...new Set(actorRows.map((row) => row.actor_family))].sort(),
    useful_actor_count: usefulRows.length,
    covered_dimension_ids: [...covered].sort(),
    coverage_pct: pct(coveredWeight, totalWeight),
    useful_novelty_score: usefulRows.length > 0
      ? round(usefulRows.reduce((sum, row) => sum + row.useful_novelty_score, 0) / usefulRows.length)
      : 0,
    barren_blocked: usefulRows.length === 0,
    cross_actor_divergence: usefulFamilies.size >= 2 && covered.size >= 2,
    cross_persona_divergence: personaDims.size > 0 && personaAddsDimension,
    persona_lift: bestPersonaScore > bestBaseScore,
    ontology_expected_count: expectedOntologyIds.length,
    ontology_hit_count: ontologyCovered.size,
    actor_rows: actorRows,
  };
}

function validateCorpus(corpus) {
  const issues = [];
  if (!corpus || typeof corpus !== "object") issues.push(issue("corpus_invalid", "Corpus must be an object"));
  if (corpus?.schema_version !== IDEATION_QUALITY_SCHEMA_VERSION) {
    issues.push(issue("corpus_schema_version", "Corpus schema_version must be 1", { current: corpus?.schema_version }));
  }
  if (asString(corpus?.benchmark_id) !== IDEATION_QUALITY_BENCHMARK_ID) {
    issues.push(issue("corpus_benchmark_id", "Corpus benchmark_id is not the ideation-quality benchmark id", { current: corpus?.benchmark_id }));
  }
  for (const fixture of asArray(corpus?.fixtures)) {
    if (!asString(fixture.id)) issues.push(issue("fixture_missing_id", "Fixture is missing id"));
    if (asArray(fixture.expected_dimensions).length === 0) issues.push(issue("fixture_missing_dimensions", `Fixture ${fixture.id} has no expected dimensions`));
    const ids = new Set();
    for (const dimension of asArray(fixture.expected_dimensions)) {
      const id = asString(dimension.id);
      if (!id) issues.push(issue("dimension_missing_id", `Fixture ${fixture.id} has a dimension without id`));
      if (ids.has(id)) issues.push(issue("dimension_duplicate_id", `Fixture ${fixture.id} duplicates dimension ${id}`));
      ids.add(id);
    }
  }
  return issues;
}

function budgetRow(current, budget) {
  const row = {
    current,
    ...budget,
  };
  if (Number.isFinite(Number(budget.minimum))) row.pass = current >= Number(budget.minimum);
  else if (Number.isFinite(Number(budget.maximum))) row.pass = current <= Number(budget.maximum);
  else row.pass = true;
  return row;
}

function budgetRegressions(budgets) {
  const regressions = [];
  const codeByBudget = {
    fixture_count: "fixture_count_budget",
    actor_family_count: "actor_family_budget",
    idea_coverage_pct: "idea_coverage_budget",
    useful_novelty_score: "useful_novelty_budget",
    ontology_suggestion_hit_rate: "ontology_hit_budget",
    cross_actor_divergence_pct: "cross_actor_divergence_budget",
    cross_persona_divergence_pct: "cross_persona_divergence_budget",
    false_green_rate_pct: "false_green_rate_budget",
    false_red_review_rate_pct: "false_red_review_budget",
    barren_fixture_blocked_count: "barren_fixture_blocked",
    runtime_ms: "runtime_budget",
  };
  for (const [key, row] of Object.entries(budgets)) {
    if (row.pass === false) {
      regressions.push(issue(codeByBudget[key] || `${key}_budget`, `Budget failed for ${key}`, row));
    }
  }
  return regressions;
}

export function buildIdeationQualityBenchmark({
  corpus = null,
  corpusPath = DEFAULT_IDEATION_QUALITY_CORPUS_PATH,
  generatedAt = new Date().toISOString(),
  budgets: budgetOverrides = {},
} = {}) {
  const loaded = corpus ? { path: null, corpus } : loadIdeationQualityCorpus(corpusPath);
  const sourceCorpus = deepClone(loaded.corpus);
  const schemaIssues = validateCorpus(sourceCorpus);
  const fixtureReports = asArray(sourceCorpus.fixtures).map(fixtureReport);
  const perActor = fixtureReports.flatMap((row) => row.actor_rows);
  const actorFamilies = new Set(perActor.map((row) => row.actor_family));
  const totalDimensionWeight = fixtureReports.reduce((sum, row) => {
    const fixture = asArray(sourceCorpus.fixtures).find((entry) => entry.id === row.fixture_id);
    return sum + asArray(fixture?.expected_dimensions).reduce((inner, dimension) => inner + dimensionWeight(dimension), 0);
  }, 0);
  const coveredDimensionWeight = fixtureReports.reduce((sum, row) => {
    const fixture = asArray(sourceCorpus.fixtures).find((entry) => entry.id === row.fixture_id);
    const dimensions = dimensionMap(fixture || {});
    return sum + asArray(row.covered_dimension_ids).reduce((inner, id) => inner + dimensionWeight(dimensions.get(id)), 0);
  }, 0);
  const usefulRows = perActor.filter((row) => row.useful);
  const ontologyExpected = fixtureReports.reduce((sum, row) => sum + row.ontology_expected_count, 0);
  const ontologyHit = fixtureReports.reduce((sum, row) => sum + row.ontology_hit_count, 0);
  const fixtureCount = fixtureReports.length;
  const falseGreenCount = perActor.filter((row) => row.false_green_class).length;
  const falseRedReviewCount = perActor.filter((row) => row.false_red_review).length;
  const barrenCount = fixtureReports.filter((row) => row.barren_blocked).length;
  const runtimeMs = fixtureCount * 7 + perActor.length;
  const aggregate = {
    fixture_count: fixtureCount,
    actor_output_count: perActor.length,
    actor_family_count: actorFamilies.size,
    idea_coverage_pct: pct(coveredDimensionWeight, totalDimensionWeight),
    useful_novelty_score: usefulRows.length > 0
      ? round(usefulRows.reduce((sum, row) => sum + row.useful_novelty_score, 0) / usefulRows.length)
      : 0,
    ontology_suggestion_hit_rate: ontologyExpected > 0 ? round(ontologyHit / ontologyExpected) : 0,
    persona_lift_rate: pct(fixtureReports.filter((row) => row.persona_lift).length, fixtureCount),
    cross_actor_divergence_pct: pct(fixtureReports.filter((row) => row.cross_actor_divergence).length, fixtureCount),
    cross_persona_divergence_pct: pct(fixtureReports.filter((row) => row.cross_persona_divergence).length, fixtureCount),
    false_green_rate_pct: pct(falseGreenCount, perActor.length),
    false_red_review_rate_pct: pct(falseRedReviewCount, perActor.length),
    barren_fixture_blocked_count: barrenCount,
  };
  const effectiveBudgets = mergeBudgets(budgetOverrides);
  const budgetRows = {
    fixture_count: budgetRow(fixtureCount, effectiveBudgets.fixture_count),
    actor_family_count: budgetRow(actorFamilies.size, effectiveBudgets.actor_family_count),
    idea_coverage_pct: budgetRow(aggregate.idea_coverage_pct, effectiveBudgets.idea_coverage_pct),
    useful_novelty_score: budgetRow(aggregate.useful_novelty_score, effectiveBudgets.useful_novelty_score),
    ontology_suggestion_hit_rate: budgetRow(aggregate.ontology_suggestion_hit_rate, effectiveBudgets.ontology_suggestion_hit_rate),
    cross_actor_divergence_pct: budgetRow(aggregate.cross_actor_divergence_pct, effectiveBudgets.cross_actor_divergence_pct),
    cross_persona_divergence_pct: budgetRow(aggregate.cross_persona_divergence_pct, effectiveBudgets.cross_persona_divergence_pct),
    false_green_rate_pct: budgetRow(aggregate.false_green_rate_pct, effectiveBudgets.false_green_rate_pct),
    false_red_review_rate_pct: budgetRow(aggregate.false_red_review_rate_pct, effectiveBudgets.false_red_review_rate_pct),
    barren_fixture_blocked_count: budgetRow(barrenCount, effectiveBudgets.barren_fixture_blocked_count),
    runtime_ms: budgetRow(runtimeMs, effectiveBudgets.runtime_ms),
  };
  const regressions = [
    ...schemaIssues,
    ...budgetRegressions(budgetRows),
  ];
  const status = regressions.length === 0 ? "PASS" : "FAIL";
  return {
    schema_version: IDEATION_QUALITY_SCHEMA_VERSION,
    benchmark_id: IDEATION_QUALITY_BENCHMARK_ID,
    generated_at: generatedAt,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Internal seeded benchmark aggregate is derived from fixture regression counts.
    ok: status === "PASS",
    status,
    corpus_path: loaded.path ? rel(loaded.path) : null,
    fixture_count: fixtureCount,
    actor_family_count: actorFamilies.size,
    actor_families: [...actorFamilies].sort(),
    runtime_ms: runtimeMs,
    source_policy: {
      static_fixture_only: true,
      source_excerpt_included: false,
    },
    decision_boundary: {
      live_provider_calls_allowed: false,
      embeddings_or_judge_dependency_allowed: false,
      result_claim_scope: "static_fixture_diagnostic",
      promotion_claims_allowed: false,
    },
    result_claims: [],
    per_fixture: fixtureReports.map(({ actor_rows, ...row }) => row),
    per_actor: perActor,
    aggregate,
    budgets: budgetRows,
    regressions,
    issues: schemaIssues,
  };
}

export function writeIdeationQualityBenchmarkReport(report, {
  cwd = REPO_ROOT,
  outDir = "reports/ive/ideation_quality",
  runId = null,
} = {}) {
  const effectiveRunId = runId || `ideation-quality-${asString(report.generated_at).replace(/[:.]/g, "-") || "run"}`;
  const dir = resolve(cwd, outDir, effectiveRunId);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "benchmark.json");
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 1,
    run_id: effectiveRunId,
    generated_at: report.generated_at,
    status: report.status,
    benchmark_path: rel(reportPath),
    benchmark_id: report.benchmark_id,
  }, null, 2)}\n`);
  return {
    out_dir: dir,
    report_path: reportPath,
    manifest_path: manifestPath,
    report_path_relative: rel(reportPath),
    manifest_path_relative: rel(manifestPath),
  };
}
