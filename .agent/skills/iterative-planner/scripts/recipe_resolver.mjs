#!/usr/bin/env node
// recipe_resolver.mjs — Deterministic recipe/entity/capability intake resolver.

import { readFileSync } from "fs";
import { join, resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { getPaths, readFile, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { resolveRecipeRequest } from "./lib/recipe_utils.mjs";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

if (flags.help) {
  console.log(`recipe_resolver.mjs — Deterministic recipe/entity/capability resolver

Usage:
  node recipe_resolver.mjs --goal "<goal>" --json
  node recipe_resolver.mjs --json
  node recipe_resolver.mjs --dir <path> --goal "<goal>" --json

Host-project convention:
  recipes/entity_registry.json
  recipes/capability_registry.json
  recipes/<recipe-id>/recipe.json`);
  process.exit(0);
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const explicitGoal = readFlagValue("--goal");
const { plansDir } = getPaths(cwd);
const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
const stateJson = !explicitGoal && target.planDir ? safeReadJson(join(target.planDir, "state.json")) : null;
const planContent = !explicitGoal && target.planDir ? (readFile(join(target.planDir, "plan.md")) || "") : "";
const inferredGoal = explicitGoal || stateJson?.goal || extractGoalFromPlanContent(planContent) || "";

const payload = {
  generated_at: new Date().toISOString(),
  cwd,
  goal: inferredGoal,
  goal_source: explicitGoal ? "cli" : (stateJson?.goal ? "state.json" : (planContent ? "plan.md" : "none")),
  ...resolveRecipeRequest({ cwd, goalText: inferredGoal }),
};

if (flags.json) {
  emitJson(payload, { exitCode: 0 });
} else {
  console.log("Recipe Resolver");
  console.log(`Goal: ${payload.goal || "(not provided)"}`);
  console.log(`Primary route: ${payload.primary_resolution.route}`);
  console.log(`Reason: ${payload.primary_resolution.reason}`);
  if (payload.primary_resolution.recipe_id) {
    console.log(`Recipe: ${payload.primary_resolution.recipe_id}`);
  }
  if (payload.entities.length > 0) {
    console.log(`Entities: ${payload.entities.map((entity) => `${entity.id} (${entity.matched_aliases.join(", ")})`).join("; ")}`);
  }
  if (payload.capabilities.length > 0) {
    console.log(`Capabilities: ${payload.capabilities.map((capability) => `${capability.id} [score=${capability.score}]`).join("; ")}`);
  }
}
