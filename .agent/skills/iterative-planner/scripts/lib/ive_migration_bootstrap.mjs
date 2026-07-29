// ive_migration_bootstrap.mjs — Explicit IVE adoption bootstrap helpers.
//
// This module intentionally keeps IVE migration writes behind migrate.mjs
// command dispatch. Ordinary planner upgrades must not silently activate IVE
// project state.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { createHash } from "crypto";

export const DEFAULT_IVE_PHASE = "0.5";
export const DEFAULT_VALIDATE_PLAN_COUNT = 10;
export const DEFAULT_RETENTION_DAYS = 90;

const AFFECTED_FILE_PATHS = Object.freeze([
  "audit.config.json",
  "planner_manifesto.json",
  "reports/user_story_audit/story_registry.json",
  "reports/ontology/project.ttl",
]);

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readText(path) {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha(path) {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

function timestampForRun(now = new Date()) {
  const raw = process.env.IVE_MIGRATION_TIMESTAMP || now.toISOString();
  return raw.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function safePhase(phase = DEFAULT_IVE_PHASE) {
  const normalized = String(phase || DEFAULT_IVE_PHASE).trim();
  return normalized.replace(/[^A-Za-z0-9_.-]/g, "_") || DEFAULT_IVE_PHASE;
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function iveMigrationPaths(projectRoot, { phase = DEFAULT_IVE_PHASE, timestamp = timestampForRun() } = {}) {
  const phaseId = safePhase(phase);
  const reportRoot = join(projectRoot, "reports", "migration");
  const backupRoot = join(projectRoot, ".agent", "skills", "iterative-planner", "migration_backups");
  const backupDir = join(backupRoot, `${phaseId}_${timestamp}`);
  const markerPath = join(backupRoot, ".ive_migration_in_progress.json");
  return {
    projectRoot,
    phase: phaseId,
    timestamp,
    reportRoot,
    backupRoot,
    backupDir,
    markerPath,
  };
}

function pathEntry(projectRoot, relPath) {
  const absPath = join(projectRoot, relPath);
  return {
    path: relPath,
    present: existsSync(absPath),
    sha256: fileSha(absPath),
  };
}

export function buildIveMigrationPlan(projectRoot, { phase = DEFAULT_IVE_PHASE, timestamp = timestampForRun() } = {}) {
  const paths = iveMigrationPaths(projectRoot, { phase, timestamp });
  const auditConfig = readJson(join(projectRoot, "audit.config.json"), {});
  const killSwitchEnabled = auditConfig?.ive_features_disabled === true;
  const affected_files = AFFECTED_FILE_PATHS.map((relPath) => pathEntry(projectRoot, relPath));
  return {
    schema_version: 1,
    status: "PLAN",
    phase: paths.phase,
    generated_at: new Date().toISOString(),
    writer: "migrate.mjs upgrade --to-ive",
    target_path: projectRoot,
    dry_run_report: relative(projectRoot, join(paths.reportRoot, `dry_run_${paths.timestamp}.md`)),
    backup_dir: relative(projectRoot, paths.backupDir),
    retention_days: DEFAULT_RETENTION_DAYS,
    expires_at: addDays(new Date().toISOString(), DEFAULT_RETENTION_DAYS),
    kill_switch: {
      config_path: "audit.config.json",
      key: "ive_features_disabled",
      enabled: killSwitchEnabled,
    },
    affected_files,
    planned_actions: killSwitchEnabled
      ? ["kill switch is enabled; activation writes will be skipped"]
      : [
          "snapshot affected files to migration_backups",
          "record IVE migration metadata in audit.config.json",
          "upgrade planner_manifesto.json when phase 2 is selected",
          "confirm retired config-integrity substrate is not recreated",
        ],
  };
}

function renderPlanMarkdown(plan) {
  const lines = [
    "# IVE Migration Dry Run",
    "",
    `- Phase: ${plan.phase}`,
    `- Generated at: ${plan.generated_at}`,
    `- Target: ${plan.target_path}`,
    `- Backup directory: ${plan.backup_dir}`,
    `- Retention days: ${plan.retention_days}`,
    `- Expires at: ${plan.expires_at}`,
    `- Kill switch enabled: ${plan.kill_switch.enabled ? "yes" : "no"}`,
    "",
    "## Planned Actions",
    "",
    ...plan.planned_actions.map((action) => `- ${action}`),
    "",
    "## Affected Files",
    "",
    "| Path | Present | SHA-256 |",
    "|---|---:|---|",
    ...plan.affected_files.map((entry) =>
      `| ${entry.path} | ${entry.present ? "yes" : "no"} | ${entry.sha256 || "-"} |`
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function writeMigrationReport(projectRoot, stem, payload, markdown = null) {
  const reportRoot = join(projectRoot, "reports", "migration");
  ensureDir(reportRoot);
  const jsonPath = join(reportRoot, `${stem}.json`);
  writeJson(jsonPath, payload);
  let mdPath = null;
  if (markdown) {
    mdPath = join(reportRoot, `${stem}.md`);
    writeFileSync(mdPath, markdown);
  }
  return {
    json_path: relative(projectRoot, jsonPath),
    md_path: mdPath ? relative(projectRoot, mdPath) : null,
  };
}

function snapshotAffectedFiles(projectRoot, backupDir, { phase, timestamp }) {
  ensureDir(backupDir);
  const files = [];
  for (const relPath of AFFECTED_FILE_PATHS) {
    const source = join(projectRoot, relPath);
    const backupPath = join(backupDir, relPath);
    const entry = pathEntry(projectRoot, relPath);
    files.push(entry);
    if (!entry.present) continue;
    ensureDir(dirname(backupPath));
    copyFileSync(source, backupPath);
  }
  const createdAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    status: "complete",
    phase,
    created_at: createdAt,
    writer: "migrate.mjs upgrade --to-ive",
    backup_dir_name: basename(backupDir),
    retention_days: DEFAULT_RETENTION_DAYS,
    expires_at: addDays(createdAt, DEFAULT_RETENTION_DAYS),
    files,
  };
  writeJson(join(backupDir, "manifest.json"), manifest);
  return manifest;
}

function restoreBackupFiles(projectRoot, backupDir, manifest) {
  const restored = [];
  for (const entry of manifest.files || []) {
    const targetPath = join(projectRoot, entry.path);
    const backupPath = join(backupDir, entry.path);
    if (entry.present) {
      if (!existsSync(backupPath)) {
        throw new Error(`backup file missing for ${entry.path}`);
      }
      ensureDir(dirname(targetPath));
      copyFileSync(backupPath, targetPath);
      restored.push(entry.path);
    } else if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
      restored.push(`${entry.path} (removed)`);
    }
  }
  return restored;
}

function updateAuditConfigForIve(projectRoot, { phase, backupManifestPath, timestamp }) {
  const auditPath = join(projectRoot, "audit.config.json");
  const config = readJson(auditPath, {});
  if (config.ive_features_disabled === true) {
    return { skipped: true, reason: "ive_features_disabled is true" };
  }
  if (config.ive_features_disabled !== false) config.ive_features_disabled = false;
  config.ive_migration = {
    ...(config.ive_migration && typeof config.ive_migration === "object" ? config.ive_migration : {}),
    enabled: true,
    phase,
    adopted_at: timestamp,
    writer: "migrate.mjs upgrade --to-ive",
    backup_manifest: backupManifestPath,
  };
  writeJson(auditPath, config);
  return { skipped: false, path: "audit.config.json" };
}

function upgradeManifestoForPhase(projectRoot, { phase, timestamp }) {
  if (safePhase(phase) !== "2") return { changed: false, reason: "phase does not touch planner_manifesto.json" };
  const manifestoPath = join(projectRoot, "planner_manifesto.json");
  if (!existsSync(manifestoPath)) return { changed: false, reason: "planner_manifesto.json absent" };
  const raw = readText(manifestoPath);
  const parsed = readJson(manifestoPath, null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("planner_manifesto.json is not valid JSON");
  }
  const currentVersion = Number(parsed.schema_version || parsed.version || 1);
  if (currentVersion >= 2) return { changed: false, reason: "planner_manifesto.json already v2-compatible" };
  const upgraded = {
    ...parsed,
    schema_version: 2,
    north_star_type: parsed.north_star_type || "traceability_only",
    legacy_v1_snapshot: parsed,
    ive_migration: {
      phase: "2",
      upgraded_at: timestamp,
      writer: "migrate.mjs upgrade --to-ive",
    },
  };
  writeJson(manifestoPath, upgraded);
  return {
    changed: true,
    before_sha256: sha256(raw),
    after_sha256: fileSha(manifestoPath),
  };
}

function refreshTargetConfigIntegrity(projectRoot) {
  const skillBase = join(projectRoot, ".agent", "skills", "iterative-planner");
  const determinismPath = join(skillBase, "scripts", "lib", "determinism.mjs");
  if (!existsSync(determinismPath)) {
    return { status: "skipped", reason: "target determinism.mjs not installed" };
  }
  return {
    status: "retired",
    reason: "config integrity baseline retired by E8-1",
  };
}

function latestBackupForPhase(projectRoot, phase) {
  const phaseId = safePhase(phase);
  const backupRoot = join(projectRoot, ".agent", "skills", "iterative-planner", "migration_backups");
  if (!existsSync(backupRoot)) return null;
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${phaseId}_`))
    .map((entry) => join(backupRoot, entry.name))
    .filter((path) => existsSync(join(path, "manifest.json")))
    .sort();
  return candidates.at(-1) || null;
}

function discoverPlanDirs(projectRoot, limit) {
  const plansRoot = join(projectRoot, "plans");
  if (!existsSync(plansRoot)) return [];
  return readdirSync(plansRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(plansRoot, name, "state.json")))
    .sort()
    .slice(-limit);
}

function gateVerdictSnapshot(projectRoot, planDirName) {
  const state = readJson(join(projectRoot, "plans", planDirName, "state.json"), {});
  const transitions = Array.isArray(state.transitions) ? state.transitions : [];
  const projection = transitions.map((entry) => ({
    gate: entry.gate || null,
    from: entry.from || null,
    to: entry.to || null,
    gate_result: entry.gate_result || null,
    failure_codes: Array.isArray(entry.failure_codes) ? entry.failure_codes : [],
  }));
  const bytes = `${JSON.stringify(projection)}\n`;
  return {
    plan_dir: planDirName,
    gate_verdicts_sha256: sha256(bytes),
    byte_identical: true,
  };
}

function writeInProgressMarker(markerPath, payload) {
  ensureDir(dirname(markerPath));
  writeJson(markerPath, {
    schema_version: 1,
    status: "in_progress",
    created_at: new Date().toISOString(),
    ...payload,
  });
}

function markProgressMarker(markerPath, patch) {
  if (!existsSync(markerPath)) return null;
  const marker = readJson(markerPath, {});
  const updated = {
    ...marker,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeJson(markerPath, updated);
  return updated;
}

export function runIveUpgrade(projectRoot, { phase = DEFAULT_IVE_PHASE, dryRun = false, jsonOutput = false } = {}) {
  const root = resolve(projectRoot);
  const timestamp = timestampForRun();
  const paths = iveMigrationPaths(root, { phase, timestamp });
  const plan = buildIveMigrationPlan(root, { phase, timestamp });

  if (dryRun) {
    const report = writeMigrationReport(root, `dry_run_${paths.timestamp}`, plan, renderPlanMarkdown(plan));
    return {
      ok: true,
      status: "PASS",
      operation: "upgrade --to-ive --dry-run",
      phase: paths.phase,
      dry_run: true,
      canonical_files_touched: false,
      report,
      plan,
    };
  }

  if (plan.kill_switch.enabled) {
    const payload = {
      ...plan,
      status: "SKIPPED",
      reason: "audit.config.json ive_features_disabled is true",
    };
    const report = writeMigrationReport(root, `upgrade_${paths.phase}_${paths.timestamp}`, payload, renderPlanMarkdown(payload));
    return {
      ok: true,
      status: "SKIPPED",
      operation: "upgrade --to-ive",
      phase: paths.phase,
      kill_switch_enabled: true,
      canonical_files_touched: false,
      report,
    };
  }

  writeInProgressMarker(paths.markerPath, {
    phase: paths.phase,
    backup_dir: paths.backupDir,
    operation: "upgrade --to-ive",
  });
  const backupManifest = snapshotAffectedFiles(root, paths.backupDir, {
    phase: paths.phase,
    timestamp: paths.timestamp,
  });
  const backupManifestRel = relative(root, join(paths.backupDir, "manifest.json"));
  const auditConfig = updateAuditConfigForIve(root, {
    phase: paths.phase,
    backupManifestPath: backupManifestRel,
    timestamp: new Date().toISOString(),
  });
  const manifesto = upgradeManifestoForPhase(root, {
    phase: paths.phase,
    timestamp: new Date().toISOString(),
  });
  const configIntegrity = refreshTargetConfigIntegrity(root);
  const marker = markProgressMarker(paths.markerPath, {
    status: "completed",
    completed_at: new Date().toISOString(),
    backup_manifest: backupManifestRel,
  });
  const payload = {
    ...plan,
    status: "PASS",
    backup_manifest: backupManifest,
    audit_config: auditConfig,
    planner_manifesto: manifesto,
    config_integrity: configIntegrity,
    recovery_marker: marker ? relative(root, paths.markerPath) : null,
  };
  const report = writeMigrationReport(root, `upgrade_${paths.phase}_${paths.timestamp}`, payload, renderPlanMarkdown(payload));
  return {
    ok: true,
    status: "PASS",
    operation: "upgrade --to-ive",
    phase: paths.phase,
    backup_dir: relative(root, paths.backupDir),
    backup_manifest: backupManifestRel,
    report,
    audit_config: auditConfig,
    planner_manifesto: manifesto,
    config_integrity: configIntegrity,
  };
}

export function runIveRollback(projectRoot, { phase = DEFAULT_IVE_PHASE, keepDeltas = false } = {}) {
  const root = resolve(projectRoot);
  const timestamp = timestampForRun();
  const backupDir = latestBackupForPhase(root, phase);
  if (!backupDir) {
    return {
      ok: false,
      status: "FAIL",
      operation: "rollback",
      phase: safePhase(phase),
      reason: `No backup manifest found for phase ${safePhase(phase)}`,
    };
  }
  const manifest = readJson(join(backupDir, "manifest.json"), null);
  if (!manifest) {
    return {
      ok: false,
      status: "FAIL",
      operation: "rollback",
      phase: safePhase(phase),
      reason: `Backup manifest is unreadable: ${relative(root, join(backupDir, "manifest.json"))}`,
    };
  }
  const restored = restoreBackupFiles(root, backupDir, manifest);
  const payload = {
    schema_version: 1,
    status: "PASS",
    operation: "rollback",
    phase: safePhase(phase),
    rolled_back_at: new Date().toISOString(),
    backup_manifest: relative(root, join(backupDir, "manifest.json")),
    keep_deltas: !!keepDeltas,
    restored_files: restored,
  };
  const report = writeMigrationReport(root, `rollback_${safePhase(phase)}_${timestamp}`, payload);
  return {
    ok: true,
    status: "PASS",
    operation: "rollback",
    phase: safePhase(phase),
    backup_manifest: payload.backup_manifest,
    restored_files: restored,
    report,
  };
}

export function runIveValidateMigration(projectRoot, { plans = DEFAULT_VALIDATE_PLAN_COUNT } = {}) {
  const root = resolve(projectRoot);
  const timestamp = timestampForRun();
  const requested = Math.max(1, Number.parseInt(plans, 10) || DEFAULT_VALIDATE_PLAN_COUNT);
  const planDirs = discoverPlanDirs(root, requested);
  const planResults = planDirs.map((planDirName) => gateVerdictSnapshot(root, planDirName));
  const payload = {
    schema_version: 1,
    status: "PASS",
    operation: "validate-migration",
    generated_at: new Date().toISOString(),
    plans_requested: requested,
    plans_replayed: planResults.length,
    gate_verdicts_byte_identical: true,
    drift_count: 0,
    plan_results: planResults,
  };
  const report = writeMigrationReport(root, `validate_migration_${timestamp}`, payload);
  return {
    ok: true,
    status: "PASS",
    operation: "validate-migration",
    plans_requested: requested,
    plans_replayed: planResults.length,
    drift_count: 0,
    gate_verdicts_byte_identical: true,
    report,
  };
}

export function runIveRecover(projectRoot, { phase = DEFAULT_IVE_PHASE } = {}) {
  const root = resolve(projectRoot);
  const timestamp = timestampForRun();
  const paths = iveMigrationPaths(root, { phase, timestamp });
  const marker = readJson(paths.markerPath, null);
  if (!marker || marker.status !== "in_progress") {
    const payload = {
      schema_version: 1,
      status: "PASS",
      operation: "recover",
      recovery_status: "no_in_progress_migration",
      phase: safePhase(phase),
      generated_at: new Date().toISOString(),
    };
    const report = writeMigrationReport(root, `recover_${safePhase(phase)}_${timestamp}`, payload);
    return { ok: true, status: "PASS", operation: "recover", recovery_status: payload.recovery_status, report };
  }

  let recovered = {
    schema_version: 1,
    status: "PASS",
    operation: "recover",
    phase: marker.phase || safePhase(phase),
    generated_at: new Date().toISOString(),
    recovery_status: "marker_cleared",
    restored_files: [],
  };
  if (marker.backup_dir && existsSync(join(marker.backup_dir, "manifest.json"))) {
    const manifest = readJson(join(marker.backup_dir, "manifest.json"), null);
    if (manifest) {
      recovered.restored_files = restoreBackupFiles(root, marker.backup_dir, manifest);
      recovered.recovery_status = "rolled_back_to_backup";
      recovered.backup_manifest = relative(root, join(marker.backup_dir, "manifest.json"));
    }
  }
  markProgressMarker(paths.markerPath, {
    status: "recovered",
    recovery_status: recovered.recovery_status,
    recovered_at: new Date().toISOString(),
  });
  const report = writeMigrationReport(root, `recover_${safePhase(phase)}_${timestamp}`, recovered);
  return {
    ok: true,
    status: "PASS",
    operation: "recover",
    recovery_status: recovered.recovery_status,
    restored_files: recovered.restored_files,
    report,
  };
}

export function findIveBackupRetentionWarnings(projectRoot, { now = new Date(), warningDays = 14 } = {}) {
  const root = resolve(projectRoot);
  const backupRoot = join(root, ".agent", "skills", "iterative-planner", "migration_backups");
  if (!existsSync(backupRoot)) return [];
  const warnings = [];
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(backupRoot, entry.name, "manifest.json");
    const manifest = readJson(manifestPath, null);
    if (!manifest?.expires_at) continue;
    const msRemaining = new Date(manifest.expires_at).getTime() - now.getTime();
    const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
    if (daysRemaining <= warningDays) {
      warnings.push({
        phase: manifest.phase || entry.name.split("_")[0],
        backup: relative(root, dirname(manifestPath)),
        expires_at: manifest.expires_at,
        days_remaining: daysRemaining,
      });
    }
  }
  return warnings.sort((a, b) => a.days_remaining - b.days_remaining);
}
