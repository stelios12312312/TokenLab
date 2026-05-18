#!/usr/bin/env node
// recipe_validate.mjs - Read-only recipe surface validation and inspection.

import { resolve } from "path";
import { validateRecipeSurface } from "./lib/recipe_utils.mjs";

const args = process.argv.slice(2);
const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "validate";
const forwarded = subcommand === args[0] ? args.slice(1) : args;

function hasFlag(flag) {
  return forwarded.includes(flag) || args.includes(flag);
}

function readFlagValue(flag) {
  const index = forwarded.indexOf(flag);
  if (index !== -1 && forwarded[index + 1]) return forwarded[index + 1];
  const allIndex = args.indexOf(flag);
  return allIndex !== -1 && args[allIndex + 1] ? args[allIndex + 1] : null;
}

function printHelp() {
  console.log(`recipe_validate.mjs - validate and inspect project-owned recipe surfaces

Usage:
  node recipe_validate.mjs validate [--dir <project-or-recipes-dir>] [--json]
  node recipe_validate.mjs list [--dir <project-or-recipes-dir>] [--json]
  node recipe_validate.mjs show <recipe-id> [--dir <project-or-recipes-dir>] [--json]

Reads canonical recipe.json and legacy runner.json. Writes nothing.`);
}

if (hasFlag("--help") || hasFlag("-h") || subcommand === "help") {
  printHelp();
  process.exitCode = 0;
  process.exit();
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const payload = validateRecipeSurface(cwd);

if (subcommand === "show") {
  const requestedId = forwarded.find((entry) => !entry.startsWith("-"));
  const recipe = payload.recipes.find((entry) => entry.id === requestedId);
  if (hasFlag("--json")) {
    console.log(JSON.stringify({ ...payload, recipe: recipe || null }, null, 2));
  } else if (recipe) {
    console.log(`${recipe.id}: ${recipe.variant} (${recipe.valid ? "valid" : "invalid"})`);
    for (const issue of recipe.issues) console.log(`  issue: ${issue}`);
    for (const info of recipe.info) console.log(`  info: ${info}`);
  } else {
    console.error(`Recipe not found: ${requestedId || "(missing id)"}`);
  }
  process.exitCode = recipe ? 0 : 1;
} else if (hasFlag("--json")) {
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.invalid_count === 0 ? 0 : 1;
} else if (subcommand === "list") {
  for (const recipe of payload.recipes) {
    console.log(`${recipe.id}\t${recipe.variant}\t${recipe.valid ? "valid" : "invalid"}`);
  }
  process.exitCode = payload.invalid_count === 0 ? 0 : 1;
} else {
  console.log(`Recipes: ${payload.recipe_count}; valid: ${payload.valid_count}; invalid: ${payload.invalid_count}; legacy: ${payload.legacy_count}`);
  for (const recipe of payload.recipes) {
    for (const info of recipe.info) console.log(`INFO ${recipe.id}: ${info}`);
    for (const issue of recipe.issues) console.log(`FAIL ${recipe.id}: ${issue}`);
  }
  for (const info of payload.registry.info) console.log(`INFO registry: ${info}`);
  for (const issue of payload.registry.issues) console.log(`FAIL registry: ${issue}`);
  process.exitCode = payload.invalid_count === 0 ? 0 : 1;
}
