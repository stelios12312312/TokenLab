#!/usr/bin/env node
// insight_velocity_report.mjs — focused, current-code Insight Velocity + ritual replay report.
//
// This report intentionally does NOT pull from the cumulative behavior archive
// (plans/plan_*/state.json), because that archive mixes historical plan noise
// with current-code behavior. Use this when you want the current E2E replay only.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const NODE = process.execPath;

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/insight_velocity_report.mjs [--json]

Options:
  --json   Emit machine-readable JSON instead of plain text.`;
}

function runJsonCommand(argv) {
  const stdout = execFileSync(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
  return JSON.parse(stdout);
}

function buildReport() {
  const iv = runJsonCommand([
    NODE,
    join(SCRIPT_DIR, "ideation_quality_benchmark.mjs"),
    "--json",
  ]);
  const ritual = runJsonCommand([
    NODE,
    join(SCRIPT_DIR, "ritual_replay.mjs"),
    "--json",
  ]);

  const current = ritual.current || {};
  const corpus = ritual.corpus || {};
  const retired = ritual.retired_gates || {};
  const ivAgg = iv.report?.aggregate || iv.aggregate || {};
  const ivBudgets = iv.report?.budgets || iv.budgets || {};

  return {
    schema_version: 1,
    report_id: "insight_velocity_current_code",
    generated_at: new Date().toISOString(),
    note: "Current-code E2E replay only. Cumulative behavior archive is intentionally excluded.",
    insight_velocity: {
      status: iv.ok === false ? "FAIL" : "PASS",
      fixture_count: asNumber(ivAgg.fixture_count),
      actor_output_count: asNumber(ivAgg.actor_output_count),
      actor_family_count: asNumber(ivAgg.actor_family_count),
      idea_coverage_pct: asNumber(ivAgg.idea_coverage_pct),
      useful_novelty_score: asNumber(ivAgg.useful_novelty_score),
      ontology_suggestion_hit_rate: asNumber(ivAgg.ontology_suggestion_hit_rate),
      persona_lift_rate: asNumber(ivAgg.persona_lift_rate),
      cross_actor_divergence_pct: asNumber(ivAgg.cross_actor_divergence_pct),
      cross_persona_divergence_pct: asNumber(ivAgg.cross_persona_divergence_pct),
      false_green_rate_pct: asNumber(ivAgg.false_green_rate_pct),
      false_red_review_rate_pct: asNumber(ivAgg.false_red_review_rate_pct),
      barren_fixture_blocked_count: asNumber(ivAgg.barren_fixture_blocked_count),
      budgets: ivBudgets,
    },
    ritual_replay: {
      status: ritual.ok === false ? "FAIL" : "PASS",
      corpus: {
        fixture_count: asNumber(corpus.fixture_count),
        transition_count: asNumber(corpus.transition_count),
      },
      current_ritual_transition_rate_pct: asNumber(current.ritual_transition_rate_pct),
      current_unknown_transition_rate_pct: asNumber(current.unknown_transition_rate_pct),
      retired_gate_active_bounce_count: asNumber(retired.current_active_bounce_count),
      budgets: ritual.budgets || {},
    },
  };
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function renderText(report) {
  const iv = report.insight_velocity;
  const rr = report.ritual_replay;
  return [
    "Insight Velocity — current-code report",
    `Generated: ${report.generated_at}`,
    "",
    "Insight Velocity / ideation quality:",
    `  Status: ${iv.status}`,
    `  Fixtures: ${iv.fixture_count} (${iv.actor_output_count} actor outputs, ${iv.actor_family_count} families)`,
    `  Idea coverage: ${iv.idea_coverage_pct}%`,
    `  Useful novelty score: ${iv.useful_novelty_score}`,
    `  Ontology hit rate: ${iv.ontology_suggestion_hit_rate}`,
    `  Persona lift rate: ${iv.persona_lift_rate}%`,
    `  Cross-actor divergence: ${iv.cross_actor_divergence_pct}%`,
    `  False-green rate: ${iv.false_green_rate_pct}%`,
    `  False-red review rate: ${iv.false_red_review_rate_pct}%`,
    `  Barren fixtures blocked: ${iv.barren_fixture_blocked_count}`,
    "",
    "Current-code ritual replay:",
    `  Status: ${rr.status}`,
    `  Corpus: ${rr.corpus.fixture_count} fixtures, ${rr.corpus.transition_count} transitions`,
    `  Ritual transition rate: ${rr.current_ritual_transition_rate_pct}%`,
    `  Unknown transition rate: ${rr.current_unknown_transition_rate_pct}%`,
    `  Retired gate active bounces: ${rr.retired_gate_active_bounce_count}`,
    "",
    "Note: This report uses current E2E replay only. The cumulative behavior-archive",
    "      ritual-stall classification across old plans is intentionally excluded.",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const report = buildReport();
  if (argv.includes("--json")) {
    emitJson(report);
  } else {
    console.log(renderText(report));
  }
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { buildReport, renderText };
