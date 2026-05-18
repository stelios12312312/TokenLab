#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  buildStructuredTestRunDocument,
  EVIDENCE_BLOCKERS,
  verifyPlanEvidence,
} from "../scripts/lib/evidence_verifier.mjs";
import { lintVerificationStrategy } from "../scripts/lib/verification_strategy.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const verificationStrategySchemaPath = join(
  plannerRoot,
  ".agent",
  "skills",
  "iterative-planner",
  "config",
  "verification_strategy.schema.json"
);

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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-verification-strategy-${name}-`));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeCoverageReport(tmp, relativePath, payload = {}) {
  const absolutePath = join(tmp, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeJson(absolutePath, {
    line_coverage: 0.95,
    branch_coverage: 0.9,
    ...payload,
  });
}

function createPlanFixture(tmp, {
  planName = "plan_2026-04-23_verification_strategy",
  criterionLabel = "Deterministic evidence contract stays backward-compatible.",
  criterionOverrides = {},
  includeEvidenceArtifacts = true,
} = {}) {
  const planDir = join(tmp, "plans", planName);
  mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  mkdirSync(join(tmp, "reports", "test_runs"), { recursive: true });
  mkdirSync(join(tmp, "src"), { recursive: true });
  mkdirSync(join(tmp, "tests"), { recursive: true });
  mkdirSync(planDir, { recursive: true });

  writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    generated_at: "2026-04-23T00:00:00.000Z",
    stories: [
      {
        id: "US-901",
        title: "Evidence-hardening fixture story",
        priority: "HIGH",
        status: "ACTIVE",
      },
    ],
  });
  writeFileSync(join(tmp, "src", "feature.js"), "export const featureFlag = true;\n");
  writeFileSync(join(tmp, "tests", "test_feature.mjs"), `import assert from "node:assert/strict";

export function runFeatureTest() {
  const actual = 1;
  assert(actual === 1);
}
`);
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Keep evidence verification deterministic and backward-compatible

## Problem Statement
Strategy lint and structured test-run verification should catch false completion without breaking legacy plans.

## Files To Modify
- src/feature.js
- tests/test_feature.mjs

## Success Criteria
1. ${criterionLabel}

## Verification Strategy
Canonical verification contract lives in \`verification_strategy.yaml\`.
`);

  const document = {
    verification_strategy: {
      version: 1,
      plan_id: planName,
      created_at: "2026-04-23T10:00:00.000Z",
      updated_at: "2026-04-23T10:00:00.000Z",
      repo_system_context: "Planner-core verification strategy and deterministic evidence contract.",
      verification_obligation_synthesis: {
        summary: "Prove evidence artifacts stay optional while structured test-output contracts are enforceable when declared.",
        scope: "verification strategy lint plus structured test-run verification",
        non_goals: [],
        dependencies: ["story_registry.json", "reports/test_runs"],
      },
      criteria: [
        {
          id: "CRIT-001",
          criterion: criterionLabel,
          story_id: "US-901",
          repo_system_context: "Evidence-aware criterion fixture",
          required_proof_type: "proof:integration_smoke",
          implementation: {
            file: "src/feature.js",
            lines: "1-10",
            function: null,
          },
          acceptance: [criterionLabel],
          tests: [
            {
              name: "runFeatureTest",
              file: "tests/test_feature.mjs",
              type: "integration",
            },
          ],
          ...(includeEvidenceArtifacts
            ? {
              evidence_artifacts: [
                {
                  type: "test_output",
                  path: `reports/test_runs/${planName}_2026-04-23T10-00-00-000Z.yaml`,
                  assert_all_passed: true,
                },
              ],
            }
            : {}),
          concrete_action: {
            type: "command",
            command: "node .agent/skills/iterative-planner/tests/test_verification_strategy.mjs",
            procedure: null,
            reviewer_persona: null,
          },
          how_verified: "integration_test",
          pass_means: "The declared structured test run proves the named test executed and passed.",
          what_remains_unverified: null,
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
          ...criterionOverrides,
        },
      ],
    },
  };

  writeJson(join(planDir, "verification_strategy.yaml"), document);
  return { planDir, document, planName };
}

function scenarioSchemaDocumentsProofGradientFields() {
  const schema = JSON.parse(readFileSync(verificationStrategySchemaPath, "utf-8"));
  const criterionSchema = schema?.properties?.verification_strategy?.properties?.criteria?.items;
  const criterionProperties = criterionSchema?.properties || {};
  const artifactSchema = schema?.properties?.verification_strategy?.properties?.criteria?.items?.properties?.evidence_artifacts?.items;
  const artifactTypes = artifactSchema?.properties?.type?.enum || [];
  const artifactProperties = artifactSchema?.properties || {};

  assert(!!artifactSchema, "verification_strategy.schema.json documents evidence_artifacts");
  assert(artifactTypes.includes("screenshot"), "verification_strategy.schema.json includes screenshot evidence artifacts");
  assert(artifactTypes.includes("test_output"), "verification_strategy.schema.json includes structured test_output evidence artifacts");
  assert(artifactTypes.includes("coverage_report"), "verification_strategy.schema.json includes coverage_report evidence artifacts");
  assert(artifactTypes.includes("convention_satisfied"), "verification_strategy.schema.json includes convention_satisfied evidence artifacts");
  assert(Object.prototype.hasOwnProperty.call(criterionProperties, "domain"), "verification_strategy.schema.json documents criterion domain");
  assert(Object.prototype.hasOwnProperty.call(criterionProperties, "risk_level"), "verification_strategy.schema.json documents criterion risk_level");
  assert(Object.prototype.hasOwnProperty.call(criterionProperties, "required_proof_weight"), "verification_strategy.schema.json documents criterion required_proof_weight");
  assert(Object.prototype.hasOwnProperty.call(criterionProperties, "accumulated_proof_weight"), "verification_strategy.schema.json documents criterion accumulated_proof_weight");
  assert(Object.prototype.hasOwnProperty.call(criterionProperties, "proof_sufficient"), "verification_strategy.schema.json documents criterion proof_sufficient");
  assert(Object.prototype.hasOwnProperty.call(artifactProperties, "proof_type"), "verification_strategy.schema.json documents artifact proof_type");
  assert(Object.prototype.hasOwnProperty.call(artifactProperties, "convention_id"), "verification_strategy.schema.json documents convention_satisfied convention_id");
  assert(Object.prototype.hasOwnProperty.call(artifactProperties, "weight_base"), "verification_strategy.schema.json documents artifact weight_base");
  assert(Object.prototype.hasOwnProperty.call(artifactProperties, "modifiers"), "verification_strategy.schema.json documents artifact modifiers");
  assert(Object.prototype.hasOwnProperty.call(artifactProperties, "computed_weight"), "verification_strategy.schema.json documents artifact computed_weight");
}

function scenarioLintDefaultsProofGradientFields() {
  const tmp = makeTemp("lint-pass");
  try {
    const { planDir } = createPlanFixture(tmp);
    const lint = lintVerificationStrategy({ cwd: tmp, planDir });

    assert(lint.ok, "lintVerificationStrategy accepts evidence_artifacts on canonical YAML criteria");
    assert(lint?.strategy?.criteria?.[0]?.risk_level === "medium", "lintVerificationStrategy defaults risk_level to medium for legacy criteria");
    assert(lint?.strategy?.criteria?.[0]?.required_proof_weight === 4, "lintVerificationStrategy derives required_proof_weight from the default medium risk");
    assert(lint?.strategy?.criteria?.[0]?.accumulated_proof_weight === 0, "lintVerificationStrategy defaults accumulated_proof_weight to zero");
    assert(lint?.strategy?.criteria?.[0]?.proof_sufficient === false, "lintVerificationStrategy defaults proof_sufficient to false before proof is accumulated");
    assert(
      lint?.strategy?.criteria?.[0]?.evidence_artifacts?.[0]?.proof_type === null,
      "lintVerificationStrategy preserves artifact proof_type as null until later slices compute it"
    );
    assert(
      Array.isArray(lint?.strategy?.criteria?.[0]?.evidence_artifacts?.[0]?.modifiers),
      "lintVerificationStrategy defaults artifact modifiers to an array"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLintUsesDomainDefaultRiskLevel() {
  const tmp = makeTemp("lint-domain-default");
  try {
    const { planDir } = createPlanFixture(tmp, {
      criterionOverrides: {
        domain: "planner_core",
      },
    });
    const lint = lintVerificationStrategy({ cwd: tmp, planDir });

    assert(lint.ok, "lintVerificationStrategy accepts domain-tagged criteria");
    assert(lint?.strategy?.criteria?.[0]?.risk_level === "high", "lintVerificationStrategy derives risk_level from proof_weights domain defaults");
    assert(lint?.strategy?.criteria?.[0]?.required_proof_weight === 7, "lintVerificationStrategy derives required_proof_weight from the resolved domain risk");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLintRejectsInvalidEvidenceArtifactShape() {
  const tmp = makeTemp("lint-invalid-artifact");
  try {
    const { planDir, document } = createPlanFixture(tmp);
    document.verification_strategy.criteria[0].evidence_artifacts = [
      {
        type: "test_output",
        assert_all_passed: true,
      },
    ];
    writeJson(join(planDir, "verification_strategy.yaml"), document);

    const lint = lintVerificationStrategy({ cwd: tmp, planDir });
    assert(!lint.ok, "lintVerificationStrategy rejects evidence artifacts that omit required path");
    assert(
      (lint.issues || []).some((issue) => issue.includes("evidence_artifacts[].path is required")),
      "lintVerificationStrategy names the missing evidence_artifacts path field"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLintRejectsConventionArtifactWithoutConventionId() {
  const tmp = makeTemp("lint-invalid-convention-artifact");
  try {
    const { planDir, document } = createPlanFixture(tmp);
    document.verification_strategy.criteria[0].evidence_artifacts = [
      {
        type: "convention_satisfied",
        path: "reports/conventions/plan/check.yaml",
      },
    ];
    writeJson(join(planDir, "verification_strategy.yaml"), document);

    const lint = lintVerificationStrategy({ cwd: tmp, planDir });
    assert(!lint.ok, "lintVerificationStrategy rejects convention_satisfied artifacts without convention_id");
    assert(
      (lint.issues || []).some((issue) => issue.includes("convention_id is required when type=convention_satisfied")),
      "lintVerificationStrategy names missing convention_id on convention_satisfied artifacts"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLintRejectsUnknownProofGradientMetadata() {
  const tmp = makeTemp("lint-invalid-proof-gradient");
  try {
    const { planDir, document } = createPlanFixture(tmp);
    document.verification_strategy.criteria[0].risk_level = "unknown_risk";
    document.verification_strategy.criteria[0].evidence_artifacts = [
      {
        type: "test_output",
        path: `reports/test_runs/${document.verification_strategy.plan_id}_2026-04-23T10-00-00-000Z.yaml`,
        proof_type: "unknown_proof",
        weight_base: 2,
        modifiers: ["cross_module"],
        computed_weight: 3,
        assert_all_passed: true,
      },
    ];
    writeJson(join(planDir, "verification_strategy.yaml"), document);

    const lint = lintVerificationStrategy({ cwd: tmp, planDir });
    assert(!lint.ok, "lintVerificationStrategy rejects unknown proof-gradient metadata");
    assert(
      (lint.issues || []).some((issue) => issue.includes("risk_level unknown_risk must resolve in proof_weights.yaml")),
      "lintVerificationStrategy names unknown risk_level values"
    );
    assert(
      (lint.issues || []).some((issue) => issue.includes("proof_type unknown_proof must resolve in proof_weights.yaml")),
      "lintVerificationStrategy names unknown artifact proof_type values"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLintRejectsUnknownProofGradientModifier() {
  const tmp = makeTemp("lint-invalid-proof-modifier");
  try {
    const { planDir, document } = createPlanFixture(tmp);
    document.verification_strategy.criteria[0].evidence_artifacts = [
      {
        type: "test_output",
        path: `reports/test_runs/${document.verification_strategy.plan_id}_2026-04-23T10-00-00-000Z.yaml`,
        proof_type: "integration_test",
        modifiers: ["not_a_real_modifier"],
        assert_all_passed: true,
      },
    ];
    writeJson(join(planDir, "verification_strategy.yaml"), document);

    const lint = lintVerificationStrategy({ cwd: tmp, planDir });
    assert(!lint.ok, "lintVerificationStrategy rejects unknown proof-type modifier names");
    assert(
      (lint.issues || []).some((issue) => issue.includes("unknown modifier not_a_real_modifier for proof_type integration_test")),
      "lintVerificationStrategy names unknown artifact modifier values"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidenceIsOptInForLegacyCriteria() {
  const tmp = makeTemp("verify-opt-in");
  try {
    const { planDir, document } = createPlanFixture(tmp, { includeEvidenceArtifacts: false });
    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });

    assert(result.required === false, "verifyPlanEvidence stays opt-in when criteria omit evidence_artifacts");
    assert(result.ok === true, "verifyPlanEvidence does not block legacy criteria that omit evidence_artifacts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidencePassesWithStructuredTestRun() {
  const tmp = makeTemp("verify-pass");
  try {
    const { planDir, document, planName } = createPlanFixture(tmp);
    const testRun = buildStructuredTestRunDocument({
      planId: planName,
      framework: "node",
      command: "node tests/test_feature.mjs",
      tests: [
        {
          name: "runFeatureTest",
          file: "tests/test_feature.mjs",
          outcome: "passed",
          assertion_count: 1,
          output_summary: "runFeatureTest passed",
        },
      ],
      generatedAt: "2026-04-23T10:00:00.000Z",
    });
    writeJson(join(tmp, "reports", "test_runs", `${planName}_2026-04-23T10-00-00-000Z.yaml`), testRun);

    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });

    assert(result.required === true, "verifyPlanEvidence requires deterministic evidence when evidence_artifacts are declared");
    assert(result.ok === true, "verifyPlanEvidence accepts a matching structured test run");
    assert(result.criteria[0]?.accumulated_proof_weight === 4, "verifyPlanEvidence infers integration_test proof weight from the structured test output artifact");
    assert(result.criteria[0]?.proof_sufficient === true, "verifyPlanEvidence marks medium-risk inferred proof as sufficient when the threshold is met");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidenceAcceptsSatisfiedConventionArtifact() {
  const tmp = makeTemp("verify-convention-pass");
  try {
    const fixturePlanName = "plan_2026-04-23_verification_strategy";
    const { planDir, document, planName } = createPlanFixture(tmp, {
      planName: fixturePlanName,
      criterionOverrides: {
        evidence_artifacts: [
          {
            type: "test_output",
            path: `reports/test_runs/${fixturePlanName}_2026-04-23T10-00-00-000Z.yaml`,
            assert_all_passed: true,
          },
          {
            type: "convention_satisfied",
            path: `reports/conventions/${fixturePlanName}/check.yaml`,
            convention_id: "CONV-300",
            target_file: "src/feature.js",
            proof_type: "static_analysis_result",
            expected: "src/feature.js satisfies CONV-300",
          },
        ],
      },
    });
    const testRun = buildStructuredTestRunDocument({
      planId: planName,
      framework: "node",
      command: "node tests/test_feature.mjs",
      tests: [
        {
          name: "runFeatureTest",
          file: "tests/test_feature.mjs",
          outcome: "passed",
          assertion_count: 1,
          output_summary: "runFeatureTest passed",
        },
      ],
      generatedAt: "2026-04-23T10:00:00.000Z",
    });
    writeJson(join(tmp, "reports", "test_runs", `${planName}_2026-04-23T10-00-00-000Z.yaml`), testRun);
    mkdirSync(join(tmp, "reports", "conventions", planName), { recursive: true });
    writeJson(join(tmp, "reports", "conventions", planName, "check.yaml"), {
      convention_check: {
        version: 1,
        plan_id: planName,
        results: [
          {
            convention_id: "CONV-300",
            file: "src/feature.js",
            applicable: true,
            satisfied: true,
            status: "satisfied",
          },
        ],
      },
    });

    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });

    assert(result.ok === true, "verifyPlanEvidence accepts satisfied convention_satisfied artifacts");
    assert(
      result.criteria[0]?.artifacts?.some((artifact) => artifact.type === "convention_satisfied" && artifact.proof_type === "static_analysis_result"),
      "verifyPlanEvidence records convention_satisfied artifact proof metadata"
    );
    assert(result.criteria[0]?.accumulated_proof_weight === 5, "verifyPlanEvidence adds static_analysis_result weight on top of structured test proof");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidenceComputesProofWeightFromArtifacts() {
  const tmp = makeTemp("verify-proof-weight-pass");
  try {
    const fixturePlanName = "plan_2026-04-23_verification_strategy";
    const coveragePath = "reports/coverage/feature.json";
    const { planDir, document, planName } = createPlanFixture(tmp, {
      planName: fixturePlanName,
      criterionOverrides: {
        domain: "planner_core",
        evidence_artifacts: [
          {
            type: "test_output",
            path: `reports/test_runs/${fixturePlanName}_2026-04-23T10-00-00-000Z.yaml`,
            assert_all_passed: true,
          },
          {
            type: "coverage_report",
            path: coveragePath,
            minimum_line_coverage: 0.9,
            minimum_branch_coverage: 0.8,
          },
        ],
      },
    });
    const testRun = buildStructuredTestRunDocument({
      planId: planName,
      framework: "node",
      command: "node tests/test_feature.mjs",
      tests: [
        {
          name: "runFeatureTest",
          file: "tests/test_feature.mjs",
          outcome: "passed",
          assertion_count: 1,
          output_summary: "runFeatureTest passed",
        },
      ],
      generatedAt: "2026-04-23T10:00:00.000Z",
    });
    writeJson(join(tmp, "reports", "test_runs", `${planName}_2026-04-23T10-00-00-000Z.yaml`), testRun);
    writeCoverageReport(tmp, coveragePath);

    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });

    assert(result.ok === true, "verifyPlanEvidence passes when validated artifacts accumulate enough proof for a high-risk criterion");
    assert(result.criteria[0]?.required_proof_weight === 7, "verifyPlanEvidence derives the planner_core high-risk proof threshold");
    assert(result.criteria[0]?.accumulated_proof_weight === 7, "verifyPlanEvidence sums inferred proof weights across validated artifacts");
    assert(result.criteria[0]?.artifacts?.[0]?.proof_type === "integration_test", "verifyPlanEvidence infers proof_type for structured test_output artifacts");
    assert(result.criteria[0]?.artifacts?.[1]?.proof_type === "coverage_threshold_met", "verifyPlanEvidence infers proof_type for coverage artifacts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidenceBlocksInsufficientProofWeight() {
  const tmp = makeTemp("verify-proof-weight-gap");
  try {
    const { planDir, document, planName } = createPlanFixture(tmp, {
      criterionOverrides: {
        domain: "planner_core",
      },
    });
    const testRun = buildStructuredTestRunDocument({
      planId: planName,
      framework: "node",
      command: "node tests/test_feature.mjs",
      tests: [
        {
          name: "runFeatureTest",
          file: "tests/test_feature.mjs",
          outcome: "passed",
          assertion_count: 1,
          output_summary: "runFeatureTest passed",
        },
      ],
      generatedAt: "2026-04-23T10:00:00.000Z",
    });
    writeJson(join(tmp, "reports", "test_runs", `${planName}_2026-04-23T10-00-00-000Z.yaml`), testRun);

    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });
    const blocker = (result.blockers || []).find((entry) => entry.blocker === EVIDENCE_BLOCKERS.INSUFFICIENT_PROOF_WEIGHT);

    assert(!result.ok, "verifyPlanEvidence blocks high-risk criteria whose validated evidence is still underweight");
    assert(result.primary_blocker === EVIDENCE_BLOCKERS.INSUFFICIENT_PROOF_WEIGHT, "verifyPlanEvidence reports evidence_insufficient_proof_weight as the primary blocker when proof is the only gap");
    assert(blocker?.required_weight === 7, "verifyPlanEvidence reports the required proof weight on insufficient-proof blockers");
    assert(blocker?.actual_weight === 4, "verifyPlanEvidence reports the accumulated proof weight on insufficient-proof blockers");
    assert(blocker?.gap === 3, "verifyPlanEvidence reports the proof-weight gap on insufficient-proof blockers");
    assert(Array.isArray(blocker?.suggested_evidence) && blocker.suggested_evidence.length > 0, "verifyPlanEvidence suggests additional evidence when proof is insufficient");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerifyPlanEvidenceBlocksFalseCompletion() {
  const tmp = makeTemp("verify-false-completion");
  try {
    const { planDir, document, planName } = createPlanFixture(tmp);
    const testRun = buildStructuredTestRunDocument({
      planId: planName,
      framework: "node",
      command: "node tests/test_feature.mjs",
      tests: [
        {
          name: "someOtherTest",
          file: "tests/test_feature.mjs",
          outcome: "passed",
          assertion_count: 1,
          output_summary: "someOtherTest passed",
        },
      ],
      generatedAt: "2026-04-23T10:00:00.000Z",
    });
    writeJson(join(tmp, "reports", "test_runs", `${planName}_2026-04-23T10-00-00-000Z.yaml`), testRun);

    const result = verifyPlanEvidence({
      projectRoot: tmp,
      planDir,
      strategyDocument: document,
    });

    assert(!result.ok, "verifyPlanEvidence blocks false completion when the declared test never ran");
    assert(result.primary_blocker === EVIDENCE_BLOCKERS.TEST_DIDNT_RUN, "verifyPlanEvidence reports evidence_test_didnt_run as the primary blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nVerification Strategy Contract Test\n");

scenarioSchemaDocumentsProofGradientFields();
scenarioLintDefaultsProofGradientFields();
scenarioLintUsesDomainDefaultRiskLevel();
scenarioLintRejectsInvalidEvidenceArtifactShape();
scenarioLintRejectsConventionArtifactWithoutConventionId();
scenarioLintRejectsUnknownProofGradientMetadata();
scenarioLintRejectsUnknownProofGradientModifier();
scenarioVerifyPlanEvidenceIsOptInForLegacyCriteria();
scenarioVerifyPlanEvidencePassesWithStructuredTestRun();
scenarioVerifyPlanEvidenceAcceptsSatisfiedConventionArtifact();
scenarioVerifyPlanEvidenceComputesProofWeightFromArtifacts();
scenarioVerifyPlanEvidenceBlocksInsufficientProofWeight();
scenarioVerifyPlanEvidenceBlocksFalseCompletion();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
