#!/usr/bin/env node
// dogfood_lifecycle_replay.mjs - Tier 2 committed lifecycle replay CLI.
// @planner:module = dogfood_lifecycle_replay_cli
// @planner:capability = committed_dogfood_lifecycle_replay_cli

import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  DEFAULT_DOGFOOD_PLAN_SPECS,
  renderDogfoodLifecycleReplayText,
  replayDogfoodLifecycleCorpus,
} from "./lib/dogfood_lifecycle_replay.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/dogfood_lifecycle_replay.mjs [--json]
  node .agent/skills/iterative-planner/scripts/dogfood_lifecycle_replay.mjs --plan <plans/plan_id> [--plan <plans/plan_id>] [--repo-root <path>] [--json]

Default mode replays the pinned three-plan Tier 2 dogfood corpus.`;
}

export function parseDogfoodLifecycleReplayArgs(argv = []) {
  const options = { json: false, help: false, repoRoot: process.cwd(), planSpecs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--repo-root") options.repoRoot = resolve(argv[++index] || process.cwd());
    else if (arg.startsWith("--repo-root=")) options.repoRoot = resolve(arg.slice("--repo-root=".length) || process.cwd());
    else if (arg === "--plan") options.planSpecs.push({ plan_dir: argv[++index] || "", shape: "explicit_plan" });
    else if (arg.startsWith("--plan=")) options.planSpecs.push({ plan_dir: arg.slice("--plan=".length), shape: "explicit_plan" });
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.planSpecs.length === 0) options.planSpecs = DEFAULT_DOGFOOD_PLAN_SPECS;
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseDogfoodLifecycleReplayArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const report = replayDogfoodLifecycleCorpus({ repoRoot: options.repoRoot, planSpecs: options.planSpecs });
  if (options.json) emitJson(report);
  else console.log(renderDogfoodLifecycleReplayText(report));
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const failure = {
      schema_version: 1,
      replay_id: "tier2_committed_dogfood_lifecycle_replay",
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) emitJson(failure);
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
