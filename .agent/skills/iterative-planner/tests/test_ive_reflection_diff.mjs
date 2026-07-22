#!/usr/bin/env node
// test_ive_reflection_diff.mjs - IVE Phase 4/4.6 structured evidence contracts.

import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules, loadStateFacts, loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import {
  REQUIRED_GENERATOR_PREDICATES,
  buildPredicateCoverage,
  compileIveReflectionDiffFacts,
  compileStructuredEvidence,
  evaluateGeneratorPredicateCoverage,
  evaluateReflectionDiff,
  lintLearningNote,
} from "../scripts/lib/ive_reflection_diff.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const rendererCli = join(skillDir, "scripts", "reflection_renderer.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function baseStructuredTelemetry() {
  const telemetry = {
    schema_version: 1,
    ive_phase4_required: true,
    ive_phase4_6_required: true,
    generated_at: "2026-06-01T12:00:00.000Z",
    anchors: [
      {
        id: "CA-IVE-P4-STRUCTURED-EVIDENCE",
        status: "delivered",
        evidence_refs: [".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs"],
      },
    ],
    acceptance_criteria: [
      {
        id: "AC-T-INTAKE-FB889508",
        status: "satisfied",
        evidence_refs: [".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs"],
      },
    ],
    pre_mortem_risks: [
      {
        id: "RISK-PROSE-PATCH",
        status: "addressed",
        mitigation_refs: ["CA-IVE-P4-STRUCTURED-EVIDENCE"],
      },
    ],
    verification_rows: [
      {
        id: "VM-T-INTAKE-FB889508",
        status: "pass",
        command: "node .agent/skills/iterative-planner/tests/ive/run.mjs --phase 4,4.6",
        evidence_refs: [".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs"],
      },
    ],
    telemetry: [
      {
        id: "METRIC-REFLECTION-DIFF",
        metric_id: "generated_artifact_count",
        actual: 4,
        threshold: ">=4",
        evidence_refs: [".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs"],
      },
    ],
    red_team_notes: [
      {
        id: "RT-CLAIM-CONFABULATION",
        perspective: "false_green",
        status: "mitigated",
        evidence_refs: ["CA-IVE-P4-STRUCTURED-EVIDENCE"],
      },
    ],
    session_claims: [
      {
        id: "CLAIM-STRUCTURED-EVIDENCE",
        severity: "critical",
        text: "CA-IVE-P4-STRUCTURED-EVIDENCE is supported by .agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs.",
        refs: ["CA-IVE-P4-STRUCTURED-EVIDENCE"],
      },
    ],
    learning_note: "Structured telemetry should stay the proof source.",
  };
  return stampRunRecordPayload(telemetry, {
    producer: "verification_runner",
    row_id: "VM-IVE-REFLECTION-DIFF",
    command: "node .agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs",
    exit_code: 0,
    timestamp: "2026-06-03T12:00:00.000Z",
  });
}

function issueCodes(report) {
  return new Set((report.issues || []).map((issue) => issue.code));
}

function writeFixturePlan(structuredTelemetry) {
  const tmp = makeTemp("ive-reflection-");
  const planName = "plan_ive_reflection_fixture";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(join(tmp, "plans"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  mkdirSync(planDir, { recursive: true });

  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    stories: [
      {
        id: "US-077",
        title: "Ontology as discipline layer",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/ive/run.mjs"],
      },
    ],
  }, null, 2));
  writeFileSync(join(planDir, "structured_telemetry.json"), `${JSON.stringify(structuredTelemetry, null, 2)}\n`);
  writeFileSync(join(planDir, "plan.md"), [
    "## Problem Statement",
    "Verify IVE phase 4 and 4.6 structured evidence contracts.",
    "",
    "## Files To Modify",
    "- .agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs",
    "",
    "## Verification Strategy",
    "| Criterion | Story linkage | Check | Pass means |",
    "| --- | --- | --- | --- |",
    "| sc_1 | US-077 | node .agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs | PASS |",
  ].join("\n"));
  writeStateJson(planDir, createInitialStateJson(planName, "IVE reflection fixture", { projectRoot: tmp }));
  return { tmp, planDir };
}

function loadFixtureSession(fixture) {
  const session = createSession();
  loadRules(session, { cwd: fixture.tmp, skillPath: skillDir });
  loadStoryFacts(session, { cwd: fixture.tmp });
  loadStateFacts(session, { cwd: fixture.tmp, skillPath: skillDir });
  return session;
}

console.log("\nIVE Reflection Diff Tests\n");

function testValidStructuredTelemetryPasses() {
  const report = evaluateReflectionDiff(baseStructuredTelemetry());
  assert(report.required && report.status === "PASS", "valid structured telemetry passes");
  assert(report.counts.anchors === 1 && report.counts.verification_rows === 1 && report.counts.telemetry_rows === 1, "valid report records structured ledger counts");
}

function testGeneratedArtifactsComeFromLedgers() {
  const compiled = compileStructuredEvidence(baseStructuredTelemetry());
  assert(compiled.progress_md.includes("CA-IVE-P4-STRUCTURED-EVIDENCE"), "generated progress lists anchor evidence");
  assert(compiled.verification_md.includes("VM-T-INTAKE-FB889508") && compiled.verification_md.includes("Status: PASS"), "generated verification lists row status");
  assert(compiled.red_team_notes_md.includes("Attack:") && compiled.red_team_notes_md.includes("Mitigation:"), "generated red-team notes use deterministic vector shape");
  assert(compiled.reflection_md.includes("## Anchors") && compiled.reflection_md.includes("## Unsubstantiated"), "generated reflection contains required diff sections");
}

function testPredicateCoverageFailsClosed() {
  const coverage = buildPredicateCoverage();
  const coverageReport = evaluateGeneratorPredicateCoverage(coverage);
  assert(coverageReport.status === "PASS" && coverageReport.required_predicates.length === REQUIRED_GENERATOR_PREDICATES.length, "complete predicate coverage passes");

  const broken = deepClone(baseStructuredTelemetry());
  broken.generator_predicate_coverage = {
    schema_version: 1,
    mappings: [{ predicate: "progress_complete" }],
  };
  const report = evaluateReflectionDiff(broken);
  assert(issueCodes(report).has("generator_predicate_unmapped"), "missing generator predicate mapping fails closed");
}

function testReflectionDiffFailures() {
  const missingAnchor = baseStructuredTelemetry();
  missingAnchor.anchors[0].status = "planned";
  missingAnchor.anchors[0].evidence_refs = [];
  assert(issueCodes(evaluateReflectionDiff(missingAnchor)).has("planned_anchor_not_delivered"), "undelivered planned anchor fails reflection diff");

  const unmetAcceptance = baseStructuredTelemetry();
  unmetAcceptance.acceptance_criteria[0].status = "open";
  unmetAcceptance.acceptance_criteria[0].evidence_refs = [];
  assert(issueCodes(evaluateReflectionDiff(unmetAcceptance)).has("acceptance_unmet"), "unmet acceptance criterion fails reflection diff");

  const unresolvedRisk = baseStructuredTelemetry();
  unresolvedRisk.pre_mortem_risks[0].status = "open";
  unresolvedRisk.pre_mortem_risks[0].mitigation_refs = [];
  assert(issueCodes(evaluateReflectionDiff(unresolvedRisk)).has("pre_mortem_risk_unresolved"), "unresolved pre-mortem risk fails reflection diff");

  const missingVerification = baseStructuredTelemetry();
  missingVerification.verification_rows[0].evidence_refs = [];
  missingVerification.verification_rows[0].command = "";
  assert(issueCodes(evaluateReflectionDiff(missingVerification)).has("verification_row_missing_evidence"), "verification row with no evidence fails reflection diff");

  const missingTelemetry = baseStructuredTelemetry();
  delete missingTelemetry.telemetry[0].actual;
  assert(issueCodes(evaluateReflectionDiff(missingTelemetry)).has("telemetry_missing"), "metric without actual telemetry fails reflection diff");
}

function testHandAuthoredDeliveredTelemetryWithoutRunRecordFails() {
  const forged = baseStructuredTelemetry();
  delete forged.run_record;
  forged.anchors[0].evidence_refs = ["missing/proof.mjs#missingSymbol"];
  forged.acceptance_criteria[0].evidence_refs = ["missing/acceptance.json"];
  forged.verification_rows[0].evidence_refs = ["missing/verification.log"];
  forged.telemetry[0].evidence_refs = ["missing/metric.json"];

  const report = evaluateReflectionDiff(forged);
  const codes = issueCodes(report);
  assert(report.status === "FAIL", "hand-authored delivered telemetry without runner record fails");
  assert(codes.has("run_record_missing"), "missing reflection run record is an explicit issue");
  assert(codes.has("evidence_ref_unresolved"), "fake delivered evidence refs are explicit issues");
  assert(report.required_phase4_6 === false, "phase 4.6 is not required from an agent-authored telemetry flag alone");
}

function testUnsupportedClaimsAndLearningNoteLint() {
  const unsupported = baseStructuredTelemetry();
  unsupported.session_claims[0] = {
    id: "CLAIM-FALSE-GREEN",
    severity: "critical",
    text: "Everything is completed and production ready.",
    refs: [],
  };
  assert(issueCodes(evaluateReflectionDiff(unsupported)).has("reflection_unsubstantiated"), "unsupported critical completion claim fails reflection diff");

  const noteIssues = lintLearningNote("I verified everything in MISSING-ANCHOR and completed the rollout.", new Set(["KNOWN-ANCHOR"]));
  const codes = new Set(noteIssues.map((row) => row.code));
  assert(codes.has("learning_note_completeness_claim") && codes.has("learning_note_dangling_ref"), "learning note lint rejects completeness claims and dangling refs");
}

function testFactCompilerAndPrologBridge() {
  const broken = baseStructuredTelemetry();
  broken.anchors[0].status = "planned";
  broken.anchors[0].evidence_refs = [];
  stampRunRecordPayload(broken, {
    producer: "verification_runner",
    row_id: "VM-IVE-REFLECTION-DIFF",
    command: "node .agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs",
    exit_code: 0,
    timestamp: "2026-06-03T12:05:00.000Z",
  });

  const compiled = compileIveReflectionDiffFacts({
    inputs: { structuredTelemetry: broken },
  });
  assert(compiled.facts.some((fact) => fact === "planned_anchor_not_delivered('CA-IVE-P4-STRUCTURED-EVIDENCE')."), "compiler emits planned_anchor_not_delivered fact");

  const fixture = writeFixturePlan(broken);
  try {
    const session = loadFixtureSession(fixture);
    assert(session.check("ive_phase4_6_required(true)"), "fact_loader exposes IVE phase-4.6 requirement");
    assert(session.check("invariant_violated(planned_anchor_not_delivered, 'CA-IVE-P4-STRUCTURED-EVIDENCE')"), "Prolog invariant consumes reflection-diff fact");
  } finally {
    cleanup(fixture.tmp);
  }
}

function testRendererCli() {
  const fixture = writeFixturePlan(baseStructuredTelemetry());
  try {
    const stdout = execFileSync(NODE, [rendererCli, "--plan", fixture.planDir, "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(stdout);
    assert(parsed.status === "PASS" && parsed.markdown.includes("## Telemetry"), "reflection renderer CLI emits JSON and six-section markdown");
  } finally {
    cleanup(fixture.tmp);
  }
}

testValidStructuredTelemetryPasses();
testGeneratedArtifactsComeFromLedgers();
testPredicateCoverageFailsClosed();
testReflectionDiffFailures();
testHandAuthoredDeliveredTelemetryWithoutRunRecordFails();
testUnsupportedClaimsAndLearningNoteLint();
testFactCompilerAndPrologBridge();
testRendererCli();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
