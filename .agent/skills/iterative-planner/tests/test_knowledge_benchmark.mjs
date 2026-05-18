#!/usr/bin/env node
// test_knowledge_benchmark.mjs — contract coverage for knowledge_benchmark.mjs summary metrics.

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const NODE = process.execPath;
const benchmarkPath = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts", "knowledge_benchmark.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

let parsed = null;
try {
  const stdout = execFileSync(NODE, [benchmarkPath, "--json"], {
    cwd: plannerRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
    },
  });
  parsed = JSON.parse(stdout);
} catch {
  parsed = null;
}

assert(!!parsed, "knowledge_benchmark emits valid JSON");
assert(parsed?.total_scenarios === 6, "knowledge_benchmark runs the golden six-scenario cohort");
assert(parsed?.passed_scenarios === parsed?.total_scenarios, "knowledge_benchmark reports all scenarios passing");
assert(parsed?.route_accuracy === 1, "knowledge_benchmark reports perfect route accuracy for the golden cohort");
assert(parsed?.tier_accuracy === 1, "knowledge_benchmark reports perfect tier accuracy for the golden cohort");
assert(parsed?.deep_search_accuracy === 1, "knowledge_benchmark reports perfect deep-search expectation accuracy");
assert(parsed?.matched_via_accuracy === 1, "knowledge_benchmark reports perfect signal-match accuracy");
assert(parsed?.easy_case_no_deep_search_rate === 1, "knowledge_benchmark preserves no-deep-search behavior for easy cases");
assert(parsed?.deep_case_deep_search_rate === 1, "knowledge_benchmark preserves deep-search behavior for deep cases");
assert(typeof parsed?.avg_tiers_visited === "number" && parsed.avg_tiers_visited >= 1 && parsed.avg_tiers_visited <= 3, "knowledge_benchmark reports bounded average tiers visited");
assert(typeof parsed?.avg_sources_consulted === "number" && parsed.avg_sources_consulted > 0, "knowledge_benchmark reports average consulted sources");
assert(typeof parsed?.avg_candidate_count === "number" && parsed.avg_candidate_count > 0, "knowledge_benchmark reports average candidate count");
assert(parsed?.archetypes?.quant?.route_accuracy === 1, "knowledge_benchmark preserves quant archetype route accuracy");
assert(parsed?.archetypes?.cms_plugin?.route_accuracy === 1, "knowledge_benchmark preserves cms_plugin archetype route accuracy");
assert(parsed?.archetypes?.content_automation?.route_accuracy === 1, "knowledge_benchmark preserves content_automation archetype route accuracy");
assert(Array.isArray(parsed?.scenarios) && parsed.scenarios.some((scenario) => scenario.id === "quant_upside_sme" && scenario.actual.entrypoint === "/sme-improvement"), "knowledge_benchmark includes quant upside scenario details");
assert(Array.isArray(parsed?.scenarios) && parsed.scenarios.some((scenario) => scenario.id === "plugin_config_guardrails" && scenario.actual.entrypoint === "/safe-change-power"), "knowledge_benchmark includes plugin config scenario details");
assert(Array.isArray(parsed?.scenarios) && parsed.scenarios.some((scenario) => scenario.id === "content_automation_steward" && scenario.actual.entrypoint === "/steward"), "knowledge_benchmark includes content automation scenario details");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
