#!/usr/bin/env node
// Complexity Budget — tracks and enforces complexity limits during execution.
//
// Usage:
//   node complexity_budget.mjs check              Check current complexity against budget
//   node complexity_budget.mjs record <metric> <n> Record a complexity increment
//   node complexity_budget.mjs snapshot            Capture current state from git diff
//   node complexity_budget.mjs reset               Reset budget (new plan)
//   node complexity_budget.mjs status              Show current status
//
// Metrics: files_added, files_modified, abstractions_added, net_lines, new_dependencies
//
// Reads/writes to plans/<active>/complexity.json.
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, getActivePlan, debugLog } from "./lib/plan_utils.mjs";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Budget limits (can be overridden via complexity.config.json in project root)
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = {
  files_added: 10,
  files_modified: 20,
  abstractions_added: 5,
  net_lines: 500,
  new_dependencies: 3,
};

const VALID_METRICS = Object.keys(DEFAULT_BUDGET);

function loadBudget() {
  const configPath = join(process.cwd(), "complexity.config.json");
  try {
    const custom = JSON.parse(readFileSync(configPath, "utf-8"));
    return { ...DEFAULT_BUDGET, ...custom };
  } catch {
    return { ...DEFAULT_BUDGET };
  }
}

// ---------------------------------------------------------------------------
// Complexity state management
// ---------------------------------------------------------------------------

function complexityPath(planDir) {
  return join(planDir, "complexity.json");
}

function readComplexity(planDir) {
  const p = complexityPath(planDir);
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    const initial = {};
    for (const m of VALID_METRICS) initial[m] = 0;
    return { metrics: initial, created: new Date().toISOString(), snapshots: [] };
  }
}

function writeComplexity(planDir, state) {
  state.updated = new Date().toISOString();
  const p = complexityPath(planDir);
  writeFileSync(p, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Git-based snapshot
// ---------------------------------------------------------------------------

function captureFromGit() {
  const metrics = { files_added: 0, files_modified: 0, net_lines: 0, abstractions_added: 0, new_dependencies: 0 };

  // Get diff stats
  const diffStat = spawnSync("git", ["diff", "--stat", "--cached"], { encoding: "utf-8", cwd: process.cwd() });
  const diffAll = spawnSync("git", ["diff", "--stat"], { encoding: "utf-8", cwd: process.cwd() });

  // Count new/modified files
  const statusResult = spawnSync("git", ["status", "--porcelain"], { encoding: "utf-8", cwd: process.cwd() });
  if (statusResult.stdout) {
    for (const line of statusResult.stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const code = line.substring(0, 2).trim();
      if (code === "A" || code === "??") metrics.files_added++;
      else if (code === "M" || code === "MM") metrics.files_modified++;
    }
  }

  // Count net lines (added - deleted)
  const numstat = spawnSync("git", ["diff", "--numstat"], { encoding: "utf-8", cwd: process.cwd() });
  if (numstat.stdout) {
    for (const line of numstat.stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const added = parseInt(parts[0], 10) || 0;
      const deleted = parseInt(parts[1], 10) || 0;
      metrics.net_lines += added - deleted;
    }
  }

  // Heuristic: count new class/function definitions as abstractions
  const diffContent = spawnSync("git", ["diff"], { encoding: "utf-8", cwd: process.cwd() });
  if (diffContent.stdout) {
    const newAbstractions = (diffContent.stdout.match(/^\+.*(class |function |const \w+ = \(|export (default )?function|export (default )?class)/gm) || []).length;
    metrics.abstractions_added = newAbstractions;
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function check(planDir) {
  const state = readComplexity(planDir);
  const budget = loadBudget();
  const results = [];
  let exitCode = 0;

  for (const metric of VALID_METRICS) {
    const current = state.metrics[metric] || 0;
    const limit = budget[metric];
    const pct = Math.round((current / limit) * 100);

    if (current > limit) {
      results.push({ level: "FAIL", message: `${metric}: ${current}/${limit} (${pct}%) — OVER BUDGET` });
      exitCode = 1;
    } else if (pct >= 80) {
      results.push({ level: "WARN", message: `${metric}: ${current}/${limit} (${pct}%) — approaching limit` });
    } else {
      results.push({ level: "PASS", message: `${metric}: ${current}/${limit} (${pct}%)` });
    }
  }

  console.log("=== Complexity Budget Check ===");
  for (const r of results) {
    const icon = r.level === "FAIL" ? "FAIL" : r.level === "WARN" ? "WARN" : "PASS";
    console.log(`  [${icon}] ${r.message}`);
  }

  if (exitCode === 1) {
    console.log("\nResult: FAIL — complexity budget exceeded. Consider:");
    console.log("  - Splitting into multiple plans");
    console.log("  - Removing unnecessary abstractions");
    console.log("  - Using the 10-line rule: if a fix needs >10 lines, REFLECT first");
  } else {
    console.log(`\nResult: PASS`);
  }

  return exitCode;
}

function record(planDir, metric, n) {
  if (!VALID_METRICS.includes(metric)) {
    console.error(`ERROR: Invalid metric '${metric}'. Valid: ${VALID_METRICS.join(", ")}`);
    process.exit(1);
  }
  const value = parseInt(n, 10);
  if (isNaN(value)) {
    console.error("ERROR: Value must be a number.");
    process.exit(1);
  }
  const state = readComplexity(planDir);
  if (!state.metrics) state.metrics = {};
  state.metrics[metric] = (state.metrics[metric] || 0) + value;
  writeComplexity(planDir, state);

  const budget = loadBudget();
  const current = state.metrics[metric];
  const limit = budget[metric];
  console.log(`${metric}: ${current}/${limit} (+${value})`);
  if (current > limit) {
    console.log(`  WARNING: Over budget!`);
  }
}

function snapshot(planDir) {
  const gitMetrics = captureFromGit();
  const state = readComplexity(planDir);
  state.metrics = gitMetrics;
  state.snapshots = state.snapshots || [];
  state.snapshots.push({ timestamp: new Date().toISOString(), ...gitMetrics });

  // Cap snapshots at 20
  if (state.snapshots.length > 20) {
    state.snapshots = state.snapshots.slice(-20);
  }

  writeComplexity(planDir, state);

  console.log("=== Complexity Snapshot (from git) ===");
  for (const [k, v] of Object.entries(gitMetrics)) {
    console.log(`  ${k}: ${v}`);
  }
}

function reset(planDir) {
  const initial = {};
  for (const m of VALID_METRICS) initial[m] = 0;
  writeComplexity(planDir, { metrics: initial, created: new Date().toISOString(), snapshots: [] });
  console.log("Complexity budget counters reset.");
}

function showStatus(planDir) {
  const state = readComplexity(planDir);
  const budget = loadBudget();
  console.log("=== Complexity Budget Status ===");
  console.log("\nCurrent:");
  console.log(JSON.stringify(state.metrics, null, 2));
  console.log("\nBudget limits:");
  console.log(JSON.stringify(budget, null, 2));
  if (state.snapshots && state.snapshots.length > 0) {
    console.log(`\nSnapshots: ${state.snapshots.length} recorded`);
    console.log(`Latest: ${state.snapshots[state.snapshots.length - 1].timestamp}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { plansDir } = getPaths();
const { planDir } = getActivePlan(plansDir, { exitOnMissing: false });

const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

if (!cmd || cmd === "check") {
  if (!planDir) {
    console.log("No active plan — complexity budget not applicable.");
    process.exit(0);
  }
  process.exit(check(planDir));
} else if (cmd === "record") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  record(planDir, arg1, arg2);
} else if (cmd === "snapshot") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  snapshot(planDir);
} else if (cmd === "reset") {
  if (!planDir) { console.error("ERROR: No active plan."); process.exit(1); }
  reset(planDir);
} else if (cmd === "status") {
  if (!planDir) {
    console.log("No active plan.");
    process.exit(0);
  }
  showStatus(planDir);
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error("Usage: complexity_budget.mjs [check|record <metric> <n>|snapshot|reset|status]");
  process.exit(1);
}
