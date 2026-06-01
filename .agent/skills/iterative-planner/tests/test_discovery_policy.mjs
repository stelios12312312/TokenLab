#!/usr/bin/env node
// test_discovery_policy.mjs — bounded repo-local discovery policy coverage.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { loadDiscoveryPolicy } from "../scripts/knowledge_resolver.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");

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

function scenarioDefaultsWhenNoPolicyExists() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-discovery-policy-"));
  try {
    const policy = loadDiscoveryPolicy({ cwd: tmp });
    assert(policy.present === false, "loadDiscoveryPolicy reports no file when planner.discovery.json is absent");
    assert(policy.policy.enabled_matchers.length === 0, "fuzzy matcher families stay disabled by default");
    assert(policy.policy.search_policy.allow_tier2 === true, "tier2 stays enabled by default");
    assert(policy.policy.search_policy.prefer_early_stop === true, "early-stop stays enabled by default");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioNormalizationAndFiltering() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-discovery-policy-"));
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      archetype: "quant",
      enabled_matchers: ["workflow_hint_ranking", "unknown", "story_adjacency"],
      disabled_matchers: ["entity_matching"],
      thresholds: { workflow_hint_ranking: 0.81 },
      search_policy: { allow_tier2: false, prefer_early_stop: false },
      preferred_workflows: ["/steward", "/safe-change-power"],
      preferred_personas: ["quant", "traceability"],
      preferred_recipes: ["walk-forward-daily"],
      required_secondary_signals: ["multi_surface_files"],
    }, null, 2));
    const policy = loadDiscoveryPolicy({ cwd: tmp });
    assert(policy.present === true && policy.usable === true, "planner.discovery.json loads cleanly when valid");
    assert(policy.policy.archetype === "quant", "policy preserves archetype");
    assert(policy.policy.enabled_matchers.includes("workflow_hint_ranking"), "allowed matcher families are preserved");
    assert(!policy.policy.enabled_matchers.includes("unknown"), "unknown matcher families are filtered out");
    assert(policy.policy.disabled_matchers.includes("entity_matching"), "disabled matcher families are normalized");
    assert(policy.policy.thresholds.workflow_hint_ranking === 0.81, "custom matcher thresholds are preserved");
    assert(policy.policy.search_policy.allow_tier2 === false, "repo policy can disable tier2");
    assert(policy.policy.search_policy.prefer_early_stop === false, "repo policy can disable early-stop");
    assert(policy.policy.preferred_workflows.includes("/steward"), "preferred workflows are preserved");
    assert(policy.policy.required_secondary_signals.includes("multi_surface_files"), "required secondary signals are preserved");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInvalidJsonFallsBackSafely() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-discovery-policy-"));
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), "{ invalid json }\n");
    const policy = loadDiscoveryPolicy({ cwd: tmp });
    assert(policy.present === true && policy.usable === false, "invalid planner.discovery.json is marked unusable");
    assert(policy.error === "invalid_json", "invalid planner.discovery.json returns invalid_json");
    assert(policy.policy.enabled_matchers.length === 0, "invalid planner.discovery.json falls back to safe matcher defaults");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioDefaultsWhenNoPolicyExists();
scenarioNormalizationAndFiltering();
scenarioInvalidJsonFallsBackSafely();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
