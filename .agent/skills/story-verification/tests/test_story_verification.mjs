#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../../iterative-planner/scripts/lib/prolog.mjs";
import { extractAnnotations } from "../scripts/extract_annotations.mjs";
import { verifyAdequacy, verifyCoverage } from "../scripts/verify_coverage.mjs";
import { verifyObligations } from "../scripts/verify_obligations.mjs";
import { validateVerificationReport, writeVerificationReport } from "../scripts/report_generator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../..");
const skillRoot = resolve(__dirname, "..");
const iterativePlannerSkillRoot = join(repoRoot, ".agent", "skills", "iterative-planner");
const verifyStoriesCliPath = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "verify_stories.mjs");
const plannerCliPath = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "planner.mjs");
const iterativePlannerStoriesPath = join(iterativePlannerSkillRoot, "prolog", "stories.pl");
const iterativePlannerInvariantsPath = join(iterativePlannerSkillRoot, "prolog", "invariants.pl");
const storyRulesPath = join(skillRoot, "prolog", "story_rules.pl");
const ruleEngineGuidePath = join(iterativePlannerSkillRoot, "references", "rule-engine-guide.md");
const MIGRATED_STORY_RULE_NAMES = new Set([
  "high_priority_untested",
  "circular_dependency",
  "code_without_tests",
  "depends_on_unimplemented",
  "depends_on_retired",
  "story_conflict",
  "script_story_without_doc",
  "auth_story_untested",
  "public_endpoint_no_rate_limit_doc",
  "sensitive_data_not_reviewed",
  "perf_critical_no_benchmark",
  "list_endpoint_no_pagination",
  "transaction_no_atomicity",
  "migration_no_rollback",
]);

const LEGACY_STORY_INVARIANTS = String.raw`
invariant_violated(high_priority_untested, StoryId) :-
    story(StoryId, _, high, Status),
    Status \= retired,
    \+ test_ref(StoryId, _).

invariant_violated(circular_dependency, pair(S1, S2)) :-
    circular_dependency(S1, S2).

invariant_violated(code_without_tests, StoryId) :-
    code_ref(StoryId, _),
    \+ test_ref(StoryId, _).

invariant_violated(depends_on_unimplemented, dep(Story, Dep)) :-
    depends_on(Story, Dep),
    story(Dep, _, _, not_implemented).

invariant_violated(depends_on_retired, dep(Story, Dep)) :-
    depends_on(Story, Dep),
    story(Dep, _, _, retired).

invariant_violated(story_conflict, conflict(S1, S2, Reason)) :-
    conflict(S1, S2, Reason).

invariant_violated(capability_without_story, Script) :-
    capability(Script),
    \+ story_covers_script(_, Script).

invariant_violated(script_story_without_doc, StoryId) :-
    story_covers_script(StoryId, _),
    story(StoryId, _, _, _),
    \+ doc_ref(StoryId, _).

invariant_violated(auth_story_untested, StoryId) :-
    story_tag(StoryId, auth),
    \+ test_ref(StoryId, _).

invariant_warning(public_endpoint_no_rate_limit_doc, StoryId) :-
    story_tag(StoryId, public_api),
    \+ story_tag(StoryId, rate_limited).

invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, pii),
    \+ story_tag(StoryId, security_reviewed).
invariant_warning(sensitive_data_not_reviewed, StoryId) :-
    story_tag(StoryId, credentials),
    \+ story_tag(StoryId, security_reviewed).

invariant_warning(perf_critical_no_benchmark, StoryId) :-
    story_tag(StoryId, perf_critical),
    \+ test_ref(StoryId, benchmark).

invariant_warning(list_endpoint_no_pagination, StoryId) :-
    story_tag(StoryId, list_endpoint),
    \+ story_tag(StoryId, paginated).

invariant_warning(transaction_no_atomicity, StoryId) :-
    story_tag(StoryId, transaction),
    \+ story_tag(StoryId, atomic).

invariant_warning(migration_no_rollback, StoryId) :-
    story_tag(StoryId, migration),
    \+ story_tag(StoryId, rollback_tested).
`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${message}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${message}`);
  }
}

function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), `story-verification-${prefix}-`));
}

function writeFixture(root, relativePath, content) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function withWorkspace(name, callback) {
  const workspace = makeTemp(name);
  try {
    callback(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function buildRegistry(stories) {
  const now = "2026-04-21T00:00:00Z";
  return {
    version: 1,
    updated: now,
    updated_at: now,
    stories,
  };
}

function buildStrategy(criteria) {
  const now = "2026-04-21T00:00:00Z";
  return buildStrategyWithOverrides(criteria, {
    planId: "plan_story_verification_fixture",
    createdAt: now,
    updatedAt: now,
  });
}

function buildStrategyWithOverrides(criteria, overrides = {}) {
  const now = "2026-04-21T00:00:00Z";
  return {
    verification_strategy: {
      version: 1,
      plan_id: overrides.planId || "plan_story_verification_fixture",
      created_at: overrides.createdAt || now,
      updated_at: overrides.updatedAt || overrides.createdAt || now,
      repo_system_context: overrides.repoSystemContext || "Story verification fixture",
      verification_obligation_synthesis: {
        summary: overrides.summary || "Fixture proof",
        scope: overrides.scope || "Temp workspace",
        non_goals: [],
        dependencies: [],
      },
      criteria,
    },
  };
}

function runCommand(binary, args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(binary, args, {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
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

function runNode(args, cwd) {
  return runCommand(process.execPath, args, cwd);
}

function runGit(args, cwd) {
  return runCommand("git", args, cwd);
}

function collectDiagnostics(session, predicate, allowedNames = null) {
  return [...new Set(session.queryAll(`${predicate}(Name, Detail)`)
    .filter((entry) => !allowedNames || allowedNames.has(String(entry.Name)))
    .map((entry) => `${String(entry.Name)}::${JSON.stringify(entry.Detail)}`))]
    .sort();
}

function seedCliWorkspace(workspace) {
  const alphaPlanId = "plan_2026-04-21_cli_alpha";
  const betaPlanId = "plan_2026-04-21_cli_beta";
  const legacyPlanIds = [
    "plan_2026-04-19_cli_legacy_one",
    "plan_2026-04-20_cli_legacy_two",
  ];

  writeFixture(workspace, "reports/user_story_audit/story_registry.json", JSON.stringify(buildRegistry([
    {
      id: "US-101",
      title: "Annotated checkout flow",
      status: "FULLY_COVERED",
      acceptance_criteria: ["Accepts card"],
    },
    {
      id: "US-102",
      title: "Pending wire flow",
      status: "PARTIALLY_COVERED",
      acceptance_criteria: ["Wire controller soon"],
    },
    {
      id: "US-103",
      title: "Unrelated implemented story",
      status: "FULLY_COVERED",
      acceptance_criteria: ["This unrelated story should not poison selected-plan verification"],
    },
  ]), null, 2));

  writeFixture(workspace, "src/payment.mjs", `// @planner:story_id US-101
// @planner:tested_by payment_integration_spec
// @planner:accepts Accepts card
export function validatePayment() {
  return true;
}
`);

  writeFixture(workspace, "tests/payment.integration.test.mjs", `// @planner:story_id US-101
export function payment_integration_spec() {
  return true;
}
`);

  writeFixture(
    workspace,
    join("plans", alphaPlanId, "verification_strategy.yaml"),
    JSON.stringify(buildStrategyWithOverrides([
      {
        id: "CRIT-101",
        criterion: "Alpha checkout stays annotated",
        story_id: "US-101",
        implementation: { file: "src/payment.mjs", lines: "1-5", function: "validatePayment" },
        acceptance: ["Accepts card"],
        tests: [{ name: "payment_integration_spec", file: "tests/payment.integration.test.mjs", type: "integration" }],
        concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
        how_verified: "integration_test",
        pass_means: "Integration annotation exists",
        what_remains_unverified: "Live execution is advisory in Phase 3.1",
        persona_audit_required: false,
        persona_audit_result: null,
        waiver: null,
      },
    ], {
      planId: alphaPlanId,
      createdAt: "2026-04-21T09:00:00Z",
      updatedAt: "2026-04-21T10:00:00Z",
    }), null, 2)
  );

  writeFixture(
    workspace,
    join("plans", betaPlanId, "verification_strategy.yaml"),
    JSON.stringify(buildStrategyWithOverrides([
      {
        id: "CRIT-201",
        criterion: "Beta wire flow should land next",
        story_id: "US-102",
        implementation: { file: "src/wire.mjs", lines: "1-5", function: "buildWireFlow" },
        acceptance: ["Wire controller soon"],
        tests: [],
        concrete_action: { type: "procedure", command: null, procedure: ["Review beta wire flow"], reviewer_persona: null },
        how_verified: "manual_smoke",
        pass_means: "Waiver-backed manual smoke exists",
        what_remains_unverified: null,
        persona_audit_required: false,
        persona_audit_result: null,
        waiver: null,
      },
    ], {
      planId: betaPlanId,
      createdAt: "2026-04-21T13:00:00Z",
      updatedAt: "2026-04-21T15:00:00Z",
    }), null, 2)
  );

  for (const legacyPlanId of legacyPlanIds) {
    writeFixture(
      workspace,
      join("plans", legacyPlanId, "plan.md"),
      `# Legacy plan\n\nThis fixture intentionally omits verification_strategy.yaml so batch selectors must decide whether to skip or fail it.\n`
    );
  }

  return { alphaPlanId, betaPlanId, legacyPlanIds };
}

function scenarioExtractAnnotations() {
  withWorkspace("extract", (workspace) => {
    writeFixture(workspace, "src/payment.mjs", `// @planner:story_id US-042
// @planner:tested_by payment_integration_spec
// @planner:accepts Rejects zero
// @planner:obligation integration_test
export function validateAmount() {
  return true;
}

const ignoredString = "@planner:story_id US-999";
// This comment mentions @planner:story_id US-998 but should not parse.
`);
    writeFixture(workspace, "tests/payment.test.mjs", `// @planner:story_id US-042
// @planner:tested_by payment_integration_spec
export function payment_integration_spec() {
  return true;
}
`);
    writeFixture(workspace, "docs/example.md", `@planner:story_id US-777`);

    const result = extractAnnotations({ projectRoot: workspace });
    const sourceRecord = result.records.find((record) => record.file === "src/payment.mjs");
    const testRecord = result.records.find((record) => record.file === "tests/payment.test.mjs");

    assert(result.records.length === 2, "extractAnnotations only records real annotation comment blocks");
    assert(sourceRecord?.symbol === "validateAmount", "extractAnnotations associates source annotations with the next symbol");
    assert(sourceRecord?.tags?.story_id?.[0] === "US-042", "extractAnnotations captures story_id");
    assert(sourceRecord?.tags?.tested_by?.[0] === "payment_integration_spec", "extractAnnotations captures tested_by");
    assert(sourceRecord?.tags?.obligation?.[0] === "integration_test", "extractAnnotations captures obligation");
    assert(testRecord?.scope === "test", "extractAnnotations marks test-surface records");
    assert(!result.records.some((record) => record.file.includes("docs/")), "extractAnnotations ignores docs paths");
  });
}

function scenarioVerifyCoverage() {
  const registry = buildRegistry([
    {
      id: "US-042",
      title: "Implemented story",
      status: "FULLY_COVERED",
      acceptance_criteria: ["Rejects zero"],
    },
    {
      id: "US-043",
      title: "Active story",
      status: "PARTIALLY_COVERED",
      acceptance_criteria: ["Tracks partial coverage"],
    },
    {
      id: "US-044",
      title: "Proposed story",
      status: "NOT_IMPLEMENTED",
      acceptance_criteria: ["Future work"],
    },
    {
      id: "US-045",
      title: "Retired story",
      status: "RETIRED",
      acceptance_criteria: ["No code remains"],
    },
  ]);

  const annotations = {
    records: [
      {
        file: "src/payment.mjs",
        line: 1,
        symbol: "validateAmount",
        scope: "source",
        tags: {
          story_id: ["US-042"],
          tested_by: ["payment_integration_spec"],
          accepts: ["Rejects zero"],
        },
      },
      {
        file: "tests/payment.integration.test.mjs",
        line: 1,
        symbol: "payment_integration_spec",
        scope: "test",
        tags: {
          story_id: ["US-042"],
        },
      },
      {
        file: "src/orphan.mjs",
        line: 1,
        symbol: "orphanedFlow",
        scope: "source",
        tags: {
          story_id: ["US-999"],
        },
      },
      {
        file: "src/retired.mjs",
        line: 1,
        symbol: "legacyFlow",
        scope: "source",
        tags: {
          story_id: ["US-045"],
        },
      },
    ],
  };

  const result = verifyCoverage({ registryDocument: registry, annotations });
  const findingTypes = result.findings.map((finding) => finding.type).sort();

  assert(findingTypes.includes("ORPHANED_ANNOTATION"), "verifyCoverage reports annotated stories that are missing from the registry");
  assert(findingTypes.includes("MISSING_IMPLEMENTATION"), "verifyCoverage only requires annotations for implemented/active stories");
  assert(findingTypes.includes("STALE_RETIRED_ANNOTATION"), "verifyCoverage flags retired stories that still have annotations");
  assert(!result.findings.some((finding) => finding.story_id === "US-044"), "verifyCoverage skips NOT_IMPLEMENTED stories");
  assert(result.summary.total_findings === 3, "verifyCoverage summarizes the expected finding count");
}

function scenarioVerifyAdequacy() {
  withWorkspace("adequacy", (workspace) => {
    writeFixture(workspace, "reports/coverage/payment.json", JSON.stringify({
      line_coverage: 0.62,
      branch_coverage: 0.41,
    }, null, 2));
    writeFixture(workspace, "tests/test_1.mjs", `export function test_1() {
  assert.equal(1, 1);
}
`);
    writeFixture(workspace, "tests/reject_zero_amount_spec.mjs", `export function reject_zero_amount_spec() {
  assert(true);
}
`);
    writeFixture(workspace, "tests/archive_widget_spec.mjs", `export function archive_widget_spec() {
  expect(result).toBe(false);
}
`);

    const strategy = buildStrategy([
      {
        id: "CRIT-001",
        criterion: "Reject zero payment amounts",
        story_id: "US-042",
        implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
        acceptance: ["Reject zero payment amounts", "Reject negative payment amounts"],
        tests: [
          { name: "test_1", file: "tests/test_1.mjs", type: "unit" },
          { name: "reject_zero_amount_spec", file: "tests/reject_zero_amount_spec.mjs", type: "unit" },
          { name: "archive_widget_spec", file: "tests/archive_widget_spec.mjs", type: "integration" },
        ],
        concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
        how_verified: "integration_test",
        pass_means: "Payment validation rejects invalid amounts",
        what_remains_unverified: null,
        persona_audit_required: false,
        persona_audit_result: null,
        waiver: null,
        evidence_artifacts: [
          {
            type: "coverage_report",
            path: "reports/coverage/payment.json",
            minimum_line_coverage: 0.85,
            minimum_branch_coverage: 0.75,
          },
        ],
      },
    ]);

    const result = verifyAdequacy({
      projectRoot: workspace,
      strategyDocument: strategy,
    });
    const findingTypes = result.findings.map((finding) => finding.type);

    assert(result.ok === false, "verifyAdequacy reports deterministic adequacy gaps");
    assert(findingTypes.includes("COVERAGE_THRESHOLD_UNMET"), "verifyAdequacy flags coverage reports that miss declared thresholds");
    assert(findingTypes.includes("GENERIC_TEST_NAME"), "verifyAdequacy flags generic test names");
    assert(findingTypes.includes("TAUTOLOGICAL_ASSERTION"), "verifyAdequacy flags tautological test assertions");
    assert(findingTypes.includes("TEST_NAME_MISMATCH"), "verifyAdequacy flags tests whose names do not describe the criterion behavior");
  });
}

function scenarioVerifyObligations() {
  const annotations = {
    records: [
      {
        file: "src/payment.mjs",
        line: 1,
        symbol: "validateAmount",
        scope: "source",
        tags: {
          story_id: ["US-042"],
          tested_by: ["payment_integration_spec", "payment_unit_spec", "payment_regression_spec"],
        },
      },
      {
        file: "tests/payment.integration.test.mjs",
        line: 1,
        symbol: "payment_integration_spec",
        scope: "test",
        tags: {
          story_id: ["US-042"],
        },
      },
      {
        file: "tests/payment.unit.test.mjs",
        line: 1,
        symbol: "payment_unit_spec",
        scope: "test",
        tags: {
          story_id: ["US-042"],
        },
      },
      {
        file: "tests/payment.regression.test.mjs",
        line: 1,
        symbol: "payment_regression_spec",
        scope: "test",
        tags: {
          story_id: ["US-042"],
        },
      },
    ],
  };

  const strategy = buildStrategy([
    {
      id: "CRIT-001",
      criterion: "integration",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["integration"],
      tests: [{ name: "payment_integration_spec", file: "tests/payment.integration.test.mjs", type: "integration" }],
      concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
      how_verified: "integration_test",
      pass_means: "Integration passes",
      what_remains_unverified: null,
      persona_audit_required: false,
      persona_audit_result: null,
      waiver: null,
    },
    {
      id: "CRIT-002",
      criterion: "unit",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["unit"],
      tests: [{ name: "payment_unit_spec", file: "tests/payment.unit.test.mjs", type: "unit" }],
      concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
      how_verified: "unit_test",
      pass_means: "Unit passes",
      what_remains_unverified: null,
      persona_audit_required: false,
      persona_audit_result: null,
      waiver: null,
    },
    {
      id: "CRIT-003",
      criterion: "artifact review",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["artifact"],
      tests: [],
      concrete_action: { type: "review", command: null, procedure: ["Review report"], reviewer_persona: "ux" },
      how_verified: "artifact_review",
      pass_means: "Audit passes",
      what_remains_unverified: null,
      persona_audit_required: true,
      persona_audit_result: { audited_by: "ux", verdict: "PASS", notes: "Looks good" },
      waiver: null,
    },
    {
      id: "CRIT-004",
      criterion: "manual smoke",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["manual"],
      tests: [],
      concrete_action: { type: "procedure", command: null, procedure: ["Run smoke"], reviewer_persona: null },
      how_verified: "manual_smoke",
      pass_means: "Manual smoke completed",
      what_remains_unverified: null,
      persona_audit_required: false,
      persona_audit_result: null,
      waiver: null,
    },
    {
      id: "CRIT-005",
      criterion: "regression",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["regression"],
      tests: [{ name: "payment_regression_spec", file: "tests/payment.regression.test.mjs", type: "integration" }],
      concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
      how_verified: "regression_test",
      pass_means: "Regression passes",
      what_remains_unverified: null,
      persona_audit_required: false,
      persona_audit_result: null,
      waiver: null,
    },
    {
      id: "CRIT-006",
      criterion: "waiver",
      story_id: "US-042",
      implementation: { file: "src/payment.mjs", lines: "1-5", function: "validateAmount" },
      acceptance: ["waiver"],
      tests: [],
      concrete_action: { type: "procedure", command: null, procedure: ["Document waiver"], reviewer_persona: null },
      how_verified: "waiver_approved",
      pass_means: "Waiver present",
      what_remains_unverified: null,
      persona_audit_required: false,
      persona_audit_result: null,
      waiver: {
        reason: "Manual approval",
        approved_by: "operator",
        approved_at: "2026-04-21T00:00:00Z",
      },
    },
  ]);

  const result = verifyObligations({
    strategyDocument: strategy,
    annotations,
    testResults: {
      payment_integration_spec: { exists: true, passed: true, classification: "integration", changed_in_plan: false },
      payment_unit_spec: { exists: true, passed: true, classification: "unit", changed_in_plan: false },
      payment_regression_spec: { exists: true, passed: true, classification: "integration", changed_in_plan: true },
    },
  });

  const byId = new Map(result.findings.map((finding) => [finding.criterion_id, finding]));
    assert(byId.get("CRIT-001")?.obligation_met === true, "verifyObligations accepts integration_test when an integration test exists and passes");
    assert(byId.get("CRIT-002")?.obligation_met === true, "verifyObligations accepts unit_test when a unit test exists and passes");
    assert(byId.get("CRIT-003")?.obligation_met === true, "verifyObligations accepts artifact_review with a passing persona audit");
    assert(byId.get("CRIT-004")?.obligation_met === false, "verifyObligations rejects manual_smoke without waiver metadata");
    assert(byId.get("CRIT-005")?.obligation_met === true, "verifyObligations accepts regression_test when the test changed in the plan and passes");
    assert(byId.get("CRIT-006")?.obligation_met === true, "verifyObligations accepts waiver_approved with approved_by metadata");
}

function scenarioReportGenerator() {
  withWorkspace("report", (workspace) => {
    const validReport = {
      verification_report: {
        version: 1,
        plan_id: "plan_story_verification_fixture",
        verified_at: "2026-04-21T00:00:00Z",
        verified_by: "agent_b",
        strategy_source: "plans/plan_story_verification_fixture/verification_strategy.yaml",
        findings: [
          {
            criterion_id: "CRIT-001",
            status: "VERIFIED",
            annotation_found: "@planner:story_id US-042",
            code_matches_declared: true,
            test_exists: true,
            test_passing: true,
            acceptance_met: [
              {
                criterion: "Rejects zero",
                status: "verified",
                evidence: "payment_integration_spec passes",
              },
            ],
            obligation_met: true,
            obligation_notes: null,
          },
        ],
        summary: {
          total_criteria: 1,
          verified: 1,
          partial: 0,
          failed: 0,
          orphaned: 0,
          coverage_pct: 100,
        },
        gaps: [],
        adequacy_findings: [
          {
            criterion_id: "CRIT-001",
            plan_id: "plan_story_verification_fixture",
            story_id: "US-042",
            type: "COVERAGE_THRESHOLD_UNMET",
            severity: "HIGH",
            description: "line coverage 0.62 below minimum 0.85",
            test_name: null,
            file: "reports/coverage/payment.json",
          },
        ],
      },
    };

    const validValidation = validateVerificationReport({ reportDocument: validReport });
    assert(validValidation.ok === true, "validateVerificationReport accepts the documented report shape");

    const writeResult = writeVerificationReport({
      projectRoot: workspace,
      reportDocument: validReport,
      outputPath: join(workspace, "reports", "story_verification", "plan_story_verification_fixture_20260421T000000Z.yaml"),
      planId: "plan_story_verification_fixture",
      correlationId: "sess_story_fixture",
    });

    assert(writeResult.ok === true, "writeVerificationReport persists a valid report");
    assert(existsSync(writeResult.outputPath), "writeVerificationReport writes the valid report file");

    const invalidReport = {
      verification_report: {
        ...validReport.verification_report,
        findings: [
          {
            status: "FAILED",
            annotation_found: null,
            code_matches_declared: false,
            test_exists: false,
            test_passing: null,
            acceptance_met: [],
            obligation_met: false,
            obligation_notes: "Missing criterion_id",
          },
        ],
      },
    };

    const invalidValidation = validateVerificationReport({ reportDocument: invalidReport });
    assert(invalidValidation.ok === false, "validateVerificationReport rejects missing required finding fields");

    const invalidAdequacyReport = {
      verification_report: {
        ...validReport.verification_report,
        adequacy_findings: [
          {
            criterion_id: "CRIT-001",
            type: "UNSUPPORTED",
            severity: "HIGH",
            description: "bad adequacy type",
            test_name: null,
            file: null,
          },
        ],
      },
    };
    const invalidAdequacyValidation = validateVerificationReport({ reportDocument: invalidAdequacyReport });
    assert(invalidAdequacyValidation.ok === false, "validateVerificationReport rejects malformed adequacy findings");

    const failedWrite = writeVerificationReport({
      projectRoot: workspace,
      reportDocument: invalidReport,
      outputPath: join(workspace, "reports", "story_verification", "invalid.yaml"),
      planId: "plan_story_verification_fixture",
      correlationId: "sess_story_fixture",
    });

    assert(failedWrite.ok === false, "writeVerificationReport fails closed on invalid report input");
    assert(!existsSync(join(workspace, "reports", "story_verification", "invalid.yaml")), "writeVerificationReport does not persist invalid reports");

    const logPath = failedWrite.error_log_path;
    const errorLine = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n")[0]);
    assert(errorLine.agent === "agent_b", "writeVerificationReport emits an Agent B error log entry");
    assert(errorLine.event === "schema_validation_failed", "writeVerificationReport emits the schema_validation_failed event");
    assert(errorLine.component === "report_generator.mjs", "writeVerificationReport identifies the failing component");
  });
}

function scenarioStoryRuleSplitMatchesLegacyBundle() {
  const facts = String.raw`
story('US-100', 'Auth checkout', high, partially_covered).
code_ref('US-100', 'src/auth_checkout.mjs').
story_covers_script('US-100', 'auth_checkout.mjs').
story_tag('US-100', auth).
story_tag('US-100', public_api).
story_tag('US-100', pii).
story_tag('US-100', perf_critical).
story_tag('US-100', list_endpoint).
story_tag('US-100', transaction).
story_tag('US-100', migration).

story('US-101', 'Missing docs story', medium, partially_covered).
story_covers_script('US-101', 'missing_docs.mjs').

story('US-102', 'Not implemented dependency', medium, not_implemented).
story('US-103', 'Retired dependency', medium, retired).
requires('US-100', 'US-102').
requires('US-100', 'US-103').

story('US-104', 'Cycle A', medium, partially_covered).
story('US-105', 'Cycle B', medium, partially_covered).
requires('US-104', 'US-105').
requires('US-105', 'US-104').

story('US-106', 'Grant flow', medium, partially_covered).
story('US-107', 'Deny flow', medium, partially_covered).
postcondition('US-106', grants_access(user, dashboard)).
postcondition('US-107', denies_access(user, dashboard)).
`;

  const legacySession = createSession();
  legacySession.consultFile(iterativePlannerStoriesPath);
  legacySession.consult(LEGACY_STORY_INVARIANTS);
  legacySession.consult(facts);

  const splitSession = createSession();
  splitSession.consultFile(iterativePlannerStoriesPath);
  splitSession.consultFile(iterativePlannerInvariantsPath);
  splitSession.consultFile(storyRulesPath);
  splitSession.consult(facts);

  const legacyViolations = collectDiagnostics(legacySession, "invariant_violated", MIGRATED_STORY_RULE_NAMES);
  const splitViolations = collectDiagnostics(splitSession, "invariant_violated", MIGRATED_STORY_RULE_NAMES);
  const legacyWarnings = collectDiagnostics(legacySession, "invariant_warning", MIGRATED_STORY_RULE_NAMES);
  const splitWarnings = collectDiagnostics(splitSession, "invariant_warning", MIGRATED_STORY_RULE_NAMES);

  assert(JSON.stringify(splitViolations) === JSON.stringify(legacyViolations), "split Agent B rule bundle preserves the legacy story invariant violations");
  assert(JSON.stringify(splitWarnings) === JSON.stringify(legacyWarnings), "split Agent B rule bundle preserves the legacy story invariant warnings");
  assert(splitViolations.some((entry) => entry.includes("high_priority_untested")), "split parity fixture exercises I-001 from the migrated story bundle");
  assert(splitViolations.some((entry) => entry.includes("script_story_without_doc")), "split parity fixture exercises I-008 from the migrated story bundle");
  assert(splitWarnings.some((entry) => entry.includes("migration_no_rollback")), "split parity fixture exercises I-029 from the migrated story bundle");
}

function scenarioCapabilitySplitBoundary() {
  const facts = String.raw`
capability('planner.mjs').
planner_capability('planner.mjs').
story_covers_script('_planner_infra', 'planner.mjs').
capability('host_script.mjs').
`;

  const agentASession = createSession();
  agentASession.consultFile(iterativePlannerInvariantsPath);
  agentASession.consult(facts);
  const agentAViolations = collectDiagnostics(agentASession, "invariant_violated");

  assert(agentAViolations.length === 0, "Agent A keeps planner infrastructure covered without claiming host-script ownership");

  const combinedSession = createSession();
  combinedSession.consultFile(iterativePlannerInvariantsPath);
  combinedSession.consultFile(storyRulesPath);
  combinedSession.consult(facts);
  const combinedViolations = collectDiagnostics(combinedSession, "invariant_violated");

  assert(combinedViolations.some((entry) => entry.includes("capability_without_story_host") && entry.includes("host_script.mjs")), "Agent B owns the host-script half of the I-007 split");
  assert(!combinedViolations.some((entry) => entry.includes("capability_without_story::") && entry.includes("host_script.mjs")), "Agent A no longer reports uncovered host scripts after the I-007 split");
}

function scenarioReadOnlyBoundary() {
  const skillPath = join(repoRoot, ".agent", "skills", "story-verification", "SKILL.md");
  const workflowPath = join(repoRoot, ".agent", "workflows", "story-verification.md");
  const githubActionsPath = join(repoRoot, "docs", "ci", "github_actions.md");
  const gitlabCiPath = join(repoRoot, "docs", "ci", "gitlab.md");
  const preCommitPath = join(repoRoot, "docs", "ci", "pre_commit.md");
  const versionPath = join(repoRoot, ".agent", "version.json");
  const rootRegistryPath = join(repoRoot, "reports", "user_story_audit", "story_registry.json");
  const extractPath = join(skillRoot, "scripts", "extract_annotations.mjs");
  const coveragePath = join(skillRoot, "scripts", "verify_coverage.mjs");
  const obligationsPath = join(skillRoot, "scripts", "verify_obligations.mjs");
  const reportPath = join(skillRoot, "scripts", "report_generator.mjs");
  const verifyStoriesPath = verifyStoriesCliPath;
  const postCommitHelperPath = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "hooks", "post_commit_story_verification.mjs");

  assert(existsSync(skillPath), "story-verification SKILL remains present");
  assert(readFileSync(skillPath, "utf8").includes("read-only"), "story-verification SKILL documents the read-only boundary");
  assert(readFileSync(skillPath, "utf8").includes("advisory"), "story-verification SKILL documents the advisory role");
  assert(existsSync(storyRulesPath), "Phase 3.3 adds the Agent B story_rules.pl bundle");
  assert(readFileSync(skillPath, "utf8").includes("story_rules.pl"), "story-verification SKILL documents the Agent B Prolog bundle");
  assert(readFileSync(skillPath, "utf8").includes("post_commit_story_verification.mjs"), "story-verification SKILL documents the optional post-commit helper");
  assert(readFileSync(ruleEngineGuidePath, "utf8").includes("story-verification/prolog/story_rules.pl"), "rule-engine guide documents the Agent B story rule bundle");
  assert(existsSync(verifyStoriesPath), "verify_stories.mjs remains present");
  assert(existsSync(postCommitHelperPath), "Phase 3.4 adds the post-commit story verification helper");
  assert(existsSync(versionPath), "Phase 3.4 adds the root .agent/version.json routing surface");
  const versionDoc = JSON.parse(readFileSync(versionPath, "utf8"));
  assert(versionDoc?.planner === "v7", ".agent/version.json enables v7 routing for the current repo");
  assert((versionDoc?.agents_enabled?.agent_b_invocation || []).includes("manual_cli"), ".agent/version.json keeps manual_cli enabled for Agent B");
  assert((versionDoc?.agents_enabled?.agent_b_invocation || []).includes("post_commit_hook"), ".agent/version.json enables the Agent B post-commit hook path");
  assert(existsSync(workflowPath), "Phase 3.2 adds the story-verification workflow");
  assert(existsSync(githubActionsPath), "Phase 3.5 adds the GitHub Actions CI recipe");
  assert(existsSync(gitlabCiPath), "Phase 3.5 adds the GitLab CI recipe");
  assert(existsSync(preCommitPath), "Phase 3.5 adds the pre-commit CI recipe");
  const workflowContent = readFileSync(workflowPath, "utf8");
  const skillContent = readFileSync(skillPath, "utf8");
  assert(workflowContent.includes("read-only"), "story-verification workflow documents the read-only boundary");
  assert(workflowContent.includes("advisory"), "story-verification workflow documents the advisory role");
  assert(workflowContent.includes("verify-stories --plan <plan_id>"), "story-verification workflow documents the single-plan command");
  assert(workflowContent.includes("verify-stories --plan-from-head"), "story-verification workflow documents the HEAD plan command");
  assert(workflowContent.includes("verify-stories --staged"), "story-verification workflow documents the staged-plan command");
  assert(workflowContent.includes("--check-report"), "story-verification workflow documents report threshold re-checks");
  assert(workflowContent.includes("install-hook story-verification"), "story-verification workflow documents the optional post-commit installer");
  assert(workflowContent.includes("--since \"1 hour ago\" --quiet"), "story-verification workflow documents the scheduled batch path");
  assert(workflowContent.includes("docs/ci/github_actions.md"), "story-verification workflow points operators at the GitHub Actions recipe");
  assert(!workflowContent.includes("CI recipes still wait for Phase 3.5."), "story-verification workflow no longer claims CI is deferred");
  assert(skillContent.includes("docs/ci/"), "story-verification SKILL points readers at the shipped CI recipe docs");
  assert(readFileSync(githubActionsPath, "utf8").includes("--check-report"), "GitHub Actions recipe uses report threshold re-checks");
  assert(readFileSync(gitlabCiPath, "utf8").includes("--check-report"), "GitLab recipe uses report threshold re-checks");
  assert(readFileSync(preCommitPath, "utf8").includes("--staged --fail-on-severity HIGH"), "pre-commit recipe uses the staged HIGH-threshold command");

  for (const filePath of [extractPath, coveragePath, obligationsPath, reportPath]) {
    const content = readFileSync(filePath, "utf8");
    assert(!content.includes("bootstrap_registry.mjs"), `${filePath} does not import bootstrap_registry.mjs`);
    assert(!content.includes("initializeBootstrapRegistry"), `${filePath} does not call registry bootstrap helpers`);
    assert(!content.includes("bootstrapRegistryFromAnnotations"), `${filePath} does not write the story registry`);
  }

  const verifyStoriesContent = readFileSync(verifyStoriesPath, "utf8");
  assert(verifyStoriesContent.includes("extract_annotations.mjs"), "verify_stories.mjs imports extract_annotations");
  assert(verifyStoriesContent.includes("verify_coverage.mjs"), "verify_stories.mjs imports verify_coverage");
  assert(verifyStoriesContent.includes("verify_obligations.mjs"), "verify_stories.mjs imports verify_obligations");
  assert(verifyStoriesContent.includes("report_generator.mjs"), "verify_stories.mjs imports report_generator");
  assert(!verifyStoriesContent.includes("bootstrap_registry.mjs"), "verify_stories.mjs does not import bootstrap_registry.mjs");
  assert(!verifyStoriesContent.includes("writeFileSync("), "verify_stories.mjs does not write files directly");
  assert(!verifyStoriesContent.includes("appendFileSync("), "verify_stories.mjs does not append to arbitrary files");
  const rootRegistry = JSON.parse(readFileSync(rootRegistryPath, "utf8"));
  const workflowStory = (rootRegistry.stories || []).find((story) => story.id === "US-089");
  const ciStory = (rootRegistry.stories || []).find((story) => story.id === "US-090");
  const prologStory = (rootRegistry.stories || []).find((story) => story.id === "US-018");
  const invariantStory = (rootRegistry.stories || []).find((story) => story.id === "US-019");
  assert(!!workflowStory, "story_registry.json includes US-089 for the workflow surface");
  assert(workflowStory?.status === "FULLY_COVERED", "US-089 is fully covered once the workflow surface ships");
  assert(String(workflowStory?.title || "").includes("invocation"), "US-089 title reflects the invocation surface added in Phase 3.4");
  assert((workflowStory?.code_refs || []).includes(".agent/workflows/story-verification.md"), "US-089 maps the workflow file in code_refs");
  assert((workflowStory?.code_refs || []).includes(".agent/skills/iterative-planner/scripts/bootstrap.mjs"), "US-089 maps the bootstrap dispatcher hook surface");
  assert((workflowStory?.code_refs || []).includes(".agent/skills/iterative-planner/scripts/migrate.mjs"), "US-089 maps the migration install surface for shipped Agent B assets");
  assert((workflowStory?.code_refs || []).includes(".agent/skills/iterative-planner/scripts/hooks/post_commit_story_verification.mjs"), "US-089 maps the post-commit helper surface");
  assert((workflowStory?.code_refs || []).includes(".agent/version.json"), "US-089 maps the Agent B invocation routing file");
  assert((workflowStory?.test_refs || []).includes(".agent/skills/story-verification/tests/test_story_verification.mjs"), "US-089 maps the focused Agent B suite in test_refs");
  assert((workflowStory?.test_refs || []).includes(".agent/skills/iterative-planner/tests/test_planner_script_smoke.mjs"), "US-089 maps the planner smoke coverage for hook invocation");
  assert(!!ciStory, "story_registry.json includes US-090 for the CI recipe surface");
  assert((ciStory?.code_refs || []).includes("docs/ci/github_actions.md"), "US-090 maps the GitHub Actions recipe");
  assert((ciStory?.code_refs || []).includes("docs/ci/gitlab.md"), "US-090 maps the GitLab recipe");
  assert((ciStory?.code_refs || []).includes("docs/ci/pre_commit.md"), "US-090 maps the pre-commit recipe");
  assert((ciStory?.test_refs || []).includes(".agent/skills/story-verification/tests/test_story_verification.mjs"), "US-090 maps the focused Agent B test suite");
  assert((ciStory?.validation_refs || []).includes(".agent/skills/iterative-planner/tests/test_planner_doc_contracts.mjs"), "US-090 maps the planner doc-contract suite");
  assert(!!prologStory, "story_registry.json keeps US-018 for the story verification Prolog surface");
  assert((prologStory?.code_refs || []).includes(".agent/skills/story-verification/prolog/story_rules.pl"), "US-018 maps the extracted Agent B story rule bundle");
  assert((prologStory?.validation_refs || []).includes(".agent/skills/story-verification/tests/test_story_verification.mjs"), "US-018 points at the split-aware Agent B regression suite");
  assert(!!invariantStory, "story_registry.json keeps US-019 for the Agent A invariant bundle");
  assert((invariantStory?.code_refs || []).includes(".agent/skills/iterative-planner/prolog/invariants.pl"), "US-019 still maps the Agent A core invariant bundle");
  assert(String(invariantStory?.title || "").includes("Agent A"), "US-019 title reflects the Agent A core-invariant boundary");

  withWorkspace("readonly-cli", (workspace) => {
    const { alphaPlanId } = seedCliWorkspace(workspace);
    const registryPath = join(workspace, "reports", "user_story_audit", "story_registry.json");
    const sourcePath = join(workspace, "src", "payment.mjs");
    const registryBefore = readFileSync(registryPath, "utf8");
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const outputPath = join(workspace, "reports", "story_verification", "readonly.yaml");

    const result = runNode([verifyStoriesCliPath, "--plan", alphaPlanId, "--output", outputPath], workspace);
    assert(result.ok, "verify_stories.mjs exits cleanly for a read-only fixture run");
    assert(readFileSync(registryPath, "utf8") === registryBefore, "verify_stories.mjs leaves story_registry.json unchanged");
    assert(readFileSync(sourcePath, "utf8") === sourceBefore, "verify_stories.mjs leaves source files unchanged");
  });
}

function scenarioVerifyStoriesCLISelectors() {
  withWorkspace("verify-cli", (workspace) => {
    const { alphaPlanId, betaPlanId, legacyPlanIds } = seedCliWorkspace(workspace);

    const planOutput = join(workspace, "reports", "story_verification", "plan.yaml");
    const planResult = runNode([verifyStoriesCliPath, "--plan", alphaPlanId, "--output", planOutput], workspace);
    assert(planResult.ok, "verify_stories.mjs dispatches --plan <plan_id>");
    const planReport = JSON.parse(readFileSync(planOutput, "utf8"));
    assert(planReport.verification_report.plan_id === alphaPlanId, "--plan writes a single-plan report");

    const allOutput = join(workspace, "reports", "story_verification", "all.yaml");
    const allResult = runNode([verifyStoriesCliPath, "--all", "--output", allOutput], workspace);
    assert(allResult.ok, "verify_stories.mjs dispatches --all");
    const allReport = JSON.parse(readFileSync(allOutput, "utf8"));
    assert(allReport.verification_report.plan_id === "batch:all", "--all writes a batch report");
    assert(allReport.verification_report.summary.total_criteria === 2, "--all covers both fixture plans");
    assert(
      !allReport.verification_report.gaps.some((gap) => String(gap.description || "").includes("US-103")),
      "--all narrows coverage findings to stories referenced by the selected canonical plans"
    );
    assert(
      allReport.verification_report.fleet_summary?.canonical_plans?.total === 2,
      "--all writes canonical fleet counts alongside criterion counts"
    );
    assert(
      allReport.verification_report.fleet_summary?.legacy_plans?.skipped === legacyPlanIds.length,
      "--all skips legacy plans by default and records the skipped count"
    );
    assert(
      allReport.verification_report.fleet_summary?.legacy_plans?.date_range?.start === "2026-04-19"
      && allReport.verification_report.fleet_summary?.legacy_plans?.date_range?.end === "2026-04-20",
      "--all reports the skipped legacy date range"
    );
    assert(
      (allReport.verification_report.warnings || []).some((warning) => warning.includes("Skipped 2 legacy plans")),
      "--all emits an explicit warning when legacy plans are skipped"
    );

    const sinceOutput = join(workspace, "reports", "story_verification", "since.yaml");
    const sinceResult = runNode([verifyStoriesCliPath, "--since", "2026-04-21T12:00:00Z", "--output", sinceOutput], workspace);
    assert(sinceResult.ok, "verify_stories.mjs dispatches --since <date>");
    const sinceReport = JSON.parse(readFileSync(sinceOutput, "utf8"));
    assert(sinceReport.verification_report.summary.total_criteria === 1, "--since filters to the later plan");
    assert(String(sinceReport.verification_report.strategy_source).includes(betaPlanId), "--since reports the filtered plan source");

    const quietOutput = join(workspace, "reports", "story_verification", "quiet.yaml");
    const quietResult = runNode([verifyStoriesCliPath, "--plan", alphaPlanId, "--quiet", "--output", quietOutput], workspace);
    assert(quietResult.ok, "verify_stories.mjs accepts --quiet");
    assert(String(quietResult.stdout || "").trim() === "", "--quiet suppresses informational stdout");

    const failOutput = join(workspace, "reports", "story_verification", "fail.yaml");
    const failResult = runNode([verifyStoriesCliPath, "--plan", betaPlanId, "--output", failOutput, "--fail-on-severity", "HIGH"], workspace);
    assert(failResult.ok === false && failResult.status === 1, "verify_stories.mjs honors --fail-on-severity <HIGH|MEDIUM|LOW>");
    const failReport = JSON.parse(readFileSync(failOutput, "utf8"));
    assert(failReport.verification_report.gaps.some((gap) => gap.severity === "HIGH"), "fail-on-severity fixture produces a HIGH-severity gap");

    const checkClear = runNode([verifyStoriesCliPath, "--check-report", planOutput, "--fail-on-severity", "HIGH"], workspace);
    assert(checkClear.ok, "verify_stories.mjs can re-check a clean report at a threshold");

    const checkFail = runNode([verifyStoriesCliPath, "--check-report", failOutput, "--fail-on-severity", "HIGH"], workspace);
    assert(checkFail.ok === false && checkFail.status === 1, "verify_stories.mjs can fail from an existing report via --check-report");
  });
}

function scenarioVerifyStoriesScansPlanScopedInternalRoots() {
  withWorkspace("verify-internal-roots", (workspace) => {
    const planId = "plan_2026-04-23_internal_roots";
    const outputPath = join(workspace, "reports", "story_verification", "internal-roots.yaml");

    writeFixture(workspace, "reports/user_story_audit/story_registry.json", JSON.stringify(buildRegistry([
      {
        id: "US-201",
        title: "Planner internal MCP route",
        status: "FULLY_COVERED",
        acceptance_criteria: ["MCP initializes"],
      },
    ]), null, 2));

    writeFixture(workspace, ".agent/skills/planner-mcp/server.mjs", `// @planner:story_id US-201
// @planner:accepts MCP initializes
export function initializeMcp() {
  return true;
}
`);

    writeFixture(workspace, ".agent/skills/planner-mcp/tests/server.integration.test.mjs", `// @planner:story_id US-201
export function planner_mcp_initialize_smoke() {
  return true;
}
`);

    writeFixture(
      workspace,
      join("plans", planId, "verification_strategy.yaml"),
      JSON.stringify(buildStrategyWithOverrides([
        {
          id: "CRIT-MCP",
          criterion: "Planner internal MCP route stays traceable",
          story_id: "US-201",
          implementation: { file: ".agent/skills/planner-mcp", lines: "1-5", function: "initializeMcp" },
          acceptance: ["MCP initializes"],
          tests: [{ name: "planner_mcp_initialize_smoke", file: ".agent/skills/planner-mcp/tests/server.integration.test.mjs", type: "integration" }],
          concrete_action: { type: "command", command: "node .agent/skills/planner-mcp/tests/server.integration.test.mjs", procedure: null, reviewer_persona: null },
          how_verified: "integration_test",
          pass_means: "Internal route annotation is visible to Agent B",
          what_remains_unverified: "Live execution is outside this fixture",
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
        },
      ], {
        planId,
        createdAt: "2026-04-23T09:00:00Z",
        updatedAt: "2026-04-23T10:00:00Z",
      }), null, 2)
    );

    const result = runNode([verifyStoriesCliPath, "--plan", planId, "--output", outputPath, "--fail-on-severity", "HIGH"], workspace);
    assert(result.ok, "verify_stories.mjs scans internal roots named by verification_strategy.yaml");

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    const finding = report.verification_report.findings.find((entry) => entry.criterion_id === "CRIT-MCP");
    assert(finding?.code_matches_declared === true, "plan-scoped .agent implementation annotations match the criterion file");
    assert(String(finding?.annotation_found || "").includes("@planner:story_id US-201"), "internal-root report records the story annotation");
    assert(
      !report.verification_report.gaps.some((gap) => gap.type === "ORPHANED_CODE" && String(gap.description || "").includes("US-201")),
      "plan-scoped internal annotations prevent false missing-implementation gaps"
    );
  });
}

function scenarioVerifyStoriesEmitsAdequacyFindings() {
  withWorkspace("verify-adequacy-cli", (workspace) => {
    const planId = "plan_2026-04-23_adequacy_cli";
    const outputPath = join(workspace, "reports", "story_verification", "adequacy.yaml");

    writeFixture(workspace, "reports/user_story_audit/story_registry.json", JSON.stringify(buildRegistry([
      {
        id: "US-301",
        title: "Payment amount validation",
        status: "FULLY_COVERED",
        acceptance_criteria: ["Reject zero payment amounts"],
      },
    ]), null, 2));

    writeFixture(workspace, "src/payment.mjs", `// @planner:story_id US-301
// @planner:accepts Reject zero payment amounts
export function validatePayment() {
  return false;
}
`);
    writeFixture(workspace, "tests/test_1.mjs", `export function test_1() {
  assert.equal(1, 1);
}
`);
    writeFixture(workspace, "reports/coverage/payment.json", JSON.stringify({
      line_coverage: 0.4,
      branch_coverage: 0.25,
    }, null, 2));

    writeFixture(
      workspace,
      join("plans", planId, "verification_strategy.yaml"),
      JSON.stringify(buildStrategyWithOverrides([
        {
          id: "CRIT-301",
          criterion: "Reject zero payment amounts",
          story_id: "US-301",
          implementation: { file: "src/payment.mjs", lines: "1-5", function: "validatePayment" },
          acceptance: ["Reject zero payment amounts"],
          tests: [{ name: "test_1", file: "tests/test_1.mjs", type: "unit" }],
          concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
          how_verified: "unit_test",
          pass_means: "Unit test rejects zero payment amounts",
          what_remains_unverified: null,
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
          evidence_artifacts: [
            {
              type: "coverage_report",
              path: "reports/coverage/payment.json",
              minimum_line_coverage: 0.85,
              minimum_branch_coverage: 0.75,
            },
          ],
        },
      ], {
        planId,
        createdAt: "2026-04-23T09:00:00Z",
        updatedAt: "2026-04-23T10:00:00Z",
      }), null, 2)
    );

    const result = runNode([verifyStoriesCliPath, "--plan", planId, "--output", outputPath], workspace);
    assert(result.ok, "verify_stories.mjs still exits cleanly when adequacy findings are present");

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    const adequacyTypes = (report.verification_report.adequacy_findings || []).map((finding) => finding.type);
    assert(adequacyTypes.includes("GENERIC_TEST_NAME"), "verify_stories.mjs writes generic-name adequacy findings into verification_report");
    assert(adequacyTypes.includes("COVERAGE_THRESHOLD_UNMET"), "verify_stories.mjs writes coverage-threshold adequacy findings into verification_report");
  });
}

function scenarioVerifyStoriesDispatcher() {
  withWorkspace("verify-dispatcher", (workspace) => {
    const { alphaPlanId, legacyPlanIds } = seedCliWorkspace(workspace);

    const init = runGit(["init"], workspace);
    assert(init.ok, "git init succeeds for the plan-from-head fixture");
    assert(runGit(["config", "user.name", "Story Verifier"], workspace).ok, "git user.name is configured for the plan-from-head fixture");
    assert(runGit(["config", "user.email", "story-verifier@example.com"], workspace).ok, "git user.email is configured for the plan-from-head fixture");
    assert(runGit(["add", "."], workspace).ok, "git add succeeds for the initial fixture commit");
    assert(runGit(["commit", "-m", "seed verification fixture"], workspace).ok, "initial fixture commit succeeds");

    writeFixture(
      workspace,
      join("plans", alphaPlanId, "verification_strategy.yaml"),
      JSON.stringify(buildStrategyWithOverrides([
        {
          id: "CRIT-101",
          criterion: "Alpha checkout stays annotated",
          story_id: "US-101",
          implementation: { file: "src/payment.mjs", lines: "1-5", function: "validatePayment" },
          acceptance: ["Accepts card"],
          tests: [{ name: "payment_integration_spec", file: "tests/payment.integration.test.mjs", type: "integration" }],
          concrete_action: { type: "command", command: "node test", procedure: null, reviewer_persona: null },
          how_verified: "integration_test",
          pass_means: "Integration annotation exists",
          what_remains_unverified: "Live execution is advisory in Phase 3.1",
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
        },
      ], {
        planId: alphaPlanId,
        createdAt: "2026-04-21T09:00:00Z",
        updatedAt: "2026-04-21T16:00:00Z",
      }), null, 2)
    );
    assert(runGit(["add", join("plans", alphaPlanId, "verification_strategy.yaml")], workspace).ok, "git add succeeds for the HEAD plan fixture");

    const stagedOutput = join(workspace, "reports", "story_verification", "staged.yaml");
    const stagedResult = runNode([verifyStoriesCliPath, "--staged", "--output", stagedOutput], workspace);
    assert(stagedResult.ok, "verify_stories.mjs dispatches --staged for staged plan changes");
    const stagedReport = JSON.parse(readFileSync(stagedOutput, "utf8"));
    assert(stagedReport.verification_report.plan_id === "batch:staged", "--staged writes a staged batch report");
    assert(stagedReport.verification_report.summary.total_criteria === 1, "--staged limits the report to staged plan criteria");

    assert(runGit(["commit", "-m", "touch alpha plan"], workspace).ok, "HEAD fixture commit succeeds");

    const planFromHeadOutput = join(workspace, "reports", "story_verification", "head.yaml");
    const planFromHeadResult = runNode([verifyStoriesCliPath, "--plan-from-head", "--output", planFromHeadOutput], workspace);
    assert(planFromHeadResult.ok, "verify_stories.mjs dispatches --plan-from-head");
    const planFromHeadReport = JSON.parse(readFileSync(planFromHeadOutput, "utf8"));
    assert(planFromHeadReport.verification_report.plan_id === alphaPlanId, "--plan-from-head resolves the HEAD-touched plan");

    const dispatcherOutput = join(workspace, "reports", "story_verification", "dispatcher.yaml");
    const dispatcherResult = runNode([plannerCliPath, "verify-stories", "--plan", alphaPlanId, "--output", dispatcherOutput], workspace);
    assert(dispatcherResult.ok, "planner.mjs dispatches verify-stories to verify_stories.mjs");
    const helpResult = runNode([plannerCliPath, "--help"], workspace);
    assert(helpResult.ok && helpResult.stdout.includes("planner.mjs verify-stories"), "planner.mjs help advertises the verify-stories dispatcher alias");

    const emptyStagedOutput = join(workspace, "reports", "story_verification", "staged-empty.yaml");
    const emptyStagedResult = runNode([verifyStoriesCliPath, "--staged", "--output", emptyStagedOutput], workspace);
    assert(emptyStagedResult.ok, "verify_stories.mjs treats no staged plan directories as a clean no-op");
    const emptyStagedReport = JSON.parse(readFileSync(emptyStagedOutput, "utf8"));
    assert((emptyStagedReport.verification_report.warnings || []).includes("No staged plan directories matched; nothing to verify."), "--staged no-op writes an explicit warning");

    writeFixture(
      workspace,
      join("plans", legacyPlanIds[0], "plan.md"),
      "# Legacy plan\n\nThis staged legacy change should be skipped when --skip-legacy is supplied.\n"
    );
    assert(runGit(["add", join("plans", legacyPlanIds[0], "plan.md")], workspace).ok, "git add succeeds for the staged legacy fixture");

    const stagedLegacyOutput = join(workspace, "reports", "story_verification", "staged-legacy.yaml");
    const stagedLegacyResult = runNode([verifyStoriesCliPath, "--staged", "--skip-legacy", "--output", stagedLegacyOutput], workspace);
    assert(stagedLegacyResult.ok, "verify_stories.mjs tolerates staged legacy plans when --skip-legacy is supplied");
    const stagedLegacyReport = JSON.parse(readFileSync(stagedLegacyOutput, "utf8"));
    assert(stagedLegacyReport.verification_report.summary.total_criteria === 0, "--staged --skip-legacy does not invent canonical criteria");
    assert(
      stagedLegacyReport.verification_report.fleet_summary?.legacy_plans?.skipped === 1,
      "--staged --skip-legacy records the staged legacy skip count"
    );
    assert(
      (stagedLegacyReport.verification_report.warnings || []).some((warning) => warning.includes("--skip-legacy")),
      "--staged --skip-legacy explains the skip mode in report warnings"
    );
  });
}

const scenarios = [
  ["extractAnnotations parses real comment annotations and rejects false positives", scenarioExtractAnnotations],
  ["verifyCoverage applies the Phase 3 status-scoped rules", scenarioVerifyCoverage],
  ["verifyAdequacy reports coverage, tautology, and naming weaknesses deterministically", scenarioVerifyAdequacy],
  ["verifyObligations evaluates each how_verified family", scenarioVerifyObligations],
  ["report_generator validates valid and invalid reports with structured errors", scenarioReportGenerator],
  ["split Agent B story rules preserve the legacy story invariant results", scenarioStoryRuleSplitMatchesLegacyBundle],
  ["the I-007 split keeps Agent A and Agent B ownership separate", scenarioCapabilitySplitBoundary],
  ["verify_stories.mjs dispatches the Phase 3.1 CLI selectors and flags", scenarioVerifyStoriesCLISelectors],
  ["verify_stories.mjs scans plan-scoped internal annotation roots", scenarioVerifyStoriesScansPlanScopedInternalRoots],
  ["verify_stories.mjs persists adequacy findings alongside ordinary verification output", scenarioVerifyStoriesEmitsAdequacyFindings],
  ["planner.mjs routes verify-stories and --plan-from-head resolves HEAD cleanly", scenarioVerifyStoriesDispatcher],
  ["Phase 3.3 keeps the workflow, docs, and read-only boundary in sync", scenarioReadOnlyBoundary],
];

console.log("Story verification scaffold tests");
for (const [name, scenario] of scenarios) {
  console.log(`\n- ${name}`);
  try {
    scenario();
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${error?.stack || error?.message || error}`);
  }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
