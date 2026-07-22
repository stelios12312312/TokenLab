#!/usr/bin/env node
// test_ive_release_handoff.mjs - IVE Runtime Phase 6 release-handoff proof.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  buildReleaseHandoffReport,
  parseReleaseHandoffArgs,
} from "../scripts/lib/ive_release_handoff.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const cliPath = join(skillDir, "scripts", "ive_release_handoff.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

console.log("\nIVE Release Handoff Tests\n");

const parsed = parseReleaseHandoffArgs(["--plans", "50", "--json", "--no-write", "--no-rollback-drill"]);
assert(parsed.plans === 50 && parsed.json && parsed.writeReport === false && parsed.runRollbackDrill === false, "parseReleaseHandoffArgs handles phase 6 flags");

const report = buildReleaseHandoffReport(repoRoot, {
  plans: 50,
  writeReport: false,
  runRollbackDrill: true,
});
assert(report.ok && report.status === "PASS", "release handoff report passes on the repo");
assert(report.checks.historical_replay.plans_replayed === report.selected_plan_count, "historical replay covers every selected plan");
assert(report.checks.historical_replay.drift_count === 0 && report.checks.historical_replay.gate_verdicts_byte_identical, "historical replay reports zero drift and byte-identical gates");
assert(report.checks.state_preservation.state_json_bytes_unchanged, "state preservation check leaves state.json bytes unchanged");
assert(report.checks.fact_parity.cached_fact_count > 0 && report.checks.fact_parity.drift_count === 0, "fact parity checks cached ontology facts without drift");
assert(report.checks.rollback_drill.manifesto_restored_byte_for_byte, "rollback drill restores manifesto byte-for-byte in temp project");
assert(report.checks.rollback_drill.real_repo_mutated === false, "rollback drill records no real repo mutation");
assert(report.checks.program_packet.ticket_id === "T-INTAKE-0445AB16" && report.checks.program_packet.child_plan_present, "Program Packet T44 evidence is present");
assert(report.checks.docs_version.version_recorded_in_migration_doc, "version is recorded in MIGRATION.md");
assert(report.checks.review_board_sync.deterministic_packet_authority_documented, "review-board deterministic authority is documented");

const oversubscribed = buildReleaseHandoffReport(repoRoot, {
  plans: 999,
  writeReport: false,
  runRollbackDrill: false,
});
assert(oversubscribed.ok && oversubscribed.status === "PASS", "release handoff replays all available plans when requested history exceeds clean checkout");
assert(oversubscribed.plans_requested === 999 && oversubscribed.selected_plan_count > 0, "oversubscribed report preserves requested and selected plan counts");
assert(oversubscribed.checks.historical_replay.requested_plans === oversubscribed.selected_plan_count, "oversubscribed historical replay uses selected plan count");
assert((oversubscribed.warnings || []).some((warning) => warning.code === "limited_plan_history"), "oversubscribed report warns about limited tracked plan history");
assert(!(oversubscribed.issues || []).some((issue) => issue.code === "insufficient_plan_history"), "limited tracked history is not a blocking issue");

const cli = JSON.parse(execFileSync(NODE, [cliPath, "--plans", "50", "--json", "--no-write", "--no-rollback-drill"], {
  cwd: repoRoot,
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
}));
assert(cli.ok && cli.status === "PASS", "CLI emits PASS JSON");
assert(cli.checks.rollback_drill.skipped === true, "CLI can skip rollback drill for focused smoke");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
