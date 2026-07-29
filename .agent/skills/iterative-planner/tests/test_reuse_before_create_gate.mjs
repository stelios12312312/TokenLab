#!/usr/bin/env node
// test_reuse_before_create_gate.mjs — E6-8 reuse-before-create gate proof.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  evaluateReuseBeforeCreateGate,
  extractProposedCreations,
} from "../scripts/lib/reuse_before_create_gate.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const cliPath = join(skillDir, "scripts", "reuse_before_create.mjs");
const fixtureFleetDir = join(testDir, "fixtures", "recipe_fleet");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` - ${details}` : ""}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRecipeProject(root) {
  writeJson(join(root, "recipes", "entity_registry.json"), {
    version: 1,
    entities: [{ id: "portfolio", title: "Portfolio" }],
  });
  writeJson(join(root, "recipes", "capability_registry.json"), {
    version: 1,
    capabilities: [{
      id: "daily_runner",
      title: "Daily Runner",
      description: "Runs deterministic daily portfolio workflow jobs.",
      scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    }],
  });
  writeJson(join(root, "recipes", "daily-runner", "recipe.json"), {
    id: "daily-runner",
    title: "Daily Runner",
    capability_id: "daily_runner",
    entity_ids: ["portfolio"],
    required_params: ["portfolio_id"],
    scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    runner: {
      type: "command",
      command: ["node", "scripts/daily_runner.mjs"],
      cwd: ".",
      defaults: {},
      dry_run_flags: ["--dry-run"],
      live_flags: [],
    },
  });
}

function planWithFiles(files) {
  return `# Plan

## Problem Statement
Reuse-before-create should inspect proposed script creation before implementation.

## Files To Modify
${files.map((file) => `- ${file}`).join("\n")}

## Steps
1. Check reuse-before-create declarations.
`;
}

function makeTempProject(name = "reuse-before-create") {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function runCli(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, [cliPath, ...args], {
        cwd,
        encoding: "utf-8",
        env: plannerSubprocessEnv(),
        maxBuffer: 10 * 1024 * 1024,
      }),
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function snapshotFixtureFiles(root) {
  const files = [
    join(root, "alpha_project", "recipes", "daily-runner", "recipe.json"),
    join(root, "beta_project", "recipes", "daily-runner", "recipe.json"),
  ];
  return new Map(files.map((file) => [file, {
    content: readFileSync(file, "utf-8"),
    mtimeMs: statSync(file).mtimeMs,
  }]));
}

function assertSnapshotUnchanged(snapshot, label) {
  const changed = [...snapshot.entries()].some(([file, entry]) => {
    if (!existsSync(file)) return true;
    return readFileSync(file, "utf-8") !== entry.content || statSync(file).mtimeMs !== entry.mtimeMs;
  });
  assert(!changed, label);
}

function runFocusedEvaluatorProof() {
  const tmp = makeTempProject();
  try {
    writeRecipeProject(tmp);

    const duplicateCapability = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["scripts/new_daily_runner.mjs"]),
      workOrder: {
        proposed_creations: [{
          capability_id: "daily_runner",
          path: "scripts/new_daily_runner.mjs",
          purpose: "Run the daily portfolio workflow",
        }],
      },
    });
    assert(duplicateCapability.status === "FAIL", "duplicate capability id blocks");
    assert(duplicateCapability.issues.some((issue) => issue.code === "duplicate_capability_id"), "duplicate capability issue is coded");

    const duplicateCommand = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["scripts/portfolio_daily.mjs"]),
      workOrder: {
        scripts_to_create: [{
          path: "scripts/portfolio_daily.mjs",
          command: ["node", "scripts/daily_runner.mjs"],
          purpose: "Run daily portfolio workflow",
        }],
      },
    });
    assert(duplicateCommand.status === "FAIL", "duplicate runner command blocks");
    assert(duplicateCommand.issues.some((issue) => issue.code === "duplicate_runner_command"), "duplicate runner command issue is coded");

    const duplicatePath = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["jobs/daily_runner.mjs"]),
      workOrder: { new_scripts: [{ path: "jobs/daily_runner.mjs", purpose: "Run daily portfolio workflow" }] },
    });
    assert(duplicatePath.status === "FAIL", "duplicate script basename blocks");
    assert(duplicatePath.issues.some((issue) => issue.code === "duplicate_script_name"), "duplicate script name issue is coded");

    const nearMatch = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["scripts/daily_report.mjs"]),
      workOrder: {
        proposed_creations: [{
          capability_id: "daily_report",
          path: "scripts/daily_report.mjs",
          purpose: "Prepare a daily portfolio workflow report",
        }],
      },
    });
    assert(nearMatch.status === "WARN", "near match warns instead of blocking");
    assert(nearMatch.issues.some((issue) => issue.code === "near_capability_match"), "near match issue is coded");

    const novel = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["scripts/monthly_reconciliation.mjs"]),
      workOrder: {
        proposed_creations: [{
          capability_id: "monthly_reconciliation",
          path: "scripts/monthly_reconciliation.mjs",
          purpose: "Reconcile monthly treasury exports",
        }],
      },
    });
    assert(novel.status === "PASS", "novel script creation passes");

    const noDeclarations = evaluateReuseBeforeCreateGate({
      cwd: tmp,
      planContent: planWithFiles(["README.md"]),
      workOrder: {},
    });
    assert(noDeclarations.status === "PASS", "no script declaration passes");
    assert(extractProposedCreations({ cwd: tmp, planContent: planWithFiles(["README.md"]) }).length === 0, "non-script file is not a proposed creation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runFleetConfigAndCliProof() {
  const tmp = makeTempProject("reuse-before-create-cli");
  try {
    const configPath = join(tmp, "fleet.yaml");
    writeFileSync(configPath, `projects:
  - name: alpha_project
    path: ${JSON.stringify(join(fixtureFleetDir, "alpha_project"))}
  - name: beta_project
    path: ${JSON.stringify(join(fixtureFleetDir, "beta_project"))}
`);
    const planDir = join(tmp, "plans", "plan_cli");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.md"), planWithFiles(["scripts/new_daily_runner.mjs"]));
    writeJson(join(planDir, "work_order.json"), {
      id: "wo_duplicate_daily_runner",
      proposed_creations: [{
        capability_id: "daily_runner",
        path: "scripts/new_daily_runner.mjs",
        purpose: "Run daily portfolio workflow",
      }],
    });

    const before = snapshotFixtureFiles(fixtureFleetDir);
    const result = runCli(["--plan", planDir, "--config", configPath, "--json"], repoRoot);
    assert(!result.ok && result.status === 1, "CLI exits non-zero for duplicate proposal");
    const payload = parseJson(result.stdout);
    assert(payload?.status === "FAIL", "CLI emits FAIL JSON for duplicate proposal");
    assert(payload?.inventory_summary?.fleet_entry_count > 0, "CLI inventory includes configured fleet entries");
    assert(payload?.issues?.some((issue) => issue.candidate?.project === "alpha_project"), "CLI reports fleet candidate project");
    assertSnapshotUnchanged(before, "CLI leaves fleet fixtures unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nReuse Before Create Gate Tests\n");
runFocusedEvaluatorProof();
runFleetConfigAndCliProof();

console.log(`\nReuse before create gate tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
