#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join, resolve } from "path";

import {
  parseRawTestOutput,
  writeStructuredTestRunDocument,
} from "./lib/evidence_verifier.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = cliArgs.indexOf(flag);
  return index !== -1 && cliArgs[index + 1] ? cliArgs[index + 1] : null;
}

function splitCommandArgs(rawArgs) {
  const separatorIndex = rawArgs.indexOf("--");
  if (separatorIndex === -1) {
    return {
      cliArgs: rawArgs,
      commandArgs: [],
    };
  }
  return {
    cliArgs: rawArgs.slice(0, separatorIndex),
    commandArgs: rawArgs.slice(separatorIndex + 1),
  };
}

function inferFramework({ explicitFramework, commandArgs = [], inputPath = "" }) {
  const explicit = String(explicitFramework || "").trim();
  if (explicit) return explicit;

  const firstToken = String(commandArgs[0] || "").toLowerCase();
  const joined = commandArgs.map((token) => String(token || "").toLowerCase()).join(" ");
  if (firstToken.includes("pytest") || joined.includes(" pytest ")) return "pytest";
  if (firstToken.includes("jest") || joined.includes(" jest ")) return "jest";
  if (firstToken.includes("mocha") || joined.includes(" mocha ")) return "mocha";
  if (firstToken.includes("node") || joined.includes(".mjs") || joined.includes(".js")) return "node";

  const normalizedInput = String(inputPath || "").toLowerCase();
  if (normalizedInput.endsWith(".xml")) return "pytest";
  if (normalizedInput.endsWith(".txt") || normalizedInput.endsWith(".log")) return "unknown";
  return "unknown";
}

function printHelp() {
  console.log(`test_run_record.mjs — capture deterministic structured test-run proof

Usage:
  node test_run_record.mjs --plan <plan-dir> --framework pytest --input reports/raw/pytest.log --json
  node test_run_record.mjs --plan <plan-dir> --framework node -- node tests/example.mjs

Behavior:
  - Writes reports/test_runs/<plan_id>_<timestamp>.yaml
  - Refreshes reports/test_runs/<plan_id>_latest.yaml
  - Captures raw output plus parsed tests for common frameworks
  - Returns the child command exit code when executing a command
`);
}

if (flags.help) {
  printHelp();
  process.exit(0);
}

const { cliArgs, commandArgs } = splitCommandArgs(args);
const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const planArg = readFlagValue("--plan");
const frameworkFlag = readFlagValue("--framework");
const inputPath = readFlagValue("--input");
const outputPath = readFlagValue("--output");
const generatedAt = readFlagValue("--generated-at") || new Date().toISOString();
const { plansDir } = getPaths(cwd);
const target = resolvePlanTarget(plansDir, {
  plan: planArg || null,
  exitOnMissing: false,
});

if (!target.planDirName) {
  console.error("ERROR: No plan directory specified and no active plan. Pass --plan <plan-dir> or set plans/.current_plan.");
  process.exit(1);
}

if (!inputPath && commandArgs.length === 0) {
  console.error("ERROR: Provide either --input <raw-output-file> or a command after '--'.");
  process.exit(1);
}

let rawOutput = "";
let command = "";
let childStatus = 0;

if (inputPath) {
  const resolvedInputPath = resolve(cwd, inputPath);
  if (!existsSync(resolvedInputPath)) {
    console.error(`ERROR: Input file does not exist: ${inputPath}`);
    process.exit(1);
  }
  rawOutput = readFileSync(resolvedInputPath, "utf-8");
  command = readFlagValue("--command") || `cat ${inputPath}`;
}

if (commandArgs.length > 0) {
  const child = spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  rawOutput = `${child.stdout || ""}${child.stderr || ""}`.trimEnd();
  command = commandArgs.join(" ");
  childStatus = typeof child.status === "number" ? child.status : 1;
}

const framework = inferFramework({
  explicitFramework: frameworkFlag,
  commandArgs,
  inputPath,
});
const tests = parseRawTestOutput({
  framework,
  rawOutput,
});
const result = writeStructuredTestRunDocument({
  projectRoot: cwd,
  planId: target.planDirName,
  framework,
  command,
  tests,
  generatedAt,
  outputPath,
  rawOutput,
});

const payload = {
  ok: true,
  plan_id: target.planDirName,
  framework,
  command,
  parsed_test_count: tests.length,
  path: result.path,
  latest_path: result.latest_path,
  child_status: childStatus,
};

if (flags.json) {
  emitJson(payload, { exitCode: childStatus });
} else {
  console.log(`Recorded structured test run for ${target.planDirName}`);
  console.log(`  Framework: ${framework}`);
  console.log(`  Parsed tests: ${tests.length}`);
  console.log(`  Path: ${result.path}`);
  console.log(`  Latest: ${result.latest_path}`);
  process.exitCode = childStatus;
}
