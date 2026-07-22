#!/usr/bin/env node
// test_ive_migration_bootstrap.mjs — IVE phase 0.5 migration bootstrap proof.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const sourceMigrate = join(skillDir, "scripts", "migrate.mjs");
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

function runJson(args, cwd = repoRoot) {
  const stdout = execFileSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IVE_MIGRATION_TIMESTAMP: `2026-05-31T13-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}-00Z`,
    },
  });
  return JSON.parse(stdout);
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

function rel(projectRoot, relPath) {
  return join(projectRoot, relPath);
}

console.log("\nIVE Migration Bootstrap Tests\n");

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
    assert(existsSync(rel(tmp, ".agent/skills/iterative-planner/config/.config_integrity")), "phase 2 refreshes target .config_integrity");

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
    });
    assert(stdout.includes("IVE migration backup retention window expiring"), "bootstrap status warns when backup retention is near expiry");
  } finally {
    cleanup(tmp);
  }
}

testDryRunRollbackAndValidate();
testKillSwitch();
testRecovery();
testRetentionWarning();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
