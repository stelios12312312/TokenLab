#!/usr/bin/env node
// test_dispatcher_v1.mjs - E6-5 dispatcher v1 end-to-end contract.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DISPATCHER_V1_RETURN_TYPE,
  DEFAULT_DISPATCHER_EPISODE_ID,
  PLANNER_CHEAP_DISPATCHER_ARM_ID,
  runDispatcherV1,
  validateDispatcherRun,
} from "../scripts/lib/dispatcher_v1.mjs";
import { validateDeliveryReceipt } from "../scripts/lib/delivery_receipt_assembler.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cliPath = join(testDir, "..", "scripts", "dispatcher_v1.mjs");
const NODE = process.execPath;
const FIXED_NOW = "2026-06-18T00:00:00.000Z";

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` - ${details}` : ""}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function installRecipeProject(root) {
  const recipesDir = join(root, "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeJson(join(recipesDir, "entity_registry.json"), {
    entities: [
      {
        id: "eventbrite_bootcamp",
        title: "AI Fluency Bootcamp Eventbrite roster",
        aliases: ["AI Fluency Bootcamp", "Eventbrite registrants", "bootcamp attendees"],
        systems: { eventbrite: "Eventbrite ticketing export" },
        recipe_ids: ["get-participants"],
      },
    ],
  });
  writeJson(join(recipesDir, "capability_registry.json"), {
    capabilities: [
      {
        id: "eventbrite_people_export",
        title: "Eventbrite attendee participant roster export",
        description: "Prepare a people, attendee, participant, or registrant export for an Eventbrite bootcamp.",
        triggers: [{ pattern: "^get participants for (?<value>.+)$", weight: 10 }],
        recipe_ids: ["get-participants"],
        supported_entities: ["eventbrite_bootcamp"],
        skills: ["eventbrite", "csv"],
      },
    ],
  });
  writeJson(join(recipesDir, "get-participants", "recipe.json"), {
    id: "get-participants",
    title: "Eventbrite participants export",
    capability_id: "eventbrite_people_export",
    entity_ids: ["eventbrite_bootcamp"],
    required_params: [],
    skills: ["eventbrite", "csv"],
    runner: {
      type: "command",
      cwd: ".",
      command: ["node", "-e", "console.log('get-participants')"],
      defaults: {},
      dry_run_flags: ["--dry-run"],
      live_flags: [],
    },
  });
}

console.log("\nDispatcher v1 Tests\n");

const run = await runDispatcherV1({
  episodeId: DEFAULT_DISPATCHER_EPISODE_ID,
  runId: "unit-dispatcher",
  generatedAt: FIXED_NOW,
  cwd: repoRoot,
});

assert(run.return_type === DISPATCHER_V1_RETURN_TYPE, "dispatcher run uses stable return type");
assert(run.status === "ESCALATED", "dispatcher records escalated cheap-arm outcome");
assert(run.source_task?.episode_id === "trueskill_cpcv_future_leakage", "dispatcher uses the selected real episode");
assert(run.validations?.work_order?.ok === true, "dispatcher work-order validates");
assert(run.validations?.claim_briefing?.ok === true, "dispatcher claim briefing validates");
assert(run.validations?.delivery_receipt?.ok === true, "dispatcher delivery receipt validates");
assert(validateDispatcherRun(run).ok === true, "dispatcher run validates");
assert(validateDeliveryReceipt(run.delivery_receipt).ok === true, "delivery receipt validator accepts dispatcher receipt");

const selectedPacks = asArray(run.claim_briefing?.source?.selected_pack_ids).sort();
assert(selectedPacks.join(",") === "quant,quant_target", "claim briefing uses quant and quant_target pack contracts");
assert(run.work_order?.id === "wo_dispatch_trueskill_cpcv_future_leakage", "work-order id is stable");
assert(asArray(run.work_order?.constraints).some((entry) => /no tennis|no roi|no alpha|no betting|no model-performance/i.test(entry)), "work-order records non-claim quant boundary");

assert(run.rubric_admin_suite_result?.summary?.shippable_count === 1, "one cheap rubric-admin config ships");
assert(run.rubric_admin_suite_result?.summary?.unshippable_count === 1, "one cheap rubric-admin config fails");
assert(run.rubric_admin_suite_result?.summary?.sycophancy_failed_count === 1, "suite records one sycophancy failure");
assert(run.delivery_receipt?.status === "ESCALATED", "delivery receipt status is ESCALATED");
assert(run.delivery_receipt?.escalation_telemetry?.escalation_count >= 1, "delivery receipt records escalation count");
assert(run.delivery_receipt?.escalation_telemetry?.bounce_count === 0, "delivery receipt records bounce count");
assert(Number.isFinite(run.delivery_receipt?.cost_ledger?.total?.wall_clock_ms), "delivery receipt records wall-clock");

assert(run.cost_comparison?.planner_cheap_total_usd < run.cost_comparison?.all_frontier_total_usd, "planner-cheap estimate is below all-frontier baseline");
assert(Number.isFinite(run.cost_comparison?.delta_usd), "cost comparison records numeric delta");
assert(Number.isFinite(run.cost_comparison?.savings_pct), "cost comparison records numeric savings percent");
assert(/deterministic estimate/i.test(run.cost_comparison?.method || ""), "cost comparison labels deterministic estimate method");

assert(run.benchmark_arm?.arm_id === PLANNER_CHEAP_DISPATCHER_ARM_ID, "benchmark arm id is planner_cheap_dispatcher");
assert(run.benchmark_arm?.receipt_ref, "benchmark arm records receipt ref");
assert(run.benchmark_arm?.escalation_count >= 1, "benchmark arm records escalation count");
assert(run.benchmark_arm?.bounce_count === 0, "benchmark arm records bounce count");
assert(run.honest_writeup?.cheap_arm_failed_and_escalated === true, "honest writeup records cheap-arm failure/escalation");
assert(run.quant_results_validation?.status === "not_applicable", "quant results validation is explicitly non-applicable");

const recipeProject = mkdtempSync(join(tmpdir(), "dispatcher-v1-recipe-"));
installRecipeProject(recipeProject);

const recipePreviewRun = await runDispatcherV1({
  goalText: "Prepare the Eventbrite people export for the AI Fluency Bootcamp",
  runId: "unit-dispatcher-recipe-preview",
  generatedAt: FIXED_NOW,
  cwd: recipeProject,
});
assert(recipePreviewRun.status === "RECIPE_PREVIEW", "dispatcher known recipe goal returns recipe preview status");
assert(validateDispatcherRun(recipePreviewRun).ok === true, "dispatcher recipe preview run validates");
assert(recipePreviewRun.recipe_first?.fell_through_to_work_order === false, "dispatcher recipe preview does not fall through to work-order path");
assert(recipePreviewRun.recipe_first?.runner_preview?.selected_recipe_id === "get-participants", "dispatcher recipe preview selects get-participants");
assert(recipePreviewRun.recipe_first?.runner_preview?.execution?.mode === "preview", "dispatcher recipe preview uses recipe_runner preview mode");
assert(recipePreviewRun.recipe_first?.runner_preview?.execution?.executed === false, "dispatcher recipe preview does not execute command");
assert(!recipePreviewRun.work_order, "dispatcher recipe preview does not compile a fresh work-order");

const noMatchFallthroughRun = await runDispatcherV1({
  goalText: "Write a haiku about calm planning",
  runId: "unit-dispatcher-recipe-no-match",
  generatedAt: FIXED_NOW,
  cwd: recipeProject,
});
assert(validateDispatcherRun(noMatchFallthroughRun).ok === true, "dispatcher registry no-match fall-through validates");
assert(noMatchFallthroughRun.recipe_first?.fell_through_to_work_order === true, "dispatcher registry no-match falls through to work-order path");
assert(noMatchFallthroughRun.recipe_first?.route === "plan_build", "dispatcher registry no-match records plan_build route");
assert(noMatchFallthroughRun.work_order?.id === "wo_dispatch_trueskill_cpcv_future_leakage", "dispatcher registry no-match still compiles normal work-order");

const fallbackRun = await runDispatcherV1({
  episodeId: DEFAULT_DISPATCHER_EPISODE_ID,
  runId: "unit-dispatcher-fallback",
  generatedAt: FIXED_NOW,
  cwd: repoRoot,
  monolithicFallback: true,
});
assert(validateDispatcherRun(fallbackRun).ok === true, "dispatcher fallback run validates");
assert(validateDeliveryReceipt(fallbackRun.delivery_receipt).ok === true, "dispatcher fallback delivery receipt validates");
assert(fallbackRun.execution_protocol?.execution_mode === "monolithic_fallback", "dispatcher fallback records monolithic execution mode");
assert(fallbackRun.execution_protocol?.provider_status === "unavailable", "dispatcher fallback records provider-unavailable status");
assert(fallbackRun.rubric_admin_suite_result?.summary?.fallback_count === 2, "dispatcher fallback records rubric fallback count");
assert(fallbackRun.delivery_receipt?.status === "PASS", "dispatcher fallback receipt passes without silent provider skip");
assert(fallbackRun.honest_writeup?.provider_disabled_and_fallback === true, "honest writeup records provider-disabled fallback");
assert(fallbackRun.rubric_admin_suite_result?.runs.every((entry) => entry.executor_result?.status === "SUCCESS"), "fallback runs return executor result status");

const providerDownRecipeFallthrough = await runDispatcherV1({
  goalText: "Export contacts from the CRM pipeline",
  episodeId: DEFAULT_DISPATCHER_EPISODE_ID,
  runId: "unit-dispatcher-no-registry-provider-down",
  generatedAt: FIXED_NOW,
  cwd: repoRoot,
  monolithicFallback: true,
});
assert(validateDispatcherRun(providerDownRecipeFallthrough).ok === true, "dispatcher no-registry provider-down fall-through validates");
assert(providerDownRecipeFallthrough.recipe_first?.fell_through_to_work_order === true, "dispatcher no-registry recipe request falls through to work-order path");
assert(providerDownRecipeFallthrough.recipe_first?.route === "recipe_discovery", "dispatcher no-registry operational request records recipe_discovery route");
assert(providerDownRecipeFallthrough.execution_protocol?.execution_mode === "monolithic_fallback", "dispatcher no-registry provider-down run keeps fallback execution mode");
assert(providerDownRecipeFallthrough.delivery_receipt?.status === "PASS", "dispatcher no-registry provider-down fall-through keeps honest PASS receipt");

let invalidFailed = false;
try {
  await runDispatcherV1({
    episodeId: "missing_episode",
    runId: "invalid",
    generatedAt: FIXED_NOW,
    cwd: repoRoot,
  });
} catch (error) {
  invalidFailed = /episode|missing/i.test(error.message);
}
assert(invalidFailed, "unknown episode fails closed");

const tmp = mkdtempSync(join(tmpdir(), "dispatcher-v1-"));
const cliJsonText = execFileSync(NODE, [
  cliPath,
  "--json",
  "--write",
  "--run-id",
  "unit-cli",
  "--out-dir",
  tmp,
  "--now",
  FIXED_NOW,
], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const cliJson = JSON.parse(cliJsonText);
assert(cliJson.ok === true && cliJson.run?.return_type === DISPATCHER_V1_RETURN_TYPE, "CLI emits parseable dispatcher JSON");
assert(existsSync(cliJson.artifacts?.dispatcher_path), "CLI writes dispatcher.json");
assert(existsSync(cliJson.artifacts?.delivery_receipt_path), "CLI writes delivery_receipt.json");
assert(existsSync(cliJson.artifacts?.benchmark_path), "CLI writes benchmark.json");
const manifest = JSON.parse(readFileSync(cliJson.artifacts.manifest_path, "utf8"));
assert(manifest.status === "ESCALATED" && manifest.run_id === "unit-cli", "manifest records run status and id");

const fallbackCliJsonText = execFileSync(NODE, [
  cliPath,
  "--json",
  "--monolithic-fallback",
  "--run-id",
  "unit-cli-fallback",
  "--now",
  FIXED_NOW,
], {
  cwd: repoRoot,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const fallbackCliJson = JSON.parse(fallbackCliJsonText);
assert(fallbackCliJson.ok === true, "CLI fallback emits ok JSON");
assert(fallbackCliJson.run?.execution_protocol?.execution_mode === "monolithic_fallback", "CLI fallback records monolithic mode");
assert(fallbackCliJson.run?.rubric_admin_suite_result?.summary?.fallback_count === 2, "CLI fallback records fallback count");

const recipeCliJsonText = execFileSync(NODE, [
  cliPath,
  "--json",
  "--goal",
  "Prepare the Eventbrite people export for the AI Fluency Bootcamp",
  "--run-id",
  "unit-cli-recipe-preview",
  "--now",
  FIXED_NOW,
], {
  cwd: recipeProject,
  env: plannerSubprocessEnv(),
  encoding: "utf8",
});
const recipeCliJson = JSON.parse(recipeCliJsonText);
assert(recipeCliJson.ok === true, "CLI recipe goal emits ok JSON");
assert(recipeCliJson.run?.status === "RECIPE_PREVIEW", "CLI recipe goal returns recipe preview");
assert(recipeCliJson.run?.recipe_first?.runner_preview?.execution?.executed === false, "CLI recipe preview remains non-executing");

rmSync(recipeProject, { recursive: true, force: true });

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
