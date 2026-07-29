#!/usr/bin/env node
// test_deterministic_findings.mjs - FI1 normalized findings bridge contract.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASELINE_PATH,
  SAMPLE_TIMESTAMP,
  buildSampleScoreboardInputs,
  buildScoreboardReport,
  loadScoreboardBaseline,
} from "../scripts/lib/scoreboard.mjs";
import {
  DEFAULT_FIXTURES_DIR,
  runRitualReplay,
} from "../scripts/lib/ritual_replay.mjs";
import {
  DETERMINISTIC_FINDING_SCHEMA_VERSION,
  findingsFromProjectHealthReport,
  findingsFromRuleEngineReport,
  makeDeterministicFinding,
} from "../scripts/lib/deterministic_findings.mjs";
import { runConformance } from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const repoRoot = resolve(skillRoot, "..", "..", "..");
const NODE = process.execPath;

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    assert.fail(`${label} emitted invalid JSON: ${error.message}`);
  }
}

function runJson(command, args) {
  return spawnSync(NODE, [command, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 25 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
}

const directFinding = makeDeterministicFinding({
  sourceRun: {
    surface: "unit",
    run_id: "unit-run",
    run_receipt_path: "reports/unit/run.json",
  },
  severity: "regression",
  title: "Unit finding",
  failingSuiteId: "unit-suite",
  failingCheckId: "unit-check",
  evidenceRefs: {
    stdout_log_path: "reports/unit/stdout.log",
    offending_files: ["src/example.mjs", "src/example.mjs"],
    measured_scores: { quality_score: 0.4 },
    verification_command: "node unit.mjs",
  },
});
assert.equal(directFinding.schema_version, DETERMINISTIC_FINDING_SCHEMA_VERSION);
assert.equal(directFinding.severity, "error");
assert.equal(directFinding.advisory_only, true);
assert.deepEqual(directFinding.evidence_refs.offending_files, ["src/example.mjs"]);
assert.equal(directFinding.evidence_refs.log_path, "reports/unit/stdout.log");
assert.equal(directFinding.verification.command, "node unit.mjs");

const tmp = mkdtempSync(join(tmpdir(), "deterministic-findings-"));
try {
  const suite = {
    id: "unit-failing-suite",
    name: "unit-failing-suite",
    category: "structured_plan",
    label: "Unit failing suite",
    required: true,
    command: ["node", "unit-failing-suite.mjs"],
    display_command: "node unit-failing-suite.mjs",
    phases: ["fi1"],
    fixtures: [],
    changed_file_patterns: [],
  };
  const report = runConformance({
    suites: [suite],
    phase: "fi1",
    executeCommand: () => ({
      id: suite.id,
      category: suite.category,
      label: suite.label,
      required: true,
      command: suite.display_command,
      status: "FAIL",
      exit_code: 17,
      timed_out: false,
      started_at: "2026-07-08T00:00:00.000Z",
      finished_at: "2026-07-08T00:00:00.001Z",
      stdout_excerpt: "stdout excerpt",
      stderr_excerpt: "stderr excerpt",
      raw_stdout: "full stdout",
      raw_stderr: "full stderr",
    }),
    writeManifest: true,
    runId: "unit-findings-run",
    repoRoot: tmp,
    reportRoot: join(tmp, "reports", "ive", "test_runs"),
  });
  assert.equal(report.status, "FAIL");
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.source_run.surface, "ive_conformance");
  assert.equal(finding.failing_suite_id, "unit-failing-suite");
  assert.equal(finding.failing_check_id, "required_suite_failed");
  assert.equal(finding.evidence_refs.run_receipt_path, "reports/ive/test_runs/unit-findings-run/manifest.json");
  assert.equal(finding.evidence_refs.stdout_log_path, "reports/ive/test_runs/unit-findings-run/logs/unit-failing-suite.stdout.log");
  assert.equal(finding.verification.command, "node unit-failing-suite.mjs");
  assert(existsSync(join(tmp, finding.evidence_refs.stdout_log_path)), "IVE finding stdout log path is real");
  const manifest = parseJson(readFileSync(join(tmp, "reports", "ive", "test_runs", "unit-findings-run", "manifest.json"), "utf-8"), "IVE manifest");
  assert.equal(manifest.findings?.[0]?.id, finding.id);
  assert.equal(manifest.findings?.[0]?.advisory_only, true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const baseline = loadScoreboardBaseline(DEFAULT_BASELINE_PATH, { cwd: repoRoot }).document;
const passInputs = buildSampleScoreboardInputs({ baseline, generatedAt: SAMPLE_TIMESTAMP });
const passScoreboard = buildScoreboardReport({
  baseline,
  inputs: passInputs,
  runId: "unit-scoreboard-pass",
  generatedAt: SAMPLE_TIMESTAMP,
  baselinePath: DEFAULT_BASELINE_PATH,
});
assert.equal(passScoreboard.status, "PASS");
assert.deepEqual(passScoreboard.findings, []);

const failingInputs = buildSampleScoreboardInputs({
  baseline,
  generatedAt: SAMPLE_TIMESTAMP,
  injectSeededRegression: true,
});
const failingScoreboard = buildScoreboardReport({
  baseline,
  inputs: failingInputs,
  runId: "unit-scoreboard-fail",
  generatedAt: SAMPLE_TIMESTAMP,
  baselinePath: DEFAULT_BASELINE_PATH,
  artifactPath: join(repoRoot, "reports", "ive", "scoreboard", "unit-scoreboard-fail", "scoreboard.json"),
});
const seededFinding = failingScoreboard.findings.find((entry) => entry.failing_check_id === "seeded_defect_catch_rate_regression");
assert(seededFinding, "scoreboard seeded regression emits normalized finding");
assert.equal(seededFinding.source_run.surface, "scoreboard");
assert.equal(seededFinding.evidence_refs.run_receipt_path, "reports/ive/scoreboard/unit-scoreboard-fail/scoreboard.json");
assert.equal(seededFinding.measured_scores.quality_score, failingScoreboard.scores.quality_score.current);
assert.match(seededFinding.verification.command, /scoreboard\.mjs --json/);

const strictRitual = runRitualReplay({
  fixturesDir: DEFAULT_FIXTURES_DIR,
  maxCurrentRitualTransitionRatePct: 1,
});
const ritualFinding = strictRitual.findings.find((entry) => entry.failing_check_id === "ritual_replay_current_ritual_transition_rate_pct");
assert(ritualFinding, "ritual replay budget breach emits normalized finding");
assert.equal(ritualFinding.source_run.surface, "ritual_replay");
assert.match(ritualFinding.verification.command, /ritual_replay\.mjs --json/);

const ruleFindings = findingsFromRuleEngineReport({
  violations: [{ name: "story_gap", detail: "missing story" }],
  warnings: [{ name: "coverage_thin", detail: "coverage warning" }],
});
assert.equal(ruleFindings.length, 2);
assert(ruleFindings.some((entry) => entry.severity === "error" && entry.failing_check_id === "story_gap"));
assert(ruleFindings.some((entry) => entry.severity === "warning" && entry.failing_check_id === "coverage_thin"));

const healthFindings = findingsFromProjectHealthReport({
  generated_at: SAMPLE_TIMESTAMP,
  commit: "abcdef0",
  findings: [{
    severity: "fail",
    analyzer: "doc_references",
    message: "Broken reference",
    location: "docs/missing.md",
    count: 2,
  }],
});
assert.equal(healthFindings.length, 1);
assert.equal(healthFindings[0].source_run.surface, "project_health");
assert.deepEqual(healthFindings[0].evidence_refs.offending_files, ["docs/missing.md"]);
assert.equal(healthFindings[0].measured_scores.count, 2);

const ruleCli = runJson(join(skillRoot, "scripts", "rule_engine.mjs"), ["check-invariants", "--json"]);
assert([0, 1].includes(ruleCli.status), "rule_engine check-invariants exits with verdict status");
const ruleCliJson = parseJson(ruleCli.stdout, "rule_engine check-invariants");
assert(Array.isArray(ruleCliJson.findings), "rule_engine JSON exposes normalized findings array");
assert(typeof ruleCliJson.warning_count === "number", "rule_engine JSON exposes warning count");

const healthCli = runJson(join(skillRoot, "scripts", "project_health.mjs"), ["--quick", "--json"]);
assert([0, 1].includes(healthCli.status), "project_health quick exits with verdict status");
const healthCliJson = parseJson(healthCli.stdout, "project_health quick");
assert(Array.isArray(healthCliJson.normalized_findings), "project_health JSON exposes normalized findings array");
assert(
  healthCliJson.normalized_findings.every((entry) => entry.advisory_only === true),
  "project_health normalized findings remain advisory-only",
);

console.log("deterministic_findings: PASS");
