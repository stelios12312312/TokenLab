#!/usr/bin/env node
// planner.mjs — Small stable dispatcher for common iterative-planner entrypoints.

import { existsSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);

const ROUTES = new Map([
  ["new", "bootstrap.mjs"],
  ["resume", "bootstrap.mjs"],
  ["status", "bootstrap.mjs"],
  ["list", "bootstrap.mjs"],
  ["close", "bootstrap.mjs"],
  ["abandon", "bootstrap.mjs"],
  ["recover-poison", "bootstrap.mjs"],
  ["fix-stuck", "bootstrap.mjs"],
  ["install-health", "bootstrap.mjs"],
  ["story-review", "bootstrap.mjs"],
  ["run", "autonomous_driver.mjs"],
  ["doctor", "project_health.mjs"],
  ["health", "project_health.mjs"],
  ["preflight", "planner_preflight.mjs"],
  ["verify-fleet", "migrate.mjs"],
  ["fleet-doctor", "migrate.mjs"],
  ["migration-wave", "migrate.mjs"],
  ["migrate", "migrate.mjs"],
  ["hygiene", "planner_hygiene.mjs"],
  ["findings", "planner_findings.mjs"],
  ["knowledge", "knowledge_resolver.mjs"],
  ["work-preflight", "work_preflight.mjs"],
  ["ritual-lint", "ritual_lint.mjs"],
]);

function printUsage() {
  console.log(`planner.mjs — iterative planner dispatcher

Usage:
  node .agent/skills/iterative-planner/scripts/planner.mjs status
  node .agent/skills/iterative-planner/scripts/planner.mjs new "<goal>"
  node .agent/skills/iterative-planner/scripts/planner.mjs resume
  node .agent/skills/iterative-planner/scripts/planner.mjs run --until close [--plan <plan-dir>] [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs migration-wave <create|verify> [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs verify-fleet [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs fleet doctor [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs gate <gate-name> [--plan <plan-dir>]
  node .agent/skills/iterative-planner/scripts/planner.mjs work-preflight --goal "<task>" [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs advise [--goal "<task>"] [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs batch <start|add|status|close> [...]
  node .agent/skills/iterative-planner/scripts/planner.mjs ritual-lint --workflow </workflow> --phase <phase> [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs reflection-guide --plan <plan-dir> [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs validate-reflection <path> [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs install-hook [--uninstall]
  node .agent/skills/iterative-planner/scripts/planner.mjs ontology build [--induce] [--incremental] [--dry-run] [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs ontology query "<prolog>" [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs ontology facts --entity <type> [--domain <domain>] [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs ontology validate [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs recipe <bootstrap|validate|runner|resolver|discovery> [...]
  node .agent/skills/iterative-planner/scripts/planner.mjs conventions <list|check|promote|demote> [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs context --task "<task>" [--dir <path>] [--json]
  node .agent/skills/iterative-planner/scripts/planner.mjs verify-stories [--plan <plan-id>|--plan-from-head|--since <date>|--all|--staged|--check-report <path>] [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]
  node .agent/skills/iterative-planner/scripts/planner.mjs sidekick commit-message
`);
}

function runScript(scriptName, args) {
  const scriptPath = join(scriptDir, scriptName);
  if (!existsSync(scriptPath)) {
    console.error(`planner.mjs cannot route to missing script: ${scriptName}`);
    process.exit(1);
  }
  const child = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) {
    console.error(`planner.mjs failed to launch ${scriptName}: ${child.error.message}`);
    process.exit(1);
  }
  if (child.signal) {
    console.error(`planner.mjs routed script ${scriptName} terminated by signal ${child.signal}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

if (command === "fleet" && args[1] === "doctor") {
  runScript("migrate.mjs", ["fleet-doctor", ...args.slice(2)]);
}

if (command === "gate") {
  runScript("transition.mjs", args.slice(1));
}

if (command === "verify-stories") {
  runScript("verify_stories.mjs", args.slice(1));
}

if (command === "install-hook") {
  runScript(join("hooks", "install.mjs"), args.slice(1));
}

if (command === "advise") {
  runScript("advise.mjs", args.slice(1));
}

if (command === "batch") {
  runScript("batch.mjs", args.slice(1));
}

if (command === "reflection-guide") {
  runScript("reflection_guide.mjs", args.slice(1));
}

if (command === "validate-reflection") {
  runScript("validate_reflection.mjs", args.slice(1));
}

// Sub-tool aliases: forward the remaining args (drop the dispatcher command word)
// to the tool, which reads its own subcommand from argv[0].
if (command === "sidekick") {
  runScript("sidekick.mjs", args.slice(1));
}

if (command === "conventions") {
  runScript("conventions.mjs", args.slice(1));
}

if (command === "context") {
  runScript("ontology_context.mjs", args.slice(1));
}

if (command === "ontology") {
  runScript("ontology_cli.mjs", args.slice(1));
}

if (command === "recipe") {
  const recipeCommand = args[1];
  const recipeRoutes = new Map([
    ["bootstrap", "recipe_bootstrap.mjs"],
    ["validate", "recipe_validate.mjs"],
    ["runner", "recipe_runner.mjs"],
    ["run", "recipe_runner.mjs"],
    ["resolver", "recipe_resolver.mjs"],
    ["resolve", "recipe_resolver.mjs"],
    ["discovery", "recipe_discovery.mjs"],
    ["discover", "recipe_discovery.mjs"],
  ]);
  if (recipeRoutes.has(recipeCommand)) {
    runScript(recipeRoutes.get(recipeCommand), args.slice(2));
  }
  console.error(`ERROR: Unknown planner recipe command "${recipeCommand || ""}".`);
  printUsage();
  process.exit(1);
}

if (ROUTES.has(command)) {
  runScript(ROUTES.get(command), args);
}

console.error(`ERROR: Unknown planner command "${command}".`);
printUsage();
process.exit(1);
