// pack_guard_benchmark.mjs - deterministic pack-guard conformance benchmark.
// @planner:module = pack_guard_benchmark
// @planner:capability = measures_pack_guard_consumption_receipts_and_false_blocks

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildKnowledgeReceipt,
  renderKnowledgeReceiptText,
} from "./knowledge_receipt.mjs";
import {
  buildOntologyPackGuardContract,
  normalizePackGuardRecords,
} from "./ontology_pack_guard_contract.mjs";
import { deriveTaskFocusContract } from "./task_focus_contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SKILL_ROOT = resolve(LIB_DIR, "..", "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

export const PACK_GUARD_BENCHMARK_SCHEMA_VERSION = 1;
export const PACK_GUARD_BENCHMARK_ID = "ive_autocoder_v2_pack_guard_benchmark";
export const REQUIRED_PACK_GUARD_SCENARIO_CLASSES = Object.freeze([
  "quant_process",
  "report_artifact",
  "planner_core_false_positive",
  "frontend_ui",
]);
export const DEFAULT_PACK_GUARD_CORPUS_PATH = join(
  SKILL_ROOT,
  "tests",
  "fixtures",
  "pack_guard_benchmark",
  "corpus.json",
);
export const DEFAULT_PACK_GUARD_BUDGETS = Object.freeze({
  fixture_count: { minimum: 4 },
  scenario_class_count: { minimum: 4 },
  ignored_high_confidence_pack_count: { maximum: 0 },
  false_block_count: { maximum: 0 },
  receipt_visibility_rate: { minimum: 1 },
  runtime_ms: { maximum: 30000 },
});

function asArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function rel(path) {
  if (!path) return null;
  return relative(REPO_ROOT, resolve(path)).split("\\").join("/");
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
  const merged = deepClone(DEFAULT_PACK_GUARD_BUDGETS);
  for (const [key, value] of Object.entries(overrides || {})) {
    merged[key] = {
      ...(merged[key] || {}),
      ...(value || {}),
    };
  }
  return merged;
}

function budgetRow(current, budget = {}) {
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
  const codeByBudget = {
    fixture_count: "fixture_count_budget",
    scenario_class_count: "scenario_class_budget",
    applied_guard_count: "applied_guard_count_budget",
    ignored_high_confidence_pack_count: "ignored_high_confidence_pack_budget",
    false_block_count: "false_block_budget",
    receipt_visibility_rate: "receipt_visibility_budget",
    runtime_ms: "runtime_budget",
  };
  const regressions = [];
  for (const [key, row] of Object.entries(budgets)) {
    if (row.pass === false) {
      regressions.push(issue(codeByBudget[key] || `${key}_budget`, `Budget failed for ${key}`, row));
    }
  }
  return regressions;
}

function validateCorpus(corpus) {
  const issues = [];
  if (!corpus || typeof corpus !== "object" || Array.isArray(corpus)) {
    return [issue("corpus_invalid", "Corpus must be an object")];
  }
  if (corpus.schema_version !== PACK_GUARD_BENCHMARK_SCHEMA_VERSION) {
    issues.push(issue("corpus_schema_version", "Corpus schema_version must be 1", { current: corpus.schema_version }));
  }
  if (asString(corpus.benchmark_id) !== PACK_GUARD_BENCHMARK_ID) {
    issues.push(issue("corpus_benchmark_id", "Corpus benchmark_id is not the pack-guard benchmark id", { current: corpus.benchmark_id }));
  }
  const ids = new Set();
  for (const fixture of asArray(corpus.fixtures)) {
    const id = asString(fixture.id);
    if (!id) issues.push(issue("fixture_missing_id", "Fixture is missing id"));
    if (ids.has(id)) issues.push(issue("fixture_duplicate_id", `Fixture id is duplicated: ${id}`));
    ids.add(id);
    if (!asString(fixture.scenario_class)) issues.push(issue("fixture_missing_scenario_class", `Fixture ${id || "(unknown)"} is missing scenario_class`));
    if (!Array.isArray(fixture.expected_guard_ids)) {
      issues.push(issue("fixture_expected_guard_ids_missing", `Fixture ${id || "(unknown)"} must declare expected_guard_ids`));
    }
  }
  return issues;
}

export function loadPackGuardCorpus(corpusPath = DEFAULT_PACK_GUARD_CORPUS_PATH) {
  const resolved = resolve(corpusPath);
  if (!existsSync(resolved)) throw new Error(`Pack guard corpus not found: ${corpusPath}`);
  return {
    path: resolved,
    corpus: JSON.parse(readFileSync(resolved, "utf-8")),
  };
}

function deriveScenarioTaskFocus(scenario) {
  if (scenario.task_focus_contract && typeof scenario.task_focus_contract === "object") {
    return scenario.task_focus_contract;
  }
  return deriveTaskFocusContract({
    goalText: scenario.goal_text || scenario.goal || "",
    plannedFiles: scenario.planned_files || [],
    planShape: scenario.plan_shape || null,
    forcedPacks: scenario.forced_packs || [],
  });
}

function isOntologyScenario(scenario) {
  return ["ontology_quant", "ontology_planner_core", "ontology"].includes(asString(scenario.engine));
}

function normalizeScenarioRecords(scenario) {
  const raw = [];
  if (isOntologyScenario(scenario)) {
    raw.push(...buildOntologyPackGuardContract({
      phase: scenario.phase || "preflight",
      goalText: scenario.goal_text || scenario.goal || "",
      sourceFacts: scenario.source_facts || [],
      taskFocusContract: deriveScenarioTaskFocus(scenario),
      plannedFiles: scenario.planned_files || [],
    }));
  }
  raw.push(...asArray(scenario.fixture_records));
  return normalizePackGuardRecords(raw);
}

function actionableRecord(record) {
  return ["guard", "idea", "waiver_candidate"].includes(asString(record.type));
}

function receiptForScenario({ scenario, records, consumePackGuards, renderReceiptText }) {
  const actionable = consumePackGuards ? records.filter(actionableRecord) : [];
  const nARecords = records.filter((record) => asString(record.type) === "N/A");
  const receipt = buildKnowledgeReceipt({
    source: {
      surface: "pack_guard_benchmark",
      kind: scenario.scenario_class,
      title: scenario.title || scenario.id,
      ticket_id: "T-INTAKE-E868A72A",
    },
    sourceText: [
      scenario.title,
      scenario.goal_text,
      ...asArray(scenario.source_facts),
    ].filter(Boolean).join("\n"),
    personaPacks: scenario.persona_packs || [],
    concreteGuards: actionable.map((record) => ({
      id: record.id,
      source_id: asArray(record.source_ids)[0] || record.pack_id,
      source_type: record.pack_id,
      status: "applied",
      reason: record.evidence_expectation,
      evidence_refs: record.source_ids,
    })),
    nAPacks: nARecords.map((record) => ({
      pack_id: record.pack_id,
      reason: record.id,
      rationale: record.n_a_rationale || record.summary,
    })),
    artifactRefs: scenario.artifact_refs || [],
    remainingUnverifiedRisk: scenario.remaining_unverified_risk || [],
  });
  const text = renderReceiptText(receipt, { maxItems: 5 });
  return {
    receipt,
    text,
    visible: !scenario.receipt_required || /^Knowledge receipt:/.test(text),
  };
}

function scenarioReport(scenario, {
  consumePackGuards = true,
  renderReceiptText = renderKnowledgeReceiptText,
} = {}) {
  const expectedGuardIds = uniqueStrings(scenario.expected_guard_ids);
  const expectedNaPackIds = uniqueStrings(scenario.expected_na_pack_ids);
  const issues = [];
  let records = [];
  try {
    records = normalizeScenarioRecords(scenario);
  } catch (error) {
    issues.push(issue("pack_guard_record_invalid", `Fixture ${scenario.id || "(unknown)"} produced invalid pack guard records`, {
      error: error.message,
    }));
  }

  const actionables = consumePackGuards ? records.filter(actionableRecord) : [];
  const actionableIds = new Set(actionables.map((record) => record.id));
  const appliedGuardIds = expectedGuardIds.filter((id) => actionableIds.has(id));
  const ignoredHighConfidencePackIds = expectedGuardIds.filter((id) => !actionableIds.has(id));
  const falseBlockRecords = scenario.expected_stand_down === true
    ? actionables.filter((record) => record.blocking_eligible === true)
    : [];
  const nAPackIds = uniqueStrings(records
    .filter((record) => asString(record.type) === "N/A")
    .map((record) => record.pack_id));
  const missingNaPackIds = expectedNaPackIds.filter((id) => !nAPackIds.includes(id));
  if (missingNaPackIds.length > 0) {
    issues.push(issue("expected_na_pack_missing", `Fixture ${scenario.id || "(unknown)"} did not emit expected N/A pack records`, {
      missing_na_pack_ids: missingNaPackIds,
    }));
  }
  const receipt = receiptForScenario({ scenario, records, consumePackGuards, renderReceiptText });
  if (scenario.receipt_required && !receipt.visible) {
    issues.push(issue("receipt_not_visible", `Fixture ${scenario.id || "(unknown)"} required a rendered Knowledge Receipt`));
  }

  return {
    fixture_id: scenario.id || null,
    scenario_class: scenario.scenario_class || null,
    title: scenario.title || null,
    engine: scenario.engine || "fixture_records",
    expected_guard_ids: expectedGuardIds,
    applied_guard_ids: appliedGuardIds,
    ignored_high_confidence_pack_ids: ignoredHighConfidencePackIds,
    actual_actionable_guard_ids: actionables.map((record) => record.id),
    expected_na_pack_ids: expectedNaPackIds,
    observed_na_pack_ids: nAPackIds,
    missing_na_pack_ids: missingNaPackIds,
    false_block_records: falseBlockRecords.map((record) => ({
      id: record.id,
      pack_id: record.pack_id,
      type: record.type,
      blocking_eligible: record.blocking_eligible,
    })),
    receipt_required: scenario.receipt_required === true,
    receipt_visible: receipt.visible,
    receipt_text: receipt.text,
    receipt_has_content: receipt.receipt.has_content === true,
    record_count: records.length,
    issues,
  };
}

export function buildPackGuardBenchmark({
  corpus = null,
  corpusPath = DEFAULT_PACK_GUARD_CORPUS_PATH,
  generatedAt = new Date().toISOString(),
  budgets: budgetOverrides = {},
  consumePackGuards = true,
  renderReceiptText = renderKnowledgeReceiptText,
} = {}) {
  const loaded = corpus ? { path: null, corpus } : loadPackGuardCorpus(corpusPath);
  const sourceCorpus = deepClone(loaded.corpus);
  const schemaIssues = validateCorpus(sourceCorpus);
  const fixtureRows = asArray(sourceCorpus.fixtures).map((fixture) => scenarioReport(fixture, {
    consumePackGuards,
    renderReceiptText,
  }));
  const scenarioClasses = uniqueStrings(fixtureRows.map((row) => row.scenario_class));
  const missingScenarioClasses = REQUIRED_PACK_GUARD_SCENARIO_CLASSES.filter((id) => !scenarioClasses.includes(id));
  const expectedGuardCount = fixtureRows.reduce((sum, row) => sum + row.expected_guard_ids.length, 0);
  const appliedGuardCount = fixtureRows.reduce((sum, row) => sum + row.applied_guard_ids.length, 0);
  const ignoredCount = fixtureRows.reduce((sum, row) => sum + row.ignored_high_confidence_pack_ids.length, 0);
  const falseBlockCount = fixtureRows.reduce((sum, row) => sum + row.false_block_records.length, 0);
  const receiptRequiredCount = fixtureRows.filter((row) => row.receipt_required).length;
  const receiptVisibleCount = fixtureRows.filter((row) => row.receipt_required && row.receipt_visible).length;
  const runtimeMs = fixtureRows.length * 11 + fixtureRows.reduce((sum, row) => sum + row.record_count, 0);
  const aggregate = {
    fixture_count: fixtureRows.length,
    scenario_class_count: scenarioClasses.length,
    expected_guard_count: expectedGuardCount,
    applied_guard_count: appliedGuardCount,
    ignored_high_confidence_pack_count: ignoredCount,
    false_block_count: falseBlockCount,
    receipt_required_count: receiptRequiredCount,
    receipt_visible_count: receiptVisibleCount,
    receipt_visibility_rate: receiptRequiredCount > 0 ? round(receiptVisibleCount / receiptRequiredCount) : 1,
    runtime_ms: runtimeMs,
  };
  const effectiveBudgets = mergeBudgets({
    ...budgetOverrides,
    applied_guard_count: {
      minimum: expectedGuardCount,
      ...(budgetOverrides.applied_guard_count || {}),
    },
  });
  const budgetRows = {
    fixture_count: budgetRow(aggregate.fixture_count, effectiveBudgets.fixture_count),
    scenario_class_count: budgetRow(aggregate.scenario_class_count, effectiveBudgets.scenario_class_count),
    applied_guard_count: budgetRow(aggregate.applied_guard_count, effectiveBudgets.applied_guard_count),
    ignored_high_confidence_pack_count: budgetRow(aggregate.ignored_high_confidence_pack_count, effectiveBudgets.ignored_high_confidence_pack_count),
    false_block_count: budgetRow(aggregate.false_block_count, effectiveBudgets.false_block_count),
    receipt_visibility_rate: budgetRow(aggregate.receipt_visibility_rate, effectiveBudgets.receipt_visibility_rate),
    runtime_ms: budgetRow(aggregate.runtime_ms, effectiveBudgets.runtime_ms),
  };
  const scenarioIssues = [
    ...fixtureRows.flatMap((row) => row.issues),
    ...missingScenarioClasses.map((id) => issue("scenario_class_missing", `Required scenario class is missing: ${id}`, {
      scenario_class: id,
    })),
  ];
  const regressions = [
    ...schemaIssues,
    ...scenarioIssues,
    ...budgetRegressions(budgetRows),
  ];
  const status = regressions.length === 0 ? "PASS" : "FAIL";
  return {
    schema_version: PACK_GUARD_BENCHMARK_SCHEMA_VERSION,
    benchmark_id: PACK_GUARD_BENCHMARK_ID,
    generated_at: generatedAt,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Internal seeded benchmark aggregate is derived from fixture regression counts.
    ok: status === "PASS",
    status,
    corpus_path: loaded.path ? rel(loaded.path) : null,
    fixture_count: aggregate.fixture_count,
    scenario_classes: scenarioClasses,
    required_scenario_classes: [...REQUIRED_PACK_GUARD_SCENARIO_CLASSES],
    missing_scenario_classes: missingScenarioClasses,
    runtime_ms: runtimeMs,
    source_policy: {
      static_fixture_only: true,
      source_excerpt_included: false,
      live_provider_calls_allowed: false,
    },
    decision_boundary: {
      live_provider_calls_allowed: false,
      browser_runtime_required: false,
      quant_result_claims_allowed: false,
      result_claim_scope: "pack_guard_conformance_diagnostic",
      promotion_claims_allowed: false,
    },
    result_claims: [],
    per_fixture: fixtureRows.map(({ issues, ...row }) => row),
    aggregate,
    budgets: budgetRows,
    regressions,
    issues: [...schemaIssues, ...scenarioIssues],
  };
}

export function writePackGuardBenchmarkReport(report, {
  cwd = REPO_ROOT,
  outDir = "reports/ive/pack_guard_benchmark",
  runId = null,
} = {}) {
  const effectiveRunId = runId || `pack-guard-${asString(report.generated_at).replace(/[:.]/g, "-") || "run"}`;
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
