#!/usr/bin/env node

import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

import { emitJson } from "./lib/emit_json.mjs";
import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { writeReflectionGuide } from "./lib/reflection_guide.mjs";

function usage() {
  return [
    "reflection_guide.mjs — generate a structured Phase 2.9 reflection guide",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/reflection_guide.mjs --plan <plan-dir> [--json]",
    "",
    "Behavior:",
    "  - Reads plan-local plan/progress/state/verification artifacts plus ontology and convention context",
    "  - Writes plans/<plan-id>/reflection_guide.yaml as JSON-compatible YAML",
    "  - Returns the generated path plus required-question metadata",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    cwd: process.cwd(),
    plan: null,
    json: false,
    help: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--plan":
        options.plan = args.shift() || null;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        return {
          ...options,
          invalid: token,
        };
    }
  }

  return options;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function renderHuman(result) {
  return [
    `Reflection guide generated for ${result.plan_id}`,
    `- path: ${result.path}`,
    `- required_question_count: ${result.required_question_count}`,
    `- sections: ${result.section_ids.join(", ")}`,
    result.warnings.length > 0 ? `- warnings: ${result.warnings.join("; ")}` : null,
  ].filter(Boolean).join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(usage());
    return 0;
  }
  if (cli.invalid) {
    console.error(`Unknown argument: ${cli.invalid}\n\n${usage()}`);
    return 2;
  }

  const { plansDir } = getPaths(cli.cwd);
  const target = resolvePlanTarget(plansDir, {
    plan: cli.plan || null,
    exitOnMissing: false,
  });
  if (!target.planDir || !target.planDirName) {
    const payload = {
      ok: false,
      error: "missing_plan",
      details: "Pass --plan <plan-dir> or set an active plan.",
    };
    emitJson(payload, { fd: 2, space: cli.json ? 0 : 2 });
    return 1;
  }

  const result = writeReflectionGuide({
    cwd: cli.cwd,
    planDir: target.planDir,
  });

  const payload = {
      ok: result.ok,
      plan_id: result.plan_id,
      path: result.path,
      wrote: result.wrote,
      required_question_count: result.required_question_count,
      section_ids: result.section_ids,
      warnings: result.warnings,
      issues: result.issues,
    };

  if (result.ok) {
    if (cli.json) emitJson(payload);
    else console.log(renderHuman(result));
    return 0;
  }

  if (cli.json) emitJson(payload, { fd: 2 });
  else console.error(renderHuman(result));
  return 1;
}

if (isDirectRun()) {
  process.exitCode = main();
}
