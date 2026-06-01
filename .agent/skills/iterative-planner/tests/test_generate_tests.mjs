#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import {
  generateTestsForPlan,
  getTestSpecificationPath,
  TEST_SPECIFICATION_FILENAME,
} from "../scripts/generate_tests.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
const nodeBin = process.execPath;

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
  return mkdtempSync(join(tmpdir(), `planner-generate-tests-${name}-`));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function runCli(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(nodeBin, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function seedGenerateTestsFixture(tmp) {
  mkdirSync(join(tmp, "src", "parser"), { recursive: true });
  mkdirSync(join(tmp, "scripts"), { recursive: true });
  mkdirSync(join(tmp, "tests"), { recursive: true });
  mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  writeFileSync(join(tmp, "src", "parser", "verification_parser.js"), "export function parseVerificationArtifact() { return true; }\n");
  writeFileSync(join(tmp, "src", "parser", "reader.js"), "export function readVerificationArtifact() { return true; }\n");
  writeFileSync(join(tmp, "scripts", "migration_guard.js"), "export const MigrationGuard = true;\n");
  writeFileSync(join(tmp, "scripts", "migrate.js"), "import { MigrationGuard } from \"./migration_guard.js\";\nexport function migratePlanArtifacts() { return MigrationGuard; }\n");
  writeFileSync(join(tmp, "tests", "parser.test.js"), "export function test_parser_reader_keeps_verification_md_parity() { return true; }\n");
  writeFileSync(join(tmp, "tests", "migration.test.js"), "export function test_migration_preserves_upgrade_parity() { return true; }\n");

  writeJson(join(tmp, ".agent", "ontology", "facts", "code.yaml"), {
    code: {
      version: 1,
      modules: [
        { id: "parser", path: "src/parser" },
        { id: "migration", path: "scripts" },
      ],
      files: [
        { path: "src/parser/verification_parser.js", module: "parser", language: "javascript" },
        { path: "src/parser/reader.js", module: "parser", language: "javascript" },
        { path: "scripts/migrate.js", module: "migration", language: "javascript" },
      ],
      classes: [],
      functions: [],
      file_dependencies: [
        { source: "src/parser/reader.js", target: "src/parser/verification_parser.js", type: "import" },
      ],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "specification.yaml"), {
    specification: {
      version: 1,
      domains: [
        { name: "parser_reader", description: "Parser and reader parity" },
        { name: "migration", description: "Migration parity" },
      ],
      stories: [
        {
          id: "US-PARSE-001",
          title: "Keep parser and reader parity for verification artifacts",
          status: "PARTIALLY_COVERED",
          domain: "parser_reader",
          acceptance_criteria: [
            { id: "AC-US-PARSE-001", text: "Parser and mirror readers stay in sync" },
          ],
        },
        {
          id: "US-MIG-001",
          title: "Preserve migration parity on upgrade paths",
          status: "PARTIALLY_COVERED",
          domain: "migration",
          acceptance_criteria: [
            { id: "AC-US-MIG-001", text: "Upgrade paths preserve parity and rollback safety" },
          ],
        },
      ],
      plans: [],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "verification.yaml"), {
    verification: {
      version: 1,
      criteria: [
        { id: "CRIT-PARSE-BASE", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-PARSE-001" },
        { id: "CRIT-MIG-BASE", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-MIG-001" },
      ],
      tests: [
        {
          name: "test_parser_reader_keeps_verification_md_parity",
          file: "tests/parser.test.js",
          type: "integration",
          criterion_ids: ["AC-US-PARSE-001"],
          covered_files: ["src/parser/verification_parser.js", "src/parser/reader.js"],
        },
        {
          name: "test_migration_preserves_upgrade_parity",
          file: "tests/migration.test.js",
          type: "integration",
          criterion_ids: ["AC-US-MIG-001"],
          covered_files: ["scripts/migrate.js"],
        },
      ],
      artifacts: [],
      test_runs: [],
      coverage_reports: [],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), {
    conventions: {
      version: 1,
      conventions: [
        {
          id: "CONV-300",
          title: "Migration scripts import MigrationGuard",
          description: "Migration entrypoints should import MigrationGuard before execution.",
          status: "active",
          domain: "planner_core",
          scope: "scripts",
          confidence: 0.98,
          applies_to: {
            file_patterns: ["scripts/**/*.js"],
            change_classes: ["planner_core", "migration"],
          },
          requires: [{ import_contains: "MigrationGuard" }],
          evidence_type: "static_analysis",
          detected_from: "manual",
        },
      ],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "process.yaml"), {
    process: {
      version: 1,
      mistakes: [],
      patterns: [
        { id: "P-075", title: "Inventory mirror readers before parser changes", applies_to: ["parser_reader"] },
        { id: "P-076", title: "Prove migration parity across upgrade paths", applies_to: ["migration"] },
      ],
      gotchas: [],
      retros: [
        {
          id: "R-PARSE-001",
          title: "Parser regression drifted from mirror readers",
          domain_tags: ["parser_reader"],
          change_classes: ["parser_reader"],
        },
        {
          id: "R-MIG-001",
          title: "Migration parity broke after upgrade",
          domain_tags: ["migration"],
          change_classes: ["migration"],
        },
      ],
      adrs: [],
      workflows: [],
      mirror_readers: [
        { reader: "src/parser/verification_parser.js", artifact: "verification.md" },
        { reader: "src/parser/reader.js", artifact: "state.json" },
      ],
      edge_cases: [
        { domain: "parser_reader", label: "verification_md_drift", description: "Check parser output stays aligned with verification.md readers." },
        { domain: "migration", label: "upgrade_path_missing_rollback", description: "Verify rollback material exists for the upgrade path." },
      ],
      invariants: [],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "proof_weights.yaml"), {
    proof_weights: {
      version: 1,
      proof_types: {
        integration_test: {
          label: "Integration test",
          category: "test",
          base_weight: 4,
          modifiers: [{ condition: "cross_module", delta: 1 }],
        },
        unit_test: {
          label: "Unit test",
          category: "test",
          base_weight: 2,
        },
        mutation_testing_pass: {
          label: "Mutation testing pass",
          category: "test",
          base_weight: 7,
        },
        console_log_clean: {
          label: "Console log clean",
          category: "artifact",
          base_weight: 1,
        },
        static_analysis_result: {
          label: "Static analysis result",
          category: "artifact",
          base_weight: 1,
        },
      },
      risk_levels: {
        medium: {
          required_weight: 4,
        },
        high: {
          required_weight: 7,
        },
      },
      domain_defaults: {
        migration: "high",
        planner_core: "high",
        verification: "medium",
      },
    },
  });

  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    stories: [
      {
        id: "US-PARSE-001",
        title: "Keep parser and reader parity for verification artifacts",
        status: "PARTIALLY_COVERED",
        code_refs: ["src/parser/verification_parser.js", "src/parser/reader.js"],
        test_refs: ["tests/parser.test.js"],
        validation_refs: ["tests/parser.test.js"],
      },
      {
        id: "US-MIG-001",
        title: "Preserve migration parity on upgrade paths",
        status: "PARTIALLY_COVERED",
        code_refs: ["scripts/migrate.js"],
        test_refs: ["tests/migration.test.js"],
        validation_refs: ["tests/migration.test.js"],
      },
    ],
  });

  const planName = "plan_generate_tests_fixture";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeStateJson(planDir, createInitialStateJson(
    planName,
    "Generate tests for parser-reader parity and migration proof obligations",
    { cwd: tmp }
  ));
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Generate tests for parser-reader parity and migration proof obligations

## Files To Modify
- src/parser/verification_parser.js
- src/parser/reader.js
- scripts/migrate.js

## Success Criteria
1. Parser and mirror readers stay in sync.
2. Migration parity is exercised across upgrade paths.

## Verification Strategy
Canonical verification contract lives in \`verification_strategy.yaml\`.
`);
  writeJson(join(planDir, "verification_strategy.yaml"), {
    verification_strategy: {
      version: 1,
      plan_id: planName,
      created_at: "2026-04-24T10:00:00.000Z",
      updated_at: "2026-04-24T10:00:00.000Z",
      repo_system_context: "Planner proof-gradient fixture",
      verification_obligation_synthesis: {
        summary: "Generate ontology-driven test slots for parser parity and migration parity work.",
        scope: "generate-tests planner surface",
        non_goals: [],
        dependencies: ["story_registry.json", "ontology facts"],
      },
      criteria: [
        {
          id: "CRIT-001",
          criterion: "Parser and mirror readers stay in sync.",
          story_id: "US-PARSE-001",
          domain: "parser_reader",
          repo_system_context: "Parser reader parity",
          required_proof_type: "proof:integration_smoke",
          implementation: {
            file: "src/parser/verification_parser.js",
            lines: "1-20",
            function: "parseVerificationArtifact",
          },
          acceptance: ["Parser and mirror readers stay in sync."],
          tests: [],
          concrete_action: {
            type: "review",
            command: null,
            procedure: ["Review the parser-reader fixture output."],
            reviewer_persona: "assumptions_challenger",
          },
          how_verified: "integration_test",
          pass_means: "Generated tests capture parser-reader drift risks.",
          what_remains_unverified: null,
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
        },
        {
          id: "CRIT-002",
          criterion: "Migration parity is exercised across upgrade paths.",
          story_id: "US-MIG-001",
          domain: "migration",
          repo_system_context: "Migration parity",
          required_proof_type: "proof:integration_smoke plus proof:migration_parity",
          implementation: {
            file: "scripts/migrate.js",
            lines: "1-20",
            function: "migratePlanArtifacts",
          },
          acceptance: ["Migration parity is exercised across upgrade paths."],
          tests: [
            {
              name: "test_migration_preserves_upgrade_parity",
              file: "tests/migration.test.js",
              type: "integration",
            },
          ],
          concrete_action: {
            type: "command",
            command: "node tests/migration.test.js",
            procedure: null,
            reviewer_persona: null,
          },
          how_verified: "integration_test",
          pass_means: "Generated tests capture migration parity coverage.",
          what_remains_unverified: null,
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
        },
      ],
    },
  });

  return { planDir, planName };
}

function scenarioGenerateTestsWritesCanonicalSpecification() {
  const tmp = makeTemp("canonical-spec");
  try {
    const { planDir, planName } = seedGenerateTestsFixture(tmp);
    const result = generateTestsForPlan({ cwd: tmp, planDir });
    const specPath = getTestSpecificationPath(planDir);
    const spec = parseJson(readFileSync(specPath, "utf-8"));

    assert(result.ok, "generateTestsForPlan exits cleanly for a canonical verification strategy");
    assert(result.test_specification_path === specPath, "generateTestsForPlan reports the canonical test_specification.yaml path");
    assert(existsSync(specPath), "generateTestsForPlan writes test_specification.yaml");
    assert(spec?.test_specification?.plan_id === planName, "test_specification.yaml records the plan id");
    assert(spec?.test_specification?.summary?.total_criteria === 2, "test_specification.yaml summarizes both criteria");
    assert(
      spec?.test_specification?.summary?.tests_to_implement >= 1,
      "test_specification.yaml reports work remaining when generated slots are missing from the strategy"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGenerateTestsComposesOntologySignals() {
  const tmp = makeTemp("ontology-signals");
  try {
    const { planDir } = seedGenerateTestsFixture(tmp);
    const result = generateTestsForPlan({ cwd: tmp, planDir });
    const parserCriterion = result?.test_specification?.per_criterion?.find((criterion) => criterion.criterion_id === "CRIT-001");
    const sources = new Set((parserCriterion?.required_tests || []).map((test) => test.source));

    assert(result.ok, "generateTestsForPlan exits cleanly for ontology signal composition");
    assert(
      sources.has("edge_case:parser_reader/verification_md_drift"),
      "generateTestsForPlan includes parser-reader edge case tests from the ontology"
    );
    assert(
      sources.has("pattern:P-075"),
      "generateTestsForPlan includes applicable pattern tests from the ontology"
    );
    assert(
      sources.has("historical_incident:R-PARSE-001"),
      "generateTestsForPlan includes historical incident guards from the ontology"
    );
    assert(
      [...sources].some((source) => source.startsWith("mirror_reader:src/parser/verification_parser.js")),
      "generateTestsForPlan includes mirror-reader tests when parser-reader history applies"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGenerateTestsMarksMissingDeclaredTestsAsWorkRemaining() {
  const tmp = makeTemp("missing-declared-test");
  try {
    const { planDir } = seedGenerateTestsFixture(tmp);
    rmSync(join(tmp, "tests", "migration.test.js"));

    const result = generateTestsForPlan({ cwd: tmp, planDir });
    const migrationCriterion = result?.test_specification?.per_criterion?.find((criterion) => criterion.criterion_id === "CRIT-002");
    const declaredMigrationTest = (migrationCriterion?.required_tests || [])
      .find((test) => test.name === "test_migration_preserves_upgrade_parity");

    assert(result.ok, "generateTestsForPlan still succeeds when a strategy-declared test file is currently missing");
    assert(
      declaredMigrationTest?.already_present === false,
      "generateTestsForPlan marks missing strategy-declared test files as not already present"
    );
    assert(
      (result?.test_specification?.summary?.tests_to_implement || 0) >= 1,
      "generateTestsForPlan keeps missing strategy-declared tests in the work-remaining count"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGenerateTestsUpdatesStrategyAndEstimatesProofWeight() {
  const tmp = makeTemp("update-strategy");
  try {
    const { planDir } = seedGenerateTestsFixture(tmp);
    const parsed = generateTestsForPlan({ cwd: tmp, planDir, updateStrategy: true });
    const updatedStrategy = parseJson(readFileSync(join(planDir, "verification_strategy.yaml"), "utf-8"));
    const migrationCriterion = parsed?.test_specification?.per_criterion?.find((criterion) => criterion.criterion_id === "CRIT-002");
    const parserStrategyCriterion = updatedStrategy?.verification_strategy?.criteria?.find((criterion) => criterion.id === "CRIT-001");
    const originalMigrationNames = (updatedStrategy?.verification_strategy?.criteria || [])
      .find((criterion) => criterion.id === "CRIT-002")
      ?.tests
      ?.map((test) => test.name) || [];

    assert(parsed?.ok === true, "generateTestsForPlan exits cleanly when updateStrategy is requested");
    assert(parsed?.strategy_updated === true, "generateTestsForPlan reports strategy_updated=true when writeback is requested");
    assert(migrationCriterion?.required_proof_weight === 7, "generate-tests derives required_proof_weight from the migration domain default");
    assert(
      migrationCriterion?.estimated_proof_weight >= migrationCriterion?.required_proof_weight,
      "generate-tests estimates proof weight using ontology proof weights"
    );
    assert(
      Array.isArray(parserStrategyCriterion?.tests) && parserStrategyCriterion.tests.length >= 3,
      "generate-tests --update-strategy appends generated parser test slots into verification_strategy.yaml"
    );
    assert(
      originalMigrationNames.includes("test_migration_preserves_upgrade_parity"),
      "generate-tests --update-strategy preserves existing manual tests in verification_strategy.yaml"
    );
    assert(
      (migrationCriterion?.required_tests || []).some((test) => test.intent === "convention_application" && test.convention_id === "CONV-300"),
      "generate-tests adds convention_application tests when active conventions apply to the implementation file"
    );
    assert(
      (migrationCriterion?.required_evidence_artifacts || []).some((artifact) => artifact.type === "convention_satisfied" && artifact.convention_id === "CONV-300"),
      "generate-tests emits required convention_satisfied evidence artifacts for applicable conventions"
    );

    const rerun = generateTestsForPlan({ cwd: tmp, planDir, updateStrategy: true });
    const rerunStrategy = parseJson(readFileSync(join(planDir, "verification_strategy.yaml"), "utf-8"));
    const parserNames = rerunStrategy?.verification_strategy?.criteria
      ?.find((criterion) => criterion.id === "CRIT-001")
      ?.tests
      ?.map((test) => test.name) || [];
    const uniqueParserNames = new Set(parserNames);

    assert(rerun?.ok === true, "generateTestsForPlan can be rerun with updateStrategy");
    assert(
      uniqueParserNames.size === parserNames.length,
      "generate-tests --update-strategy dedupes generated test slots on rerun"
    );
    assert(
      existsSync(join(planDir, TEST_SPECIFICATION_FILENAME)),
      "generate-tests --update-strategy still writes the canonical test_specification artifact"
    );
    assert(
      rerunStrategy?.verification_strategy?.criteria
        ?.find((criterion) => criterion.id === "CRIT-002")
        ?.tests
        ?.some((test) => test.name && test.name.includes("conv_300")),
      "generate-tests --update-strategy persists convention application tests into verification_strategy.yaml"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nGenerate Tests Test\n");

scenarioGenerateTestsWritesCanonicalSpecification();
scenarioGenerateTestsComposesOntologySignals();
scenarioGenerateTestsMarksMissingDeclaredTestsAsWorkRemaining();
scenarioGenerateTestsUpdatesStrategyAndEstimatesProofWeight();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
