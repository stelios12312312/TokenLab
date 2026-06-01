#!/usr/bin/env node
// test_adversarial_posture_contract.mjs — path precedence and posture coverage.

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { computeRecommendedPath } from "../scripts/lib/planner_phase_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
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

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
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
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function seedKnowledgeBase(projectRoot) {
  mkdirSync(join(projectRoot, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(projectRoot, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
}

function createProject(name) {
  const tmp = mkdtempSync(join(tmpdir(), `planner-adversarial-${name}-`));
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  seedKnowledgeBase(tmp);
  return tmp;
}

function seedPlan(projectRoot, goal, planContent) {
  const planName = "plan_2026-04-09_adversarial";
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);
  const state = createInitialStateJson(planName, goal, { projectRoot });
  writeStateJson(planDir, state);
  writeFileSync(join(planDir, "plan.md"), planContent);
  return planDir;
}

function seedStoryRegistry(projectRoot) {
  mkdirSync(join(projectRoot, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(projectRoot, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-10T00:00:00.000Z",
    stories: [
      {
        id: "US-301",
        title: "Planner routing fields stay aligned across scripts and docs",
        priority: "HIGH",
        status: "PLANNED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
          ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
        ],
        test_refs: [],
      },
      {
        id: "US-302",
        title: "Planner hygiene output stays aligned with routing posture",
        priority: "MEDIUM",
        status: "PLANNED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
        ],
        test_refs: [],
      },
    ],
  }, null, 2));
}

function scenarioPathPrecedenceIsDeterministic() {
  const bootstrap = computeRecommendedPath({
    semanticSubstrate: {
      required: true,
      satisfied: false,
      detail: "placeholder story registry blocks semantic bootstrap",
    },
    hygieneSummary: { auto_fix_count: 3 },
    symmetryHunts: [{ id: "mistake:M-001", source: "mistake_registry", recommended_guard: "requires_red_team" }],
  });
  assert(bootstrap.recommended_path === "bootstrap_semantics", "semantic bootstrap outranks cleanup and adversarial review");

  const cleanup = computeRecommendedPath({
    hygieneSummary: { auto_fix_count: 2 },
    symmetryHunts: [],
  });
  assert(cleanup.recommended_path === "cleanup", "cleanup wins when only deterministic repairs remain");
  assert(cleanup.audit_posture === "normal", "cleanup-only routing keeps normal audit posture");

  const targeted = computeRecommendedPath({
    symmetryHunts: [{ id: "mistake:M-001", source: "mistake_registry", recommended_guard: "requires_red_team" }],
  });
  assert(targeted.recommended_path === "targeted_red_team", "requires_red_team symmetry hunts escalate to targeted red-team");
  assert(targeted.audit_posture === "adversarial", "requires_red_team symmetry hunts escalate audit posture");

  const fullReview = computeRecommendedPath({
    classification: { signals: { planned_file_count: 4 } },
    symmetryHunts: [
      { id: "mistake:M-001", source: "mistake_registry", recommended_guard: "requires_red_team" },
      { id: "AP-002", source: "red_team_artifact", recommended_guard: "requires_red_team" },
    ],
    repairableVariances: [{ kind: "proof_gap" }],
  });
  assert(fullReview.recommended_path === "full_review", "broad clustered hidden-risk signals escalate to full_review");

  const ordinary = computeRecommendedPath({});
  assert(ordinary.recommended_path === "continue", "ordinary low-risk work stays on continue");
}

function scenarioCompositionSmokeConvergesOnTargetedRedTeam() {
  const tmp = createProject("composition");
  try {
    seedStoryRegistry(tmp);
    seedPlan(
      tmp,
      "Refactor planner authority routing",
      `# Plan

## Goal
Refactor planner authority routing

## Problem Statement
Planner-core authority routing should stay aligned across scripts and workflow docs.

## Files To Modify
- .agent/skills/iterative-planner/scripts/planner_preflight.mjs
- .agent/skills/iterative-planner/scripts/planner_findings.mjs
- .agent/workflows/advisor.md

## Steps
1. Keep authority_profile, audit_posture, and recommended_path aligned.
`
    );
    writeFileSync(join(tmp, "plans", "plan_2026-04-09_adversarial", "findings.md"), `# Findings

## Finding 1
Planner routing fields must stay aligned across planner_preflight, planner_findings, and advisor guidance.
If one surface lags, the operator sees a different next move even when the repo state is unchanged.
That makes planner-core routing a hidden-risk class rather than a local doc tweak.

## Finding 2
Root Cause: shared planner contract fields tend to drift across scripts and workflows when only one surface is updated.
That failure class already exists in the planner mistake memory, so this fixture should exercise the adversarial routing path instead of re-discovering it manually.
The test needs enough written substance to prove that the route is about planner-core ripple risk, not about missing context.

## Adjacency
Adjacency: planner_preflight.mjs, planner_findings.mjs, and .agent/workflows/advisor.md are the direct shared-contract neighbors for this change.
The routing contract is cross-surface by design, so the symmetry hunt should stay active after adjacency is made explicit.
`);

    const preflight = parseJson(run([".agent/skills/iterative-planner/scripts/planner_preflight.mjs", "--json"], tmp).stdout);
    const findings = parseJson(run([".agent/skills/iterative-planner/scripts/planner_findings.mjs", "--json"], tmp).stdout);
    const knowledge = parseJson(run([".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs", "--json"], tmp).stdout);
    const hygiene = parseJson(run([".agent/skills/iterative-planner/scripts/planner_hygiene.mjs", "scan", "--json"], tmp).stdout);

    assert(preflight?.recommended_path === "targeted_red_team", "planner_preflight converges on targeted red-team for planner-core symmetry-hunt work");
    assert(findings?.recommended_path === "targeted_red_team", "planner_findings converges on targeted red-team for planner-core symmetry-hunt work");
    assert(knowledge?.recommended_path === "targeted_red_team", "knowledge_resolver converges on targeted red-team for planner-core symmetry-hunt work");
    assert(hygiene?.recommended_path === "targeted_red_team", "planner_hygiene converges on targeted red-team when no deterministic cleanup is pending");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nAdversarial Posture Contract Tests\n");
scenarioPathPrecedenceIsDeterministic();
scenarioCompositionSmokeConvergesOnTargetedRedTeam();

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
