#!/usr/bin/env node
// test_ritual_replay.mjs — real-work ritual E2E replay gate.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_FIXTURES_DIR,
  detectRetiredGateRecurrence,
  runRitualReplay,
} from "../scripts/lib/ritual_replay.mjs";

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

function transition({ gate = "plan-to-execute", decision = "BLOCKED", checks = [], failure_codes = null } = {}) {
  return {
    timestamp: "2026-06-16T00:00:00.000Z",
    type: "gate_transition",
    gate,
    inputs: { plan: "unit-plan", source_state: "plan" },
    checks,
    decision,
    next_state: decision === "ALLOWED" ? "EXECUTE" : null,
    failure_codes: Array.isArray(failure_codes)
      ? failure_codes
      : checks.filter((check) => check.status === "FAIL" && check.code).map((check) => check.code),
  };
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

console.log("\nRitual Replay Tests\n");

const realReport = runRitualReplay({ fixturesDir: DEFAULT_FIXTURES_DIR });
assert(realReport.ok, "real telemetry ritual replay passes current fail-closed budget");
assert(realReport.corpus.fixture_count >= 26, `real corpus includes at least 26 fixtures (got ${realReport.corpus.fixture_count})`);
assert(realReport.corpus.transition_count >= 300, `real corpus includes at least 300 gate transitions (got ${realReport.corpus.transition_count})`);
assert(realReport.corpus.transitions_by_project.portable_agent_kit >= 100, "real corpus includes substantial portable-agent-kit work");
const contentFixtureSummary = realReport.corpus.fixtures.find((f) => f.fixture === "content_marketing_site.jsonl");
assert(!!contentFixtureSummary, "content_marketing_site.jsonl fixture is discovered and included in the ritual replay corpus");
assert(contentFixtureSummary.source_project === "content_marketing_site", "content fixture is attributed to the content-marketing-site project");
assert(contentFixtureSummary.transition_count === 6, `content fixture contributes 6 transitions (got ${contentFixtureSummary.transition_count})`);
assert(contentFixtureSummary.current_ritual_transition_count === 0, "content fixture introduces zero current ritual transitions");
assert(contentFixtureSummary.current_active_blocked_transition_count === 0, "content fixture introduces zero current active blocked transitions");
assert(realReport.current.ritual_transition_rate_pct <= 6.1, `adding the content fixture does not increase the current ritual transition rate (baseline 6.1%, got ${realReport.current.ritual_transition_rate_pct}%)`);
assert(realReport.retired_gates.historical_hits_by_code["GATE-TMP-002"] > 0, "historical GATE-TMP-002 hits remain visible");
assert(realReport.retired_gates.historical_hits_by_code["GATE-PLN-010"] > 0, "historical GATE-PLN-010 hits remain visible");
assert(realReport.retired_gates.current_active_bounce_count === 0, "retired gates produce zero current active bounces");
assert(realReport.current.ritual_transition_rate_pct > 0, "current ritual transition percentage is measured");
assert(realReport.current.ritual_transition_count <= 25, `real current ritual transition count remains at or below the hardened target (got ${realReport.current.ritual_transition_count})`);
assert(realReport.current.ritual_transition_rate_pct <= 7, `real current ritual transition rate is at or below 7% (got ${realReport.current.ritual_transition_rate_pct}%)`);
assert(realReport.current.ritual_share_of_active_blocked_pct < 15, `real current ritual share of active blocked transitions is below 15% (got ${realReport.current.ritual_share_of_active_blocked_pct}%)`);
assert(realReport.current.unknown_transition_rate_pct > 0, "unknown/uncoded failure signal is exposed separately from ritual");
assert(realReport.current.unknown_transition_rate_pct <= 1, `real current unknown/uncoded transition rate is at or below 1% (got ${realReport.current.unknown_transition_rate_pct}%)`);
assert(realReport.current.unknown_transition_count <= 3, `real current unknown/uncoded transition count satisfies the 1% budget (got ${realReport.current.unknown_transition_count})`);
assert(realReport.budgets.current_ritual_transition_rate_pct.maximum === 7, "real replay default max ritual budget is 7%");
assert(realReport.budgets.current_ritual_transition_rate_pct.target === 7, "real replay default ritual target is 7%");
assert(realReport.budgets.current_unknown_transition_rate_pct.maximum === 1, "real replay default max unknown budget is 1%");
assert(realReport.budgets.current_ritual_transition_rate_pct.pass === true, "strict ritual transition budget passes");
assert(realReport.budgets.current_unknown_transition_rate_pct.pass === true, "unknown/uncoded transition budget passes");
assert(realReport.current.active_failure_counts_by_source.legacy_inference > 0, "real replay reports legacy inference as a bounded recovery source");
assert(realReport.current.active_failure_counts_by_code["GATE-CHK-008"] === 2, "real replay classifies legacy command-check rows");
assert(realReport.current.active_failure_counts_by_code["GATE-PLN-005"] === 3, "real replay classifies legacy success-criteria rows");
assert(realReport.current.softened_failure_policy_version.includes("T-INTAKE-291DF645"), "real replay exposes the PLN-017 trigger-precision softened-failure policy version");
assert(realReport.current.suppressed_failure_policy_version.includes("T-INTAKE-484F9D5B"), "real replay exposes the trace-off suppression policy version");
const targetRepairRows = realReport.current.target_hotspot_repairs || [];
assert(targetRepairRows.length === 4, "real replay exposes four target hotspot repair rows");
const targetRepairByCode = Object.fromEntries(targetRepairRows.map((row) => [row.code, row]));
assert(targetRepairByCode["GATE-REF-003"]?.current_active_failure_count === 9, "GATE-REF-003 current target count is reported");
assert(targetRepairByCode["GATE-PLN-017"]?.current_active_failure_count === 23, "GATE-PLN-017 current target count includes the real Polymarket planning block after crawler_extractor false-positive repair");
assert(targetRepairByCode["GATE-REF-004"]?.repair_execution?.status === "repaired_guidance", "GATE-REF-004 target row records repaired guidance status");
assert(targetRepairByCode["GATE-PLN-016"]?.repair_execution?.strictness === "preserved", "GATE-PLN-016 target row records preserved strictness");
assert(realReport.current.suppressed_failure_counts_by_code["GATE-EXP-015"] > 0, "real replay suppresses legacy EXP-015 from current counts");
assert(realReport.current.suppressed_failure_counts_by_code["GATE-EXP-016"] > 0, "real replay suppresses legacy EXP-016 from current counts");
assert(realReport.current.suppressed_failure_counts_by_code["GATE-TRC-002"] > 0, "real replay suppresses unsupported-trace rows from current counts");
assert(realReport.current.suppressed_failure_counts_by_code["GATE-TRC-006"] > 0, "real replay suppresses trace-own-findings rows from current counts when trace capture is off");
assert(realReport.current.softened_failure_counts_by_code["GATE-PLN-017"] === 6, "real replay softens crawler_extractor PLN-017 false-positive rows");
assert(realReport.current.softened_failure_counts_by_code["GATE-PLN-021"] > 0, "real replay softens legacy unconditional PLN-021 KB-marker rows");
assert(!realReport.current.active_failure_counts_by_code["GATE-EXP-015"], "suppressed legacy EXP-015 is not a current active blocker");
assert(!realReport.current.active_failure_counts_by_code["GATE-EXP-016"], "suppressed legacy EXP-016 is not a current active blocker");
assert(!realReport.current.active_failure_counts_by_code["GATE-TRC-002"], "unsupported-trace GATE-TRC-002 rows are not current active blockers");
assert(!realReport.current.active_failure_counts_by_code["GATE-TRC-006"], "trace-own-findings GATE-TRC-006 rows are not current active blockers");
assert(!realReport.current.active_failure_counts_by_code["GATE-PLN-021"], "legacy unconditional PLN-021 rows are not current active blockers");
assert(realReport.current.unresolved_failure_signal_count > 0, "real replay keeps truly unresolved failure signals visible");
assert(realReport.semantics.cumulative_history.includes("behavior_report.mjs"), "report labels behavior_report as separate cumulative history");

const strictBudget = runRitualReplay({
  fixturesDir: DEFAULT_FIXTURES_DIR,
  maxCurrentRitualTransitionRatePct: 1,
});
assert(!strictBudget.ok && strictBudget.status === "FAIL", "too-strict ritual budget fails closed");
assert(
  strictBudget.regressions.some((row) => row.code === "ritual_replay_current_ritual_transition_rate_pct"),
  "strict budget reports ritual transition regression code",
);

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-small-"));
  try {
    const fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeJsonl(join(fixtureDir, "portable_agent_kit_GATE-TMP-002.jsonl"), [
      {
        type: "harvest_provenance",
        source_project: "portable-agent-kit",
        gate_code: "GATE-TMP-002",
      },
      transition({
        checks: [{ name: "retired tamper", status: "FAIL", code: "GATE-TMP-002" }],
      }),
      transition({
        checks: [{ name: "KB read proof", status: "FAIL", code: "GATE-EXP-010" }],
      }),
      transition({
        decision: "ALLOWED",
        checks: [{ name: "all good", status: "PASS" }],
      }),
    ]);
    const report = runRitualReplay({
      fixturesDir: fixtureDir,
      repoRoot: tmp,
      scanPaths: [],
      minFixtureCount: 1,
      minTransitionCount: 3,
      minPortableAgentKitTransitionCount: 3,
      maxCurrentRitualTransitionRatePct: 50,
    });
    assert(report.ok, "small controlled fixture passes when budgets are adjusted");
    assert(report.historical.retired_gate_hits_by_code["GATE-TMP-002"] === 1, "small fixture counts retired gate as historical");
    assert(report.current.active_blocked_transition_count === 1, "retired-only transition is not a current active block");
    assert(report.current.ritual_transition_count === 1, "coded ceremony transition counts as current ritual");
    assert(report.retired_gates.current_active_bounce_count === 0, "small fixture has zero retired current bounces");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-normalizer-"));
  try {
    const fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeJsonl(join(fixtureDir, "portable_agent_kit_GATE-VAL-011.jsonl"), [
      {
        type: "harvest_provenance",
        source_project: "portable-agent-kit",
        gate_code: "GATE-VAL-011",
      },
      transition({
        checks: [{ name: "legacy row with transition-level code only", status: "FAIL" }],
        failure_codes: ["GATE-VAL-011"],
      }),
      transition({
        gate: "explore-to-plan",
        checks: [{ name: "Semantic: explore → plan", status: "FAIL", detail: "Blocked: insufficient_findings" }],
      }),
      transition({
        gate: "execute-to-reflect",
        checks: [{ name: "Mystery local row", status: "FAIL", detail: "no stable code exists yet" }],
      }),
    ]);
    const report = runRitualReplay({
      fixturesDir: fixtureDir,
      repoRoot: tmp,
      scanPaths: [],
      minFixtureCount: 1,
      minTransitionCount: 3,
      minPortableAgentKitTransitionCount: 3,
      maxCurrentRitualTransitionRatePct: 100,
      maxCurrentUnknownTransitionRatePct: 100,
    });
    assert(report.ok, "controlled normalizer fixture passes with adjusted budgets");
    assert(report.current.active_failure_counts_by_code["GATE-VAL-011"] === 1, "transition-level failure code is recovered once");
    assert(report.current.active_failure_counts_by_source["transition.failure_codes"] === 1, "transition-level recovery is surfaced as its own source");
    assert(report.current.active_failure_counts_by_code["GATE-SEM-001"] === 1, "known legacy semantic row is inferred");
    assert(report.current.active_failure_counts_by_code.__uncoded_fail__ === 1, "unrecognized uncoded row remains visible");
    assert(report.current.unknown_transition_count === 1, "unrecognized uncoded row contributes to unknown transition count");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-legacy-codes-"));
  try {
    const fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeJsonl(join(fixtureDir, "portable_agent_kit_GATE-LEGACY-CODES.jsonl"), [
      {
        type: "harvest_provenance",
        source_project: "portable-agent-kit",
        gate_code: "GATE-LEGACY-CODES",
      },
      transition({ checks: [{ name: "Success criteria section exists in plan.md", status: "FAIL" }] }),
      transition({ gate: "execute-to-reflect", checks: [{ name: "Red-team notes contain actual analysis (not empty)", status: "FAIL" }] }),
      transition({ gate: "execute-to-reflect", checks: [{ name: "Mitigations documented for attack vectors (mandatory)", status: "FAIL" }] }),
      transition({ gate: "explore-to-plan", checks: [{ name: "Prolog rule engine self-test passes (ensures invariant layer is functional)", status: "FAIL" }] }),
      transition({ gate: "execute-to-reflect", checks: [{ name: "@planner: annotations are valid (no broken references, expired disables, or unknown keys)", status: "FAIL" }] }),
      transition({ gate: "reflect-to-validate", checks: [{ name: "Structured close signal confirms all progress items are complete before VALIDATE", status: "FAIL" }] }),
      transition({ gate: "reflect-to-validate", checks: [{ name: "Structured close signal confirms task-relevant semantic substrate gaps are resolved before VALIDATE", status: "FAIL" }] }),
      transition({ gate: "validate-to-close", checks: [{ name: "Verification is not still template", status: "FAIL" }] }),
      transition({ gate: "validate-to-close", checks: [{ name: "Structured close signal confirms remediation-style work records an anti-recurrence guard (test, ontology, annotation, KB) or an approved waiver", status: "FAIL" }] }),
    ]);
    const report = runRitualReplay({
      fixturesDir: fixtureDir,
      repoRoot: tmp,
      scanPaths: [],
      minFixtureCount: 1,
      minTransitionCount: 9,
      minPortableAgentKitTransitionCount: 9,
      maxCurrentRitualTransitionRatePct: 100,
      maxCurrentUnknownTransitionRatePct: 100,
    });
    assert(report.ok, "controlled legacy-code fixture passes with adjusted budgets");
    assert(report.current.active_failure_counts_by_code["GATE-PLN-005"] === 1, "legacy success criteria row maps to GATE-PLN-005");
    assert(report.current.active_failure_counts_by_code["GATE-ETR-002"] === 1, "legacy red-team analysis row maps to GATE-ETR-002");
    assert(report.current.active_failure_counts_by_code["GATE-ETR-004"] === 1, "legacy mitigation row maps to GATE-ETR-004");
    assert(report.current.active_failure_counts_by_code["GATE-CHK-008"] === 2, "legacy command rows map to GATE-CHK-008");
    assert(report.current.active_failure_counts_by_code["GATE-REF-003"] === 1, "legacy progress row maps to GATE-REF-003");
    assert(report.current.active_failure_counts_by_code["GATE-REF-016"] === 1, "legacy semantic substrate row maps to GATE-REF-016");
    assert(report.current.active_failure_counts_by_code["GATE-VAL-001"] === 1, "legacy verification-template row maps to GATE-VAL-001");
    assert(report.current.active_failure_counts_by_code["GATE-VAL-013"] === 1, "legacy anti-recurrence row maps to GATE-VAL-013");
    assert(!report.current.active_failure_counts_by_code.__uncoded_fail__, "coded legacy fixture produces no uncoded failure rows");
    assert(report.current.unknown_transition_count === 0, "coded legacy fixture produces zero unknown transitions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-softened-"));
  try {
    const fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeJsonl(join(fixtureDir, "portable_agent_kit_GATE-TRC-002.jsonl"), [
      {
        type: "harvest_provenance",
        source_project: "portable-agent-kit",
        gate_code: "GATE-TRC-002",
      },
      transition({
        gate: "explore-to-plan",
        checks: [
          { name: "Assumption Ledger section present", status: "FAIL", detail: "Assumption ledger not found" },
          { name: "Root cause and adjacency evidence", status: "FAIL", detail: "Findings/root cause/adjacency missing" },
        ],
      }),
      transition({
        gate: "explore-to-plan",
        checks: [
          { name: "IDE trace support", status: "WARN", code: "GATE-TRC-009", detail: "Unsupported IDE cannot capture PostToolUse trace" },
          { name: "Trace: Knowledge base files", status: "FAIL", code: "GATE-TRC-002", detail: "Knowledge base files — not found in trace" },
        ],
      }),
      transition({
        gate: "explore-to-plan",
        checks: [
          { name: "IDE trace support", status: "WARN", code: "GATE-TRC-009", detail: "Unsupported IDE cannot capture PostToolUse trace" },
          { name: "Trace: Knowledge base files", status: "FAIL", code: "GATE-TRC-002", detail: "Knowledge base files — not found in trace" },
          { name: "Semantic: explore -> plan", status: "FAIL", code: "GATE-SEM-001", detail: "Blocked: real semantic issue" },
        ],
      }),
      transition({
        gate: "plan-to-execute",
        checks: [
          { name: "IDE trace support", status: "WARN", code: "GATE-TRC-009", detail: "Unsupported IDE cannot capture PostToolUse trace" },
          { name: "Trace: Knowledge base files", status: "FAIL", code: "GATE-TRC-002", detail: "Knowledge base files — not found in trace" },
          { name: "Context-sensitive verification matrix", status: "FAIL", code: "GATE-PLN-017", detail: "missing matrix" },
        ],
      }),
      transition({
        gate: "explore-to-plan",
        checks: [
          { name: "IDE trace support", status: "WARN", code: "GATE-TRC-009", detail: "Unsupported IDE cannot capture PostToolUse trace" },
          { name: "Trace: Own findings before planning", status: "FAIL", code: "GATE-TRC-006", detail: "Own findings — not found in trace" },
        ],
      }),
      transition({
        gate: "explore-to-plan",
        checks: [
          { name: "Trace: Knowledge base files", status: "FAIL", code: "GATE-TRC-002", detail: "Supported trace mode should still block" },
        ],
      }),
    ]);
    const report = runRitualReplay({
      fixturesDir: fixtureDir,
      repoRoot: tmp,
      scanPaths: [],
      minFixtureCount: 1,
      minTransitionCount: 6,
      minPortableAgentKitTransitionCount: 6,
      maxCurrentRitualTransitionRatePct: 100,
    });
    assert(report.ok, "controlled trace-off suppression fixture passes with adjusted budgets");
    assert(report.current.suppressed_transition_count === 5, "suppressed-only and suppressed-plus rows are counted as suppressed transitions");
    assert(report.current.suppressed_failure_count === 6, "suppressed failure count includes legacy EXP and trace rows");
    assert(report.current.suppressed_failure_counts_by_code["GATE-EXP-015"] === 1, "legacy inferred EXP-015 is suppressed");
    assert(report.current.suppressed_failure_counts_by_code["GATE-EXP-016"] === 1, "legacy inferred EXP-016 is suppressed");
    assert(report.current.suppressed_failure_counts_by_code["GATE-TRC-002"] === 3, "unsupported trace GATE-TRC-002 rows are suppressed");
    assert(report.current.suppressed_failure_counts_by_code["GATE-TRC-006"] === 1, "trace-own-findings GATE-TRC-006 row is suppressed when trace capture is off");
    assert(report.current.active_blocked_transition_count === 3, "suppressed-only rows do not count as active blockers");
    assert(report.current.active_failure_counts_by_code["GATE-SEM-001"] === 1, "softened plus substantive remains active");
    assert(report.current.active_failure_counts_by_code["GATE-PLN-017"] === 1, "softened plus remaining ritual remains active");
    assert(report.current.active_failure_counts_by_code["GATE-TRC-002"] === 1, "supported trace GATE-TRC-002 still blocks");
    assert(report.current.ritual_transition_count === 2, "remaining ritual rows still count after suppressed failures are removed");
    assert(report.historical.failure_counts_by_code["GATE-TRC-002"] === 4, "historical counts retain original trace failure rows");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-bad-"));
  try {
    mkdirSync(join(tmp, "fixtures"), { recursive: true });
    writeFileSync(join(tmp, "fixtures", "bad.jsonl"), "{not json}\n");
    const report = runRitualReplay({
      fixturesDir: join(tmp, "fixtures"),
      repoRoot: tmp,
      scanPaths: [],
      minFixtureCount: 1,
      minTransitionCount: 0,
      minPortableAgentKitTransitionCount: 0,
      maxCurrentRitualTransitionRatePct: 100,
    });
    assert(!report.ok, "malformed fixture fails closed");
    assert(report.budgets.parse_error_count.pass === false, "malformed fixture reports parse-error budget failure");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "ritual-replay-source-"));
  try {
    mkdirSync(join(tmp, "active"), { recursive: true });
    writeFileSync(join(tmp, "active", "gate.mjs"), "export const code = 'GATE-TMP-002';\n");
    const recurrence = detectRetiredGateRecurrence({
      repoRoot: tmp,
      scanPaths: ["active"],
      retiredGates: ["GATE-TMP-002"],
      allowlist: [],
    });
    assert(!recurrence.ok, "active source recurrence of a retired gate is detected");
    assert(recurrence.hits[0]?.gate === "GATE-TMP-002", "retired recurrence names the gate");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
