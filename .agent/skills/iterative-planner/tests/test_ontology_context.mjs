#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
const contextCliPath = join(scriptDir, "ontology_context.mjs");
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
  return mkdtempSync(join(tmpdir(), `planner-ontology-context-${name}-`));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function runCli(scriptPath, args, cwd) {
  try {
    const stdout = execFileSync(nodeBin, [scriptPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function seedOntologyFixture(tmp) {
  writeJson(join(tmp, ".agent", "ontology", "facts", "code.yaml"), {
    code: {
      version: 1,
      modules: [
        { id: "payment", path: "src/payment" },
        { id: "auth", path: "src/auth" },
        { id: "parser", path: "src/parser" },
        { id: "migration", path: "scripts" },
      ],
      files: [
        { path: "src/payment/validate.js", module: "payment", language: "javascript" },
        { path: "src/payment/retry.js", module: "payment", language: "javascript" },
        { path: "src/auth/login.js", module: "auth", language: "javascript" },
        { path: "src/parser/verification_parser.js", module: "parser", language: "javascript" },
        { path: "src/parser/reader.js", module: "parser", language: "javascript" },
        { path: "scripts/migrate.js", module: "migration", language: "javascript" },
      ],
      classes: [],
      functions: [],
      file_dependencies: [
        { source: "src/payment/retry.js", target: "src/payment/validate.js", type: "import" },
        { source: "src/parser/reader.js", target: "src/parser/verification_parser.js", type: "import" },
      ],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "specification.yaml"), {
    specification: {
      version: 1,
      domains: [
        { name: "payment", description: "Payment validation and retry handling" },
        { name: "auth", description: "Authentication and lockout rules" },
        { name: "parser_reader", description: "Parser and reader parity" },
        { name: "migration", description: "Upgrade and parity work" },
      ],
      stories: [
        {
          id: "US-PAY-001",
          title: "Validate payment amounts and retries",
          status: "PARTIALLY_COVERED",
          domain: "payment",
          acceptance_criteria: [
            { id: "AC-US-PAY-001", text: "Reject invalid amounts and retry safely" },
          ],
        },
        {
          id: "US-AUTH-001",
          title: "Protect auth login lockout flow",
          status: "FULLY_COVERED",
          domain: "auth",
          acceptance_criteria: [
            { id: "AC-US-AUTH-001", text: "Lock out repeated invalid auth attempts" },
          ],
        },
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
      plans: [
        { id: "plan_context_fixture", phase: "EXECUTE", story_ids: ["US-PAY-001", "US-AUTH-001", "US-PARSE-001", "US-MIG-001"] },
      ],
    },
  });

  writeJson(join(tmp, ".agent", "ontology", "facts", "verification.yaml"), {
    verification: {
      version: 1,
      criteria: [
        { id: "CRIT-PAY-001", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-PAY-001" },
        { id: "CRIT-AUTH-001", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-AUTH-001" },
        { id: "CRIT-PARSE-001", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-PARSE-001" },
        { id: "CRIT-MIG-001", plan_id: "plan_context_fixture", story_criterion_id: "AC-US-MIG-001" },
      ],
      tests: [
        {
          name: "test_validate_amount_rejects_zero",
          file: "tests/payment.test.js",
          type: "integration",
          criterion_ids: ["AC-US-PAY-001"],
          covered_files: ["src/payment/validate.js"],
        },
        {
          name: "test_retry_after_timeout",
          file: "tests/payment.test.js",
          type: "integration",
          criterion_ids: ["AC-US-PAY-001"],
          covered_files: ["src/payment/retry.js"],
        },
        {
          name: "test_auth_lockout_after_failures",
          file: "tests/auth.test.js",
          type: "integration",
          criterion_ids: ["AC-US-AUTH-001"],
          covered_files: ["src/auth/login.js"],
        },
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

  writeJson(join(tmp, ".agent", "ontology", "facts", "process.yaml"), {
    process: {
      version: 1,
      mistakes: [],
      patterns: [
        { id: "P-075", title: "Inventory mirror readers before parser changes", applies_to: ["parser_reader"] },
        { id: "P-076", title: "Prove migration parity across upgrade paths", applies_to: ["migration"] },
        { id: "P-091", title: "Exercise verification-heavy runtime paths", applies_to: ["verification"] },
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
      workflows: [
        { name: "/advisor", recipe_affinity: "low" },
      ],
      mirror_readers: [
        { reader: "src/parser/verification_parser.js", artifact: "verification.md" },
        { reader: "src/parser/reader.js", artifact: "state.json" },
      ],
      edge_cases: [
        { domain: "payment", label: "zero_amount", description: "Test zero or null payment amounts before retry logic." },
        { domain: "payment", label: "idempotency_key_missing", description: "Test retry safety when the idempotency key is missing." },
        { domain: "auth", label: "lockout_reset_window", description: "Check auth lockout reset windows after repeated failures." },
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
        },
        unit_test: {
          label: "Unit test",
          category: "test",
          base_weight: 2,
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
        payment: "medium",
        planner_core: "high",
      },
    },
  });

  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    stories: [
      {
        id: "US-PAY-001",
        title: "Validate payment amounts and retries",
        status: "PARTIALLY_COVERED",
        code_refs: ["src/payment/validate.js", "src/payment/retry.js"],
        test_refs: ["tests/payment.test.js"],
        validation_refs: ["tests/payment.test.js"],
      },
      {
        id: "US-AUTH-001",
        title: "Protect auth login lockout flow",
        status: "FULLY_COVERED",
        code_refs: ["src/auth/login.js"],
        test_refs: ["tests/auth.test.js"],
        validation_refs: ["tests/auth.test.js"],
      },
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
}

function scenarioPaymentTaskContextFindsPaymentSurface() {
  const tmp = makeTemp("payment");
  try {
    seedOntologyFixture(tmp);
    const result = runCli(contextCliPath, ["--task", "add retry logic to payment validation", "--dir", tmp, "--json"], tmp);
    assert(result.ok, "ontology_context exits cleanly for payment work");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology_context payment run emits valid JSON");
    assert(parsed?.task_context?.inferred_tags?.domains?.includes("payment"), "payment task infers the payment domain");
    assert(parsed?.task_context?.relevant_stories?.some((story) => story.id === "US-PAY-001"), "payment task keeps the payment story in context");
    assert(parsed?.task_context?.likely_affected_files?.includes("src/payment/retry.js"), "payment task includes retry.js as a likely affected file");
    assert(parsed?.task_context?.covering_tests?.includes("test_retry_after_timeout"), "payment task surfaces the retry test");
    assert(parsed?.task_context?.edge_cases_to_consider?.some((edgeCase) => edgeCase.label === "zero_amount"), "payment task surfaces payment edge cases");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioAuthTaskContextWorksThroughPlannerAlias() {
  const tmp = makeTemp("auth");
  try {
    seedOntologyFixture(tmp);
    const result = runCli(plannerCliPath, ["context", "--task", "tighten auth login lockout checks", "--dir", tmp, "--json"], tmp);
    assert(result.ok, "planner context alias exits cleanly for auth work");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner context alias emits valid JSON for auth work");
    assert(parsed?.task_context?.inferred_tags?.domains?.includes("auth"), "auth task infers the auth domain");
    assert(parsed?.task_context?.relevant_stories?.some((story) => story.id === "US-AUTH-001"), "auth task keeps the auth story in context");
    assert(parsed?.task_context?.covering_tests?.includes("test_auth_lockout_after_failures"), "auth task surfaces the auth lockout test");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioParserTaskContextSurfacesMirrorReaders() {
  const tmp = makeTemp("parser");
  try {
    seedOntologyFixture(tmp);
    const result = runCli(contextCliPath, ["--task", "fix parser reader drift in verification serializer", "--dir", tmp, "--json"], tmp);
    assert(result.ok, "ontology_context exits cleanly for parser-reader work");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology_context parser run emits valid JSON");
    assert(parsed?.task_context?.inferred_tags?.change_class === "parser_reader", "parser task infers the parser_reader change class");
    assert(parsed?.task_context?.mirror_readers_to_consider?.length === 2, "parser task surfaces the expected mirror readers");
    assert(parsed?.task_context?.historical_incidents?.some((retro) => retro.id === "R-PARSE-001"), "parser task surfaces parser historical incidents");
    assert(parsed?.task_context?.applicable_patterns?.some((pattern) => pattern.id === "P-075"), "parser task surfaces parser-reader patterns");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioMigrationTaskContextSurfacesParitySignals() {
  const tmp = makeTemp("migration");
  try {
    seedOntologyFixture(tmp);
    const result = runCli(contextCliPath, ["--task", "add migration parity checks for the upgrade path", "--dir", tmp, "--json"], tmp);
    assert(result.ok, "ontology_context exits cleanly for migration work");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology_context migration run emits valid JSON");
    assert(parsed?.task_context?.inferred_tags?.change_class === "migration", "migration task infers the migration change class");
    assert(parsed?.task_context?.relevant_stories?.some((story) => story.id === "US-MIG-001"), "migration task keeps the migration story in context");
    assert(parsed?.task_context?.historical_incidents?.some((retro) => retro.id === "R-MIG-001"), "migration task surfaces migration incidents");
    assert(parsed?.task_context?.applicable_patterns?.some((pattern) => pattern.id === "P-076"), "migration task surfaces migration patterns");
    assert(parsed?.task_context?.suggested_checklist_items?.some((item) => item.includes("rollback")), "migration task synthesizes rollback-focused checklist items");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioPaymentTaskContextFindsPaymentSurface();
scenarioAuthTaskContextWorksThroughPlannerAlias();
scenarioParserTaskContextSurfacesMirrorReaders();
scenarioMigrationTaskContextSurfacesParitySignals();

console.log(`\nOntology context tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
