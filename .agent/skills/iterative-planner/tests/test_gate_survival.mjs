#!/usr/bin/env node
// test_gate_survival.mjs - E2-4 gate survival report fixtures.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildGateSurvivalReport, renderMarkdown } from "../scripts/gate_survival.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const script = join(skillDir, "scripts", "gate_survival.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLog(path, rows, { malformed = false } = {}) {
  ensureDir(dirname(path));
  const lines = rows.map((row) => JSON.stringify(row));
  if (malformed) lines.push("{not json");
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function transition({ at, gate, decision, codes = [], checks = [], sourceState = "plan" }) {
  return {
    timestamp: at,
    type: "gate_transition",
    gate,
    decision,
    inputs: { source_state: sourceState },
    failure_codes: codes,
    checks,
  };
}

function makeFixture(root) {
  const plansDir = join(root, "plans");
  writeLog(join(plansDir, "plan_2026-01-01_a", "artifacts", "decision_log.jsonl"), [
    transition({
      at: "2026-01-01T00:00:00.000Z",
      gate: "plan-to-execute",
      decision: "BLOCKED",
      codes: ["GATE-REF-003"],
      checks: [{ name: "Reflection summary present", code: "GATE-REF-003", status: "FAIL", detail: "summary missing" }],
    }),
    transition({
      at: "2026-01-01T00:00:30.000Z",
      gate: "plan-to-execute",
      decision: "ALLOWED",
      checks: [{ name: "State is stable", status: "PASS", detail: "stable" }],
    }),
    transition({
      at: "2026-01-01T00:05:00.000Z",
      gate: "execute-to-reflect",
      decision: "BLOCKED",
      codes: ["GATE-ETR-008"],
      checks: [{ name: "Real verification executed", code: "GATE-ETR-008", status: "FAIL", detail: "missing real command" }],
    }),
    transition({
      at: "2026-01-01T00:20:00.000Z",
      gate: "execute-to-reflect",
      decision: "ALLOWED",
    }),
    transition({
      at: "2026-01-01T00:25:00.000Z",
      gate: "reflect-to-validate",
      decision: "ALLOWED",
      checks: [
        { name: "State is stable", status: "PASS", detail: "still stable" },
        { name: "10 warning(s)", status: "PASS", detail: "summary row" },
      ],
    }),
  ], { malformed: true });

  writeJson(join(plansDir, "plan_2026-01-01_b", "state.json"), {
    state: "VALIDATE",
    transitions: [
      { from: "REFLECT", to: "VALIDATE", gate_result: "FAIL", failure_codes: ["GATE-REF-017"] },
      { from: "VALIDATE", to: "CLOSE", gate_result: "PASS", failure_codes: [] },
    ],
  });

  writeLog(join(plansDir, ".audit-archive", "plan_2025-12-31_legacy", "artifacts", "decision_log.jsonl"), [
    transition({
      at: "2026-01-01T00:30:00.000Z",
      gate: "reflect-to-close",
      decision: "BLOCKED",
      codes: ["GATE-VAL-013"],
      checks: [{ name: "Anti recurrence guard", code: "GATE-VAL-013", status: "FAIL", detail: "Guard Type missing" }],
    }),
    transition({
      at: "2026-01-01T00:30:30.000Z",
      gate: "reflect-to-close",
      decision: "ALLOWED",
    }),
  ]);

  writeLog(join(plansDir, "plan_2026-01-01_b", "telemetry", "events.jsonl"), [
    { event: "gate_probe", gate: "notify-user", timestamp: "2026-01-01T00:40:00.000Z" },
  ]);

  return plansDir;
}

console.log("\nGate Survival Report Tests\n");

const tmp = mkdtempSync(join(tmpdir(), "gate-survival-test-"));
try {
  const plansDir = makeFixture(tmp);
  const report = buildGateSurvivalReport({ cwd: tmp, plansDir, windowSec: 120 });

  assert(report.summary.configured_gates_covered === true, "all configured gates are represented");
  assert(report.summary.configured_gates_missing.length === 0, "no configured gates missing");
  assert(report.static_check_census.complete === true && report.static_check_census.row_count > 0, "static census covers configured check surfaces");
  assert(report.static_check_census.source_counts.failure_code_registry > 0, "static census includes every failure-code registry row");
  assert(report.static_check_census.source_counts.yaml_checklist > 0, "static census includes YAML checklist rows");
  assert(report.static_check_census.source_counts.javascript_check > 0, "static census includes JavaScript check sites");
  assert(report.static_check_census.source_counts.prolog_guard > 0, "static census includes Prolog guards");
  assert(
    report.static_check_census.rows
      .filter((row) => row.surface === "javascript_check" && !row.failure_code)
      .every((row) => row.runtime_class === "contract_enforced" && row.why.includes("GATE-CONTRACT-001")),
    "uncoded JavaScript sites are explicitly owned by the runtime contract-defect control",
  );
  assert(report.corpus.top_level_plan_dirs === 2, "top-level plan dirs counted");
  assert(report.corpus.all_plan_dirs_including_archive === 3, "archive plan dirs counted separately");
  assert(report.corpus.decision_log_files === 2, "decision log files counted");
  assert(report.corpus.telemetry_event_files === 1, "telemetry event files counted");
  assert(report.corpus.state_files === 1, "state snapshots counted");
  assert(report.corpus.malformed_decision_log_rows === 1, "malformed decision rows counted");

  assert(report.gates["reflect-to-close"]?.configured === false, "legacy reflect-to-close is separated from configured gates");
  assert(report.gates["plan-to-execute"]?.classification === "DEMOTE", "self-clearing ceremony gate is a DEMOTE candidate");
  assert(report.gates["execute-to-reflect"]?.classification === "KEEP", "substantive gate remains KEEP");
  assert(report.gates["notify-user"]?.evidence_counts.telemetry_events === 1, "telemetry evidence is counted by gate");

  const checks = new Map(report.checks.map((row) => [row.id, row]));
  assert(checks.get("GATE-REF-003")?.classification === "DEMOTE", "ceremony failure check is DEMOTE");
  assert(checks.get("GATE-ETR-008")?.classification === "KEEP", "substantive failure check is KEEP");
  assert(checks.get("GATE-VAL-013")?.known_false_red_classes.includes("anti_recurrence_parser"), "known false-red class is attached");
  assert(checks.get("GATE-VAL-013")?.classification === "KEEP", "known false-red keeps guard intent");
  assert(checks.get("CHECK:state_is_stable")?.classification === "DELETE", "pass-only check is DELETE candidate");
  assert(checks.get("GATE-REF-003")?.candidate_actionability === "actionable", "coded demote check is actionable");
  assert(checks.get("CHECK:state_is_stable")?.candidate_disposition === "defer_unmapped_pass_only_check", "pass-only unmapped check is review-only");
  assert(checks.get("CHECK:state_is_stable")?.candidate_actionability === "review_only", "pass-only unmapped check is not actionable yet");
  assert(checks.get("CHECK:10_warning_s")?.candidate_disposition === "ignore_synthetic_summary", "synthetic summary check is ignored");
  assert(checks.get("CHECK:10_warning_s")?.candidate_actionability === "non_actionable", "synthetic summary check is non-actionable");
  assert(report.summary.actionable_candidate_counts.DEMOTE >= 1, "summary counts actionable demote candidates");
  assert(report.summary.review_only_candidate_counts.DELETE >= 1, "summary counts review-only delete candidates");
  assert(report.summary.non_actionable_candidate_counts.DELETE >= 1, "summary counts non-actionable delete candidates");

  const markdown = renderMarkdown(report);
  assert(markdown.includes("## Candidate Actionability Summary"), "markdown renders candidate actionability summary");
  assert(markdown.includes("## Gate Rankings"), "markdown renders gate rankings");
  assert(markdown.includes("Strongest counterargument"), "markdown renders counterargument");

  const outDir = join(tmp, "reports", "ive", "gate_survival");
  const cli = JSON.parse(execFileSync(NODE, [script, "--cwd", tmp, "--plans-dir", plansDir, "--out-dir", outDir, "--write", "--json"], { encoding: "utf-8" }));
  assert(cli.written && existsSync(join(outDir, "gate_survival.json")), "CLI writes JSON report");
  assert(cli.written && existsSync(join(outDir, "gate_survival.md")), "CLI writes markdown report");
  const written = JSON.parse(readFileSync(join(outDir, "gate_survival.json"), "utf-8"));
  assert(written.summary.configured_gates_covered === true, "written JSON preserves configured gate coverage");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
