#!/usr/bin/env node
// pre_commit_policy.mjs — scoped commit blocking for planner hook enforcement.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

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
  });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = null;
  }

  return { result, parsed };
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

function summarizeGap(gap) {
  return `${gap.gate}: ${gap.file} — ${gap.issue}`;
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
    process.exit(0);
  }

  const impactedPaths = [...new Set(hardGaps.flatMap((gap) => gap.impacted_paths).filter(Boolean))];
  if (impactedPaths.length === 0) {
    console.error("  ❌ pre-commit: hard ripple gaps found but impacted surfaces could not be mapped safely");
    for (const gap of hardGaps.slice(0, 10)) {
      console.error(`  - ${summarizeGap(gap)}`);
    }
    process.exit(1);
  }

  const stagedSet = new Set(staged.files.map(normalizePath));
  const overlapping = impactedPaths.filter((path) => stagedSet.has(normalizePath(path)));
  if (overlapping.length > 0) {
    console.error("  ❌ pre-commit: hard ripple gaps overlap the staged planner surfaces");
    console.error("  Fix the gaps listed below before committing.");
    for (const gap of hardGaps.slice(0, 10)) {
      console.error(`  - ${summarizeGap(gap)}`);
    }
    console.error("  Overlapping staged files:");
    for (const file of overlapping) {
      console.error(`  - ${file}`);
    }
    console.error("  To bypass (NOT recommended): git commit --no-verify");
    process.exit(1);
  }

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
  console.log("  Staged planner files do not overlap the failing contract surfaces, so the commit may proceed.");
  console.log(`  Advisory id: ${advisoryId}`);
  console.log("  Follow up:");
  for (const command of FOLLOW_UP_COMMANDS) {
    console.log(`  - ${command}`);
  }
  process.exit(0);
}

const command = process.argv[2] || "pre-commit";
if (command === "pre-commit") {
  cmdPreCommit();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
