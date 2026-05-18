#!/usr/bin/env node
// persona_adapt.mjs - scan and safely adapt project persona seed roles.

import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import {
  applySafePersonaAdaptation,
  inferPersonaAdaptation,
  isProblematicPersonaStatus,
  scanAllPersonaAdaptation,
} from "./lib/persona_adaptation.mjs";

function usage() {
  return `Usage:
  node persona_adapt.mjs scan <path> --json
  node persona_adapt.mjs scan --all --json
  node persona_adapt.mjs apply <path> --safe --json

Commands:
  scan <path>        Read-only persona adaptation health for one project
  scan --all         Read-only fleet report from the planner project registry
  apply <path> --safe  Add only high-confidence missing seed roles

Options:
  --json             Emit machine-readable JSON
  --safe             Required for apply`;
}

function printHumanReport(report) {
  console.log("Persona Adaptation");
  console.log();
  console.log(`  Target: ${report.path || report.registry_path}`);
  console.log(`  Status: ${report.status}`);
  if (report.confidence) console.log(`  Confidence: ${report.confidence}`);
  if (report.domain_profiles) console.log(`  Domain profiles: ${report.domain_profiles.join(", ") || "none"}`);
  if (report.configured_roles) console.log(`  Configured roles: ${report.configured_roles.join(", ") || "none"}`);
  if (report.recommended_seed_roles) console.log(`  Recommended seeds: ${report.recommended_seed_roles.join(", ") || "none"}`);
  if (report.expected_companions) console.log(`  Expected companions: ${report.expected_companions.join(", ") || "none"}`);
  if (report.missing_seed_roles) console.log(`  Missing seeds: ${report.missing_seed_roles.join(", ") || "none"}`);
  if (report.usage) {
    console.log(`  Usage: serious=${report.usage.recent_serious_plans}, persona_artifacts=${report.usage.plans_with_persona_artifacts}, trivial_blockers=${report.usage.trivial_plans_with_persona_blockers}`);
  }
  if (report.write_status) console.log(`  Write status: ${report.write_status}`);
  if (report.added_roles?.length) console.log(`  Added roles: ${report.added_roles.join(", ")}`);
  if (isProblematicPersonaStatus(report.status)) console.log(`  Repair: ${report.recommended_command}`);
  console.log();
}

function printHumanFleet(report) {
  console.log("Persona Adaptation Fleet Scan");
  console.log();
  console.log(`  Registry: ${report.registry_path}`);
  console.log(`  Projects: ${report.project_count}`);
  for (const [status, count] of Object.entries(report.statuses || {}).sort()) {
    console.log(`  ${status}: ${count}`);
  }
  console.log();
  for (const project of report.projects || []) {
    const marker = isProblematicPersonaStatus(project.status) ? "!" : "-";
    console.log(`  ${marker} ${project.path} [${project.status}; ${project.confidence}]`);
    if (isProblematicPersonaStatus(project.status)) {
      console.log(`    ${project.recommended_command}`);
    }
  }
  console.log();
}

function main(argv) {
  const [command, ...rest] = argv;
  const jsonMode = rest.includes("--json");

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }

  if (command === "scan") {
    if (rest.includes("--all")) {
      const report = scanAllPersonaAdaptation();
      if (jsonMode) console.log(JSON.stringify(report, null, 2));
      else printHumanFleet(report);
      return 0;
    }
    const pathArg = rest.find((arg) => !arg.startsWith("--")) || ".";
    const report = inferPersonaAdaptation(pathArg);
    if (jsonMode) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
    return 0;
  }

  if (command === "apply") {
    if (!rest.includes("--safe")) {
      console.error("ERROR: apply requires --safe");
      console.error(usage());
      return 2;
    }
    const pathArg = rest.find((arg) => !arg.startsWith("--")) || ".";
    const report = applySafePersonaAdaptation(pathArg);
    if (jsonMode) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
    return report.write_status === "blocked_invalid_config" ? 1 : 0;
  }

  console.error(`ERROR: unknown command '${command}'`);
  console.error(usage());
  return 2;
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}

