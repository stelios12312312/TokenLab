#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { resolveRecipeRequest } from "../scripts/lib/recipe_utils.mjs";
import { scaffoldVerificationStrategy } from "../scripts/lib/verification_strategy.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const domainChecklistDir = join(plannerRoot, ".agent", "semantic", "domain_checklists");
const scriptDir = resolve(testDir, "..", "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-recipe-resolver-${name}-`));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function run(args, cwd, extraEnv = {}) {
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
          ...extraEnv,
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

function installDomainChecklistFixtures(root) {
  const targetDir = join(root, ".agent", "semantic", "domain_checklists");
  mkdirSync(targetDir, { recursive: true });
  for (const name of [
    "browser_feature.yaml",
    "api_feature.yaml",
    "data_migration.yaml",
    "ui_component.yaml",
  ]) {
    writeFileSync(join(targetDir, name), readFileSync(join(domainChecklistDir, name), "utf-8"));
  }
}

function createPlanFixture(root, {
  planId = "plan_2026-04-23_recipe_scaffold",
  goal = "Harden an API endpoint with deterministic evidence defaults",
  filesToModify = ["src/api/orders.mjs"],
} = {}) {
  const planDir = join(root, "plans", planId);
  mkdirSync(join(root, "plans", "knowledge"), { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(root, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(root, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(root, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(root, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  writeFileSync(join(root, "plans", ".current_plan"), `${planId}\n`);
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
${filesToModify.map((filePath) => `- ${filePath}`).join("\n")}

## Verification Obligation Synthesis
- Repo/system context: Evidence defaults fixture
- Task shape: direct scaffold smoke
- System boundaries touched: ${filesToModify.join(", ")}
- Derived verification obligations: auto-populate domain recipe evidence requirements

## Success Criteria
1. Domain recipe defaults are scaffolded into the canonical verification strategy.
`);
  return planDir;
}

function scenarioDomainRecipeFilesShipRequiredFields() {
  for (const name of [
    "browser_feature.yaml",
    "api_feature.yaml",
    "data_migration.yaml",
    "ui_component.yaml",
  ]) {
    const parsed = JSON.parse(readFileSync(join(domainChecklistDir, name), "utf-8"));
    assert(typeof parsed?.domain === "string" && parsed.domain.length > 0, `${name} declares a domain id`);
    assert(Array.isArray(parsed?.required_tests) && parsed.required_tests.length > 0, `${name} declares required_tests`);
    assert(Array.isArray(parsed?.required_evidence_artifacts) && parsed.required_evidence_artifacts.length > 0, `${name} declares required_evidence_artifacts`);
  }
}

function scenarioResolveRecipeRequestMatchesMigrationEvidence() {
  const tmp = makeTemp("migration-match");
  try {
    installDomainChecklistFixtures(tmp);
    const resolution = resolveRecipeRequest({
      cwd: tmp,
      goalText: "Run a user table migration with rollback coverage",
      plannedFiles: ["migrations/20260423_users.sql"],
    });

    assert(
      (resolution.domain_checklists || []).some((entry) => entry.domain === "data_migration"),
      "resolveRecipeRequest matches data_migration for migration files"
    );
    assert(
      (resolution.evidence_defaults?.required_evidence_artifacts || []).some((artifact) => artifact.type === "row_count"),
      "resolveRecipeRequest exposes row_count evidence defaults for data_migration"
    );
    assert(
      (resolution.evidence_defaults?.required_tests || []).some((test) => test.name === "migration_rollback_path"),
      "resolveRecipeRequest exposes rollback-path test defaults for data_migration"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioScaffoldVerificationStrategyAutoPopulatesApiDefaults() {
  const tmp = makeTemp("api-scaffold");
  try {
    installDomainChecklistFixtures(tmp);
    const planId = "plan_2026-04-23_api_scaffold";
    const planDir = createPlanFixture(tmp, {
      planId,
      goal: "Add backend validation and API rate limiting",
      filesToModify: ["src/api/orders.mjs"],
    });

    const result = scaffoldVerificationStrategy({ cwd: tmp, planDir });
    const criterion = result?.strategy?.criteria?.[0];

    assert(result.ok, "scaffoldVerificationStrategy exits cleanly for API fixtures");
    assert(
      Array.isArray(result?.recipe_resolution?.domain_checklists) &&
      result.recipe_resolution.domain_checklists.some((entry) => entry.domain === "api_feature"),
      "scaffoldVerificationStrategy records the matched api_feature domain checklist"
    );
    assert(
      Array.isArray(criterion?.tests) && criterion.tests.some((test) => test.name === "api_rate_limit_hit"),
      "scaffoldVerificationStrategy auto-populates required API tests"
    );
    assert(
      Array.isArray(criterion?.evidence_artifacts) && criterion.evidence_artifacts.some((artifact) => artifact.type === "coverage_report"),
      "scaffoldVerificationStrategy auto-populates coverage evidence defaults for API work"
    );
    assert(
      criterion?.evidence_artifacts?.some((artifact) => artifact.path === `reports/test_runs/${planId}_latest.yaml`),
      "scaffoldVerificationStrategy replaces {{plan_id}} placeholders in evidence artifact paths"
    );
    assert(
      criterion?.how_verified === "integration_test",
      "scaffoldVerificationStrategy upgrades auto-populated test defaults to a test-based verification mode"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioScaffoldVerificationStrategyPreservesExplicitCriterionEvidence() {
  const tmp = makeTemp("preserve-explicit");
  try {
    installDomainChecklistFixtures(tmp);
    const planDir = createPlanFixture(tmp, {
      planId: "plan_2026-04-23_preserve_explicit",
      goal: "Adjust API contract handling",
      filesToModify: ["src/api/contracts.mjs"],
    });
    writeJson(join(planDir, "verification_strategy.yaml"), {
      verification_strategy: {
        version: 1,
        plan_id: "plan_2026-04-23_preserve_explicit",
        created_at: "2026-04-23T00:00:00.000Z",
        updated_at: "2026-04-23T00:00:00.000Z",
        repo_system_context: "Preserve explicit evidence defaults fixture",
        verification_obligation_synthesis: {
          summary: "Keep explicit strategy data intact.",
          scope: "API preservation fixture",
          non_goals: [],
          dependencies: [],
        },
        criteria: [
          {
            id: "CRIT-001",
            criterion: "Domain recipe defaults are scaffolded into the canonical verification strategy.",
            story_id: null,
            repo_system_context: "Preserve explicit evidence defaults fixture",
            required_proof_type: "proof:integration_smoke",
            implementation: {
              file: "src/api/contracts.mjs",
              lines: "1-20",
              function: null,
            },
            acceptance: ["Domain recipe defaults are scaffolded into the canonical verification strategy."],
            tests: [
              {
                name: "custom_contract_guard",
                file: "tests/custom_contract_guard.mjs",
                type: "integration",
              },
            ],
            evidence_artifacts: [
              {
                type: "coverage_report",
                path: "reports/custom/coverage.json",
                minimum_line_coverage: 0.9,
              },
            ],
            concrete_action: {
              type: "command",
              command: "node tests/custom_contract_guard.mjs",
              procedure: null,
              reviewer_persona: null,
            },
            how_verified: "integration_test",
            pass_means: "Custom evidence stays intact across scaffold refreshes.",
            what_remains_unverified: null,
            persona_audit_required: false,
            persona_audit_result: null,
            waiver: null,
          },
        ],
      },
    });

    const result = scaffoldVerificationStrategy({ cwd: tmp, planDir, force: true });
    const criterion = result?.strategy?.criteria?.[0];

    assert(result.ok, "scaffoldVerificationStrategy --force exits cleanly when a strategy already exists");
    assert(
      Array.isArray(criterion?.tests) &&
      criterion.tests.length === 1 &&
      criterion.tests[0]?.name === "custom_contract_guard",
      "scaffoldVerificationStrategy preserves explicit test definitions instead of overwriting them"
    );
    assert(
      Array.isArray(criterion?.evidence_artifacts) &&
      criterion.evidence_artifacts.length === 1 &&
      criterion.evidence_artifacts[0]?.path === "reports/custom/coverage.json",
      "scaffoldVerificationStrategy preserves explicit evidence artifacts instead of overwriting them"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCliRecipeResolverAndWriteStrategyUseDomainDefaults() {
  const tmp = makeTemp("cli-surface");
  try {
    installDomainChecklistFixtures(tmp);
    const planId = "plan_2026-04-23_cli_surface";
    const planDir = createPlanFixture(tmp, {
      planId,
      goal: "Add API rate limiting evidence defaults",
      filesToModify: ["src/api/orders.mjs"],
    });

    const resolver = run([join(scriptDir, "recipe_resolver.mjs"), "--json"], tmp);
    assert(resolver.ok, "recipe_resolver CLI exits cleanly for an active API plan fixture");
    const resolverJson = JSON.parse(resolver.stdout);
    assert(
      (resolverJson?.domain_checklists || []).some((entry) => entry.domain === "api_feature"),
      "recipe_resolver CLI matches api_feature from the active plan file list"
    );
    assert(
      (resolverJson?.evidence_defaults?.required_tests || []).some((test) => test.name === "api_rate_limit_hit"),
      "recipe_resolver CLI exposes domain-derived required tests"
    );
    assert(
      (resolverJson?.evidence_defaults?.required_evidence_artifacts || []).some((artifact) => artifact.path === `reports/test_runs/${planId}_latest.yaml`),
      "recipe_resolver CLI replaces {{plan_id}} placeholders in evidence defaults"
    );

    const writeStrategy = run([plannerCliPath, "write-strategy", "--init", "--plan", planId], tmp);
    assert(writeStrategy.ok, "planner write-strategy CLI exits cleanly for an active API plan fixture");
    const strategy = JSON.parse(readFileSync(join(planDir, "verification_strategy.yaml"), "utf-8"));
    const criterion = strategy?.verification_strategy?.criteria?.[0];
    assert(
      Array.isArray(criterion?.tests) && criterion.tests.some((test) => test.name === "api_rate_limit_hit"),
      "planner write-strategy CLI auto-populates domain-derived tests"
    );
    assert(
      Array.isArray(criterion?.evidence_artifacts) && criterion.evidence_artifacts.some((artifact) => artifact.path === `reports/test_runs/${planId}_latest.yaml`),
      "planner write-strategy CLI auto-populates plan-id-expanded evidence artifacts"
    );
    assert(
      criterion?.how_verified === "integration_test",
      "planner write-strategy CLI upgrades domain-derived test defaults to integration_test"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nRecipe Resolver Test\n");

scenarioDomainRecipeFilesShipRequiredFields();
scenarioResolveRecipeRequestMatchesMigrationEvidence();
scenarioScaffoldVerificationStrategyAutoPopulatesApiDefaults();
scenarioScaffoldVerificationStrategyPreservesExplicitCriterionEvidence();
scenarioCliRecipeResolverAndWriteStrategyUseDomainDefaults();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
