#!/usr/bin/env node
// test_retro_registry.mjs — smoke coverage for the structured retro archive loader and CLI.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { loadRetroRegistry } from "../scripts/lib/retro_registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptPath = join(skillDir, "scripts", "retro_registry.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function createProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-retro-registry-"));
  mkdirSync(join(tmp, "plans", "knowledge", "retros", "cases"), { recursive: true });
  writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
  return tmp;
}

function seedRetroFixture(projectRoot) {
  writeFileSync(join(projectRoot, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({
    version: 1,
    retros: [
      {
        id: "R-2026-03-24-001",
        date: "2026-03-24",
        title: "Planner-core ripple-through learned the hard way",
        summary: "Planner-core contract changes must update code, docs, migration, and proof surfaces together.",
        failure_modes: ["MISSED_BLAST_RADIUS"],
        discovered_phase: "execute-to-reflect",
        affected_surfaces: [".agent/skills/iterative-planner/scripts/", ".agent/workflows/"],
        root_cause: "The rollout treated a behavioral contract change like a local code patch.",
        promotion_decision: "hard_invariant",
        promotions: {
          mistake_ids: ["M-001"],
          obligation_ids: [],
          invariant_ids: ["active_mistake_missing_declared_guard"]
        },
        kb_refs: ["plans/knowledge/mistakes.md#M-001"],
        tags: ["planner_core", "ripple"],
        case_file: "plans/knowledge/retros/cases/R-2026-03-24-001.md",
        status: "accepted"
      },
      {
        id: "R-2026-04-11-001",
        date: "2026-04-11",
        title: "Migration left operator front doors stale",
        summary: "Fleet rollout looked current at the script level, but operator-facing root instructions were still stale.",
        failure_modes: ["MISSING_GATE"],
        discovered_phase: "validate-to-close",
        affected_surfaces: ["CLAUDE.md", "AGENTS.md", "GEMINI.md"],
        root_cause: "Install health was verified without verifying operator discoverability.",
        promotion_decision: "docs_only",
        kb_refs: ["plans/knowledge/mistakes.md#M-030"],
        tags: ["migration", "operator_front_door"],
        case_file: "plans/knowledge/retros/cases/R-2026-04-11-001.md",
        status: "accepted"
      }
    ]
  }, null, 2));
  writeFileSync(join(projectRoot, "plans", "knowledge", "retros", "cases", "R-2026-03-24-001.md"), "# R-2026-03-24-001\n\n## Incident\nPlanner-core ripple-through was missed.\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "retros", "cases", "R-2026-04-11-001.md"), "# R-2026-04-11-001\n\n## Incident\nOperator front doors stayed stale.\n");

  const planName = "plan_2026-04-11_retro_fixture";
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);
  writeStateJson(planDir, createInitialStateJson(planName, "Refactor planner migration ripple checks", { projectRoot }));
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor planner migration ripple checks

## Files To Modify
- .agent/skills/iterative-planner/scripts/migrate.mjs
- .agent/workflows/retro.md
`);

  return { planName, planDir };
}

function scenarioLoaderAndCli() {
  const tmp = createProject();
  try {
    const { planName } = seedRetroFixture(tmp);

    const registry = loadRetroRegistry({ cwd: tmp });
    assert(registry.usable === true, "loadRetroRegistry accepts a valid retro ledger");
    assert((registry.accepted_retros || []).length === 2, "loadRetroRegistry returns accepted retros");

    const list = run([scriptPath, "list", "--json"], tmp);
    assert(list.ok, "retro_registry list exits cleanly");
    const listJson = parseJson(list.stdout);
    assert(!!listJson, "retro_registry list emits valid JSON");
    assert(listJson?.summary?.accepted_count === 2, "retro_registry list reports accepted retro count");

    const show = run([scriptPath, "show", "R-2026-03-24-001", "--json"], tmp);
    assert(show.ok, "retro_registry show exits cleanly");
    const showJson = parseJson(show.stdout);
    assert(showJson?.retro?.id === "R-2026-03-24-001", "retro_registry show returns the requested retro");
    assert((showJson?.case_file_excerpt || "").includes("Planner-core ripple-through was missed"), "retro_registry show returns the case file excerpt");

    const search = run([scriptPath, "search", "ripple", "--json"], tmp);
    assert(search.ok, "retro_registry search exits cleanly");
    const searchJson = parseJson(search.stdout);
    assert((searchJson?.retros || []).some((entry) => entry.id === "R-2026-03-24-001"), "retro_registry search matches the ripple retro");

    const related = run([scriptPath, "related-mistake", "M-001", "--json"], tmp);
    assert(related.ok, "retro_registry related-mistake exits cleanly");
    const relatedJson = parseJson(related.stdout);
    assert((relatedJson?.retros || []).some((entry) => entry.id === "R-2026-03-24-001"), "retro_registry related-mistake follows retro promotions by mistake id");

    const active = run([scriptPath, "active-for-plan", planName, "--json"], tmp);
    assert(active.ok, "retro_registry active-for-plan exits cleanly");
    const activeJson = parseJson(active.stdout);
    assert((activeJson?.active_mistakes || []).some((entry) => entry.id === "M-001"), "retro_registry active-for-plan activates the planner-core ripple-through mistake");
    assert((activeJson?.related_retros || []).some((entry) => entry.id === "R-2026-03-24-001"), "retro_registry active-for-plan returns the linked retro for the active mistake");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioDuplicateRetroIdsFailValidation() {
  const tmp = createProject();
  try {
    writeFileSync(join(tmp, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({
      version: 1,
      retros: [
        { id: "R-001", title: "One", summary: "One" },
        { id: "R-001", title: "Two", summary: "Two" }
      ]
    }, null, 2));
    const registry = loadRetroRegistry({ cwd: tmp });
    assert(registry.usable === false, "loadRetroRegistry rejects duplicate retro ids");
    assert(registry.error === "duplicate_retro_id", "loadRetroRegistry reports duplicate_retro_id for repeated retro ids");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioLoaderAndCli();
scenarioDuplicateRetroIdsFailValidation();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
