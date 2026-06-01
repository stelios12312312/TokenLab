#!/usr/bin/env node
// retro_registry.mjs — Read-only query interface for structured retro history.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

import { computeMistakeRegistrySignal } from "./lib/mistake_registry.mjs";
import {
  collectRelatedRetros,
  defaultRetroLedgerPath,
  getRetroById,
  getRetrosForMistakeId,
  loadRetroRegistry,
  resolveRetroCaseFile,
  searchRetros,
  summarizeRetroRegistry,
} from "./lib/retro_registry.mjs";
import { extractFilesToModify, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { readStateJson } from "./lib/determinism.mjs";

function printHelp() {
  console.log(`retro_registry.mjs — query structured retro history

Usage:
  node retro_registry.mjs list [--json] [--dir <path>]
  node retro_registry.mjs show <retro-id> [--json] [--dir <path>]
  node retro_registry.mjs search <term> [--json] [--dir <path>]
  node retro_registry.mjs related-mistake <mistake-id> [--json] [--dir <path>]
  node retro_registry.mjs active-for-plan <plan-dir> [--json] [--dir <path>]

Notes:
  - Reads plans/knowledge/retros/retro_ledger.json
  - active-for-plan resolves active mistakes first, then ranks accepted retros
  - Human output stays compact; use --json for machine-readable details
`);
}

function parseArgs(args) {
  const json = args.includes("--json");
  const help = args.includes("--help") || args.includes("-h");
  const dirIndex = args.indexOf("--dir");
  const cwd = dirIndex !== -1 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]) : process.cwd();
  const dirValueIndex = dirIndex !== -1 ? dirIndex + 1 : -1;
  const filtered = args.filter((arg, index) => arg !== "--json" && arg !== "--help" && arg !== "-h" && arg !== "--dir" && index !== dirValueIndex);
  return {
    json,
    help,
    cwd,
    command: filtered[0] || null,
    operands: filtered.slice(1),
  };
}

function loadStoryRegistry(cwd) {
  const path = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readPlanContext(cwd, explicitPlan) {
  const plansDir = join(cwd, "plans");
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: explicitPlan });
  if (!target.planDirName || !target.planDir) return null;
  const planContent = existsSync(join(target.planDir, "plan.md"))
    ? readFileSync(join(target.planDir, "plan.md"), "utf-8")
    : "";
  const stateJson = readStateJson(target.planDir) || null;
  return {
    planDirName: target.planDirName,
    planDir: target.planDir,
    planContent,
    stateJson,
    goalText: stateJson?.goal || "",
    plannedFiles: extractFilesToModify(planContent || ""),
  };
}

function printList(payload) {
  console.log("Retro Registry");
  console.log(`Path: ${payload.path}`);
  console.log(`Retros: ${payload.summary.accepted_count}/${payload.summary.retro_count} accepted`);
  if ((payload.warnings || []).length > 0) {
    console.log(`Warnings: ${(payload.warnings || []).map((warning) => `${warning.code}:${warning.retro_id}`).join(", ")}`);
  }
  for (const retro of payload.retros || []) {
    console.log(`- ${retro.id} | ${retro.promotion_decision || "n/a"} | ${retro.title}`);
  }
}

function printShow(payload) {
  const retro = payload.retro;
  if (!retro) {
    console.log(`Retro not found: ${payload.retro_id}`);
    return;
  }
  console.log(`${retro.id} — ${retro.title}`);
  console.log(`Status: ${retro.status}`);
  console.log(`Promotion: ${retro.promotion_decision || "n/a"}`);
  console.log(`Summary: ${retro.summary}`);
  if (retro.kb_refs?.length) console.log(`KB refs: ${retro.kb_refs.join(", ")}`);
  if (retro.tags?.length) console.log(`Tags: ${retro.tags.join(", ")}`);
  if (payload.case_file_path) console.log(`Case file: ${payload.case_file_path}`);
  if (payload.case_file_excerpt) {
    console.log("");
    console.log(payload.case_file_excerpt.trim());
  }
}

function printRelated(payload) {
  console.log(`Related retros for ${payload.mistake_id}`);
  for (const retro of payload.retros || []) {
    console.log(`- ${retro.id} | ${retro.promotion_decision || "n/a"} | ${retro.title}`);
  }
}

function printActive(payload) {
  console.log(`Active retros for ${payload.plan_dir}`);
  if ((payload.active_mistakes || []).length > 0) {
    console.log(`Active mistakes: ${payload.active_mistakes.map((mistake) => mistake.id).join(", ")}`);
  }
  for (const retro of payload.related_retros || []) {
    console.log(`- ${retro.id} | score=${retro.score} | ${retro.title}`);
  }
}

const { json, help, cwd, command, operands } = parseArgs(process.argv.slice(2));
if (help || !command) {
  printHelp();
  process.exit(help ? 0 : 1);
}

const registry = loadRetroRegistry({ cwd, ledgerPath: defaultRetroLedgerPath({ cwd }) });

let payload;
if (command === "list") {
  payload = {
    path: registry.path,
    summary: summarizeRetroRegistry(registry),
    warnings: registry.warnings || [],
    retros: registry.accepted_retros || [],
  };
} else if (command === "show") {
  const retroId = operands[0];
  const retro = getRetroById(registry, retroId);
  const caseFilePath = retro?.case_file ? resolve(cwd, retro.case_file) : null;
  const caseFileContent = retro ? resolveRetroCaseFile(cwd, retro) : null;
  payload = {
    retro_id: retroId || null,
    path: registry.path,
    summary: summarizeRetroRegistry(registry),
    retro,
    case_file_path: caseFilePath,
    case_file_excerpt: caseFileContent,
  };
} else if (command === "search") {
  const query = operands.join(" ").trim();
  payload = {
    query,
    path: registry.path,
    summary: summarizeRetroRegistry(registry),
    retros: searchRetros(registry, query),
  };
} else if (command === "related-mistake") {
  const mistakeId = operands[0];
  payload = {
    mistake_id: mistakeId || null,
    path: registry.path,
    summary: summarizeRetroRegistry(registry),
    retros: getRetrosForMistakeId(registry, mistakeId),
  };
} else if (command === "active-for-plan") {
  const explicitPlan = operands[0];
  const planContext = readPlanContext(cwd, explicitPlan);
  if (!planContext) {
    console.error(`ERROR: Plan not found: ${explicitPlan || "(active plan)"}`);
    process.exit(1);
  }
  const mistakeSignal = computeMistakeRegistrySignal({
    cwd,
    planDir: planContext.planDir,
    stateJson: planContext.stateJson,
    planContent: planContext.planContent,
    storyRegistry: loadStoryRegistry(cwd),
  });
  payload = {
    plan_dir: planContext.planDirName,
    path: registry.path,
    summary: summarizeRetroRegistry(registry),
    active_mistakes: mistakeSignal.active_mistakes || [],
    related_retros: collectRelatedRetros({
      registry,
      activeMistakes: mistakeSignal.active_mistakes || [],
      goalText: planContext.goalText,
      plannedFiles: planContext.plannedFiles,
    }),
  };
} else {
  printHelp();
  process.exit(1);
}

if (json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else if (command === "list" || command === "search") {
  printList(payload);
} else if (command === "show") {
  printShow(payload);
} else if (command === "related-mistake") {
  printRelated(payload);
} else if (command === "active-for-plan") {
  printActive(payload);
}
