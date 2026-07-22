#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { writeStateJson } from "../scripts/lib/determinism.mjs";

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
  writeStateJson(planDir, stateJson);
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    stories: [
      {
        id: "US-SPOT-001",
        title: "Spot-check invariant fixture",
        priority: "HIGH",
        status: "ACTIVE",
        code_refs: ["src/feature.js"],
        test_refs: ["tests/feature.test.js"],
        doc_refs: ["README.md"],
        validation_refs: ["reports/spot-check-fixture.json"],
      },
    ],
  }, null, 2) + "\n");
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

function writeHighwaterRecord(tmp, planName, highIds) {
  // Mirrors recordSpotCheckHighwater: a spot_check_highwater entry in the
  // append-only decision_log recording the HIGH finding ids that were produced.
  const artifactsDir = join(tmp, "plans", planName, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const entry = { type: "spot_check_highwater", plan_id: planName, high_finding_ids: highIds, ts: "2026-04-26T10:00:00.000Z" };
  writeFileSync(join(artifactsDir, "decision_log.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" });
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
    ], { "SCF-TEST": true });
    const bareAck = invariantViolations(tmp, "validate", "high_test_adequacy_spot_check_blocks_validate");
    assert(bareAck.length === 1, "I-053 still blocks when acks.json contains only a bare truthy ack");

    writeFindings(tmp, planName, [
      { id: "SCF-TEST", severity: "HIGH", category: "test_adequacy", file: "tests/feature.test.js" },
    ], {
      "SCF-TEST": {
        finding_id: "SCF-TEST",
        category: "test_adequacy",
        severity: "HIGH",
        fingerprint: "fixture-1",
        acked_at: "2026-04-26T10:01:00.000Z",
        note: "",
      },
    });
    const emptyNoteAck = invariantViolations(tmp, "validate", "high_test_adequacy_spot_check_blocks_validate");
    assert(emptyNoteAck.length === 1, "I-053 still blocks when ack note is empty");

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
    ], { "SCF-HIGH": true });
    const bareAck = invariantViolations(tmp, "close", "high_spot_check_unacknowledged_before_close");
    assert(bareAck.length === 1, "I-052 still blocks when acks.json contains only a bare truthy ack");

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

function scenarioManualInvariantAuditIncludesTransitionScopedSpotChecks() {
  const { tmp, planName } = makeFixture("manual-audit", "VALIDATE");
  try {
    writeFindings(tmp, planName, [
      { id: "SCF-MANUAL", severity: "HIGH", category: "bug_patterns" },
    ]);
    const result = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(!result.ok && result.status === 1, "manual check-invariants fails on transition-scoped HIGH close blockers");
    const payload = parseJsonOutput(result.stdout);
    assert(payload?.semantic_transition_targets?.includes("close"), "manual check-invariants declares the close transition target for VALIDATE state");
    const violationNames = new Set((payload?.violations || []).map((entry) => entry.name));
    assert(violationNames.has("high_spot_check_unacknowledged_before_close"), "manual check-invariants surfaces I-052 for unacknowledged HIGH spot-check findings");
    assert((payload?.violations || []).some((entry) => entry.detail === "SCF-MANUAL"), "manual check-invariants identifies the exact spot-check finding");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// I-055 (AV-4 tamper-evidence): a HIGH finding recorded in the append-only
// decision_log but deleted from reports/spot_checks/ must BLOCK, not fail open.
function scenarioDeletedHighFindingBlocksCloseAndValidate() {
  const { tmp, planName } = makeFixture("av4-deleted", "VALIDATE");
  try {
    // A HIGH finding was produced and recorded in the decision_log...
    writeHighwaterRecord(tmp, planName, ["SCF-DELETED"]);
    // ...but the findings dir was then emptied (the AV-4 delete-everything attack):
    // no findings.jsonl and no .yaml reports remain, so the old path would fail open.
    const close = invariantViolations(tmp, "close", "high_spot_check_finding_deleted");
    assert(close.length === 1, "I-055 blocks CLOSE when a recorded HIGH finding was deleted (AV-4 closed)");
    assert((close[0]?.Detail || close[0]?.detail) === "SCF-DELETED", "I-055 detail identifies the deleted finding");
    const validate = invariantViolations(tmp, "validate", "high_spot_check_finding_deleted");
    assert(validate.length === 1, "I-055 also blocks VALIDATE for a deleted HIGH finding");

    // Restoring the finding to findings.jsonl makes it readable again → clears.
    writeFindings(tmp, planName, [{ id: "SCF-DELETED", severity: "HIGH", category: "bug_patterns" }]);
    const restored = invariantViolations(tmp, "close", "high_spot_check_finding_deleted");
    assert(restored.length === 0, "I-055 clears once the recorded HIGH finding is present again (no false-red)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Guard: a plan that never recorded a highwater (no spot checks ran, or clean
// run) must NOT trip I-055 — only deletion-after-production blocks.
function scenarioNoHighwaterNeverBlocks() {
  const { tmp } = makeFixture("av4-none", "VALIDATE");
  try {
    const close = invariantViolations(tmp, "close", "high_spot_check_finding_deleted");
    assert(close.length === 0, "I-055 does not fire when no HIGH finding was ever recorded (no false-red)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nSpot Check Invariants\n");

scenarioHighTestAdequacyBlocksValidateUntilAcked();
scenarioHighFindingsBlockCloseUntilAcked();
scenarioPersistentRecurrenceWarns();
scenarioManualInvariantAuditIncludesTransitionScopedSpotChecks();
scenarioDeletedHighFindingBlocksCloseAndValidate();
scenarioNoHighwaterNeverBlocks();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
