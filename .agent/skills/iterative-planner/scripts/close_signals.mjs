#!/usr/bin/env node
// close_signals.mjs — Non-mutating diagnostics for generated close signals.
//
// Usage:
//   node close_signals.mjs explain --plan <plan-dir> [--json]

import { existsSync, readFileSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";

import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { refreshPlanArtifacts } from "./lib/plan_refresh.mjs";

function parseArgs(argv) {
  const args = { command: argv[2] || "help", plan: null, json: false };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--plan") {
      args.plan = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/close_signals.mjs explain --plan <plan-dir> [--json]",
  ].join("\n");
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function resolvePlan(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  if (!planArg) {
    const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
    if (!target.planDirName) return { ok: false, error: "No active plan found" };
    return {
      ok: true,
      planDirName: target.planDirName,
      planDir: join(plansDir, target.planDirName),
      source: target.source || "pointer",
    };
  }

  const candidate = isAbsolute(planArg)
    ? planArg
    : planArg.includes("/") || planArg.includes("\\")
      ? resolve(cwd, planArg)
      : join(plansDir, planArg);
  return {
    ok: existsSync(candidate),
    planDirName: basename(candidate),
    planDir: candidate,
    source: planArg,
    error: existsSync(candidate) ? null : `Plan directory not found: ${candidate}`,
  };
}

function suggestionsForSemanticSubstrate(signal) {
  const blocking = Array.isArray(signal?.blocking_gap_ids) ? signal.blocking_gap_ids : [];
  if (blocking.length === 0) {
    return [
      "Edit plan.md, verification.md, story_registry.json, or @planner annotations when the generated signal is wrong; do not edit state.json.close_signals directly.",
    ];
  }
  const suggestions = [];
  if (blocking.includes("missing_mutually_exclusive_facts")) {
    suggestions.push("Add trusted @planner:mutually_exclusive annotations or revise the plan so config-mode risk is no longer in scope.");
  }
  if (blocking.includes("missing_story_postconditions")) {
    suggestions.push("Add story postconditions to story_registry.json for the affected stateful flow.");
  }
  if (blocking.includes("missing_story_conflict_facts")) {
    suggestions.push("Add story conflict facts to story_registry.json for mutually exclusive stateful outcomes.");
  }
  suggestions.push("Run this explain command again after changing source artifacts; it is non-mutating.");
  return suggestions;
}

function buildExplainResult({ cwd, planArg }) {
  const resolved = resolvePlan(cwd, planArg);
  if (!resolved.ok) {
    return { status: "fail", ok: false, error: resolved.error, plan: resolved };
  }

  const beforeState = readText(join(resolved.planDir, "state.json"));
  let refresh = null;
  try {
    refresh = refreshPlanArtifacts({
      cwd,
      planDirName: resolved.planDirName,
      refreshOntology: true,
      persistOntology: false,
      persistState: false,
      syncFindings: false,
    });
  } catch (error) {
    return {
      status: "fail",
      ok: false,
      error: error?.message || String(error),
      plan: {
        plan_dir_name: resolved.planDirName,
        plan_dir: resolved.planDir,
        source: resolved.source,
      },
      generated_cache: {
        path: "state.json.close_signals",
        generated: true,
        operator_editable: false,
        state_mutated: beforeState !== readText(join(resolved.planDir, "state.json")),
      },
    };
  }
  const afterState = readText(join(resolved.planDir, "state.json"));
  const semanticSubstrate = refresh.closeSignals?.semantic_substrate || null;

  return {
    status: refresh.refreshed ? "pass" : "fail",
    ok: refresh.refreshed === true,
    plan: {
      plan_dir_name: resolved.planDirName,
      plan_dir: resolved.planDir,
      source: resolved.source,
    },
    generated_cache: {
      path: "state.json.close_signals",
      generated: true,
      operator_editable: false,
      state_mutated: beforeState !== afterState,
      note: "Close signals are generated from plan artifacts, annotations, story registry, telemetry, and Prolog diagnostics.",
    },
    close_signals: refresh.closeSignals || null,
    semantic_substrate: semanticSubstrate,
    diagnostics: {
      selected_source_artifacts: semanticSubstrate?.provenance?.source_artifacts || [
        "plan.md",
        "verification.md",
        "findings.md/findings_ledger.json",
        "story_registry.json",
        "@planner annotations",
        "proof telemetry",
        "Prolog diagnostics",
      ],
      relevance_evidence: semanticSubstrate?.relevance_evidence || null,
      blocking_gap_ids: semanticSubstrate?.blocking_gap_ids || [],
      advisory_gap_ids: semanticSubstrate?.advisory_gap_ids || [],
      scan_scope: semanticSubstrate?.scan_scope || null,
      scan_scope_used: semanticSubstrate?.scan_scope_used || null,
      scope_degraded: semanticSubstrate?.scope_degraded === true,
      suggested_source_edits: suggestionsForSemanticSubstrate(semanticSubstrate),
    },
  };
}

function printHuman(result) {
  if (!result.ok) {
    console.log(`close_signals explain: FAIL — ${result.error || "unknown error"}`);
    return;
  }
  const signal = result.semantic_substrate || {};
  console.log(`close_signals explain: ${result.plan.plan_dir_name}`);
  console.log(`  generated cache: ${result.generated_cache.path}`);
  console.log(`  state mutated: ${result.generated_cache.state_mutated ? "YES" : "NO"}`);
  console.log(`  semantic substrate: ${signal.status || "unknown"} (required=${signal.required === true}, satisfied=${signal.satisfied !== false})`);
  console.log(`  relevance: config=${signal.relevance_evidence?.config || "none"}, story=${signal.relevance_evidence?.story_semantics || "none"}`);
  console.log(`  blocking gaps: ${(signal.blocking_gap_ids || []).join(", ") || "none"}`);
  console.log(`  advisory gaps: ${(signal.advisory_gap_ids || []).join(", ") || "none"}`);
  console.log("  suggested source edits:");
  for (const suggestion of result.diagnostics.suggested_source_edits || []) {
    console.log(`    - ${suggestion}`);
  }
}

const args = parseArgs(process.argv);
if (args.command !== "explain") {
  console.log(usage());
  process.exitCode = args.command === "help" ? 0 : 1;
} else {
  const result = buildExplainResult({ cwd: process.cwd(), planArg: args.plan });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}
