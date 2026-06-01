#!/usr/bin/env node
// verification_strategy.mjs — Non-mutating diagnostics for canonical verification_strategy.yaml files.
//
// Usage:
//   node verification_strategy.mjs lint --plan <plan-dir> [--json]

import { existsSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { getPaths, normalizePlanDirName } from "./lib/plan_utils.mjs";
import { lintVerificationStrategy } from "./lib/verification_strategy.mjs";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    plan: null,
    json: false,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--plan") {
      args.plan = argv[index + 1] || null;
      index += 1;
    }
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/verification_strategy.mjs lint --plan <plan-dir> [--json]",
  ].join("\n");
}

function renderHuman(result) {
  const lines = [];
  lines.push(`Verification strategy lint: ${result.ok ? "PASS" : "FAIL"}`);
  lines.push(`Path: ${result.path}`);
  lines.push(`Source: ${result.source || "unknown"}`);
  lines.push(`Strategy present: ${result.strategy_present ? "yes" : "no"}`);
  lines.push("Criterion matches:");
  for (const match of result.criterion_matches || []) {
    lines.push(`- ${match.success_criterion_id}: ${match.matched ? `${match.strategy_criterion_id} (${match.story_id || "no story"})` : "missing"}`);
  }
  if ((result.warnings || []).length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  if ((result.issues || []).length > 0) {
    lines.push("Issues:");
    for (const issue of result.issues) lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}

function resolvePlanArg(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  const normalizedPlanDirName = normalizePlanDirName(planArg, plansDir);
  if (normalizedPlanDirName) {
    const candidate = join(plansDir, normalizedPlanDirName);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(cwd, planArg || "");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command !== "lint" || !args.plan) {
    console.error(usage());
    process.exit(2);
  }

  const result = lintVerificationStrategy({
    cwd: process.cwd(),
    planDir: resolvePlanArg(process.cwd(), args.plan),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderHuman(result));
  }
  process.exit(result.ok ? 0 : 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main();
}
