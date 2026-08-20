import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { emitJson } from "./emit_json.mjs";

const SELF_HEAL_ENV = "_PLANNER_SELF_HEAL_RUNNING";
const SELF_HEAL_SKIP_ENV = "PLANNER_SKIP_SELF_HEAL";
const SELF_HEAL_SOURCE_ENV = "PLANNER_SOURCE_REPO";

function resolveSelfHealSource(projectRoot) {
  const override = process.env[SELF_HEAL_SOURCE_ENV]?.trim();
  if (override) return resolve(projectRoot, override);

  const registryPath = join(projectRoot, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const sourcePath = registry?.source_project_path;
    if (typeof sourcePath === "string" && sourcePath.trim()) return resolve(sourcePath);
  } catch {
    // Best-effort lookup only — fall through when the registry is absent or stale.
  }
  return null;
}

export function inspectInstallHealth(projectRoot) {
  const sourceRepo = resolveSelfHealSource(projectRoot) || projectRoot;
  const migrateScript = join(sourceRepo, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
  if (!existsSync(migrateScript)) {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: false,
      needs_repair: false,
      summary: { description: `Canonical migrate.mjs not found at ${migrateScript}` },
    };
  }

  const doctor = spawnSync(process.execPath, [migrateScript, "doctor", projectRoot, "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (doctor.status !== 0) {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      needs_repair: false,
      summary: { description: `doctor check failed (${doctor.status ?? "unknown"})` },
      stderr: doctor.stderr || "",
    };
  }

  try {
    const report = JSON.parse(doctor.stdout || "{}");
    return {
      ok: true,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      ...report,
    };
  } catch {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      needs_repair: false,
      summary: { description: "doctor output was not valid JSON" },
    };
  }
}

export function maybeRunSelfHeal(projectRoot, entryArgs) {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") return;
  if (command === "install-health" || command === "triage" || command === "contract") return;
  if (process.env[SELF_HEAL_ENV] === "1" || process.env[SELF_HEAL_SKIP_ENV]) return;

  const health = inspectInstallHealth(projectRoot);
  if (!health?.ok || !health.source_repo || resolve(health.source_repo) === resolve(projectRoot)) return;
  if (!health.needs_repair) return;

  const migrateScript = join(health.source_repo, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
  if (!existsSync(migrateScript)) {
    if (existsSync(health.source_repo)) {
      console.warn(`⚠️  Planner self-heal skipped — canonical migrate.mjs not found at ${migrateScript}`);
    }
    return;
  }

  console.log("\n── Planner Self-Heal ──");
  console.log(`  Source repo: ${health.source_repo}`);
  console.log(`  Source ref: ${health.source_ref || "HEAD"}`);
  console.log(`  Source commit: ${health.source_commit || "unresolved"}`);
  console.log(`  Target repo: ${projectRoot}`);
  console.log(`  Version strata: committed=${health.committed_version || "unknown"}, tree=${health.tree_version || health.detected_version || "unknown"}, source=${health.source_version || health.current_version || "unknown"}`);
  console.log(`  Install state: ${health.install_state || "unknown"}`);
  console.log(`  Detected drift: ${health.summary?.description || "planner repair required"}`);
  if (!health.source_commit) {
    console.warn("  ⚠️  Planner self-heal paused — the installed doctor cannot resolve an immutable source commit.");
    console.warn("  First hop: run the canonical migrate.mjs upgrade command manually with --source-ref <commit>, then retry.");
    return;
  }

  if (health.recovery_command) {
    console.log("  ⚠️  Planner self-heal paused — an interrupted managed upgrade must be recovered first.");
    console.log(`  Recover: ${health.recovery_command}`);
    return;
  }
  console.log("  ⏸️  Planner self-heal requires explicit commit consent; no target files were written.");
  console.log(`  Run: ${health.repair_command || `${process.execPath} ${migrateScript} upgrade ${JSON.stringify(projectRoot)} --source-ref ${health.source_commit} --commit`}`);
  console.log("  For legacy half-applied debris: preserve unrelated work, stash or revert .agent/** and managed root snapshots, then run the pinned command above.");
  if (command === "status") return;
  console.log(`  Original planner command '${command}' was not run against the stale installation.`);
  process.exit(2);
}

export function maybeHandleInstallHealth(projectRoot) {
  if (process.argv[2] !== "install-health") return false;
  const jsonMode = process.argv.includes("--json");
  const health = inspectInstallHealth(projectRoot);
  if (jsonMode) {
    emitJson(health, { exitCode: health.ok ? 0 : 1 });
    return true;
  }

  console.log("Planner Install Health");
  console.log();
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  Canonical source: ${health.source_repo || "unknown"}`);
  console.log(`  Source ref: ${health.source_ref || "HEAD"}`);
  console.log(`  Source commit: ${health.source_commit || "unresolved"}`);
  console.log(`  Self-heal available: ${health.self_heal_available ? "YES" : "NO"}`);
  console.log(`  Needs repair: ${health.needs_repair ? "YES" : "NO"}`);
  console.log(`  Advisories: ${(health.advisory_issues || []).length}`);
  console.log(`  Summary: ${health.summary?.description || "No summary available"}`);
  if (!health.ok) {
    console.log("  Diagnosis: planner install health could not be verified cleanly.");
    process.exit(1);
  }
  if (health.needs_repair) {
    console.log("  Next step: planner entrypoints will diagnose drift and pause for explicit commit consent.");
    if (health.recovery_command) console.log(`  Recover first: ${health.recovery_command}`);
    console.log(`  Upgrade: ${health.repair_command || "node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade . --commit"}`);
  } else if ((health.advisory_issues || []).length > 0) {
    console.log("  Advisory drift: no self-heal will run. Sync root instruction mirrors manually if you want them aligned.");
  } else {
    console.log("  Next step: planner-managed files and setup look aligned.");
  }
  process.exit(0);
}
