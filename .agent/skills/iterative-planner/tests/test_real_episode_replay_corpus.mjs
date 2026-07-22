#!/usr/bin/env node
// test_real_episode_replay_corpus.mjs - real Mac mini IVE autocode replay coverage.

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildRealEpisodeScenarioFixtures,
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  loadRealEpisodeCorpus,
  validateRealEpisodeCorpus,
} from "../scripts/lib/ive_real_episode_corpus.mjs";
import {
  runIveScenarioSuite,
  writeIveScenarioReport,
} from "../scripts/lib/ive_scenario_harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` — ${details}` : ""}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectKeys(entry, keys);
  }
  return keys;
}

function collectValues(value, values = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectValues(entry, values);
    return values;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") values.push(value);
    return values;
  }
  for (const entry of Object.values(value)) collectValues(entry, values);
  return values;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function routeActions(fixtures) {
  return unique(fixtures.map((fixture) => fixture.packet.fact_routes[0]?.valid_next_action));
}

function routeStatuses(fixtures) {
  return unique(fixtures.map((fixture) => fixture.packet.fact_routes[0]?.status));
}

console.log("\nReal Mac Mini IVE Episode Replay Corpus Tests\n");

const loaded = loadRealEpisodeCorpus(DEFAULT_REAL_EPISODE_CORPUS_PATH);
const corpus = loaded.corpus;
const validation = validateRealEpisodeCorpus(corpus);

assert(existsSync(DEFAULT_REAL_EPISODE_CORPUS_PATH), "real episode corpus fixture exists");
assert(validation.ok, "real episode corpus schema validates", JSON.stringify(validation.issues.slice(0, 3)));
assert(validation.summary.episode_count >= 10, "corpus has at least 10 real episodes");
assert(validation.summary.episode_count === 14, "corpus has the planned 14 episode seed set");
assert(validation.summary.quant_guard_count >= 12, "corpus has broad quant guard coverage");
assert(
  validation.summary.knowledge_trigger_count === validation.summary.episode_count,
  "every episode has a Knowledge Trigger candidate",
);

const requiredFamilies = ["trueskill", "ipbs_ufc", "polymarket", "valueinvesting", "evolution_automation"];
for (const family of requiredFamilies) {
  assert(validation.summary.families.includes(family), `family covered: ${family}`);
}

const forbiddenKeys = new Set([
  "raw_excerpt",
  "raw_source_excerpt",
  "source_text",
  "raw_source_text",
  "copied_excerpt",
  "quote",
]);
const foundForbiddenKeys = collectKeys(corpus).filter((key) => forbiddenKeys.has(key));
assert(foundForbiddenKeys.length === 0, "corpus contains no raw source excerpt keys", foundForbiddenKeys.join(", "));

const absoluteSourcePaths = asArray(corpus.episodes)
  .flatMap((episode) => asArray(episode.source_refs))
  .map((ref) => ref.source_path)
  .filter((sourcePath) => typeof sourcePath === "string" && sourcePath.startsWith("/"));
assert(absoluteSourcePaths.length === 0, "source refs use project-relative paths");

const sourceRefHashes = asArray(corpus.episodes)
  .flatMap((episode) => asArray(episode.source_refs))
  .map((ref) => ref.source_sha256);
assert(
  sourceRefHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
  "every source ref has a 64-character sha256",
);

const corpusTextValues = collectValues(corpus);
assert(
  corpusTextValues.every((value) => !value.includes("/Users/stelios/Documents/Github/")),
  "corpus does not embed absolute local project paths",
);

const fixtures = buildRealEpisodeScenarioFixtures(corpus);
assert(fixtures.length === validation.summary.episode_count, "adapter emits one scenario fixture per episode");

for (const action of ["fix_now", "ticket_now", "run_experiment", "ask_user", "accept_limitation"]) {
  assert(routeActions(fixtures).includes(action), `route action covered: ${action}`);
}
for (const status of ["routed", "deferred_with_ticket", "accepted"]) {
  assert(routeStatuses(fixtures).includes(status), `route status covered: ${status}`);
}

const ticketRoutes = fixtures.filter((fixture) => fixture.expected.ticket_route_count === 1);
assert(ticketRoutes.length >= 4, "multiple real episodes route to Program Manager tickets");
assert(
  fixtures.some((fixture) => fixture.expected.valid_next_action === "ask_user" && fixture.expected.user_decision_required === true),
  "autocode ambiguity can require an explicit user decision",
);

const report = runIveScenarioSuite(fixtures, {
  clock: () => new Date("2026-06-10T00:00:00.000Z"),
});
const written = writeIveScenarioReport(report, {
  cwd: repoRoot,
  runId: "real-episode-replay-corpus-test",
});

assert(report.ok, "real episode replay suite passes");
assert(report.status === "PASS", "suite report status is PASS");
assert(report.summary.total === fixtures.length, "suite report counts every corpus fixture");
assert(report.summary.failed === 0, "suite report has no failed scenario expectations");
assert(report.quant_results_validation.status === "PASS", "quant results validation guard passes");
assert(report.quant_results_validation.promotion_allowed === false, "quant replay forbids promotion");
assert(report.quant_results_validation.result_claims.length === 0, "quant replay emits no result claims");
assert(
  report.quant_results_validation.checks.every((check) => check.promotion_verdict === "diagnostic_only"),
  "every quant replay remains diagnostic only",
);

const scenarioActions = unique(report.scenarios.map((scenario) => scenario.user_verdict.valid_next_action));
for (const action of ["fix_now", "ticket_now", "run_experiment", "ask_user", "accept_limitation"]) {
  assert(scenarioActions.includes(action), `suite verdict action covered: ${action}`);
}

assert(written.scenarios_exists, "scenario proof report written");
assert(written.manifest_exists, "scenario proof manifest written");

console.log("\nReport:");
console.log(`  ${written.scenarios_relpath}`);
console.log(`  ${written.manifest_relpath}`);

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
