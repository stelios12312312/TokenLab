#!/usr/bin/env node
// semantic_maintenance.mjs -- scan and safely repair host-owned semantic drift.

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { applySafePersonaAdaptation } from "./lib/persona_adaptation.mjs";
import {
  attachSemanticHealth,
  installTelemetryHook,
  repairMutualExclusionSymmetry,
  scaffoldWorkflowAuditLog,
  writeSemanticBacklog,
} from "./lib/semantic_maintenance.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const migrateScript = join(scriptDir, "migrate.mjs");

function printUsage() {
  console.log(`semantic_maintenance.mjs -- fleet semantic maintenance

Usage:
  node semantic_maintenance.mjs scan <path> --json
  node semantic_maintenance.mjs scan --all --json
  node semantic_maintenance.mjs repair <path> --safe --json
  node semantic_maintenance.mjs repair-fleet --safe --json

Notes:
  scan is read-only.
  repair is additive/safe-only and writes plans/semantic_backlog/*.`);
}

function parseJsonOutput(stdout, commandLabel) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${commandLabel} did not emit valid JSON: ${error.message}`);
  }
}

function runMigrateJson(args, opts = {}) {
  const stdout = execFileSync(process.execPath, [migrateScript, ...args], {
    cwd: opts.cwd || resolve(join(scriptDir, "..", "..", "..", "..")),
    env: process.env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts.timeout || 60000,
  });
  return parseJsonOutput(stdout, `migrate ${args.join(" ")}`);
}

function summarizeProject(projectReport) {
  const report = attachSemanticHealth(projectReport);
  return {
    name: report.name,
    path: report.path,
    status: report.semantic_health.overall_status,
    planner_status: report.semantic_health.planner_status,
    semantic_status: report.semantic_health.semantic_status,
    observability_status: report.semantic_health.observability_status,
    host_history_status: report.semantic_health.host_history_status,
    detected_version: report.detected_version,
    current_version: report.current_version,
    semantic_health: report.semantic_health,
    recommended_command: `node .agent/skills/iterative-planner/scripts/semantic_maintenance.mjs repair ${JSON.stringify(report.path || ".")} --safe`,
  };
}

function scanProject(projectPath) {
  const report = runMigrateJson(["semantic-scan", projectPath, "--json"]);
  return summarizeProject(report);
}

function scanFleet() {
  const fleet = runMigrateJson(["verify-fleet", "--json"], { timeout: 180000 });
  const projects = (fleet.projects || []).map((project) => summarizeProject(project));
  const statuses = {};
  for (const project of projects) statuses[project.status] = (statuses[project.status] || 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    source: "semantic_maintenance",
    current_version: fleet.current_version,
    project_count: projects.length,
    statuses,
    projects,
  };
}

function runPersonaRepair(projectPath, issues) {
  const relevant = issues.filter((issue) => issue.repair_strategy === "persona_apply_safe");
  const result = {
    strategy: "persona_apply_safe",
    status: "not_needed",
    issue_ids: relevant.map((issue) => issue.id),
    result: null,
  };
  if (relevant.length === 0) return result;
  const applied = applySafePersonaAdaptation(projectPath, { commandTarget: projectPath });
  result.result = applied;
  result.status = applied.write_status === "written" ? "repaired" : applied.write_status;
  return result;
}

function repairProject(projectPath) {
  const beforeRaw = runMigrateJson(["semantic-scan", projectPath, "--json"]);
  const before = attachSemanticHealth(beforeRaw);
  const issues = before.semantic_health.issues || [];
  const repairResults = [
    runPersonaRepair(projectPath, issues),
    repairMutualExclusionSymmetry(projectPath, issues),
    scaffoldWorkflowAuditLog(projectPath, issues),
    installTelemetryHook(projectPath, issues),
  ];
  const afterRaw = runMigrateJson(["semantic-scan", projectPath, "--json"]);
  const after = attachSemanticHealth(afterRaw);
  const backlogWrite = writeSemanticBacklog(projectPath, after, repairResults);
  return {
    generated_at: new Date().toISOString(),
    path: projectPath,
    before: summarizeProject(beforeRaw),
    after: summarizeProject(afterRaw),
    repair_results: repairResults,
    backlog_files: backlogWrite.files_written,
  };
}

function repairFleet() {
  const fleet = scanFleet();
  const projects = [];
  for (const project of fleet.projects) {
    projects.push(repairProject(project.path));
  }
  const statuses = {};
  for (const project of projects) statuses[project.after.status] = (statuses[project.after.status] || 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    source: "semantic_maintenance",
    project_count: projects.length,
    statuses,
    projects,
  };
}

function emit(report, jsonOutput) {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.projects) {
    console.log(`Semantic maintenance: ${report.project_count} project(s)`);
    for (const project of report.projects) {
      const summary = project.after || project;
      console.log(`- ${summary.path}: ${summary.status}`);
    }
    return;
  }
  console.log(`${report.path}: ${report.after?.status || report.status}`);
}

const args = process.argv.slice(2);
const command = args[0];
const jsonOutput = args.includes("--json");
const safe = args.includes("--safe");
const all = args.includes("--all");
const positional = args.filter((arg) => !arg.startsWith("--"));

try {
  if (!command || args.includes("--help") || args.includes("help")) {
    printUsage();
    process.exit(0);
  }

  if (command === "scan" && all) {
    emit(scanFleet(), jsonOutput);
  } else if (command === "scan") {
    const target = positional[1] ? resolve(positional[1]) : null;
    if (!target || !existsSync(target)) throw new Error(`Target project path not found: ${target || "(missing)"}`);
    emit(scanProject(target), jsonOutput);
  } else if (command === "repair") {
    const target = positional[1] ? resolve(positional[1]) : null;
    if (!safe) throw new Error("repair requires --safe");
    if (!target || !existsSync(target)) throw new Error(`Target project path not found: ${target || "(missing)"}`);
    emit(repairProject(target), jsonOutput);
  } else if (command === "repair-fleet") {
    if (!safe) throw new Error("repair-fleet requires --safe");
    emit(repairFleet(), jsonOutput);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: "error", error: error.message }, null, 2));
  } else {
    console.error(`ERROR: ${error.message}`);
  }
  process.exit(1);
}
