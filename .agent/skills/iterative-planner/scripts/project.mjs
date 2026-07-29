#!/usr/bin/env node

import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { resolve } from "path";

import {
  analyzeClaudeMerge,
  diagnoseProject,
  formatProjectLifecycleText,
  generateProjectPlan,
  initializeProject,
  parseFlagValue,
  resolvePlanLifecycle,
} from "./lib/project_lifecycle.mjs";

const __filename = fileURLToPath(import.meta.url);

function isMain(entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(__filename);
  } catch {
    return resolve(entry) === __filename;
  }
}

function usage() {
  return [
    "project.mjs — Project lifecycle tooling",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/project.mjs init [--json] [--flavor <minimal|standard|full>] [--agents-enabled a,b,c] [--orchestrator <none|advisory>]",
    "  node .agent/skills/iterative-planner/scripts/project.mjs diagnose [--json]",
    "  node .agent/skills/iterative-planner/scripts/project.mjs plan [--json]",
    "  node .agent/skills/iterative-planner/scripts/project.mjs resolve [--list] [plan_id] [--convert-to-v7|--complete-on-v6|--abandon] [--json]",
    "  node .agent/skills/iterative-planner/scripts/project.mjs merge-claude-md [path] [--json]",
  ].join("\n");
}

function serializeJsonCompatibleYaml(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const subcommand = args[0] || "diagnose";
  const json = args.includes("--json");

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usage());
    return 0;
  }

  if (subcommand === "init") {
    const result = initializeProject(process.cwd(), {
      flavor: parseFlagValue(args, "--flavor") || "standard",
      agentsEnabled: parseFlagValue(args, "--agents-enabled"),
      orchestrator: parseFlagValue(args, "--orchestrator"),
    });
    if (json) console.log(serializeJsonCompatibleYaml(result).trimEnd());
    else console.log(formatProjectLifecycleText(result));
    return result.ok === false ? 1 : 0;
  }

  if (subcommand === "diagnose") {
    const result = diagnoseProject(process.cwd());
    if (json) console.log(serializeJsonCompatibleYaml(result.diagnosis).trimEnd());
    else console.log(formatProjectLifecycleText(result));
    return result.exit_code;
  }

  if (subcommand === "plan") {
    const result = generateProjectPlan(process.cwd());
    if (json) console.log(serializeJsonCompatibleYaml(result).trimEnd());
    else console.log(formatProjectLifecycleText(result));
    return 0;
  }

  if (subcommand === "resolve") {
    const planId = args.find((arg, index) => index > 0 && !arg.startsWith("--")) || null;
    const option = args.includes("--convert-to-v7") ? "convert-to-v7"
      : args.includes("--complete-on-v6") ? "complete-on-v6"
        : args.includes("--abandon") ? "abandon"
          : null;
    const result = resolvePlanLifecycle(process.cwd(), {
      list: args.includes("--list"),
      planId,
      option,
    });
    if (json) console.log(serializeJsonCompatibleYaml(result).trimEnd());
    else console.log(formatProjectLifecycleText(result));
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Project command result is synthesized from operation errors for CLI exit routing.
    return result.status === "FAIL" ? 1 : 0;
  }

  if (subcommand === "merge-claude-md") {
    const target = args.find((arg, index) => index > 0 && !arg.startsWith("--")) || process.cwd();
    const result = analyzeClaudeMerge(target);
    if (json) console.log(serializeJsonCompatibleYaml(result).trimEnd());
    else console.log(formatProjectLifecycleText(result));
    return 0;
  }

  console.error(`Unknown project subcommand: ${subcommand}`);
  console.error(usage());
  return 2;
}

if (isMain()) {
  process.exitCode = main(process.argv);
}
