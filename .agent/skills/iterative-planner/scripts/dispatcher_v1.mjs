#!/usr/bin/env node
// dispatcher_v1.mjs - CLI for E6-5 dispatcher v1 proof.

import {
  DEFAULT_DISPATCHER_EPISODE_ID,
  runDispatcherV1,
  writeDispatcherArtifacts,
} from "./lib/dispatcher_v1.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgsValue(argv, index, arg, name) {
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), index };
  if (argv[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: argv[index + 1], index: index + 1 };
}

export function parseDispatcherV1Args(argv = []) {
  const parsed = {
    json: false,
    write: false,
    help: false,
    episodeId: DEFAULT_DISPATCHER_EPISODE_ID,
    runId: null,
    outDir: null,
    corpusPath: null,
    now: null,
    monolithicFallback: false,
    goalText: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--monolithic-fallback") {
      parsed.monolithicFallback = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--episode" || arg.startsWith("--episode=")) {
      const value = parseArgsValue(argv, index, arg, "--episode");
      parsed.episodeId = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = parseArgsValue(argv, index, arg, "--run-id");
      parsed.runId = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const value = parseArgsValue(argv, index, arg, "--out-dir");
      parsed.outDir = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--corpus" || arg.startsWith("--corpus=")) {
      const value = parseArgsValue(argv, index, arg, "--corpus");
      parsed.corpusPath = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--now" || arg.startsWith("--now=")) {
      const value = parseArgsValue(argv, index, arg, "--now");
      parsed.now = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--goal" || arg.startsWith("--goal=")) {
      const value = parseArgsValue(argv, index, arg, "--goal");
      parsed.goalText = value.value;
      index = value.index;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/dispatcher_v1.mjs [--json] [--write] [--goal <text>] [--episode <id>] [--run-id <id>] [--out-dir <path>] [--corpus <path>] [--now <iso>] [--monolithic-fallback]

Options:
  --json           Emit machine-readable JSON.
  --write          Write dispatcher artifact bundle.
  --goal <text>    Try recipe-first resolution before compiling a dispatcher work-order.
  --episode <id>   Real episode id (default ${DEFAULT_DISPATCHER_EPISODE_ID}).
  --run-id <id>    Artifact run id.
  --out-dir <path> Output root for --write.
  --corpus <path>  Real episode corpus path.
  --now <iso>      Stable generated_at timestamp.
  --monolithic-fallback
                   Treat providers as unavailable and run the claims/evidence protocol locally.`;
}

export async function runDispatcherV1Cli(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
} = {}) {
  const args = parseDispatcherV1Args(argv);
  if (args.help) {
    return {
      ok: true,
      status: "HELP",
      text: usage(),
    };
  }
  const run = await runDispatcherV1({
    episodeId: args.episodeId,
    corpusPath: args.corpusPath || undefined,
    runId: args.runId,
    generatedAt: args.now || now(),
    cwd,
    monolithicFallback: args.monolithicFallback,
    goalText: args.goalText,
  });
  const result = {
    ok: true,
    status: run.status,
    run,
  };
  if (args.write) {
    result.artifacts = writeDispatcherArtifacts(run, {
      cwd,
      outDir: args.outDir,
      runId: args.runId,
    });
  }
  return result;
}

function renderText(result) {
  if (result.status === "HELP") return result.text;
  if (result.run?.status === "RECIPE_PREVIEW") {
    return [
      "Dispatcher v1",
      `Status: ${result.status}`,
      `Goal: ${result.run.source_task?.goal}`,
      `Recipe: ${result.run.recipe_first?.runner_preview?.selected_recipe_id}`,
      "Execution: recipe_runner_preview",
      `Command: ${result.run.recipe_first?.preview_command?.display || "(not rendered)"}`,
      result.artifacts?.dispatcher_path ? `Dispatcher: ${result.artifacts.dispatcher_path}` : null,
    ].filter(Boolean).join("\n");
  }
  return [
    "Dispatcher v1",
    `Status: ${result.status}`,
    `Episode: ${result.run.source_task?.episode_id}`,
    `Execution: ${result.run.execution_protocol?.execution_mode || "role_provider"}`,
    `Receipt: ${result.run.delivery_receipt?.status}`,
    `Escalations: ${result.run.delivery_receipt?.escalation_telemetry?.escalation_count ?? 0}`,
    `Cost USD: ${result.run.cost_comparison?.planner_cheap_total_usd ?? 0}`,
    result.artifacts?.dispatcher_path ? `Dispatcher: ${result.artifacts.dispatcher_path}` : null,
  ].filter(Boolean).join("\n");
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const args = parseDispatcherV1Args(process.argv.slice(2));
    const result = await runDispatcherV1Cli(process.argv.slice(2));
    if (args.json) {
      emitJson(result);
    } else {
      console.log(renderText(result));
    }
  } catch (error) {
    const failure = {
      ok: false,
      status: "FAIL",
      error: error.message,
      code: error.code || "dispatcher_v1_failed",
    };
    if (process.argv.includes("--json")) {
      emitJson(failure, { exitCode: 1 });
    } else {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
  }
}
