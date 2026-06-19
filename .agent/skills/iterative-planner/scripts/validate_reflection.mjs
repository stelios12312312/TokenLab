#!/usr/bin/env node

import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

import { emitJson } from "./lib/emit_json.mjs";
import { validateReflection } from "./lib/reflection_validation.mjs";

function usage() {
  return [
    "validate_reflection.mjs — validate a structured Phase 2.9 reflection artifact",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/validate_reflection.mjs <path> [--json]",
    "",
    "Behavior:",
    "  - Reads reflection.md frontmatter plus the referenced reflection_guide.yaml",
    "  - Verifies required sections and non-vacuous answers for required guide questions",
    "  - Returns deterministic question and section validation metadata",
  ].join("\n");
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    cwd: process.cwd(),
    filePath: null,
    json: false,
    help: false,
    invalid: null,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token.startsWith("-")) {
      options.invalid = token;
      return options;
    }
    if (!options.filePath) {
      options.filePath = token;
      continue;
    }
    options.invalid = token;
    return options;
  }

  return options;
}

function renderHuman(result) {
  const lines = [
    `Reflection validation for ${result.relative_path || result.path}`,
    `- plan_id: ${result.plan_id || "unknown"}`,
    `- guide_path: ${result.guide_path || "missing"}`,
    `- required questions: ${result.answered_question_count}/${result.required_question_count}`,
    `- template detected: ${result.template_detected ? "yes" : "no"}`,
  ];

  if (result.issues.length > 0) {
    lines.push("- issues:");
    for (const issue of result.issues) {
      lines.push(`  - ${issue}`);
    }
  } else {
    lines.push("- issues: none");
  }

  return lines.join("\n");
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
  if (!cli.filePath) {
    console.error(usage());
    return 2;
  }

  const result = validateReflection({
    cwd: cli.cwd,
    filePath: cli.filePath,
  });

  if (result.ok) {
    if (cli.json) emitJson(result);
    else console.log(renderHuman(result));
    return 0;
  }

  if (cli.json) emitJson(result, { fd: 2 });
  else console.error(renderHuman(result));
  return 1;
}

if (isDirectRun()) {
  process.exitCode = main();
}
