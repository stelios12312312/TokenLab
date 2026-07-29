#!/usr/bin/env node
// test_behavior_report.mjs — behavior taxonomy + gate-nature classification.

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { run as runBehaviorReport } from "../scripts/behavior_report.mjs";
import {
  advisoryConsumerAudit,
  classifyRun,
  gateFailureNature,
  unsatisfiedRequiredSignals,
  summarize,
} from "../scripts/lib/behavior_report.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "..", "scripts", "behavior_report.mjs");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function st(overrides = {}) {
  return {
    state: "CLOSE",
    transitions: [{ from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] }],
    circuit_breakers: {},
    fix_attempts: 0,
    close_signals: {},
    ...overrides,
  };
}

console.log("\nIVE Behavior Report Tests\n");

console.log("[run classification]");
assert(classifyRun(st()).category === "right_action", "clean PASS-close with satisfied signals is right-action");

assert(
  classifyRun(st({
    transitions: [
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-017"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-016"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-EXP-009"] },
      { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
    ],
  })).category === "ritual_stall",
  "PASS-close with >=3 gate fails is ritual-stall"
);

// SKIP-close correction: reaching CLOSE via SKIP is administrative, NOT false-green.
const skipClose = classifyRun(st({
  transitions: [{ from: "REFLECT", to: "CLOSE", gate_result: "SKIP", failure_codes: [] }],
  close_signals: { planner_core: { required: true, satisfied: false } },
}));
assert(skipClose.category === "abandoned", "SKIP-close (short-circuit) is abandoned, not a completion");
assert(skipClose.administrative_skip_close === true, "SKIP-close is flagged administrative");

// True false-green: PASS-close but a required signal unsatisfied.
assert(
  classifyRun(st({ close_signals: { planner_core: { required: true, satisfied: false } } })).category === "false_green",
  "PASS-close with an unsatisfied required signal is false-green"
);
assert(
  classifyRun(st({ close_signals: { test_evidence: { required: false, satisfied: false } } })).category === "right_action",
  "an unsatisfied OPTIONAL signal does not make a false-green"
);

assert(classifyRun(st({ state: "EXECUTE" })).category === "abandoned", "non-CLOSE terminal state is abandoned");
assert(classifyRun(null).category === "other_uncertain", "missing state is other/uncertain");

console.log("\n[close-signal helper]");
assert(unsatisfiedRequiredSignals({ a: { required: true, satisfied: false }, b: { satisfied: true } }).length === 1, "detects one unsatisfied required signal");
assert(unsatisfiedRequiredSignals({ a: { satisfied: false } }).length === 1, "absent required defaults to required");

console.log("\n[gate-failure nature]");
assert(gateFailureNature("GATE-EXP-004") === "ceremony", "adjacency marker is ceremony");
assert(gateFailureNature("GATE-ETR-008") === "substantive", "red-team depth is substantive");
assert(gateFailureNature("GATE-PLN-017") === "hybrid", "verification-matrix shape is hybrid");
assert(gateFailureNature("GATE-SEM-003") === "substantive", "Prolog/JS divergence is substantive");
assert(gateFailureNature("GATE-REF-021") === "substantive", "substantive unfinished progress remains a hard proof boundary");
assert(gateFailureNature("GATE-PRS-TRACE") === "hybrid", "traceability persona recovery is hybrid");
assert(gateFailureNature("GATE-PLN-021") === "hybrid", "KB-learning reference recovery is hybrid");
assert(gateFailureNature("GATE-TMP-002") === "substantive", "retired tamper fingerprint remains substantive in historical taxonomy");
assert(gateFailureNature("GATE-ZZZ-999") === "unknown", "unmapped code is unknown");

console.log("\n[aggregate]");
const report = summarize([
  { name: "plan_2026-04-01_a", month: "2026-04", state: st() },
  { name: "plan_2026-04-02_b", month: "2026-04", state: st({ state: "EXPLORE" }) },
  { name: "plan_2026-05-01_c", month: "2026-05", state: st({
      transitions: [
        { from: "EXPLORE", to: "EXPLORE", gate_result: "FAIL", failure_codes: ["GATE-EXP-004"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-ETR-008"] },
        { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-016"] },
        { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
      ],
    }) },
]);
assert(report.total_runs === 3, "aggregate counts all runs");
assert(
  report.by_category.right_action === 1 && report.by_category.abandoned === 1 && report.by_category.ritual_stall === 1,
  "aggregate category counts"
);
assert(
  report.total_gate_bounces === 3 && report.nature_split.ceremony === 1 && report.nature_split.substantive === 1 && report.nature_split.hybrid === 1,
  "aggregate gate-bounce nature split"
);
assert(report.by_month["2026-05"].ritual_stall === 1, "monthly breakdown present");
assert(report.gate_bounce_rates["GATE-EXP-004"].per_run_pct === 33.3, "per-gate bounce rate is reported as percent of runs");
assert(report.ceremony_gate_bounce_rates["GATE-EXP-004"].nature === "ceremony", "ceremony gate bounce rates are split out for decision use");
assert(report.actionable_gate_hotspots.some((row) => row.code === "GATE-PLN-016" && row.targeted_attack_plan_gate), "actionable hotspot report highlights target hybrid gates");
const targetPln016 = report.actionable_gate_hotspots.find((row) => row.code === "GATE-PLN-016");
assert(targetPln016?.repair_execution?.status === "strict_guidance_repaired", "target hotspot row includes execution repair status");
assert(targetPln016?.repair_execution?.strictness === "preserved", "target hotspot row records preserved strictness");
assert(targetPln016?.repair_execution?.false_red_evidence?.blocked_on === 19, "target hotspot row includes false-red evidence counts");
assert(report.output_volume_lines?.source_status === "live_repair_surface_counter", "aggregate report emits live repair-surface output-volume counters");
assert(report.output_volume_lines.blocked_first < 99, "blocked-first output lines improve over E2-1 baseline");
assert(report.output_volume_lines.blocked_repeat < 79, "blocked-repeat output lines improve over E2-1 baseline");

console.log("\n[shadow canary]");
const shadowReport = summarize([
  { name: "plan_2026-06-01_shadow", month: "2026-06", state: st({
    transitions: [
      {
        from: "PLAN",
        to: "EXECUTE",
        gate_result: "PASS",
        failure_codes: [],
        shadow_canary: [
          {
            gate: "GATE-EXP-004",
            proxy: "adjacency-marker",
            old_would_bounce: true,
            new_passed: true,
          },
          {
            gate: "GATE-ETR-008",
            proxy: "red-team-depth",
            old_would_bounce: true,
            new_passed: false,
          },
        ],
      },
    ],
  }) },
]);
assert(shadowReport.shadow_canary.total_observations === 2, "shadow canary counts observations");
assert(shadowReport.shadow_canary.divergence_count === 0, "shadow canary booleans do not substitute for canonical proof status");
assert(shadowReport.shadow_canary.by_proxy["adjacency-marker"].divergence_rate_pct === 0, "shadow canary reports zero divergence for boolean-only evidence");

const canonicalShadowReport = summarize([
  { name: "plan_2026-06-01_canonical_shadow", month: "2026-06", state: st({
    transitions: [{
      from: "PLAN",
      to: "EXECUTE",
      gate_result: "PASS",
      failure_codes: [],
      shadow_canary: [{
        gate: "GATE-EXP-004",
        proxy: "adjacency-marker",
        old_status: "FAIL",
        new_status: "PASS",
      }],
    }],
  }) },
]);
assert(canonicalShadowReport.shadow_canary.divergence_count === 1, "shadow canary counts canonical old-fail/new-pass divergences");
assert(canonicalShadowReport.shadow_canary.by_proxy["adjacency-marker"].divergence_rate_pct === 100, "shadow canary reports canonical per-proxy divergence rate");

console.log("\n[advisory consumer audit]");
const advisoryAudit = advisoryConsumerAudit();
assert(advisoryAudit.status === "pass", "default advisory signal registry has named consumers");
const failingAdvisoryAudit = advisoryConsumerAudit([
  { id: "orphan_advisory", producers: ["test"], consumers: [], surfaced_in: [] },
]);
assert(failingAdvisoryAudit.status === "fail", "advisory consumer audit fails unconsumed rows");
assert(failingAdvisoryAudit.unconsumed[0].id === "orphan_advisory", "unconsumed advisory row is reported");

console.log("\n[autocoder scoreboard integration]");
const tmp = mkdtempSync(join(tmpdir(), "ive-behavior-report-"));
try {
  writeJson(join(tmp, "plans", "plan_2026-06-01_clean", "state.json"), st({ completion_mode: "autonomous" }));
  writeJson(join(tmp, "plans", "plan_2026-06-01_clean", "metrics.json"), {
    tool_errors: [
      { gate: "explore-to-plan", code: "TOOL-RIT-001", kind: "process_exit" },
      { gate: "explore-to-plan", code: "TOOL-RIT-001", kind: "invalid_json" },
    ],
  });
  writeJson(join(tmp, "plans", "programs", "fixture-program", "program_packet.json"), {
    version: 1,
    id: "fixture-program",
    tickets: [
      {
        id: "T-FIXTURE-001",
        lifecycle: "done",
        completion_mode: "autonomous",
      },
    ],
    verification_matrix: [
      {
        id: "VM-FIXTURE-001",
        subject_ref: "T-FIXTURE-001",
        status: "pass",
      },
    ],
  });
  writeJson(join(tmp, "reports", "ive", "test_runs", "fixture-run", "manifest.json"), {
    schema_version: 1,
    suites: [
      {
        id: "fixture-suite",
        status: "pass",
        required: true,
        exit_code: 0,
      },
    ],
  });

  const integrated = runBehaviorReport(["--plans-dir", join(tmp, "plans")]);
  const scoreboard = integrated.autocoder_scoreboard;
  assert(!!scoreboard, "behavior_report run attaches an autocoder_scoreboard");
  assert(integrated.by_category.right_action === 1, "scoreboard integration preserves behavior category counts");
  assert(integrated.output_volume_lines?.source_status === "live_repair_surface_counter", "behavior_report CLI run carries live output-volume counters");
  assert(scoreboard.metrics.autonomous_ticket_completion_rate === 1, "scoreboard uses fixture Program Packet ticket data");
  assert(scoreboard.metrics.program_proof_execution_rate === 1, "scoreboard exposes Program Packet proof rate");
  assert(scoreboard.metrics.manifest_proof_execution_rate === 1, "scoreboard exposes manifest proof rate");
  assert(scoreboard.metrics.real_executed_proof_ratio === 1, "scoreboard uses fixture manifest proof data");
  assert(scoreboard.metrics.close_telemetry_unknown_rate === 0, "scoreboard exposes close telemetry unknown rate");
  assert(scoreboard.metrics.tool_errors_per_close === 2, "scoreboard exposes tool errors separately from lifecycle retries");
  assert(typeof scoreboard.definitions.tool_errors_per_close === "string", "scoreboard defines the tool-error KPI");
  assert(scoreboard.detail.close_evidence?.counts?.autonomous === 1, "scoreboard detail carries close evidence ledger counts");
  assert(scoreboard.detail.close_evidence?.clean_autonomy_explanation?.status === "autonomous_evidence_found", "scoreboard detail carries clean autonomy explanation");
  assert(scoreboard.detail.program_lifecycle_drift?.summary?.packet_count === 1, "scoreboard detail carries lifecycle drift summary");
  assert(scoreboard.detail.program_packets.programs === 1, "scoreboard default programs root is fixture-local");
  assert(scoreboard.detail.test_manifests.manifests === 1, "scoreboard default test-run root is fixture-local");
  assert(scoreboard.detail.outcome_provenance?.available === true, "scoreboard detail carries outcome provenance bridge");
  assert(scoreboard.detail.outcome_provenance?.proven_numerator === 3, "scoreboard outcome provenance uses executed-only numerator");
  assert(scoreboard.detail.outcome_provenance?.unproven_case_count === 2, "scoreboard outcome provenance keeps unproven residuals");
  assert(
    typeof scoreboard.definitions.ceremony_to_engineering_ratio === "string" &&
      scoreboard.definitions.ceremony_to_engineering_ratio.length > 0,
    "scoreboard carries canonical metric definitions"
  );

  const textRun = spawnSync(process.execPath, [scriptPath, "--plans-dir", join(tmp, "plans")], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert(textRun.status === 0, "behavior_report text CLI exits cleanly");
  assert(textRun.stdout.includes("autocoder scoreboard:"), "behavior_report text CLI prints scoreboard heading");
  assert(textRun.stdout.includes("aggregate executed proof ratio: 1"), "behavior_report text CLI prints scoreboard metric values");
  assert(textRun.stdout.includes("tool errors/close: 2"), "behavior_report text CLI prints the separate tool-error KPI");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
