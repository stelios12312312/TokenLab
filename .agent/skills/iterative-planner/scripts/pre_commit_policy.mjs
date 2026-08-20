#!/usr/bin/env node
// pre_commit_policy.mjs — local advisory policy for planner hook diagnostics.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { join, dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  normalizeVerificationStatus,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = join(scriptDir, "..");
const cwd = process.cwd();

const SKILL_PREFIX = ".agent/skills/iterative-planner/";
const LEDGER_PATH = join(cwd, "plans", "commit_advisories.json");
const ARCHETYPE_SCENARIO_CONFIG_PATH = join(skillDir, "config", "archetype_scenarios.json");
const FOLLOW_UP_COMMANDS = [
  "node .agent/skills/iterative-planner/scripts/ripple_check.mjs",
  "node .agent/skills/iterative-planner/scripts/bootstrap.mjs install-health",
  "/advisor",
];
const IVE_RUNNER_PATH = join(skillDir, "tests", "ive", "run.mjs");
const AFFECTED_TEST_TIMEOUT_MS = 900_000;
const AFFECTED_TEST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PROOF_ATTESTATION_ENV = "_PLANNER_MANAGED_UPGRADE_PROOF_ATTESTATION";
const REQUIRED_MANAGED_UPGRADE_PROOFS = Object.freeze([
  "gate-or-delete-census",
  "migration-bootstrap",
  "preplanning-scaffolding",
  "transition-gate-flows",
]);
const GOVERNED_RELEASE_PROFILE_ID = "core-release";
const GOVERNED_RELEASE_PROFILE_SURFACES = new Set([
  `${SKILL_PREFIX}config/ive_release_profiles.json`,
  `${SKILL_PREFIX}scripts/pre_commit_policy.mjs`,
  `${SKILL_PREFIX}tests/ive/run.mjs`,
  `${SKILL_PREFIX}tests/ive/test_run.mjs`,
  `${SKILL_PREFIX}tests/test_ive_conformance_runner.mjs`,
]);
const PARENT_GIT_ENV_KEYS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function isolatedChildEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of PARENT_GIT_ENV_KEYS) delete env[key];
  return env;
}

function getPlannerCoreProofBundle() {
  const parsed = readJson(ARCHETYPE_SCENARIO_CONFIG_PATH, null);
  const bundle = parsed?.planner_core_proof_bundle;
  return {
    trigger_paths: Array.isArray(bundle?.trigger_paths) ? bundle.trigger_paths.map(normalizePath) : [],
    required_commands: Array.isArray(bundle?.required_commands) ? bundle.required_commands : [],
  };
}

function writeJsonAtomic(path, payload) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function runJsonScript(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: isolatedChildEnv(),
  });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = null;
  }

  return { result, parsed };
}

function runAffectedIveTests(stagedFiles) {
  if (!existsSync(IVE_RUNNER_PATH)) {
    return { ok: false, error: `IVE runner missing: ${normalizePath(IVE_RUNNER_PATH)}` };
  }
  const useGovernedProfile = stagedFiles.some((file) =>
    GOVERNED_RELEASE_PROFILE_SURFACES.has(normalizePath(file))
  );
  const explicitPlanTarget = process.env._PLANNER_PLAN_TARGET?.trim() || null;
  const planTargetArgs = explicitPlanTarget
    ? ["--plan-target", explicitPlanTarget]
    : [];
  const args = useGovernedProfile
    ? [
        IVE_RUNNER_PATH,
        "--profile",
        GOVERNED_RELEASE_PROFILE_ID,
        ...planTargetArgs,
        "--json",
      ]
    : [
        IVE_RUNNER_PATH,
        ...stagedFiles.flatMap((file) => ["--changed-files", file]),
        ...planTargetArgs,
        "--json",
        "--no-manifest",
      ];
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: isolatedChildEnv(),
    timeout: AFFECTED_TEST_TIMEOUT_MS,
    maxBuffer: AFFECTED_TEST_MAX_BUFFER_BYTES,
  });
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (error) {
    parseError = error;
  }
  const normalizedStatus = normalizeVerificationStatus(parsed?.status, "gate");
  const status = normalizedStatus.canonical || "UNKNOWN";
  const ok = result.status === 0 && normalizedStatus.kind === "pass";
  return {
    ok,
    status,
    selection_mode: useGovernedProfile ? `profile:${GOVERNED_RELEASE_PROFILE_ID}` : "changed-files",
    selected_count: Array.isArray(parsed?.results) ? parsed.results.length : Number(parsed?.summary?.total || 0),
    error: ok ? null : (
      result.stderr?.trim() ||
      parsed?.issues?.[0]?.message ||
      result.error?.message ||
      (parseError ? `IVE affected-test JSON parse failed after ${Buffer.byteLength(result.stdout || "", "utf8")} byte(s): ${parseError.message}` : null) ||
      `IVE affected-test run returned ${status} (exit ${result.status ?? "unknown"}, signal ${result.signal ?? "none"})`
    ),
  };
}

function validateManagedUpgradeProofAttestation() {
  const requested = process.env[PROOF_ATTESTATION_ENV]?.trim();
  if (!requested) return { present: false, ok: false, reason: null };
  if (requested !== "1") {
    return { present: true, ok: false, reason: "proof attestation marker is invalid" };
  }
  const gitDirResult = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (gitDirResult.status !== 0) {
    return { present: true, ok: false, reason: "cannot resolve Git metadata for proof attestation" };
  }
  let resolvedGitDir;
  let resolvedAttestation;
  try {
    resolvedGitDir = realpathSync(gitDirResult.stdout.trim());
    resolvedAttestation = realpathSync(join(
      resolvedGitDir,
      "iterative-planner",
      "managed-upgrade-proof.json",
    ));
  } catch {
    return { present: true, ok: false, reason: "proof attestation path cannot be resolved" };
  }
  if (dirname(resolvedAttestation) !== join(resolvedGitDir, "iterative-planner")) {
    return { present: true, ok: false, reason: "proof attestation is outside this repository's Git metadata" };
  }
  const attestation = readJson(resolvedAttestation, null);
  if (
    attestation?.schema_version !== 1
    || !verificationStatusIsPass(attestation?.status, "execution")
  ) {
    return { present: true, ok: false, reason: "proof attestation is missing or malformed" };
  }
  const treeResult = spawnSync("git", ["write-tree"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    treeResult.status !== 0
    || treeResult.stdout.trim() !== attestation.staged_tree_sha
  ) {
    return { present: true, ok: false, reason: "proof attestation does not match the staged candidate tree" };
  }
  const passedIds = new Set(
    (Array.isArray(attestation.conformance) ? attestation.conformance : [])
      .filter((entry) => verificationStatusIsPass(entry?.status, "execution"))
      .map((entry) => entry.id),
  );
  const complete = REQUIRED_MANAGED_UPGRADE_PROOFS.every((id) => passedIds.has(id));
  const testParentOwned = attestation.test_parent_owned === true
    && process.env._PLANNER_MANAGED_UPGRADE_TEST_MODE === "1"
    && passedIds.has("parent-proof-owner");
  if (!complete && !testParentOwned) {
    return { present: true, ok: false, reason: "proof attestation does not contain every required PASS" };
  }
  return {
    present: true,
    ok: true,
    reason: testParentOwned ? "outer migration test owns recursive proof" : "same staged tree already passed managed-upgrade conformance",
  };
}

function managedUpgradeRecoveryRecipe() {
  const registry = readJson(
    join(cwd, ".agent/skills/iterative-planner/config/.project_registry.json"),
    {},
  );
  const sourceRepo = process.env.PLANNER_CANONICAL_SOURCE_REPO?.trim()
    || registry?.source_project_path;
  if (typeof sourceRepo !== "string" || !sourceRepo.trim()) return null;
  const sourceScript = join(
    resolve(sourceRepo),
    ".agent/skills/iterative-planner/scripts/migrate.mjs",
  );
  if (!existsSync(sourceScript)) return null;
  const sourceCommitResult = spawnSync(
    "git",
    ["-C", resolve(sourceRepo), "rev-parse", "--verify", "HEAD^{commit}"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const sourceCommit = process.env.PLANNER_SOURCE_COMMIT?.trim()
    || (sourceCommitResult.status === 0 ? sourceCommitResult.stdout.trim() : null);
  if (!sourceCommit) return null;
  return {
    doctor: `node ${JSON.stringify(sourceScript)} doctor ${JSON.stringify(cwd)} --source-ref ${sourceCommit}`,
    upgrade: `node ${JSON.stringify(sourceScript)} upgrade ${JSON.stringify(cwd)} --source-ref ${sourceCommit} --commit`,
  };
}

function enforceAffectedIveTests(stagedFiles) {
  const attestation = validateManagedUpgradeProofAttestation();
  if (attestation.present) {
    if (!attestation.ok) {
      console.error(`  ❌ pre-commit: managed-upgrade proof attestation refused (${attestation.reason})`);
      return false;
    }
    console.log(`  ✅ pre-commit: ${attestation.reason}`);
    return true;
  }
  console.log(`  [pre-commit] Running affected IVE suites for ${stagedFiles.length} staged planner file(s)...`);
  const affected = runAffectedIveTests(stagedFiles);
  if (!affected.ok) {
    console.error("  ❌ pre-commit: affected IVE suites failed; refusing commit");
    if (affected.error) console.error(`  ${affected.error}`);
    console.error("  half-applied payload detected (or an incoherent managed payload may be present).");
    console.error("  Recovery: preserve unrelated work, then stash or revert .agent/** and managed root snapshots to committed state.");
    const recipe = managedUpgradeRecoveryRecipe();
    if (recipe) {
      console.error(`  Diagnose: ${recipe.doctor}`);
      console.error(`  Rerun: ${recipe.upgrade}`);
    } else {
      console.error("  Diagnose with the canonical source repository's migrate.mjs doctor command.");
      console.error("  Then rerun the exact source-pinned upgrade command printed by doctor with --commit.");
    }
    return false;
  }
  console.log(`  ✅ pre-commit: affected IVE suites passed (${affected.selected_count} selected; ${affected.selection_mode})`);
  return true;
}

function getStagedPlannerFiles() {
  const result = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return {
      ok: false,
      files: [],
      error: result.stderr?.trim() || "git diff --cached failed",
    };
  }

  const files = (result.stdout || "")
    .split("\n")
    .map((line) => normalizePath(line))
    .filter((line) => line.startsWith(SKILL_PREFIX));

  return { ok: true, files };
}

function impactedPathsForGap(gate, gap) {
  const file = String(gap?.file || "");
  if (!file) return [];
  if (file.startsWith("checklists/")) return [normalizePath(`${SKILL_PREFIX}${file}`)];

  switch (file) {
    case "transition.mjs":
      return [normalizePath(`${SKILL_PREFIX}scripts/transition.mjs`)];
    case "failure-codes.json":
      return [normalizePath(`${SKILL_PREFIX}config/failure-codes.json`)];
    case "config/archetype_scenarios.json":
      return [normalizePath(`${SKILL_PREFIX}config/archetype_scenarios.json`)];
    case "SKILL.md":
      return [normalizePath(`${SKILL_PREFIX}SKILL.md`)];
    case "config/version.json":
      return [normalizePath(`${SKILL_PREFIX}config/version.json`)];
    case "MIGRATION.md":
      return [normalizePath(`${SKILL_PREFIX}MIGRATION.md`)];
    case "pre_commit_policy.mjs":
      return [normalizePath(`${SKILL_PREFIX}scripts/pre_commit_policy.mjs`)];
    case "instruction-surface":
      return [
        normalizePath(`${SKILL_PREFIX}SKILL.md`),
        "CLAUDE.md",
        "GEMINI.md",
        "AGENTS.md",
      ];
    default:
      if (gate === "planner-core-proof-bundle" && file === "pre_commit_policy.mjs") {
        return [normalizePath(`${SKILL_PREFIX}scripts/pre_commit_policy.mjs`)];
      }
      if (gate === "version-consistency" && file === "SKILL.md") {
        return [normalizePath(`${SKILL_PREFIX}SKILL.md`)];
      }
      return [];
  }
}

function flattenHardGaps(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const flattened = [];
  for (const entry of results) {
    const gate = String(entry?.gate || "");
    const gaps = Array.isArray(entry?.gaps) ? entry.gaps : [];
    for (const gap of gaps) {
      if (gap?.severity === "warn") continue;
      flattened.push({
        gate,
        file: String(gap?.file || ""),
        issue: String(gap?.issue || ""),
        impacted_paths: impactedPathsForGap(gate, gap),
      });
    }
  }
  return flattened;
}

function appendAdvisoryRecord(record) {
  mkdirSync(join(cwd, "plans"), { recursive: true });
  const ledger = readJson(LEDGER_PATH, { version: 1, advisories: [] });
  if (!Array.isArray(ledger.advisories)) ledger.advisories = [];
  ledger.advisories.push(record);
  ledger.advisories = ledger.advisories.slice(-100);
  writeJsonAtomic(LEDGER_PATH, ledger);
}

function requiredPlannerCoreProofCommands(stagedFiles) {
  const bundle = getPlannerCoreProofBundle();
  const staged = new Set((Array.isArray(stagedFiles) ? stagedFiles : []).map(normalizePath));
  const touchedPlannerCoreProofSurface = bundle.trigger_paths.some((path) => staged.has(normalizePath(path)));
  return touchedPlannerCoreProofSurface ? bundle.required_commands : [];
}

function cmdPreCommit() {
  const staged = getStagedPlannerFiles();
  if (!staged.ok) {
    console.error("  ❌ pre-commit: could not inspect staged planner files");
    console.error(`  ${staged.error}`);
    process.exit(1);
  }

  if (staged.files.length === 0) {
    process.exit(0);
  }

  const plannerCoreProofCommands = requiredPlannerCoreProofCommands(staged.files);

  console.log("  [pre-commit] Planner files staged — evaluating scoped ripple-through policy...");

  const rippleScript = join(scriptDir, "ripple_check.mjs");
  const ripple = runJsonScript(rippleScript, ["--json"]);
  const status = ripple.result.status ?? 2;
  if (!ripple.parsed || (status !== 0 && status !== 1)) {
    console.error("  ❌ pre-commit: ripple-through check could not be evaluated safely");
    if (ripple.result.stderr?.trim()) console.error(`  ${ripple.result.stderr.trim()}`);
    process.exit(1);
  }

  const hardGaps = flattenHardGaps(ripple.parsed);
  if (hardGaps.length === 0) {
    console.log("  ✅ pre-commit: ripple-through check passed");
    if (plannerCoreProofCommands.length > 0) {
      console.log("  ℹ️  planner-core proof bundle expected before merge:");
      for (const command of plannerCoreProofCommands) {
        console.log(`     - ${command}`);
      }
    }
    if (!enforceAffectedIveTests(staged.files)) process.exit(1);
    process.exit(0);
  }

  const impactedPaths = [...new Set(hardGaps.flatMap((gap) => gap.impacted_paths).filter(Boolean))];

  const advisoryId = `advisory_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const record = {
    id: advisoryId,
    type: "deferred_pre_commit_ripple_gap",
    created_at: new Date().toISOString(),
    status: "pending_review",
    staged_files: staged.files,
    impacted_paths: impactedPaths,
    issues: hardGaps.map((gap) => ({
      gate: gap.gate,
      file: gap.file,
      issue: gap.issue,
    })),
    recommended_commands: uniqueList([
      ...plannerCoreProofCommands,
      ...FOLLOW_UP_COMMANDS,
    ]),
  };

  try {
    appendAdvisoryRecord(record);
  } catch (error) {
    console.error("  ❌ pre-commit: could not persist deferred advisory record");
    console.error(`  ${error.message}`);
    process.exit(1);
  }

  console.log(`  ⚠️  pre-commit: deferred ${hardGaps.length} hard ripple gap(s) to plans/commit_advisories.json`);
  console.log("  Local pre-commit enforcement is advisory; governed clean-checkout conformance and managed pre-push refusal remain authoritative.");
  console.log(`  Advisory id: ${advisoryId}`);
  console.log("  Follow up:");
  for (const command of FOLLOW_UP_COMMANDS) {
    console.log(`  - ${command}`);
  }
  if (!enforceAffectedIveTests(staged.files)) process.exit(1);
  process.exit(0);
}

const command = process.argv[2] || "pre-commit";
if (command === "pre-commit") {
  cmdPreCommit();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
