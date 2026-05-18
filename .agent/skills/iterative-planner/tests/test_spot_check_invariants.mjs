#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;

const bootstrapScript = join(skillDir, "scripts", "bootstrap.mjs");
const ruleEngineScript = join(skillDir, "scripts", "rule_engine.mjs");

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

function runNode(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJsonOutput(output) {
  const text = String(output || "");
  const start = text.indexOf("{");
  assert(start !== -1, "command emits parseable JSON payload");
  return start === -1 ? null : JSON.parse(text.slice(start));
}

function makeFixture(name, state = "REFLECT") {
  const tmp = mkdtempSync(join(tmpdir(), `spot-check-invariants-${name}-`));
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");
  const bootstrap = runNode([bootstrapScript, "new", `spot-check invariant fixture ${name}`], tmp);
  assert(bootstrap.ok, `bootstrap new succeeds for ${name}`);
  const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  const planDir = join(tmp, "plans", planName);
  const statePath = join(planDir, "state.json");
  const stateJson = JSON.parse(readFileSync(statePath, "utf-8"));
  stateJson.state = state;
  writeFileSync(statePath, JSON.stringify(stateJson, null, 2) + "\n");
  mkdirSync(join(tmp, "reports", "spot_checks", planName), { recursive: true });
  return { tmp, planName };
}

function writeFindings(tmp, planName, findings, acks = null) {
  const dir = join(tmp, "reports", "spot_checks", planName);
  const normalized = findings.map((finding, index) => ({
    schema_version: 1,
    id: finding.id || `SCF-${index + 1}`,
    plan_id: planName,
    file: finding.file || "src/feature.js",
    line: finding.line || index + 1,
    severity: finding.severity || "LOW",
    category: finding.category || "bug_patterns",
    message: finding.message || "Fixture finding",
    suggestion: finding.suggestion || "Fixture suggestion",
    confidence: "HIGH",
    category_detector_version: "fixture_v1",
    recurrence: finding.recurrence || 1,
    fingerprint: finding.fingerprint || `fixture-${index + 1}`,
    acknowledged: false,
    created_at: "2026-04-26T10:00:00.000Z",
    retention_class: 3,
  }));
  writeFileSync(join(dir, "findings.jsonl"), normalized.map((finding) => JSON.stringify(finding)).join("\n") + "\n");
  if (acks) writeFileSync(join(dir, "acks.json"), JSON.stringify(acks, null, 2) + "\n");
}

function blockerNames(payload) {
  return new Set((payload?.blockers || []).map((entry) =>
    typeof entry === "string" ? entry : entry?.functor
  ).filter(Boolean));
}

function invariantViolations(tmp, target, name) {
  const { session } = createSemanticEngine({
    cwd: tmp,
    skillPath: skillDir,
    refreshOntology: true,
  });
  session.consult(`semantic_transition_target(${target}).`);
  return session.queryAll(`invariant_violated(${name}, Detail)`);
}

function invariantWarnings(tmp, name) {
  const { session } = createSemanticEngine({
    cwd: tmp,
    skillPath: skillDir,
    refreshOntology: true,
  });
  return session.queryAll(`invariant_warning(${name}, Detail)`);
}

function scenarioHighTestAdequacyBlocksValidateUntilAcked() {
  const { tmp, planName } = makeFixture("validate", "REFLECT");
  try {
    writeFindings(tmp, planName, [
      { id: "SCF-TEST", severity: "HIGH", category: "test_adequacy", file: "tests/feature.test.js" },
    ]);
    const blocked = invariantViolations(tmp, "validate", "high_test_adequacy_spot_check_blocks_validate");
    assert(blocked.length > 0, "I-053 blocks VALIDATE on unacknowledged HIGH test_adequacy findings");
    assert(blocked.length === 1, "I-053 reports exactly one blocker for one unacknowledged finding");
    assert(String(blocked[0]?.Detail || blocked[0]?.detail || "").includes("SCF-TEST"), "I-053 detail includes finding id");
    assert((blocked[0]?.Detail || blocked[0]?.detail) === "SCF-TEST", "I-053 detail identifies the exact finding");

    writeFindings(tmp, planName, [
      { id: "SCF-TEST", severity: "HIGH", category: "test_adequacy", file: "tests/feature.test.js" },
    ], {
      "SCF-TEST": {
        finding_id: "SCF-TEST",
        category: "test_adequacy",
        severity: "HIGH",
        fingerprint: "fixture-1",
        acked_at: "2026-04-26T10:01:00.000Z",
        note: "acknowledged in fixture",
      },
    });
    const acked = invariantViolations(tmp, "validate", "high_test_adequacy_spot_check_blocks_validate");
    assert(acked.length === 0, "I-053 clears after the finding is acknowledged");
    const closeStillClean = invariantViolations(tmp, "close", "high_test_adequacy_spot_check_blocks_validate");
    assert(closeStillClean.length === 0, "I-053 remains clear for acknowledged finding at CLOSE target");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioHighFindingsBlockCloseUntilAcked() {
  const { tmp, planName } = makeFixture("close", "VALIDATE");
  try {
    writeFindings(tmp, planName, [
      { id: "SCF-HIGH", severity: "HIGH", category: "bug_patterns" },
    ]);
    const blocked = invariantViolations(tmp, "close", "high_spot_check_unacknowledged_before_close");
    assert(blocked.length > 0, "I-052 blocks CLOSE on any unacknowledged HIGH spot-check finding");
    assert(blocked.length === 1, "I-052 reports exactly one blocker for one unacknowledged HIGH finding");
    assert(String(blocked[0]?.Detail || blocked[0]?.detail || "").includes("SCF-HIGH"), "I-052 detail includes finding id");
    assert((blocked[0]?.Detail || blocked[0]?.detail) === "SCF-HIGH", "I-052 detail identifies the exact finding");

    writeFindings(tmp, planName, [
      { id: "SCF-HIGH", severity: "HIGH", category: "bug_patterns" },
    ], {
      "SCF-HIGH": {
        finding_id: "SCF-HIGH",
        category: "bug_patterns",
        severity: "HIGH",
        fingerprint: "fixture-1",
        acked_at: "2026-04-26T10:01:00.000Z",
        note: "acknowledged in fixture",
      },
    });
    const acked = invariantViolations(tmp, "close", "high_spot_check_unacknowledged_before_close");
    assert(acked.length === 0, "I-052 clears after the finding is acknowledged");
    const validateTarget = invariantViolations(tmp, "validate", "high_spot_check_unacknowledged_before_close");
    assert(validateTarget.length === 0, "I-052 does not fire at VALIDATE target");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPersistentRecurrenceWarns() {
  const { tmp, planName } = makeFixture("persistent", "EXECUTE");
  try {
    writeFindings(tmp, planName, Array.from({ length: 5 }, (_, index) => ({
      id: `SCF-LOW-${index + 1}`,
      severity: "LOW",
      category: "left_behind_artifacts",
      fingerprint: `debug-${index + 1}`,
    })));
    const warnings = invariantWarnings(tmp, "persistent_spot_check_recurrence");
    assert(warnings.length > 0, "I-054 warns on persistent unacknowledged spot-check recurrence");
    assert(warnings.length === 1, "I-054 reports one recurrence warning per repeated category");
    assert(String(warnings[0]?.Detail || warnings[0]?.detail || "").includes("left_behind_artifacts"), "I-054 detail includes recurring category");
    assert((warnings[0]?.Detail || warnings[0]?.detail) === "left_behind_artifacts", "I-054 detail identifies the recurring category");
    const noCloseBlock = invariantViolations(tmp, "close", "high_spot_check_unacknowledged_before_close");
    assert(noCloseBlock.length === 0, "LOW recurrence warnings do not become HIGH close blockers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nSpot Check Invariants\n");

scenarioHighTestAdequacyBlocksValidateUntilAcked();
scenarioHighFindingsBlockCloseUntilAcked();
scenarioPersistentRecurrenceWarns();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
