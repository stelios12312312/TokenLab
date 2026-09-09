#!/usr/bin/env node
// Same-machine evidence harness; it deliberately makes no universal speed claim.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform, release, arch, cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { buildOntologyFacts } from "./lib/ontology_fact_builder.mjs";
import { loadOntologyRuntime, validateOntologyGraph } from "./lib/ontology_runtime.mjs";
import { buildEmptyOntologyDocument, ONTOLOGY_ENTITY_CLASSES, renderOntologyDocument } from "./lib/ontology_schema.mjs";
import { createSession } from "./lib/prolog.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const runs = Math.max(1, Number(value("--runs") || 5));
const warmups = Math.max(0, Number(value("--warmups") || 1));
const output = value("--output");
function createSmallFixture() {
  const root = mkdtempSync(join(tmpdir(), "ontology-benchmark-small-"));
  const documents = Object.fromEntries(ONTOLOGY_ENTITY_CLASSES.map((entityClass) => [entityClass, buildEmptyOntologyDocument(entityClass)]));
  documents.code.code.modules.push({ id: "sample", path: "src" });
  documents.code.code.files.push({ path: "src/sample.mjs", module: "sample", language: "javascript" });
  documents.specification.specification.domains.push({ name: "sample" });
  documents.specification.specification.stories.push({ id: "US-SAMPLE-1", title: "Small benchmark story", status: "FULLY_COVERED", domain: "sample", acceptance_criteria: [{ id: "AC-SAMPLE-1", text: "Small graph is queryable" }] });
  documents.verification.verification.tests.push({ name: "tests/sample.mjs", file: "tests/sample.mjs", type: "unit", criterion_ids: [], covered_files: ["src/sample.mjs"] });
  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const path = join(root, ".agent/ontology/facts", `${entityClass}.yaml`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderOntologyDocument(documents[entityClass]));
  }
  const versionPath = join(root, ".agent/skills/iterative-planner/config/version.json");
  mkdirSync(dirname(versionPath), { recursive: true });
  writeFileSync(versionPath, '{"version":"benchmark-fixture"}\n');
  return root;
}

const cases = [
  { label: "small", cwd: resolve(value("--small-dir") || createSmallFixture()) },
  { label: "large", cwd: resolve(value("--large-dir") || process.cwd()) },
];
if (cases[0].cwd === cases[1].cwd) throw new Error("small and large benchmark directories must be distinct");

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  return { samples: samples.length, p50_ms: Number(percentile(sorted, 0.5).toFixed(3)), p95_ms: Number(percentile(sorted, 0.95).toFixed(3)), mean_ms: Number(mean.toFixed(3)), variance_ms2: Number((samples.reduce((sum, sample) => sum + ((sample - mean) ** 2), 0) / samples.length).toFixed(3)) };
}
function timed(fn) { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result }; }

function measureCase(sample) {
  const measurements = { induction: [], cold_load_compile: [], warm_load_compile: [], compilation: [], grounded_lookup: [], graph_join: [], broad_scan: [], full_gate_evaluation: [] };
  let lastRuntime = null;
  let cardinalities = null;
  for (let index = 0; index < warmups + runs; index += 1) {
    const capture = index >= warmups;
    const induction = timed(() => buildOntologyFacts({ cwd: sample.cwd, induce: true, dryRun: true }));
    const cold = timed(() => loadOntologyRuntime({ cwd: sample.cwd, useCache: false, writeCache: false, projectionProfile: "full" }));
    const warm = timed(() => loadOntologyRuntime({ cwd: sample.cwd, useCache: true, writeCache: true, projectionProfile: "full" }));
    lastRuntime = warm.result;
    if (!induction.result.ok || !cold.result.ok || !warm.result.ok) throw new Error(`benchmark ${sample.label} ontology load failed`);
    const compilation = timed(() => { const session = createSession(); session.consult(warm.result.facts_text); return session; });
    const firstStory = warm.result.documents.specification?.stories?.[0]?.id || "__missing__";
    const grounded = timed(() => warm.result.session.queryAll(`story_title('${String(firstStory).replaceAll("'", "")}', Title)`));
    const join = timed(() => warm.result.session.queryAll("story_has_criterion(Story, Criterion), acceptance_criterion(Criterion, Text)"));
    const broad = timed(() => warm.result.session.queryAll("story_title(Story, Title)"));
    const validation = timed(() => validateOntologyGraph({ cwd: sample.cwd }));

    // Non-empty cardinality assertions
    if (grounded.result.length === 0) {
      throw new Error(`benchmark ${sample.label} query 'grounded' returned 0 results`);
    }
    if (join.result.length === 0) {
      throw new Error(`benchmark ${sample.label} query 'graph_join' returned 0 results`);
    }
    if (broad.result.length === 0) {
      throw new Error(`benchmark ${sample.label} query 'broad_scan' returned 0 results`);
    }

    // Injected mutation control verification
    const beforeMutationCount = broad.result.length;
    warm.result.session.assert(`story_title('__BENCHMARK_MUTATION_${index}__', 'Mutation Control Test Title').`);
    const afterMutation = warm.result.session.queryAll("story_title(Story, Title)");
    if (afterMutation.length !== beforeMutationCount + 1) {
      throw new Error(`benchmark ${sample.label} mutation control failed: expected ${beforeMutationCount + 1}, got ${afterMutation.length}`);
    }
    const negative = warm.result.session.queryAll("story_title('__NON_EXISTENT_BENCHMARK_STORY__', Title)");
    if (negative.length !== 0) {
      throw new Error(`benchmark ${sample.label} negative control failed: expected 0, got ${negative.length}`);
    }

    cardinalities = {
      grounded_count: grounded.result.length,
      graph_join_count: join.result.length,
      broad_scan_count: beforeMutationCount,
      mutation_verified: true,
      negative_control_verified: true,
    };

    if (capture) for (const [phase, timing] of Object.entries({ induction, cold_load_compile: cold, warm_load_compile: warm, compilation, grounded_lookup: grounded, graph_join: join, broad_scan: broad, full_gate_evaluation: validation })) measurements[phase].push(timing.ms);
  }
  const factLines = lastRuntime.facts_text.split("\n").filter((line) => line.trim().endsWith("."));
  const edgeFactCount = factLines.filter((line) => /^(file_depends_on|story_has_criterion|plan_criterion_story|plan_criterion_test|test_covers_file|test_verifies_criterion|artifact_proves_criterion|file_in_module)\(/.test(line.trim())).length;
  return { label: sample.label, cwd: sample.cwd, authority_digest: lastRuntime.authority_receipt.source_digest, total_fact_count: factLines.length, edge_fact_count: edgeFactCount, counts: lastRuntime.counts, cardinalities, phase_stats: Object.fromEntries(Object.entries(measurements).map(([phase, values]) => [phase, stats(values)])), cache_observation: lastRuntime.cache };
}

const slo = JSON.parse(readFileSync(new URL("../config/ontology_performance_slo.json", import.meta.url), "utf8"));
const report = {
  schema_version: 1,
  benchmark_contract: "ontology-benchmark.v1",
  generated_at: new Date().toISOString(),
  runtime: { node: process.version, platform: platform(), release: release(), arch: arch(), hostname: hostname(), cpu: cpus()[0]?.model || "unknown", cpu_count: cpus().length },
  warmup_runs: warmups,
  measurement_runs: runs,
  cases: cases.map(measureCase),
  slo,
  claims_boundary: "Same-machine repository evidence only. Results do not establish universal model, IDE, hardware, or deployment speed.",
};
report.budget_evaluation = Object.fromEntries(report.cases.map((sample) => {
  const budget = slo.budgets_ms[sample.label];
  const checks = {
    cold_p95: sample.phase_stats.cold_load_compile.p95_ms <= budget.cold_p95,
    warm_p95: sample.phase_stats.warm_load_compile.p95_ms <= budget.warm_p95,
    grounded_lookup_p95: sample.phase_stats.grounded_lookup.p95_ms <= budget.grounded_lookup_p95,
  };
  return [sample.label, { status: Object.values(checks).every(Boolean) ? "pass" : "fail", budget_ms: budget, checks }];
}));
if (output) { const path = resolve(output); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report, null, 2));
