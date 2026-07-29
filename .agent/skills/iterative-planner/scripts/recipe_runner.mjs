#!/usr/bin/env node
// recipe_runner.mjs — Preview or execute deterministic recipe runner contracts.

import { spawnSync } from "child_process";
import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import {
  loadRecipeDefinition,
  resolvePrimaryRecipeCandidate,
  resolveRecipeRequest,
} from "./lib/recipe_utils.mjs";

const args = process.argv.slice(2);
const flags = {
  execute: args.includes("--execute"),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
  live: args.includes("--live"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function readFlagValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function uniqueList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
  )];
}

function parseParams(values) {
  const output = {};
  for (const entry of uniqueList(values)) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key || !value) continue;
    output[key] = value;
  }
  return output;
}

function extractPlaceholders(tokens) {
  const placeholders = new Set();
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const text = String(token || "");
    for (const match of text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
      placeholders.add(match[1]);
    }
  }
  return [...placeholders];
}

function renderTokens(tokens, params) {
  const missing = new Set();
  const rendered = (Array.isArray(tokens) ? tokens : []).map((token) => String(token || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
    const value = params[name];
    if (typeof value !== "string" || !value.trim()) {
      missing.add(name);
      return `{${name}}`;
    }
    return value.trim();
  }));

  return { rendered, missing: [...missing] };
}

function buildPayload({
  cwd,
  goalText,
  recipeId,
  recipe,
  recipeResolution,
  primaryCandidate,
  params,
  executionMode,
  command,
  commandCwd,
  missingParams,
  execution,
  error,
}) {
  return {
    generated_at: new Date().toISOString(),
    cwd,
    goal: goalText,
    recipe_resolution: recipeResolution,
    recipe: recipe ? {
      id: recipe.recipe_id,
      title: recipe.title || recipe.recipe_id,
      path: recipe.recipe_json_path,
      capability_id: recipe.capability_id || null,
      entity_ids: recipe.entity_ids,
      required_params: recipe.required_params,
      runner: recipe.runner,
    } : null,
    selected_recipe_id: recipeId,
    selected_candidate: primaryCandidate,
    params,
    missing_params: missingParams,
    execution: {
      mode: executionMode,
      executed: !!execution?.executed,
      cwd: commandCwd,
      command,
      status: execution?.status ?? null,
      stdout: execution?.stdout ?? "",
      stderr: execution?.stderr ?? "",
    },
    ok: !error && missingParams.length === 0 && !!command,
    error: error || null,
  };
}

function printHelp() {
  console.log(`recipe_runner.mjs — Preview or execute deterministic recipe runner contracts

Usage:
  node recipe_runner.mjs --recipe <recipe-id> --json
  node recipe_runner.mjs --goal "<goal>" --json
  node recipe_runner.mjs --goal "<goal>" --param key=value --execute --json
  node recipe_runner.mjs --recipe <recipe-id> --param key=value --execute --live --json

Behavior:
  - Preview is the default mode (no command runs unless --execute is provided)
  - --execute runs in safe dry-run mode by default only when the recipe declares dry-run flags
  - Dry-run execution fails closed if the recipe has no dry-run contract; use --live explicitly or add dry_run_flags
  - --execute --live opts into live execution explicitly
  - Parameters are deterministic key/value pairs via repeatable --param key=value
`);
}

if (flags.help) {
  printHelp();
  process.exit(0);
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const goalText = readFlagValue("--goal") || "";
const explicitRecipeId = readFlagValue("--recipe");
const cliParams = parseParams(readFlagValues("--param"));
const executionMode = flags.execute ? (flags.live ? "live" : "dry_run") : "preview";

const recipeResolution = goalText ? resolveRecipeRequest({ cwd, goalText }) : null;
const primaryCandidate = goalText ? resolvePrimaryRecipeCandidate(recipeResolution) : null;
const recipeId = explicitRecipeId || primaryCandidate?.recipe_id || recipeResolution?.primary_resolution?.recipe_id || null;

let error = null;
if (!recipeId) {
  error = goalText
    ? recipeResolution?.primary_resolution?.reason || "No deterministic recipe match could be resolved for this goal."
    : "Provide either --recipe <recipe-id> or --goal \"<goal>\".";
}

const recipe = recipeId ? loadRecipeDefinition(cwd, recipeId) : null;
if (!error && (!recipe || !recipe.present)) {
  error = `Recipe '${recipeId}' does not exist in recipes/${recipeId}/recipe.json.`;
}
if (!error && !recipe?.runner_present) {
  error = `Recipe '${recipeId}' is not execution-ready because it does not define a valid runner contract.`;
}

const params = {
  ...(recipe?.runner?.defaults || {}),
  ...(recipe?.entity_ids?.length === 1 ? { entity_id: recipe.entity_ids[0] } : {}),
  ...(primaryCandidate?.resolved_params || {}),
  ...cliParams,
};

const modeFlags = recipe?.runner
  ? (executionMode === "live" ? recipe.runner.live_flags : recipe.runner.dry_run_flags)
  : [];
const templatedTokens = recipe?.runner ? [...recipe.runner.command, ...modeFlags] : [];
const placeholderParams = extractPlaceholders(templatedTokens);
const requiredParams = uniqueList([...(recipe?.required_params || []), ...placeholderParams]);
const missingParams = requiredParams.filter((name) => typeof params[name] !== "string" || !params[name].trim());

const rendered = renderTokens(templatedTokens, params);
const allMissingParams = uniqueList([...missingParams, ...rendered.missing]);
const command = rendered.rendered.length > 0
  ? {
      bin: rendered.rendered[0],
      args: rendered.rendered.slice(1),
      tokens: rendered.rendered,
      display: rendered.rendered.join(" "),
    }
  : null;
const commandCwd = recipe?.runner ? resolve(cwd, recipe.runner.cwd || ".") : cwd;

if (
  !error
  && flags.execute
  && executionMode === "dry_run"
  && Array.isArray(recipe?.runner?.dry_run_flags)
  && recipe.runner.dry_run_flags.length === 0
) {
  error = `Recipe '${recipeId}' cannot execute in dry-run mode because runner.dry_run_flags is empty. Add a dry-run contract or re-run with --live for explicit live execution.`;
}

let execution = null;
if (!error && flags.execute && allMissingParams.length === 0 && command) {
  const result = spawnSync(command.bin, command.args, {
    cwd: commandCwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  execution = {
    executed: true,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
  if (result.error) {
    error = result.error.message;
  } else if ((result.status ?? 1) !== 0) {
    error = `Recipe runner command exited with status ${result.status ?? 1}.`;
  }
}

const payload = buildPayload({
  cwd,
  goalText,
  recipeId,
  recipe,
  recipeResolution,
  primaryCandidate,
  params,
  executionMode,
  command,
  commandCwd,
  missingParams: allMissingParams,
  execution,
  error,
});

if (flags.json) {
  emitJson(payload);
} else if (payload.ok) {
  console.log("Recipe Runner");
  console.log(`Recipe: ${payload.selected_recipe_id}`);
  console.log(`Mode: ${payload.execution.mode}`);
  console.log(`Command: ${payload.execution.command?.display || "(not rendered)"}`);
  if (payload.execution.executed) {
    console.log(`Status: ${payload.execution.status}`);
    if (payload.execution.stdout.trim()) console.log(payload.execution.stdout.trim());
    if (payload.execution.stderr.trim()) console.error(payload.execution.stderr.trim());
  }
} else {
  console.log("Recipe Runner");
  console.log(`Recipe: ${payload.selected_recipe_id || "(not resolved)"}`);
  console.log(`Error: ${payload.error || "Unable to render recipe command."}`);
  if (payload.missing_params.length > 0) {
    console.log(`Missing params: ${payload.missing_params.join(", ")}`);
  }
}

process.exitCode = payload.ok ? 0 : 1;
