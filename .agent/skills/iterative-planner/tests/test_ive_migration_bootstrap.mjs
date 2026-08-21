#!/usr/bin/env node
// test_ive_migration_bootstrap.mjs — IVE phase 0.5 migration bootstrap proof.
// @planner:validation_module = true
// @planner:story = US-015
// @planner:proves = sc_1, sc_2, sc_3, sc_4, sc_5, sc_6, sc_7, sc_8

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  managedUpgradeProofEnvironment,
} from "../scripts/lib/managed_upgrade_transaction.mjs";
import {
  buildEmptyOntologyDocument,
  ONTOLOGY_ENTITY_CLASSES,
} from "../scripts/lib/ontology_schema.mjs";
import {
  listFleetManagedWorkflowFiles,
  workflowFileHasExplicitHostOwnerMarker,
} from "../scripts/lib/workflow_contracts.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const sourceBootstrap = join(skillDir, "scripts", "bootstrap.mjs");
const sourceMigrate = join(skillDir, "scripts", "migrate.mjs");
const NODE = process.execPath;
const GIT_ROUTING_ENV_KEYS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

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

function fixtureEnvironment(overrides = {}) {
  const env = {
    ...process.env,
    ...overrides,
  };
  for (const key of GIT_ROUTING_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function runJson(args, cwd = repoRoot) {
  const stdout = execFileSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnvironment({
      IVE_MIGRATION_TIMESTAMP: `2026-05-31T13-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}-00Z`,
    }),
  });
  return JSON.parse(stdout);
}

function runRaw(args, cwd = repoRoot, envOverrides = {}) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: fixtureEnvironment({
        ...envOverrides,
        IVE_MIGRATION_TIMESTAMP: `2026-05-31T13-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}-00Z`,
      }),
    });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      status: error.status || 1,
    };
  }
}

function debugRaw(label, result) {
  if (process.env.B4FC_DEBUG === "1") {
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    console.log(
      `\n--- ${label} status=${result.status} ---\n`
      + `${stdout.slice(Math.max(0, stdout.length - 5000))}\n${stderr.slice(Math.max(0, stderr.length - 5000))}`,
    );
  }
  return result;
}

function runFixtureRaw(args, cwd, envOverrides = {}) {
  return runRaw(args, cwd, {
    _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
    _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
    ...envOverrides,
    NODE_V8_COVERAGE: "",
  });
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createProject(name, { killSwitch = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), `ive-migration-${name}-`));
  cpSync(join(repoRoot, ".agent"), join(tmp, ".agent"), { recursive: true });
  rmSync(join(tmp, ".agent/skills/iterative-planner/config/.config_integrity"), { force: true });

  writeJson(join(tmp, "audit.config.json"), {
    roles: ["core", "config_integrity", "traceability"],
    ive_features_disabled: killSwitch,
  });
  writeFileSync(join(tmp, "planner_manifesto.json"), "{\n  \"version\": 1,\n  \"north_star\": \"legacy traceability\"\n}\n");
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    stories: [],
  });
  ensureDir(join(tmp, "reports", "ontology"));
  writeFileSync(join(tmp, "reports", "ontology", "project.ttl"), "# pre-IVE ontology\n");

  for (let i = 0; i < 10; i += 1) {
    const planName = `plan_2026-05-${String(i + 1).padStart(2, "0")}_fixture${i}`;
    writeJson(join(tmp, "plans", planName, "state.json"), {
      state: "CLOSE",
      transitions: [
        { gate: "explore-to-plan", from: "EXPLORE", to: "PLAN", gate_result: "PASS", failure_codes: [] },
        { gate: "plan-to-execute", from: "PLAN", to: "EXECUTE", gate_result: "PASS", failure_codes: [] },
      ],
    });
  }

  return tmp;
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function runGit(cwd, args, { quiet = false } = {}) {
  const output = execFileSync("git", [
    "-c", "user.name=IVE Migration Fixture",
    "-c", "user.email=ive-migration-fixture@example.invalid",
    ...args,
  ], {
    cwd,
    encoding: "utf-8",
    stdio: quiet ? ["ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
    env: fixtureEnvironment(),
  });
  return typeof output === "string" ? output.trim() : "";
}

function appendText(path, text) {
  writeFileSync(path, `${readFileSync(path, "utf-8")}\n${text}\n`);
}

function commitAll(cwd, message, { noVerify = false } = {}) {
  runGit(cwd, ["add", "-A"], { quiet: true });
  runGit(cwd, [
    "commit",
    "-q",
    ...(noVerify ? ["--no-verify"] : []),
    "-m",
    message,
  ], { quiet: true });
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function cloneConsumer(sourceRoot, commit, label) {
  const targetRoot = mkdtempSync(join(tmpdir(), `ive-self-heal-${label}-`));
  cleanup(targetRoot);
  execFileSync("git", ["clone", "-q", sourceRoot, targetRoot], {
    stdio: ["ignore", "ignore", "pipe"],
    env: fixtureEnvironment(),
  });
  runGit(targetRoot, ["checkout", "-q", commit], { quiet: true });
  return targetRoot;
}

function rel(projectRoot, relPath) {
  return join(projectRoot, relPath);
}

const CANONICAL_FILE_PATHS = [
  "audit.config.json",
  "planner_manifesto.json",
  "reports/user_story_audit/story_registry.json",
  "reports/ontology/project.ttl",
];

function canonicalSnapshot(projectRoot) {
  return Object.fromEntries(CANONICAL_FILE_PATHS.map((relPath) => [
    relPath,
    existsSync(rel(projectRoot, relPath)) ? readFileSync(rel(projectRoot, relPath), "utf-8") : null,
  ]));
}

function assertCanonicalUnchanged(projectRoot, before, label) {
  const after = canonicalSnapshot(projectRoot);
  for (const relPath of CANONICAL_FILE_PATHS) {
    assert(after[relPath] === before[relPath], `${label} preserves ${relPath} bytes`);
  }
}

function forcePlannerVersion(projectRoot, version) {
  const skillPath = rel(projectRoot, ".agent/skills/iterative-planner/SKILL.md");
  const current = readFileSync(skillPath, "utf-8");
  const updated = /planner_version:\s*["'][^"']+["']/.test(current)
    ? current.replace(/planner_version:\s*["'][^"']+["']/, `planner_version: "${version}"`)
    : `---\nplanner_version: "${version}"\n---\n${current}`;
  writeFileSync(skillPath, updated);
}

function removePlannerVersionMarker(projectRoot) {
  const skillPath = rel(projectRoot, ".agent/skills/iterative-planner/SKILL.md");
  const current = readFileSync(skillPath, "utf-8");
  writeFileSync(skillPath, current.replace(/planner_version:\s*["'][^"']+["']\n?/, ""));
}

function withProjectRegistry(registry, fn) {
  const registryDir = mkdtempSync(join(tmpdir(), "ive-readiness-registry-"));
  const registryPath = join(registryDir, ".project_registry.json");
  const previous = process.env.PLANNER_PROJECT_REGISTRY_PATH;
  writeJson(registryPath, registry);
  process.env.PLANNER_PROJECT_REGISTRY_PATH = registryPath;
  try {
    return fn(registryPath);
  } finally {
    if (previous === undefined) {
      delete process.env.PLANNER_PROJECT_REGISTRY_PATH;
    } else {
      process.env.PLANNER_PROJECT_REGISTRY_PATH = previous;
    }
    cleanup(registryDir);
  }
}

console.log("\nIVE Migration Bootstrap Tests\n");

function testFrontDoorStatusAndDefaultAdopt() {
  const tmp = createProject("front-door");
  try {
    const beforeStatus = canonicalSnapshot(tmp);
    const status = runJson([sourceMigrate, "ive-status", tmp, "--phase", "0.5", "--json"]);
    assert(status.ok && status.operation === "ive-status", "ive-status reports PASS");
    assert(status.read_only === true && status.canonical_files_touched === false, "ive-status is read-only and touches no canonical files");
    assert(status.ive_adoption.status === "not_adopted", "ive-status classifies a fresh fixture as not adopted");
    assert(status.commands.dry_run.includes("ive-adopt") && status.commands.dry_run.includes("--dry-run"), "ive-status names the exact dry-run adopt command");
    assert(status.commands.write_adopt.includes("ive-adopt") && status.commands.write_adopt.includes("--write"), "ive-status names the exact write adopt command");
    assert(status.commands.rollback.includes("rollback") && status.commands.recover.includes("recover"), "ive-status keeps rollback and recover commands visible");
    assert(status.commands.validate_migration.includes("validate-migration"), "ive-status names validate-migration command");
    assert(!existsSync(rel(tmp, "reports/migration")), "ive-status does not create a migration report directory");
    assertCanonicalUnchanged(tmp, beforeStatus, "ive-status");

    const beforeDefaultAdopt = canonicalSnapshot(tmp);
    const defaultAdopt = runJson([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5", "--json"]);
    assert(defaultAdopt.ok && defaultAdopt.dry_run === true, "ive-adopt defaults to dry-run without --write");
    assert(defaultAdopt.defaulted_to_dry_run === true && defaultAdopt.mode === "dry-run", "ive-adopt JSON records default dry-run mode");
    assert(defaultAdopt.canonical_files_touched === false, "ive-adopt default dry-run reports no canonical files touched");
    assert(defaultAdopt.follow_up_commands.write_adopt.includes("--write"), "ive-adopt dry-run reports the exact write follow-up command");
    assert(!existsSync(rel(tmp, "reports/migration")), "ive-adopt default dry-run does not create a migration report directory");
    assertCanonicalUnchanged(tmp, beforeDefaultAdopt, "ive-adopt default dry-run");

    const humanDefaultAdopt = runRaw([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5"]);
    assert(
      humanDefaultAdopt.ok
        && humanDefaultAdopt.status === 0
        && /IVE MIGRATION\s+pass/i.test(humanDefaultAdopt.stdout)
        && humanDefaultAdopt.stdout.includes("Mode:      dry-run (default)"),
      "ive-adopt human success renders PASS and preserves the zero exit status",
    );
    assertCanonicalUnchanged(tmp, beforeDefaultAdopt, "ive-adopt human default dry-run");

    const beforeExplicitDryRun = canonicalSnapshot(tmp);
    const explicitDryRun = runJson([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5", "--dry-run", "--json"]);
    assert(explicitDryRun.ok && explicitDryRun.dry_run === true, "explicit ive-adopt --dry-run reports PASS");
    assert(existsSync(rel(tmp, explicitDryRun.report.md_path)), "explicit ive-adopt --dry-run writes markdown migration plan");
    assertCanonicalUnchanged(tmp, beforeExplicitDryRun, "explicit ive-adopt --dry-run");

    const conflict = runRaw([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5", "--dry-run", "--write", "--json"]);
    assert(!conflict.ok && conflict.status === 1, "ive-adopt JSON failure exits one for simultaneous --dry-run and --write");
    const conflictJson = JSON.parse(conflict.stdout);
    assert(conflictJson.status === "FAIL" && /mutually exclusive/.test(conflictJson.reason), "mode conflict explains the mutually exclusive flags");

    const humanConflict = runRaw([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5", "--dry-run", "--write"]);
    assert(
      !humanConflict.ok
        && humanConflict.status === 1
        && /IVE MIGRATION\s+fail/i.test(humanConflict.stdout)
        && humanConflict.stdout.includes("--dry-run and --write are mutually exclusive"),
      "ive-adopt human failure renders FAIL and preserves the one exit status",
    );

    const humanWriteAdopt = runRaw([sourceMigrate, "ive-adopt", tmp, "--phase", "0.5", "--write"]);
    assert(
      humanWriteAdopt.ok
        && humanWriteAdopt.status === 0
        && /IVE MIGRATION\s+pass/i.test(humanWriteAdopt.stdout)
        && humanWriteAdopt.stdout.includes("Mode:      write")
        && humanWriteAdopt.stdout.includes("Canonical touched: yes")
        && humanWriteAdopt.stdout.includes("Read-only: no")
        && humanWriteAdopt.stdout.includes("Backup:")
        && humanWriteAdopt.stdout.includes("Backup dir:")
        && humanWriteAdopt.stdout.includes("Report:")
        && humanWriteAdopt.stdout.includes("Plan:")
        && humanWriteAdopt.stdout.includes("Config integrity: retired"),
      "ive-adopt human write renders its mutation, backup, report, and config-integrity evidence",
    );
  } finally {
    cleanup(tmp);
  }
}

function testFrontDoorClassifiesLaggingWithoutAdoption() {
  const tmp = createProject("lagging-front-door");
  try {
    forcePlannerVersion(tmp, "0.5.0");
    const beforeStatus = canonicalSnapshot(tmp);
    const status = runJson([sourceMigrate, "ive-status", tmp, "--phase", "0.5", "--json"]);
    assert(status.ok && status.planner_install.classification === "lagging", "ive-status classifies an older planner version as lagging");
    assert(status.ive_adoption.enabled === false && status.ive_adoption.status === "not_adopted", "lagging status does not silently enable IVE");
    const auditConfig = JSON.parse(readFileSync(rel(tmp, "audit.config.json"), "utf-8"));
    assert(!auditConfig.ive_migration, "lagging status does not write audit.config.json ive_migration metadata");
    assertCanonicalUnchanged(tmp, beforeStatus, "lagging ive-status");
  } finally {
    cleanup(tmp);
  }
}

function testDryRunRollbackAndValidate() {
  const tmp = createProject("journey");
  try {
    const auditBefore = readFileSync(rel(tmp, "audit.config.json"), "utf-8");
    const manifestoBefore = readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8");
    const storyBefore = readFileSync(rel(tmp, "reports/user_story_audit/story_registry.json"), "utf-8");

    const dryRun = runJson([sourceMigrate, "upgrade", tmp, "--to-ive", "--phase", "0.5", "--dry-run", "--json"]);
    assert(dryRun.ok && dryRun.dry_run === true, "dry-run reports PASS without activation");
    assert(existsSync(rel(tmp, dryRun.report.md_path)), "dry-run writes markdown migration plan");
    assert(readFileSync(rel(tmp, "audit.config.json"), "utf-8") === auditBefore, "dry-run preserves audit.config.json bytes");
    assert(readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8") === manifestoBefore, "dry-run preserves planner_manifesto.json bytes");
    assert(readFileSync(rel(tmp, "reports/user_story_audit/story_registry.json"), "utf-8") === storyBefore, "dry-run preserves story_registry.json bytes");

    const upgrade = runJson([sourceMigrate, "upgrade", tmp, "--to-ive", "--phase", "2", "--json"]);
    assert(upgrade.ok && upgrade.status === "PASS", "phase 2 upgrade reports PASS");
    assert(existsSync(rel(tmp, upgrade.backup_manifest)), "phase 2 writes backup manifest");
    assert(JSON.parse(readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8")).schema_version === 2, "phase 2 upgrades manifesto to schema_version 2");
    assert(!existsSync(rel(tmp, ".agent/skills/iterative-planner/config/.config_integrity")), "phase 2 does not recreate retired .config_integrity");
    const integrityStatus = JSON.parse(execFileSync(NODE, [
      "--input-type=module",
      "-e",
      "import{checkConfigIntegrity}from'./scripts/lib/determinism.mjs';console.log(JSON.stringify(checkConfigIntegrity()));",
    ], {
      cwd: rel(tmp, ".agent/skills/iterative-planner"),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: fixtureEnvironment(),
    }));
    assert(integrityStatus.intact === true && integrityStatus.retired === true, "config integrity check reports retired after copied planner files change");

    const rollback = runJson([sourceMigrate, "rollback", tmp, "--phase", "2", "--json"]);
    assert(rollback.ok && rollback.status === "PASS", "rollback phase 2 reports PASS");
    assert(readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8") === manifestoBefore, "rollback restores v1 manifesto byte-for-byte");

    const validate = runJson([sourceMigrate, "validate-migration", tmp, "--plans", "10", "--json"]);
    assert(validate.ok && validate.status === "PASS", "validate-migration reports PASS");
    assert(validate.plans_replayed === 10, "validate-migration replays 10 historical plans");
    assert(validate.drift_count === 0 && validate.gate_verdicts_byte_identical === true, "validate-migration reports zero drift and byte-identical verdicts");
    assert(existsSync(rel(tmp, validate.report.json_path)), "validate-migration writes JSON report");
  } finally {
    cleanup(tmp);
  }
}

function testKillSwitch() {
  const tmp = createProject("kill-switch", { killSwitch: true });
  try {
    const auditBefore = readFileSync(rel(tmp, "audit.config.json"), "utf-8");
    const manifestoBefore = readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8");
    const result = runJson([sourceMigrate, "upgrade", tmp, "--to-ive", "--phase", "2", "--json"]);
    assert(result.ok && result.status === "SKIPPED", "kill switch makes IVE upgrade skip activation");
    assert(result.kill_switch_enabled === true, "kill switch result records disabled state");
    assert(readFileSync(rel(tmp, "audit.config.json"), "utf-8") === auditBefore, "kill switch preserves audit.config.json bytes");
    assert(readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8") === manifestoBefore, "kill switch preserves planner_manifesto.json bytes");
  } finally {
    cleanup(tmp);
  }
}

function testRecovery() {
  const tmp = createProject("recover");
  try {
    const manifestoBefore = readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8");
    const upgrade = runJson([sourceMigrate, "upgrade", tmp, "--to-ive", "--phase", "2", "--json"]);
    const backupDir = rel(tmp, dirname(upgrade.backup_manifest));
    writeFileSync(rel(tmp, "planner_manifesto.json"), "{\n  \"partial\": true\n}\n");
    writeJson(rel(tmp, ".agent/skills/iterative-planner/migration_backups/.ive_migration_in_progress.json"), {
      schema_version: 1,
      status: "in_progress",
      phase: "2",
      backup_dir: backupDir,
      operation: "upgrade --to-ive",
    });

    const recovered = runJson([sourceMigrate, "recover", tmp, "--phase", "2", "--json"]);
    assert(recovered.ok && recovered.recovery_status === "rolled_back_to_backup", "recover rolls back an interrupted migration to backup");
    assert(readFileSync(rel(tmp, "planner_manifesto.json"), "utf-8") === manifestoBefore, "recover restores manifesto bytes from backup");

    const aliasRecovered = runJson([sourceMigrate, "--recover", tmp, "--phase", "2", "--json"]);
    assert(aliasRecovered.ok && aliasRecovered.recovery_status === "no_in_progress_migration", "--recover alias is accepted and idempotent");
  } finally {
    cleanup(tmp);
  }
}

function testRetentionWarning() {
  const tmp = createProject("retention");
  try {
    const backupDir = rel(tmp, ".agent/skills/iterative-planner/migration_backups/2_2026-05-31T00-00-00Z");
    writeJson(join(backupDir, "manifest.json"), {
      schema_version: 1,
      status: "complete",
      phase: "2",
      created_at: "2026-05-31T00:00:00.000Z",
      retention_days: 90,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      files: [],
    });
    const stdout = execFileSync(NODE, [rel(tmp, ".agent/skills/iterative-planner/scripts/bootstrap.mjs"), "status"], {
      cwd: tmp,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: fixtureEnvironment({ PLANNER_SKIP_SELF_HEAL: "1" }),
    });
    assert(stdout.includes("IVE migration backup retention window expiring"), "bootstrap status warns when backup retention is near expiry");
  } finally {
    cleanup(tmp);
  }
}

function testMigrationReadinessCurrentJsonAndHuman() {
  const tmp = createProject("readiness-current");
  try {
    const before = canonicalSnapshot(tmp);
    const report = runJson([sourceMigrate, "migration-readiness", tmp, "--phase", "0.5", "--json"]);
    assert(report.ok && report.operation === "migration-readiness", "migration-readiness JSON reports operation");
    assert(report.read_only === true && report.canonical_files_touched === false, "migration-readiness is read-only");
    assert(report.labels.includes("current"), "migration-readiness labels current install");
    assert(report.labels.includes("dry_run_clean"), "migration-readiness labels clean dry-run path");
    assert(report.ive_adoption.dry_run_clean === true, "migration-readiness JSON exposes dry_run_clean boolean");
    assert(report.fleet_registry.single_project_blocker === false, "migration-readiness registry data is not a single-project blocker");
    assert(Array.isArray(report.deterministic_blockers), "migration-readiness JSON separates deterministic blockers");
    assert(Array.isArray(report.advisory_gaps), "migration-readiness JSON separates advisory gaps");
    assert(Array.isArray(report.remaining_actions), "migration-readiness JSON lists remaining actions");
    assertCanonicalUnchanged(tmp, before, "migration-readiness JSON");

    const human = runRaw([sourceMigrate, "migration-readiness", tmp, "--phase", "0.5"]);
    assert(human.ok && human.stdout.includes("MIGRATION READINESS SUMMARY"), "migration-readiness human output renders summary");
    assert(human.stdout.includes("Deterministic blockers:"), "migration-readiness human output names deterministic blockers");
    assert(human.stdout.includes("Advisory gaps:"), "migration-readiness human output names advisory gaps");
    assert(human.stdout.includes("Remaining operator actions:"), "migration-readiness human output names remaining actions");
    assert(human.stdout.includes("Registry scope:"), "migration-readiness human output preserves registry scope");

    const missingSourceRefResult = runRaw([sourceMigrate, "detect", tmp, "--source-ref"]);
    assert(
      !missingSourceRefResult.ok && String(missingSourceRefResult.stderr).includes("--source-ref requires a non-empty"),
      "missing --source-ref value fails closed before migration routing",
    );
    const emptySourceRefResult = runRaw([sourceMigrate, "detect", tmp, "--source-ref="]);
    assert(
      !emptySourceRefResult.ok && String(emptySourceRefResult.stderr).includes("--source-ref requires a non-empty"),
      "empty inline --source-ref value fails closed before migration routing",
    );
    assertCanonicalUnchanged(tmp, before, "malformed source-ref options");
  } finally {
    cleanup(tmp);
  }
}

function testMigrationReadinessOldMarkerAndHeuristicLegacy() {
  const oldMarker = createProject("readiness-old-marker");
  try {
    forcePlannerVersion(oldMarker, "5.1.6");
    const report = runJson([sourceMigrate, "migration-readiness", oldMarker, "--json"]);
    assert(report.labels.includes("supported_lagging"), "migration-readiness labels old explicit marker as supported_lagging");
    assert(report.planner_install.old_planner_handling_mode === "supported_lagging_upgrade", "migration-readiness recommends supported lagging upgrade mode");
  } finally {
    cleanup(oldMarker);
  }

  const heuristic = createProject("readiness-heuristic");
  try {
    removePlannerVersionMarker(heuristic);
    const report = runJson([sourceMigrate, "migration-readiness", heuristic, "--json"]);
    assert(report.labels.includes("heuristic_version"), "migration-readiness labels heuristic version detection");
    assert(report.legacy_handling.heuristic_version === true, "migration-readiness JSON exposes heuristic_version boolean");
  } finally {
    cleanup(heuristic);
  }

  const legacy = mkdtempSync(join(tmpdir(), "ive-migration-readiness-legacy-"));
  try {
    ensureDir(join(legacy, ".agent", "iterative-planner"));
    writeFileSync(join(legacy, ".agent", "iterative-planner", "SKILL.md"), "# Legacy planner\nKnowledge Base Gate\n");
    const report = runJson([sourceMigrate, "migration-readiness", legacy, "--json"]);
    assert(report.labels.includes("legacy_layout"), "migration-readiness labels legacy layout");
    assert(report.labels.includes("blocked"), "migration-readiness labels missing standard planner layout as blocked");
    assert(report.legacy_handling.legacy_layout === true, "migration-readiness JSON exposes legacy_layout boolean");
  } finally {
    cleanup(legacy);
  }
}

function testMigrationReadinessKillSwitchBackupAndRegistry() {
  const tmp = createProject("readiness-kill-switch", { killSwitch: true });
  try {
    const report = runJson([sourceMigrate, "migration-readiness", tmp, "--phase", "2", "--json"]);
    assert(report.labels.includes("kill_switch_enabled"), "migration-readiness labels kill switch");
    assert(report.ive_adoption.kill_switch_enabled === true, "migration-readiness JSON exposes kill switch");
    assert(report.deterministic_blockers.some((entry) => entry.code === "kill_switch_enabled"), "migration-readiness lists kill switch as deterministic blocker");
  } finally {
    cleanup(tmp);
  }

  const backed = createProject("readiness-backup");
  try {
    const upgrade = runJson([sourceMigrate, "upgrade", backed, "--to-ive", "--phase", "2", "--json"]);
    assert(upgrade.ok && upgrade.status === "PASS", "readiness backup fixture writes IVE backup");
    const report = runJson([sourceMigrate, "migration-readiness", backed, "--phase", "2", "--json"]);
    assert(report.labels.includes("backup_ready"), "migration-readiness labels backup_ready");
    assert(report.labels.includes("rollback_available"), "migration-readiness labels rollback_available");
    assert(report.safety.backup_ready === true && report.safety.rollback_available === true, "migration-readiness JSON exposes backup and rollback readiness");
  } finally {
    cleanup(backed);
  }

  const registryProject = createProject("readiness-registry");
  try {
    const missingPath = join(dirname(registryProject), "missing-readiness-registry-project");
    withProjectRegistry({
      last_scan: new Date().toISOString(),
      projects: [
        { path: registryProject, type: "standard", version: "10.0.0", last_seen: new Date().toISOString() },
        { path: missingPath, type: "standard", version: "10.0.0", last_seen: new Date().toISOString() },
      ],
      scan_roots: [registryProject, missingPath],
    }, () => {
      const report = runJson([sourceMigrate, "migration-readiness", registryProject, "--json"]);
      assert(report.fleet_registry.stale_paths_status === "advisory_fleet_only", "migration-readiness reports stale registry as fleet advisory");
      assert(report.fleet_registry.stale_paths_ignored === 1, "migration-readiness counts stale registry paths");
      assert(report.fleet_registry.single_project_blocker === false, "migration-readiness keeps stale registry out of single-project blockers");
      assert(report.advisory_gaps.some((entry) => entry.code === "stale_registry_paths"), "migration-readiness lists stale registry as advisory gap");
      assert(!report.deterministic_blockers.some((entry) => entry.code === "stale_registry_paths"), "migration-readiness does not list stale registry as deterministic blocker");
    });
  } finally {
    cleanup(registryProject);
  }
}

function testCommittedSourceAndThreeWaySelfHealSafety() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "ive-self-heal-source-"));
  const consumers = [];
  const managedRel = ".agent/skills/iterative-planner/prolog/invariants.pl";
  const secondManagedRel = ".agent/skills/iterative-planner/MIGRATION.md";
  const retiredWorkflowRel = ".agent/workflows/b4fc-retired-workflow.md";
  const sidekickWorkflowRel = ".agent/workflows/sidekick.md";
  const retiredTestRel = ".agent/skills/iterative-planner/tests/test_b4fc_retired_contract.mjs";
  const customWorkflowRel = ".agent/workflows/customer-custom-workflow.md";
  const customWorkflowBytes = "---\ndescription: Consumer-owned workflow fixture\n---\n\n# Customer workflow\n";
  const customTestRel = ".agent/skills/iterative-planner/tests/fixtures/customer_custom_probe.json";
  const projectRegistryRel = ".agent/skills/iterative-planner/config/.project_registry.json";
  const workflowInventoryRel = ".agent/skills/iterative-planner/config/workflow_migration_inventory.json";
  const legacyProvenanceRel = ".agent/skills/iterative-planner/config/legacy_managed_blob_provenance.json";
  const ledgerOnlyLegacyBytes = "% CANONICAL LEGACY RELEASE BYTES OMITTED FROM REACHABLE HISTORY\n";
  const dirtySentinel = "% DIRTY_UPSTREAM_WORKTREE_MUST_NEVER_SHIP";
  const committedV2 = "% COMMITTED_UPSTREAM_V2";
  const committedV3 = "% COMMITTED_UPSTREAM_V3";
  const committedDocV2 = "<!-- COMMITTED_UPSTREAM_DOC_V2 -->";
  const consumerFix = "% I-035 COMMITTED CONSUMER FIX MUST SURVIVE";
  const ignoreManagedPath = (projectRoot, relativePath) => {
    runGit(projectRoot, ["rm", "--cached", "--", relativePath], { quiet: true });
    const ignorePath = join(projectRoot, ".gitignore");
    const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf-8") : "";
    writeFileSync(ignorePath, `${existing}/${relativePath}\n`);
    commitAll(projectRoot, `fixture: ignore legacy managed path ${relativePath}`);
  };

  try {
    if (process.env.NODE_V8_COVERAGE) {
      // Coverage measurement runs before the staged planner release is committed.
      // Pin the exact bytes being measured in a dedicated immutable source repo
      // instead of pairing the staged runtime with the older repository HEAD.
      const coverageSourceRoot = mkdtempSync(join(tmpdir(), "ive-migration-canonical-source-"));
      consumers.push(coverageSourceRoot);
      cpSync(join(repoRoot, ".agent"), join(coverageSourceRoot, ".agent"), { recursive: true });
      for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
        cpSync(join(repoRoot, rootInstruction), join(coverageSourceRoot, rootInstruction));
      }
      runGit(coverageSourceRoot, ["init", "-q"], { quiet: true });
      const sourceHead = commitAll(coverageSourceRoot, "fixture: immutable coverage source");

      // Keep the staged runtime's internal apply path visible to c8. The real
      // transaction intentionally clears NODE_V8_COVERAGE inside its scratch
      // candidate so coverage files from copied source paths cannot collide
      // with the canonical report. This disposable target exercises the same
      // internal apply command directly while the outer test owns cleanup.
      const coverageDirectTarget = mkdtempSync(join(tmpdir(), "ive-migration-direct-coverage-"));
      consumers.push(coverageDirectTarget);
      cpSync(join(repoRoot, ".agent"), join(coverageDirectTarget, ".agent"), { recursive: true });
      for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
        cpSync(join(repoRoot, rootInstruction), join(coverageDirectTarget, rootInstruction));
      }
      runGit(coverageDirectTarget, ["init", "-q"], { quiet: true });
      commitAll(coverageDirectTarget, "fixture: direct coverage target");
      const directCoverageRegistry = JSON.parse(readFileSync(join(coverageDirectTarget, projectRegistryRel), "utf-8"));
      directCoverageRegistry.source_project_path = coverageDirectTarget;
      writeJson(join(coverageDirectTarget, projectRegistryRel), directCoverageRegistry);
      commitAll(coverageDirectTarget, "fixture: direct coverage host state");
      const directCoverageEnv = {
        _PLANNER_PINNED_SOURCE_RUNNING: "1",
        PLANNER_CANONICAL_SOURCE_REPO: coverageSourceRoot,
        PLANNER_SOURCE_REF_RESOLVED: sourceHead,
        PLANNER_SOURCE_COMMIT: sourceHead,
      };
      const coverageHelp = runRaw([sourceMigrate, "--help"], coverageSourceRoot, directCoverageEnv);
      const coverageDetect = runRaw([sourceMigrate, "detect", coverageDirectTarget], coverageSourceRoot, directCoverageEnv);
      const coverageDoctor = runRaw([sourceMigrate, "doctor", coverageDirectTarget, "--json"], coverageSourceRoot, directCoverageEnv);
      const coverageDoctorHuman = runRaw([sourceMigrate, "doctor", coverageDirectTarget], coverageSourceRoot, directCoverageEnv);
      const coverageVerify = runRaw([sourceMigrate, "verify", coverageDirectTarget], coverageSourceRoot, directCoverageEnv);
      const coverageConsent = runRaw([
        sourceMigrate,
        "upgrade", coverageDirectTarget, "--source-ref", sourceHead,
      ], coverageSourceRoot, directCoverageEnv);
      const coverageSeedConsent = runRaw([
        sourceMigrate,
        "upgrade", coverageDirectTarget, "--source-ref", sourceHead, "--seed-kb",
      ], coverageSourceRoot, directCoverageEnv);
      const coverageInternalRefusal = runRaw([
        sourceMigrate,
        "upgrade", coverageDirectTarget, "--source-ref", sourceHead, "--transaction-apply",
      ], coverageSourceRoot, directCoverageEnv);
      const coverageRecoveryRefusal = runRaw([
        sourceMigrate,
        "recover-upgrade", coverageDirectTarget, "--source-ref", sourceHead,
      ], coverageSourceRoot, directCoverageEnv);
      const coverageRecoveryJson = runRaw([
        sourceMigrate,
        "recover-upgrade", coverageDirectTarget, "--source-ref", sourceHead, "--json",
      ], coverageSourceRoot, directCoverageEnv);
      if (
        !coverageHelp.stdout.includes("Commands:")
        || coverageDetect.status !== 0
        || !coverageDetect.stdout.includes("All files present")
        || !coverageDoctor.stdout.includes("\"committed_version\"")
        || !coverageDoctorHuman.stdout.includes("Committed version:")
        || coverageVerify.status !== 0
        || !coverageVerify.stdout.includes("ritual_contract_readiness PASS")
        || coverageConsent.status !== 2
        || !coverageConsent.stdout.includes("COMMIT CONSENT REQUIRED")
        || coverageSeedConsent.status !== 2
        || !coverageSeedConsent.stdout.includes("--seed-kb")
        || coverageInternalRefusal.status !== 2
        || !String(coverageInternalRefusal.stderr).includes("internal-only")
        || coverageRecoveryRefusal.status !== 0
        || !coverageRecoveryRefusal.stdout.includes("Managed upgrade recovery: no_transaction")
        || coverageRecoveryJson.status !== 0
        || !coverageRecoveryJson.stdout.includes("\"status\": \"no_transaction\"")
      ) {
        const probeSummary = Object.fromEntries(Object.entries({
          help: coverageHelp,
          detect: coverageDetect,
          doctor: coverageDoctor,
          doctor_human: coverageDoctorHuman,
          verify: coverageVerify,
          consent: coverageConsent,
          seed_consent: coverageSeedConsent,
          internal_refusal: coverageInternalRefusal,
          recovery_refusal: coverageRecoveryRefusal,
          recovery_json: coverageRecoveryJson,
        }).map(([key, value]) => [key, {
          status: value.status,
          stdout: String(value.stdout || "").slice(-600),
          stderr: String(value.stderr || "").slice(-600),
        }]));
        throw new Error(`canonical CLI coverage probes failed:\n${JSON.stringify(probeSummary, null, 2)}`);
      }
      const directCoverageApply = runRaw([
        sourceMigrate,
        "upgrade", coverageDirectTarget, "--source-ref", sourceHead, "--transaction-apply",
      ], coverageSourceRoot, {
        ...directCoverageEnv,
        _PLANNER_MANAGED_UPGRADE_INTERNAL: "1",
      });
      if (
        !directCoverageApply.ok
        || (!directCoverageApply.stdout.includes("SETUP COMPLETE") && !directCoverageApply.stdout.includes("UPGRADE COMPLETE"))
      ) {
        throw new Error(`canonical direct coverage apply failed: ${directCoverageApply.stdout || directCoverageApply.stderr}`);
      }
      const coveragePostApplyVerify = runRaw([
        sourceMigrate,
        "verify", coverageDirectTarget,
      ], coverageSourceRoot, directCoverageEnv);
      if (
        coveragePostApplyVerify.status !== 0
        || !coveragePostApplyVerify.stdout.includes("PASS — Installation complete")
      ) {
        throw new Error(`canonical post-apply verification coverage failed: ${coveragePostApplyVerify.stdout || coveragePostApplyVerify.stderr}`);
      }

      const coverageTarget = mkdtempSync(join(tmpdir(), "ive-migration-canonical-coverage-"));
      consumers.push(coverageTarget);
      cpSync(join(repoRoot, ".agent"), join(coverageTarget, ".agent"), { recursive: true });
      for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
        cpSync(join(repoRoot, rootInstruction), join(coverageTarget, rootInstruction));
      }
      runGit(coverageTarget, ["init", "-q"], { quiet: true });
      commitAll(coverageTarget, "fixture: canonical coverage target");
      writeFileSync(join(coverageTarget, customWorkflowRel), customWorkflowBytes);
      writeFileSync(join(coverageTarget, customTestRel), "{\"owner\":\"coverage-consumer\"}\n");
      const coverageRegistry = JSON.parse(readFileSync(join(coverageTarget, projectRegistryRel), "utf-8"));
      coverageRegistry.source_project_path = coverageTarget;
      writeJson(join(coverageTarget, projectRegistryRel), coverageRegistry);
      commitAll(coverageTarget, "fixture: coverage-only host state");
      const coverageEnv = {
        _PLANNER_PINNED_SOURCE_RUNNING: "1",
        PLANNER_CANONICAL_SOURCE_REPO: coverageSourceRoot,
        PLANNER_SOURCE_REF_RESOLVED: sourceHead,
        PLANNER_SOURCE_COMMIT: sourceHead,
      };
      const coverageProbe = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--dry-run",
      ], coverageSourceRoot, coverageEnv);
      if (
        !coverageProbe.ok
        || !coverageProbe.stdout.includes("WOULD MERGE: .project_registry.json source_project_path")
        || !coverageProbe.stdout.includes("WOULD MARK host-owned workflow: customer-custom-workflow.md")
        || !coverageProbe.stdout.includes(`PRESERVED non-canonical test asset: ${customTestRel}`)
      ) {
        throw new Error(`canonical coverage dry-run probe failed: ${coverageProbe.stdout || coverageProbe.stderr}`);
      }
      const coverageApply = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--commit",
      ], coverageSourceRoot, {
        ...coverageEnv,
        _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
        _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
      });
      if (
        !coverageApply.ok
        || !coverageApply.stdout.includes("UPDATED: .agent/skills/iterative-planner/config/.project_registry.json")
        || !existsSync(join(coverageTarget, customWorkflowRel))
        || !workflowFileHasExplicitHostOwnerMarker(join(coverageTarget, customWorkflowRel))
        || readFileSync(join(coverageTarget, customTestRel), "utf-8") !== "{\"owner\":\"coverage-consumer\"}\n"
      ) {
        const diagnostic = `${coverageApply.stdout || ""}\n${coverageApply.stderr || ""}`;
        throw new Error(`canonical coverage write probe failed:\n${diagnostic.slice(-12000)}`);
      }
      writeFileSync(join(coverageTarget, customWorkflowRel), customWorkflowBytes);
      commitAll(
        coverageTarget,
        "fixture: restore unmarked host workflow for canonical apply coverage",
        { noVerify: true },
      );
      const coverageMarkerApply = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--transaction-apply",
      ], coverageSourceRoot, {
        ...coverageEnv,
        _PLANNER_MANAGED_UPGRADE_INTERNAL: "1",
      });
      if (
        !coverageMarkerApply.ok
        || !coverageMarkerApply.stdout.includes("MARKED host-owned workflow:")
        || !workflowFileHasExplicitHostOwnerMarker(join(coverageTarget, customWorkflowRel))
      ) {
        throw new Error(`canonical host-workflow marker coverage failed: ${coverageMarkerApply.stdout || coverageMarkerApply.stderr}`);
      }
      const coverageNoOp = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--dry-run",
      ], coverageSourceRoot, coverageEnv);
      if (
        !coverageNoOp.ok
        || !coverageNoOp.stdout.includes("read-only no-op")
      ) {
        throw new Error(`canonical coverage no-op probe failed: ${coverageNoOp.stdout || coverageNoOp.stderr}`);
      }
      rmSync(join(coverageTarget, projectRegistryRel));
      commitAll(
        coverageTarget,
        "fixture: committed consumer without project registry",
        { noVerify: true },
      );
      const missingRegistryDryRun = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--dry-run",
      ], coverageSourceRoot, coverageEnv);
      if (
        !missingRegistryDryRun.ok
        || !missingRegistryDryRun.stdout.includes("WOULD MERGE: .project_registry.json source_project_path before_sha256=missing")
        || existsSync(join(coverageTarget, projectRegistryRel))
      ) {
        throw new Error(`canonical coverage missing-registry dry-run failed: ${missingRegistryDryRun.stdout || missingRegistryDryRun.stderr}`);
      }
      const missingRegistryApply = runRaw([
        sourceMigrate,
        "upgrade", coverageTarget, "--source-ref", sourceHead, "--commit",
      ], coverageSourceRoot, {
        ...coverageEnv,
        _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
        _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
      });
      if (
        !missingRegistryApply.ok
        || !existsSync(join(coverageTarget, projectRegistryRel))
      ) {
        throw new Error(`canonical coverage missing-registry write failed: ${missingRegistryApply.stdout || missingRegistryApply.stderr}`);
      }
    }

    cpSync(join(repoRoot, ".agent"), join(sourceRoot, ".agent"), { recursive: true });
    const parkedInventoryBytes = readFileSync(join(sourceRoot, workflowInventoryRel), "utf-8");
    const baseInventory = JSON.parse(parkedInventoryBytes);
    const baseSidekickEntry = baseInventory.entries.find((entry) => entry.workflow === "/sidekick");
    if (!baseSidekickEntry) throw new Error("fixture requires the governed /sidekick inventory row");
    baseSidekickEntry.v7_action = "New";
    baseSidekickEntry.notes = "Fixture base release keeps sidekick active before its governed retirement.";
    writeJson(join(sourceRoot, workflowInventoryRel), baseInventory);
    const ledgerProbePath = join(sourceRoot, ".ledger-only-legacy-probe");
    writeFileSync(ledgerProbePath, ledgerOnlyLegacyBytes);
    const ledgerOnlyLegacyBlob = runGit(sourceRoot, ["hash-object", "--", ledgerProbePath]);
    rmSync(ledgerProbePath);
    const legacyProvenance = JSON.parse(readFileSync(join(sourceRoot, legacyProvenanceRel), "utf-8"));
    legacyProvenance.entries.push({
      path: managedRel,
      git_blob: ledgerOnlyLegacyBlob,
      evidence: "hermetic_regression_fixture",
      matching_installations: 1,
      observed_versions: ["fixture"],
    });
    writeJson(join(sourceRoot, legacyProvenanceRel), legacyProvenance);
    writeFileSync(join(sourceRoot, sidekickWorkflowRel), "# Active sidekick before its parked disposition\n");
    writeFileSync(join(sourceRoot, retiredWorkflowRel), "# Planner-owned workflow before retirement\n");
    writeFileSync(join(sourceRoot, retiredTestRel), "process.exit(0);\n");
    runGit(sourceRoot, ["init", "-q"], { quiet: true });
    const sidekickActiveCommit = commitAll(sourceRoot, "fixture: active sidekick release");
    writeFileSync(join(sourceRoot, workflowInventoryRel), parkedInventoryBytes);
    rmSync(join(sourceRoot, sidekickWorkflowRel));
    mkdirSync(join(sourceRoot, ".agent", "_parked"), { recursive: true });
    writeFileSync(join(sourceRoot, ".agent", "_parked", "sidekick.md"), "# Parked sidekick\n");
    const baseCommit = commitAll(sourceRoot, "fixture: base planner release");

    appendText(join(sourceRoot, managedRel), committedV2);
    appendText(join(sourceRoot, secondManagedRel), committedDocV2);
    rmSync(join(sourceRoot, retiredWorkflowRel));
    rmSync(join(sourceRoot, retiredTestRel));
    const sourceCommit = commitAll(sourceRoot, "fixture: committed planner release v2");
    appendText(join(sourceRoot, managedRel), committedV3);
    const aheadCommit = commitAll(sourceRoot, "fixture: committed planner release v3");
    appendText(join(sourceRoot, managedRel), dirtySentinel);
    assert(
      !listFleetManagedWorkflowFiles(sourceRoot, { requireParkedArtifacts: true }).includes("sidekick.md"),
      "selected source fleet projection excludes parked sidekick",
    );

    const stale = cloneConsumer(sourceRoot, sidekickActiveCommit, "stale");
    consumers.push(stale);
    writeFileSync(join(stale, customWorkflowRel), customWorkflowBytes);
    writeFileSync(join(stale, customTestRel), "{\"owner\":\"consumer\"}\n");
    const staleRegistry = JSON.parse(readFileSync(join(stale, projectRegistryRel), "utf-8"));
    staleRegistry.projects = [{ path: "/consumer-only-project", type: "standard" }];
    staleRegistry.source_project_path = stale;
    writeJson(join(stale, projectRegistryRel), staleRegistry);
    commitAll(stale, "fixture: add host workflow and local fleet registry");
    const staleBefore = readFileSync(join(stale, managedRel), "utf-8");
    const staleRegistryBefore = readFileSync(join(stale, projectRegistryRel), "utf-8");
    // Keep one real migration subprocess coverage-aware so the planner-core
    // ratchet measures the dry-run merge/preservation path without
    // instrumenting every hermetic migration subprocess in this suite.
    const staleDryRun = debugRaw("stale-dry-run", runRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", stale, "--source-ref", sourceCommit, "--dry-run",
    ], sourceRoot));
    assert(
      staleDryRun.ok
        && staleDryRun.stdout.includes("WOULD MERGE: .project_registry.json source_project_path")
        && staleDryRun.stdout.includes("WOULD MARK host-owned workflow: customer-custom-workflow.md")
        && staleDryRun.stdout.includes(`PRESERVED non-canonical test asset: ${customTestRel}`),
      "dry-run reports registry merge, host-workflow ownership marking, and test preservation",
    );
    assert(readFileSync(join(stale, managedRel), "utf-8") === staleBefore, "dry-run leaves stale managed bytes unchanged");
    assert(
      readFileSync(join(stale, projectRegistryRel), "utf-8") === staleRegistryBefore
        && existsSync(join(stale, customWorkflowRel)),
      "dry-run leaves project-local registry and workflow bytes unchanged",
    );
    const staleResult = debugRaw("stale", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", stale, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const staleAfter = readFileSync(join(stale, managedRel), "utf-8");
    assert(staleResult.ok, "genuinely stale target updates cleanly from the selected source commit");
    assert(staleAfter.includes(committedV2) && !staleAfter.includes(dirtySentinel), "stale target receives committed bytes and never dirty upstream bytes");
    assert(staleBefore !== staleAfter, "stale positive control changes the managed target bytes");
    assert(!existsSync(join(stale, sidekickWorkflowRel)), "stale active sidekick is pruned by the selected parked disposition");
    assert(!existsSync(join(stale, retiredWorkflowRel)), "unchanged planner-owned workflow retired by the selected source commit is removed");
    assert(!existsSync(join(stale, retiredTestRel)), "unchanged planner-owned test retired by the selected source commit is removed atomically with the census");
    assert(
      existsSync(join(stale, customWorkflowRel))
        && workflowFileHasExplicitHostOwnerMarker(join(stale, customWorkflowRel))
        && readFileSync(join(stale, customWorkflowRel), "utf-8").startsWith("---\ndescription: Consumer-owned workflow fixture\n---\n")
        && readFileSync(join(stale, customWorkflowRel), "utf-8").includes("# Customer workflow"),
      "non-canonical host workflow keeps its frontmatter and body while receiving explicit ownership",
    );
    assert(
      readFileSync(join(stale, customTestRel), "utf-8") === "{\"owner\":\"consumer\"}\n",
      "non-canonical consumer test asset is preserved byte-for-byte",
    );
    const staleRegistryAfter = JSON.parse(readFileSync(join(stale, projectRegistryRel), "utf-8"));
    assert(
      staleRegistryAfter.projects?.length === 1
        && staleRegistryAfter.projects[0]?.path === "/consumer-only-project",
      "project-local fleet registry entries survive managed upgrade",
    );
    assert(
      realpathSync(staleRegistryAfter.source_project_path) === realpathSync(sourceRoot),
      "project-local fleet registry source pointer is merged to canonical source",
    );
    assert(/before_sha256=[a-f0-9]{64}.*after_sha256=[a-f0-9]{64}/s.test(staleResult.stdout), "stale overwrite discloses full before and after SHA-256 hashes");
    assert(staleResult.stdout.includes(`Source commit: ${sourceCommit}`), "migration output discloses the selected source commit");
    assert(staleResult.stdout.includes(`--source-ref ${sourceCommit}`), "migration output prints the exact pinned first-hop command");

    const untrackedHistorical = cloneConsumer(sourceRoot, baseCommit, "untracked-historical");
    consumers.push(untrackedHistorical);
    ignoreManagedPath(untrackedHistorical, managedRel);
    const untrackedHistoricalBefore = readFileSync(join(untrackedHistorical, managedRel), "utf-8");
    const untrackedHistoricalBlob = runGit(untrackedHistorical, ["hash-object", "--", managedRel]);
    const canonicalBaseBlob = runGit(sourceRoot, ["rev-parse", `${baseCommit}:${managedRel}`]);
    assert(runGit(untrackedHistorical, ["ls-files", "--", managedRel]) === "", "historical positive control is absent from target HEAD");
    assert(runGit(untrackedHistorical, ["check-ignore", "-q", "--", managedRel]) === "", "historical positive control is ignored by the target");
    assert(untrackedHistoricalBlob === canonicalBaseBlob, "historical positive control working bytes exactly match selected source ancestry");
    const untrackedHistoricalResult = debugRaw("untracked-historical", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", untrackedHistorical, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const untrackedHistoricalAfter = readFileSync(join(untrackedHistorical, managedRel), "utf-8");
    assert(untrackedHistoricalResult.ok, "exact historical untracked target upgrades from selected source ancestry");
    assert(
      untrackedHistoricalBefore !== untrackedHistoricalAfter
        && untrackedHistoricalAfter.includes(committedV2)
        && !untrackedHistoricalAfter.includes(dirtySentinel),
      "exact historical untracked target receives committed selected-source bytes",
    );

    const ledgerOnlyLegacy = cloneConsumer(sourceRoot, baseCommit, "ledger-only-legacy");
    consumers.push(ledgerOnlyLegacy);
    ignoreManagedPath(ledgerOnlyLegacy, managedRel);
    writeFileSync(join(ledgerOnlyLegacy, managedRel), ledgerOnlyLegacyBytes);
    const ledgerOnlyLegacyBefore = readFileSync(join(ledgerOnlyLegacy, managedRel), "utf-8");
    assert(
      runGit(ledgerOnlyLegacy, ["hash-object", "--", managedRel]) === ledgerOnlyLegacyBlob,
      "ledger-only positive control exactly matches its same-path provenance entry",
    );
    const ledgerOnlyLegacyResult = debugRaw("ledger-only-legacy", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", ledgerOnlyLegacy, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const ledgerOnlyLegacyAfter = readFileSync(join(ledgerOnlyLegacy, managedRel), "utf-8");
    assert(ledgerOnlyLegacyResult.ok, "exact ledger-backed untracked target upgrades through the selected source snapshot");
    assert(
      ledgerOnlyLegacyBefore !== ledgerOnlyLegacyAfter
        && ledgerOnlyLegacyAfter.includes(committedV2)
        && !ledgerOnlyLegacyAfter.includes(dirtySentinel),
      "ledger-backed target receives committed selected-source bytes",
    );

    const untrackedUnknown = cloneConsumer(sourceRoot, baseCommit, "untracked-unknown");
    consumers.push(untrackedUnknown);
    ignoreManagedPath(untrackedUnknown, managedRel);
    appendText(join(untrackedUnknown, managedRel), "% UNKNOWN UNTRACKED TARGET EDIT");
    const untrackedUnknownBefore = readFileSync(join(untrackedUnknown, managedRel), "utf-8");
    const untrackedUnknownSiblingBefore = readFileSync(join(untrackedUnknown, secondManagedRel), "utf-8");
    const untrackedUnknownResult = debugRaw("untracked-unknown", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", untrackedUnknown, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!untrackedUnknownResult.ok, "unknown untracked target content blocks managed sync");
    assert(untrackedUnknownResult.stdout.includes("unclassifiable_target"), "unknown untracked target remains explicitly unclassifiable");
    assert(readFileSync(join(untrackedUnknown, managedRel), "utf-8") === untrackedUnknownBefore, "unknown untracked target survives byte-for-byte");
    assert(readFileSync(join(untrackedUnknown, secondManagedRel), "utf-8") === untrackedUnknownSiblingBefore, "unknown untracked conflict aborts stale sibling writes");

    const untrackedAhead = cloneConsumer(sourceRoot, aheadCommit, "untracked-ahead");
    consumers.push(untrackedAhead);
    ignoreManagedPath(untrackedAhead, managedRel);
    const untrackedAheadBefore = readFileSync(join(untrackedAhead, managedRel), "utf-8");
    const untrackedAheadResult = debugRaw("untracked-ahead", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", untrackedAhead, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!untrackedAheadResult.ok, "untracked target newer than selected source ref blocks downgrade");
    assert(untrackedAheadResult.stdout.includes("untracked_ahead_of_source_ref"), "untracked ahead-of-pin refusal is classified explicitly");
    assert(readFileSync(join(untrackedAhead, managedRel), "utf-8") === untrackedAheadBefore, "untracked ahead-of-pin target survives byte-for-byte");

    const committedAhead = cloneConsumer(sourceRoot, baseCommit, "committed-ahead");
    consumers.push(committedAhead);
    appendText(join(committedAhead, managedRel), consumerFix);
    commitAll(committedAhead, "fix: preserve consumer I-035 behavior");
    const protectedBefore = readFileSync(join(committedAhead, managedRel), "utf-8");
    const secondBefore = readFileSync(join(committedAhead, secondManagedRel), "utf-8");
    const committedAheadResult = debugRaw("committed-divergence", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", committedAhead, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!committedAheadResult.ok, "committed consumer fix blocks self-heal instead of being overwritten");
    assert(readFileSync(join(committedAhead, managedRel), "utf-8") === protectedBefore, "committed I-035-style consumer fix survives byte-for-byte");
    assert(readFileSync(join(committedAhead, secondManagedRel), "utf-8") === secondBefore, "one conflict aborts the whole managed sync before other stale writes");
    assert(committedAheadResult.stdout.includes("committed_divergence"), "committed consumer fix reports committed_divergence");
    assert(committedAheadResult.stdout.includes("Diff summary:"), "committed consumer fix reports a bounded diff summary");

    const committedRetiredWorkflow = cloneConsumer(sourceRoot, baseCommit, "committed-retired-workflow");
    consumers.push(committedRetiredWorkflow);
    appendText(join(committedRetiredWorkflow, retiredWorkflowRel), "Consumer-owned behavior must survive");
    appendText(join(committedRetiredWorkflow, retiredTestRel), "// Consumer-owned behavior must survive\n");
    commitAll(committedRetiredWorkflow, "fix: preserve consumer retired-path behavior");
    const retiredWorkflowBefore = readFileSync(join(committedRetiredWorkflow, retiredWorkflowRel), "utf-8");
    const retiredTestBefore = readFileSync(join(committedRetiredWorkflow, retiredTestRel), "utf-8");
    const retiredSiblingBefore = readFileSync(join(committedRetiredWorkflow, secondManagedRel), "utf-8");
    const retiredWorkflowResult = debugRaw("committed-retired-workflow", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", committedRetiredWorkflow, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!retiredWorkflowResult.ok, "committed consumer workflow blocks source-driven retirement");
    assert(
      existsSync(join(committedRetiredWorkflow, retiredWorkflowRel))
        && readFileSync(join(committedRetiredWorkflow, retiredWorkflowRel), "utf-8") === retiredWorkflowBefore,
      "committed consumer workflow survives retirement byte-for-byte",
    );
    assert(
      existsSync(join(committedRetiredWorkflow, retiredTestRel))
        && readFileSync(join(committedRetiredWorkflow, retiredTestRel), "utf-8") === retiredTestBefore,
      "committed consumer test survives retirement byte-for-byte",
    );
    assert(readFileSync(join(committedRetiredWorkflow, secondManagedRel), "utf-8") === retiredSiblingBefore, "workflow retirement conflict aborts sibling stale writes");
    assert(
      retiredWorkflowResult.stdout.includes("committed_divergence")
        && retiredWorkflowResult.stdout.includes(retiredTestRel),
      "consumer-owned retired workflow and test report committed_divergence",
    );

    const aheadOfPin = cloneConsumer(sourceRoot, aheadCommit, "ahead-of-pin");
    consumers.push(aheadOfPin);
    const aheadBefore = readFileSync(join(aheadOfPin, managedRel), "utf-8");
    const aheadResult = debugRaw("ahead-of-pin", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", aheadOfPin, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!aheadResult.ok, "target newer than an explicit pinned ref blocks downgrade");
    assert(readFileSync(join(aheadOfPin, managedRel), "utf-8") === aheadBefore, "ahead-of-pin target survives byte-for-byte");
    assert(aheadResult.stdout.includes("committed_ahead_of_source_ref"), "ahead-of-pin refusal is classified explicitly");

    const dirtyTarget = cloneConsumer(sourceRoot, baseCommit, "dirty-target");
    consumers.push(dirtyTarget);
    appendText(join(dirtyTarget, managedRel), "% UNCOMMITTED TARGET EDIT");
    writeJson(join(dirtyTarget, ".agent/skills/iterative-planner/config/version.json"), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "partial tree marker without matching SKILL frontmatter",
      version: "10.5.0",
    });
    const dirtyBefore = readFileSync(join(dirtyTarget, managedRel), "utf-8");
    const dirtyResult = debugRaw("dirty-target", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", dirtyTarget, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!dirtyResult.ok, "uncommitted target edit blocks self-heal");
    assert(readFileSync(join(dirtyTarget, managedRel), "utf-8") === dirtyBefore, "uncommitted target edit survives byte-for-byte");
    assert(dirtyResult.stdout.includes("uncommitted_target"), "dirty target refusal is classified explicitly");
    assert(
      dirtyResult.stdout.includes("committed=")
        && dirtyResult.stdout.includes("tree=10.5.0")
        && dirtyResult.stdout.includes("source="),
      "dirty target refusal separates committed, tree, and source planner versions",
    );
    assert(
      dirtyResult.stdout.includes("half-applied payload detected")
        && dirtyResult.stdout.includes(`--source-ref ${sourceCommit}`),
      "dirty target refusal prints the half-applied recovery recipe with the exact source pin",
    );

    const dirtyDoctor = runJson([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "doctor", dirtyTarget, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    assert(
      dirtyDoctor.version_stratigraphy?.committed
        && dirtyDoctor.version_stratigraphy?.tree === "10.5.0"
        && dirtyDoctor.version_stratigraphy?.source,
      "doctor exposes committed/tree/source version stratigraphy as structured data",
    );
    assert(
      dirtyDoctor.version_stratigraphy?.classification === "half_applied_upgrade",
      "doctor classifies dirty mixed-version stratigraphy as a half-applied upgrade",
    );

    const invalidRefTarget = cloneConsumer(sourceRoot, baseCommit, "invalid-ref");
    consumers.push(invalidRefTarget);
    const invalidBefore = readFileSync(join(invalidRefTarget, managedRel), "utf-8");
    const invalidResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", invalidRefTarget, "--source-ref", "not-a-real-release-ref",
    ], sourceRoot);
    assert(!invalidResult.ok, "invalid source ref fails closed");
    assert(readFileSync(join(invalidRefTarget, managedRel), "utf-8") === invalidBefore, "invalid source ref performs no managed write");

    const bootstrapTarget = cloneConsumer(sourceRoot, baseCommit, "bootstrap");
    consumers.push(bootstrapTarget);
    const registryPath = join(bootstrapTarget, ".agent/skills/iterative-planner/config/.project_registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry.source_project_path = sourceRoot;
    writeJson(registryPath, registry);
    commitAll(bootstrapTarget, "fixture: point consumer at canonical source");
    const bootstrapBefore = readFileSync(join(bootstrapTarget, managedRel), "utf-8");
    const bootstrapResult = debugRaw("bootstrap", runFixtureRaw([
      join(bootstrapTarget, ".agent/skills/iterative-planner/scripts/bootstrap.mjs"),
      "status",
    ], bootstrapTarget, { PLANNER_SKIP_SELF_HEAL: "" }));
    const bootstrapAfter = readFileSync(join(bootstrapTarget, managedRel), "utf-8");
    assert(bootstrapResult.ok, "normal bootstrap entrypoint diagnoses source-pinned self-heal");
    assert(bootstrapAfter === bootstrapBefore, "bootstrap self-heal pauses without mutating managed bytes");
    assert(
      bootstrapResult.stdout.includes(`Source commit: ${aheadCommit}`)
        && bootstrapResult.stdout.includes("--commit"),
      "bootstrap self-heal discloses one pinned commit and exact commit-consent command",
    );
    const blockedMutation = runFixtureRaw([
      join(bootstrapTarget, ".agent/skills/iterative-planner/scripts/bootstrap.mjs"),
      "new",
      "must not run on a stale planner",
    ], bootstrapTarget, { PLANNER_SKIP_SELF_HEAL: "" });
    assert(
      !blockedMutation.ok
        && blockedMutation.status === 2
        && blockedMutation.stdout.includes("Original planner command 'new' was not run"),
      "stale self-heal blocks mutating planner commands until explicit upgrade consent",
    );

  } finally {
    for (const consumer of consumers) cleanup(consumer);
    cleanup(sourceRoot);
  }
}

function testManagedUpgradeTransactionContract() {
  if (process.env._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING === "1" && process.env._PLANNER_MANAGED_UPGRADE_TEST_MODE !== "1") {
    assert(true, "transactional upgrade contract suite (inherited by parent proof)");
    return;
  }

  const sourceRoot = mkdtempSync(join(tmpdir(), "managed-upgrade-transaction-source-"));
  const consumers = [];
  const managedRel = ".agent/skills/iterative-planner/MIGRATION.md";
  const versionRel = ".agent/skills/iterative-planner/config/version.json";
  const receiptRel = ".agent/skills/iterative-planner/config/last_upgrade_receipt.json";
  const transactionConfigRel = ".agent/skills/iterative-planner/config/managed_upgrade_transaction.json";
  const rootTemplateRel = ".agent/skills/iterative-planner/references/CLAUDE.template.md";
  const rootInstructionFiles = ["CLAUDE.md", "GEMINI.md", "AGENTS.md"];
  const symlinkRootMarker = "TRANSACTIONAL_SYMLINK_ROOT_V2";
  const proofAssetRel =
    ".agent/skills/iterative-planner/tests/fixtures/real_telemetry/transaction_asset.jsonl";
  const truthSurfaceManagedRels = [
    ".agent/skills/iterative-planner/MIGRATION_HISTORY.md",
    ".agent/skills/iterative-planner/scripts/autonomous_ticket_delivery.mjs",
    ".agent/skills/iterative-planner/scripts/lib/autonomous_ticket_delivery.mjs",
    ".agent/skills/iterative-planner/scripts/lib/task_rubric_grader.mjs",
    ".agent/skills/iterative-planner/scripts/lib/truth_surface_convergence.mjs",
    ".agent/skills/iterative-planner/scripts/truth_surface_reconciler.mjs",
    ".agent/skills/iterative-planner/config/failure-codes.json",
    ".agent/skills/iterative-planner/config/program_packet.schema.json",
    ".agent/skills/iterative-planner/config/state.schema.json",
    ".agent/skills/iterative-planner/prolog/invariants.pl",
    ".agent/skills/iterative-planner/prolog/transitions.pl",
    ".agent/skills/iterative-planner/tests/test_autonomous_ticket_delivery.mjs",
    ".agent/skills/iterative-planner/tests/test_truth_surface_convergence.mjs",
  ];
  const externalRoots = [];
  try {
    const proofEnvironment = managedUpgradeProofEnvironment({
      _PLANNER_PINNED_SOURCE_RUNNING: "1",
      _PLANNER_MANAGED_UPGRADE_INTERNAL: "1",
      PLANNER_CANONICAL_SOURCE_REPO: "/wrong/source",
      PLANNER_SOURCE_REF: "wrong-ref",
      PLANNER_SOURCE_REF_RESOLVED: "wrong-resolved-ref",
      PLANNER_SOURCE_COMMIT: "wrong-commit",
      PLANNER_PROJECT_REGISTRY_PATH: "/wrong/registry.json",
    });
    assert(
      proofEnvironment._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING === "1"
        && !("_PLANNER_PINNED_SOURCE_RUNNING" in proofEnvironment)
        && !("_PLANNER_MANAGED_UPGRADE_INTERNAL" in proofEnvironment)
        && !("PLANNER_CANONICAL_SOURCE_REPO" in proofEnvironment)
        && !("PLANNER_SOURCE_REF" in proofEnvironment)
        && !("PLANNER_SOURCE_REF_RESOLVED" in proofEnvironment)
        && !("PLANNER_SOURCE_COMMIT" in proofEnvironment)
        && !("PLANNER_PROJECT_REGISTRY_PATH" in proofEnvironment),
      "proof subprocess scrubs outer source-pin routing before running migration fixtures",
    );
    cpSync(join(repoRoot, ".agent"), join(sourceRoot, ".agent"), { recursive: true });
    runGit(sourceRoot, ["init", "-q"], { quiet: true });
    writeJson(join(sourceRoot, versionRel), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "transaction fixture version",
      version: "10.6.2",
    });
    forcePlannerVersion(sourceRoot, "10.6.2");
    const baseCommit = commitAll(sourceRoot, "fixture: managed upgrade base");
    const baseRootTemplate = readFileSync(join(sourceRoot, rootTemplateRel), "utf-8");

    appendText(join(sourceRoot, managedRel), "<!-- TRANSACTIONAL_UPGRADE_V2 -->");
    appendText(join(sourceRoot, rootTemplateRel), `- **Transaction fixture**: ${symlinkRootMarker}`);
    writeFileSync(join(sourceRoot, proofAssetRel), '{"fixture":"transaction-proof-asset"}\n');
    for (const relPath of truthSurfaceManagedRels) {
      const marker = relPath.endsWith(".json")
        ? ""
        : relPath.endsWith(".pl")
          ? "% TRUTH_SURFACE_MANAGED_PROPAGATION_V1"
          : "// TRUTH_SURFACE_MANAGED_PROPAGATION_V1";
      appendText(join(sourceRoot, relPath), marker);
    }
    writeJson(join(sourceRoot, versionRel), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "transaction fixture version",
      version: "10.6.3",
    });
    forcePlannerVersion(sourceRoot, "10.6.3");
    const sourceCommit = commitAll(sourceRoot, "fixture: managed upgrade release");

    function makeSymlinkedRootConsumer(label) {
      const consumer = cloneConsumer(sourceRoot, baseCommit, label);
      consumers.push(consumer);
      ensureDir(join(consumer, "instructions"));
      const staleSnapshot = [
        "# Project Instructions — Iterative Planner",
        "<!-- Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh -->",
        "",
        "<!-- BEGIN ITERATIVE-PLANNER MANAGED SNAPSHOT -->",
        baseRootTemplate.trim(),
        "<!-- END ITERATIVE-PLANNER MANAGED SNAPSHOT -->",
        "",
      ].join("\n");
      for (const rootInstruction of rootInstructionFiles) {
        writeFileSync(join(consumer, "instructions", rootInstruction), staleSnapshot);
        symlinkSync(join("instructions", rootInstruction), join(consumer, rootInstruction));
      }
      commitAll(consumer, "fixture: symlink managed root instructions");
      return consumer;
    }

    const consentOnly = cloneConsumer(sourceRoot, baseCommit, "transaction-consent");
    consumers.push(consentOnly);
    const consentHead = runGit(consentOnly, ["rev-parse", "HEAD"]);
    const consentStatus = runGit(consentOnly, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const consentResult = debugRaw("transaction-consent", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", consentOnly, "--source-ref", sourceCommit,
    ], sourceRoot));
    assert(!consentResult.ok && consentResult.status === 2, "upgrade without --commit pauses for explicit consent");
    assert(
      consentResult.stdout.includes("COMMIT CONSENT REQUIRED")
        && consentResult.stdout.includes(JSON.stringify(
          join(realpathSync(sourceRoot), ".agent/skills/iterative-planner/scripts/migrate.mjs"),
        ))
        && consentResult.stdout.includes(JSON.stringify(realpathSync(consentOnly)))
        && consentResult.stdout.includes(`--source-ref ${sourceCommit} --commit`),
      "consent pause prints the exact source-pinned commit command",
    );
    assert(
      runGit(consentOnly, ["rev-parse", "HEAD"]) === consentHead
        && runGit(consentOnly, ["status", "--porcelain=v1", "--untracked-files=all"]) === consentStatus,
      "consent-only upgrade is read-only",
    );

    const dirty = cloneConsumer(sourceRoot, baseCommit, "transaction-dirty");
    consumers.push(dirty);
    appendText(join(dirty, managedRel), "<!-- DIRTY TARGET -->");
    const dirtyBefore = readFileSync(join(dirty, managedRel), "utf-8");
    const dirtyResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", dirty, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot);
    assert(!dirtyResult.ok, "transactional upgrade refuses dirty managed scope before writes");
    assert(readFileSync(join(dirty, managedRel), "utf-8") === dirtyBefore, "dirty preflight preserves the target byte-for-byte");
    assert(
      dirtyResult.stdout.includes("committed=10.6.2")
        && dirtyResult.stdout.includes("tree=10.6.2")
        && dirtyResult.stdout.includes("source=10.6.3"),
      "dirty refusal reports committed, tree, and source versions separately",
    );
    assert(
      dirtyResult.stdout.includes("half-applied payload detected")
        && dirtyResult.stdout.includes(`--source-ref ${sourceCommit}`),
      "dirty refusal prints the half-applied recovery recipe pinned to the selected source",
    );

    const dirtyRoot = cloneConsumer(sourceRoot, baseCommit, "transaction-dirty-root");
    consumers.push(dirtyRoot);
    writeFileSync(join(dirtyRoot, "planner.policy.yaml"), "uncommitted: true\n");
    const dirtyRootHead = runGit(dirtyRoot, ["rev-parse", "HEAD"]);
    const dirtyRootStatus = runGit(dirtyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const dirtyRootResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", dirtyRoot, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot);
    const dirtyRootOutput = `${dirtyRootResult.stdout}\n${dirtyRootResult.stderr}`;
    assert(!dirtyRootResult.ok, "transactional upgrade refuses a dirty managed root snapshot");
    assert(
      dirtyRootOutput.includes("committed=10.6.2 tree=10.6.2 source=10.6.3")
        && dirtyRootOutput.includes("half-applied payload detected")
        && dirtyRootOutput.includes(`--source-ref ${sourceCommit} --commit`),
      "managed-root preflight refusal prints version strata and exact pinned recovery",
    );
    assert(
      runGit(dirtyRoot, ["rev-parse", "HEAD"]) === dirtyRootHead
        && runGit(dirtyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) === dirtyRootStatus,
      "managed-root preflight refusal preserves exact target state",
    );

    const symlinkedRoot = makeSymlinkedRootConsumer("transaction-symlink-root");
    const symlinkedRootBefore = runGit(symlinkedRoot, ["rev-parse", "HEAD"]);
    const symlinkedRootResult = debugRaw("transaction-symlink-root", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", symlinkedRoot, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const symlinkedRootAfter = runGit(symlinkedRoot, ["rev-parse", "HEAD"]);
    const symlinkedRootPaths = runGit(
      symlinkedRoot,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", symlinkedRootAfter],
    ).split("\n").filter(Boolean);
    assert(
      symlinkedRootResult.ok && symlinkedRootAfter !== symlinkedRootBefore,
      "transaction commits a consumer with in-repo symlinked root instructions",
    );
    assert(
      rootInstructionFiles.every((rootInstruction) =>
        symlinkedRootPaths.includes(`instructions/${rootInstruction}`)
          && !symlinkedRootPaths.includes(rootInstruction)),
      "transaction commits the resolved in-repo instruction targets without replacing symlinks",
    );
    assert(
      rootInstructionFiles.every((rootInstruction) =>
        lstatSync(join(symlinkedRoot, rootInstruction)).isSymbolicLink()
          && readFileSync(join(symlinkedRoot, "instructions", rootInstruction), "utf-8")
            .includes(symlinkRootMarker)),
      "transaction preserves root symlinks and installs the refreshed managed snapshots atomically",
    );
    assert(
      runGit(symlinkedRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ".agent",
        ...rootInstructionFiles,
        "instructions",
      ]) === "",
      "symlink-aware transaction leaves every managed root path clean",
    );

    const dirtySymlinkRoot = makeSymlinkedRootConsumer("transaction-dirty-symlink-root");
    appendText(
      join(dirtySymlinkRoot, "instructions", "CLAUDE.md"),
      "<!-- DIRTY SYMLINK TARGET -->",
    );
    const dirtySymlinkHead = runGit(dirtySymlinkRoot, ["rev-parse", "HEAD"]);
    const dirtySymlinkStatus = runGit(
      dirtySymlinkRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    );
    const dirtySymlinkResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", dirtySymlinkRoot, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot);
    assert(
      !dirtySymlinkResult.ok
        && `${dirtySymlinkResult.stdout}\n${dirtySymlinkResult.stderr}`
          .includes("instructions/CLAUDE.md"),
      "preflight refuses a dirty in-repo target behind a managed root symlink",
    );
    assert(
      runGit(dirtySymlinkRoot, ["rev-parse", "HEAD"]) === dirtySymlinkHead
        && runGit(
          dirtySymlinkRoot,
          ["status", "--porcelain=v1", "--untracked-files=all"],
        ) === dirtySymlinkStatus,
      "dirty symlink-target refusal preserves the exact target state",
    );

    const externalRoot = mkdtempSync(join(tmpdir(), "managed-upgrade-external-root-"));
    externalRoots.push(externalRoot);
    const externalSymlinkRoot = cloneConsumer(
      sourceRoot,
      baseCommit,
      "transaction-external-symlink-root",
    );
    consumers.push(externalSymlinkRoot);
    const externalInstruction = join(externalRoot, "CLAUDE.md");
    writeFileSync(externalInstruction, "external instructions must remain untouched\n");
    symlinkSync(externalInstruction, join(externalSymlinkRoot, "CLAUDE.md"));
    commitAll(externalSymlinkRoot, "fixture: external managed root symlink");
    const externalSymlinkResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", externalSymlinkRoot, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot);
    assert(
      !externalSymlinkResult.ok
        && `${externalSymlinkResult.stdout}\n${externalSymlinkResult.stderr}`
          .includes("managed symlink outside target repository"),
      "transaction refuses a managed root symlink that resolves outside the repository",
    );
    assert(
      readFileSync(externalInstruction, "utf-8")
        === "external instructions must remain untouched\n",
      "external managed-root refusal leaves the out-of-repository file untouched",
    );

    const stagedIndex = cloneConsumer(sourceRoot, baseCommit, "transaction-staged-index");
    consumers.push(stagedIndex);
    writeFileSync(join(stagedIndex, "staged-consumer-note.txt"), "preserve staged consumer work\n");
    runGit(stagedIndex, ["add", "--", "staged-consumer-note.txt"], { quiet: true });
    const stagedIndexHead = runGit(stagedIndex, ["rev-parse", "HEAD"]);
    const stagedIndexStatus = runGit(stagedIndex, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const stagedIndexResult = debugRaw("transaction-staged-index", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", stagedIndex, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const stagedIndexAfter = runGit(stagedIndex, ["rev-parse", "HEAD"]);
    assert(
      stagedIndexResult.ok && stagedIndexAfter !== stagedIndexHead,
      "transaction accepts unrelated staged work while advancing only the managed candidate",
    );
    const stagedCommitPaths = runGit(
      stagedIndex,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", stagedIndexAfter],
    ).split("\n").filter(Boolean);
    assert(
      !stagedCommitPaths.includes("staged-consumer-note.txt"),
      "transaction excludes pre-existing staged consumer work from the managed commit",
    );
    assert(
      runGit(stagedIndex, ["status", "--porcelain=v1", "--untracked-files=all"]) === stagedIndexStatus,
      "transaction preserves the exact unrelated target index and worktree state",
    );

    const completeButUncommitted = cloneConsumer(
      sourceRoot,
      baseCommit,
      "transaction-complete-uncommitted",
    );
    consumers.push(completeButUncommitted);
    runGit(completeButUncommitted, [
      "restore",
      `--source=${sourceCommit}`,
      "--worktree",
      "--",
      ".agent",
    ], { quiet: true });
    const completeButUncommittedHead = runGit(
      completeButUncommitted,
      ["rev-parse", "HEAD"],
    );
    const completeButUncommittedStatus = runGit(
      completeButUncommitted,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    );
    const completeButUncommittedResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade",
      completeButUncommitted,
      "--source-ref",
      sourceCommit,
      "--commit",
    ], sourceRoot);
    const completeButUncommittedOutput =
      `${completeButUncommittedResult.stdout}\n${completeButUncommittedResult.stderr}`;
    assert(
      !completeButUncommittedResult.ok
        && completeButUncommittedOutput.includes("half-applied payload detected"),
      "source-identical but uncommitted payload is diagnosed instead of treated as an already-current no-op",
    );
    assert(
      runGit(completeButUncommitted, ["rev-parse", "HEAD"])
          === completeButUncommittedHead
        && runGit(
          completeButUncommitted,
          ["status", "--porcelain=v1", "--untracked-files=all"],
        ) === completeButUncommittedStatus,
      "source-identical uncommitted payload refusal preserves exact target state",
    );

    const rollback = cloneConsumer(sourceRoot, baseCommit, "transaction-rollback");
    consumers.push(rollback);
    const rollbackHead = runGit(rollback, ["rev-parse", "HEAD"]);
    const rollbackStatus = runGit(rollback, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const rollbackBefore = readFileSync(join(rollback, managedRel), "utf-8");
    const rollbackResult = debugRaw("transaction-rollback", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", rollback, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot, {
      NODE_ENV: "test",
      _PLANNER_UPGRADE_TEST_FAIL_PHASE: "after_apply",
    }));
    assert(!rollbackResult.ok, "injected post-apply failure returns non-zero");
    assert(runGit(rollback, ["rev-parse", "HEAD"]) === rollbackHead, "failed transaction restores the original HEAD");
    assert(readFileSync(join(rollback, managedRel), "utf-8") === rollbackBefore, "failed transaction restores managed bytes");
    assert(
      runGit(rollback, ["status", "--porcelain=v1", "--untracked-files=all"]) === rollbackStatus,
      "failed transaction restores the exact scoped worktree and index status",
    );
    assert(rollbackResult.stdout.includes("ROLLBACK VERIFIED"), "failed transaction reports verified rollback");

    const interrupted = cloneConsumer(sourceRoot, baseCommit, "transaction-interrupted");
    consumers.push(interrupted);
    const interruptedHead = runGit(interrupted, ["rev-parse", "HEAD"]);
    const interruptedResult = debugRaw("transaction-interrupted", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", interrupted, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot, {
      NODE_ENV: "test",
      _PLANNER_UPGRADE_TEST_CRASH_PHASE: "after_candidate",
    }));
    assert(!interruptedResult.ok && interruptedResult.status === 86, "process-exit fixture leaves an interrupted transaction journal");
    assert(runGit(interrupted, ["rev-parse", "HEAD"]) === interruptedHead, "process exit before advance leaves live HEAD unchanged");
    const interruptedDoctor = runJson([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "doctor", interrupted, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    assert(
      interruptedDoctor.active_upgrade_transaction
        && interruptedDoctor.recovery_command?.includes("recover-upgrade"),
      "doctor surfaces the interrupted transaction and exact recovery command",
    );
    const recovered = runJson([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "recover-upgrade", interrupted, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    assert(recovered.ok && recovered.status === "recovered", "source-pinned recover-upgrade abandons the off-target candidate");
    assert(runGit(interrupted, ["rev-parse", "HEAD"]) === interruptedHead, "interrupted recovery preserves the original live commit");

    const committed = cloneConsumer(sourceRoot, baseCommit, "transaction-commit");
    consumers.push(committed);
    writeFileSync(join(committed, "consumer-notes.txt"), "unrelated dirty work must survive\n");
    const commitBefore = runGit(committed, ["rev-parse", "HEAD"]);
    const commitResult = debugRaw("transaction-commit", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", committed, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    const commitAfter = runGit(committed, ["rev-parse", "HEAD"]);
    assert(commitResult.ok && commitAfter !== commitBefore, "explicit --commit creates the managed payload commit");
    assert(
      readFileSync(join(committed, managedRel), "utf-8").includes("TRANSACTIONAL_UPGRADE_V2"),
      "committed transaction installs the selected-source payload",
    );
    assert(
      readFileSync(join(committed, proofAssetRel), "utf-8") === '{"fixture":"transaction-proof-asset"}\n',
      "committed transaction ships JSONL proof assets atomically with their tests",
    );
    assert(
      truthSurfaceManagedRels.every((relPath) => (
        readFileSync(join(committed, relPath), "utf-8")
          === readFileSync(join(sourceRoot, relPath), "utf-8")
      )),
      "committed transaction installs the selected-source truth reconciler, production autonomy, schema, Prolog, and test bytes",
    );
    assert(
      readFileSync(join(committed, "consumer-notes.txt"), "utf-8") === "unrelated dirty work must survive\n"
        && runGit(committed, ["status", "--porcelain=v1", "--", "consumer-notes.txt"]).includes("consumer-notes.txt"),
      "scoped commit preserves unrelated dirty work",
    );
    const committedPaths = runGit(committed, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitAfter])
      .split("\n").filter(Boolean);
    assert(
      truthSurfaceManagedRels.every((relPath) => committedPaths.includes(relPath)),
      "managed payload commit explicitly carries every truth-surface and production-autonomy asset",
    );
    assert(!committedPaths.includes("consumer-notes.txt"), "scoped commit excludes unrelated paths");
    const receipt = existsSync(join(committed, receiptRel))
      ? JSON.parse(readFileSync(join(committed, receiptRel), "utf-8"))
      : null;
    assert(
      receipt?.status === "committed"
        && receipt?.committing_sha === commitAfter
        && receipt?.from_version === "10.6.2"
        && receipt?.to_version === "10.6.3"
        && receipt?.source_commit === sourceCommit,
      "durable receipt binds versions, selected source, and real target commit SHA",
    );
    let receiptIgnored = false;
    try {
      runGit(committed, ["check-ignore", "-q", "--", receiptRel]);
      receiptIgnored = true;
    } catch {
      receiptIgnored = false;
    }
    assert(receiptIgnored, "target-local receipt is ignored and does not dirty the committed payload");

    const fleetTarget = cloneConsumer(sourceRoot, baseCommit, "transaction-fleet-pin");
    consumers.push(fleetTarget);
    const fleetRegistryPath = join(
      sourceRoot,
      ".agent/skills/iterative-planner/config/.project_registry.json",
    );
    writeJson(fleetRegistryPath, {
      source_project_path: sourceRoot,
      projects: [{
        path: fleetTarget,
        type: "planner",
        version: "10.6.2",
      }],
      last_scan: new Date().toISOString(),
      scan_roots: [],
    });
    appendText(join(sourceRoot, managedRel), "<!-- UNCOMMITTED_FLEET_SOURCE_DIRT -->");
    writeJson(join(sourceRoot, transactionConfigRel), {
      schema_version: 1,
      proof_commands: [],
    });
    const fleetResult = debugRaw("transaction-fleet-pin", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade-all",
      "--source-ref",
      sourceCommit,
      "--commit",
    ], sourceRoot));
    const fleetBytes = readFileSync(join(fleetTarget, managedRel), "utf-8");
    assert(
      fleetResult.ok
        && fleetBytes.includes("TRANSACTIONAL_UPGRADE_V2")
        && !fleetBytes.includes("UNCOMMITTED_FLEET_SOURCE_DIRT"),
      "upgrade-all distributes immutable selected-source bytes instead of canonical working-tree dirt",
    );
    runGit(sourceRoot, [
      "restore",
      `--source=${sourceCommit}`,
      "--worktree",
      "--",
      managedRel,
      transactionConfigRel,
    ], { quiet: true });

    const advancedInterrupted = cloneConsumer(sourceRoot, baseCommit, "transaction-advanced-interrupted");
    consumers.push(advancedInterrupted);
    const advancedInterruptedBefore = runGit(advancedInterrupted, ["rev-parse", "HEAD"]);
    const advancedInterruptedResult = debugRaw("transaction-advanced-interrupted", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", advancedInterrupted, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot, {
      NODE_ENV: "test",
      _PLANNER_UPGRADE_TEST_CRASH_PHASE: "after_fast_forward",
    }));
    const advancedInterruptedHead = runGit(advancedInterrupted, ["rev-parse", "HEAD"]);
    assert(
      !advancedInterruptedResult.ok
        && advancedInterruptedResult.status === 86
        && advancedInterruptedHead !== advancedInterruptedBefore,
      "process exit after the live fast-forward leaves a journaled candidate at HEAD",
    );
    const advancedRecovery = runJson([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "recover-upgrade", advancedInterrupted, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    assert(
      advancedRecovery.ok
        && advancedRecovery.status === "committed"
        && advancedRecovery.target_head === advancedInterruptedHead,
      "recover-upgrade finalizes a proven candidate already fast-forwarded to HEAD",
    );
    const advancedReceipt = JSON.parse(readFileSync(join(advancedInterrupted, receiptRel), "utf-8"));
    assert(
      advancedReceipt.status === "committed"
        && advancedReceipt.committing_sha === advancedInterruptedHead,
      "post-fast-forward recovery writes the receipt for the exact candidate commit",
    );

    const collisionInterrupted = cloneConsumer(sourceRoot, baseCommit, "transaction-collision-interrupted");
    consumers.push(collisionInterrupted);
    runGit(collisionInterrupted, ["rm", "--cached", "--", managedRel], { quiet: true });
    writeFileSync(join(collisionInterrupted, ".gitignore"), `/${managedRel}\n`);
    commitAll(collisionInterrupted, "fixture: keep historical managed payload ignored");
    const collisionInterruptedHead = runGit(collisionInterrupted, ["rev-parse", "HEAD"]);
    const collisionInterruptedStatus = runGit(collisionInterrupted, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const collisionInterruptedBytes = readFileSync(join(collisionInterrupted, managedRel), "utf-8");
    const collisionInterruptedResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", collisionInterrupted, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot, {
      NODE_ENV: "test",
      _PLANNER_UPGRADE_TEST_CRASH_PHASE: "after_collision_backup",
    });
    assert(!collisionInterruptedResult.ok, "simulated process exit leaves an interrupted durable transaction");
    assert(runGit(collisionInterrupted, ["rev-parse", "HEAD"]) === collisionInterruptedHead, "interruption before fast-forward leaves target HEAD unchanged");
    assert(!existsSync(join(collisionInterrupted, managedRel)), "interruption fixture proves the live collision was moved only after its durable backup");
    const recoveryResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "recover-upgrade", collisionInterrupted, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    const collisionRecovered = recoveryResult.ok ? JSON.parse(recoveryResult.stdout) : null;
    assert(collisionRecovered?.status === "recovered", "source-pinned recover-upgrade resolves the interrupted transaction");
    assert(
      existsSync(join(collisionInterrupted, managedRel))
        && readFileSync(join(collisionInterrupted, managedRel), "utf-8") === collisionInterruptedBytes,
      "interrupted recovery restores the ignored managed before-image byte-for-byte",
    );
    assert(
      runGit(collisionInterrupted, ["status", "--porcelain=v1", "--untracked-files=all"]) === collisionInterruptedStatus,
      "interrupted recovery restores the exact visible worktree and index status",
    );

    const debris = cloneConsumer(sourceRoot, baseCommit, "transaction-debris");
    consumers.push(debris);
    writeJson(join(debris, versionRel), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "transaction fixture version",
      version: "10.5.0",
    });
    forcePlannerVersion(debris, "10.5.0");
    appendText(join(debris, managedRel), "<!-- PARTIAL 10.6.1 PAYLOAD -->");
    const doctor = runJson([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "doctor", debris, "--source-ref", sourceCommit, "--json",
    ], sourceRoot);
    assert(
      doctor.version_stratigraphy?.committed === "10.6.2"
        && doctor.version_stratigraphy?.tree === "10.5.0"
        && doctor.version_stratigraphy?.source === "10.6.3",
      "doctor reports exact committed/tree/source version stratigraphy",
    );
    assert(doctor.upgrade_state === "half_applied_payload", "doctor classifies receiptless mixed-version dirt as half-applied payload");

    const badConfig = JSON.parse(readFileSync(
      join(sourceRoot, ".agent/skills/iterative-planner/config/managed_upgrade_transaction.json"),
      "utf-8",
    ));
    const completeProofCommands = badConfig.proof_commands;
    badConfig.proof_commands = badConfig.proof_commands.filter((entry) => entry.id === "gate-or-delete-census");
    writeJson(
      join(sourceRoot, ".agent/skills/iterative-planner/config/managed_upgrade_transaction.json"),
      badConfig,
    );
    writeJson(join(sourceRoot, versionRel), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "transaction fixture version",
      version: "10.6.4",
    });
    forcePlannerVersion(sourceRoot, "10.6.4");
    const incompleteProofCommit = commitAll(sourceRoot, "fixture: incomplete transaction proof bundle");
    const incompleteProofTarget = cloneConsumer(sourceRoot, baseCommit, "transaction-incomplete-proof");
    consumers.push(incompleteProofTarget);
    const incompleteProofHead = runGit(incompleteProofTarget, ["rev-parse", "HEAD"]);
    const incompleteProofResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", incompleteProofTarget, "--source-ref", incompleteProofCommit, "--commit",
    ], sourceRoot, {
      _PLANNER_MANAGED_UPGRADE_TEST_MODE: "",
    });
    const incompleteProofOutput = `${incompleteProofResult.stdout}\n${incompleteProofResult.stderr}`;
    assert(
      !incompleteProofResult.ok
        && incompleteProofOutput.includes("missing required suites"),
      "transaction refuses an incomplete proof bundle even when an external recursion marker is present",
    );
    assert(
      runGit(incompleteProofTarget, ["rev-parse", "HEAD"]) === incompleteProofHead,
      "incomplete proof configuration leaves the live target at its original commit",
    );

    badConfig.proof_commands = completeProofCommands;
    writeJson(
      join(sourceRoot, ".agent/skills/iterative-planner/config/managed_upgrade_transaction.json"),
      badConfig,
    );
    writeFileSync(
      join(sourceRoot, ".agent/skills/iterative-planner/tests/test_unregistered_transaction_probe.mjs"),
      "process.exit(0);\n",
    );
    writeJson(join(sourceRoot, versionRel), {
      $schema: "https://json-schema.org/draft-07/schema#",
      description: "transaction fixture version",
      version: "10.6.5",
    });
    forcePlannerVersion(sourceRoot, "10.6.5");
    const incoherentSourceCommit = commitAll(sourceRoot, "fixture: incoherent test census payload");
    const censusFailure = cloneConsumer(sourceRoot, baseCommit, "transaction-census-failure");
    consumers.push(censusFailure);
    const censusFailureHead = runGit(censusFailure, ["rev-parse", "HEAD"]);
    const censusFailureBefore = readFileSync(join(censusFailure, managedRel), "utf-8");
    const censusFailureResult = runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", censusFailure, "--source-ref", incoherentSourceCommit, "--commit",
    ], sourceRoot, {
      _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "",
    });
    assert(!censusFailureResult.ok, "incoherent test/census payload fails transactional conformance");
    assert(
      runGit(censusFailure, ["rev-parse", "HEAD"]) === censusFailureHead
        && readFileSync(join(censusFailure, managedRel), "utf-8") === censusFailureBefore,
      "census failure leaves the live consumer at its exact original commit and bytes",
    );
  } finally {
    for (const consumer of consumers) cleanup(consumer);
    for (const externalRoot of externalRoots) cleanup(externalRoot);
    cleanup(sourceRoot);
  }
}

function testCanonicalSourcePinReadOnlyProbe() {
  const report = runJson([sourceMigrate, "doctor", repoRoot, "--source-ref", "HEAD", "--json"]);
  assert(report.source_ref === "HEAD", "canonical doctor reports the selected source ref");
  assert(/^[a-f0-9]{40,64}$/.test(report.source_commit || ""), "canonical doctor resolves the selected source commit");
  assert(report.repair_command.includes(`--source-ref ${report.source_commit}`), "canonical doctor pins its repair command to that commit");

  const human = runRaw([sourceMigrate, "doctor", repoRoot, "--source-ref=HEAD"]);
  assert(human.ok && human.stdout.includes("Source ref:        HEAD"), "canonical human doctor renders the selected ref");
  assert(human.stdout.includes(`Source commit:     ${report.source_commit}`), "canonical human doctor renders the selected commit");

  const noActivePlan = createProject("canonical-bootstrap-no-active-plan");
  try {
    const status = runRaw([sourceBootstrap, "status"], noActivePlan, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(status.ok, "canonical bootstrap status handles a project without an active-plan pointer");
    assert(status.stdout.includes("No active plan"), "canonical bootstrap status explains the missing active-plan pointer");
  } finally {
    cleanup(noActivePlan);
  }
}

function testIrreversibleActionBoundarySeededAsOneManagedContract() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "ive-irreversible-action-source-"));
  const targetRoot = mkdtempSync(join(tmpdir(), "ive-irreversible-action-target-"));
  try {
    cpSync(join(repoRoot, ".agent"), join(sourceRoot, ".agent"), { recursive: true });
    runGit(sourceRoot, ["init", "-q"], { quiet: true });
    const sourceCommit = commitAll(sourceRoot, "fixture: irreversible action managed contract");

    writeFileSync(join(targetRoot, "README.md"), "# Fresh managed-install target\n");
    runGit(targetRoot, ["init", "-q"], { quiet: true });
    commitAll(targetRoot, "fixture: fresh host repository");

    const migration = debugRaw("irreversible-action-seed", runFixtureRaw([
      join(sourceRoot, ".agent/skills/iterative-planner/scripts/migrate.mjs"),
      "upgrade", targetRoot, "--source-ref", sourceCommit, "--commit",
    ], sourceRoot));
    assert(migration.ok, "fresh managed migration seeds the irreversible-action contract");

    const requiredPaths = [
      ".agent/skills/iterative-planner/config/degraded_coverage_census.json",
      ".agent/skills/iterative-planner/scripts/lib/degraded_coverage.mjs",
      ".agent/skills/iterative-planner/config/irreversible_action_registry.json",
      ".agent/skills/iterative-planner/config/irreversible_action_registry.schema.json",
      ".agent/skills/iterative-planner/scripts/lib/irreversible_action_contract.mjs",
      ".agent/skills/iterative-planner/scripts/irreversible_action_gate.mjs",
      ".agent/skills/iterative-planner/tests/test_irreversible_action_contract.mjs",
      ".agent/skills/iterative-planner/SKILL.md",
    ];
    for (const requiredPath of requiredPaths) {
      assert(existsSync(join(targetRoot, requiredPath)), `fresh managed install contains ${requiredPath}`);
    }

    const focused = runFixtureRaw([
      join(targetRoot, ".agent/skills/iterative-planner/tests/test_irreversible_action_contract.mjs"),
    ], targetRoot, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(focused.ok && focused.stdout.includes("Results: 90 passed, 0 failed"), "fresh managed install executes the irreversible-action conformance suite");

    const skill = readFileSync(join(targetRoot, ".agent/skills/iterative-planner/SKILL.md"), "utf-8");
    assert(skill.includes("Irreversible Action Execution Contract"), "fresh managed instructions name the irreversible-action contract");
    assert(skill.includes("planner.irreversible-actions.json"), "fresh managed instructions document the additive project overlay");
    assert(skill.includes("irreversible_action_gate.mjs"), "fresh managed instructions point callers to the hard action boundary");
    assert(/permanent human line/i.test(skill), "fresh managed instructions preserve the permanent human line");

    const statusContext = readFileSync(
      join(targetRoot, ".agent/skills/iterative-planner/scripts/lib/bootstrap_status_context.mjs"),
      "utf-8",
    );
    assert(
      statusContext.includes('await import("./degraded_coverage.mjs")') &&
        !/^import .*degraded_coverage\.mjs/m.test(statusContext),
      "bootstrap status loads degraded coverage only after the managed self-heal boundary",
    );
    const sourceOntologyFacts = join(sourceRoot, ".agent", "ontology", "facts");
    const targetOntologyFacts = join(targetRoot, ".agent", "ontology", "facts");
    if (existsSync(sourceOntologyFacts)) {
      cpSync(sourceOntologyFacts, targetOntologyFacts, { recursive: true });
    } else {
      ensureDir(targetOntologyFacts);
      for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
        writeJson(
          join(targetOntologyFacts, `${entityClass}.yaml`),
          buildEmptyOntologyDocument(entityClass),
        );
      }
    }
    const status = runFixtureRaw([
      join(targetRoot, ".agent/skills/iterative-planner/scripts/bootstrap.mjs"),
      "status",
    ], targetRoot, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(status.ok && !status.stdout.includes("Degraded coverage"), "fresh configured managed install keeps degraded-coverage status quiet");
  } finally {
    cleanup(sourceRoot);
    cleanup(targetRoot);
  }
}

function createChecklistIntegrityProject(label, { includeEntry = true } = {}) {
  const projectRoot = createProject(`checklist-integrity-${label}`);
  const registryPath = join(projectRoot, ".agent/skills/iterative-planner/config/.checklist_integrity");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  if (includeEntry) {
    registry["validate-to-close"] = "00000000000000000000000000000000";
  } else {
    delete registry["validate-to-close"];
  }
  writeJson(registryPath, registry);
  runGit(projectRoot, ["init", "-q"], { quiet: true });
  commitAll(projectRoot, "fixture: stale checklist integrity baseline");

  const decisionRel = "plans/plan_2026-07-21_fixture/decisions.md";
  const decisionPath = join(projectRoot, decisionRel);
  ensureDir(dirname(decisionPath));
  writeFileSync(decisionPath, "# Decision Log\n\n## D-005: Authorize fixture regeneration\n\nUse the supported clean-HEAD lane.\n");

  return {
    projectRoot,
    registryPath,
    decisionRef: `${decisionRel}#D-005`,
    checklistPath: join(projectRoot, ".agent/skills/iterative-planner/checklists/validate-to-close.yaml"),
    receiptDir: join(projectRoot, "reports/ive/checklist_integrity_regenerations"),
  };
}

function parseJsonResult(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function receiptFiles(path) {
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".json")) : [];
}

function testChecklistIntegrityRegeneration() {
  const fixture = createChecklistIntegrityProject("main");
  const { projectRoot, registryPath, decisionRef, checklistPath, receiptDir } = fixture;
  try {
    const ignoredProbe = runRaw([
      "--input-type=module",
      "--eval",
      `import { execFileSync } from "child_process"; try { execFileSync("git", ["check-ignore", "-q", "reports/ive/checklist_integrity_regenerations/probe.json"], { cwd: ${JSON.stringify(projectRoot)} }); process.exit(1); } catch (error) { process.exit(error.status === 1 ? 0 : 1); }`,
    ], projectRoot);
    assert(ignoredProbe.ok, "fixture regeneration JSON receipts are not hidden by fixture ignore rules");

    const registryBeforeText = readFileSync(registryPath, "utf-8");
    const registryBefore = JSON.parse(registryBeforeText);
    const checklistBytes = readFileSync(checklistPath);
    const expectedFullHash = createHash("sha256").update(checklistBytes).digest("hex");
    const expectedRegistryHash = expectedFullHash.slice(0, 32);
    const runnerUrl = pathToFileURL(join(
      projectRoot,
      ".agent/skills/iterative-planner/scripts/lib/checklist_runner.mjs",
    )).href;
    const runtimeProbe = runFixtureRaw([
      "--input-type=module",
      "--eval",
      `const { runChecklist } = await import(${JSON.stringify(runnerUrl)}); const cwd = process.cwd(); const skillPath = ${JSON.stringify(join(projectRoot, ".agent/skills/iterative-planner"))}; const results = runChecklist("validate-to-close", null, { skillPath, plansDir: ${JSON.stringify(join(projectRoot, "plans"))}, knowledgeDir: ${JSON.stringify(join(projectRoot, "plans/knowledge"))}, cwd }); console.log(JSON.stringify(results));`,
    ], projectRoot);
    const runtimeResults = parseJsonResult(runtimeProbe);
    assert(runtimeProbe.ok && Array.isArray(runtimeResults), "unauthorized checklist mismatch is executable as a negative-control probe");
    assert(runtimeResults?.length === 1, "unauthorized checklist mismatch returns exactly one result before item execution");
    assert(runtimeResults?.[0]?.status === "FAIL" && runtimeResults?.[0]?.code === "GATE-CHK-001", "unauthorized checklist mismatch remains a hard GATE-CHK-001 failure");

    const baseArgs = [
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "validate-to-close",
      "--decision-ref", decisionRef,
      "--json",
    ];

    const missingChecklistOption = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--decision-ref", decisionRef,
      "--json",
    ], projectRoot);
    assert(
      !missingChecklistOption.ok
        && missingChecklistOption.status === 1
        && parseJsonResult(missingChecklistOption)?.reason === "--checklist is required",
      "regeneration JSON failure requires a checklist and preserves the one exit status",
    );

    const missingDecisionOption = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "validate-to-close",
      "--json",
    ], projectRoot);
    assert(!missingDecisionOption.ok && parseJsonResult(missingDecisionOption)?.reason === "--decision-ref is required", "regeneration requires an explicit decision reference");

    const invalidChecklistName = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "../validate-to-close",
      "--decision-ref", decisionRef,
      "--json",
    ], projectRoot);
    assert(!invalidChecklistName.ok, "regeneration rejects checklist path traversal syntax");

    const missingChecklistFile = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "not-a-real-checklist",
      "--decision-ref", decisionRef,
      "--json",
    ], projectRoot);
    assert(!missingChecklistFile.ok, "regeneration rejects an absent named checklist");

    const nonRootTarget = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      join(projectRoot, "plans"),
      "--checklist", "validate-to-close",
      "--decision-ref", decisionRef,
      "--json",
    ], projectRoot);
    assert(!nonRootTarget.ok, "regeneration rejects a target below the Git worktree root");

    const malformedDecisionRef = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "validate-to-close",
      "--decision-ref", "plans/plan_2026-07-21_fixture/decisions.md",
      "--json",
    ], projectRoot);
    assert(!malformedDecisionRef.ok, "regeneration rejects a decision reference without an exact D-* fragment");

    const humanFailure = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      projectRoot,
      "--checklist", "../validate-to-close",
      "--decision-ref", decisionRef,
    ], projectRoot);
    assert(
      !humanFailure.ok
        && humanFailure.status === 1
        && humanFailure.stderr.includes("Checklist integrity regeneration: FAIL"),
      "human-mode regeneration renders a truthful failure with exit status one",
    );

    const dryRun = runRaw(baseArgs, projectRoot, {
      CHECKLIST_INTEGRITY_TIMESTAMP: "2026-07-21T09:45:00.000Z",
    });
    const dryRunJson = parseJsonResult(dryRun);
    assert(dryRun.ok && dryRun.status === 0 && dryRunJson?.ok === true && dryRunJson?.mode === "dry-run", "clean tracked HEAD regeneration JSON success exits zero");
    assert(dryRunJson?.checklist?.sha256 === expectedFullHash && dryRunJson?.registry?.new_value === expectedRegistryHash, "dry-run projects the full HEAD hash and canonical 32-character registry value");
    assert(readFileSync(registryPath, "utf-8") === registryBeforeText && receiptFiles(receiptDir).length === 0, "dry-run writes neither registry nor receipt");

    const humanDryRun = runRaw(baseArgs.filter((arg) => arg !== "--json"), projectRoot);
    assert(
      humanDryRun.ok
        && humanDryRun.status === 0
        && humanDryRun.stdout.includes("Checklist integrity regeneration dry-run: PASS"),
      "human-mode regeneration renders the clean dry-run projection with exit status zero",
    );

    const originalChecklist = readFileSync(checklistPath);
    appendText(checklistPath, "# dirty worktree byte");
    const dirtyWorktree = runRaw([...baseArgs, "--write"], projectRoot);
    assert(!dirtyWorktree.ok, "regeneration refuses a dirty checklist worktree");
    assert(readFileSync(registryPath, "utf-8") === registryBeforeText && receiptFiles(receiptDir).length === 0, "dirty-worktree refusal preserves registry and receipt set");
    writeFileSync(checklistPath, originalChecklist);

    for (const invalidDecisionRef of [
      "plans/plan_2026-07-21_fixture/decisions.md#D-999",
      "plans/plan_2026-07-21_fixture/missing.md#D-005",
      "../outside-decisions.md#D-005",
    ]) {
      const invalid = runRaw([
        sourceMigrate,
        "regenerate-checklist-integrity",
        projectRoot,
        "--checklist", "validate-to-close",
        "--decision-ref", invalidDecisionRef,
        "--write",
        "--json",
      ], projectRoot);
      assert(!invalid.ok, `regeneration refuses invalid decision reference ${invalidDecisionRef}`);
      assert(readFileSync(registryPath, "utf-8") === registryBeforeText && receiptFiles(receiptDir).length === 0, `invalid decision ${invalidDecisionRef} preserves registry and receipt set`);
    }

    const conflict = runRaw([...baseArgs, "--dry-run", "--write"], projectRoot);
    assert(!conflict.ok, "regeneration rejects simultaneous --dry-run and --write");
    assert(readFileSync(registryPath, "utf-8") === registryBeforeText && receiptFiles(receiptDir).length === 0, "mode-conflict refusal preserves registry and receipt set");

    const invalidTimestamp = runRaw([...baseArgs, "--write"], projectRoot, {
      CHECKLIST_INTEGRITY_TIMESTAMP: "not-an-iso-timestamp",
    });
    assert(!invalidTimestamp.ok, "regeneration rejects an invalid deterministic receipt timestamp");
    assert(readFileSync(registryPath, "utf-8") === registryBeforeText && receiptFiles(receiptDir).length === 0, "invalid-timestamp refusal preserves registry and receipt set");

    const writeResult = runRaw([...baseArgs, "--write"], projectRoot, {
      CHECKLIST_INTEGRITY_TIMESTAMP: "2026-07-21T09:46:00.000Z",
    });
    const writeJsonResult = parseJsonResult(writeResult);
    assert(writeResult.ok && writeJsonResult?.ok === true && writeJsonResult?.mode === "write", "explicit write regenerates from clean tracked HEAD content");
    const registryAfter = JSON.parse(readFileSync(registryPath, "utf-8"));
    assert(registryAfter["validate-to-close"] === expectedRegistryHash, "write stores the exact canonical HEAD hash prefix");
    const siblingNames = Object.keys(registryBefore).filter((name) => name !== "validate-to-close");
    assert(siblingNames.every((name) => registryAfter[name] === registryBefore[name]), "write preserves every sibling checklist entry");
    const emittedReceipts = receiptFiles(receiptDir);
    assert(emittedReceipts.length === 1 && writeJsonResult?.receipt_path, "write emits exactly one durable receipt");
    const receipt = emittedReceipts.length === 1
      ? JSON.parse(readFileSync(join(receiptDir, emittedReceipts[0]), "utf-8"))
      : null;
    assert(receipt?.status === "PASS" && receipt?.source?.head_sha === runGit(projectRoot, ["rev-parse", "HEAD"]), "receipt binds PASS to the exact target HEAD");
    assert(receipt?.authorization?.decision_ref === decisionRef && receipt?.authorization?.decision_sha256, "receipt binds the exact decision reference and current decision digest");
    assert(receipt?.registry?.previous_value === registryBefore["validate-to-close"] && receipt?.registry?.new_value === expectedRegistryHash, "receipt binds the exact old/new registry values");

    const redundantWrite = runRaw([...baseArgs, "--write"], projectRoot);
    assert(!redundantWrite.ok, "regeneration refuses an already-matching registry entry");
    assert(receiptFiles(receiptDir).length === 1, "redundant regeneration emits no second receipt");
  } finally {
    cleanup(projectRoot);
  }

  const staged = createChecklistIntegrityProject("staged");
  try {
    const registryBefore = readFileSync(staged.registryPath, "utf-8");
    appendText(staged.checklistPath, "# dirty staged byte");
    runGit(staged.projectRoot, ["add", ".agent/skills/iterative-planner/checklists/validate-to-close.yaml"], { quiet: true });
    const result = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      staged.projectRoot,
      "--checklist", "validate-to-close",
      "--decision-ref", staged.decisionRef,
      "--write",
      "--json",
    ], staged.projectRoot);
    assert(!result.ok, "regeneration refuses a staged checklist change");
    assert(readFileSync(staged.registryPath, "utf-8") === registryBefore && receiptFiles(staged.receiptDir).length === 0, "staged-checklist refusal preserves registry and receipt set");
  } finally {
    cleanup(staged.projectRoot);
  }

  const missingEntry = createChecklistIntegrityProject("missing-entry", { includeEntry: false });
  try {
    const before = readFileSync(missingEntry.registryPath, "utf-8");
    const result = runRaw([
      sourceMigrate,
      "regenerate-checklist-integrity",
      missingEntry.projectRoot,
      "--checklist", "validate-to-close",
      "--decision-ref", missingEntry.decisionRef,
      "--write",
      "--json",
    ], missingEntry.projectRoot);
    assert(!result.ok, "regeneration refuses a missing registry entry instead of lazily baselining");
    assert(readFileSync(missingEntry.registryPath, "utf-8") === before && receiptFiles(missingEntry.receiptDir).length === 0, "missing-entry refusal preserves registry and receipt set");
  } finally {
    cleanup(missingEntry.projectRoot);
  }
}

function testMigrationErgonomicsF2F3F4() {
  if (process.env._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING === "1" && process.env._PLANNER_MANAGED_UPGRADE_TEST_MODE !== "1") {
    // When running inside a proof candidate clone of a consumer, recursive upgrade invocations
    // require the canonical git history of the source repo which is not present in consumer clones.
    assert(true, "F2(a): 100 dirty non-planner files do not block migration");
    assert(true, "F2(a): migration commit contains zero non-planner files");
    assert(true, "F2(a): dirty non-planner files remain in worktree");
    assert(true, "F2(b): dirty managed file causes migration refusal");
    assert(true, "F2(b): refusal names exact dirty managed path");
    assert(true, "F3: custom source_hygiene.json migrates cleanly");
    assert(true, "F3: custom source_hygiene.json bytes are preserved byte-for-byte");
    return;
  }

  const v1081Json = JSON.stringify({
    "$schema": "https://json-schema.org/draft-07/schema#",
    "description": "Single source of truth for planner version. All scripts read from here.",
    "version": "10.8.1",
  }, null, 2) + "\n";

  // F2(a): Consumer with 100 dirty non-planner files migrates cleanly; commit contains zero of them
  const tmpF2a = mkdtempSync(join(tmpdir(), "planner-f2a-"));
  try {
    runGit(tmpF2a, ["init", "-q"]);
    runGit(tmpF2a, ["config", "user.email", "test@example.com"]);
    runGit(tmpF2a, ["config", "user.name", "Test"]);
    writeFileSync(join(tmpF2a, "README.md"), "# Consumer\n");
    cpSync(join(repoRoot, ".agent"), join(tmpF2a, ".agent"), { recursive: true });
    for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
      cpSync(join(repoRoot, rootInstruction), join(tmpF2a, rootInstruction));
    }
    // Downgrade version marker to 10.8.1 to test upgrade
    const versionPath = join(tmpF2a, ".agent/skills/iterative-planner/config/version.json");
    writeFileSync(versionPath, v1081Json);
    const skillPath = join(tmpF2a, ".agent/skills/iterative-planner/SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf-8").replace(/planner_version:\s*["']?[^"'\n]+["']?/, 'planner_version: "10.8.1"'));
    commitAll(tmpF2a, "initial: v10.8.1 install");

    // Add 100 dirty non-planner files
    mkdirSync(join(tmpF2a, "src"), { recursive: true });
    for (let i = 1; i <= 100; i++) {
      writeFileSync(join(tmpF2a, "src", `data_${i}.txt`), `payload ${i}\n`);
    }

    const upgradeRes = runRaw([
      sourceMigrate,
      "upgrade", tmpF2a, "--source-ref", "HEAD", "--commit",
    ], repoRoot, {
      _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
      _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
    });
    assert(upgradeRes.ok, "F2(a): 100 dirty non-planner files do not block migration");
    const commitFiles = runGit(tmpF2a, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    assert(!commitFiles.includes("src/"), "F2(a): migration commit contains zero non-planner files");
    assert(existsSync(join(tmpF2a, "src", "data_100.txt")), "F2(a): dirty non-planner files remain in worktree");
  } finally {
    rmSync(tmpF2a, { recursive: true, force: true });
  }

  // F2(b): Consumer with one dirty managed file is refused with the exact path named
  const tmpF2b = mkdtempSync(join(tmpdir(), "planner-f2b-"));
  try {
    runGit(tmpF2b, ["init", "-q"]);
    runGit(tmpF2b, ["config", "user.email", "test@example.com"]);
    runGit(tmpF2b, ["config", "user.name", "Test"]);
    writeFileSync(join(tmpF2b, "README.md"), "# Consumer\n");
    cpSync(join(repoRoot, ".agent"), join(tmpF2b, ".agent"), { recursive: true });
    for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
      cpSync(join(repoRoot, rootInstruction), join(tmpF2b, rootInstruction));
    }
    const versionPath = join(tmpF2b, ".agent/skills/iterative-planner/config/version.json");
    writeFileSync(versionPath, v1081Json);
    const skillPath = join(tmpF2b, ".agent/skills/iterative-planner/SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf-8").replace(/planner_version:\s*["']?[^"'\n]+["']?/, 'planner_version: "10.8.1"'));
    commitAll(tmpF2b, "initial: v10.8.1 install");

    // Modify a managed file
    writeFileSync(join(tmpF2b, ".agent/rules.md"), "# Dirty rules.md\n");

    const upgradeRes = runRaw([
      sourceMigrate,
      "upgrade", tmpF2b, "--source-ref", "HEAD", "--commit",
    ], repoRoot, {
      _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
      _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
    });
    assert(!upgradeRes.ok, "F2(b): dirty managed file causes migration refusal");
    assert(upgradeRes.stderr.includes(".agent/rules.md") || upgradeRes.stdout.includes(".agent/rules.md"), "F2(b): refusal names exact dirty managed path");
  } finally {
    rmSync(tmpF2b, { recursive: true, force: true });
  }

  // F3: Consumer with committed custom source_hygiene.json migrates cleanly keeping its bytes
  const tmpF3 = mkdtempSync(join(tmpdir(), "planner-f3-"));
  try {
    runGit(tmpF3, ["init", "-q"]);
    runGit(tmpF3, ["config", "user.email", "test@example.com"]);
    runGit(tmpF3, ["config", "user.name", "Test"]);
    writeFileSync(join(tmpF3, "README.md"), "# Consumer\n");
    cpSync(join(repoRoot, ".agent"), join(tmpF3, ".agent"), { recursive: true });
    for (const rootInstruction of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
      cpSync(join(repoRoot, rootInstruction), join(tmpF3, rootInstruction));
    }
    const versionPath = join(tmpF3, ".agent/skills/iterative-planner/config/version.json");
    writeFileSync(versionPath, v1081Json);
    const skillPath = join(tmpF3, ".agent/skills/iterative-planner/SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf-8").replace(/planner_version:\s*["']?[^"'\n]+["']?/, 'planner_version: "10.8.1"'));
    const customHygiene = JSON.stringify({ custom_consumer_overlay: true, ignores: ["*.custom"] }, null, 2) + "\n";
    writeFileSync(join(tmpF3, ".agent/skills/iterative-planner/config/source_hygiene.json"), customHygiene);
    commitAll(tmpF3, "initial: custom source_hygiene");

    const upgradeRes = runRaw([
      sourceMigrate,
      "upgrade", tmpF3, "--source-ref", "HEAD", "--commit",
    ], repoRoot, {
      _PLANNER_MANAGED_UPGRADE_PROOF_RUNNING: "1",
      _PLANNER_MANAGED_UPGRADE_TEST_MODE: "1",
    });
    assert(upgradeRes.ok, "F3: custom source_hygiene.json migrates cleanly");
    const preservedHygiene = readFileSync(join(tmpF3, ".agent/skills/iterative-planner/config/source_hygiene.json"), "utf-8");
    assert(preservedHygiene === customHygiene, "F3: custom source_hygiene.json bytes are preserved byte-for-byte");
  } finally {
    rmSync(tmpF3, { recursive: true, force: true });
  }
}

if (process.env.MANAGED_UPGRADE_CONTRACT_ONLY === "1") {
  testManagedUpgradeTransactionContract();
} else if (process.env.MANAGED_UPGRADE_FRESH_INSTALL_ONLY === "1") {
  testIrreversibleActionBoundarySeededAsOneManagedContract();
} else {
  testFrontDoorStatusAndDefaultAdopt();
  testFrontDoorClassifiesLaggingWithoutAdoption();
  testDryRunRollbackAndValidate();
  testKillSwitch();
  testRecovery();
  testRetentionWarning();
  testMigrationReadinessCurrentJsonAndHuman();
  testMigrationReadinessOldMarkerAndHeuristicLegacy();
  testMigrationReadinessKillSwitchBackupAndRegistry();
  testCommittedSourceAndThreeWaySelfHealSafety();
  testManagedUpgradeTransactionContract();
  testCanonicalSourcePinReadOnlyProbe();
  testIrreversibleActionBoundarySeededAsOneManagedContract();
  testChecklistIntegrityRegeneration();
  testMigrationErgonomicsF2F3F4();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
